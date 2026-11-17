//! 运行时获取 NInfer / KVMem 会话页所需的 llama.cpp 官方 WebUI。
//!
//! 标准 llama.cpp 发行版把 UI 编译进 `llama-server.exe`，磁盘上没有可直接复制的文件，
//! 因此按以下顺序解析：
//! 1. 本地源码构建产物或手动解压的 UI 目录；
//! 2. 识别本机 llama.cpp 的 build 号，下载对应官方 UI 包；
//! 3. 回退到固定且已验证的 b11165。
//!
//! UI 包按 GitHub release 资产声明的 SHA-256 校验，解压到应用数据目录缓存；
//! 下载与解压在后台线程完成，代理先展示等待页，避免阻塞启动命令。

use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{read_config, AppConfig};
use crate::system::{build_net_client, direct_client, probe_local_proxy, proxied_client, with_net_fallback};
use crate::webui_proxy::UiState;

const LLAMA_REPO: &str = "ggml-org/llama.cpp";
const PINNED_BUILD: &str = "b11165";
const PINNED_SIZE: u64 = 3_085_200;
const PINNED_SHA256: &str = "1cfd2d7335dfd1a5a07d00154424a92df3a18088c4ce72c9200f8f9b54cf46f3";
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 128 * 1024 * 1024;
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
/// 明确离线时不再做无意义的 4 秒重试，让提示尽早出现
const OFFLINE_ERROR_PREFIX: &str = "当前网络不可用";

const LOCAL_UI_DIRS: &[&str] = &[
    "",
    "ui",
    "webui",
    "public",
    "ui/dist",
    "webui/dist",
    "tools/server/public",
    "tools/server/webui/dist",
    "tools/server/webui/build",
    "tools/server/webui/build/client",
];

static PREPARE_LOCK: Mutex<()> = Mutex::new(());

/// 前端横幅状态：pending / retrying / ready / failed，失败时附带可读原因。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebuiStatePayload {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_state(app: &AppHandle, phase: &'static str, error: Option<String>) {
    let _ = app.emit("webui-state", WebuiStatePayload { phase, error });
}

/// 后台准备 WebUI：代理先启动并展示等待页，下载/解压完成后自动切换为官方 UI。
pub(crate) fn prepare_webui(app: AppHandle, state: std::sync::Arc<UiState>) {
    if !state.begin() {
        return;
    }
    emit_state(&app, "pending", None);

    let worker_app = app.clone();
    let thread_state = state.clone();
    let spawn = thread::Builder::new()
        .name("cookllm-webui-assets".into())
        .spawn(move || {
            for attempt in 1..=2 {
                match resolve_webui_root(&worker_app) {
                    Ok(root) => {
                        crate::process::emit_log(
                            &worker_app,
                            "system",
                            format!("WebUI 就绪：{}", root.display()),
                        );
                        thread_state.set_ready(root);
                        emit_state(&worker_app, "ready", None);
                        break;
                    }
                    Err(error) => {
                        let offline = error.starts_with(OFFLINE_ERROR_PREFIX);
                        if attempt < 2 && !offline {
                            crate::process::emit_log(
                                &worker_app,
                                "stderr",
                                format!("WebUI 准备失败，4 秒后重试：{error}"),
                            );
                            thread_state.set_retrying(format!("{error}（4 秒后重试）"));
                            emit_state(&worker_app, "retrying", Some(error));
                            thread::sleep(Duration::from_secs(4));
                        } else {
                            crate::process::emit_log(
                                &worker_app,
                                "stderr",
                                format!("WebUI 准备失败：{error}"),
                            );
                            thread_state.set_error(error.clone());
                            emit_state(&worker_app, "failed", Some(error));
                        }
                    }
                }
            }
            thread_state.finish();
        });
    if let Err(error) = spawn {
        let message = format!("启动 WebUI 下载线程失败：{error}");
        state.set_error(message.clone());
        emit_state(&app, "failed", Some(message));
        state.finish();
    }
}

fn resolve_webui_root(app: &AppHandle) -> Result<PathBuf, String> {
    let _guard = PREPARE_LOCK.lock().map_err(|_| "WebUI 准备锁已损坏")?;
    let config = read_config(app)?;
    if let Some(root) = find_local_ui(&config) {
        return Ok(root);
    }

    let cache = cache_root(app)?;
    let local_build = detect_local_build(&config);
    let mut builds: Vec<&str> = Vec::new();
    if let Some(build) = local_build.as_deref() {
        builds.push(build);
    }
    if !builds.contains(&PINNED_BUILD) {
        builds.push(PINNED_BUILD);
    }

    // 已缓存的本地构建直接使用；没有本地 llama.cpp 时固定版缓存也足以离线工作
    if let Some(root) = local_build
        .as_deref()
        .map(|build| cache.join(build))
        .filter(|path| is_ui_root(path))
    {
        return Ok(root);
    }
    let pinned = cache.join(PINNED_BUILD);
    let pinned_cached = is_ui_root(&pinned);
    if local_build.is_none() && pinned_cached {
        return Ok(pinned);
    }

    // 没有可用缓存时先做一次短超时探测：离线环境立即失败，
    // 避免 GitHub API / 多通道路由逐个等超时，让会话页快速给出可操作提示。
    if !network_reachable(&config) {
        if pinned_cached {
            return Ok(pinned);
        }
        return Err(format!(
            "{OFFLINE_ERROR_PREFIX}，无法下载 WebUI 资源（API 接口不受影响，联网后可在会话页点击「重新准备」）"
        ));
    }

    let mut errors = Vec::new();
    for build in builds {
        match ensure_build(app, &cache, build) {
            Ok(root) => return Ok(root),
            Err(error) => errors.push(format!("{build}: {error}")),
        }
    }
    Err(format!("无法获取 llama.cpp WebUI（{}）", errors.join("；")))
}

/// 引擎更新成功后预热 NInfer/KVMem 的会话界面资源。
/// 仅在配置中存在 NInfer/KVMem 引擎时执行；完全后台、失败只记日志，不影响引擎更新结果。
pub(crate) fn prefetch_webui(app: AppHandle, build_hint: Option<String>, server_path: PathBuf) {
    let worker_app = app.clone();
    let spawn = thread::Builder::new()
        .name("cookllm-webui-prefetch".into())
        .spawn(move || {
            let Ok(config) = read_config(&worker_app) else { return; };
            let has_ninfer = config
                .engines
                .iter()
                .any(|engine| engine_is_ninfer(&engine.path, engine.engine_type.as_deref()))
                || engine_is_ninfer(&config.server_path, None);
            if !has_ninfer {
                return;
            }

            let build = build_hint
                .as_deref()
                .and_then(normalize_build)
                .or_else(|| read_build_number(&server_path).map(|build| format!("b{build}")));
            let Some(build) = build else {
                crate::process::emit_log(&worker_app, "stderr", "无法识别新引擎 build，跳过 WebUI 预热");
                return;
            };
            let Ok(cache) = cache_root(&worker_app) else { return; };
            if is_ui_root(&cache.join(&build)) {
                crate::process::emit_log(&worker_app, "system", format!("会话界面资源已包含 {build}"));
                return;
            }
            if !network_reachable(&config) {
                crate::process::emit_log(
                    &worker_app,
                    "stderr",
                    format!("网络不可用，暂不预下载 WebUI {build}（下次启动会话页时会重试）"),
                );
                return;
            }

            let Ok(_guard) = PREPARE_LOCK.lock() else { return; };
            crate::process::emit_log(
                &worker_app,
                "system",
                format!("检测到 NInfer/KVMem 引擎，正在后台同步 WebUI {build}"),
            );
            match ensure_build(&worker_app, &cache, &build) {
                Ok(root) => crate::process::emit_log(
                    &worker_app,
                    "system",
                    format!("会话界面资源已同步：{build} · {}", root.display()),
                ),
                Err(error) => crate::process::emit_log(
                    &worker_app,
                    "stderr",
                    format!("会话界面资源同步失败（不影响引擎更新）：{error}"),
                ),
            }
        });
    if let Err(error) = spawn {
        crate::process::emit_log(&app, "stderr", format!("启动 WebUI 预热线程失败：{error}"));
    }
}

fn engine_is_ninfer(path: &str, engine_type: Option<&str>) -> bool {
    engine_type.map_or(false, |kind| kind.to_ascii_lowercase().contains("ninfer"))
        || Path::new(path.trim())
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase().contains("ninfer"))
            .unwrap_or(false)
}

fn normalize_build(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let digits = trimmed
        .strip_prefix('b')
        .or_else(|| trimmed.strip_prefix('B'))
        .unwrap_or(trimmed)
        .trim();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("b{digits}"))
}

/// 下载前的快速连通性探测：任一通道 3 秒内能完成 HTTPS 请求即视为可联网。
/// 与下载链路保持同样的配置代理 → 直连 → 本机代理顺序，但总耗时远小于正式请求的超时。
fn network_reachable(config: &AppConfig) -> bool {
    let network = config.network.clone().unwrap_or_default();
    let client = build_net_client(&network).unwrap_or_else(|_| direct_client().clone());
    if probe_github(&client) {
        return true;
    }
    if probe_github(direct_client()) {
        return true;
    }
    if let Some(proxy_url) = probe_local_proxy() {
        if let Ok(proxied) = proxied_client(&proxy_url) {
            return probe_github(&proxied);
        }
    }
    false
}

fn probe_github(client: &reqwest::blocking::Client) -> bool {
    client
        .head("https://github.com")
        .timeout(Duration::from_secs(3))
        .send()
        .is_ok()
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("webui");
    fs::create_dir_all(&root).map_err(|error| format!("创建 WebUI 缓存目录失败：{error}"))?;
    Ok(root)
}

fn find_local_ui(config: &AppConfig) -> Option<PathBuf> {
    for engine in &config.engines {
        let path = Path::new(engine.path.trim());
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()) else {
            continue;
        };
        // NInfer/KVMem 包内的 UI 可能使用其私有 /api/chat 协议，不能拿来托管给 llama.cpp 兼容接口
        if name.contains("ninfer") {
            continue;
        }
        let Some(mut dir) = path.parent() else {
            continue;
        };
        for _ in 0..4 {
            for relative in LOCAL_UI_DIRS {
                let candidate = if relative.is_empty() {
                    dir.to_path_buf()
                } else {
                    dir.join(relative)
                };
                if is_ui_root(&candidate) {
                    return Some(candidate);
                }
            }
            let Some(parent) = dir.parent() else {
                break;
            };
            dir = parent;
        }
    }
    None
}

fn detect_local_build(config: &AppConfig) -> Option<String> {
    for engine in &config.engines {
        let path = Path::new(engine.path.trim());
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()) else {
            continue;
        };
        if name.contains("ninfer") || !name.starts_with("llama") {
            continue;
        }
        if let Some(build) = read_build_number(path) {
            return Some(format!("b{build}"));
        }
    }
    None
}

fn read_build_number(path: &Path) -> Option<u32> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = path.parent() {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_build_number(&text)
}

fn parse_build_number(text: &str) -> Option<u32> {
    let lower = text.to_ascii_lowercase();
    for marker in ["(build ", "build ", "build:"] {
        let Some(index) = lower.find(marker) else {
            continue;
        };
        let digits: String = lower[index + marker.len()..]
            .chars()
            .skip_while(|character| character.is_whitespace() || *character == 'b')
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(value) = digits.parse() {
            return Some(value);
        }
    }
    None
}

fn ensure_build(app: &AppHandle, cache: &Path, build: &str) -> Result<PathBuf, String> {
    if !is_valid_build(build) {
        return Err(format!("非法的 WebUI 版本号：{build}"));
    }
    let target = cache.join(build);
    if is_ui_root(&target) {
        return Ok(target);
    }
    if target.exists() {
        remove_path(&target)?;
    }

    let (expected_size, expected_sha256) = if build == PINNED_BUILD {
        (PINNED_SIZE, PINNED_SHA256.to_string())
    } else {
        fetch_asset_metadata(app, build)?
    };
    let url = format!(
        "https://github.com/{LLAMA_REPO}/releases/download/{build}/llama-{build}-ui.tar.gz"
    );
    let archive = cache.join(format!(".{build}-ui.tar.gz.part"));
    crate::process::emit_log(
        app,
        "system",
        format!(
            "正在下载 llama.cpp WebUI {build}（{:.1} MB）",
            expected_size as f64 / 1024.0 / 1024.0
        ),
    );
    if let Err(error) = download_archive(app, &archive, &url, expected_size, &expected_sha256) {
        let _ = fs::remove_file(&archive);
        return Err(error);
    }
    crate::process::emit_log(app, "system", format!("正在解压 WebUI {build}"));
    let result = extract_archive(&archive, &target);
    let _ = fs::remove_file(&archive);
    result?;
    if !is_ui_root(&target) {
        return Err("解压后未找到 index.html，WebUI 包不完整".into());
    }
    Ok(target)
}

fn is_valid_build(build: &str) -> bool {
    build
        .strip_prefix('b')
        .map_or(false, |digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

fn fetch_asset_metadata(app: &AppHandle, build: &str) -> Result<(u64, String), String> {
    let config = read_config(app)?;
    let network = config.network.clone().unwrap_or_default();
    let client = build_net_client(&network).unwrap_or_else(|_| direct_client().clone());
    let url = format!("https://api.github.com/repos/{LLAMA_REPO}/releases/tags/{build}");
    let json = with_net_fallback(&client, &url, false, |client, url| {
        let response = client
            .get(url)
            .header("accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(30))
            .send()
            .map_err(|error| format!("请求 GitHub API 失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!("GitHub API 返回 HTTP {}", response.status().as_u16()));
        }
        response
            .json::<serde_json::Value>()
            .map_err(|error| format!("解析 GitHub API 响应失败：{error}"))
    })
    .map_err(|errors| errors.join("；"))?;

    let name = format!("llama-{build}-ui.tar.gz");
    let asset = json
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|asset| asset.get("name").and_then(serde_json::Value::as_str) == Some(name.as_str()))
        })
        .ok_or_else(|| format!("GitHub release 中未找到 {name}"))?;
    let size = asset.get("size").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let digest = asset
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| digest.len() == 64)
        .ok_or_else(|| "GitHub release 未提供 UI 包 SHA-256".to_string())?;
    Ok((size, digest.to_string()))
}

fn download_archive(
    app: &AppHandle,
    destination: &Path,
    url: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let config = read_config(app)?;
    let network = config.network.clone().unwrap_or_default();
    let client = build_net_client(&network).unwrap_or_else(|_| direct_client().clone());
    let _ = fs::remove_file(destination);
    let result = with_net_fallback(&client, url, false, |client, url| {
        download_once(client, url, destination, expected_size, expected_sha256)
    });
    match result {
        Ok(()) => Ok(()),
        Err(errors) => {
            let _ = fs::remove_file(destination);
            Err(format!("下载 WebUI 失败（{}）", errors.join("；")))
        }
    }
}

fn download_once(
    client: &reqwest::blocking::Client,
    url: &str,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let _ = fs::remove_file(destination);
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(300))
        .send()
        .map_err(|error| format!("连接下载地址失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载地址返回 HTTP {}", response.status().as_u16()));
    }
    if response.content_length().map_or(false, |size| size > MAX_ARCHIVE_BYTES) {
        return Err("UI 包体积异常，已取消下载".into());
    }

    let mut file = File::create(destination).map_err(|error| format!("创建临时文件失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = response.read(&mut buffer).map_err(|error| format!("读取下载数据失败：{error}"))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_ARCHIVE_BYTES {
            return Err("UI 包体积异常，已取消下载".into());
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入临时文件失败：{error}"))?;
    }
    file.flush().map_err(|error| format!("刷新临时文件失败：{error}"))?;
    drop(file);

    if expected_size > 0 && total != expected_size {
        return Err(format!("UI 包大小不符：期望 {expected_size}，实际 {total}"));
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!("UI 包 SHA-256 校验失败：期望 {expected_sha256}，实际 {actual}"));
    }
    Ok(())
}

fn extract_archive(archive: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| "WebUI 缓存路径无效".to_string())?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        target.file_name().and_then(|name| name.to_str()).unwrap_or("webui"),
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&temp);
    fs::create_dir_all(&temp).map_err(|error| format!("创建解压目录失败：{error}"))?;

    let result = (|| -> Result<(), String> {
        let file = File::open(archive).map_err(|error| format!("打开 UI 包失败：{error}"))?;
        let decoder = GzDecoder::new(file);
        let mut tar = tar::Archive::new(decoder);
        let mut unpacked = 0u64;
        let entries = tar.entries().map_err(|error| format!("读取 UI 包失败：{error}"))?;
        for entry in entries {
            let mut entry = entry.map_err(|error| format!("读取 UI 包条目失败：{error}"))?;
            let path = entry.path().map_err(|error| format!("读取 UI 包路径失败：{error}"))?.into_owned();
            if path.as_os_str().is_empty()
                || path.components().any(|component| {
                    matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
                })
            {
                continue;
            }
            let kind = entry.header().entry_type();
            if !kind.is_file() || kind.is_symlink() || kind.is_hard_link() {
                continue;
            }
            unpacked = unpacked.saturating_add(entry.size());
            if unpacked > MAX_UNPACKED_BYTES {
                return Err("UI 包解压后体积异常，已取消".into());
            }
            let output = temp.join(&path);
            if let Some(output_parent) = output.parent() {
                fs::create_dir_all(output_parent)
                    .map_err(|error| format!("创建解压子目录失败：{error}"))?;
            }
            entry
                .unpack(&output)
                .map_err(|error| format!("解压 UI 文件失败：{error}"))?;
        }

        let root = locate_ui_root(&temp).ok_or_else(|| "UI 包中未找到 index.html".to_string())?;
        if target.exists() {
            remove_path(target)?;
        }
        fs::rename(&root, target).map_err(|error| format!("移动 WebUI 到缓存目录失败：{error}"))?;
        if root != temp {
            let _ = fs::remove_dir_all(&temp);
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}

fn locate_ui_root(dir: &Path) -> Option<PathBuf> {
    if is_ui_root(dir) {
        return Some(dir.to_path_buf());
    }
    let mut queue = VecDeque::from([(dir.to_path_buf(), 0usize)]);
    while let Some((current, depth)) = queue.pop_front() {
        if depth >= 3 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if is_ui_root(&path) {
                return Some(path);
            }
            queue.push_back((path, depth + 1));
        }
    }
    None
}

fn is_ui_root(path: &Path) -> bool {
    path.join("index.html").is_file()
        && (path.join("_app").is_dir() || path.join("assets").is_dir())
}

fn remove_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("删除旧 WebUI 缓存失败：{error}"))
    } else {
        fs::remove_file(path).map_err(|error| format!("删除旧 WebUI 缓存失败：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Cursor;

    fn append_file(builder: &mut tar::Builder<GzEncoder<File>>, path: &str, data: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, Cursor::new(data)).unwrap();
    }

    #[test]
    fn parses_build_numbers() {
        assert_eq!(parse_build_number("version: 1.0.0-dev (build 12413, commit dd099a6bf)"), Some(12413));
        assert_eq!(parse_build_number("build: b11165"), Some(11165));
        assert_eq!(parse_build_number("version: 1.0.0-dev"), None);
    }

    #[test]
    fn normalizes_build_hints() {
        assert_eq!(normalize_build("b12449").as_deref(), Some("b12449"));
        assert_eq!(normalize_build(" 12449 ").as_deref(), Some("b12449"));
        assert_eq!(normalize_build("B12449").as_deref(), Some("b12449"));
        assert_eq!(normalize_build("b12449-cuda"), None);
        assert_eq!(normalize_build(""), None);
    }

    #[test]
    fn detects_ninfer_engines() {
        assert!(engine_is_ninfer(r"E:\AI\ninfer-run\ninfer-server.exe", None));
        assert!(engine_is_ninfer(r"E:\AI\kvmem\server.exe", Some("ninfer_kvmem")));
        assert!(!engine_is_ninfer(r"E:\AI\llama\llama-server.exe", Some("llamacpp")));
    }

    #[test]
    fn extracts_ui_archive_and_strips_top_level_dir() {
        let dir = std::env::temp_dir().join(format!("cookllm-webui-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("ui.tar.gz");
        let file = File::create(&archive).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(encoder);
        append_file(&mut builder, "llama-b11165/index.html", b"<!doctype html><title>ui</title>");
        append_file(&mut builder, "llama-b11165/_app/immutable/bundle.js", b"console.log(1)");
        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();

        let target = dir.join("cache/b11165");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        extract_archive(&archive, &target).unwrap();
        assert!(target.join("index.html").is_file());
        assert!(target.join("_app/immutable/bundle.js").is_file());

        let _ = fs::remove_dir_all(&dir);
    }

}
