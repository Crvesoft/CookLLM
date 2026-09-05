use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{webview::NewWindowResponse, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelAsset {
    id: String,
    name: String,
    /// 自定义显示名；空则回退到 name。
    #[serde(default)]
    display_name: Option<String>,
    path: String,
    size_bytes: u64,
    architecture: String,
    quantization: String,
    parameters: String,
    /// 该模型专属的运行预设。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    profiles: Vec<Profile>,
    /// 旧版全局预设引用，仅用于读取旧配置文件以回填 profiles。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    profile_ids: Vec<String>,
    /// 该模型的默认启动预设 id。
    #[serde(default)]
    default_profile_id: Option<String>,
    accent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    name: String,
    description: String,
    #[serde(default = "default_host")]
    host: String,
    port: u16,
    gpu_layers: i32,
    context_size: u32,
    threads: u16,
    #[serde(default = "default_parallel")]
    parallel: u32,
    batch_size: u32,
    #[serde(default = "default_ubatch_size")]
    ubatch_size: u32,
    flash_attention: bool,
    #[serde(default = "default_cache_type")]
    cache_type_k: String,
    #[serde(default = "default_cache_type")]
    cache_type_v: String,
    #[serde(default)]
    jinja: bool,
    #[serde(default = "default_reasoning")]
    reasoning: String,
    #[serde(default = "default_reasoning")]
    reasoning_effort: String,
    #[serde(default = "default_load_mode")]
    load_mode: String,
    temperature: f64,
    top_p: f64,
    min_p: f64,
    repeat_penalty: f64,
    extra_args: String,
    /// 该预设挂载的图像识别视觉模型（mmproj）；非空时以 --mmproj 附加启动。
    #[serde(default)]
    mmproj_path: Option<String>,
}

fn default_host() -> String { "0.0.0.0".into() }
fn default_parallel() -> u32 { 1 }
fn default_ubatch_size() -> u32 { 256 }
fn default_cache_type() -> String { "f32".into() }
fn default_reasoning() -> String { "auto".into() }
fn default_load_mode() -> String { "mmap".into() }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupTiming {
    app_start_ms: u64,
    before_builder_ms: u64,
    after_build_ms: u64,
    page_load_ms: Option<u64>,
    splash_shown_ms: Option<u64>,
    react_mounted_ms: Option<u64>,
    reported: bool,
}

fn log_timing(t: &StartupTiming) {
    let page = t.page_load_ms.map(|v| v as i64 - t.app_start_ms as i64).map(|v| v.to_string()).unwrap_or("N/A".into());
    let splash = t.splash_shown_ms.map(|v| v as i64 - t.app_start_ms as i64).map(|v| v.to_string()).unwrap_or("N/A".into());
    let react = t.react_mounted_ms.map(|v| v as i64 - t.app_start_ms as i64).map(|v| v.to_string()).unwrap_or("N/A".into());
    println!(
        "[StartupTiming] app_start={} builder=+{}ms build_done=+{}ms page_load=+{}ms splash=+{}ms react=+{}ms total_to_render=+{}ms",
        t.app_start_ms,
        t.before_builder_ms as i64 - t.app_start_ms as i64,
        t.after_build_ms as i64 - t.app_start_ms as i64,
        page, splash, react,
        t.react_mounted_ms.map(|v| v as i64 - t.app_start_ms as i64).unwrap_or(-1),
    );
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    server_path: String,
    models: Vec<ModelAsset>,
    /// 旧版全局预设池，仅兼容旧配置文件；新配置的预设已内置于每个模型。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    profiles: Vec<Profile>,
    /// 界面主题：light(默认) 或 dark。
    #[serde(default)]
    theme: Option<String>,
    /// GPU performance monitor toggle (default on; AMD/unsupported GPUs can disable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gpu_monitor_enabled: Option<bool>,
    /// 社区探索「刻面筛选」侧边栏是否折叠（默认展开）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    explore_sidebar_collapsed: Option<bool>,
    preferred_model_id: Option<String>,
    preferred_profile_id: Option<String>,
    /// 网络与代理配置（跟随系统 / 手动代理 / GitHub 镜像）；缺省为跟随系统。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    network: Option<NetworkConfig>,
    /// 自定义 llama.cpp 安装目录；缺省为应用数据目录下的 llamacpp。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    llamacpp_dir: Option<String>,
    /// 模型存储根目录（社区下载 / 自动扫描）；缺省为应用数据目录下的 models。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models_dir: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_path: String::new(),
            models: Vec::new(),
            profiles: vec![Profile {
                id: "balanced".into(),
                name: "均衡模式".into(),
                description: "日常对话与编码的推荐配置".into(),
                host: default_host(),
                port: 9931,
                gpu_layers: 35,
                context_size: 8192,
                threads: 8,
                parallel: default_parallel(),
                batch_size: 512,
                ubatch_size: default_ubatch_size(),
                flash_attention: true,
                cache_type_k: default_cache_type(),
                cache_type_v: default_cache_type(),
                jinja: true,
                reasoning: default_reasoning(),
                reasoning_effort: default_reasoning(),
                load_mode: default_load_mode(),
                temperature: 0.7,
                top_p: 0.9,
                min_p: 0.05,
                repeat_penalty: 1.1,
                extra_args: String::new(),
                mmproj_path: None,
            }],
            theme: None,
            gpu_monitor_enabled: None,
            explore_sidebar_collapsed: None,
            preferred_model_id: None,
            preferred_profile_id: None,
            network: None,
            llamacpp_dir: None,
            models_dir: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    running: bool,
    pid: Option<u32>,
    port: Option<u16>,
    model_id: Option<String>,
    model_name: Option<String>,
    profile_id: Option<String>,
    profile_name: Option<String>,
    started_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct LogPayload {
    stream: String,
    line: String,
    timestamp: u64,
}

struct ManagedProcess {
    child: Child,
    status: ServerStatus,
}

/// 本进程托管的 llama-server；None 表示未运行。
#[derive(Default)]
struct ProcessState(Mutex<Option<ManagedProcess>>);

#[derive(Default)]
struct TimingState(Mutex<StartupTiming>);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("config.json"))
}

fn read_config(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn emit_log(app: &AppHandle, stream: &str, line: impl Into<String>) {
    let _ = app.emit("llama-log", LogPayload { stream: stream.into(), line: line.into(), timestamp: now_ms() });
}

fn stream_reader<R: std::io::Read + Send + 'static>(app: AppHandle, stream: &'static str, reader: R) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            emit_log(&app, stream, line);
        }
    });
}

/// 强制终止托管子进程（llama-server），三处出口共用：退出时 / 停止服务 / 重启服务。
/// - Windows：taskkill /T /F（与"停止服务"按钮一致，最可靠，连带整棵进程树），
///   此前退出路径用 in-process Child::kill 无法可靠杀掉 llama-server，导致它留在后台占显存。
/// - 非 Windows：Child::kill。
/// 之后带 5 秒超时轮询 wait：确保进程被回收，同时绝不无限阻塞调用线程（退出流程同样安全）。
fn kill_managed_child(managed: &mut ManagedProcess) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：避免拉起 taskkill 时闪出控制台窗口
        let _ = Command::new("taskkill")
            .args(["/PID", &managed.child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = managed.child.kill();
    }
    let deadline = now_ms() + 5000;
    loop {
        match managed.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if now_ms() >= deadline => break,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => break,
        }
    }
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    read_config(&app)
}

/// Windows 沉浸式深色标题栏：DWMWA_USE_IMMERSIVE_DARK_MODE (20)。
/// dark=true 时窗口标题栏变黑，false 恢复系统默认（亮色主题用）。
#[cfg(target_os = "windows")]
mod titlebar {
    use std::ffi::c_void;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: *const c_void, attr: u32, value: *const c_void) -> i32;
    }

    pub fn set_dark_mode(hwnd: *mut c_void, dark: bool) {
        const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
        let value: i32 = if dark { 1 } else { 0 };
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd as *const c_void,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &value as *const i32 as *const c_void,
            );
        }
    }
}

/// 按应用主题同步系统标题栏：暗色主题时让 Windows 窗口标题栏变黑，亮色恢复默认。
#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // Tauri 的 HWND 是 *mut c_void 的透明 newtype（单指针字段），转成裸指针调用 DWM API。
        let raw: *mut std::ffi::c_void = unsafe { std::mem::transmute(hwnd) };
        titlebar::set_dark_mode(raw, dark);
    }
    Ok(())
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_server(app: AppHandle, state: State<ProcessState>, model_id: String, profile_id: String) -> Result<ServerStatus, String> {
    let config = read_config(&app)?;
    let model = config.models.iter().find(|item| item.id == model_id).cloned().ok_or("未找到模型配置")?;
    let profile = model.profiles.iter().find(|item| item.id == profile_id)
        .or_else(|| config.profiles.iter().find(|item| item.id == profile_id))
        .cloned().ok_or("未找到运行预设")?;
    if config.server_path.trim().is_empty() {
        return Err("请先在设置中选择 llama-server.exe".into());
    }
    if !PathBuf::from(&config.server_path).exists() {
        return Err(format!("llama-server 不存在：{}", config.server_path));
    }
    if !PathBuf::from(&model.path).exists() {
        return Err(format!("模型文件不存在：{}", model.path));
    }
    let mmproj_path = profile.mmproj_path.as_deref().filter(|p| !p.trim().is_empty());
    if let Some(mmproj) = mmproj_path {
        if !PathBuf::from(mmproj).exists() {
            return Err(format!("图像识别模型（mmproj）不存在：{}", mmproj));
        }
    }

    let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
    if let Some(mut running) = guard.take() {
        kill_managed_child(&mut running);
    }

    let mut command = Command::new(&config.server_path);
    command
        .arg("-m").arg(&model.path);
    if let Some(mmproj) = mmproj_path {
        command.arg("--mmproj").arg(mmproj);
    }
    command
        .arg("--host").arg(&profile.host)
        .arg("--port").arg(profile.port.to_string())
        .arg("-ngl").arg(profile.gpu_layers.to_string())
        .arg("-c").arg(profile.context_size.to_string())
        .arg("-t").arg(profile.threads.to_string())
        .arg("-np").arg(profile.parallel.to_string())
        .arg("-b").arg(profile.batch_size.to_string())
        .arg("-ub").arg(profile.ubatch_size.to_string())
        .arg("--cache-type-k").arg(&profile.cache_type_k)
        .arg("--cache-type-v").arg(&profile.cache_type_v)
        .arg("--load-mode").arg(&profile.load_mode)
        .arg("--reasoning").arg(&profile.reasoning)
        .arg("--reasoning-effort").arg(&profile.reasoning_effort)
        .arg("--temp").arg(profile.temperature.to_string())
        .arg("--top-p").arg(profile.top_p.to_string())
        .arg("--min-p").arg(profile.min_p.to_string())
        .arg("--repeat-penalty").arg(profile.repeat_penalty.to_string());
    if profile.flash_attention {
        command.arg("--flash-attn").arg("on");
    }
    if profile.jinja {
        command.arg("--jinja");
    }
    if let Some(extra) = shlex::split(&profile.extra_args) {
        command.args(extra);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    emit_log(&app, "system", format!("launch: {} · {}", model.name, profile.name));
    let mut child = command.spawn().map_err(|error| format!("启动失败：{error}"))?;
    let pid = child.id();
    if let Some(stdout) = child.stdout.take() {
        stream_reader(app.clone(), "stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        stream_reader(app.clone(), "stderr", stderr);
    }
    let status = ServerStatus {
        running: true,
        pid: Some(pid),
        port: Some(profile.port),
        model_id: Some(model.id),
        model_name: Some(model.name),
        profile_id: Some(profile.id),
        profile_name: Some(profile.name),
        started_at: Some(now_ms()),
    };
    *guard = Some(ManagedProcess { child, status: status.clone() });
    Ok(status)
}

#[tauri::command]
fn stop_server(app: AppHandle, state: State<ProcessState>) -> Result<ServerStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
    if let Some(mut managed) = guard.take() {
        kill_managed_child(&mut managed);
        emit_log(&app, "system", "llama-server 已停止");
    } else {
        emit_log(&app, "system", "llama-server 未在运行");
    }
    Ok(ServerStatus::default())
}

#[tauri::command]
fn get_server_status(state: State<ProcessState>) -> Result<ServerStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
    if let Some(managed) = guard.as_mut() {
        match managed.child.try_wait() {
            Ok(Some(_)) => { *guard = None; Ok(ServerStatus::default()) }
            Ok(None) => Ok(managed.status.clone()),
            Err(error) => Err(error.to_string()),
        }
    } else {
        Ok(ServerStatus::default())
    }
}

/// GPU 实时指标（nvidia-smi）：显存 MiB / 核心负载 % / 功耗 W；驱动不支持的字段为 None。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuStats {
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
        memory_total_mb: fields.get(0).and_then(|value| value.parse::<f64>().ok()),
        memory_used_mb: fields.get(1).and_then(|value| value.parse::<f64>().ok()),
        util_percent: fields.get(2).and_then(|value| value.parse::<f64>().ok()),
        // 个别卡型不支持功耗读数（输出 "N/A"）→ None，前端回退为仅显示 Idle
        power_watts: fields.get(3).and_then(|value| value.parse::<f64>().ok()),
    })
}

/// 系统级硬件概览：显卡厂商 / 显存 / 总物理内存，供「适配本机」一键边界计算使用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareInfo {
    vendor: String,
    supported: bool,
    /// GPU 总显存（MiB；无独显或非 NVIDIA 驱动时为空）
    vram_total_mb: Option<f64>,
    /// Windows 可见总物理内存（MiB）；非 Windows 平台为空
    system_ram_mb: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuInfo {
    vendor: String,
    supported: bool,
    /// GPU 总显存（MiB；无独显 / 非 NVIDIA 驱动时为空）
    vram_total_mb: Option<f64>,
}

/// 探测显卡厂商 / 显存：NVIDIA 通过 nvidia-smi.exe（System32）并顺带读取总显存，
/// AMD 通过 atiadlxx.dll（System32）存在性判断，其余视为未知。
#[tauri::command]
fn get_gpu_info() -> GpuInfo {
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
async fn get_gpu_stats() -> Result<Option<GpuStats>, String> {
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
fn hardware_info() -> HardwareInfo {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    path: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskUsage {
    path: String,
    total_bytes: u64,
    free_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HuggingFaceModel {
    id: String,
    author: String,
    name: String,
    downloads: u64,
    likes: u64,
    updated_at: String,
    tags: Vec<String>,
    /// 已有 .gguf 文件总数（-1 表示未查询）
    gguf_count: i64,
    /// 供列表页展示的推荐量化文件名（可能为空）
    sample_quant: Option<String>,
    /// 从模型名/标签解析出的参数量（十亿单位；解析失败为 None）
    parameters_b: Option<f64>,
    /// 从量化标签解析出的比特位（如 Q4_K_M → 4、IQ3_M → 3；无法识别为 None）
    quant_bits: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HuggingFaceFile {
    name: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HfDownloadResult {
    path: String,
    size_bytes: u64,
}

#[tauri::command]
fn pick_files(app: AppHandle, filters: Vec<String>) -> Vec<PickedFile> {
    let mut builder = app.dialog().file();
    if !filters.is_empty() {
        let refs = filters.iter().map(String::as_str).collect::<Vec<_>>();
        builder = builder.add_filter("支持的文件", &refs);
    }
    let mut out = Vec::new();
    for file_path in builder.blocking_pick_files().unwrap_or_default() {
        if let Some(value) = file_path.as_path() {
            out.push(PickedFile {
                path: value.to_string_lossy().to_string(),
                size_bytes: fs::metadata(value).map(|meta| meta.len()).unwrap_or(0),
            });
        }
    }
    out
}

/// 递归收集目录下的 .gguf 文件（含子目录）。
fn collect_gguf(dir: &Path, out: &mut Vec<PickedFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            collect_gguf(&path, out);
        } else if file_type.is_file() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if name.ends_with(".gguf") {
                let size_bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                out.push(PickedFile {
                    path: path.to_string_lossy().to_string(),
                    size_bytes,
                });
            }
        }
    }
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Vec<PickedFile> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Vec::new();
    };
    let Some(folder) = folder.as_path() else {
        return Vec::new();
    };
    let folder = folder.to_path_buf();
    let mut out = Vec::new();
    collect_gguf(&folder, &mut out);
    out
}

/// 把 root 下所有 *.dll 文件复制到 bin_dir（与 llama-server.exe 同级），供 CUDA/Vulkan 运行时使用。
/// 覆盖 cudart 包可能把 dll 放在子目录的情况（如 lib/ 或 bin/x64/）。
fn flatten_dlls(root: &Path, bin_dir: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            flatten_dlls(&path, bin_dir);
        } else if path.extension().map(|ext| ext.eq_ignore_ascii_case("dll")).unwrap_or(false) {
            let name = path.file_name().unwrap_or_default();
            let dest = bin_dir.join(name);
            if !dest.exists() {
                let _ = fs::copy(&path, &dest);
            }
        }
    }
}

/// 判断安装目录是否已包含指定主版本的 CUDA 运行时 dll（如 cudart64_12.dll / cublas64_12.dll）。
/// 正式版 cudart 包通常同时带这几个文件；任一存在即视为该主版本运行时已就绪。
fn has_cuda_runtime_dll(dir: &Path, major: &str) -> bool {
    for name in [format!("cudart64_{}.dll", major), format!("cublas64_{}.dll", major), format!("cublasLt64_{}.dll", major)] {
        if dir.join(&name).is_file() {
            return true;
        }
    }
    false
}

/// 在目录树中查找可执行文件：当前目录优先，其次按子目录就近递归，深度上限 6。
fn find_executable(dir: &Path, exe_name: &str, depth: usize) -> Option<PathBuf> {
    let entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
    let current = entries.iter().find(|entry| {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if cfg!(windows) {
            name.eq_ignore_ascii_case(exe_name)
        } else {
            name == exe_name
        }
    }).map(|entry| entry.path());
    if let Some(found) = current {
        return Some(found);
    }
    if depth >= 6 {
        return None;
    }
    for entry in entries {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(found) = find_executable(&path, exe_name, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// 选择本机 llama.cpp 构建目录，自动定位其中的 llama-server.exe（当前目录优先，子目录就近递归）。
/// 用户取消时返回空串；目录内未找到可执行文件时返回错误。
#[tauri::command]
fn pick_server_dir(app: AppHandle) -> Result<String, String> {
    let Some(file_path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(String::new());
    };
    let Some(folder) = file_path.as_path() else {
        return Ok(String::new());
    };
    let exe_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    match find_executable(folder, exe_name, 0) {
        Some(path) => Ok(path.to_string_lossy().to_string()),
        None => Err("所选文件夹中未找到 llama-server.exe".into()),
    }
}

/// 把前端拖入/选中的路径展开为 GGUF 文件列表：目录递归收集，文件按 .gguf 后缀过滤，最后按路径去重。
/// 供“拖拽上传区”使用——拖入的文件/文件夹路径直接来自 Tauri 的 drag-drop 事件。
#[tauri::command]
fn expand_paths(paths: Vec<String>) -> Vec<PickedFile> {
    let mut raw = Vec::new();
    for path in paths {
        let p = PathBuf::from(&path);
        if p.is_dir() {
            collect_gguf(&p, &mut raw);
        } else if p.is_file() {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if name.ends_with(".gguf") {
                let size_bytes = fs::metadata(&p).map(|meta| meta.len()).unwrap_or(0);
                raw.push(PickedFile { path, size_bytes });
            }
        }
    }
    dedup_gguf(raw)
}

fn path_dedupe_key(path: &str) -> String {
    // Windows 文件系统大小写不敏感，按小写去重避免同一文件被识别为两条
    #[cfg(windows)]
    { path.to_lowercase() }
    #[cfg(not(windows))]
    { path.to_string() }
}

fn dedup_gguf(items: Vec<PickedFile>) -> Vec<PickedFile> {
    let mut seen: Vec<String> = Vec::new();
    items
        .into_iter()
        .filter(|item| {
            let key = path_dedupe_key(&item.path);
            let fresh = !seen.contains(&key);
            if fresh {
                seen.push(key);
            }
            fresh
        })
        .collect()
}

/// 打开应用配置目录（config.json 所在文件夹），便于用户查看 / 备份配置文件。
#[tauri::command]
fn open_config_dir(app: AppHandle) -> Result<(), String> {
    let directory = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    open_url(app, directory.to_string_lossy().to_string())
}

#[tauri::command]
fn open_url(_app: AppHandle, url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 前端首帧渲染完成后调用，显示主窗口，消除启动黑屏。
#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}

/// 前端上报页面侧计时（unix 毫秒）：文档开始 / DOM 就绪（splash 可见）/ React 挂载，汇总打印全链路时间线。
#[tauri::command]
fn report_startup_timing(
    state: State<TimingState>,
    page_load_ms: u64,
    splash_shown_ms: u64,
    react_mounted_ms: u64,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "计时锁已损坏")?;
    guard.page_load_ms = Some(page_load_ms);
    guard.splash_shown_ms = Some(splash_shown_ms);
    guard.react_mounted_ms = Some(react_mounted_ms);
    guard.reported = true;
    log_timing(&*guard);
    Ok(())
}


/// Bridge script injected into ALL frames (main app frame skips itself).
/// 1. Wrap navigator.clipboard.writeText: when the native API fails, post a
///    message to the top page so it can fall back to the Tauri clipboard.
/// 2. Intercept clicks on external links inside the iframe and ask the top
///    page to open them in the system browser.
const IFRAME_BRIDGE_SCRIPT: &str = r##"
(function () {
  if (window.top === window) return;
  function send(payload) {
    try { window.top.postMessage(payload, "*"); } catch (e) {}
  }
  try {
    var nav = window.navigator;
    var originals = nav.clipboard && nav.clipboard.writeText;
    if (originals) {
      nav.clipboard.writeText = function (text) {
        try {
          return originals.call(nav.clipboard, text).catch(function () {
            send({ type: "cookllm:copy", text: String(text) });
            return true;
          });
        } catch (e) {
          send({ type: "cookllm:copy", text: String(text) });
          return Promise.resolve(true);
        }
      };
    }
  } catch (e) {}
  document.addEventListener("click", function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    var href = anchor.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" || /^javascript:/i.test(href)) return;
    var url;
    try { url = new URL(href, window.location.href); } catch (e) { return; }
    var host = url.hostname;
    var local = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === window.location.hostname;
    if ((url.protocol === "http:" || url.protocol === "https:") && !local) {
      event.preventDefault();
      event.stopPropagation();
      send({ type: "cookllm:open", url: url.href });
    }
  });
})();
"##;

/// Allow navigation to the app itself and local llama services
/// (localhost / loopback / private network). Any other http/https navigation
/// is cancelled and handed to the system browser instead, so an external page
/// can never replace the Tauri main window.
fn should_allow_navigation(url: &tauri::Url) -> bool {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return true; // tauri:// app page, about:blank, data:, etc.
    }
    let host = url.host_str().unwrap_or("");
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".tauri.localhost") || host == "tauri.localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        if ip.is_loopback() || ip.is_unspecified() || ip.is_private() || ip.is_link_local() {
            return true;
        }
    }
    if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        if ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() || ip.is_unicast_link_local() {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn set_system_clipboard(text: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    let mut utf16: Vec<u16> = text.encode_utf16().collect();
    utf16.push(0);
    let bytes = utf16.len() * 2;

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("OpenClipboard failed".into());
        }
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if handle.is_null() {
            let _ = CloseClipboard();
            return Err("GlobalAlloc failed".into());
        }
        let target = GlobalLock(handle);
        if target.is_null() {
            let _ = GlobalFree(handle);
            let _ = CloseClipboard();
            return Err("GlobalLock failed".into());
        }
        std::ptr::copy_nonoverlapping(utf16.as_ptr(), target as *mut u16, utf16.len());
        let _ = GlobalUnlock(handle);
        let _ = EmptyClipboard();
        let set = SetClipboardData(CF_UNICODETEXT as u32, handle);
        let _ = CloseClipboard();
        if set.is_null() {
            let _ = GlobalFree(handle);
            return Err("SetClipboardData failed".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_system_clipboard(text: &str) -> Result<(), String> {
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
    }
    child.wait().map_err(|error| error.to_string())?;
    Ok(())
}

/// Called by the top page when the iframe native Clipboard API failed.
#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    set_system_clipboard(&text)
}

/// Create the main window manually (tauri.conf.json has create:false) so we can
/// register navigation / new-window interception, enable WebView2 clipboard
/// permissions and inject the iframe bridge script.
fn configure_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let navigation_handle = app.handle().clone();
    let new_window_handle = app.handle().clone();
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
        .enable_clipboard_access()
        .initialization_script_for_all_frames(IFRAME_BRIDGE_SCRIPT)
        .on_navigation(move |url| {
            if should_allow_navigation(url) {
                return true;
            }
            let _ = open_url(navigation_handle.clone(), url.as_str().to_string());
            false
        })
        .on_new_window(move |url, _features| {
            if !should_allow_navigation(&url) {
                let _ = open_url(new_window_handle.clone(), url.as_str().to_string());
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}


/* ==================== 阶段四：社区探索（HuggingFace 热门 / 搜索 / 下载） ==================== */

const HF_API_BASE: &str = "https://huggingface.co/api";
const HF_DL_BASE: &str = "https://huggingface.co";

fn hf_repo_id(repo: &str) -> String {
    repo.trim().trim_end_matches('/').to_string()
}

/// 仓库名转安全目录名（社区探索下载的本地根目录名）。
fn hf_repo_dir_name(repo: &str) -> String {
    let id = hf_repo_id(repo);
    let last = id.rsplit('/').next().unwrap_or(&id);
    let sanitized: String = last
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if sanitized.is_empty() { "model".into() } else { sanitized }
}

/// 直连客户端（忽略系统/手动代理）：当代理路径连接失败时降级重试，兼容浏览器侧 TUN/Clash 透明代理。
fn direct_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .connect_timeout(std::time::Duration::from_secs(10))
            .no_proxy()
            .build()
            .expect("构建直连网络客户端失败")
    })
}

const HF_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 带标准浏览器 UA 的 HF 请求
fn hf_send(client: &reqwest::blocking::Client, url: &str) -> Result<reqwest::blocking::Response, reqwest::Error> {
    client
        .get(url)
        .header("user-agent", HF_UA)
        .timeout(std::time::Duration::from_secs(30))
        .send()
}

/// 处理 HF 响应：状态码检查 + JSON 解析
fn hf_response_json(response: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    if !response.status().is_success() {
        let code = response.status().as_u16();
        let message = match code {
            429 => "HuggingFace API 触发限流（HTTP 429），请稍后重试".to_string(),
            403 => "HuggingFace API 拒绝访问（HTTP 403）".to_string(),
            _ => format!("HuggingFace API 返回 HTTP {}", code),
        };
        return Err(message);
    }
    response.json().map_err(|error| format!("解析 HuggingFace API 响应失败：{}", error))
}

/// 探测本机正在监听的代理端口（Clash 7897 / Clash 7890 / V2rayN 10809 等），返回可用地址
fn probe_local_proxy() -> Option<String> {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    const PORTS: &[u16] = &[7897, 7890, 7891, 10809, 10808, 1080, 8888, 2080];
    for port in PORTS {
        let address = SocketAddr::from(([127, 0, 0, 1], *port));
        if TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok() {
            return Some(format!("http://127.0.0.1:{}", port));
        }
    }
    None
}

/// 带指定代理地址的客户端
fn proxied_client(proxy_url: &str) -> Result<reqwest::blocking::Client, String> {
    let proxy = reqwest::Proxy::all(proxy_url).map_err(|error| format!("代理地址无效：{}", error))?;
    reqwest::blocking::Client::builder()
        .user_agent(HF_UA)
        .connect_timeout(std::time::Duration::from_secs(10))
        .proxy(proxy)
        .build()
        .map_err(|error| format!("初始化代理客户端失败：{}", error))
}

/// 把 huggingface.co 替换为国内镜像 hf-mirror.com
fn hf_mirror_url(url: &str) -> Option<String> {
    if url.contains("huggingface.co") {
        Some(url.replace("huggingface.co", "hf-mirror.com"))
    } else {
        None
    }
}

/// 查询 HF API：多通道自动兜底（配置代理 → 直连 → 本机代理端口 → hf-mirror 镜像）
fn fetch_hf_json(client: &reqwest::blocking::Client, url: &str) -> Result<serde_json::Value, String> {
    let mut errors: Vec<String> = Vec::new();
    match hf_send(client, url) {
        Ok(response) => match hf_response_json(response) {
            Ok(value) => return Ok(value),
            Err(error) => errors.push(format!("配置代理通道：{}", error)),
        },
        Err(error) => errors.push(format!("配置代理通道：{}", error)),
    }
    match hf_send(direct_client(), url) {
        Ok(response) => match hf_response_json(response) {
            Ok(value) => return Ok(value),
            Err(error) => errors.push(format!("直连：{}", error)),
        },
        Err(error) => errors.push(format!("直连：{}", error)),
    }
    if let Some(proxy_url) = probe_local_proxy() {
        match proxied_client(&proxy_url) {
            Ok(proxied) => match hf_send(&proxied, url) {
                Ok(response) => match hf_response_json(response) {
                    Ok(value) => return Ok(value),
                    Err(error) => errors.push(format!("本地代理 {}：{}", proxy_url, error)),
                },
                Err(error) => errors.push(format!("本地代理 {}：{}", proxy_url, error)),
            },
            Err(error) => errors.push(format!("初始化本地代理 {} 失败：{}", proxy_url, error)),
        }
    } else {
        errors.push("未探测到本机代理端口".into());
    }
    if let Some(mirror) = hf_mirror_url(url) {
        match hf_send(direct_client(), &mirror) {
            Ok(response) => match hf_response_json(response) {
                Ok(value) => return Ok(value),
                Err(error) => errors.push(format!("镜像 hf-mirror.com：{}", error)),
            },
            Err(error) => errors.push(format!("镜像 hf-mirror.com：{}", error)),
        }
    }
    Err(format!("HuggingFace 连接失败（{}）。请在「设置 → 网络与代理」选择手动代理（Clash 端口 7897 / V2rayN 10809）后重试", errors.join("；")))
}

/// 拉取候选模型并按量化位过滤（服务端二次过滤：HF filter 不支持按 bit 查询）。
/// 有量化过滤时放大 limit，循环翻页直到凑满目标数量或 API 返回空，保证分页语义正确。
fn fetch_models_filtered(client: &reqwest::blocking::Client, base: &str, gguf_only: bool, limit: usize, skip: Option<usize>, quants: Option<Vec<i32>>) -> Result<Vec<HuggingFaceModel>, String> {
    let wanted = limit;
    if let Some(bits) = quants {
        if !bits.is_empty() {
            let mut seen = std::collections::HashSet::new();
            let mut collected: Vec<HuggingFaceModel> = Vec::new();
            let mut cursor = skip.unwrap_or(0);
            let page = (wanted * 4).max(50).min(100);
            // 最多 20 页，避免极端情况死循环
            for _ in 0..20 {
                let mut url = format!("{}&limit={}&skip={}", base, page, cursor);
                if gguf_only {
                    url.push_str("&filter=gguf");
                }
                let value = fetch_hf_json(client, &url)?;
                let items = value.as_array().ok_or("HuggingFace API 返回格式异常")?;
                let mut any = false;
                for value in items {
                    if let Some(model) = hf_model_from_value(value) {
                        any = true;
                        if let Some(bits_b) = model.quant_bits {
                            if bits.contains(&bits_b) && seen.insert(model.id.clone()) {
                                collected.push(model);
                                if collected.len() >= wanted {
                                    return Ok(collected);
                                }
                            }
                        }
                    }
                }
                if !any || items.len() < page {
                    break;
                }
                cursor += page;
            }
            return Ok(collected);
        }
    }
    // 无量化过滤：原有单页逻辑
    let mut url = format!("{}&limit={}", base, wanted);
    if let Some(page_skip) = skip {
        url.push_str(&format!("&skip={}", page_skip));
    }
    if gguf_only {
        url.push_str("&filter=gguf");
    }
    let value = fetch_hf_json(client, &url)?;
    let items = value.as_array().ok_or("HuggingFace API 返回格式异常")?;
    Ok(items.iter().filter_map(hf_model_from_value).collect::<Vec<_>>())
}

fn hf_model_from_value(value: &serde_json::Value) -> Option<HuggingFaceModel> {
    let id = value.get("id").and_then(|value| value.as_str())?.to_string();
    if id.is_empty() {
        return None;
    }
    let author = id.split('/').next().unwrap_or("").to_string();
    let name = value
        .get("modelId")
        .and_then(|value| value.as_str())
        .or_else(|| value.get("id").and_then(|value| value.as_str()))
        .unwrap_or(&id)
        .to_string();
    let tags: Vec<String> = value
        .get("tags")
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(|tag| tag.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let gated = value
        .get("gated")
        .map(|value| match value {
            serde_json::Value::Bool(flag) => *flag,
            serde_json::Value::String(text) => text != "false",
            _ => false,
        })
        .unwrap_or(false);
    let sample_quant = tags
        .iter()
        .find(|tag| tag.to_lowercase().contains(".gguf"))
        .cloned()
        .or_else(|| {
            ["Q4_K_M", "Q5_K_M", "Q8_0", "Q6_K", "Q4_0"]
                .iter()
                .find(|candidate| tags.iter().any(|tag| tag.to_uppercase().contains(**candidate)))
                .map(|value| value.to_string())
        });
    // 参数量：优先取形如 0.5B / 7B / 14B / 32B / 70B 的数字（名称或标签中最靠前的匹配）。
    let parameter_sources = std::iter::once(id.clone())
        .chain(tags.iter().cloned())
        .collect::<Vec<_>>();
    let parameters_b = parameter_sources
        .iter()
        .filter_map(|text| {
            regex_like_parameter(text).or_else(|| {
                // 兜底：把 "14b-instruct" 等小写串也纳入匹配
                regex_like_parameter(&text.to_lowercase())
            })
        })
        .next();
    // 量化比特位：从 id / 标签 / 推荐量化名中提取 Q 数字（IQ3 → 3、Q4_K_M → 4、Q8_0 → 8）。
    let quant_bits = parameter_sources
        .iter()
        .chain(std::iter::once(&sample_quant.clone().unwrap_or_default()))
        .filter_map(|text| {
            let upper = text.to_uppercase();
            for token in upper.split(|c: char| !c.is_ascii_alphanumeric()) {
                if token.starts_with('Q') && token.len() > 1 {
                    if let Some(digits) = token[1..].chars().take(2).collect::<String>().parse::<i32>().ok() {
                        if (1..=8).contains(&digits) {
                            return Some(digits);
                        }
                    }
                }
                if let Some(rest) = token.strip_prefix("IQ") {
                    if let Some(digits) = rest.chars().take(1).collect::<String>().parse::<i32>().ok() {
                        if (1..=8).contains(&digits) {
                            return Some(digits);
                        }
                    }
                }
                // 1-bit 与 16-bit/原版：HF 标签可写为 F16/BF16/FP16/FP32/F32。
                if matches!(token, "F16" | "BF16" | "FP16" | "FP32" | "F32") {
                    return Some(16);
                }
            }
            None
        })
        .next()
        .or_else(|| sample_quant.as_deref().and_then(|quant| {
            quant.to_uppercase().chars().skip_while(|c| *c == 'I' || *c == 'Q').next()
                .and_then(|c| c.to_digit(10))
                .map(|digit| digit as i32)
        }));
    Some(HuggingFaceModel {
        id,
        author,
        name,
        downloads: value.get("downloads").and_then(|value| value.as_u64()).unwrap_or(0),
        likes: value.get("likes").and_then(|value| value.as_u64()).unwrap_or(0),
        updated_at: value.get("lastModified").and_then(|value| value.as_str()).unwrap_or("").to_string(),
        tags,
        gguf_count: -1,
        sample_quant: if gated { None } else { sample_quant },
        parameters_b,
        quant_bits,
    })
}

/// 从文本中提取参数量（十亿）：匹配 "7b"、"14b"、"0.5b"、"32b" 等；返回最先出现且 <= 1000B 的值。
fn regex_like_parameter(text: &str) -> Option<f64> {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let mut start: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_digit() || b == b'.' {
            if start.is_none() {
                start = Some(i);
            }
        } else {
            // 'b' 紧跟数字串尾部时视为参数量（"7b" / "0.5b"）；
            // 其余字符一律重置数字起点（"2.5-14b" 应命中 14 而非报错）。
            if b == b'b' {
                if let Some(from) = start {
                    let candidate = &lower[from..i];
                    if let Ok(value) = candidate.parse::<f64>() {
                        if value > 0.0 && value <= 1000.0 {
                            return Some(value);
                        }
                    }
                }
            }
            start = None;
        }
        i += 1;
    }
    None
}

/// 本周 HuggingFace 热门模型（sort=trending）；可选仅 GGUF（filter=gguf）。
#[tauri::command]
async fn hf_trending(app: AppHandle, limit: Option<usize>, gguf_only: Option<bool>, skip: Option<usize>, sort: Option<String>, quants: Option<Vec<i32>>) -> Result<Vec<HuggingFaceModel>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let client = build_net_client(&network)?;
    tauri::async_runtime::spawn_blocking(move || {
        let base = format!("{}/models?sort=trendingScore&direction=-1&expand[]=lastModified", HF_API_BASE);
        let base = if let Some(sort_by) = sort {
            base.replace("sort=trendingScore", &format!("sort={}", sort_by))
        } else {
            base
        };
        fetch_models_filtered(&client, &base, gguf_only.unwrap_or(false), limit.unwrap_or(12), skip, quants)
    })
    .await
    .map_err(|error| format!("获取热门榜单任务中断：{}", error))?
}

/// 搜索 HuggingFace 模型（关键词 / 组织名）；可选仅 GGUF。
#[tauri::command]
async fn hf_search(app: AppHandle, query: String, limit: Option<usize>, gguf_only: Option<bool>, skip: Option<usize>, sort: Option<String>, quants: Option<Vec<i32>>) -> Result<Vec<HuggingFaceModel>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let client = build_net_client(&network)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut url = reqwest::Url::parse(&format!("{}/models", HF_API_BASE)).map_err(|error| format!("构建请求 URL 失败：{}", error))?;
        url.query_pairs_mut()
            .append_pair("search", query.trim())
            .append_pair("sort", sort.as_deref().unwrap_or("trendingScore"))
            .append_pair("expand[]", "lastModified")
            .append_pair("direction", "-1");
        let base = url.as_str().to_string();
        fetch_models_filtered(&client, &base, gguf_only.unwrap_or(false), limit.unwrap_or(30), skip, quants)
    })
    .await
    .map_err(|error| format!("搜索任务中断：{}", error))?
}

/// 列出仓库 main 分支的 .gguf 文件（递归，按文件名排序）。
#[tauri::command]
async fn hf_list_files(app: AppHandle, repo: String) -> Result<Vec<HuggingFaceFile>, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let client = build_net_client(&network)?;
    tauri::async_runtime::spawn_blocking(move || {
        let base = hf_repo_id(&repo);
        let url = format!("{}/models/{}/tree/main?recursive=true&expand=false", HF_API_BASE, base);
        let value = fetch_hf_json(&client, &url)?;
        let items = value.as_array().ok_or("HuggingFace API 返回格式异常")?;
        let mut files: Vec<HuggingFaceFile> = items
            .iter()
            .filter_map(|item| {
                let kind = item.get("type").and_then(|value| value.as_str()).unwrap_or("");
                if kind != "file" {
                    return None;
                }
                let name = item.get("path").and_then(|value| value.as_str())?;
                if !name.to_lowercase().ends_with(".gguf") {
                    return None;
                }
                let size = item.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
                Some(HuggingFaceFile { name: name.to_string(), size_bytes: size })
            })
            .collect();
        files.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(files)
    })
    .await
    .map_err(|error| format!("获取文件列表任务中断：{}", error))?
}

/// 计算目标下载路径并防目录逃逸（仅允许文件名中的普通路径段）。
fn model_download_dest(root: &Path, repo: &str, file: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let repo_dir = root.join(hf_repo_dir_name(repo));
    let mut out = repo_dir.clone();
    for component in Path::new(file).components() {
        match component {
            Component::Normal(segment) => out.push(segment),
            _ => return Err(format!("文件名包含非法路径：{}", file)),
        }
    }
    if !out.starts_with(&repo_dir) {
        return Err("非法下载路径".into());
    }
    Ok(out)
}

/// 模型下载取消标志（与 llama.cpp 更新取消标志相互独立）。
static HF_CANCEL_FLAG: AtomicBool = AtomicBool::new(false);
/// 模型下载暂停标志：置位后下载循环在下一轮退出（保留 .part 断点文件，不删除）。
static HF_PAUSE_FLAG: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDownloadProgress {
    repo: String,
    file: String,
    phase: String,
    percent: u32,
    downloaded: u64,
    total: u64,
    speed_bps: u64,
    message: String,
}

fn emit_model_progress(app: &AppHandle, repo: &str, file: &str, phase: &str, percent: u32, downloaded: u64, total: u64, speed: u64, message: impl Into<String>) {
    let _ = app.emit("model-download-progress", ModelDownloadProgress {
        repo: repo.into(),
        file: file.into(),
        phase: phase.into(),
        percent: percent.min(100),
        downloaded,
        total,
        speed_bps: speed,
        message: message.into(),
    });
}

/// 取消正在进行的模型下载。
#[tauri::command]
fn hf_cancel_download() -> Result<(), String> {
    HF_CANCEL_FLAG.store(true, Ordering::Relaxed);
    HF_PAUSE_FLAG.store(false, Ordering::Relaxed);
    Ok(())
}

/// 暂停全部正在进行的模型下载（保留 .part 断点文件；前端「继续」时重新发起并断点续传）。
#[tauri::command]
fn hf_pause_downloads() -> Result<(), String> {
    HF_PAUSE_FLAG.store(true, Ordering::Relaxed);
    Ok(())
}

/// 删除本地文件（下载管理中「取消任务并删除缓存」用）。
#[tauri::command]
fn remove_local_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Ok(());
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| format!("删除目录失败：{}", error))
    } else {
        fs::remove_file(&target).map_err(|error| format!("删除文件失败：{}", error))
    }
}

/// 在系统资源管理器中定位并选中文件（文件不存在时打开其所在目录）。
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let args = if target.exists() {
            vec!["/select,".to_string(), target.to_string_lossy().to_string()]
        } else if let Some(parent) = target.parent().filter(|dir| dir.exists()) {
            vec![parent.to_string_lossy().to_string()]
        } else {
            return Err(format!("路径不存在：{}", path));
        };
        std::process::Command::new("explorer")
            .args(&args)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| format!("打开资源管理器失败：{}", error))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        return Err("该功能仅支持 Windows".into());
    }
    Ok(())
}

/// 下载 HF 文件：多通道自动兜底（配置代理 → 直连 → 本地探测代理 → hf-mirror 镜像）。
/// 返回 (客户端, 实际 URL, 是否已降级)。
fn download_hf_with_fallback(config_client: &reqwest::blocking::Client, url: &str) -> Result<(reqwest::blocking::Client, String), String> {
    let base_candidates: Vec<(reqwest::blocking::Client, String)> = std::iter::once((config_client.clone(), url.to_string()))
        .chain(std::iter::once((direct_client().clone(), url.to_string())))
        .collect();
    for (candidate, candidate_url) in base_candidates {
        if let Ok(response) = candidate
            .get(&candidate_url)
            .header("user-agent", HF_UA)
            .timeout(std::time::Duration::from_secs(30))
            .send()
        {
            // 只要连接成功（含 4xx 授权类），就返回该通道；由调用者处理状态码
            drop(response);
            return Ok((candidate, candidate_url));
        }
    }
    // 本地探测代理
    if let Some(proxy_url) = probe_local_proxy() {
        if let Ok(proxied) = proxied_client(&proxy_url) {
            if proxied
                .get(url)
                .header("user-agent", HF_UA)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .is_ok()
            {
                return Ok((proxied, url.to_string()));
            }
        }
    }
    // hf-mirror 镜像
    if let Some(mirror) = hf_mirror_url(url) {
        let client = direct_client().clone();
        if client
            .get(&mirror)
            .header("user-agent", HF_UA)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .is_ok()
        {
            return Ok((client, mirror));
        }
    }
    Err("无法访问 HuggingFace（配置代理 / 直连 / 本地代理 / hf-mirror 镜像均失败）".into())
}

/// 下载 HuggingFace 仓库中的指定文件到模型存储目录（流式 + 进度事件 + 断点续传）。
#[tauri::command]
async fn hf_download(app: AppHandle, repo: String, file: String) -> Result<HfDownloadResult, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let root = models_root(&app, &config)?;
    let client = build_net_client(&network)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read as _;
        use std::io::Write as _;
        HF_CANCEL_FLAG.store(false, Ordering::Relaxed);
        let dest = model_download_dest(&root, &repo, &file)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建下载目录失败：{}", error))?;
        }
        // 恢复上次暂停留下的 .part 断点文件（暂停时 dest 被改名 dest.part，先改回以便断点续传）
        let part_path = dest.with_extension("part");
        if !dest.exists() && part_path.exists() {
            let _ = fs::rename(&part_path, &dest);
        }
        let url = format!("{}/{}/resolve/main/{}", HF_DL_BASE, hf_repo_id(&repo), file);
        emit_model_progress(&app, &repo, &file, "download", 0, 0, 0, 0, "开始下载");
        // 多通道兜底：配置代理 → 直连 → 本机代理端口 → hf-mirror 镜像（浏览器常走 TUN / 软路由透明代理）
        let (net_client, effective_url) = download_hf_with_fallback(&client, &url)?;
        let url = effective_url;
        let mut response = net_client
            .get(&url)
            .timeout(std::time::Duration::from_secs(3600))
            .send()
            .map_err(|error| format!("下载失败：{}", error))?;
        if !response.status().is_success() {
            let code = response.status().as_u16();
            if code == 401 || code == 403 {
                return Err("该模型需要授权（gated），无法直接下载".into());
            }
            if code == 404 {
                return Err("文件不存在或仓库未公开（HTTP 404）".into());
            }
            return Err(format!("下载失败：HTTP {}", code));
        }
        let mut full_total: u64 = response.content_length().unwrap_or(0);
        if dest.exists() && full_total > 0 {
            let existing_len = fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
            if existing_len >= full_total {
                emit_model_progress(&app, &repo, &file, "done", 100, existing_len, full_total, 0, "文件已存在");
                return Ok(HfDownloadResult {
                    path: dest.to_string_lossy().to_string(),
                    size_bytes: existing_len,
                });
            }
        }

        // 断点续传：目标已存在则携带 Range 续传；服务器忽略 Range（返回 200）时从头覆盖
        let mut downloaded: u64 = 0;
        if dest.exists() {
            downloaded = fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
        }
        let mut file_handle: fs::File;
        if downloaded > 0 {
            let range = format!("bytes={}-", downloaded);
            let ranged = net_client
                .get(&url)
                .header("range", &range)
                .timeout(std::time::Duration::from_secs(3600))
                .send()
                .map_err(|error| format!("下载失败：{}", error))?;
            if ranged.status().as_u16() == 206 {
                response = ranged;
                file_handle = fs::OpenOptions::new().append(true).create(true).open(&dest).map_err(|error| format!("打开下载文件失败：{}", error))?;
            } else if ranged.status().is_success() {
                response = ranged;
                downloaded = 0;
                if let Some(total) = response.content_length() {
                    full_total = total;
                }
                file_handle = fs::File::create(&dest).map_err(|error| format!("创建下载文件失败：{}", error))?;
            } else {
                return Err(format!("下载失败：HTTP {}", ranged.status()));
            }
        } else {
            file_handle = fs::File::create(&dest).map_err(|error| format!("创建下载文件失败：{}", error))?;
        }

        let mut buffer = [0u8; 128 * 1024];
        let start_ms = now_ms();
        let mut last_emit_ms = start_ms;
        loop {
            if HF_CANCEL_FLAG.load(Ordering::Relaxed) {
                let _ = fs::remove_file(&dest);
                return Err("下载已取消".into());
            }
            if HF_PAUSE_FLAG.load(Ordering::Relaxed) {
                // 暂停：保留 .part 断点文件（前端「继续」时按 Range 续传），清掉暂停标志
                HF_PAUSE_FLAG.store(false, Ordering::Relaxed);
                file_handle.flush().ok();
                drop(file_handle);
                let part = dest.with_extension("part");
                let _ = fs::remove_file(&part);
                let _ = fs::rename(&dest, &part);
                emit_model_progress(&app, &repo, &file, "paused", 0, downloaded, full_total, 0, "已暂停，剩余部分保留在 .part 断点文件");
                return Err("下载已暂停".into());
            }
            let count = response.read(&mut buffer).map_err(|error| format!("下载中断：{}", error))?;
            if count == 0 {
                break;
            }
            file_handle.write_all(&buffer[..count]).map_err(|error| format!("写入下载文件失败：{}", error))?;
            downloaded += count as u64;
            let elapsed = now_ms().saturating_sub(start_ms);
            if now_ms().saturating_sub(last_emit_ms) >= 200 {
                let speed = if elapsed > 0 { downloaded * 1000 / elapsed } else { 0 };
                let percent = if full_total > 0 { ((downloaded as f64 / full_total as f64) * 100.0) as u32 } else { 0 };
                emit_model_progress(&app, &repo, &file, "download", percent, downloaded, full_total, speed, format!("{downloaded}/{full_total}"));
                last_emit_ms = now_ms();
            }
        }
        file_handle.flush().map_err(|error| error.to_string())?;
        emit_model_progress(&app, &repo, &file, "done", 100, downloaded, full_total, 0, "下载完成");
        Ok(HfDownloadResult {
            path: dest.to_string_lossy().to_string(),
            size_bytes: downloaded,
        })
    })
    .await
    .map_err(|error| format!("下载任务中断：{}", error))?
}


/// 从任意直链 URL 下载文件到模型存储目录（流式 + 进度事件）。
#[tauri::command]
async fn hf_download_url(app: AppHandle, url: String) -> Result<HfDownloadResult, String> {
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let root = models_root(&app, &config)?;
    let client = build_net_client(&network)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read as _;
        use std::io::Write as _;
        HF_CANCEL_FLAG.store(false, Ordering::Relaxed);
        let raw_name = url.rsplit('/').next().filter(|name| !name.trim().is_empty()).unwrap_or("model.gguf").trim().to_string();
        let file_name: String = raw_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
            .collect();
        let file_name = if file_name.to_lowercase().ends_with(".gguf") { file_name } else { format!("{}.gguf", file_name) };
        let dest = root.join(&file_name);
        // 恢复上次暂停留下的 .part 断点文件
        let part_path = dest.with_extension("part");
        if !dest.exists() && part_path.exists() {
            let _ = fs::rename(&part_path, &dest);
        }
        let repo_id = "direct-url";
        emit_model_progress(&app, repo_id, &file_name, "download", 0, 0, 0, 0, "开始下载");
        // 多通道兜底：配置代理 → 直连 → 本机代理端口 → hf-mirror 镜像
        let (net_client, effective_url) = download_hf_with_fallback(&client, &url)?;
        let url = effective_url;
        let mut response = net_client
            .get(&url)
            .timeout(std::time::Duration::from_secs(3600))
            .send()
            .map_err(|error| format!("下载失败：{}", error))?;
        if !response.status().is_success() {
            return Err(format!("下载失败：HTTP {}", response.status()));
        }
        let full_total: u64 = response.content_length().unwrap_or(0);
        let mut file_handle = fs::File::create(&dest).map_err(|error| format!("创建下载文件失败：{}", error))?;
        let mut downloaded: u64 = 0;
        let mut buffer = [0u8; 128 * 1024];
        let start_ms = now_ms();
        let mut last_emit_ms = start_ms;
        loop {
            if HF_CANCEL_FLAG.load(Ordering::Relaxed) {
                let _ = fs::remove_file(&dest);
                return Err("下载已取消".into());
            }
            if HF_PAUSE_FLAG.load(Ordering::Relaxed) {
                HF_PAUSE_FLAG.store(false, Ordering::Relaxed);
                file_handle.flush().ok();
                drop(file_handle);
                let part = dest.with_extension("part");
                let _ = fs::remove_file(&part);
                let _ = fs::rename(&dest, &part);
                emit_model_progress(&app, repo_id, &file_name, "paused", 0, downloaded, full_total, 0, "已暂停，剩余部分保留在 .part 断点文件");
                return Err("下载已暂停".into());
            }
            let count = response.read(&mut buffer).map_err(|error| format!("下载中断：{}", error))?;
            if count == 0 {
                break;
            }
            file_handle.write_all(&buffer[..count]).map_err(|error| format!("写入下载文件失败：{}", error))?;
            downloaded += count as u64;
            let elapsed = now_ms().saturating_sub(start_ms);
            if now_ms().saturating_sub(last_emit_ms) >= 200 {
                let speed = if elapsed > 0 { downloaded * 1000 / elapsed } else { 0 };
                let percent = if full_total > 0 { ((downloaded as f64 / full_total as f64) * 100.0) as u32 } else { 0 };
                emit_model_progress(&app, repo_id, &file_name, "download", percent, downloaded, full_total, speed, format!("{downloaded}/{full_total}"));
                last_emit_ms = now_ms();
            }
        }
        file_handle.flush().map_err(|error| error.to_string())?;
        emit_model_progress(&app, repo_id, &file_name, "done", 100, downloaded, full_total, 0, "下载完成");
        Ok(HfDownloadResult {
            path: dest.to_string_lossy().to_string(),
            size_bytes: downloaded,
        })
    })
    .await
    .map_err(|error| format!("下载任务中断：{}", error))?
}

/// 查询模型存储目录的可用空间（Windows 走 GetDiskFreeSpaceExW；其他平台返回 0）。
fn free_disk_space(path: &Path) -> (u64, u64) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            let mut free_avail: u64 = 0;
            let mut total: u64 = 0;
            let rc = GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_avail, &mut total, std::ptr::null_mut());
            if rc == 0 { (0, 0) } else { (total, free_avail) }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        (0, 0)
    }
}

/// 读取当前模型存储目录与剩余空间（缺省目录首次访问自动创建）。
#[tauri::command]
fn get_models_dir(app: AppHandle) -> Result<DiskUsage, String> {
    let config = read_config(&app)?;
    let root = models_root(&app, &config)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let (total, free) = free_disk_space(&root);
    Ok(DiskUsage {
        path: root.to_string_lossy().to_string(),
        total_bytes: total,
        free_bytes: free,
    })
}

/// 选择模型存储目录：校验可写（写入探针文件），不直接持久化（由前端保存配置）。
#[tauri::command]
fn pick_models_dir(app: AppHandle) -> Result<String, String> {
    let Some(file_path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(String::new());
    };
    let Some(folder) = file_path.as_path() else {
        return Ok(String::new());
    };
    let probe = folder.join(".cookllm_write_test");
    let writable = fs::write(&probe, b"ok").is_ok();
    if !writable {
        return Err("所选目录不可写，请更换目录".into());
    }
    let _ = fs::remove_file(&probe);
    Ok(folder.to_string_lossy().to_string())
}

/* ==================== 阶段一：硬件探测（CUDA / Vulkan / CPU 推荐） ==================== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareSuggestion {
    recommended_backend: String,
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
fn detect_hardware() -> HardwareSuggestion {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkConfig {
    /// "system"（跟随系统代理）/ "manual"（手动 HTTP/SOCKS5）/ "direct"（直连）
    #[serde(default = "default_proxy_mode")]
    proxy_mode: String,
    #[serde(default)]
    proxy_url: String,
}

fn default_proxy_mode() -> String {
    "system".into()
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            proxy_mode: default_proxy_mode(),
            proxy_url: String::new(),
        }
    }
}

/// 按配置构建 reqwest 客户端：manual 注入 Proxy::all，system 走系统代理（默认行为），direct 直连并忽略代理。
fn build_net_client(network: &NetworkConfig) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
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
fn get_system_proxy() -> Option<String> {
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
struct ProxyTestResult {
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
async fn test_proxy_connection(
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

/* ==================== 阶段三：llama.cpp 获取、解压与原子覆盖 ==================== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlamaCppAsset {
    backend: String,
    /// CUDA 主版本（如 "12" / "13"）；非 cuda 后端为空字符串
    cuda_version: String,
    /// CUDA 完整版本（如 "12.4"）；非 cuda 或无法识别时为空字符串
    cuda_full_version: String,
    file_name: String,
    url: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlamaCppRelease {
    tag: String,
    assets: Vec<LlamaCppAsset>,
    /// 对应的 CUDA 运行时包（cudart-...zip），仅 cuda 后端时有值
    cudart_assets: Vec<LlamaCppAsset>,
    match_backend: String,
    match_asset: Option<LlamaCppAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlamaCppLocalStatus {
    install_dir: String,
    local_version: Option<String>,
    local_backend: String,
    server_available: bool,
    server_path: Option<String>,
}

/// llama.cpp 官方仓库（2024 起迁移到 ggml-org，旧 ggerganov 已 301 重定向）。
const LLAMA_CPP_REPO: &str = "ggml-org/llama.cpp";
fn llama_api_base() -> String {
    format!("https://api.github.com/repos/{}", LLAMA_CPP_REPO)
}

fn llama_exe_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}

/// llama.cpp 安装目录：与当前 llama-server 可执行文件同级（更新目录 = 可执行目录）；
/// 首次安装（无可执行文件）时使用用户配置目录，其次应用数据目录下的 llamacpp。

/// 模型存储根目录：优先用户配置的自定义目录，其次应用数据目录下的 models（首次访问自动创建）。
fn models_root(app: &AppHandle, config: &AppConfig) -> Result<PathBuf, String> {
    if let Some(dir) = config.models_dir.as_deref().filter(|path| !path.trim().is_empty()) {
        return Ok(PathBuf::from(dir.trim()));
    }
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let path = directory.join("models");
    fs::create_dir_all(&path).map_err(|error| format!("创建模型目录失败：{}", error))?;
    Ok(path)
}

fn llamacpp_root(app: &AppHandle, config: &AppConfig) -> Result<PathBuf, String> {
    let server_path = config.server_path.trim().to_string();
    if !server_path.is_empty() {
        let exe = PathBuf::from(&server_path);
        if exe.file_name().is_some() {
            if let Some(parent) = exe.parent().filter(|dir| !dir.as_os_str().is_empty()) {
                return Ok(parent.to_path_buf());
            }
        }
    }
    if let Some(dir) = config.llamacpp_dir.as_deref().filter(|path| !path.trim().is_empty()) {
        return Ok(PathBuf::from(dir.trim()));
    }
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(directory.join("llamacpp"))
}

/// 从文本中提取 bXXXX 构建号（如 "llama-b5678-bin-win-cuda..." -> "b5678"）。
fn extract_build_number(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'b' && index + 1 < bytes.len() && bytes[index + 1].is_ascii_digit() {
            let mut end = index + 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            return Some(text[index..end].to_string());
        }
    }
    None
}

fn local_llamacpp_version(bin_dir: &Path) -> Option<String> {
    let version_file = bin_dir.join("version.txt");
    if let Ok(text) = fs::read_to_string(&version_file) {
        let version = text.trim().to_string();
        if !version.is_empty() {
            return Some(version);
        }
    }
    bin_dir.file_name().and_then(|name| name.to_str()).and_then(extract_build_number)
}

/// 读取本地安装状态（纯本地逻辑，不访问网络）。
#[tauri::command]
fn get_llamacpp_status(app: AppHandle) -> Result<LlamaCppLocalStatus, String> {
    let config = read_config(&app)?;
    let install_dir = llamacpp_root(&app, &config)?;
    let server_path = if install_dir.exists() {
        find_executable(&install_dir, llama_exe_name(), 0)
    } else {
        None
    };
    let mut local_backend = "cpu".into();
    let mut local_version = None;
    if let Some(exe) = server_path.as_ref() {
        let bin_dir = exe.parent().unwrap_or(&install_dir).to_path_buf();
        local_version = local_llamacpp_version(&bin_dir);
        // 优先读安装时写入的 backend.txt，回退按路径名推断
        if let Ok(text) = fs::read_to_string(bin_dir.join("backend.txt")) {
            let value = text.trim().to_lowercase();
            if value == "cuda" || value == "vulkan" || value == "cpu" {
                local_backend = value;
            }
        } else {
            let path_text = bin_dir.to_string_lossy().to_lowercase();
            local_backend = if path_text.contains("cuda") { "cuda" } else if path_text.contains("vulkan") { "vulkan" } else { "cpu" }.into();
        }
    }
    Ok(LlamaCppLocalStatus {
        install_dir: install_dir.to_string_lossy().to_string(),
        local_version,
        local_backend,
        server_available: server_path.is_some(),
        server_path: server_path.map(|path| path.to_string_lossy().to_string()),
    })
}

fn fetch_github_release(client: &reqwest::blocking::Client, url: &str) -> Result<serde_json::Value, String> {
    let response = client
        .get(url)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
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
fn fetch_github_release_with_fallback(config_client: &reqwest::blocking::Client, url: &str) -> Result<serde_json::Value, String> {
    let mut errors: Vec<String> = Vec::new();
    match fetch_github_release(config_client, url) {
        Ok(value) => return Ok(value),
        Err(error) => errors.push(format!("配置代理通道：{}", error)),
    }
    match fetch_github_release(direct_client(), url) {
        Ok(value) => return Ok(value),
        Err(error) => errors.push(format!("直连：{}", error)),
    }
    if let Some(proxy_url) = probe_local_proxy() {
        match proxied_client(&proxy_url) {
            Ok(proxied) => match fetch_github_release(&proxied, url) {
                Ok(value) => return Ok(value),
                Err(error) => errors.push(format!("本地代理 {}：{}", proxy_url, error)),
            },
            Err(error) => errors.push(format!("初始化本地代理 {} 失败：{}", proxy_url, error)),
        }
    }
    Err(format!("GitHub API 连接失败（{}）。请在「设置 → 网络与代理」选择手动代理（Clash 端口 7897 / V2rayN 10809）后重试", errors.join("；")))
}

/// 解析 Windows x64 的 llama.cpp 资产（llama-bXXXX-bin-win-{cuda|vulkan|avx2}.zip）。
fn parse_win_assets(value: &serde_json::Value) -> Vec<LlamaCppAsset> {
    let mut out = Vec::new();
    let Some(assets) = value.get("assets").and_then(|value| value.as_array()) else {
        return out;
    };
    for item in assets {
        let name = item.get("name").and_then(|value| value.as_str()).unwrap_or_default();
        let lower = name.to_lowercase();
        // 仅匹配官方 llama-bXXXX-bin-win-*.zip（排除 cudart- 纯运行时包 / arm64 / 其他平台）
        if !lower.starts_with("llama-") || !lower.contains("-bin-win-") || !lower.ends_with(".zip") {
            continue;
        }
        if lower.contains("arm64") || lower.contains("-arm64") {
            continue;
        }
        let url = item.get("browser_download_url").and_then(|value| value.as_str()).unwrap_or_default().to_string();
        if url.is_empty() {
            continue;
        }
        let size = item.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
        let backend = if lower.contains("win-cuda") { "cuda" } else if lower.contains("win-vulkan") { "vulkan" } else if lower.contains("win-cpu") || lower.contains("win-avx2") { "cpu" } else { continue };
        // 提取 CUDA 主版本 / 完整版本：如 win-cuda-12.4-x64 -> "12" / "12.4"
        let mut cuda_version = String::new();
        if backend == "cuda" {
            if let Some(pos) = lower.find("cuda-") {
                let rest = &lower[pos + 5..];
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !digits.is_empty() {
                    cuda_version = digits;
                }
            }
            if cuda_version.is_empty() {
                if let Some(pos) = lower.find("cu") {
                    let rest = &lower[pos + 2..];
                    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if !digits.is_empty() {
                        cuda_version = digits;
                    }
                }
            }
        }
        let cuda_full_version = if backend == "cuda" { extract_cuda_full_version(&lower) } else { String::new() };
        out.push(LlamaCppAsset { backend: backend.into(), cuda_version: cuda_version.clone(), cuda_full_version: cuda_full_version.clone(), file_name: name.to_string(), url, size });
    }
    out
}

/// 从资产名提取 CUDA 完整版本（如 "cuda-12.4-x64" -> "12.4"）。
fn extract_cuda_full_version(lower: &str) -> String {
    let Some(pos) = lower.find("cuda-") else { return String::new() };
    let rest = &lower[pos + 5..];
    let mut out = String::new();
    for c in rest.chars() {
        if c.is_ascii_digit() {
            out.push(c);
        } else if c == '.' && !out.is_empty() && !out.contains('.') {
            out.push(c);
        } else {
            break;
        }
    }
    while out.ends_with('.') {
        out.pop();
    }
    out
}

/// 解析 CUDA 运行时包资产（cudart-llama-bin-win-cuda-X.Y-x64.zip，不含 llama-server，仅含 cudart dll）。
fn parse_cudart_assets(value: &serde_json::Value) -> Vec<LlamaCppAsset> {
    let mut out = Vec::new();
    let Some(assets) = value.get("assets").and_then(|value| value.as_array()) else {
        return out;
    };
    for item in assets {
        let name = item.get("name").and_then(|value| value.as_str()).unwrap_or_default();
        let lower = name.to_lowercase();
        if !lower.starts_with("cudart-") || !lower.contains("-win-cuda-") || !lower.ends_with(".zip") {
            continue;
        }
        if lower.contains("arm64") {
            continue;
        }
        let url = item.get("browser_download_url").and_then(|value| value.as_str()).unwrap_or_default().to_string();
        if url.is_empty() {
            continue;
        }
        let size = item.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
        let cuda_full_version = extract_cuda_full_version(&lower);
        let cuda_version = cuda_full_version.split('.').next().unwrap_or("").to_string();
        out.push(LlamaCppAsset { backend: "cuda".into(), cuda_version, cuda_full_version, file_name: name.to_string(), url, size });
    }
    out
}

/// 根据主构建的 CUDA 完整版本匹配运行时包：优先精确版本，其次同主版本，最后任意 cuda。
fn pick_cudart_asset<'a>(assets: &'a [LlamaCppAsset], cuda_full: &str) -> Option<&'a LlamaCppAsset> {
    if cuda_full.is_empty() {
        return assets.iter().find(|asset| asset.backend == "cuda");
    }
    let major = cuda_full.split('.').next().unwrap_or("");
    assets
        .iter()
        .find(|asset| asset.cuda_full_version == cuda_full)
        .or_else(|| assets.iter().find(|asset| asset.cuda_version == major))
        .or_else(|| assets.iter().find(|asset| asset.backend == "cuda"))
}

/// 最新 release 无 Windows 资产时回退扫描最近 releases，找到第一个带资产者。
fn fetch_latest_release_with_assets(client: &reqwest::blocking::Client) -> Result<(String, serde_json::Value), String> {
    let latest_url = format!("{}/releases/latest", llama_api_base());
    let first = fetch_github_release_with_fallback(client, &latest_url)?;
    let tag = first.get("tag_name").and_then(|value| value.as_str()).unwrap_or_default().to_string();
    if !parse_win_assets(&first).is_empty() {
        return Ok((tag, first));
    }
    let list_url = format!("{}/releases?per_page=10", llama_api_base());
    let list = fetch_github_release_with_fallback(client, &list_url)?;
    if let Some(items) = list.as_array() {
        for item in items {
            if let Some(tag_value) = item.get("tag_name").and_then(|value| value.as_str()) {
                if !parse_win_assets(item).is_empty() {
                    return Ok((tag_value.to_string(), item.clone()));
                }
            }
        }
    }
    Err("llama.cpp 最近发布中未找到 Windows 构建资产（可能网络异常或官方暂未发布）".into())
}

fn pick_asset<'a>(assets: &'a [LlamaCppAsset], backend: &'a str, cuda_version: &'a str) -> Option<&'a LlamaCppAsset> {
    match backend {
        "cuda" => {
            // 指定了 CUDA 主版本则精确匹配；否则优先 CUDA 12，其次 13，最后任意 cuda
            let version = if cuda_version == "auto" || cuda_version.is_empty() { "12" } else { cuda_version };
            assets
                .iter()
                .find(|asset| asset.backend == "cuda" && asset.cuda_version == version)
                .or_else(|| {
                    if cuda_version == "auto" || cuda_version.is_empty() {
                        assets.iter().find(|asset| asset.backend == "cuda" && asset.cuda_version == "13")
                    } else {
                        None
                    }
                })
                .or_else(|| assets.iter().find(|asset| asset.backend == "cuda"))
        }
        "vulkan" => assets
            .iter()
            .find(|asset| asset.backend == "vulkan" && asset.file_name.to_lowercase().contains("x64"))
            .or_else(|| assets.iter().find(|asset| asset.backend == "vulkan")),
        _ => assets
            .iter()
            .find(|asset| {
                let lower = asset.file_name.to_lowercase();
                asset.backend == "cpu" && (lower.contains("cpu-x64") || lower.contains("avx2"))
            })
            .or_else(|| assets.iter().find(|asset| asset.backend == "cpu")),
    }
}

/// 检查远程最新版本并匹配当前硬件后端对应的 Windows 资产（内部阻塞实现）。
fn check_llamacpp_update_impl(app: &AppHandle, backend: Option<String>, cuda_version: Option<String>) -> Result<LlamaCppRelease, String> {
    let config = read_config(app)?;
    let network = config.network.clone().unwrap_or_default();
    let client = build_net_client(&network)?;
    let (tag, value) = fetch_latest_release_with_assets(&client)?;
    if tag.trim().is_empty() {
        return Err("未获取到远程版本号".into());
    }
    let assets = parse_win_assets(&value);
    let cudart_assets = parse_cudart_assets(&value);
    let requested = backend.unwrap_or_else(|| detect_hardware().recommended_backend);
    let matched = pick_asset(&assets, &requested, cuda_version.as_deref().unwrap_or("auto")).cloned();
    Ok(LlamaCppRelease { tag, assets, cudart_assets, match_backend: requested, match_asset: matched })
}

/// 检查远程最新版本并匹配当前硬件后端对应的 Windows 资产。
#[tauri::command]
async fn check_llamacpp_update(app: AppHandle, backend: Option<String>, cuda_version: Option<String>) -> Result<LlamaCppRelease, String> {
    tauri::async_runtime::spawn_blocking(move || check_llamacpp_update_impl(&app, backend, cuda_version))
        .await
        .map_err(|error| format!("检查更新任务中断：{}", error))?
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

fn emit_download_progress(app: &AppHandle, phase: &str, percent: u32, downloaded: u64, total: u64, speed_bps: u64, message: impl Into<String>) {
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
fn stream_download(client: &reqwest::blocking::Client, url: &str, dest: &Path, app: &AppHandle) -> Result<u64, String> {
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
    loop {
        if UPDATE_CANCEL_FLAG.load(Ordering::Relaxed) {
            let _ = fs::remove_file(dest);
            return Err("更新已取消".into());
        }
        let count = response.read(&mut buffer).map_err(|error| format!("下载中断：{}", error))?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count]).map_err(|error| format!("写入下载文件失败：{}", error))?;
        downloaded += count as u64;
        let elapsed = now_ms().saturating_sub(start_ms);
        if now_ms().saturating_sub(last_emit_ms) >= 200 {
            let speed = if elapsed > 0 { downloaded * 1000 / elapsed } else { 0 };
            let percent = if total > 0 { ((downloaded as f64 / total as f64) * 100.0) as u32 } else { 0 };
            emit_download_progress(app, "download", percent, downloaded, total, speed, format!("{downloaded}/{total}"));
            last_emit_ms = now_ms();
        }
    }
    file.flush().map_err(|error| error.to_string())?;
    emit_download_progress(app, "download", 100, downloaded, total, 0, "下载完成");
    Ok(downloaded)
}

/// 流式下载多通道兜底：配置代理 → 直连 → 本机探测代理端口；失败时汇总各通道原因。
fn stream_download_with_fallback(client: &reqwest::blocking::Client, url: &str, dest: &Path, app: &AppHandle) -> Result<u64, String> {
    let mut errors: Vec<String> = Vec::new();
    match stream_download(client, url, dest, app) {
        Ok(size) => return Ok(size),
        Err(error) => errors.push(format!("配置代理通道：{}", error)),
    }
    emit_download_progress(app, "download", 0, 0, 0, 0, "代理通道失败，切换直连重试");
    match stream_download(direct_client(), url, dest, app) {
        Ok(size) => return Ok(size),
        Err(error) => errors.push(format!("直连：{}", error)),
    }
    if let Some(proxy_url) = probe_local_proxy() {
        match proxied_client(&proxy_url) {
            Ok(proxied) => {
                emit_download_progress(app, "download", 0, 0, 0, 0, format!("切换本地代理 {} 重试", proxy_url));
                match stream_download(&proxied, url, dest, app) {
                    Ok(size) => return Ok(size),
                    Err(error) => errors.push(format!("本地代理 {}：{}", proxy_url, error)),
                }
            }
            Err(error) => errors.push(format!("初始化本地代理 {} 失败：{}", proxy_url, error)),
        }
    }
    Err(format!("下载失败（{}）", errors.join("；")))
}

/// 防止 zip 条目逃逸解压目录（拒绝绝对路径、.. 等）。
fn safe_zip_path(base: &Path, name: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let mut out = base.to_path_buf();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(segment) => out.push(segment),
            _ => return Err(format!("压缩包内含非法路径：{}", name)),
        }
    }
    Ok(out)
}

/// 解压 zip 到目标目录，并逐条发送进度。
fn extract_zip_archive(zip_path: &Path, dest_dir: &Path, app: &AppHandle) -> Result<(), String> {
    emit_download_progress(app, "extract", 0, 0, 0, 0, "开始解压");
    let file = fs::File::open(zip_path).map_err(|error| format!("打开压缩包失败：{}", error))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("读取压缩包失败：{}", error))?;
    let total_entries = archive.len();
    for index in 0..total_entries {
        if UPDATE_CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err("更新已取消".into());
        }
        let mut entry = archive.by_index(index).map_err(|error| format!("读取压缩条目失败：{}", error))?;
        let name = entry.name().to_string();
        let out_path = safe_zip_path(dest_dir, &name)?;
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|error| format!("创建目录失败：{}", error))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{}", error))?;
        }
        let mut out = fs::File::create(&out_path).map_err(|error| format!("创建解压文件失败：{}", error))?;
        std::io::copy(&mut entry, &mut out).map_err(|error| format!("解压写入失败：{}", error))?;
        let percent = if total_entries > 0 { ((index + 1) as f64 / total_entries as f64 * 100.0) as u32 } else { 0 };
        emit_download_progress(app, "extract", percent, index as u64 + 1, total_entries as u64, 0, name);
    }
    emit_download_progress(app, "extract", 100, total_entries as u64, total_entries as u64, 0, "解压完成");
    Ok(())
}

/// 原子替换 llamacpp 目录：旧目录先改名备份，新目录 rename 到位，成功后删除备份。
fn install_bin_dir(bin_dir: &Path, target: &Path, version: &str, backend: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let backup = target.with_extension(format!("old-{}", now_ms()));
    if target.exists() {
        fs::rename(target, &backup).map_err(|error| format!("备份旧安装目录失败：{}", error))?;
    }
    if let Err(error) = fs::rename(bin_dir, target) {
        if backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!("原子替换安装目录失败（可能 llama-server 仍在运行占用文件）：{}", error));
    }
    // 保留旧目录中目标目录缺失的 DLL（如 cudart 等 CUDA 运行时），best effort
    if backup.exists() {
        if let Ok(entries) = fs::read_dir(&backup) {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_dll = path.extension().map(|ext| ext.eq_ignore_ascii_case("dll")).unwrap_or(false);
                if !is_dll || !path.is_file() {
                    continue;
                }
                let name = path.file_name().unwrap_or_default();
                let dest = target.join(name);
                if !dest.exists() {
                    let _ = fs::copy(&path, &dest);
                }
            }
        }
        let _ = fs::remove_dir_all(&backup);
    }
    if !version.trim().is_empty() {
        let _ = fs::write(target.join("version.txt"), format!("{}
", version.trim()));
    }
    let _ = fs::write(target.join("backend.txt"), format!("{}
", backend));
    Ok(())
}

/// 更新任务取消标志：前端点击“取消”后置位，下载/解压循环检查并中断。
static UPDATE_CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

/// 取消正在进行的 llama.cpp 更新（下载 / 解压阶段）。
#[tauri::command]
fn cancel_llamacpp_update() -> Result<(), String> {
    UPDATE_CANCEL_FLAG.store(true, Ordering::Relaxed);
    Ok(())
}

/// 一键更新 / 重新安装 llama.cpp（内部阻塞实现）。
fn download_llamacpp_impl(app: AppHandle, backend: String, cuda_version: Option<String>, asset_url: Option<String>, asset_name: Option<String>, tag: Option<String>) -> Result<String, String> {
    // 0) 重置取消标志，开启新一轮任务
    UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
    // 1) 确认主程序（托管中的 llama-server）未在运行
    {
        let state = app.state::<ProcessState>();
        let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏".to_string())?;
        if let Some(managed) = guard.as_mut() {
            let still_running = managed.child.try_wait().map(|wait| wait.is_none()).unwrap_or(true);
            if still_running {
                return Err("llama-server 正在运行，请先在顶部停止服务后再更新引擎".into());
            }
        }
    }
    let config = read_config(&app)?;
    let network = config.network.clone().unwrap_or_default();
    let target = llamacpp_root(&app, &config)?;

    // 2) 解析下载资产（未指定则按后端自动匹配）
    let (download_url, file_name, version, cuda_full, cudart_url, cudart_name) = match (asset_url, asset_name) {
        (Some(url), Some(name)) => (url, name, tag.unwrap_or_default(), String::new(), String::new(), String::new()),
        _ => {
            let release = check_llamacpp_update_impl(&app, Some(backend.clone()), cuda_version.clone())?;
            let asset = release.match_asset.ok_or_else(|| format!("未找到 {backend} 后端的 Windows 构建资产，请检查网络或更换后端"))?;
            // cuda 后端需要配套的 cudart 运行时包
            let (cudart_url, cudart_name) = if backend == "cuda" {
                let picked = pick_cudart_asset(&release.cudart_assets, &asset.cuda_full_version);
                picked.map(|item| (item.url.clone(), item.file_name.clone())).unwrap_or_default()
            } else {
                (String::new(), String::new())
            };
            (asset.url, asset.file_name, release.tag, asset.cuda_full_version.clone(), cudart_url, cudart_name)
        }
    };

    // 3) 临时目录：与目标安装目录同卷（避免跨盘 rename 失败，保证安装阶段原子重命名可执行）
    let target_parent = target.parent().map(Path::to_path_buf).unwrap_or_else(|| target.clone());
    let temp_root = target_parent.join(".llamacpp_tmp");
    fs::create_dir_all(&temp_root).map_err(|error| format!("创建临时目录失败：{}", error))?;
    let zip_path = temp_root.join(&file_name);
    let extract_dir = temp_root.join("extract");
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&extract_dir).map_err(|error| error.to_string())?;

    // 4) 下载 + 解压（取消 / 失败时清理临时文件）
    let client = build_net_client(&network)?;
    if let Err(error) = stream_download_with_fallback(&client, &download_url, &zip_path, &app) {
        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_dir_all(&temp_root);
        UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
        return Err(error);
    }
    if let Err(error) = extract_zip_archive(&zip_path, &extract_dir, &app) {
        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_dir_all(&temp_root);
        UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
        return Err(error);
    }

    // 4.5) cuda 后端：需要配套的 cudart 运行时包。
    // 若安装目录已存在同主版本的 CUDA 运行时 dll（如 cudart64_12.dll）则跳过下载；
    // 否则下载并缓存到应用数据目录 llamacpp_cache：缓存存在则直接解压复用；
    // 缓存损坏时自动删除并回退重新下载，避免同版本重复走网络。
    if backend == "cuda" && !cudart_url.is_empty() && !cudart_name.is_empty() {
        let cuda_major = cuda_full.split('.').next().unwrap_or("").to_string();
        if !cuda_major.is_empty() && has_cuda_runtime_dll(&target, &cuda_major) {
            emit_download_progress(&app, "install", 0, 0, 0, 0, format!("已安装 CUDA {} 运行时，跳过下载", cuda_full));
        } else {
            let cache_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("llamacpp_cache");
            fs::create_dir_all(&cache_dir).map_err(|e| format!("创建 CUDA 缓存目录失败：{}", e))?;
            let cached_zip = cache_dir.join(&cudart_name);
            let mut need_download = false;
            if cached_zip.exists() {
                emit_download_progress(&app, "extract", 0, 0, 0, 0, format!("使用本地缓存的 CUDA 运行时 {}", &cudart_name));
                if let Err(_error) = extract_zip_archive(&cached_zip, &extract_dir, &app) {
                    // 缓存损坏：删除后重新下载
                    let _ = fs::remove_file(&cached_zip);
                    need_download = true;
                }
            } else {
                need_download = true;
            }
            if need_download {
                emit_download_progress(&app, "download", 0, 0, 0, 0, format!("正在下载 CUDA 运行时 {}", &cudart_name));
                if let Err(error) = stream_download_with_fallback(&client, &cudart_url, &cached_zip, &app) {
                    let _ = fs::remove_file(&cached_zip);
                    let _ = fs::remove_dir_all(&temp_root);
                    UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
                    return Err(format!("下载 CUDA 运行时失败：{}", error));
                }
                if let Err(error) = extract_zip_archive(&cached_zip, &extract_dir, &app) {
                    let _ = fs::remove_file(&cached_zip);
                    let _ = fs::remove_dir_all(&temp_root);
                    UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
                    return Err(format!("解压 CUDA 运行时失败：{}", error));
                }
            }
        }
    }

    // 5) 定位解压后的 llama-server 可执行文件
    let located = match find_executable(&extract_dir, llama_exe_name(), 0) {
        Some(path) => path,
        None => {
            let _ = fs::remove_dir_all(&temp_root);
            UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
            return Err("压缩包中未找到 llama-server（可能是 cudart 运行时包或其他平台构建），已清理临时文件".into());
        }
    };
    let bin_dir = located.parent().ok_or("解压内容异常".to_string())?.to_path_buf();
    // cuda 后端：把 cudart 包内的 dll 拍平到与 llama-server 同级，确保启动时能找到 CUDA 运行时
    if backend == "cuda" {
        flatten_dlls(&extract_dir, &bin_dir);
    }

    // 6) 原子替换安装目录
    emit_download_progress(&app, "install", 0, 0, 0, 0, "正在覆盖安装");
    if let Err(error) = install_bin_dir(&bin_dir, &target, &version, &backend) {
        let _ = fs::remove_dir_all(&temp_root);
        UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
        return Err(error);
    }
    if backend == "cuda" && !cuda_full.is_empty() {
        let _ = fs::write(target.join("cuda_version.txt"), format!("{}
", cuda_full));
    }

    // 7) 更新配置：serverPath 指向新引擎，并持久化安装目录
    let new_server_path = find_executable(&target, llama_exe_name(), 0)
        .ok_or("安装后未找到 llama-server.exe".to_string())?;
    let mut updated = read_config(&app)?;
    updated.server_path = new_server_path.to_string_lossy().to_string();
    updated.llamacpp_dir = Some(target.to_string_lossy().to_string());
    save_config(app.clone(), updated)?;

    // 8) 清理临时的下载与解压文件
    let _ = fs::remove_file(&zip_path);
    let _ = fs::remove_dir_all(&temp_root);
    UPDATE_CANCEL_FLAG.store(false, Ordering::Relaxed);
    emit_download_progress(&app, "done", 100, 0, 0, 0, "更新完成");
    Ok(new_server_path.to_string_lossy().to_string())
}

/// 一键更新 / 重新安装 llama.cpp：检查服务未运行 -> 解析资产 -> 下载 -> 解压 -> 原子替换 -> 更新配置。
#[tauri::command]
async fn download_llamacpp(app: AppHandle, backend: String, cuda_version: Option<String>, asset_url: Option<String>, asset_name: Option<String>, tag: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || download_llamacpp_impl(app, backend, cuda_version, asset_url, asset_name, tag))
        .await
        .map_err(|error| format!("更新任务中断：{}", error))?
}



#[cfg(test)]
mod tests {
    use super::find_executable;
    use std::fs;

    fn make_tree(base: &std::path::Path) {
        fs::create_dir_all(base.join("build").join("bin")).unwrap();
        fs::write(base.join("build").join("bin").join("llama-server.exe"), "dummy").unwrap();
        fs::create_dir_all(base.join("empty")).unwrap();
    }

    #[test]
    fn find_executable_recurses_subdirectories() {
        let base = std::env::temp_dir().join("cookllm_find_test");
        let _ = fs::remove_dir_all(&base);
        make_tree(&base);
        let found = find_executable(&base, "llama-server.exe", 0).expect("should find exe");
        assert!(found == base.join("build").join("bin").join("llama-server.exe"), "found: {found:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn find_executable_prefers_current_directory() {
        let base = std::env::temp_dir().join("cookllm_find_test_current");
        let _ = fs::remove_dir_all(&base);
        make_tree(&base);
        fs::write(base.join("llama-server.exe"), "dummy-current").unwrap();
        let found = find_executable(&base, "llama-server.exe", 0).expect("should find exe");
        assert!(found == base.join("llama-server.exe"), "found: {found:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn find_executable_returns_none_when_missing() {
        let base = std::env::temp_dir().join("cookllm_find_test_none");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        assert!(find_executable(&base, "llama-server.exe", 0).is_none());
        let _ = fs::remove_dir_all(&base);
    }
}

pub fn run() {
    let app_start_ms = now_ms();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessState::default())
        .manage(TimingState(Mutex::new(StartupTiming {
            app_start_ms,
            before_builder_ms: now_ms(),
            after_build_ms: 0,
            page_load_ms: None,
            splash_shown_ms: None,
            react_mounted_ms: None,
            reported: false,
        })))
        .invoke_handler(tauri::generate_handler![hf_trending, hf_search, hf_list_files, hf_download, hf_download_url, hf_cancel_download, hf_pause_downloads, remove_local_file, reveal_in_folder, get_models_dir, pick_models_dir, load_config, save_config, start_server, stop_server, get_server_status, get_gpu_stats, get_gpu_info, hardware_info, detect_hardware, test_proxy_connection, get_system_proxy, get_llamacpp_status, check_llamacpp_update, download_llamacpp, cancel_llamacpp_update, pick_files, pick_folder, pick_server_dir, expand_paths, open_url, open_config_dir, clipboard_write, set_window_theme, show_main_window, report_startup_timing])
        .setup(|app| match configure_main_window(app) {
            Ok(()) => Ok(()),
            Err(error) => Err(error.into()),
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building CookLLM");
    if let Ok(mut timing) = app.state::<TimingState>().0.lock() {
        timing.after_build_ms = now_ms();
    }

    // 兜底：8 秒内前端未上报启动计时（例如加载失败）则打印已知时间线，同时确保窗口可见
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            if let Some(window) = handle.get_webview_window("main") {
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                }
            }
            let timing_snapshot: StartupTiming = handle.state::<TimingState>().0.lock()
                .map(|t| t.clone())
                .unwrap_or_default();
            if !timing_snapshot.reported {
                log_timing(&timing_snapshot);
                eprintln!("[StartupTiming] 前端 8 秒内未上报启动计时（可能页面加载失败）");
            }
        });
    }

    app.run(|app_handle, event| {
        match event {
            // 窗口就绪后主动抢焦点：WebView2 在窗口未激活时首帧可能延迟（启动黑屏的诱因之一）
            tauri::RunEvent::Ready => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                // 关闭窗口（X 按钮）退出时，同样用 taskkill /T /F 杀掉 llama-server，
                // 保证"关软件 = 关服务"，避免它留在后台继续占显存。
                let state = app_handle.state::<ProcessState>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut managed) = guard.take() {
                        kill_managed_child(&mut managed);
                    }
                };
            }
            _ => {}
        }
    });
}



