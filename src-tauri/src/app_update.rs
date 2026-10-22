use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::config::read_config;
use crate::process::{kill_managed_child, ProcessState};
use crate::system::{
    build_net_client, direct_client, probe_local_proxy, proxied_client, with_net_fallback, HF_UA,
};
use crate::now_ms;

const APP_GITHUB_REPO: &str = "Crvesoft/CookLLM";


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateInfo {
    status: String,
    latest_tag: String,
    release_url: String,
    release_notes: Option<String>,
    asset_url: Option<String>,
    asset_name: Option<String>,
    asset_size: Option<u64>,
    asset_sha256: Option<String>,
}

fn fetch_github_release(client: &reqwest::blocking::Client, url: &str) -> Result<serde_json::Value, String> {
    let response = client
        .get(url)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", HF_UA)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .map_err(|error| format!("请求 GitHub API 失败：{}", error))?;
    if !response.status().is_success() {
        let code = response.status().as_u16();
        if code == 403 {
            return Err("GitHub API 触发限流（HTTP 403），可尝试切换代理或稍后重试".into());
        }
        return Err(format!("GitHub API 返回 HTTP {}", code));
    }
    response.json().map_err(|error| format!("解析 GitHub API 响应失败：{}", error))
}

/// GitHub API 多通道兜底：配置代理 → 直连 → 本机探测代理端口；错误信息汇总各通道原因。
pub(crate) fn fetch_github_release_with_fallback(config_client: &reqwest::blocking::Client, url: &str) -> Result<serde_json::Value, String> {
    with_net_fallback(config_client, url, false, fetch_github_release)
        .map_err(|errors| format!("GitHub API 连接失败（{}）。请在「设置 → 网络与代理」选择手动代理（Clash 端口 7897 / V2rayN 10809）后重试", errors.join("；")))
}

fn version_number(value: &str) -> Vec<u64> {
    value.trim().trim_start_matches('v').split(|character: char| !character.is_ascii_digit() && character != '.').next().unwrap_or("")
        .split('.').map(|part| part.parse::<u64>().unwrap_or(0)).collect()
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    let candidate = version_number(candidate);
    let current = version_number(current);
    let max_len = candidate.len().max(current.len());
    for index in 0..max_len {
        let left = candidate.get(index).copied().unwrap_or(0);
        let right = current.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppInstallKind {
    Msi,
    Nsis,
}

#[cfg(target_os = "windows")]
fn is_msi_in_registry() -> bool {
    use std::os::windows::process::CommandExt;
    let check1 = std::process::Command::new("reg")
        .args(["query", "HKCU\\Software\\cookllm\\CookLLM", "/v", "Uninstaller Shortcut"])
        .creation_flags(0x08000000)
        .output();
    if let Ok(out) = check1 {
        if out.status.success() && String::from_utf8_lossy(&out.stdout).contains("0x1") {
            return true;
        }
    }
    let check2 = std::process::Command::new("reg")
        .args(["query", "HKCU\\Software\\cookllm\\CookLLM", "/v", "InstallDir"])
        .creation_flags(0x08000000)
        .output();
    if let Ok(out) = check2 {
        if out.status.success() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn detect_app_install_kind() -> AppInstallKind {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            // 1. NSIS 安装器在安装目录下必然生成实体的卸载程序 uninstall.exe
            if parent.join("uninstall.exe").is_file() {
                return AppInstallKind::Nsis;
            }
            // 2. WiX MSI 安装器在安装目录下生成卸载快捷方式 Uninstall CookLLM.lnk
            if parent.join("Uninstall CookLLM.lnk").is_file() {
                return AppInstallKind::Msi;
            }
        }
    }

    // 3. 注册表检测：WiX MSI 会在 HKCU\Software\cookllm\CookLLM 写入专属的 InstallDir 或快捷方式键值
    if is_msi_in_registry() {
        return AppInstallKind::Msi;
    }

    // 默认回退为 NSIS EXE 安装包
    AppInstallKind::Nsis
}

#[cfg(not(target_os = "windows"))]
fn detect_app_install_kind() -> AppInstallKind {
    AppInstallKind::Nsis
}

fn app_installer_from_value(value: &serde_json::Value) -> Option<(String, String, u64, Option<String>)> {
    let assets = value.get("assets")?.as_array()?;
    let install_kind = detect_app_install_kind();

    assets.iter().filter_map(|item| {
        let name = item.get("name")?.as_str()?.to_string();
        let lower = name.to_lowercase();
        if lower.contains("arm64") || lower.contains("aarch64") { return None; }

        let rank = match install_kind {
            AppInstallKind::Msi => {
                if lower.ends_with(".msi") {
                    0 // MSI 用户优先匹配下载 MSI，原地覆盖升级
                } else if lower.ends_with(".exe") && (lower.contains("setup") || lower.contains("nsis")) {
                    1 // 兜底使用 EXE
                } else {
                    return None;
                }
            }
            AppInstallKind::Nsis => {
                if lower.ends_with(".exe") && (lower.contains("setup") || lower.contains("nsis")) {
                    0 // EXE 用户优先匹配下载 EXE Setup，原地覆盖升级
                } else if lower.ends_with(".msi") {
                    1 // 兜底使用 MSI
                } else {
                    return None;
                }
            }
        };

        let url = item.get("browser_download_url")?.as_str()?.to_string();
        if url.is_empty() { return None; }
        let size = item.get("size").and_then(serde_json::Value::as_u64).unwrap_or(0);
        let digest = item.get("digest").and_then(serde_json::Value::as_str).and_then(|text| text.strip_prefix("sha256:")).map(str::to_string);
        Some((rank, (url, name, size, digest)))
    }).min_by_key(|(rank, _)| *rank).map(|(_, item)| item)
}

pub(crate) fn check_app_update_impl(app: &AppHandle) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let config = read_config(app)?;
    let client = build_net_client(&config.network.clone().unwrap_or_default())?;
    let url = format!("https://api.github.com/repos/{APP_GITHUB_REPO}/releases/latest");
    let release = fetch_github_release_with_fallback(&client, &url)?;
    let latest_tag = release.get("tag_name").and_then(serde_json::Value::as_str).unwrap_or("").trim().to_string();
    if latest_tag.is_empty() { return Err("bad-response".into()); }
    let installer = if cfg!(target_os = "windows") { app_installer_from_value(&release) } else { None };
    let (asset_url, asset_name, asset_size, asset_sha256) = installer
        .map(|(url, name, size, digest)| (Some(url), Some(name), Some(size), digest))
        .unwrap_or((None, None, None, None));
    Ok(AppUpdateInfo {
        status: if is_newer_version(&latest_tag, &current_version) { "available".into() } else { "latest".into() },
        latest_tag,
        release_url: release.get("html_url").and_then(serde_json::Value::as_str).unwrap_or("https://github.com/Crvesoft/CookLLM/releases").to_string(),
        release_notes: release.get("body").and_then(serde_json::Value::as_str).map(str::to_string).filter(|text| !text.trim().is_empty()),
        asset_url, asset_name, asset_size, asset_sha256,
    })
}

#[tauri::command]
pub(crate) async fn check_app_update(app: AppHandle) -> Result<AppUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check_app_update_impl(&app)).await.map_err(|error| format!("应用更新检查任务中断：{}", error))?
}

fn installer_digest(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(|error| format!("读取安装包失败：{}", error))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| format!("计算安装包校验失败：{}", error))?;
    Ok(hasher.finalize().iter().map(|byte| format!("{:02x}", byte)).collect())
}

fn verify_app_installer(path: &Path, expected_size: Option<u64>, expected_digest: Option<&str>) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("安装包校验失败：{}", error))?;
    if metadata.len() == 0 { return Err("安装包为空".into()); }
    if let Some(size) = expected_size.filter(|size| *size > 0) {
        if metadata.len() != size { return Err(format!("安装包大小校验失败：期望 {} 字节，实际 {} 字节", size, metadata.len())); }
    }
    if let Some(expected) = expected_digest.filter(|digest| !digest.trim().is_empty()) {
        if !installer_digest(path)?.eq_ignore_ascii_case(expected.trim()) { return Err("安装包 SHA-256 校验失败".into()); }
    }
    Ok(())
}

pub(crate) fn download_app_update_impl(app: AppHandle, url: String, file_name: String, expected_size: Option<u64>, expected_sha256: Option<String>) -> Result<String, String> {
    let normalized = url.trim().to_string();
    let parsed = reqwest::Url::parse(&normalized).map_err(|_| "安装包下载地址无效".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") || !parsed.path().contains("/releases/download/") {
        return Err("安装包下载地址不受信任".into());
    }
    let safe_name = file_name.trim();
    let safe_self = Path::new(safe_name).file_name().and_then(|value| value.to_str()).unwrap_or("");
    if safe_name != safe_self || !(safe_name.to_lowercase().ends_with(".exe") || safe_name.to_lowercase().ends_with(".msi")) {
        return Err("安装包文件名无效".into());
    }
    let directory = std::env::temp_dir().join("CookLLM");
    fs::create_dir_all(&directory).map_err(|error| format!("创建更新临时目录失败：{}", error))?;
    let destination = directory.join(safe_name);
    if destination.exists() && verify_app_installer(&destination, expected_size, expected_sha256.as_deref()).is_ok() {
        emit_download_progress(&app, "done", 100, expected_size.unwrap_or(0), expected_size.unwrap_or(0), 0, "安装包已就绪");
        return Ok(destination.to_string_lossy().to_string());
    }
    let temporary = destination.with_extension(format!("part.{}", now_ms()));
    // 应用自更新链路：持有 RAII 守卫，任何退出路径自动复位自己的取消标志
    let cancel = CancelFlag(&APP_UPDATE_CANCEL);
    let _guard = CancelGuard(cancel);
    let client = build_net_client(&read_config(&app)?.network.clone().unwrap_or_default())?;
    let download_result = stream_download_with_fallback(cancel, &client, &normalized, &temporary, &app);
    if let Err(error) = download_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    verify_app_installer(&temporary, expected_size, expected_sha256.as_deref())?;
    if destination.exists() {
        fs::remove_file(&destination).map_err(|error| format!("替换旧安装包失败：{}", error))?;
    }
    fs::rename(&temporary, &destination).map_err(|error| format!("保存安装包失败：{}", error))?;
    emit_download_progress(&app, "done", 100, expected_size.unwrap_or(0), expected_size.unwrap_or(0), 0, "安装包已就绪");
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn download_app_update(app: AppHandle, url: String, file_name: String, size: Option<u64>, sha256: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || download_app_update_impl(app, url, file_name, size, sha256))
        .await.map_err(|error| format!("应用更新下载任务中断：{}", error))?
}

#[tauri::command]
pub(crate) fn cancel_app_update() -> Result<(), String> {
    CancelFlag(&APP_UPDATE_CANCEL).cancel();
    Ok(())
}

#[tauri::command]
pub(crate) fn install_app_update(app: AppHandle, path: String) -> Result<(), String> {
    let installer = PathBuf::from(&path);
    let allowed_parent = std::env::temp_dir().join("CookLLM");
    if !installer.starts_with(&allowed_parent) || !installer.is_file() || !(path.to_lowercase().ends_with(".exe") || path.to_lowercase().ends_with(".msi")) {
        return Err("安装包无效".into());
    }
    if fs::metadata(&installer).map(|metadata| metadata.len()).unwrap_or(0) == 0 { return Err("安装包为空".into()); }
    // 升级退出前确保杀死当前运行中的 llama-server，防止更新后残留进程占用显存
    let state = app.state::<ProcessState>();
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut managed) = guard.take() {
            kill_managed_child(&mut managed);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if path.to_lowercase().ends_with(".msi") {
            Command::new("msiexec").arg("/i").arg(&installer).creation_flags(0x00000208).spawn().map_err(|error| format!("启动安装程序失败：{}", error))?;
        } else {
            Command::new(&installer).creation_flags(0x00000208).spawn().map_err(|error| format!("启动安装程序失败：{}", error))?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = Command::new(&installer).spawn();
    std::thread::sleep(std::time::Duration::from_millis(400));
    app.cleanup_before_exit();
    app.exit(0);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    phase: String,
    percent: u32,
    downloaded: u64,
    total: u64,
    speed_bps: u64,
    message: String,
}

pub(crate) fn emit_download_progress(app: &AppHandle, phase: &str, percent: u32, downloaded: u64, total: u64, speed_bps: u64, message: impl Into<String>) {
    let _ = app.emit("download-progress", DownloadProgress {
        phase: phase.into(),
        percent: percent.min(100),
        downloaded,
        total,
        speed_bps,
        message: message.into(),
    });
}

/// 流式下载并实时发送进度事件（download-progress），返回最终字节数。
fn stream_download(cancel: CancelFlag, client: &reqwest::blocking::Client, url: &str, dest: &Path, app: &AppHandle) -> Result<u64, String> {
    use std::io::Read as _;
    use std::io::Write as _;
    emit_download_progress(app, "download", 0, 0, 0, 0, "开始下载");
    let mut response = client.get(url).timeout(std::time::Duration::from_secs(3600)).send().map_err(|error| format!("下载失败：{}", error))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(dest).map_err(|error| format!("创建下载文件失败：{}", error))?;
    let mut downloaded: u64 = 0;
    let mut buffer = [0u8; 128 * 1024];
    let start_ms = now_ms();
    let mut last_emit_ms = start_ms;
    let mut last_speed_ms = start_ms;
    let mut last_speed_bytes = downloaded;
    let mut current_speed: u64 = 0;
    loop {
        if cancel.cancelled() {
            let _ = fs::remove_file(dest);
            return Err("更新已取消".into());
        }
        let count = response.read(&mut buffer).map_err(|error| format!("下载中断：{}", error))?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count]).map_err(|error| format!("写入下载文件失败：{}", error))?;
        downloaded += count as u64;
        let now = now_ms();
        let speed_dt = now.saturating_sub(last_speed_ms);
        if speed_dt >= 500 {
            let bytes_delta = downloaded.saturating_sub(last_speed_bytes);
            let instant = bytes_delta * 1000 / speed_dt;
            current_speed = if current_speed == 0 { instant } else { (current_speed * 3 + instant * 7) / 10 };
            last_speed_ms = now;
            last_speed_bytes = downloaded;
        }
        if now.saturating_sub(last_emit_ms) >= 200 {
            let percent = if total > 0 { ((downloaded as f64 / total as f64) * 100.0) as u32 } else { 0 };
            let downloaded_mb = (downloaded as f64) / (1024.0 * 1024.0);
            let total_mb = (total as f64) / (1024.0 * 1024.0);
            let size_msg = if total > 0 {
                format!("{:.1} MB / {:.1} MB", downloaded_mb, total_mb)
            } else {
                format!("{:.1} MB", downloaded_mb)
            };
            emit_download_progress(app, "download", percent, downloaded, total, current_speed, size_msg);
            last_emit_ms = now;
        }
    }
    file.flush().map_err(|error| error.to_string())?;
    emit_download_progress(app, "download", 100, downloaded, total, 0, "下载完成");
    Ok(downloaded)
}

/// 流式下载多通道兜底：配置代理 → 直连 → 本机探测代理端口；失败时汇总各通道原因。
pub(crate) fn stream_download_with_fallback(cancel: CancelFlag, client: &reqwest::blocking::Client, url: &str, dest: &Path, app: &AppHandle) -> Result<u64, String> {
    let mut errors: Vec<String> = Vec::new();
    match stream_download(cancel, client, url, dest, app) {
        Ok(size) => return Ok(size),
        Err(error) => errors.push(format!("配置代理通道：{}", error)),
    }
    emit_download_progress(app, "download", 0, 0, 0, 0, "代理通道失败，切换直连重试");
    match stream_download(cancel, direct_client(), url, dest, app) {
        Ok(size) => return Ok(size),
        Err(error) => errors.push(format!("直连：{}", error)),
    }
    if let Some(proxy_url) = probe_local_proxy() {
        match proxied_client(&proxy_url) {
            Ok(proxied) => {
                emit_download_progress(app, "download", 0, 0, 0, 0, format!("切换本地代理 {} 重试", proxy_url));
                match stream_download(cancel, &proxied, url, dest, app) {
                    Ok(size) => return Ok(size),
                    Err(error) => errors.push(format!("本地代理 {}：{}", proxy_url, error)),
                }
            }
            Err(error) => errors.push(format!("初始化本地代理 {} 失败：{}", proxy_url, error)),
        }
    }
    Err(format!("下载失败（{}）", errors.join("；")))
}

/// 更新任务取消标志（按链路独立）：「应用自更新」与「llama.cpp 引擎更新」各持一个，
/// 取消任何一边都不会误杀另一边正在进行下载 / 解压。
static APP_UPDATE_CANCEL: AtomicBool = AtomicBool::new(false);

/// 指向某条链路取消标志的句柄，随调用参数传递给下载 / 解压循环。
#[derive(Clone, Copy)]
pub(crate) struct CancelFlag(pub(crate) &'static AtomicBool);
impl CancelFlag {
    pub(crate) fn cancelled(self) -> bool { self.0.load(Ordering::Relaxed) }
    pub(crate) fn cancel(self) { self.0.store(true, Ordering::Relaxed) }
    pub(crate) fn reset(self) { self.0.store(false, Ordering::Relaxed) }
}

/// RAII：任务函数持有后无论成功 / 失败 / 提前返回，离开作用域都自动复位标志，
/// 取代失败分支里成串的手动 `store(false)`。
pub(crate) struct CancelGuard(pub(crate) CancelFlag);
impl Drop for CancelGuard {
    fn drop(&mut self) { self.0.reset(); }
}

