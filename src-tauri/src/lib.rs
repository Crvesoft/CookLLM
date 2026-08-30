use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
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
    preferred_model_id: Option<String>,
    preferred_profile_id: Option<String>,
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
                port: 8080,
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
            }],
            theme: None,
            preferred_model_id: None,
            preferred_profile_id: None,
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

    let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
    if let Some(mut running) = guard.take() {
        kill_managed_child(&mut running);
    }

    let mut command = Command::new(&config.server_path);
    command
        .arg("-m").arg(&model.path)
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
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
        .invoke_handler(tauri::generate_handler![load_config, save_config, start_server, stop_server, get_server_status, get_gpu_stats, pick_files, pick_folder, expand_paths, open_url, set_window_theme, show_main_window, report_startup_timing]);

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



