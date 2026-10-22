use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};

use tauri::AppHandle;

use crate::config::{read_config, NetworkConfig};
use crate::now_ms;

/// GPU 实时指标（nvidia-smi）：显存 MiB / 核心负载 % / 功耗 W；驱动不支持的字段为 None。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuStats {
    memory_used_mb: Option<f64>,
    memory_total_mb: Option<f64>,
    util_percent: Option<f64>,
    power_watts: Option<f64>,
}

/// nvidia-smi 路径缓存（None = 本会话未找到，避免每轮重复拉起 cmd 搜索 PATH）。
static SMI_PATH_CACHE: Mutex<Option<PathBuf>> = Mutex::new(None);
/// 防止 GPU 查询堆积：上一轮还没返回时直接跳过本轮。
static GPU_QUERY_BUSY: AtomicBool = AtomicBool::new(false);

fn find_nvidia_smi() -> Option<PathBuf> {
    let mut cache = SMI_PATH_CACHE.lock().ok()?;
    if let Some(path) = cache.as_ref() {
        return Some(path.clone());
    }
    // 1) NVIDIA 驱动把 nvidia-smi 随 System32 安装，优先直取（零额外进程）
    let found = std::env::var("SystemRoot")
        .ok()
        .map(|root| PathBuf::from(root).join(r"system32\nvidia-smi.exe"))
        .filter(|path| path.exists())
        // 2) 兜底：PATH 搜索（Windows `where`）
        .or_else(|| {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "where", "nvidia-smi"]);
            // CREATE_NO_WINDOW：GUI 进程拉起控制台程序 cmd 会新建一个可见控制台窗口
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command.output().ok()?;
            if !output.status.success() {
                return None;
            }
            String::from_utf8(output.stdout)
                .ok()?
                .lines()
                .map(|line| line.trim())
                .find(|line| !line.is_empty())
                .map(PathBuf::from)
        });
    *cache = found.clone();
    found
}

/// 查询一次 GPU 指标（单位 MiB / % / W）；多卡取第一行即 GPU0。无 NVIDIA 驱动时返回 None。
fn query_gpu_stats() -> Option<GpuStats> {
    let path = find_nvidia_smi()?;
    let mut command = std::process::Command::new(&path);
    command
        .args([
            "--query-gpu=memory.total,memory.used,utilization.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // CREATE_NO_WINDOW：nvidia-smi 是控制台程序，GUI 进程拉起时会闪出控制台窗口（每 2s 轮询一次）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    let fields: Vec<&str> = line.split(',').map(|field| field.trim()).collect();
    Some(GpuStats {
        memory_total_mb: fields.first().and_then(|value| value.parse::<f64>().ok()),
        memory_used_mb: fields.get(1).and_then(|value| value.parse::<f64>().ok()),
        util_percent: fields.get(2).and_then(|value| value.parse::<f64>().ok()),
        // 个别卡型不支持功耗读数（输出 "N/A"）→ None，前端回退为仅显示 Idle
        power_watts: fields.get(3).and_then(|value| value.parse::<f64>().ok()),
    })
}

/// 系统级硬件概览：显卡厂商 / 显存 / 总物理内存，供「适配本机」一键边界计算使用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardwareInfo {
    vendor: String,
    supported: bool,
    /// GPU 总显存（MiB；无独显或非 NVIDIA 驱动时为空）
    vram_total_mb: Option<f64>,
    /// Windows 可见总物理内存（MiB）；非 Windows 平台为空
    system_ram_mb: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuInfo {
    vendor: String,
    supported: bool,
    /// GPU 总显存（MiB；无独显 / 非 NVIDIA 驱动时为空）
    vram_total_mb: Option<f64>,
}

/// 探测显卡厂商 / 显存：NVIDIA 通过 nvidia-smi.exe（System32）并顺带读取总显存，
/// AMD 通过 atiadlxx.dll（System32）存在性判断，其余视为未知。
#[tauri::command]
pub(crate) fn get_gpu_info() -> GpuInfo {
    let (vendor, supported, vram_total_mb) = if find_nvidia_smi().is_some() {
        (
            "nvidia".to_string(),
            true,
            query_gpu_stats().and_then(|stats| stats.memory_total_mb),
        )
    } else if std::env::var("SystemRoot")
        .ok()
        .map(|root| PathBuf::from(root).join(r"system32\atiadlxx.dll"))
        .filter(|p| p.exists())
        .is_some()
    {
        ("amd".to_string(), false, None)
    } else {
        ("unknown".to_string(), false, None)
    };
    GpuInfo {
        vendor,
        supported,
        vram_total_mb,
    }
}

#[tauri::command]
pub(crate) async fn get_gpu_stats() -> Result<Option<GpuStats>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 上一轮查询仍在运行（驱动卡住）：跳过本轮，避免进程堆积
        if GPU_QUERY_BUSY
            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return None;
        }
        let stats = query_gpu_stats();
        GPU_QUERY_BUSY.store(false, Ordering::Relaxed);
        stats
    })
    .await
    .map_err(|_| "GPU 查询任务已中断".into())
}

#[cfg(windows)]
fn total_system_memory_mb() -> Option<f64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return None;
    }
    let total_kb = status.ullTotalPhys / 1024;
    Some(total_kb as f64 / 1024.0)
}

#[cfg(not(windows))]
fn total_system_memory_mb() -> Option<f64> {
    None
}

/// 汇总本机硬件能力：显卡 / 显存 + 总物理内存（供「适配本机」一键边界计算）。
#[tauri::command]
pub(crate) fn hardware_info() -> HardwareInfo {
    #[cfg(windows)]
    let system_ram_mb = total_system_memory_mb();
    #[cfg(not(windows))]
    let system_ram_mb = None;

    let info = get_gpu_info();
    #[cfg(windows)]
    let vram_total_mb = info.supported.then_some(info.vram_total_mb).flatten();
    #[cfg(not(windows))]
    let vram_total_mb = None;
    HardwareInfo {
        vendor: info.vendor,
        supported: info.supported,
        vram_total_mb,
        system_ram_mb,
    }
}

/// 从文件名或路径文本中提取 CUDA 完整版本（如 "12.4"、"13.4"、"11.8"、"13.2.86"）
pub(crate) fn extract_cuda_full_version(lower: &str) -> String {
    // 1. 扫描所有 "cuda" 出现位置（跳过 "cudart" 自身）
    let mut search_from = 0;
    while let Some(pos) = lower[search_from..].find("cuda") {
        let abs_pos = search_from + pos;
        search_from = abs_pos + 4;
        let after = &lower[abs_pos + 4..];
        if after.starts_with("rt") {
            continue;
        }
        let mut rest = after.trim_start_matches(|c| c == '-' || c == '_' || c == ' ');
        if rest.starts_with("cu") {
            rest = rest[2..].trim_start_matches(|c| c == '-' || c == '_');
        }
        if rest.starts_with(|c: char| c.is_ascii_digit()) {
            let mut out = String::new();
            for c in rest.chars() {
                if c.is_ascii_digit() || (c == '.' && !out.is_empty() && !out.ends_with('.')) {
                    out.push(c);
                } else {
                    break;
                }
            }
            while out.ends_with('.') {
                out.pop();
            }
            if !out.is_empty() {
                return out;
            }
        }
    }

    // 2. 扫描所有单独的 "cu" 后面直接跟数字（如 "cu12.4", "cu118", "cu12"）
    let mut search_from = 0;
    while let Some(pos) = lower[search_from..].find("cu") {
        let abs_pos = search_from + pos;
        search_from = abs_pos + 2;
        if lower[abs_pos..].starts_with("cuda") || lower[abs_pos..].starts_with("cudart") {
            continue;
        }
        let rest = lower[abs_pos + 2..].trim_start_matches(|c| c == '-' || c == '_');
        if rest.starts_with(|c: char| c.is_ascii_digit()) {
            let mut out = String::new();
            for c in rest.chars() {
                if c.is_ascii_digit() || (c == '.' && !out.is_empty() && !out.ends_with('.')) {
                    out.push(c);
                } else {
                    break;
                }
            }
            while out.ends_with('.') {
                out.pop();
            }
            if !out.is_empty() {
                return out;
            }
        }
    }

    String::new()
}

/// 提取 CUDA 主版本号（如 "12"、"13"、"11"）
pub(crate) fn extract_cuda_major_version(full_or_text: &str) -> String {
    let trimmed = full_or_text.trim();
    if trimmed.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        trimmed.split('.').next().unwrap_or("").to_string()
    } else {
        let full = extract_cuda_full_version(&trimmed.to_lowercase());
        full.split('.').next().unwrap_or("").to_string()
    }
}

/// 判断安装目录是否已包含指定主版本的 CUDA 运行时 dll（如 cudart64_12.dll / cublas64_12.dll）。
pub(crate) fn has_cuda_runtime_dll(dir: &Path, major: &str) -> bool {
    for name in [format!("cudart64_{}.dll", major), format!("cublas64_{}.dll", major), format!("cublasLt64_{}.dll", major)] {
        if dir.join(&name).is_file() {
            return true;
        }
    }
    if major == "11" && dir.join("cudart64_110.dll").is_file() {
        return true;
    }
    false
}

/// 判断安装目录是否具备指定主版本且完整的 CUDA 运行时（cudart 与 cublas 均就绪且未损坏）
pub(crate) fn is_cuda_runtime_complete(dir: &Path, major: &str) -> bool {
    if major.is_empty() {
        return false;
    }
    let has_cudart = dir.join(format!("cudart64_{}.dll", major)).is_file()
        || (major == "11" && dir.join("cudart64_110.dll").is_file());
    let has_cublas = dir.join(format!("cublas64_{}.dll", major)).is_file()
        || dir.join(format!("cublasLt64_{}.dll", major)).is_file();
    has_cudart && has_cublas
}

/// 获取指定目录下的 CUDA 版本（如 "12.4"、"13.4"、"12"）
pub(crate) fn get_installed_cuda_version(dir: &Path) -> Option<String> {
    if let Ok(text) = fs::read_to_string(dir.join("cuda_version.txt")) {
        let v = text.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    let path_text = dir.to_string_lossy().to_lowercase();
    let from_path = extract_cuda_full_version(&path_text);
    if !from_path.is_empty() {
        return Some(from_path);
    }
    for major in ["13", "12", "11"] {
        if is_cuda_runtime_complete(dir, major) {
            return Some(major.to_string());
        }
    }
    for major in ["13", "12", "11"] {
        if has_cuda_runtime_dll(dir, major) {
            return Some(major.to_string());
        }
    }
    None
}

/// 直连客户端（忽略系统/手动代理）：当代理路径连接失败时降级重试，兼容浏览器侧 TUN/Clash 透明代理。
pub(crate) fn direct_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent(HF_UA)
            .connect_timeout(std::time::Duration::from_secs(10))
            .no_proxy()
            .build()
            .expect("构建直连网络客户端失败")
    })
}

pub(crate) const HF_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 探测本机正在监听的代理端口（Clash 7897 / Clash 7890 / V2rayN 10809 等），返回可用地址。
/// 结果缓存 60 秒：本机代理端口在一次会话内几乎不变，而每次全量探测最坏 8×150ms，
/// 该函数被 fetch/download/avatar 等高频兜底链路反复调用。
pub(crate) fn probe_local_proxy() -> Option<String> {
    use std::net::{SocketAddr, TcpStream};
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;
    const PORTS: &[u16] = &[7897, 7890, 7891, 10809, 10808, 1080, 8888, 2080];
    const PROBE_TIMEOUT_MS: u64 = 150;
    const CACHE_TTL_MS: u64 = 60_000;
    struct ProbeCache {
        at_ms: AtomicU64,
        value: Mutex<Option<Option<String>>>,
    }
    static CACHE: OnceLock<ProbeCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| ProbeCache { at_ms: AtomicU64::new(0), value: Mutex::new(None) });
    let now = now_ms();
    let cached = cache.value.lock().ok().and_then(|guard| guard.as_ref().cloned()).filter(|_| {
        now.saturating_sub(cache.at_ms.load(Ordering::Relaxed)) < CACHE_TTL_MS
    });
    if let Some(value) = cached {
        return value;
    }
    let fresh = PORTS.iter().find_map(|port| {
        let address = SocketAddr::from(([127, 0, 0, 1], *port));
        TcpStream::connect_timeout(&address, Duration::from_millis(PROBE_TIMEOUT_MS)).is_ok().then(|| format!("http://127.0.0.1:{}", port))
    });
    if let Ok(mut guard) = cache.value.lock() {
        *guard = Some(fresh.clone());
        cache.at_ms.store(now, Ordering::Relaxed);
    }
    fresh
}

/// 带指定代理地址的客户端
pub(crate) fn proxied_client(proxy_url: &str) -> Result<reqwest::blocking::Client, String> {
    let proxy = reqwest::Proxy::all(proxy_url).map_err(|error| format!("代理地址无效：{}", error))?;
    reqwest::blocking::Client::builder()
        .user_agent(HF_UA)
        .connect_timeout(std::time::Duration::from_secs(10))
        .proxy(proxy)
        .build()
        .map_err(|error| format!("初始化代理客户端失败：{}", error))
}

/// 把 huggingface.co 替换为国内镜像 hf-mirror.com
pub(crate) fn hf_mirror_url(url: &str) -> Option<String> {
    if url.contains("huggingface.co") {
        Some(url.replace("huggingface.co", "hf-mirror.com"))
    } else {
        None
    }
}

/// 通用多通道兜底（原四处逐行复制的通道切换逻辑）：配置代理 → 直连 → 本机探测代理端口 →
/// mirror=true 时追加 hf-mirror 镜像通道。`attempt` 为单通道尝试（url 参数已按通道替换为镜像地址）；
/// 返回第一个成功的通道结果，全部失败时返回各通道的错误明细，由调用方拼接最终提示文案。
pub(crate) fn with_net_fallback<T>(
    config_client: &reqwest::blocking::Client,
    url: &str,
    mirror: bool,
    mut attempt: impl FnMut(&reqwest::blocking::Client, &str) -> Result<T, String>,
) -> Result<T, Vec<String>> {
    let mut errors: Vec<String> = Vec::new();
    match attempt(config_client, url) {
        Ok(value) => return Ok(value),
        Err(error) => errors.push(format!("配置代理通道：{}", error)),
    }
    match attempt(direct_client(), url) {
        Ok(value) => return Ok(value),
        Err(error) => errors.push(format!("直连：{}", error)),
    }
    if let Some(proxy_url) = probe_local_proxy() {
        match proxied_client(&proxy_url) {
            Ok(proxied) => match attempt(&proxied, url) {
                Ok(value) => return Ok(value),
                Err(error) => errors.push(format!("本地代理 {}：{}", proxy_url, error)),
            },
            Err(error) => errors.push(format!("初始化本地代理 {} 失败：{}", proxy_url, error)),
        }
    } else {
        errors.push("未探测到本机代理端口".into());
    }
    if mirror {
        if let Some(mirror_url) = hf_mirror_url(url) {
            match attempt(direct_client(), &mirror_url) {
                Ok(value) => return Ok(value),
                Err(error) => errors.push(format!("镜像 hf-mirror.com：{}", error)),
            }
        }
    }
    Err(errors)
}

/// 魔塔社区多通道兜底：直连（国内最快） → 配置网络 → 本机探测代理端口
pub(crate) fn with_ms_net_fallback<T>(
    config_client: &reqwest::blocking::Client,
    url: &str,
    mut attempt: impl FnMut(&reqwest::blocking::Client, &str) -> Result<T, String>,
) -> Result<T, Vec<String>> {
    let mut errors: Vec<String> = Vec::new();
    match attempt(direct_client(), url) {
        Ok(value) => return Ok(value),
        Err(error) => errors.push(format!("直连：{}", error)),
    }
    match attempt(config_client, url) {
        Ok(value) => return Ok(value),
        Err(error) => errors.push(format!("配置网络通道：{}", error)),
    }
    if let Some(proxy_url) = probe_local_proxy() {
        match proxied_client(&proxy_url) {
            Ok(proxied) => match attempt(&proxied, url) {
                Ok(value) => return Ok(value),
                Err(error) => errors.push(format!("本地代理 {}：{}", proxy_url, error)),
            },
            Err(error) => errors.push(format!("初始化本地代理 {} 失败：{}", proxy_url, error)),
        }
    }
    Err(errors)
}

/* ==================== 阶段一：硬件探测（CUDA / Vulkan / CPU 推荐） ==================== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardwareSuggestion {
    pub(crate) recommended_backend: String,
    gpu_name: Option<String>,
    cuda_supported: bool,
    vulkan_supported: bool,
}

#[cfg(target_os = "windows")]
fn load_library_exists(dll_name: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
    let wide: Vec<u16> = std::ffi::OsStr::new(dll_name).encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        // 已加载则直接命中；否则尝试加载（FreeLibrary 不在 windows-sys 0.59 可用 API 中）
        !GetModuleHandleW(wide.as_ptr()).is_null() || !LoadLibraryW(wide.as_ptr()).is_null()
    }
}

#[cfg(not(target_os = "windows"))]
fn load_library_exists(_dll_name: &str) -> bool {
    false
}

fn system32_dll_present(name: &str) -> bool {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    PathBuf::from(root).join("System32").join(name).exists()
}

/// 查询 NVIDIA GPU 名称（nvidia-smi 首行），查询失败返回 None。
fn query_gpu_name() -> Option<String> {
    let path = find_nvidia_smi()?;
    let mut command = Command::new(&path);
    command.args(["--query-gpu=name", "--format=csv,noheader,nounits"]).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()?.lines().map(str::trim).find(|line| !line.is_empty()).map(String::from)
}

/// 探测运行环境并推荐最合适的 llama.cpp 构建后端：cuda > vulkan > cpu。
#[tauri::command]
pub(crate) fn detect_hardware() -> HardwareSuggestion {
    let nvidia_present = find_nvidia_smi().is_some() || system32_dll_present("nvcuda.dll");
    let vulkan_present = load_library_exists("vulkan-1.dll") || system32_dll_present("vulkan-1.dll");
    let gpu_name = if nvidia_present { query_gpu_name() } else { None };
    let recommended_backend = if nvidia_present { "cuda" } else if vulkan_present { "vulkan" } else { "cpu" };
    HardwareSuggestion {
        recommended_backend: recommended_backend.into(),
        gpu_name,
        cuda_supported: nvidia_present,
        vulkan_supported: vulkan_present,
    }
}

/* ==================== 阶段二：代理与网络请求配置 ==================== */

/// 按配置构建 reqwest 客户端（带缓存）：网络配置不变时复用同一 Client，
/// 避免每个命令重建连接池 + TLS 会话（hf_avatar 每个作者调用一次，开销成倍放大）。
/// 配置变更（key 不匹配）时自动重建，无需手动失效。
pub(crate) fn build_net_client(network: &NetworkConfig) -> Result<reqwest::blocking::Client, String> {
    static CLIENT_CACHE: OnceLock<Mutex<Option<(String, reqwest::blocking::Client)>>> = OnceLock::new();
    let key = format!("{}|{}", network.proxy_mode, network.proxy_url.trim());
    if let Some(client) = CLIENT_CACHE.get_or_init(|| Mutex::new(None)).lock().ok().and_then(|guard| guard.as_ref().filter(|(cached_key, _)| cached_key == &key).map(|(_, client)| client.clone())) {
        return Ok(client);
    }
    let client = build_net_client_fresh(network)?;
    if let Ok(mut guard) = CLIENT_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some((key, client.clone()));
    }
    Ok(client)
}

/// 实际构建逻辑（无缓存）：manual 注入 Proxy::all，system 走系统代理（默认行为），direct 直连并忽略代理。
fn build_net_client_fresh(network: &NetworkConfig) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(HF_UA)
        .connect_timeout(std::time::Duration::from_secs(10));
    if network.proxy_mode == "manual" {
        let url = network.proxy_url.trim();
        if url.is_empty() {
            return Err("手动代理地址为空，请填写 http://127.0.0.1:7890 或 socks5://...".into());
        }
        let proxy = reqwest::Proxy::all(url).map_err(|error| format!("代理地址无效：{}", error))?;
        builder = builder.proxy(proxy);
    } else if network.proxy_mode == "direct" {
        // 直连：显式忽略系统代理 / 手动代理
        builder = builder.no_proxy();
    }
    builder.build().map_err(|error| format!("初始化网络客户端失败：{}", error))
}

/// 读取系统代理地址（仅 Windows）：读 HKCU 代理设置，ProxyEnable=1 时返回代理地址，否则返回 None。
#[cfg(windows)]
fn read_system_proxy_windows() -> Option<String> {
    use windows_sys::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, KEY_READ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW};

    const SETTINGS_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        let path: Vec<u16> = SETTINGS_PATH.encode_utf16().chain(std::iter::once(0)).collect();
        if RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut key) != 0 || key.is_null() {
            return None;
        }
        let cleanup = || RegCloseKey(key);
        // ProxyEnable = 1 才启用代理
        let mut enabled: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let name: Vec<u16> = "ProxyEnable".encode_utf16().chain(std::iter::once(0)).collect();
        let rc = RegQueryValueExW(key, name.as_ptr(), std::ptr::null(), std::ptr::null_mut(), &mut enabled as *mut u32 as *mut u8, &mut size);
        if rc != 0 || enabled == 0 {
            cleanup();
            return None;
        }
        // ProxyServer（可能形如 127.0.0.1:7890 或 http=...;https=...）
        let name2: Vec<u16> = "ProxyServer".encode_utf16().chain(std::iter::once(0)).collect();
        let mut buf = [0u16; 512];
        let mut buf_size = (buf.len() * std::mem::size_of::<u16>()) as u32;
        let rc = RegQueryValueExW(key, name2.as_ptr(), std::ptr::null(), std::ptr::null_mut(), buf.as_mut_ptr() as *mut u8, &mut buf_size);
        cleanup();
        if rc != 0 {
            return None;
        }
        let wide_end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let raw = String::from_utf16_lossy(&buf[..wide_end]);
        // 取第一段并去掉 http=/https= 前缀
        let segment = raw.split(';').next().unwrap_or("").trim().trim_end_matches('/');
        let host = segment.rsplit('=').next().unwrap_or(segment).trim();
        if host.is_empty() { None } else { Some(host.to_string()) }
    }
}

#[tauri::command]
pub(crate) fn get_system_proxy() -> Option<String> {
    #[cfg(windows)]
    {
        read_system_proxy_windows()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyTestResult {
    ok: bool,
    status: String,
    detail: String,
    latency_ms: u64,
}

/// 测试与 GitHub 的连通性：manual 走自定义代理，system 走系统代理（后台线程执行，避免阻塞 UI）。
fn test_proxy_connection_impl(network: NetworkConfig) -> Result<ProxyTestResult, String> {
    let client = build_net_client(&network)?;
    let target = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest".to_string();
    let start = now_ms();
    match client.get(&target).header("accept", "application/vnd.github+json").timeout(std::time::Duration::from_secs(25)).send() {
        Ok(response) => {
            let code = response.status().as_u16();
            let ok = (200..400).contains(&code);
            Ok(ProxyTestResult {
                ok,
                status: code.to_string(),
                detail: if ok { "连接成功，网络可用".into() } else { format!("服务返回 HTTP {}", code) },
                latency_ms: now_ms().saturating_sub(start),
            })
        }
        Err(error) => Ok(ProxyTestResult { ok: false, status: "ERR".into(), detail: format!("连接失败：{}", error), latency_ms: now_ms().saturating_sub(start) }),
    }
}

#[tauri::command]
pub(crate) async fn test_proxy_connection(
    app: AppHandle,
    proxy_mode: Option<String>,
    proxy_url: Option<String>,
) -> Result<ProxyTestResult, String> {
    let mut network = read_config(&app)?.network.unwrap_or_default();
    if let Some(mode) = proxy_mode {
        network.proxy_mode = mode;
    }
    if let Some(url) = proxy_url {
        network.proxy_url = url;
    }
    tauri::async_runtime::spawn_blocking(move || test_proxy_connection_impl(network))
        .await
        .map_err(|error| format!("连接测试任务中断：{}", error))?
}
