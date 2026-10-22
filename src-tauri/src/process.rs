use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{read_config, AppConfig};
use crate::server_args::{build_server_launch, RequestLogTail};
use crate::{
    get_tray_state, now_ms, set_tray_state, update_tray_status, TrayServerState,
    TRAY_PULSE_GENERATION,
};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerStatus {
    running: bool,
    pid: Option<u32>,
    pub(crate) port: Option<u16>,
    model_id: Option<String>,
    model_name: Option<String>,
    profile_id: Option<String>,
    profile_name: Option<String>,
    started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine_backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LogPayload {
    stream: String,
    line: String,
    timestamp: u64,
}

pub(crate) struct ManagedProcess {
    pub(crate) child: Child,
    pub(crate) status: ServerStatus,
    /// NInfer --request-log-jsonl 增量 tail 读取游标（None = 未开启结构化请求日志）
    request_log: Option<RequestLogTail>,
}

/// 本进程托管的 llama-server；None 表示未运行。
#[derive(Default)]
pub(crate) struct ProcessState(pub(crate) Mutex<Option<ManagedProcess>>);

pub(crate) fn emit_log(app: &AppHandle, stream: &str, line: impl Into<String>) {
    let _ = app.emit("llama-log", LogPayload { stream: stream.into(), line: line.into(), timestamp: now_ms() });
}

/// 服务生命周期广播（事件名 server-lifecycle）：托盘或主界面任一侧发生
/// 启动（starting）/ 主动停止（stopped）/ 启动失败与意外退出（failed）时通知前端，
/// 使主界面与托盘操作严格同步：启动过渡动画、异常标记清除、主动停止绝不误判为「服务异常」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerLifecyclePayload {
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<ServerStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_server_lifecycle(app: &AppHandle, phase: &str, status: Option<ServerStatus>, error: Option<String>) {
    let _ = app.emit("server-lifecycle", ServerLifecyclePayload { phase: phase.to_string(), status, error });
}

fn stream_reader<R: std::io::Read + Send + 'static>(app: AppHandle, stream: &'static str, reader: R) {
    std::thread::spawn(move || {
        for line in BufReader::with_capacity(65536, reader).lines().map_while(Result::ok) {
            emit_log(&app, stream, line);
        }
    });
}

/// 强制终止托管子进程（llama-server），三处出口共用：退出时 / 停止服务 / 重启服务。
/// - Windows：taskkill /T /F（与"停止服务"按钮一致，最可靠，连带整棵进程树），
///   此前退出路径用 in-process Child::kill 无法可靠杀掉 llama-server，导致它留在后台占显存。
/// - 非 Windows：Child::kill。
///
/// 之后带 5 秒超时轮询 wait：确保进程被回收，同时绝不无限阻塞调用线程（退出流程同样安全）。
pub(crate) fn kill_managed_child(managed: &mut ManagedProcess) {
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

#[cfg(windows)]
fn get_process_path(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == -1isize as HANDLE {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let success = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if success != 0 && size > 0 {
            String::from_utf16(&buf[..size as usize]).ok()
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn get_process_path(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(dest) = fs::read_link(format!("/proc/{}/exe", pid)) {
            return Some(dest.to_string_lossy().to_string());
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrphanProcessItem {
    pid: u32,
    name: String,
    path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrphanServerInfo {
    has_orphan: bool,
    pids: Vec<u32>,
    processes: Vec<OrphanProcessItem>,
}

/// 收集配置中已登记的所有 server 可执行程序文件名（包括默认路径与多分支）
fn collect_configured_exe_names(config: Option<&AppConfig>) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(cfg) = config {
        let trimmed = cfg.server_path.trim();
        if !trimmed.is_empty() {
            if let Some(n) = Path::new(trimmed).file_name().and_then(|n| n.to_str()) {
                names.push(n.to_string());
            }
        }
        for eng in &cfg.engines {
            let p = eng.path.trim();
            if !p.is_empty() {
                if let Some(n) = Path::new(p).file_name().and_then(|n| n.to_str()) {
                    let s = n.to_string();
                    if !names.contains(&s) {
                        names.push(s);
                    }
                }
            }
        }
    }
    names
}

/// 探测系统中未被 CookLLM 当前生命周期托管的 server 进程（包括 llama-server 与分支自定义名称，如 llama-kvmem-server.exe）
fn find_orphan_servers(managed_pid: Option<u32>, custom_exe_names: &[String]) -> Vec<OrphanProcessItem> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut queries = vec!["IMAGENAME eq llama*".to_string()];
        for custom in custom_exe_names {
            let custom_lower = custom.to_lowercase();
            if !custom_lower.starts_with("llama") && custom_lower.ends_with(".exe") {
                let q = format!("IMAGENAME eq {}", custom);
                if !queries.contains(&q) {
                    queries.push(q);
                }
            }
        }

        let mut items = Vec::new();
        let mut seen_pids = Vec::new();

        for query in queries {
            let output = Command::new("tasklist")
                .args(["/FI", &query, "/FO", "CSV", "/NH"])
                .creation_flags(0x08000000)
                .output();
            let Ok(output) = output else { continue; };
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with("INFO:") || line.starts_with("信息:") {
                    continue;
                }
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 2 {
                    let name = parts[0].trim_matches('"').to_string();
                    let name_lower = name.to_lowercase();
                    let is_match = name_lower == "llama-server.exe"
                        || (name_lower.starts_with("llama") && name_lower.contains("server"))
                        || custom_exe_names.iter().any(|c| c.eq_ignore_ascii_case(&name));

                    if is_match {
                        if let Ok(pid) = parts[1].trim_matches('"').parse::<u32>() {
                            if managed_pid != Some(pid) && !seen_pids.contains(&pid) {
                                seen_pids.push(pid);
                                let path = get_process_path(pid);
                                items.push(OrphanProcessItem { pid, name, path });
                            }
                        }
                    }
                }
            }
        }
        items
    }
    #[cfg(not(windows))]
    {
        let mut patterns = vec!["llama-server".to_string(), "llama.*server".to_string()];
        for custom in custom_exe_names {
            if !patterns.iter().any(|p| p == custom) {
                patterns.push(custom.to_string());
            }
        }

        let mut items = Vec::new();
        let mut seen_pids = Vec::new();

        for pattern in patterns {
            let output = Command::new("pgrep")
                .args(["-l", "-f", &pattern])
                .output();
            let Ok(output) = output else { continue; };
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if !parts.is_empty() {
                    if let Ok(pid) = parts[0].parse::<u32>() {
                        if managed_pid != Some(pid) && !seen_pids.contains(&pid) {
                            seen_pids.push(pid);
                            let name = parts.get(1).unwrap_or(&"llama-server").to_string();
                            let path = get_process_path(pid);
                            items.push(OrphanProcessItem { pid, name, path });
                        }
                    }
                }
            }
        }
        items
    }
}

/// 检查是否存在后台残留的 server 进程
#[tauri::command]
pub(crate) fn check_orphan_server(app: AppHandle, state: State<ProcessState>) -> Result<OrphanServerInfo, String> {
    let managed_pid = {
        let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
        if let Some(managed) = guard.as_mut() {
            match managed.child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    None
                }
                Ok(None) => Some(managed.child.id()),
                Err(_) => None,
            }
        } else {
            None
        }
    };

    let config = read_config(&app).ok();
    let custom_exe_names = collect_configured_exe_names(config.as_ref());
    let processes = find_orphan_servers(managed_pid, &custom_exe_names);
    let pids = processes.iter().map(|p| p.pid).collect();
    Ok(OrphanServerInfo {
        has_orphan: !processes.is_empty(),
        pids,
        processes,
    })
}

/// 终止指定的（或全部未托管的）后台残留 server 进程
#[tauri::command]
pub(crate) fn kill_orphan_server(app: AppHandle, state: State<ProcessState>, pids: Option<Vec<u32>>) -> Result<usize, String> {
    let managed_pid = {
        let guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
        guard.as_ref().map(|m| m.child.id())
    };

    let target_pids: Vec<u32> = match pids {
        Some(list) if !list.is_empty() => list
            .into_iter()
            .filter(|&pid| Some(pid) != managed_pid)
            .collect(),
        _ => {
            let config = read_config(&app).ok();
            let custom_exe_names = collect_configured_exe_names(config.as_ref());
            find_orphan_servers(managed_pid, &custom_exe_names).into_iter().map(|p| p.pid).collect()
        }
    };

    let count = target_pids.len();
    if count == 0 {
        return Ok(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for pid in &target_pids {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output();
        }
    }

    #[cfg(not(windows))]
    {
        for pid in &target_pids {
            let _ = Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(count)
}

/// start/stop 专用串行化锁：kill 旧进程最长 5 秒的等待只占用这把锁，
/// 不再长时间持有 ProcessState 锁，避免重启/停止期间状态轮询全部卡住。
static PROCESS_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub(crate) fn start_server(app: AppHandle, state: State<ProcessState>, model_id: String, profile_id: String) -> Result<ServerStatus, String> {
    start_server_internal(&app, &state, &model_id, &profile_id)
}

pub(crate) fn start_server_internal(app: &AppHandle, state: &ProcessState, model_id: &str, profile_id: &str) -> Result<ServerStatus, String> {
    match start_server_core(app, state, model_id, profile_id) {
        Ok(status) => {
            // 广播 starting：无论从主界面还是托盘启动，前端都立即进入启动过渡动画并同步状态
            emit_server_lifecycle(app, "starting", Some(status.clone()), None);
            Ok(status)
        }
        Err(err) => {
            let model_name = read_config(app).ok().and_then(|c| {
                c.models.iter().find(|m| m.id == model_id).map(|m| {
                    m.display_name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(&m.name).to_string()
                })
            }).unwrap_or_else(|| model_id.to_string());
            set_tray_state(TrayServerState::Failed {
                model_name,
                error: err.clone(),
            });
            update_tray_status(app, None);
            // 广播 failed：主界面立即结束过渡动画并标记服务异常（托盘启动失败同样可见）
            emit_server_lifecycle(app, "failed", None, Some(err.clone()));
            Err(err)
        }
    }
}

fn start_server_core(app: &AppHandle, state: &ProcessState, model_id: &str, profile_id: &str) -> Result<ServerStatus, String> {
    let plan = build_server_launch(app, model_id, profile_id)?;

    // 进程生命周期串行化：kill 旧进程的等待在专用锁内进行，ProcessState 锁只做短暂存取
    let lifecycle = PROCESS_LIFECYCLE_LOCK.lock().map_err(|_| "进程生命周期锁已损坏")?;
    let previous = {
        let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
        let prev = guard.take();
        // 旧服务切换终止同样属于主动停止：在 take() 生效前广播 stopped，
        // 避免前端 2s 轮询在 kill 等待窗口内捕捉到 running=false 误判为「服务异常」
        if prev.is_some() {
            emit_server_lifecycle(app, "stopped", Some(ServerStatus::default()), None);
        }
        prev
    };
    if let Some(mut running) = previous {
        // 先递增代数，使旧服务的呼吸灯与端口探测线程立即失效退出，绝不误判旧进程终止为异常退出
        TRAY_PULSE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        kill_managed_child(&mut running);
    }

    let mut command = plan.command;
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    emit_log(&app, "system", format!("launch: {} · {} [engine: {}]", plan.model_name, plan.profile_name, plan.engine_name));
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
        port: Some(plan.port),
        model_id: Some(plan.model_id),
        model_name: Some(plan.model_name.clone()),
        profile_id: Some(plan.profile_id),
        profile_name: Some(plan.profile_name),
        started_at: Some(now_ms()),
        engine_name: Some(plan.engine_name),
        engine_backend: plan.engine_backend,
        engine_type: Some(plan.engine_type),
    };
    let port = plan.port;
    {
        let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
        *guard = Some(ManagedProcess { child, status: status.clone(), request_log: plan.request_log });
    }
    drop(lifecycle);

    set_tray_state(TrayServerState::Starting {
        model_name: plan.model_name.clone(),
        port,
    });
    update_tray_status(app, None);

    let app_probe = app.clone();
    let probe_model_name = plan.model_name.clone();
    let probe_port = port;
    let probe_pid = pid;
    let probe_gen = TRAY_PULSE_GENERATION.load(std::sync::atomic::Ordering::SeqCst);

    std::thread::spawn(move || {
        use std::net::{SocketAddr, TcpStream};
        use std::time::{Duration, Instant};

        let start_time = Instant::now();
        let timeout = Duration::from_secs(120);
        let addr: Result<SocketAddr, _> = format!("127.0.0.1:{}", probe_port).parse();
        let addr = match addr {
            Ok(a) => a,
            Err(_) => return,
        };

        loop {
            // 若代数已变更或托盘状态不再是本轮匹配的 Starting（如用户已主动停止或切换模型），直接静默退出
            if TRAY_PULSE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != probe_gen {
                return;
            }
            match get_tray_state() {
                TrayServerState::Starting { ref model_name, port } if model_name == &probe_model_name && port == probe_port => {},
                _ => return,
            }

            let is_alive = {
                let state = app_probe.try_state::<ProcessState>();
                if let Some(state) = state {
                    let mut guard = state.0.lock().ok();
                    if let Some(guard) = guard.as_mut() {
                        if let Some(managed) = guard.as_mut() {
                            if managed.status.pid == Some(probe_pid) {
                                match managed.child.try_wait() {
                                    Ok(None) => true,
                                    _ => {
                                        **guard = None;
                                        false
                                    }
                                }
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            };

            if !is_alive {
                if TRAY_PULSE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == probe_gen {
                    if let TrayServerState::Starting { ref model_name, port } = get_tray_state() {
                        if model_name == &probe_model_name && port == probe_port {
                            set_tray_state(TrayServerState::Failed {
                                model_name: probe_model_name,
                                error: "服务启动后意外退出，请查看日志".to_string(),
                            });
                            update_tray_status(&app_probe, None);
                            // 广播 failed：前端立即结束启动过渡动画并标记服务异常（无需等 2s 轮询）
                            emit_server_lifecycle(&app_probe, "failed", None, Some("服务启动后意外退出，请查看日志".to_string()));
                        }
                    }
                }
                return;
            }

            if let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
                drop(stream);
                if TRAY_PULSE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == probe_gen {
                    if let TrayServerState::Starting { ref model_name, port } = get_tray_state() {
                        if model_name == &probe_model_name && port == probe_port {
                            set_tray_state(TrayServerState::Running {
                                model_name: probe_model_name.clone(),
                                port: probe_port,
                            });
                            update_tray_status(&app_probe, None);
                            emit_log(&app_probe, "system", format!("服务已就绪 (http://127.0.0.1:{})", probe_port));
                        }
                    }
                }
                return;
            }

            if start_time.elapsed() > timeout {
                if TRAY_PULSE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == probe_gen {
                    if let TrayServerState::Starting { ref model_name, port } = get_tray_state() {
                        if model_name == &probe_model_name && port == probe_port {
                            set_tray_state(TrayServerState::Failed {
                                model_name: probe_model_name,
                                error: "服务启动超时 (端口未就绪)".to_string(),
                            });
                            update_tray_status(&app_probe, None);
                        }
                    }
                }
                return;
            }

            std::thread::sleep(Duration::from_millis(350));
        }
    });

    Ok(status)
}

#[tauri::command]
pub(crate) fn stop_server(app: AppHandle, state: State<ProcessState>) -> Result<ServerStatus, String> {
    stop_server_internal(&app, &state)
}

pub(crate) fn stop_server_internal(app: &AppHandle, state: &ProcessState) -> Result<ServerStatus, String> {
    let lifecycle = PROCESS_LIFECYCLE_LOCK.lock().map_err(|_| "进程生命周期锁已损坏")?;

    // 1. 立即重置托盘状态为 Stopped 并递增代数，使正在运行的呼吸灯与端口探测线程瞬间失效退出，
    //    从时序上彻底杜绝将“主动停止”误判为“意外退出/启动失败”
    set_tray_state(TrayServerState::Stopped);
    TRAY_PULSE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    update_tray_status(app, None);
    // 2. 广播 stopped（先于 take() 生效：保证事件先于任何轮询观察到 running=false），
    //    前端据此把本次退出标记为主动停止，绝不误判为「服务异常」
    emit_server_lifecycle(app, "stopped", Some(ServerStatus::default()), None);

    let managed = { state.0.lock().map_err(|_| "进程状态锁已损坏")?.take() };
    if let Some(mut managed) = managed {
        kill_managed_child(&mut managed);
        emit_log(app, "system", "llama-server 已停止");
    } else {
        emit_log(app, "system", "llama-server 未在运行");
    }
    drop(lifecycle);

    // 杀完子进程后再次确保托盘处于已停止状态
    set_tray_state(TrayServerState::Stopped);
    update_tray_status(app, None);
    Ok(ServerStatus::default())
}

#[tauri::command]
pub(crate) fn get_server_status(state: State<ProcessState>) -> Result<ServerStatus, String> {
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

/// 增量读取 NInfer --request-log-jsonl 新写入的记录（server_start / request_start / request_done）。
/// 前端 2s 轮询调用：只返回自上次调用以来追加的完整行；轮转（文件变小）时游标归零重读，
/// 由前端按 server_instance_id + request_id 去重合并。llama.cpp / 未开启日志时返回空数组。
#[tauri::command]
pub(crate) fn read_ninfer_request_log(state: State<ProcessState>) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.0.lock().map_err(|_| "进程状态锁已损坏")?;
    let Some(tail) = guard.as_mut().and_then(|m| m.request_log.as_mut()) else {
        return Ok(Vec::new());
    };
    let size = match fs::metadata(&tail.path) {
        Ok(meta) => meta.len(),
        Err(_) => return Ok(Vec::new()),
    };
    if size < tail.offset {
        // 日志轮转：活动文件被截断重写，游标归零
        tail.offset = 0;
    }
    if size <= tail.offset {
        return Ok(Vec::new());
    }
    let want = ((size - tail.offset) as usize).min(4 * 1024 * 1024);
    let buf = {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = fs::File::open(&tail.path).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(tail.offset)).map_err(|error| error.to_string())?;
        let mut buf = vec![0u8; want];
        file.read_exact(&mut buf).map_err(|error| error.to_string())?;
        buf
    };
    // 只消费到最后一个完整换行为止：半行残片留给下次调用拼接
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(pos) => tail.offset + (pos as u64) + 1,
        None => return Ok(Vec::new()),
    };
    let text = String::from_utf8_lossy(&buf[..(consumed - tail.offset) as usize]).to_string();
    tail.offset = consumed;
    let mut records = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            // 高频吞吐聚合记录（5s 周期）不透传：前端从 /stats 实时拿，避免噪声
            let event = value.get("event").and_then(|v| v.as_str()).unwrap_or("");
            if event == "throughput" {
                continue;
            }
            records.push(value);
        }
    }
    Ok(records)
}

