//! GGUF → NInfer v3 转换后端：
//! 1. 可选转换器整合包的探测、GitHub 按需下载/校验/解压、本地导入与卸载；
//! 2. GGUF 文件头与分卷预检（架构、Qwen3.5 Dense 几何、张量块格式、MTP/词表/模板探测）；
//! 3. HF / ModelScope 轻量配置文件按需拉取（config.json / tokenizer* / chat_template）；
//! 4. 受管子进程调度转换、实时进度解析与任务取消清理。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::app_update::{fetch_github_release_with_fallback, CancelFlag, CancelGuard};
use crate::config::{read_config, save_config, AppConfig};
use crate::process::emit_log;
use crate::system::{
    build_net_client, hf_mirror_url, with_ms_net_fallback, with_net_fallback, HF_UA,
};
use crate::{find_split_group_impl, now_ms, DetectedSplitGroup};

pub(crate) const DEFAULT_CONVERTER_REPO: &str = "Crvesoft/cookllm-ninfer-converter";

static CONVERTER_DL_CANCEL: AtomicBool = AtomicBool::new(false);
static CONVERT_CANCEL: AtomicBool = AtomicBool::new(false);
static ACTIVE_CONVERT_PID: Mutex<Option<u32>> = Mutex::new(None);
static CONVERT_RUNNING: AtomicBool = AtomicBool::new(false);

const AUX_REQUIRED_FILES: &[&str] = &[
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "generation_config.json",
];
const AUX_OPTIONAL_FILES: &[&str] = &[
    "chat_template.jinja",
    "preprocessor_config.json",
    "video_preprocessor_config.json",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NinferConverterStatus {
    installed: bool,
    ready: bool,
    install_dir: String,
    repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    python_path: Option<String>,
    issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NinferConverterRelease {
    tag: String,
    repo: String,
    release_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_sha256: Option<String>,
    up_to_date: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NinferConverterDownloadProgress {
    phase: String,
    percent: u32,
    downloaded: u64,
    total: u64,
    speed_bps: u64,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NinferConvertInspection {
    compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_reason: Option<String>,
    warnings: Vec<String>,
    architecture: String,
    parameters: String,
    hidden_size: u32,
    intermediate_size: u32,
    block_count: u32,
    attention_heads: u32,
    kv_heads: u32,
    head_dim: u32,
    key_heads: u32,
    value_heads: u32,
    vocab_size: u32,
    has_mtp: bool,
    has_chat_template: bool,
    has_tokenizer_kv: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    recommended_hf_repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    split_info: Option<DetectedSplitGroup>,
    unsupported_tensors: Vec<String>,
    tensor_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NinferAuxConfigFetchResult {
    dir: String,
    repo: String,
    source: String,
    files: Vec<String>,
    missing_required: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NinferConvertOptions {
    gguf_path: String,
    output_path: String,
    #[serde(default)]
    instance_name: Option<String>,
    #[serde(default)]
    aux_dir: Option<String>,
    #[serde(default)]
    auto_reconstruct: bool,
    #[serde(default)]
    include_mtp: bool,
    #[serde(default)]
    vision_path: Option<String>,
    #[serde(default)]
    dflash2_path: Option<String>,
    #[serde(default)]
    chat_template_path: Option<String>,
    #[serde(default)]
    proposal: bool,
    #[serde(default)]
    recipe: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NinferConvertProgress {
    phase: String,
    percent: u32,
    current: u32,
    total: u32,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NinferConvertLogEvent {
    stream: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NinferConvertResult {
    output_path: String,
    size_bytes: u64,
    parts: Vec<String>,
}

struct ConvertGuard;
impl Drop for ConvertGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = ACTIVE_CONVERT_PID.lock() {
            *guard = None;
        }
        CONVERT_CANCEL.store(false, Ordering::Relaxed);
        CONVERT_RUNNING.store(false, Ordering::Relaxed);
    }
}

/// 规范化并校验 GitHub 仓库标识（支持 `owner/repo` 或 `https://github.com/owner/repo`）。
pub(crate) fn normalize_github_repo(raw: &str) -> Result<String, String> {
    let mut text = raw.trim().trim_end_matches('/');
    if text.is_empty() {
        return Ok(DEFAULT_CONVERTER_REPO.to_string());
    }
    if let Some(rest) = text
        .strip_prefix("https://github.com/")
        .or_else(|| text.strip_prefix("http://github.com/"))
    {
        text = rest.trim_end_matches(".git");
    }
    let parts: Vec<&str> = text.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() != 2 {
        return Err("GitHub 仓库格式无效，请填写 owner/repo（如 Crvesoft/cookllm-ninfer-converter）".into());
    }
    let valid_seg = |seg: &str| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    if !valid_seg(parts[0]) || !valid_seg(parts[1]) {
        return Err("GitHub 仓库名称包含非法字符".into());
    }
    Ok(format!("{}/{}", parts[0], parts[1]))
}

fn exe_install_dir() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    let parent = exe_path.parent()?;
    (!parent.as_os_str().is_empty()).then(|| parent.to_path_buf())
}

/// 返回 CookLLM 当前可执行文件所在安装目录，确保转换整合包与缓存默认随程序安放（避免写入 C 盘 AppData）。
fn cookllm_install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = exe_install_dir() {
        return Ok(dir);
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn default_converter_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cookllm_install_dir(app)?.join("ninfer_converter"))
}

fn ensure_dir_writable(dir: &Path, label: &str) -> Result<(), String> {
    let map_perm = |err: std::io::Error| {
        if err.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "{label}失败：目标目录无写入权限（{}）。可点击「选择 / 更改目录」改选其他磁盘可写目录，或以管理员身份运行。",
                dir.display()
            )
        } else {
            format!("{label}失败：{err}")
        }
    };
    fs::create_dir_all(dir).map_err(map_perm)?;
    let probe = dir.join(format!(".cookllm_probe_{}_{}", std::process::id(), now_ms()));
    fs::write(&probe, b"ok").map_err(map_perm)?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

fn is_windows_lock_or_perm_err(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(err.raw_os_error(), Some(5) | Some(32))
}

fn rename_with_retry(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
    let mut last_err = None;
    for attempt in 0..10 {
        match fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(err) if attempt < 9 && is_windows_lock_or_perm_err(&err) => {
                last_err = Some(err);
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "rename failed")))
}

fn copy_dir_tree(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目标目录失败：{e}"))?;
    let entries = fs::read_dir(src).map_err(|e| format!("读取临时目录失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("遍历临时目录失败：{e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_tree(&src_path, &dst_path)?;
        } else {
            // 优先使用轻量重命名；若文件正被 Windows Defender 只读扫描占用（os error 5/32），回退 fs::copy
            if let Err(err) = fs::rename(&src_path, &dst_path) {
                if !is_windows_lock_or_perm_err(&err) {
                    return Err(format!("移动文件 {} 失败：{err}", entry.file_name().to_string_lossy()));
                }
                let mut copied = false;
                let mut last = None;
                for attempt in 0..5 {
                    match fs::copy(&src_path, &dst_path) {
                        Ok(_) => {
                            copied = true;
                            break;
                        }
                        Err(copy_err) if attempt < 4 && is_windows_lock_or_perm_err(&copy_err) => {
                            last = Some(copy_err);
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                        Err(copy_err) => {
                            last = Some(copy_err);
                            break;
                        }
                    }
                }
                if !copied {
                    let detail = last.map(|e| e.to_string()).unwrap_or_else(|| "unknown error".into());
                    return Err(format!("复制文件 {} 失败：{detail}", entry.file_name().to_string_lossy()));
                }
            }
        }
    }
    Ok(())
}

fn effective_converter_dir(app: &AppHandle, config: &AppConfig) -> Result<PathBuf, String> {
    if let Some(custom) = config
        .ninfer_converter_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(PathBuf::from(custom));
    }
    default_converter_dir(app)
}

fn effective_converter_repo(config: &AppConfig) -> String {
    config
        .ninfer_converter_repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|raw| normalize_github_repo(raw).ok())
        .unwrap_or_else(|| DEFAULT_CONVERTER_REPO.to_string())
}

struct BundleLayout {
    root: PathBuf,
    python_exe: PathBuf,
    wrapper_py: PathBuf,
}

fn find_bundle_root_at(dir: &Path) -> Option<BundleLayout> {
    let py_name = if cfg!(windows) { "python.exe" } else { "python3" };
    let check = |candidate: &Path| -> Option<BundleLayout> {
        let wrapper = candidate.join("cookllm_convert.py");
        let tools_convert = candidate.join("tools").join("convert");
        if !wrapper.is_file() || !tools_convert.is_dir() {
            return None;
        }
        let py_candidates = [
            candidate.join("python").join(py_name),
            candidate.join(py_name),
            candidate.join(".venv").join("Scripts").join(py_name),
            candidate.join(".venv").join("bin").join(py_name),
        ];
        let python_exe = py_candidates.into_iter().find(|p| p.is_file())?;
        Some(BundleLayout {
            root: candidate.to_path_buf(),
            python_exe,
            wrapper_py: wrapper,
        })
    };

    if let Some(found) = check(dir) {
        return Some(found);
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(found) = check(&p) {
                    return Some(found);
                }
            }
        }
    }
    None
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    upstream_commit: Option<String>,
}

fn normalize_version_str(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_ascii_lowercase()
}

fn read_bundle_manifest(root: &Path) -> Option<BundleManifest> {
    let path = root.join("bundle-manifest.json");
    let text = fs::read_to_string(path).ok()?;
    let clean = text.trim_start_matches('\u{feff}').trim();
    serde_json::from_str(clean).ok()
}

fn build_converter_status(dir: &Path, repo: String) -> NinferConverterStatus {
    let installed = dir.is_dir();
    if !installed {
        return NinferConverterStatus {
            installed: false,
            ready: false,
            install_dir: dir.to_string_lossy().to_string(),
            repo,
            local_version: None,
            upstream_commit: None,
            python_path: None,
            issues: vec!["尚未安装 NInfer 转换整合包".into()],
        };
    }

    if let Some(layout) = find_bundle_root_at(dir) {
        let manifest = read_bundle_manifest(&layout.root);
        let manifest_ver = manifest
            .as_ref()
            .and_then(|m| m.version.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let version_txt = fs::read_to_string(layout.root.join("version.txt"))
            .ok()
            .and_then(|s| s.lines().next().map(str::trim).map(str::to_string))
            .filter(|s| !s.is_empty());
        return NinferConverterStatus {
            installed: true,
            ready: true,
            install_dir: layout.root.to_string_lossy().to_string(),
            repo,
            local_version: manifest_ver.or(version_txt),
            upstream_commit: manifest.and_then(|m| m.upstream_commit),
            python_path: Some(layout.python_exe.to_string_lossy().to_string()),
            issues: Vec::new(),
        };
    }

    let mut issues = Vec::new();
    let py_name = if cfg!(windows) { "python.exe" } else { "python3" };
    if !dir.join("python").join(py_name).is_file() && !dir.join(py_name).is_file() {
        issues.push(format!("未找到嵌入式 {py_name}"));
    }
    if !dir.join("cookllm_convert.py").is_file() {
        issues.push("缺少 cookllm_convert.py".into());
    }
    if !dir.join("tools").join("convert").is_dir() {
        issues.push("缺少 tools/convert 目录".into());
    }
    NinferConverterStatus {
        installed: true,
        ready: false,
        install_dir: dir.to_string_lossy().to_string(),
        repo,
        local_version: None,
        upstream_commit: None,
        python_path: None,
        issues,
    }
}

#[tauri::command]
pub(crate) fn get_ninfer_converter_status(app: AppHandle) -> Result<NinferConverterStatus, String> {
    let config = read_config(&app)?;
    let dir = effective_converter_dir(&app, &config)?;
    let repo = effective_converter_repo(&config);
    Ok(build_converter_status(&dir, repo))
}

fn fetch_sha256_text(client: &reqwest::blocking::Client, url: &str) -> Option<String> {
    let text = with_net_fallback(client, url, false, |c, u| {
        let resp = c
            .get(u)
            .header("user-agent", HF_UA)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        resp.text().map_err(|e| e.to_string())
    })
    .ok()?;
    let token = text.split_whitespace().next()?.trim().to_ascii_lowercase();
    if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(token)
    } else {
        None
    }
}

fn parse_converter_asset(
    client: &reqwest::blocking::Client,
    release: &serde_json::Value,
) -> Option<(String, String, u64, Option<String>)> {
    let assets = release.get("assets")?.as_array()?;
    let picked = assets
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_string();
            let lower = name.to_lowercase();
            if !lower.ends_with(".zip") {
                return None;
            }
            let url = item.get("browser_download_url")?.as_str()?.to_string();
            if url.is_empty() {
                return None;
            }
            let size = item.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            let digest = item
                .get("digest")
                .and_then(|v| v.as_str())
                .and_then(|s| s.strip_prefix("sha256:"))
                .map(str::to_string);
            let rank = if lower.contains("cookllm-ninfer-converter") && lower.contains("win") {
                0
            } else if lower.contains("converter") && lower.contains("win") {
                1
            } else if lower.contains("win") {
                2
            } else {
                3
            };
            Some((rank, (url, name, size, digest)))
        })
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, v)| v)?;

    let (url, name, size, mut digest) = picked;
    if digest.is_none() {
        let sha_name = format!("{}.sha256", name.to_lowercase());
        if let Some(sha_url) = assets.iter().find_map(|item| {
            let n = item.get("name")?.as_str()?;
            if n.to_lowercase() == sha_name {
                item.get("browser_download_url")?.as_str().map(str::to_string)
            } else {
                None
            }
        }) {
            digest = fetch_sha256_text(client, &sha_url);
        }
    }
    Some((url, name, size, digest))
}

#[tauri::command]
pub(crate) async fn check_ninfer_converter_release(
    app: AppHandle,
    repo: Option<String>,
) -> Result<NinferConverterRelease, String> {
    let config = read_config(&app)?;
    let target_repo = match repo {
        Some(raw) if !raw.trim().is_empty() => normalize_github_repo(&raw)?,
        _ => effective_converter_repo(&config),
    };
    let dir = effective_converter_dir(&app, &config)?;
    let status = build_converter_status(&dir, target_repo.clone());
    let network = config.network.clone().unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        let client = build_net_client(&network)?;
        let api_url = format!("https://api.github.com/repos/{target_repo}/releases/latest");
        let release = fetch_github_release_with_fallback(&client, &api_url)?;
        let tag = release
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if tag.is_empty() {
            return Err("GitHub Release 响应中未包含 tag_name".into());
        }
        let release_url = release
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://github.com/{target_repo}/releases"));
        let release_notes = release
            .get("body")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty());
        let asset = parse_converter_asset(&client, &release);
        let (asset_url, asset_name, asset_size, asset_sha256) = asset
            .map(|(u, n, s, d)| (Some(u), Some(n), Some(s), d))
            .unwrap_or((None, None, None, None));
        let up_to_date = status.ready
            && status
                .local_version
                .as_deref()
                .map(|local| {
                    let a = normalize_version_str(local);
                    let b = normalize_version_str(&tag);
                    !a.is_empty() && !b.is_empty() && a == b
                })
                .unwrap_or(false);
        Ok(NinferConverterRelease {
            tag,
            repo: target_repo,
            release_url,
            release_notes,
            asset_name,
            asset_url,
            asset_size,
            asset_sha256,
            up_to_date,
        })
    })
    .await
    .map_err(|e| format!("检查转换整合包发布失败：{e}"))?
}

fn emit_conv_dl_progress(
    app: &AppHandle,
    phase: &str,
    percent: u32,
    downloaded: u64,
    total: u64,
    speed_bps: u64,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "ninfer-converter-download-progress",
        NinferConverterDownloadProgress {
            phase: phase.into(),
            percent: percent.min(100),
            downloaded,
            total,
            speed_bps,
            message: message.into(),
        },
    );
}

fn stream_download_converter_once(
    cancel: CancelFlag,
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    app: &AppHandle,
) -> Result<u64, String> {
    emit_conv_dl_progress(app, "download", 0, 0, 0, 0, "正在连接下载转换整合包...");
    let mut response = client
        .get(url)
        .header("user-agent", HF_UA)
        .timeout(std::time::Duration::from_secs(3600))
        .send()
        .map_err(|e| format!("下载请求失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(dest).map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut downloaded: u64 = 0;
    let mut buffer = [0u8; 128 * 1024];
    let start_ms = now_ms();
    let mut last_emit_ms = start_ms;
    let mut last_speed_ms = start_ms;
    let mut last_speed_bytes = 0u64;
    let mut speed_bps = 0u64;

    loop {
        if cancel.cancelled() {
            drop(file);
            let _ = fs::remove_file(dest);
            return Err("下载已取消".into());
        }
        let n = response
            .read(&mut buffer)
            .map_err(|e| format!("下载读取中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        downloaded += n as u64;
        let now = now_ms();
        let dt = now.saturating_sub(last_speed_ms);
        if dt >= 500 {
            let instant = downloaded.saturating_sub(last_speed_bytes) * 1000 / dt;
            speed_bps = if speed_bps == 0 {
                instant
            } else {
                (speed_bps * 3 + instant * 7) / 10
            };
            last_speed_ms = now;
            last_speed_bytes = downloaded;
        }
        if now.saturating_sub(last_emit_ms) >= 200 {
            let percent = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0) as u32
            } else {
                0
            };
            let msg = if total > 0 {
                format!(
                    "{:.1} MB / {:.1} MB",
                    downloaded as f64 / (1024.0 * 1024.0),
                    total as f64 / (1024.0 * 1024.0)
                )
            } else {
                format!("{:.1} MB", downloaded as f64 / (1024.0 * 1024.0))
            };
            emit_conv_dl_progress(app, "download", percent, downloaded, total, speed_bps, msg);
            last_emit_ms = now;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    emit_conv_dl_progress(app, "download", 100, downloaded, total, 0, "下载完成");
    Ok(downloaded)
}

fn verify_sha256(path: &Path, expected_sha256: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected_sha256.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let mut file = fs::File::open(path).map_err(|e| format!("校验读取失败：{e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("计算 SHA-256 失败：{e}"))?;
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(format!("整合包 SHA-256 校验失败（期望 {expected}，实际 {actual}）"));
    }
    Ok(())
}

fn safe_zip_path(base: &Path, name: &str) -> Result<PathBuf, String> {
    let mut out = base.to_path_buf();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(seg) => out.push(seg),
            _ => return Err(format!("压缩包内含非法路径：{name}")),
        }
    }
    Ok(out)
}

fn extract_converter_zip(
    cancel: Option<CancelFlag>,
    zip_path: &Path,
    extract_dir: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    emit_conv_dl_progress(app, "extract", 0, 0, 0, 0, "正在解压转换整合包...");
    let file = fs::File::open(zip_path).map_err(|e| format!("打开整合包失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败：{e}"))?;
    let total = archive.len();
    for i in 0..total {
        if cancel.map(|c| c.cancelled()).unwrap_or(false) {
            return Err("安装已取消".into());
        }
        let mut entry = archive.by_index(i).map_err(|e| format!("读取压缩条目失败：{e}"))?;
        let name = entry.name().to_string();
        let out_path = safe_zip_path(extract_dir, &name)?;
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| format!("写入文件失败：{e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压写入失败：{e}"))?;
        if i % 64 == 0 || i + 1 == total {
            let pct = if total > 0 { ((i + 1) * 100 / total) as u32 } else { 100 };
            emit_conv_dl_progress(app, "extract", pct, (i + 1) as u64, total as u64, 0, &name);
        }
    }
    emit_conv_dl_progress(app, "extract", 100, total as u64, total as u64, 0, "解压完成");
    Ok(())
}

fn cleanup_temp_dir_best_effort(dir: &Path) {
    for attempt in 0..5 {
        if !dir.exists() || fs::remove_dir_all(dir).is_ok() {
            return;
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
}

fn install_extracted_bundle(
    extracted_dir: &Path,
    target_dir: &Path,
    tag: Option<&str>,
) -> Result<(), String> {
    let layout = find_bundle_root_at(extracted_dir).ok_or_else(|| {
        "压缩包内缺少有效转换器结构（需包含 python/python.exe、tools/convert 与 cookllm_convert.py）"
            .to_string()
    })?;
    let source_root = layout.root;

    if let Some(parent) = target_dir.parent() {
        ensure_dir_writable(parent, "创建目标父目录")?;
    }
    let backup = target_dir.with_extension(format!("old-{}", now_ms()));
    if target_dir.exists() {
        rename_with_retry(target_dir, &backup).map_err(|e| format!("备份旧转换器目录失败：{e}"))?;
    }
    if let Err(err) = rename_with_retry(&source_root, target_dir) {
        if is_windows_lock_or_perm_err(&err) {
            if let Err(copy_err) = copy_dir_tree(&source_root, target_dir) {
                let _ = fs::remove_dir_all(target_dir);
                if backup.exists() {
                    let _ = rename_with_retry(&backup, target_dir);
                }
                return Err(format!("写入转换器目录失败：{copy_err}"));
            }
        } else {
            if backup.exists() {
                let _ = rename_with_retry(&backup, target_dir);
            }
            return Err(format!("写入转换器目录失败：{err}"));
        }
    }
    if backup.exists() {
        cleanup_temp_dir_best_effort(&backup);
    }
    if let Some(t) = tag.map(str::trim).filter(|s| !s.is_empty()) {
        let _ = fs::write(target_dir.join("version.txt"), format!("{t}\n"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn download_ninfer_converter(
    app: AppHandle,
    repo: Option<String>,
    asset_url: Option<String>,
    asset_name: Option<String>,
    tag: Option<String>,
    sha256: Option<String>,
) -> Result<NinferConverterStatus, String> {
    if CONVERT_RUNNING.load(Ordering::Relaxed) {
        return Err("正在执行模型转换，请先停止转换后再更新整合包".into());
    }
    let mut config = read_config(&app)?;
    let target_repo = match repo {
        Some(raw) if !raw.trim().is_empty() => normalize_github_repo(&raw)?,
        _ => effective_converter_repo(&config),
    };
    let target_dir = effective_converter_dir(&app, &config)?;
    let default_dir = default_converter_dir(&app)?;
    let network = config.network.clone().unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        let cancel = CancelFlag(&CONVERTER_DL_CANCEL);
        let _guard = CancelGuard(cancel);
        let client = build_net_client(&network)?;

        let (dl_url, dl_name, dl_tag, dl_sha) = match (asset_url, asset_name) {
            (Some(u), Some(n)) => (u, n, tag.unwrap_or_default(), sha256),
            _ => {
                let api_url = format!("https://api.github.com/repos/{target_repo}/releases/latest");
                let release = fetch_github_release_with_fallback(&client, &api_url)?;
                let resolved_tag = release
                    .get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let (u, n, _s, d) = parse_converter_asset(&client, &release)
                    .ok_or_else(|| format!("仓库 {target_repo} 的最新 Release 中未找到 Windows 整合包（.zip）"))?;
                (u, n, resolved_tag, d)
            }
        };

        let parsed = reqwest::Url::parse(dl_url.trim())
            .map_err(|_| "转换整合包下载地址无效".to_string())?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
            return Err("转换整合包下载地址必须是 github.com HTTPS 链接".into());
        }

        let parent = target_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| target_dir.clone());
        let temp_root = parent.join(".ninfer_converter_tmp");
        if temp_root.exists() {
            let _ = fs::remove_dir_all(&temp_root);
        }
        ensure_dir_writable(&temp_root, "创建临时目录")?;

        let safe_name = Path::new(&dl_name)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("converter.zip");
        let zip_path = temp_root.join(safe_name);
        let extract_dir = temp_root.join("extract");
        ensure_dir_writable(&extract_dir, "创建解压目录")?;

        let dl_res = with_net_fallback(&client, dl_url.trim(), false, |c, u| {
            stream_download_converter_once(cancel, c, u, &zip_path, &app)
        });
        if let Err(errors) = dl_res {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(format!("下载失败（{}）", errors.join("；")));
        }

        if let Err(err) = verify_sha256(&zip_path, dl_sha.as_deref()) {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(err);
        }
        if let Err(err) = extract_converter_zip(Some(cancel), &zip_path, &extract_dir, &app) {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(err);
        }
        emit_conv_dl_progress(&app, "install", 95, 0, 0, 0, "正在部署转换整合包...");
        if let Err(err) = install_extracted_bundle(&extract_dir, &target_dir, Some(&dl_tag)) {
            cleanup_temp_dir_best_effort(&temp_root);
            return Err(err);
        }
        cleanup_temp_dir_best_effort(&temp_root);

        config.ninfer_converter_repo = Some(target_repo.clone());
        if target_dir == default_dir {
            config.ninfer_converter_dir = None;
        } else {
            config.ninfer_converter_dir = Some(target_dir.to_string_lossy().to_string());
        }
        save_config(app.clone(), config)?;

        emit_conv_dl_progress(&app, "done", 100, 0, 0, 0, "NInfer 转换整合包已就绪");
        Ok(build_converter_status(&target_dir, target_repo))
    })
    .await
    .map_err(|e| format!("下载任务中断：{e}"))?
}

#[tauri::command]
pub(crate) fn cancel_ninfer_converter_download() -> Result<(), String> {
    CancelFlag(&CONVERTER_DL_CANCEL).cancel();
    Ok(())
}

#[tauri::command]
pub(crate) async fn import_ninfer_converter_zip(app: AppHandle) -> Result<Option<NinferConverterStatus>, String> {
    if CONVERT_RUNNING.load(Ordering::Relaxed) {
        return Err("正在执行模型转换，请先停止转换后再导入整合包".into());
    }
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("NInfer 转换整合包 (*.zip)", &["zip"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let Some(zip_path) = picked.as_path().map(Path::to_path_buf) else {
        return Ok(None);
    };

    let mut config = read_config(&app)?;
    let target_dir = effective_converter_dir(&app, &config)?;
    let default_dir = default_converter_dir(&app)?;
    let repo = effective_converter_repo(&config);

    let status = tauri::async_runtime::spawn_blocking(move || {
        let parent = target_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| target_dir.clone());
        let temp_root = parent.join(".ninfer_converter_import_tmp");
        if temp_root.exists() {
            let _ = fs::remove_dir_all(&temp_root);
        }
        let extract_dir = temp_root.join("extract");
        ensure_dir_writable(&extract_dir, "创建临时解压目录")?;
        if let Err(err) = extract_converter_zip(None, &zip_path, &extract_dir, &app) {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(err);
        }
        if let Err(err) = install_extracted_bundle(&extract_dir, &target_dir, None) {
            cleanup_temp_dir_best_effort(&temp_root);
            return Err(err);
        }
        cleanup_temp_dir_best_effort(&temp_root);
        if target_dir == default_dir {
            config.ninfer_converter_dir = None;
        } else {
            config.ninfer_converter_dir = Some(target_dir.to_string_lossy().to_string());
        }
        save_config(app.clone(), config)?;
        emit_conv_dl_progress(&app, "done", 100, 0, 0, 0, "本地转换整合包已导入");
        Ok::<NinferConverterStatus, String>(build_converter_status(&target_dir, repo))
    })
    .await
    .map_err(|e| format!("导入任务中断：{e}"))??;

    Ok(Some(status))
}

fn resolve_custom_install_dir(picked: &Path) -> PathBuf {
    let is_ninfer_named = picked
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("ninfer_converter"));
    let is_empty = fs::read_dir(picked)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false);
    if is_ninfer_named || is_empty {
        picked.to_path_buf()
    } else {
        picked.join("ninfer_converter")
    }
}

#[tauri::command]
pub(crate) fn pick_ninfer_converter_dir(app: AppHandle) -> Result<Option<NinferConverterStatus>, String> {
    if CONVERT_RUNNING.load(Ordering::Relaxed) {
        return Err("正在执行模型转换，请先停止转换后再更改目录".into());
    }
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Some(folder) = picked.as_path() else {
        return Ok(None);
    };
    let target = if let Some(layout) = find_bundle_root_at(folder) {
        layout.root
    } else {
        let candidate = resolve_custom_install_dir(folder);
        let check_dir = candidate.parent().unwrap_or(&candidate);
        ensure_dir_writable(check_dir, "检查所选安装目录写入权限")?;
        candidate
    };
    let mut config = read_config(&app)?;
    let default_dir = default_converter_dir(&app)?;
    if target == default_dir {
        config.ninfer_converter_dir = None;
    } else {
        config.ninfer_converter_dir = Some(target.to_string_lossy().to_string());
    }
    let repo = effective_converter_repo(&config);
    save_config(app, config)?;
    Ok(Some(build_converter_status(&target, repo)))
}

#[tauri::command]
pub(crate) fn remove_ninfer_converter(app: AppHandle) -> Result<NinferConverterStatus, String> {
    if CONVERT_RUNNING.load(Ordering::Relaxed) {
        return Err("正在执行模型转换，请先停止转换后再卸载".into());
    }
    let mut config = read_config(&app)?;
    let active_dir = effective_converter_dir(&app, &config)?;
    let default_dir = default_converter_dir(&app)?;
    let remove_safe = active_dir == default_dir
        || active_dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("ninfer_converter"));
    if remove_safe && active_dir.exists() {
        fs::remove_dir_all(&active_dir).map_err(|e| format!("删除转换器目录失败：{e}"))?;
    } else if default_dir.exists() {
        fs::remove_dir_all(&default_dir).map_err(|e| format!("删除转换器目录失败：{e}"))?;
    }
    config.ninfer_converter_dir = None;
    let repo = effective_converter_repo(&config);
    save_config(app, config)?;
    Ok(build_converter_status(&default_dir, repo))
}

/* ==================== GGUF 深度预检（转换前门禁） ==================== */

#[derive(Debug, Clone)]
enum GgufScalar {
    U32(u32),
    U64(u64),
    Str(String),
}

struct ParsedGgufHeader {
    kv_scalars: BTreeMap<String, GgufScalar>,
    kv_array_lens: BTreeMap<String, u64>,
    tensors: Vec<(String, Vec<u64>, u32)>,
}

fn ggml_type_name(id: u32) -> &'static str {
    match id {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        6 => "Q5_0",
        7 => "Q5_1",
        8 => "Q8_0",
        9 => "Q8_1",
        10 => "Q2_K",
        11 => "Q3_K",
        12 => "Q4_K",
        13 => "Q5_K",
        14 => "Q6_K",
        15 => "Q8_K",
        16 => "IQ2_XXS",
        17 => "IQ2_XS",
        18 => "IQ3_XXS",
        19 => "IQ1_S",
        20 => "IQ4_NL",
        21 => "IQ3_S",
        22 => "IQ2_S",
        23 => "IQ4_XS",
        24 => "I8",
        25 => "I16",
        26 => "I32",
        27 => "I64",
        28 => "F64",
        29 => "IQ1_M",
        30 => "BF16",
        142 => "PQ2_0",
        143 => "PTQ1_0",
        _ => "UNKNOWN",
    }
}

fn is_supported_gguf_blocks_type(id: u32) -> bool {
    matches!(
        id,
        0 | 1 | 8 | 10 | 11 | 12 | 13 | 14 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 29 | 30 | 142 | 143
    )
}

fn parse_gguf_header(path: &Path) -> Result<ParsedGgufHeader, String> {
    let file = fs::File::open(path).map_err(|e| format!("无法打开 GGUF 文件：{e}"))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut header = [0u8; 24];
    reader
        .read_exact(&mut header)
        .map_err(|_| "读取 GGUF 文件头失败（文件已截断）".to_string())?;
    if &header[0..4] != b"GGUF" {
        return Err("不是有效的 GGUF 文件".into());
    }
    let version = u32::from_le_bytes(header[4..8].try_into().unwrap_or([0; 4]));
    if version < 2 {
        return Err(format!("不支持的 GGUF 版本 v{version}（需 v2/v3）"));
    }
    let tensor_count = u64::from_le_bytes(header[8..16].try_into().unwrap_or([0; 8]));
    let kv_count = u64::from_le_bytes(header[16..24].try_into().unwrap_or([0; 8]));
    if tensor_count > 1_000_000 || kv_count > 100_000 {
        return Err("GGUF 文件头条目数异常".into());
    }

    fn read_exact_vec(r: &mut impl Read, len: usize) -> Result<Vec<u8>, String> {
        if len > 64 * 1024 * 1024 {
            return Err("GGUF 字符串字段过大".into());
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf).map_err(|_| "GGUF 头部读取意外结束".to_string())?;
        Ok(buf)
    }
    fn skip_n(r: &mut impl Read, len: usize) -> Result<(), String> {
        let copied = std::io::copy(&mut r.by_ref().take(len as u64), &mut std::io::sink())
            .map_err(|e| format!("跳过 GGUF 字段失败：{e}"))?;
        if copied != len as u64 {
            return Err("GGUF 头部读取意外结束".into());
        }
        Ok(())
    }
    fn read_u32(r: &mut impl Read) -> Result<u32, String> {
        let b = read_exact_vec(r, 4)?;
        Ok(u32::from_le_bytes(b.try_into().unwrap_or([0; 4])))
    }
    fn read_u64(r: &mut impl Read) -> Result<u64, String> {
        let b = read_exact_vec(r, 8)?;
        Ok(u64::from_le_bytes(b.try_into().unwrap_or([0; 8])))
    }
    fn read_str(r: &mut impl Read) -> Result<String, String> {
        let len = read_u64(r)? as usize;
        let b = read_exact_vec(r, len)?;
        Ok(String::from_utf8_lossy(&b).to_string())
    }
    fn skip_str(r: &mut impl Read) -> Result<(), String> {
        let len = read_u64(r)? as usize;
        skip_n(r, len)
    }

    let mut kv_scalars = BTreeMap::new();
    let mut kv_array_lens = BTreeMap::new();

    for _ in 0..kv_count {
        let key = read_str(&mut reader)?;
        let vtype = read_u32(&mut reader)?;
        match vtype {
            8 => {
                const WANTED_STR_KEYS: &[&str] = &[
                    "general.architecture",
                    "general.name",
                    "general.basename",
                    "general.repo_url",
                    "general.url",
                    "general.base_model.0.repo_url",
                    "general.base_model.0.name",
                    "general.base_model.1.repo_url",
                    "tokenizer.chat_template",
                ];
                if WANTED_STR_KEYS.contains(&key.as_str()) {
                    let s = read_str(&mut reader)?;
                    kv_scalars.insert(key, GgufScalar::Str(s));
                } else {
                    skip_str(&mut reader)?;
                }
            }
            4 | 5 => {
                let v = read_u32(&mut reader)?;
                kv_scalars.insert(key, GgufScalar::U32(v));
            }
            10 | 11 => {
                let v = read_u64(&mut reader)?;
                kv_scalars.insert(key, GgufScalar::U64(v));
            }
            0 | 1 | 7 => skip_n(&mut reader, 1)?,
            2 | 3 => skip_n(&mut reader, 2)?,
            6 => skip_n(&mut reader, 4)?,
            12 => skip_n(&mut reader, 8)?,
            9 => {
                let arr_type = read_u32(&mut reader)?;
                let len = read_u64(&mut reader)?;
                if len > 2_000_000 {
                    return Err("GGUF 数组长度异常".into());
                }
                kv_array_lens.insert(key, len);
                for _ in 0..len {
                    if arr_type == 8 {
                        skip_str(&mut reader)?;
                    } else {
                        let elem_size = match arr_type {
                            0 | 1 | 7 => 1,
                            2 | 3 => 2,
                            4 | 5 | 6 => 4,
                            10 | 11 | 12 => 8,
                            _ => return Err(format!("不支持的 GGUF 数组元素类型 {arr_type}")),
                        };
                        skip_n(&mut reader, elem_size)?;
                    }
                }
            }
            _ => return Err(format!("不支持的 GGUF 值类型 {vtype}")),
        }
    }

    let mut tensors = Vec::with_capacity(tensor_count as usize);
    for _ in 0..tensor_count {
        let name = read_str(&mut reader)?;
        let rank = read_u32(&mut reader)?;
        if rank > 8 {
            return Err(format!("张量 {name} 维度异常：{rank}"));
        }
        let mut dims = Vec::with_capacity(rank as usize);
        for _ in 0..rank {
            dims.push(read_u64(&mut reader)?);
        }
        // GGUF 维度倒序为行优先
        dims.reverse();
        let type_id = read_u32(&mut reader)?;
        let _offset = read_u64(&mut reader)?;
        tensors.push((name, dims, type_id));
    }

    Ok(ParsedGgufHeader {
        kv_scalars,
        kv_array_lens,
        tensors,
    })
}

fn extract_model_repo_from_url(raw: &str) -> Option<String> {
    let mut text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Some((head, _)) = text.split_once(['?', '#']) {
        text = head;
    }
    text = text.trim_end_matches('/');
    for prefix in [
        "https://huggingface.co/",
        "http://huggingface.co/",
        "https://hf-mirror.com/",
        "http://hf-mirror.com/",
        "https://modelscope.cn/models/",
        "http://modelscope.cn/models/",
        "https://www.modelscope.cn/models/",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest;
            break;
        }
    }
    let parts: Vec<&str> = text.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    // 忽略如 owner/repo/tree/main 或 ModelScope /files 之后的路径片段，仅提取两段 owner/repo
    if parts.len() > 2 && !matches!(parts[2], "tree" | "blob" | "resolve" | "files" | "summary") {
        return None;
    }
    let owner = parts[0];
    let repo = parts[1].trim_end_matches(".git");
    let valid_seg = |seg: &str| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    if !valid_seg(owner) || !valid_seg(repo) {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn is_quant_only_repo(repo_id: &str) -> bool {
    let lower = repo_id.to_ascii_lowercase();
    lower.ends_with("-gguf") || lower.ends_with("_gguf")
}

fn recommend_qwen_aux_repo(
    header: &ParsedGgufHeader,
    file_name: &str,
    hidden: u32,
    text_layers: u32,
) -> Option<String> {
    let get_str = |key: &str| match header.kv_scalars.get(key) {
        Some(GgufScalar::Str(s)) => s.trim(),
        _ => "",
    };

    // 1. 优先读取 GGUF 元数据写入的上游基座仓库 URL（如 Qwen/Qwen3.8-27B、ukisai/Swift-1.5-Qwen3.8-27b）
    for key in ["general.base_model.0.repo_url", "general.base_model.1.repo_url"] {
        if let Some(repo) = extract_model_repo_from_url(get_str(key)) {
            if !is_quant_only_repo(&repo) {
                return Some(repo);
            }
        }
    }

    // 2. 结合文件名与 GGUF 名称字段识别社区常见变体（Swift-1.5 / Qwen3.8）
    let hint = format!(
        "{file_name} {} {} {} {}",
        get_str("general.name"),
        get_str("general.basename"),
        get_str("general.base_model.0.name"),
        get_str("general.repo_url"),
    )
    .to_ascii_lowercase();
    let tpl = get_str("tokenizer.chat_template");

    if (hidden, text_layers) == (5120, 64) {
        if hint.contains("swift-1.5") || hint.contains("swift1.5") || hint.contains("swift_1.5") || hint.contains("swift") {
            return Some("ukisai/Swift-1.5-Qwen3.8-27b".into());
        }
        if hint.contains("qwen3.8")
            || hint.contains("qwen3_8")
            || hint.contains("qwen-3.8")
            || tpl.contains("resolved_reasoning_effort")
        {
            return Some("Qwen/Qwen3.8-27B".into());
        }
    }

    for key in ["general.repo_url", "general.url"] {
        if let Some(repo) = extract_model_repo_from_url(get_str(key)) {
            if !is_quant_only_repo(&repo) {
                return Some(repo);
            }
        }
    }

    // 3. 回退到按几何规模匹配的官方基座系列
    match (hidden, text_layers) {
        (1024, 24) => Some("Qwen/Qwen3.5-0.8B".into()),
        (2048, 24) => Some("Qwen/Qwen3.5-2B".into()),
        (2560, 32) => Some("Qwen/Qwen3.5-4B".into()),
        (4096, 32) => Some("Qwen/Qwen3.5-9B".into()),
        (5120, 64) => Some("Qwen/Qwen3.5-27B".into()),
        _ => None,
    }
}

pub(crate) fn inspect_gguf_for_ninfer_impl(path: &str) -> Result<NinferConvertInspection, String> {
    let target = Path::new(path);
    if !target.is_file() {
        return Err(format!("GGUF 文件不存在：{path}"));
    }

    let split_info = find_split_group_impl(target);
    let primary_path = split_info
        .as_ref()
        .map(|g| PathBuf::from(&g.primary_path))
        .unwrap_or_else(|| target.to_path_buf());

    let header = parse_gguf_header(&primary_path)?;
    let mut all_tensors = header.tensors.clone();

    if let Some(ref group) = split_info {
        for part in &group.parts {
            let p = Path::new(part);
            if p != primary_path {
                if let Ok(part_hdr) = parse_gguf_header(p) {
                    all_tensors.extend(part_hdr.tensors);
                }
            }
        }
    }

    let get_u32 = |keys: &[&str]| -> u32 {
        for k in keys {
            if let Some(val) = header.kv_scalars.get(*k) {
                match val {
                    GgufScalar::U32(v) => return *v,
                    GgufScalar::U64(v) => return *v as u32,
                    GgufScalar::Str(_) => {}
                }
            }
        }
        0
    };

    let raw_arch = match header.kv_scalars.get("general.architecture") {
        Some(GgufScalar::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let arch_lower = raw_arch.to_lowercase();

    let params_str = header
        .kv_scalars
        .get("general.parameter_count")
        .and_then(|v| match v {
            GgufScalar::U64(n) => Some(*n as f64),
            GgufScalar::U32(n) => Some(*n as f64),
            _ => None,
        })
        .map(|n| {
            if n >= 1e9 {
                format!("{:.1}B", n / 1e9)
            } else if n >= 1e6 {
                format!("{:.0}M", n / 1e6)
            } else {
                format!("{n:.0}")
            }
        })
        .unwrap_or_default();

    let hidden_size = get_u32(&["qwen35.embedding_length", "qwen3_5.embedding_length"]);
    let intermediate_size = get_u32(&["qwen35.feed_forward_length", "qwen3_5.feed_forward_length"]);
    let block_count = get_u32(&["qwen35.block_count", "qwen3_5.block_count"]);
    let attention_heads = get_u32(&["qwen35.attention.head_count", "qwen3_5.attention.head_count"]);
    let kv_heads = get_u32(&["qwen35.attention.head_count_kv", "qwen3_5.attention.head_count_kv"]);
    let head_dim = get_u32(&["qwen35.attention.key_length", "qwen3_5.attention.key_length"]);
    let key_heads = get_u32(&["qwen35.ssm.group_count", "qwen3_5.ssm.group_count"]);
    let value_heads = get_u32(&["qwen35.ssm.time_step_rank", "qwen3_5.ssm.time_step_rank"]);
    let state_size = get_u32(&["qwen35.ssm.state_size", "qwen3_5.ssm.state_size"]);
    let conv_kernel = get_u32(&["qwen35.ssm.conv_kernel", "qwen3_5.ssm.conv_kernel"]);
    let interval = get_u32(&["qwen35.full_attention_interval", "qwen3_5.full_attention_interval"]);
    let expert_count = get_u32(&["qwen35.expert_count", "qwen3_5.expert_count", "qwen35moe.expert_count"]);

    let vocab_size = all_tensors
        .iter()
        .find(|(name, _, _)| name == "token_embd.weight")
        .and_then(|(_, dims, _)| dims.first().copied())
        .unwrap_or(0) as u32;

    // -mtp 导出格式会把额外 MTP 块计入 qwen35.block_count（如 64 层文本 + blk.64.nextn = 65），需还原真实文本层数
    let mtp_at = |idx: u32| format!("blk.{idx}.nextn.eh_proj.weight");
    let mtp_at_last =
        block_count > 0 && all_tensors.iter().any(|(n, _, _)| n == &mtp_at(block_count - 1));
    let mtp_at_next =
        block_count > 0 && all_tensors.iter().any(|(n, _, _)| n == &mtp_at(block_count));
    let text_layers = if mtp_at_last {
        block_count - 1
    } else {
        block_count
    };
    let has_mtp = mtp_at_last
        || mtp_at_next
        || all_tensors
            .iter()
            .any(|(n, _, _)| n.ends_with(".nextn.eh_proj.weight"));
    let has_chat_template = matches!(
        header.kv_scalars.get("tokenizer.chat_template"),
        Some(GgufScalar::Str(s)) if !s.trim().is_empty()
    );
    let has_tokenizer_kv = header
        .kv_array_lens
        .get("tokenizer.ggml.tokens")
        .copied()
        .unwrap_or(0)
        > 0;

    let mut unsupported_tensors = Vec::new();
    let mut has_ternary = false;
    for (name, _, type_id) in &all_tensors {
        if *type_id == 142 || *type_id == 143 {
            has_ternary = true;
        }
        if !is_supported_gguf_blocks_type(*type_id) {
            unsupported_tensors.push(format!("{name} ({})", ggml_type_name(*type_id)));
        }
    }

    let mut warnings = Vec::new();
    let mut block_reason: Option<String> = None;

    if let Some(ref group) = split_info {
        if !group.missing_parts.is_empty() {
            let missing = group
                .missing_parts
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            block_reason = Some(format!(
                "分卷 GGUF 不完整：共 {} 卷，缺失第 {} 卷，请补齐后再转换",
                group.total, missing
            ));
        }
    }

    if block_reason.is_none() {
        if arch_lower == "qwen35moe" || expert_count > 0 {
            block_reason = Some(
                "检测到 Qwen3.5 MoE 混合专家架构：NInfer GGUF 直装配方仅支持稠密模型；MoE 模型可直接使用 KVMem v0.19.1 的 PolyStrata 或 llama.cpp 引擎运行该 GGUF"
                    .into(),
            );
        } else if arch_lower != "qwen35" && arch_lower != "qwen3_5" {
            block_reason = Some(format!(
                "当前架构「{}」暂不支持直转为 NInfer v3（仅支持 Qwen3.5 / Qwen3.6 / Qwen3.8 稠密架构 qwen35）",
                if raw_arch.is_empty() { "未知" } else { &raw_arch }
            ));
        } else {
            let valid_heads = matches!((attention_heads, kv_heads), (8, 2) | (16, 4) | (24, 4));
            let valid_value_heads = matches!(value_heads, 16 | 32 | 48);
            if !valid_heads
                || head_dim != 256
                || state_size != 128
                || conv_kernel != 4
                || key_heads != 16
                || !valid_value_heads
                || hidden_size == 0
                || hidden_size % 128 != 0
                || interval != 4
            {
                block_reason = Some(format!(
                    "模型几何参数与 Qwen3.5 稠密 NInfer 内核要求不匹配（heads={attention_heads}/{kv_heads}, head_dim={head_dim}, ssm={key_heads}/{value_heads}/{state_size}, interval={interval}）"
                ));
            } else if !unsupported_tensors.is_empty() {
                let sample = unsupported_tensors
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("、");
                block_reason = Some(format!(
                    "包含 NInfer gguf_blocks_v1 暂不支持的张量格式（共 {} 个，如 {sample}）；当前仅支持 Q8_0 / Q2_K~Q6_K / IQ1_S~IQ4_XS 等标准块格式",
                    unsupported_tensors.len()
                ));
            }
        }
    }

    if has_ternary {
        warnings.push("检测到三值量化（PQ2_0 / PTQ1_0）张量，转换时需按三值模型匹配配置".into());
    }
    if !has_chat_template {
        warnings.push("GGUF 内未检测到 tokenizer.chat_template，自动重构时将使用内置 Qwen3.8 默认对话模板".into());
    }
    if !has_tokenizer_kv {
        warnings.push("GGUF 内未检测到词表元数据，请通过「在线拉取配置」或「本地 HF 目录」提供分词器文件".into());
    }

    let file_name = primary_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    Ok(NinferConvertInspection {
        compatible: block_reason.is_none(),
        block_reason,
        warnings,
        architecture: raw_arch,
        parameters: params_str,
        hidden_size,
        intermediate_size,
        block_count: text_layers,
        attention_heads,
        kv_heads,
        head_dim,
        key_heads,
        value_heads,
        vocab_size,
        has_mtp,
        has_chat_template,
        has_tokenizer_kv,
        recommended_hf_repo: recommend_qwen_aux_repo(&header, file_name, hidden_size, text_layers),
        split_info,
        unsupported_tensors,
        tensor_count: all_tensors.len(),
    })
}

#[tauri::command]
pub(crate) async fn inspect_gguf_for_ninfer(path: String) -> Result<NinferConvertInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_gguf_for_ninfer_impl(&path))
        .await
        .map_err(|e| format!("预检任务中断：{e}"))?
}

/* ==================== 在线轻量辅助配置拉取（HF / ModelScope） ==================== */

fn sanitize_repo_dir(repo: &str) -> String {
    repo.trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn fetch_small_text_file(
    client: &reqwest::blocking::Client,
    url: &str,
    hf_token: &str,
    is_ms: bool,
) -> Result<Option<Vec<u8>>, String> {
    let attempt = |c: &reqwest::blocking::Client, u: &str| -> Result<Option<Vec<u8>>, String> {
        let mut req = c
            .get(u)
            .header("user-agent", HF_UA)
            .timeout(std::time::Duration::from_secs(30));
        if !is_ms
            && !hf_token.trim().is_empty()
            && (u.starts_with("https://huggingface.co") || u.contains("hf-mirror.com"))
        {
            req = req.bearer_auth(hf_token.trim());
        }
        let resp = req.send().map_err(|e| e.to_string())?;
        let code = resp.status().as_u16();
        if code == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {code}"));
        }
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        Ok(Some(bytes.to_vec()))
    };

    if is_ms {
        with_ms_net_fallback(client, url, attempt).map_err(|errs| errs.join("；"))
    } else {
        with_net_fallback(client, url, true, attempt).map_err(|errs| errs.join("；"))
    }
}

#[tauri::command]
pub(crate) async fn fetch_hf_aux_configs(
    app: AppHandle,
    repo: String,
    source: Option<String>,
) -> Result<NinferAuxConfigFetchResult, String> {
    let repo_id = extract_model_repo_from_url(&repo).ok_or_else(|| {
        "请输入有效的模型仓库 ID 或 URL（例如 Qwen/Qwen3.8-27B 或 ukisai/Swift-1.5-Qwen3.8-27b）"
            .to_string()
    })?;
    let src = source
        .as_deref()
        .unwrap_or("hf")
        .trim()
        .to_ascii_lowercase();
    let is_ms = src == "ms" || src == "modelscope";

    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let hf_token = config.hf_token.clone().unwrap_or_default();
    let aux_base = config
        .ninfer_converter_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|p| Path::new(p).parent().map(Path::to_path_buf))
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(cookllm_install_dir(&app)?);
    let cache_root = aux_base
        .join("ninfer_aux_cache")
        .join(sanitize_repo_dir(&repo_id));

    tauri::async_runtime::spawn_blocking(move || {
        ensure_dir_writable(&cache_root, "创建配置缓存目录")?;
        // 清理同仓库旧缓存中的辅助文件，避免残留不同变体的 chat_template / json
        for old_name in AUX_REQUIRED_FILES.iter().chain(AUX_OPTIONAL_FILES.iter()) {
            let p = cache_root.join(old_name);
            if p.is_file() {
                let _ = fs::remove_file(p);
            }
        }
        let client = build_net_client(&network)?;

        let mut downloaded_files = Vec::new();
        let mut missing_required = Vec::new();

        for name in AUX_REQUIRED_FILES.iter().chain(AUX_OPTIONAL_FILES.iter()) {
            let url = if is_ms {
                format!(
                    "https://modelscope.cn/api/v1/models/{repo_id}/repo?Revision=master&FilePath={name}"
                )
            } else {
                format!("https://huggingface.co/{repo_id}/resolve/main/{name}")
            };
            let fetched = fetch_small_text_file(&client, &url, &hf_token, is_ms)?;
            if let Some(bytes) = fetched {
                let dest = cache_root.join(name);
                fs::write(&dest, &bytes).map_err(|e| format!("写入 {name} 失败：{e}"))?;
                downloaded_files.push((*name).to_string());
            } else if AUX_REQUIRED_FILES.contains(name) {
                missing_required.push((*name).to_string());
            }
        }

        // 若未单独提供 chat_template.jinja，尝试从 tokenizer_config.json 中提取 chat_template 字段
        if !cache_root.join("chat_template.jinja").is_file() {
            if let Ok(tok_cfg_raw) = fs::read_to_string(cache_root.join("tokenizer_config.json")) {
                if let Ok(tok_cfg) = serde_json::from_str::<serde_json::Value>(&tok_cfg_raw) {
                    if let Some(tpl) = tok_cfg.get("chat_template").and_then(|v| v.as_str()) {
                        if !tpl.trim().is_empty()
                            && fs::write(cache_root.join("chat_template.jinja"), tpl).is_ok()
                        {
                            downloaded_files.push("chat_template.jinja".into());
                        }
                    }
                }
            }
        }

        let _ = hf_mirror_url; // keep explicit reference aligned with system.rs usage
        Ok(NinferAuxConfigFetchResult {
            dir: cache_root.to_string_lossy().to_string(),
            repo: repo_id,
            source: if is_ms { "ms".into() } else { "hf".into() },
            files: downloaded_files,
            missing_required,
        })
    })
    .await
    .map_err(|e| format!("拉取配置文件任务中断：{e}"))?
}

/* ==================== 转换执行与进程生命周期 ==================== */

#[tauri::command]
pub(crate) fn pick_ninfer_output_file(
    app: AppHandle,
    default_name: Option<String>,
    default_dir: Option<String>,
) -> Result<String, String> {
    let mut builder = app.dialog().file().add_filter("NInfer 模型 (*.ninfer)", &["ninfer"]);
    if let Some(name) = default_name.as_deref().filter(|s| !s.trim().is_empty()) {
        builder = builder.set_file_name(name.trim());
    }
    if let Some(dir) = default_dir.as_deref().map(Path::new).filter(|p| p.is_dir()) {
        builder = builder.set_directory(dir);
    }
    let Some(picked) = builder.blocking_save_file() else {
        return Ok(String::new());
    };
    let Some(path) = picked.as_path() else {
        return Ok(String::new());
    };
    let mut out = path.to_path_buf();
    if out.extension().and_then(|e| e.to_str()).map(|e| !e.eq_ignore_ascii_case("ninfer")).unwrap_or(true) {
        out.set_extension("ninfer");
    }
    Ok(out.to_string_lossy().to_string())
}

fn emit_convert_progress(
    app: &AppHandle,
    phase: &str,
    percent: u32,
    current: u32,
    total: u32,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "ninfer-convert-progress",
        NinferConvertProgress {
            phase: phase.into(),
            percent: percent.min(100),
            current,
            total,
            message: message.into(),
        },
    );
}

fn emit_convert_log(app: &AppHandle, stream: &str, line: impl Into<String>) {
    let text = line.into();
    let _ = app.emit(
        "ninfer-convert-log",
        NinferConvertLogEvent {
            stream: stream.into(),
            line: text.clone(),
        },
    );
    emit_log(app, if stream == "stderr" { "stderr" } else { "system" }, text);
}

fn terminate_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).output();
    }
}

#[tauri::command]
pub(crate) fn cancel_ninfer_convert() -> Result<(), String> {
    CONVERT_CANCEL.store(true, Ordering::Relaxed);
    if let Ok(guard) = ACTIVE_CONVERT_PID.lock() {
        if let Some(pid) = *guard {
            terminate_pid_tree(pid);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn convert_gguf_to_ninfer(
    app: AppHandle,
    options: NinferConvertOptions,
) -> Result<NinferConvertResult, String> {
    if CONVERT_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有模型转换任务正在进行中，请等待完成或先取消".into());
    }
    CONVERT_CANCEL.store(false, Ordering::Relaxed);

    let config = read_config(&app)?;
    let converter_dir = effective_converter_dir(&app, &config)?;

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ConvertGuard;

        let layout = find_bundle_root_at(&converter_dir).ok_or_else(|| {
            "NInfer 转换整合包尚未安装或文件不完整，请先下载安装转换整合包".to_string()
        })?;

        let inspection = inspect_gguf_for_ninfer_impl(&options.gguf_path)?;
        if !inspection.compatible {
            return Err(inspection
                .block_reason
                .unwrap_or_else(|| "该 GGUF 模型暂不兼容 NInfer v3 转换".into()));
        }

        let source_gguf = inspection
            .split_info
            .as_ref()
            .map(|g| g.primary_path.clone())
            .unwrap_or_else(|| options.gguf_path.clone());

        let out_path = PathBuf::from(options.output_path.trim());
        if options.output_path.trim().is_empty() {
            return Err("请指定输出的 .ninfer 文件路径".into());
        }
        if out_path.exists() {
            return Err(format!("输出文件已存在：{}", out_path.display()));
        }

        let mut cmd = Command::new(&layout.python_exe);
        cmd.current_dir(&layout.root)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .arg("-u")
            .arg(&layout.wrapper_py)
            .arg("--gguf")
            .arg(&source_gguf)
            .arg("--out")
            .arg(&out_path)
            .arg("--device")
            .arg("cpu")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(name) = options.instance_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cmd.arg("--name").arg(name);
        }
        if let Some(aux) = options.aux_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cmd.arg("--aux-dir").arg(aux);
        }
        if options.auto_reconstruct {
            cmd.arg("--auto-reconstruct");
        }
        if options.include_mtp && inspection.has_mtp {
            cmd.arg("--include-mtp");
        }
        if let Some(vision) = options.vision_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if !Path::new(vision).is_file() {
                return Err(format!("视觉模型文件不存在：{vision}"));
            }
            cmd.arg("--vision").arg(vision);
        }
        if let Some(dflash2) = options.dflash2_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if !Path::new(dflash2).exists() {
                return Err(format!("DFlash2 草稿权重不存在：{dflash2}"));
            }
            cmd.arg("--dflash2").arg(dflash2);
        }
        if let Some(tpl) = options.chat_template_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if !Path::new(tpl).is_file() {
                return Err(format!("对话模板文件不存在：{tpl}"));
            }
            cmd.arg("--chat-template").arg(tpl);
        }
        if options.proposal {
            cmd.arg("--proposal");
        }
        if let Some(recipe) = options.recipe.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cmd.arg("--recipe").arg(recipe);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        emit_convert_progress(&app, "prepare", 1, 0, 0, "正在启动转换器...");
        let mut child = cmd.spawn().map_err(|e| format!("启动转换进程失败：{e}"))?;
        let pid = child.id();
        if let Ok(mut guard) = ACTIVE_CONVERT_PID.lock() {
            *guard = Some(pid);
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let app_out = app.clone();
        let out_handle = std::thread::spawn(move || {
            let Some(stream) = stdout else { return };
            let reader = BufReader::new(stream);
            let mut saw_structured_tensor = false;
            for line in reader.lines().map_while(Result::ok) {
                if let Some(json_str) = line.strip_prefix("[COOKLLM_PROGRESS] ") {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                        let phase = val.get("phase").and_then(|v| v.as_str()).unwrap_or("convert");
                        let percent = val.get("percent").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        let current = val.get("current").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        let total = val.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        let msg = val.get("message").and_then(|v| v.as_str()).unwrap_or("");
                        if current > 0 && total > 0 {
                            saw_structured_tensor = true;
                        }
                        emit_convert_progress(&app_out, phase, percent, current, total, msg);
                        continue;
                    }
                }
                if !saw_structured_tensor {
                    if let Some((current, total, pct, msg)) = parse_tensor_progress_line(&line) {
                        emit_convert_progress(&app_out, "convert", pct, current, total, &msg);
                    }
                }
                emit_convert_log(&app_out, "stdout", line);
            }
        });

        let app_err = app.clone();
        let err_lines: std::sync::Arc<Mutex<Vec<String>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
        let err_store = err_lines.clone();
        let err_handle = std::thread::spawn(move || {
            let Some(stream) = stderr else { return };
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut list) = err_store.lock() {
                    if list.len() > 20 {
                        list.remove(0);
                    }
                    list.push(line.clone());
                }
                emit_convert_log(&app_err, "stderr", line);
            }
        });

        let status = child.wait().map_err(|e| format!("等待转换进程失败：{e}"))?;
        let _ = out_handle.join();
        let _ = err_handle.join();

        if CONVERT_CANCEL.load(Ordering::Relaxed) {
            return Err("转换已取消".into());
        }
        if !status.success() {
            let tail = err_lines
                .lock()
                .ok()
                .and_then(|list| {
                    list.iter()
                        .rev()
                        .find_map(|l| l.strip_prefix("[COOKLLM_ERROR] ").map(str::to_string))
                        .or_else(|| list.last().cloned())
                })
                .unwrap_or_else(|| format!("退出码 {:?}", status.code()));
            return Err(format!("转换失败：{tail}"));
        }

        if !out_path.is_file() {
            return Err("转换进程已退出，但未找到生成的 .ninfer 文件".into());
        }

        let mut parts = vec![out_path.to_string_lossy().to_string()];
        let mut total_size = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        if let (Some(parent), Some(fname)) = (out_path.parent(), out_path.file_name().and_then(|n| n.to_str())) {
            let prefix = format!("{fname}.part-");
            let mut extra: Vec<_> = fs::read_dir(parent)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let name = p.file_name()?.to_str()?;
                    if name.starts_with(&prefix) && p.is_file() {
                        Some(p)
                    } else {
                        None
                    }
                })
                .collect();
            extra.sort();
            for p in extra {
                total_size += fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                parts.push(p.to_string_lossy().to_string());
            }
        }

        Ok(NinferConvertResult {
            output_path: out_path.to_string_lossy().to_string(),
            size_bytes: total_size,
            parts,
        })
    })
    .await
    .map_err(|e| format!("转换任务中断：{e}"))?
}

fn parse_tensor_progress_line(line: &str) -> Option<(u32, u32, u32, String)> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('[')?;
    let (counts, after) = rest.split_once(']')?;
    let (cur_str, tot_str) = counts.split_once('/')?;
    let current: u32 = cur_str.trim().parse().ok()?;
    let total: u32 = tot_str.trim().parse().ok()?;
    if current == 0 || total == 0 || current > total {
        return None;
    }
    let label = after.trim().split(':').next().unwrap_or("").trim();
    if label.is_empty() {
        return None;
    }
    let pct = 10u32 + ((((current - 1) as u64 * 87) / total as u64) as u32);
    Some((current, total, pct.min(97), format!("[{current}/{total}] {label}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_gguf(
        path: &Path,
        arch: &str,
        kv_u32: &[(&str, u32)],
        tensors: &[(&str, &[u64], u32)],
    ) {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        buf.extend_from_slice(&3u32.to_le_bytes());
        buf.extend_from_slice(&(tensors.len() as u64).to_le_bytes());
        let total_kv = 2 + kv_u32.len();
        buf.extend_from_slice(&(total_kv as u64).to_le_bytes());

        let push_str = |out: &mut Vec<u8>, s: &str| {
            out.extend_from_slice(&(s.len() as u64).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        };

        push_str(&mut buf, "general.architecture");
        buf.extend_from_slice(&8u32.to_le_bytes());
        push_str(&mut buf, arch);

        push_str(&mut buf, "tokenizer.ggml.tokens");
        buf.extend_from_slice(&9u32.to_le_bytes());
        buf.extend_from_slice(&8u32.to_le_bytes());
        buf.extend_from_slice(&2u64.to_le_bytes());
        push_str(&mut buf, "<|endoftext|>");
        push_str(&mut buf, "<|im_end|>");

        for (k, v) in kv_u32 {
            push_str(&mut buf, k);
            buf.extend_from_slice(&4u32.to_le_bytes());
            buf.extend_from_slice(&v.to_le_bytes());
        }

        for (name, dims_row_major, type_id) in tensors {
            push_str(&mut buf, name);
            buf.extend_from_slice(&(dims_row_major.len() as u32).to_le_bytes());
            for d in dims_row_major.iter().rev() {
                buf.extend_from_slice(&d.to_le_bytes());
            }
            buf.extend_from_slice(&type_id.to_le_bytes());
            buf.extend_from_slice(&0u64.to_le_bytes());
        }

        fs::write(path, buf).unwrap();
    }

    #[test]
    fn exe_install_dir_resolves_parent_of_current_exe() {
        let dir = exe_install_dir().expect("exe install dir");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(dir, exe.parent().unwrap());
        assert_eq!(
            dir.join("ninfer_converter").file_name().unwrap(),
            "ninfer_converter"
        );
    }

    #[test]
    fn install_extracted_bundle_and_custom_dir_resolution_work() {
        let root = std::env::temp_dir().join(format!("cookllm-bundle-test-{}", now_ms()));
        let extracted = root.join("extract");
        let py_dir = extracted.join("python");
        let tools_dir = extracted.join("tools").join("convert");
        fs::create_dir_all(&py_dir).unwrap();
        fs::create_dir_all(&tools_dir).unwrap();
        let py_name = if cfg!(windows) { "python.exe" } else { "python3" };
        fs::write(py_dir.join(py_name), b"stub").unwrap();
        fs::write(extracted.join("cookllm_convert.py"), b"# stub").unwrap();

        let target = root.join("ninfer_converter");
        install_extracted_bundle(&extracted, &target, Some("v1.0.0")).unwrap();
        assert!(target.join("cookllm_convert.py").is_file());
        assert!(target.join("version.txt").is_file());

        // Custom install dir keeps existing ninfer_converter name or nests under non-empty dir
        assert_eq!(resolve_custom_install_dir(&target), target);
        let non_empty_parent = root.join("non_empty");
        fs::create_dir_all(&non_empty_parent).unwrap();
        fs::write(non_empty_parent.join("existing.txt"), b"keep").unwrap();
        assert_eq!(
            resolve_custom_install_dir(&non_empty_parent),
            non_empty_parent.join("ninfer_converter")
        );

        // UTF-8 BOM in bundle-manifest.json and leading 'v' normalization
        fs::write(
            target.join("bundle-manifest.json"),
            "\u{feff}{\"version\":\"v1.0.1\",\"upstreamCommit\":\"5fe3107abcdef\"}",
        )
        .unwrap();
        let st = build_converter_status(&target, "Crvesoft/cookllm-ninfer-converter".into());
        assert!(st.ready);
        assert_eq!(st.local_version.as_deref(), Some("v1.0.1"));
        assert_eq!(normalize_version_str("v1.0.1"), normalize_version_str("1.0.1"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recommend_qwen_aux_repo_detects_38_and_swift() {
        assert_eq!(
            extract_model_repo_from_url("https://huggingface.co/Qwen/Qwen3.8-27B/"),
            Some("Qwen/Qwen3.8-27B".into())
        );
        assert_eq!(
            extract_model_repo_from_url("https://modelscope.cn/models/ukisai/Swift-1.5-Qwen3.8-27b?tab=files"),
            Some("ukisai/Swift-1.5-Qwen3.8-27b".into())
        );
        assert_eq!(extract_model_repo_from_url("https://huggingface.co/ISTA-DASLab"), None);

        let mut hdr_base = ParsedGgufHeader {
            kv_scalars: BTreeMap::new(),
            kv_array_lens: BTreeMap::new(),
            tensors: Vec::new(),
        };
        hdr_base.kv_scalars.insert(
            "general.base_model.0.repo_url".into(),
            GgufScalar::Str("https://huggingface.co/Qwen/Qwen3.8-27B".into()),
        );
        assert_eq!(
            recommend_qwen_aux_repo(&hdr_base, "foo.gguf", 5120, 64).as_deref(),
            Some("Qwen/Qwen3.8-27B")
        );

        let mut hdr_swift = ParsedGgufHeader {
            kv_scalars: BTreeMap::new(),
            kv_array_lens: BTreeMap::new(),
            tensors: Vec::new(),
        };
        hdr_swift.kv_scalars.insert(
            "general.name".into(),
            GgufScalar::Str("Swift-1.5-Qwen3.8-27B-GSQ-RCO".into()),
        );
        assert_eq!(
            recommend_qwen_aux_repo(&hdr_swift, "Swift-1.5-Qwen3.8-27B.gguf", 5120, 64).as_deref(),
            Some("ukisai/Swift-1.5-Qwen3.8-27b")
        );
    }

    #[test]
    fn normalize_github_repo_accepts_slug_and_url() {
        assert_eq!(
            normalize_github_repo("Crvesoft/cookllm-ninfer-converter").unwrap(),
            "Crvesoft/cookllm-ninfer-converter"
        );
        assert_eq!(
            normalize_github_repo("https://github.com/Crvesoft/my-conv.git/").unwrap(),
            "Crvesoft/my-conv"
        );
        assert!(normalize_github_repo("invalid").is_err());
        assert!(normalize_github_repo("a/b/c").is_err());
    }

    #[test]
    fn inspect_gguf_for_ninfer_accepts_valid_qwen35_dense() {
        let p = std::env::temp_dir().join("cookllm-test-qwen35-dense.gguf");
        write_test_gguf(
            &p,
            "qwen35",
            &[
                ("qwen35.embedding_length", 2560),
                ("qwen35.feed_forward_length", 9216),
                ("qwen35.block_count", 33), // 32 text layers + blk.32.nextn MTP layer
                ("qwen35.attention.head_count", 16),
                ("qwen35.attention.head_count_kv", 4),
                ("qwen35.attention.key_length", 256),
                ("qwen35.ssm.group_count", 16),
                ("qwen35.ssm.time_step_rank", 32),
                ("qwen35.ssm.state_size", 128),
                ("qwen35.ssm.conv_kernel", 4),
                ("qwen35.full_attention_interval", 4),
            ],
            &[
                ("token_embd.weight", &[248320, 2560], 12), // Q4_K
                ("blk.32.nextn.eh_proj.weight", &[2560, 5120], 21), // IQ3_S
            ],
        );
        let res = inspect_gguf_for_ninfer_impl(&p.to_string_lossy()).unwrap();
        let _ = fs::remove_file(&p);
        assert!(res.compatible, "unexpected block: {:?}", res.block_reason);
        assert_eq!(res.block_count, 32);
        assert!(res.has_mtp);
        assert!(res.has_tokenizer_kv);
        assert_eq!(res.recommended_hf_repo.as_deref(), Some("Qwen/Qwen3.5-4B"));
    }

    #[test]
    fn inspect_gguf_for_ninfer_rejects_moe_and_unsupported_arch() {
        let p_moe = std::env::temp_dir().join("cookllm-test-qwen35-moe.gguf");
        write_test_gguf(
            &p_moe,
            "qwen35moe",
            &[("qwen35moe.expert_count", 256)],
            &[("token_embd.weight", &[248320, 2048], 12)],
        );
        let res_moe = inspect_gguf_for_ninfer_impl(&p_moe.to_string_lossy()).unwrap();
        let _ = fs::remove_file(&p_moe);
        assert!(!res_moe.compatible);
        assert!(res_moe.block_reason.unwrap_or_default().contains("MoE"));

        let p_llama = std::env::temp_dir().join("cookllm-test-llama.gguf");
        write_test_gguf(&p_llama, "llama", &[], &[("token_embd.weight", &[128256, 4096], 12)]);
        let res_llama = inspect_gguf_for_ninfer_impl(&p_llama.to_string_lossy()).unwrap();
        let _ = fs::remove_file(&p_llama);
        assert!(!res_llama.compatible);
    }

    #[test]
    fn inspect_gguf_for_ninfer_rejects_unsupported_quant_type() {
        let p = std::env::temp_dir().join("cookllm-test-q4_0.gguf");
        write_test_gguf(
            &p,
            "qwen35",
            &[
                ("qwen35.embedding_length", 5120),
                ("qwen35.feed_forward_length", 17408),
                ("qwen35.block_count", 64),
                ("qwen35.attention.head_count", 24),
                ("qwen35.attention.head_count_kv", 4),
                ("qwen35.attention.key_length", 256),
                ("qwen35.ssm.group_count", 16),
                ("qwen35.ssm.time_step_rank", 48),
                ("qwen35.ssm.state_size", 128),
                ("qwen35.ssm.conv_kernel", 4),
                ("qwen35.full_attention_interval", 4),
            ],
            &[("token_embd.weight", &[248320, 5120], 2)], // Q4_0 unsupported
        );
        let res = inspect_gguf_for_ninfer_impl(&p.to_string_lossy()).unwrap();
        let _ = fs::remove_file(&p);
        assert!(!res.compatible);
        assert_eq!(res.unsupported_tensors.len(), 1);
    }

    #[test]
    fn parse_tensor_progress_line_tracks_progress_from_stdout() {
        let p1 = parse_tensor_progress_line("[1/1176] text/token_embd/weight: gguf_q4_k (248320, 5120)")
            .expect("first tensor line should parse");
        assert_eq!(p1.0, 1);
        assert_eq!(p1.1, 1176);
        assert_eq!(p1.2, 10);
        assert_eq!(p1.3, "[1/1176] text/token_embd/weight");

        let p_mid = parse_tensor_progress_line("[589/1176] text/layers/32/attn/q_proj: q3_s");
        assert_eq!(p_mid.expect("mid line").2, 53);

        let p_last = parse_tensor_progress_line("[1175/1176] proposal/head: gguf_q4_k (131072, 5120)")
            .expect("last tensor line should parse");
        assert_eq!(p_last.2, 96);
        assert_eq!(p_last.3, "[1175/1176] proposal/head");

        assert!(parse_tensor_progress_line("[COOKLLM_PROGRESS] {}").is_none());
        assert!(parse_tensor_progress_line("wrote out.ninfer: 100 objects").is_none());
        assert!(parse_tensor_progress_line("[0/10] bad").is_none());
        assert!(parse_tensor_progress_line("[11/10] bad").is_none());
    }
}
