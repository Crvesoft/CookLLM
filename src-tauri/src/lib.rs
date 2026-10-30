use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

mod app_update;
mod config;
mod downloads;
mod engines;
mod process;
mod server_args;
mod system;

use config::{read_config, AppConfig};
use downloads::{reveal_in_folder, DownloadRegistry};
use process::{emit_log, kill_managed_child, start_server_internal, stop_server_internal, ProcessState};

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

#[derive(Default)]
struct TimingState(Mutex<StartupTiming>);

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
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

/// 录制快捷键或打开快捷键弹窗时临时暂停全局热键，避免冲突与按键拦截
#[tauri::command]
fn set_shortcuts_recording_mode(app: AppHandle, recording: bool) -> Result<(), String> {
    if recording {
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
    } else if let Ok(config) = read_config(&app) {
        sync_global_shortcuts(&app, &config);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TrayServerState {
    Stopped,
    Starting { model_name: String, port: u16 },
    Running { model_name: String, port: u16 },
    Failed { model_name: String, error: String },
}

static CURRENT_TRAY_STATE: OnceLock<Mutex<TrayServerState>> = OnceLock::new();

pub(crate) fn get_tray_state() -> TrayServerState {
    CURRENT_TRAY_STATE
        .get_or_init(|| Mutex::new(TrayServerState::Stopped))
        .lock()
        .map(|g| g.clone())
        .unwrap_or(TrayServerState::Stopped)
}

pub(crate) fn set_tray_state(new_state: TrayServerState) {
    if let Ok(mut g) = CURRENT_TRAY_STATE.get_or_init(|| Mutex::new(TrayServerState::Stopped)).lock() {
        *g = new_state;
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum TrayLightColor {
    Green,
    Yellow,
    Red,
}

pub(crate) static TRAY_PULSE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn update_tray_status(app: &AppHandle, _hint_model: Option<&str>) {
    let tray_state = get_tray_state();
    if let Some(tray) = app.tray_by_id("main-tray") {
        let tooltip = match &tray_state {
            TrayServerState::Starting { model_name, port } => {
                format!("CookLLM · 启动中: {} (http://127.0.0.1:{})", model_name, port)
            }
            TrayServerState::Running { model_name, port } => {
                format!("CookLLM · 运行中: {} (http://127.0.0.1:{})", model_name, port)
            }
            TrayServerState::Failed { model_name, error } => {
                format!("CookLLM · 启动失败: {} ({})", model_name, error)
            }
            TrayServerState::Stopped => "CookLLM · 本地大模型管理器".to_string(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
        if let Ok(menu) = build_tray_menu(app, &tray_state) {
            let _ = tray.set_menu(Some(menu));
        }

        match &tray_state {
            TrayServerState::Starting { .. } => {
                start_tray_pulse_animation(app, TrayLightColor::Yellow);
            }
            TrayServerState::Running { .. } => {
                start_tray_pulse_animation(app, TrayLightColor::Green);
            }
            TrayServerState::Failed { .. } => {
                TRAY_PULSE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if let Some(base_icon) = app.default_window_icon() {
                    let red_icon = create_tray_status_icon(base_icon, 0, TrayLightColor::Red);
                    let _ = tray.set_icon(Some(red_icon));
                }
            }
            TrayServerState::Stopped => {
                TRAY_PULSE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if let Some(default_icon) = app.default_window_icon() {
                    let _ = tray.set_icon(Some(default_icon.clone()));
                }
            }
        }
    }
}

/// 仅根据当前状态刷新托盘菜单项（模型列表更新时调用），不重启或打断正在运行的呼吸灯
pub(crate) fn refresh_tray_menu(app: &AppHandle) {
    let tray_state = get_tray_state();
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_tray_menu(app, &tray_state) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// 启动托盘图标右下角呼吸灯动画（按状态切换颜色：启动中琥珀黄，运行中翠绿）
fn start_tray_pulse_animation(app: &AppHandle, color: TrayLightColor) {
    let new_gen = TRAY_PULSE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let frames: Vec<tauri::image::Image<'static>> = match app.default_window_icon() {
        Some(icon) => (0..4).map(|phase| create_tray_status_icon(icon, phase, color)).collect(),
        None => return,
    };

    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut phase = 0;
        loop {
            if TRAY_PULSE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != new_gen {
                break;
            }

            // 当前状态必须是 Starting 或 Running，若已被置为 Stopped 或 Failed 则立即退出循环
            match get_tray_state() {
                TrayServerState::Starting { .. } | TrayServerState::Running { .. } => {},
                _ => break,
            }

            // 运行时二次校验，确保子进程存活
            let is_alive = {
                let state = app_handle.try_state::<ProcessState>();
                if let Some(state) = state {
                    let mut guard = state.0.lock().ok();
                    if let Some(guard) = guard.as_mut() {
                        if let Some(managed) = guard.as_mut() {
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
            };

            if !is_alive {
                if TRAY_PULSE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == new_gen {
                    let cur_state = get_tray_state();
                    match cur_state {
                        TrayServerState::Starting { model_name, .. } => {
                            set_tray_state(TrayServerState::Failed {
                                model_name,
                                error: "服务启动中意外退出，请查看日志".to_string(),
                            });
                            update_tray_status(&app_handle, None);
                        }
                        TrayServerState::Running { model_name, .. } => {
                            set_tray_state(TrayServerState::Failed {
                                model_name,
                                error: "服务异常退出，请查看日志".to_string(),
                            });
                            update_tray_status(&app_handle, None);
                        }
                        _ => {}
                    }
                }
                break;
            }

            if let Some(tray) = app_handle.tray_by_id("main-tray") {
                let _ = tray.set_icon(Some(frames[phase % frames.len()].clone()));
            }

            phase = (phase + 1) % frames.len();
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

/// 基于原始应用图标在右下角像素级合成抗锯齿高光呼吸状态灯（支持黄/绿/红）
fn create_tray_status_icon(base_icon: &tauri::image::Image, phase: usize, color: TrayLightColor) -> tauri::image::Image<'static> {
    let width = base_icon.width();
    let height = base_icon.height();
    let mut rgba = base_icon.rgba().to_vec();

    if width < 8 || height < 8 {
        return tauri::image::Image::new_owned(rgba, width, height);
    }

    let w_f = width as f32;
    let h_f = height as f32;

    // 状态点圆心位于右下角
    let base_r = (w_f * 0.17).max(3.0);
    let margin = (w_f * 0.06).max(1.5);
    let cx = w_f - base_r - margin;
    let cy = h_f - base_r - margin;

    // 4 阶段呼吸光晕节奏：0: 柔暗 -> 1: 渐亮 -> 2: 满亮 -> 3: 渐暗
    let breathe_factor = match color {
        TrayLightColor::Red => 0.0,
        _ => match phase % 4 {
            0 => 0.25,
            1 => 0.65,
            2 => 1.00,
            _ => 0.65,
        },
    };

    let border_r = base_r + (w_f * 0.04).max(1.0);
    let halo_r = if color == TrayLightColor::Red {
        base_r * 1.25
    } else {
        base_r * (1.18 + 0.38 * breathe_factor)
    };

    let min_x = ((cx - halo_r - 2.0).floor().max(0.0)) as u32;
    let max_x = ((cx + halo_r + 2.0).ceil().min(w_f - 1.0)) as u32;
    let min_y = ((cy - halo_r - 2.0).floor().max(0.0)) as u32;
    let max_y = ((cy + halo_r + 2.0).ceil().min(h_f - 1.0)) as u32;

    let (main_rgb, halo_rgb) = match color {
        TrayLightColor::Green => ((34, 197, 94), (34, 197, 94)),
        TrayLightColor::Yellow => ((234, 179, 8), (245, 158, 11)),
        TrayLightColor::Red => ((239, 68, 68), (220, 38, 38)),
    };

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let dx = px - cx;
            let dy = py - cy;
            let dist = (dx * dx + dy * dy).sqrt();

            let idx = ((y * width + x) * 4) as usize;
            if idx + 3 >= rgba.len() {
                continue;
            }

            // 1. 发光外晕 (Halo)
            if dist <= halo_r && dist > border_r {
                let t = (dist - border_r) / (halo_r - border_r);
                let halo_alpha = if color == TrayLightColor::Red {
                    (1.0 - t).powi(2) * 0.40
                } else {
                    (1.0 - t).powi(2) * (0.30 + 0.50 * breathe_factor)
                };
                blend_pixel(&mut rgba[idx..idx + 4], halo_rgb.0, halo_rgb.1, halo_rgb.2, halo_alpha);
            }
            // 2. 深色外边框 (Border) 确保对比度
            else if dist <= border_r && dist > base_r {
                let t = (dist - base_r) / (border_r - base_r);
                let border_alpha = 0.85 * (1.0 - t * 0.2);
                blend_pixel(&mut rgba[idx..idx + 4], 15, 23, 42, border_alpha);
            }
            // 3. 核心指示灯点 (Core)
            else if dist <= base_r {
                let hx = dx + base_r * 0.25;
                let hy = dy + base_r * 0.25;
                let h_dist = (hx * hx + hy * hy).sqrt();

                let (r, g, b) = if h_dist < base_r * 0.45 {
                    let hl = 1.0 - (h_dist / (base_r * 0.45));
                    match color {
                        TrayLightColor::Green => {
                            let r = (46.0 + 180.0 * hl * (0.6 + 0.4 * breathe_factor)).min(255.0) as u8;
                            let g = (204.0 + 51.0 * hl).min(255.0) as u8;
                            let b = (113.0 + 142.0 * hl * (0.6 + 0.4 * breathe_factor)).min(255.0) as u8;
                            (r, g, b)
                        }
                        TrayLightColor::Yellow => {
                            let r = 255;
                            let g = (210.0 + 45.0 * hl).min(255.0) as u8;
                            let b = (100.0 + 155.0 * hl).min(255.0) as u8;
                            (r, g, b)
                        }
                        TrayLightColor::Red => {
                            let r = (245.0 + 10.0 * hl).min(255.0) as u8;
                            let g = (80.0 + 140.0 * hl).min(255.0) as u8;
                            let b = (80.0 + 140.0 * hl).min(255.0) as u8;
                            (r, g, b)
                        }
                    }
                } else {
                    match color {
                        TrayLightColor::Green => {
                            let base_green = (197.0 + 35.0 * breathe_factor).min(255.0) as u8;
                            (34, base_green, 94)
                        }
                        TrayLightColor::Yellow => {
                            let base_yellow = (179.0 + 35.0 * breathe_factor).min(214.0) as u8;
                            (234, base_yellow, 8)
                        }
                        TrayLightColor::Red => (main_rgb.0, main_rgb.1, main_rgb.2),
                    }
                };
                blend_pixel(&mut rgba[idx..idx + 4], r, g, b, 1.0);
            }
        }
    }

    tauri::image::Image::new_owned(rgba, width, height)
}

fn blend_pixel(dst: &mut [u8], src_r: u8, src_g: u8, src_b: u8, src_alpha: f32) {
    if src_alpha <= 0.0 {
        return;
    }
    let sa = src_alpha.min(1.0);
    let da = (dst[3] as f32) / 255.0;
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 0.0 {
        return;
    }

    let dr = dst[0] as f32;
    let dg = dst[1] as f32;
    let db = dst[2] as f32;

    let sr = src_r as f32;
    let sg = src_g as f32;
    let sb = src_b as f32;

    let out_r = (sr * sa + dr * da * (1.0 - sa)) / out_a;
    let out_g = (sg * sa + dg * da * (1.0 - sa)) / out_a;
    let out_b = (sb * sa + db * da * (1.0 - sa)) / out_a;

    dst[0] = out_r.round().clamp(0.0, 255.0) as u8;
    dst[1] = out_g.round().clamp(0.0, 255.0) as u8;
    dst[2] = out_b.round().clamp(0.0, 255.0) as u8;
    dst[3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    path: String,
    size_bytes: u64,
}

/// GGUF 文件头里能稳定读到的模型信息。读失败时字段留空，由前端继续用文件名兜底；
/// 容量字段（层数 / KV 结构 / 权重体积）供「智能推荐」估算显存，读不到时为 0。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GgufMeta {
    architecture: String,
    parameters: String,
    quantization: String,
    block_count: u32,
    attention_layer_count: u32,
    head_count: u32,
    head_count_kv: u32,
    head_dim: u32,
    context_length: u32,
    weights_bytes: u64,
}

fn gguf_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_matches('\0').trim().to_string()
}

/// 把 GGUF 参数量格式化成与文件名解析一致的展示（32.8B / 8.0B / 512M）。
fn format_parameter_count(count: f64) -> String {
    if !count.is_finite() || count <= 0.0 {
        return String::new();
    }
    if count >= 1_000_000_000.0 {
        format!("{:.1}B", count / 1_000_000_000.0)
    } else if count >= 1_000_000.0 {
        format!("{:.0}M", count / 1_000_000.0)
    } else if count >= 1_000.0 {
        format!("{:.0}K", count / 1_000.0)
    } else {
        format!("{:.0}", count)
    }
}

fn gguf_type_name(value: u32) -> Option<&'static str> {
    Some(match value {
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
        _ => return None,
    })
}

/// 读取 GGUF 头部元数据：general.architecture、*.block_count、*.expert_count 与首个张量量化。
/// 只顺序扫描键值，不把整个模型读进内存；遇到不认识的版本或损坏头即返回空结果。
fn read_gguf_meta(path: &str) -> GgufMeta {
    let empty = GgufMeta {
        architecture: String::new(),
        parameters: String::new(),
        quantization: String::new(),
        block_count: 0,
        attention_layer_count: 0,
        head_count: 0,
        head_count_kv: 0,
        head_dim: 0,
        context_length: 0,
        weights_bytes: 0,
    };
    // 词表 / merges 数组有几十万个小字符串，必须走缓冲读取并整段跳过，否则逐条读会卡几十秒
    let mut file = match fs::File::open(path) {
        Ok(file) => std::io::BufReader::with_capacity(256 * 1024, file),
        Err(_) => return empty,
    };
    use std::io::Read;
    let mut header = [0u8; 24];
    if file.read_exact(&mut header).is_err() {
        return empty;
    }
    if &header[0..4] != b"GGUF" {
        return empty;
    }
    let version = u32::from_le_bytes(header[4..8].try_into().unwrap_or([0; 4]));
    if version < 2 {
        return empty;
    }
    let tensor_count = u64::from_le_bytes(header[8..16].try_into().unwrap_or([0; 8]));
    let kv_count = u64::from_le_bytes(header[16..24].try_into().unwrap_or([0; 8]));
    if tensor_count > 1_000_000 || kv_count > 100_000 {
        return empty;
    }

    let mut architecture = String::new();
    let mut explicit_params: f64 = 0.0;
    let mut block_count: u32 = 0;
    let mut full_attention_interval: u32 = 0;
    let mut kv_array_len: u64 = 0;
    let mut kv_array_nonzero: u32 = 0;
    let mut head_count: u32 = 0;
    let mut head_count_kv: u32 = 0;
    let mut embedding_length: u32 = 0;
    let mut key_length: u32 = 0;
    let mut context_length: u32 = 0;
    let mut ok = true;

    fn read_exact(file: &mut impl Read, len: usize) -> Option<Vec<u8>> {
        if len > 64 * 1024 * 1024 {
            return None;
        }
        let mut buf = vec![0u8; len];
        file.read_exact(&mut buf).ok()?;
        Some(buf)
    }
    fn skip_bytes(file: &mut impl Read, len: usize) -> Option<()> {
        if len > 64 * 1024 * 1024 {
            return None;
        }
        let copied = std::io::copy(&mut file.by_ref().take(len as u64), &mut std::io::sink()).ok()?;
        if copied == len as u64 { Some(()) } else { None }
    }
    fn read_u32(file: &mut impl Read) -> Option<u32> {
        read_exact(file, 4).map(|buf| u32::from_le_bytes(buf.try_into().unwrap_or([0; 4])))
    }
    fn read_u64(file: &mut impl Read) -> Option<u64> {
        read_exact(file, 8).map(|buf| u64::from_le_bytes(buf.try_into().unwrap_or([0; 8])))
    }
    fn read_string(file: &mut impl Read) -> Option<String> {
        let len = read_u64(file)? as usize;
        read_exact(file, len).map(|buf| gguf_string(&buf))
    }
    fn skip_string(file: &mut impl Read) -> Option<()> {
        let len = read_u64(file)? as usize;
        skip_bytes(file, len)
    }

    for _ in 0..kv_count {
        let Some(key) = read_string(&mut file) else { ok = false; break; };
        let Some(value_type) = read_u32(&mut file) else { ok = false; break; };
        let key_tail = key.rsplit('.').next().unwrap_or("");
        match value_type {
            8 => {
                // 只有架构名需要内容，其余字符串（描述 / 对话模板等）直接跳过
                if key == "general.architecture" {
                    let Some(text) = read_string(&mut file) else { ok = false; break; };
                    if !text.is_empty() {
                        architecture = text;
                    }
                } else if skip_string(&mut file).is_none() {
                    ok = false;
                    break;
                }
            }
            4 | 5 => {
                let Some(raw) = read_u32(&mut file) else { ok = false; break; };
                match key_tail {
                    "parameter_count" => explicit_params = raw as f64,
                    "block_count" => block_count = raw,
                    "full_attention_interval" => full_attention_interval = raw,
                    "head_count" => head_count = raw,
                    "head_count_kv" => head_count_kv = raw,
                    "embedding_length" => embedding_length = raw,
                    "key_length" => key_length = raw,
                    "context_length" => context_length = raw,
                    _ => {}
                }
            }
            10 | 11 | 12 => {
                let Some(raw) = read_u64(&mut file) else { ok = false; break; };
                if key_tail == "parameter_count" {
                    explicit_params = raw as f64;
                }
            }
            0 | 1 | 7 => {
                if read_exact(&mut file, 1).is_none() { ok = false; break; }
            }
            2 | 3 => {
                if read_exact(&mut file, 2).is_none() { ok = false; break; }
            }
            6 => {
                // f32：4 字节，按 8 字节读会把后续键值全部错位
                if read_exact(&mut file, 4).is_none() { ok = false; break; }
            }
            9 => {
                // 数组元素共用同一类型；head_count_kv 可能是逐层数组，取最大值做容量估算
                let Some(array_type) = read_u32(&mut file) else { ok = false; break; };
                let Some(len) = read_u64(&mut file) else { ok = false; break; };
                if len > 1_000_000 { ok = false; break; }
                if key_tail == "head_count_kv" {
                    kv_array_len = len;
                    kv_array_nonzero = 0;
                }
                let mut index = 0u64;
                while index < len {
                    if array_type == 8 {
                        // 词表 / merges 等字符串数组：只跳过内容，不构造 String
                        if skip_string(&mut file).is_none() { ok = false; break; }
                        index += 1;
                        continue;
                    }
                    let size = match array_type {
                        0 | 1 | 7 => 1,
                        2 | 3 => 2,
                        4 | 5 | 6 => 4,
                        10 | 11 | 12 => 8,
                        _ => 0,
                    };
                    if size == 0 { ok = false; break; }
                    if key_tail == "head_count_kv" && size == 4 && (array_type == 4 || array_type == 5) {
                        let Some(raw) = read_exact(&mut file, 4) else { ok = false; break; };
                        let value = u32::from_le_bytes(raw.as_slice().try_into().unwrap_or([0; 4]));
                        head_count_kv = head_count_kv.max(value);
                        if value > 0 {
                            kv_array_nonzero += 1;
                        }
                    } else if skip_bytes(&mut file, size).is_none() {
                        ok = false;
                        break;
                    }
                    index += 1;
                }
                if !ok { break; }
            }
            _ => { ok = false; break; }
        }
    }

    let mut quantization = String::new();
    if ok && tensor_count > 0 {
        if read_string(&mut file).is_some() {
            let dims = read_u32(&mut file).unwrap_or(0);
            let mut skipped = true;
            for _ in 0..dims.min(8) {
                if read_u64(&mut file).is_none() { skipped = false; break; }
            }
            if skipped {
                if let Some(kind) = read_u32(&mut file).and_then(gguf_type_name) {
                    quantization = kind.to_string();
                }
            }
        }
    }

    let parameters = if explicit_params > 0.0 { format_parameter_count(explicit_params) } else { String::new() };

    let head_count_kv = if head_count_kv > 0 { head_count_kv } else { head_count };
    // 混合架构（如 Qwen3.5 的 SSM + 全注意力）只有部分层缓存 KV：
    // 逐层 head_count_kv 数组里的非零项数最能说明问题，其次按 full_attention_interval 推算。
    let attention_layer_count = if block_count > 0 && kv_array_len == block_count as u64 && kv_array_nonzero > 0 {
        kv_array_nonzero.min(block_count)
    } else if block_count > 0 && full_attention_interval > 0 {
        block_count.div_ceil(full_attention_interval).min(block_count)
    } else {
        block_count
    };
    let head_dim = if key_length > 0 {
        key_length
    } else if head_count > 0 && embedding_length > 0 {
        embedding_length / head_count
    } else {
        0
    };
    let weights_bytes = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);

    if !ok && architecture.is_empty() && parameters.is_empty() && quantization.is_empty() {
        return empty;
    }
    GgufMeta {
        architecture,
        parameters,
        quantization,
        block_count,
        attention_layer_count,
        head_count,
        head_count_kv,
        head_dim,
        context_length,
        weights_bytes,
    }
}

#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|path| !path.trim().is_empty() && Path::new(path).exists()).collect()
}

fn extract_parameters_from_name(name: &str) -> String {
    let bytes = name.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            if i < len && (bytes[i] == b'b' || bytes[i] == b'B') {
                let end = i + 1;
                if end == len || !bytes[end].is_ascii_alphabetic() {
                    return format!("{}B", &name[start..i]);
                }
            }
        } else {
            i += 1;
        }
    }
    String::new()
}

fn extract_quant_from_name(name: &str) -> String {
    let lower = name.to_lowercase();
    const QUANTS: &[&str] = &[
        "iq1_s", "iq1_m", "iq2_xxs", "iq2_xs", "iq2_s", "iq2_m",
        "iq3_xxs", "iq3_xs", "iq3_s", "iq3_m",
        "iq4_nl", "iq4_xs",
        "q2_k", "q3_k_s", "q3_k_m", "q3_k_l", "q3_k",
        "q4_k_s", "q4_k_m", "q4_k", "q4_0", "q4_1",
        "q5_k_s", "q5_k_m", "q5_k", "q5_0", "q5_1",
        "q6_k", "q8_0", "q8_k",
        "fp16", "f16", "bf16", "fp32", "f32",
        "rk8v4", "rk4v4-e8", "rk4v4_e8", "rk4v4", "rk2v4-e8", "rk2v4_e8", "k8v4", "nvfp4", "fp8", "int8", "int4", "gsq"
    ];
    for &q in QUANTS {
        if let Some(pos) = lower.find(q) {
            let slice = &name[pos..pos + q.len()];
            return slice.to_uppercase();
        }
    }
    String::new()
}

/// 读取 .ninfer 单容器头部元数据：
/// 偏移 0..7 为魔数 NINFER\0\x03，偏移 8..15 为 64 位 JSON 长度，偏移 32 起为 UTF-8 JSON 架构定义。
fn read_ninfer_meta(path: &str) -> GgufMeta {
    let empty = GgufMeta {
        architecture: String::new(),
        parameters: String::new(),
        quantization: String::new(),
        block_count: 0,
        attention_layer_count: 0,
        head_count: 0,
        head_count_kv: 0,
        head_dim: 0,
        context_length: 0,
        weights_bytes: 0,
    };
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return empty,
    };
    use std::io::{Read, Seek, SeekFrom};
    let mut header = [0u8; 16];
    if file.read_exact(&mut header).is_err() {
        return empty;
    }
    if &header[0..6] != b"NINFER" {
        return empty;
    }
    let json_len = u64::from_le_bytes(header[8..16].try_into().unwrap_or([0; 8]));
    if json_len == 0 || json_len > 16 * 1024 * 1024 {
        return empty;
    }
    if file.seek(SeekFrom::Start(32)).is_err() {
        return empty;
    }
    let mut json_buf = vec![0u8; json_len as usize];
    if file.read_exact(&mut json_buf).is_err() {
        return empty;
    }
    let Ok(json_str) = std::str::from_utf8(&json_buf) else {
        return empty;
    };
    let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(json_str) else {
        return empty;
    };

    let raw_arch = value
        .pointer("/components/text/config/architectures/0")
        .and_then(|v| v.as_str())
        .or_else(|| value.pointer("/components/text/config/model_type").and_then(|v| v.as_str()))
        .unwrap_or("NInfer");

    let architecture = if raw_arch.contains("Qwen3_5") || raw_arch.contains("qwen3_5") {
        "Qwen3.5".to_string()
    } else if raw_arch.contains("Qwen2") || raw_arch.contains("qwen2") {
        "Qwen2".to_string()
    } else {
        raw_arch.replace("ForCausalLM", "").replace("_text", "")
    };

    let model_name = value
        .pointer("/metadata/name")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let path_obj = Path::new(path);
    let fallback_name = path_obj.file_stem().map(|s| s.to_string_lossy()).unwrap_or_default();
    let name_for_parse = if !model_name.is_empty() { model_name } else { &fallback_name };

    let parameters = extract_parameters_from_name(name_for_parse);
    let quantization = extract_quant_from_name(name_for_parse);

    let text_config = value.pointer("/components/text/config");
    let scalar = |key: &str| {
        text_config
            .and_then(|config| config.get(key))
            .and_then(|field| field.as_u64())
            .unwrap_or(0) as u32
    };
    let block_count = scalar("num_hidden_layers");
    let head_count = scalar("num_attention_heads");
    let head_count_kv = {
        let kv = scalar("num_key_value_heads");
        if kv > 0 { kv } else { head_count }
    };
    let head_dim = scalar("head_dim");
    let context_length = scalar("max_position_embeddings");
    // 混合架构（GDN + 全注意力）只有 full_attention 层带 KV；没有逐层表时按全部层处理
    let attention_layer_count = text_config
        .and_then(|config| config.get("layer_types"))
        .and_then(|field| field.as_array())
        .map(|layers| layers.iter().filter(|layer| layer.as_str() == Some("full_attention")).count() as u32)
        .filter(|count| *count > 0)
        .unwrap_or(block_count);

    // 容器里同时装着视觉 / DFlash 权重，纯文本启动不应把它们算进显存预算
    let text_weights = ninfer_text_weights(&value);
    let weights_bytes = if text_weights > 0 {
        text_weights
    } else {
        fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
    };

    GgufMeta {
        architecture,
        parameters,
        quantization,
        block_count,
        attention_layer_count,
        head_count,
        head_count_kv,
        head_dim,
        context_length,
        weights_bytes,
    }
}

/// 汇总 .ninfer 容器里 text / mtp / proposal 组件的张量体积（按绑定去重，共享张量只算一次）。
fn ninfer_text_weights(value: &serde_json::Value) -> u64 {
    use std::collections::{HashMap, HashSet};

    let Some(objects) = value.get("objects") else {
        return 0;
    };
    let object_values: Vec<&serde_json::Value> = if let Some(map) = objects.as_object() {
        map.values().collect()
    } else if let Some(list) = objects.as_array() {
        list.iter().collect()
    } else {
        return 0;
    };
    let mut bytes_by_id: HashMap<&str, u64> = HashMap::new();
    for object in object_values {
        if object.get("kind").and_then(|kind| kind.as_str()) != Some("tensor") {
            continue;
        }
        if let (Some(id), Some(bytes)) = (
            object.get("id").and_then(|id| id.as_str()),
            object.get("bytes").and_then(|bytes| bytes.as_u64()),
        ) {
            bytes_by_id.insert(id, bytes);
        }
    }
    let Some(bindings) = value.get("bindings").and_then(|items| items.as_object()) else {
        return bytes_by_id.values().sum();
    };

    let mut counted: HashSet<&str> = HashSet::new();
    let mut total = 0u64;
    for (name, binding) in bindings {
        let component = name.split('/').next().unwrap_or_default();
        if !matches!(component, "text" | "mtp" | "proposal") {
            continue;
        }
        let ids: Vec<&str> = if let Some(id) = binding.get("object").and_then(|id| id.as_str()) {
            vec![id]
        } else {
            binding
                .get("parts")
                .and_then(|parts| parts.as_array())
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("object").and_then(|id| id.as_str()))
                        .collect()
                })
                .unwrap_or_default()
        };
        for id in ids {
            if !counted.insert(id) {
                continue;
            }
            if let Some(bytes) = bytes_by_id.get(id) {
                total += *bytes;
            }
        }
    }
    total
}

#[tauri::command]
fn inspect_gguf(path: String) -> GgufMeta {
    let lower = path.to_lowercase();
    if lower.ends_with(".ninfer") {
        let meta = read_ninfer_meta(&path);
        if !meta.architecture.is_empty() || !meta.parameters.is_empty() || !meta.quantization.is_empty() {
            return meta;
        }
    }
    let meta = read_gguf_meta(&path);
    if meta.architecture.is_empty() && meta.quantization.is_empty() && meta.parameters.is_empty() {
        read_ninfer_meta(&path)
    } else {
        meta
    }
}

#[cfg(test)]
mod gguf_meta_tests {
    use crate::engines::detect_engine_type;
    use super::{read_gguf_meta, read_ninfer_meta};

    #[test]
    fn detect_engine_type_identifies_engines() {
        assert_eq!(detect_engine_type("ninfer-kvmem-server.exe"), "ninfer_kvmem");
        assert_eq!(detect_engine_type("D:\\AI\\workers\\ninfer\\ninfer-kvmem-server.exe"), "ninfer_kvmem");
        assert_eq!(detect_engine_type("ninfer-serve.exe"), "ninfer");
        assert_eq!(detect_engine_type("D:\\AI\\ninfer-serve.exe"), "ninfer");
        assert_eq!(detect_engine_type("llama-server.exe"), "llamacpp");
        assert_eq!(detect_engine_type("llama-kvmem-server.exe"), "llamacpp");
    }

    #[test]
    fn read_ninfer_meta_parses_json_header() {
        let path = std::env::temp_dir().join("test-model-mock.ninfer");
        let mut buf = Vec::new();
        buf.extend_from_slice(b"NINFER\0\x03");
        let json = r#"{"metadata":{"name":"Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp"},"components":{"text":{"config":{"architectures":["Qwen3_5ForCausalLM"]}}}}"#;
        let json_bytes = json.as_bytes();
        buf.extend_from_slice(&(json_bytes.len() as u64).to_le_bytes());
        buf.extend_from_slice(&[0u8; 16]); // 16 bytes reserved/hash to reach offset 32
        buf.extend_from_slice(json_bytes);
        std::fs::write(&path, buf).unwrap();

        let meta = read_ninfer_meta(&path.to_string_lossy());
        assert_eq!(meta.architecture, "Qwen3.5");
        assert_eq!(meta.parameters, "27B");
        assert_eq!(meta.quantization, "IQ3_S");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_ninfer_meta_reads_text_capacity() {
        let path = std::env::temp_dir().join("test-model-capacity.ninfer");
        let mut buf = Vec::new();
        buf.extend_from_slice(b"NINFER\0\x03");
        let json = r#"{
            "metadata":{"name":"Qwen3.8-27B-IQ3_S-mtp"},
            "components":{"text":{"config":{
                "architectures":["Qwen3_5ForCausalLM"],
                "num_hidden_layers":64,
                "num_attention_heads":24,
                "num_key_value_heads":4,
                "head_dim":256,
                "max_position_embeddings":262144,
                "layer_types":["linear_attention","linear_attention","linear_attention","full_attention"]
            }}},
            "objects":{
                "0":{"id":"weight/000001","kind":"tensor","bytes":1000},
                "1":{"id":"weight/000002","kind":"tensor","bytes":2000},
                "2":{"id":"resource/text/tokenizer.json","kind":"resource","bytes":400}
            },
            "bindings":{
                "text/token_embedding":{"object":"weight/000001"},
                "text/output_head":{"parts":[{"object":"weight/000001","range":[0,500]}]},
                "vision/projection":{"object":"weight/000002"}
            }
        }"#;
        let json_bytes = json.as_bytes();
        buf.extend_from_slice(&(json_bytes.len() as u64).to_le_bytes());
        buf.extend_from_slice(&[0u8; 16]);
        buf.extend_from_slice(json_bytes);
        std::fs::write(&path, buf).unwrap();

        let meta = read_ninfer_meta(&path.to_string_lossy());
        assert_eq!(meta.block_count, 64);
        assert_eq!(meta.attention_layer_count, 1);
        assert_eq!(meta.head_count, 24);
        assert_eq!(meta.head_count_kv, 4);
        assert_eq!(meta.head_dim, 256);
        assert_eq!(meta.context_length, 262144);
        // 视觉权重不计入文本预算，共享张量只算一次
        assert_eq!(meta.weights_bytes, 1000);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_gguf_meta_rejects_truncated_header() {
        let path = std::env::temp_dir().join("cookllm-truncated.gguf");
        std::fs::write(&path, b"GGUF").unwrap();
        let meta = read_gguf_meta(&path.to_string_lossy());
        assert!(meta.architecture.is_empty());
        assert!(meta.parameters.is_empty());
        assert!(meta.quantization.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_gguf_meta_reads_architecture_and_quant() {
        fn push_u32(buf: &mut Vec<u8>, value: u32) { buf.extend_from_slice(&value.to_le_bytes()); }
        fn push_u64(buf: &mut Vec<u8>, value: u64) { buf.extend_from_slice(&value.to_le_bytes()); }
        fn push_str(buf: &mut Vec<u8>, value: &str) { push_u64(buf, value.len() as u64); buf.extend_from_slice(value.as_bytes()); }
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3);
        push_u64(&mut buf, 1);
        push_u64(&mut buf, 2);
        push_str(&mut buf, "general.architecture");
        push_u32(&mut buf, 8);
        push_str(&mut buf, "qwen2");
        push_str(&mut buf, "general.parameter_count");
        push_u32(&mut buf, 10);
        push_u64(&mut buf, 8_000_000_000);
        push_str(&mut buf, "token_embd.weight");
        push_u32(&mut buf, 2);
        push_u64(&mut buf, 4096);
        push_u64(&mut buf, 151936);
        push_u32(&mut buf, 8);
        push_u64(&mut buf, 0);
        let path = std::env::temp_dir().join("cookllm-valid.gguf");
        std::fs::write(&path, buf).unwrap();
        let meta = read_gguf_meta(&path.to_string_lossy());
        assert_eq!(meta.architecture, "qwen2");
        assert_eq!(meta.parameters, "8.0B");
        assert_eq!(meta.quantization, "Q8_0");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_gguf_meta_reads_kv_capacity_fields() {
        fn push_u32(buf: &mut Vec<u8>, value: u32) {
            buf.extend_from_slice(&value.to_le_bytes());
        }
        fn push_u64(buf: &mut Vec<u8>, value: u64) {
            buf.extend_from_slice(&value.to_le_bytes());
        }
        fn push_str(buf: &mut Vec<u8>, value: &str) {
            push_u64(buf, value.len() as u64);
            buf.extend_from_slice(value.as_bytes());
        }
        fn push_u32_kv(buf: &mut Vec<u8>, key: &str, value: u32) {
            push_str(buf, key);
            push_u32(buf, 4);
            push_u32(buf, value);
        }

        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        push_u32(&mut buf, 3);
        push_u64(&mut buf, 0);
        push_u64(&mut buf, 6);
        push_str(&mut buf, "general.architecture");
        push_u32(&mut buf, 8);
        push_str(&mut buf, "qwen2");
        push_u32_kv(&mut buf, "qwen2.block_count", 28);
        push_u32_kv(&mut buf, "qwen2.attention.head_count", 28);
        push_str(&mut buf, "qwen2.attention.head_count_kv");
        push_u32(&mut buf, 9);
        push_u32(&mut buf, 4);
        push_u64(&mut buf, 4);
        for value in [4u32, 4, 2, 2] {
            push_u32(&mut buf, value);
        }
        push_u32_kv(&mut buf, "qwen2.attention.key_length", 128);
        push_u32_kv(&mut buf, "qwen2.context_length", 32768);

        let path = std::env::temp_dir().join("cookllm-capacity.gguf");
        std::fs::write(&path, &buf).unwrap();
        let meta = read_gguf_meta(&path.to_string_lossy());
        assert_eq!(meta.architecture, "qwen2");
        assert_eq!(meta.block_count, 28);
        assert_eq!(meta.attention_layer_count, 28);
        assert_eq!(meta.head_count, 28);
        assert_eq!(meta.head_count_kv, 4);
        assert_eq!(meta.head_dim, 128);
        assert_eq!(meta.context_length, 32768);
        assert_eq!(meta.weights_bytes, buf.len() as u64);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_gguf_meta_detects_hybrid_attention_layers() {
        fn push_u32(buf: &mut Vec<u8>, value: u32) {
            buf.extend_from_slice(&value.to_le_bytes());
        }
        fn push_u64(buf: &mut Vec<u8>, value: u64) {
            buf.extend_from_slice(&value.to_le_bytes());
        }
        fn push_str(buf: &mut Vec<u8>, value: &str) {
            push_u64(buf, value.len() as u64);
            buf.extend_from_slice(value.as_bytes());
        }
        fn push_u32_kv(buf: &mut Vec<u8>, key: &str, value: u32) {
            push_str(buf, key);
            push_u32(buf, 4);
            push_u32(buf, value);
        }
        fn push_kv_array(buf: &mut Vec<u8>, key: &str, values: &[u32]) {
            push_str(buf, key);
            push_u32(buf, 9);
            push_u32(buf, 4);
            push_u64(buf, values.len() as u64);
            for value in values {
                push_u32(buf, *value);
            }
        }

        // Qwen3.5 混合架构：32 层里每 4 层才有一层全注意力（8 层带 KV）
        let mut interval_buf = Vec::new();
        interval_buf.extend_from_slice(b"GGUF");
        push_u32(&mut interval_buf, 3);
        push_u64(&mut interval_buf, 0);
        push_u64(&mut interval_buf, 8);
        push_str(&mut interval_buf, "general.architecture");
        push_u32(&mut interval_buf, 8);
        push_str(&mut interval_buf, "qwen35");
        push_u32_kv(&mut interval_buf, "qwen35.block_count", 32);
        push_u32_kv(&mut interval_buf, "qwen35.attention.head_count_kv", 4);
        // 字符串数组（类似词表 tags）整段跳过，验证跳过后仍能读到后面的键
        push_str(&mut interval_buf, "general.tags");
        push_u32(&mut interval_buf, 9);
        push_u32(&mut interval_buf, 8);
        push_u64(&mut interval_buf, 2);
        push_str(&mut interval_buf, "text-generation");
        push_str(&mut interval_buf, "chat");
        // f32 / bool 键穿插在中间，验证标量长度没读错位（f32 是 4 字节而非 8 字节）
        push_str(&mut interval_buf, "qwen35.rope.freq_base");
        push_u32(&mut interval_buf, 6);
        interval_buf.extend_from_slice(&1_000_000f32.to_le_bytes());
        push_str(&mut interval_buf, "qwen35.attention.causal");
        push_u32(&mut interval_buf, 7);
        interval_buf.push(1);
        push_u32_kv(&mut interval_buf, "qwen35.full_attention_interval", 4);
        push_u32_kv(&mut interval_buf, "qwen35.attention.key_length", 256);

        let interval_path = std::env::temp_dir().join("cookllm-hybrid-interval.gguf");
        std::fs::write(&interval_path, &interval_buf).unwrap();
        let meta = read_gguf_meta(&interval_path.to_string_lossy());
        assert_eq!(meta.block_count, 32);
        assert_eq!(meta.attention_layer_count, 8);
        let _ = std::fs::remove_file(interval_path);

        // 逐层 head_count_kv 数组：非零项数直接给出带 KV 的层数
        let mut array_buf = Vec::new();
        array_buf.extend_from_slice(b"GGUF");
        push_u32(&mut array_buf, 3);
        push_u64(&mut array_buf, 0);
        push_u64(&mut array_buf, 4);
        push_str(&mut array_buf, "general.architecture");
        push_u32(&mut array_buf, 8);
        push_str(&mut array_buf, "qwen35");
        push_u32_kv(&mut array_buf, "qwen35.block_count", 8);
        push_kv_array(&mut array_buf, "qwen35.attention.head_count_kv", &[0, 4, 0, 4, 0, 4, 0, 4]);
        push_u32_kv(&mut array_buf, "qwen35.attention.key_length", 256);

        let array_path = std::env::temp_dir().join("cookllm-hybrid-array.gguf");
        std::fs::write(&array_path, &array_buf).unwrap();
        let meta = read_gguf_meta(&array_path.to_string_lossy());
        assert_eq!(meta.block_count, 8);
        assert_eq!(meta.attention_layer_count, 4);
        let _ = std::fs::remove_file(array_path);
    }

    #[test]
    fn test_ensure_device_profile_schema_conversion() {
        use crate::server_args::ensure_device_profile_schema;
        let path = std::env::temp_dir().join("test-device-profile-schema.json");
        let initial_json = r#"{
  "schema": "ninfer.device-route-profiles",
  "schema_version": 1,
  "devices": [
    {
      "hardware_class": "nvidia-geforce-rtx-5070-ti-sm120",
      "routes": { "route1": "kernel_a" }
    }
  ]
}"#;
        std::fs::write(&path, initial_json).unwrap();

        // Convert 1 -> 2 (for kvmem)
        ensure_device_profile_schema(&path, 2);
        let content_v2 = std::fs::read_to_string(&path).unwrap();
        let parsed_v2: serde_json::Value = serde_json::from_str(&content_v2).unwrap();
        assert_eq!(parsed_v2["schema_version"], 2);
        assert_eq!(parsed_v2["devices"][0]["routes"]["route1"], "kernel_a");

        // Convert 2 -> 1 (for standard ninfer)
        ensure_device_profile_schema(&path, 1);
        let content_v1 = std::fs::read_to_string(&path).unwrap();
        let parsed_v1: serde_json::Value = serde_json::from_str(&content_v1).unwrap();
        assert_eq!(parsed_v1["schema_version"], 1);
        assert_eq!(parsed_v1["devices"][0]["routes"]["route1"], "kernel_a");

        let _ = std::fs::remove_file(&path);
    }
}

/// 弹出系统目录选择框并返回所选路径（取消时返回 None）
#[tauri::command]
fn pick_directory(app: AppHandle) -> Option<String> {
    let folder = app.dialog().file().blocking_pick_folder()?;
    let path = folder.as_path()?;
    Some(path.to_string_lossy().to_string())
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

fn is_model_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".gguf") || lower.ends_with(".ninfer")
}

/// 递归收集目录下的 .gguf 与 .ninfer 模型文件（含子目录）。
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
            if is_model_file(&name) {
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

/// 把前端拖入/选中的路径展开为模型文件列表（支持 .gguf 与 .ninfer）：目录递归收集，文件按后缀过滤，最后按路径去重。
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
            if is_model_file(&name) {
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
    reveal_in_folder(directory.to_string_lossy().to_string())
}

#[tauri::command]
fn open_url(_app: AppHandle, url: String) -> Result<(), String> {
    // 只放行 http/https 链接：open_url 的来源包含页面内任意外链，必须挡掉 file:/cmd 注入与协议滥用
    let lower = url.trim().to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("不支持的链接协议：{}", url));
    }
    #[cfg(target_os = "windows")]
    {
        // 走 explorer.exe 而非 `cmd /C start`：cmd 的元字符解析（& | ^ %VAR%）无法被 std::process 的引号转义覆盖，存在拼接执行风险
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(&url)
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
    log_timing(&guard);
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

  window.addEventListener("keydown", function (event) {
    if (event.key === "F11") {
      event.preventDefault();
      send({ type: "cookllm:zen-toggle" });
    }
  });

  // 强制 WebUI 在内嵌桌面环境下始终以 Desktop 模式运行：
  // 1) 拦截 mobile 探测媒体查询（max-width: 767px 等），防止 SvelteKit 将侧边栏当成移动端全屏抽屉；
  // 保证收起按钮显示为侧边栏折叠图标而非关闭 X，并在收起时彻底 unmount 历史会话列表，避免首字溢出。
  try {
    var origMatchMedia = window.matchMedia;
    if (origMatchMedia) {
      window.matchMedia = function (query) {
        var q = String(query || "");
        if (/max-width:\s*(76[0-9]|770|48rem)/i.test(q) || q.indexOf("max-width: 767px") !== -1) {
          return origMatchMedia.call(window, "(max-width: 0px)");
        }
        return origMatchMedia.apply(this, arguments);
      };
    }
  } catch (e) {}

  // 2) 注入桌面布局样式补丁，保证即使在窄视口下侧边栏折叠也能固定为 3rem (48px)，
  // 并在非展开状态下隐藏会话历史及多余文本，防止任何溢出。
  function injectDesktopStyles() {
    try {
      if (document.getElementById("cookllm-desktop-layout-override")) return;
      var target = document.head || document.documentElement;
      if (!target) return;
      var style = document.createElement("style");
      style.id = "cookllm-desktop-layout-override";
      style.textContent = [
        "aside:not(.is-expanded) ul,",
        "aside:not(.is-expanded) .overflow-y-auto,",
        "aside:not(.is-expanded) [class*=\"overflow-y\"],",
        "aside:not(.is-expanded) span.truncate,",
        "aside:not(.is-expanded) kbd {",
        "  display: none !important;",
        "}",
        "aside:not(.is-expanded) {",
        "  width: 3rem !important;",
        "  min-width: 3rem !important;",
        "  max-width: 3rem !important;",
        "  position: sticky !important;",
        "  pointer-events: auto !important;",
        "}",
        "aside.is-expanded {",
        "  width: 18rem !important;",
        "  min-width: 18rem !important;",
        "  position: sticky !important;",
        "  pointer-events: auto !important;",
        "}",
        "aside.is-expanded::before {",
        "  display: none !important;",
        "}",
        "div.flex.flex-col:has(> aside) {",
        "  flex-direction: row !important;",
        "}",
        ".chat-tabs-fade {",
        "  display: block !important;",
        "}"
      ].join("\n");
      target.appendChild(style);
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectDesktopStyles);
  } else {
    injectDesktopStyles();
  }
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
    let mut window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;

    let config = read_config(&app.handle()).unwrap_or_default();
    let is_dark = config.theme.as_deref() == Some("dark");
    window_config.background_color = if is_dark {
        Some(tauri::utils::config::Color(24, 24, 24, 255))
    } else {
        Some(tauri::utils::config::Color(242, 244, 249, 255))
    };

    let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
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

    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            let raw: *mut std::ffi::c_void = unsafe { std::mem::transmute(hwnd) };
            titlebar::set_dark_mode(raw, is_dark);
        }
    }

    let win = window.clone();
    let app_handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let config = read_config(&app_handle).unwrap_or_default();
            if config.minimize_to_tray_on_close.unwrap_or(true) {
                api.prevent_close();
                let _ = win.hide();
            }
        }
    });

    Ok(())
}

fn build_tray_menu(app: &AppHandle, tray_state: &TrayServerState) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;

    let config = read_config(app).ok();
    let models = config.as_ref().map(|c| c.models.as_slice()).unwrap_or_default();

    let get_format_tag = |name: &str| -> &'static str {
        models
            .iter()
            .find(|m| {
                let dname = m
                    .display_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(m.name.as_str());
                dname == name || m.name == name
            })
            .map(|m| {
                let is_ninfer = m.path.to_lowercase().ends_with(".ninfer")
                    || m.architecture.to_uppercase() == "NINFER";
                if is_ninfer { "[Ninfer] " } else { "[GGUF] " }
            })
            .unwrap_or("")
    };

    // 1. 服务状态项与控制项（仅在启动中、运行中或失败时显示；未运行/停止时保持干净，与刚打开软件时完全一致，无多余任务状态行）
    match tray_state {
        TrayServerState::Starting { model_name, port } => {
            let tag = get_format_tag(model_name);
            let status_text = format!("🟡 启动中: {}{} (端口: {})", tag, model_name, port);
            let status_item = MenuItem::with_id(app, "status_label", &status_text, true, None::<&str>)?;
            menu.append(&status_item)?;

            let sep_status = PredefinedMenuItem::separator(app)?;
            menu.append(&sep_status)?;

            let stop_item = MenuItem::with_id(app, "stop_service", "⏹ 取消启动", true, None::<&str>)?;
            menu.append(&stop_item)?;

            let copy_item = MenuItem::with_id(app, "copy_endpoint", "📋 复制 API 接口", true, None::<&str>)?;
            menu.append(&copy_item)?;

            let sep_ctrl = PredefinedMenuItem::separator(app)?;
            menu.append(&sep_ctrl)?;
        }
        TrayServerState::Running { model_name, port } => {
            let tag = get_format_tag(model_name);
            let status_text = format!("🟢 运行中: {}{} (端口: {})", tag, model_name, port);
            let status_item = MenuItem::with_id(app, "status_label", &status_text, true, None::<&str>)?;
            menu.append(&status_item)?;

            let sep_status = PredefinedMenuItem::separator(app)?;
            menu.append(&sep_status)?;

            let stop_item = MenuItem::with_id(app, "stop_service", "⏹ 停止服务", true, None::<&str>)?;
            menu.append(&stop_item)?;

            let webui_item = MenuItem::with_id(app, "open_webui", "🌐 打开会话界面 (WebUI)", true, None::<&str>)?;
            menu.append(&webui_item)?;

            let copy_item = MenuItem::with_id(app, "copy_endpoint", "📋 复制 API 接口", true, None::<&str>)?;
            menu.append(&copy_item)?;

            let sep_ctrl = PredefinedMenuItem::separator(app)?;
            menu.append(&sep_ctrl)?;
        }
        TrayServerState::Failed { model_name, .. } => {
            let status_text = format!("🔴 启动失败: {} (点击查看详情)", model_name);
            let status_item = MenuItem::with_id(app, "view_error", &status_text, true, None::<&str>)?;
            menu.append(&status_item)?;

            let sep_status = PredefinedMenuItem::separator(app)?;
            menu.append(&sep_status)?;
        }
        TrayServerState::Stopped => {
            // 未运行时不显示任何服务状态项，与刚打开软件时完全一致
        }
    }

    // 3. 模型子菜单：处于启动中或运行中时传达“切换”语义
    let is_active = matches!(tray_state, TrayServerState::Starting { .. } | TrayServerState::Running { .. });
    let current_model_name = match tray_state {
        TrayServerState::Starting { model_name, .. } | TrayServerState::Running { model_name, .. } => Some(model_name.as_str()),
        _ => None,
    };

    let submenu_title = if is_active { "▶ 切换模型" } else { "▶ 启动模型" };
    let model_submenu = Submenu::new(app, submenu_title, true)?;

    if models.is_empty() {
        let empty_item = MenuItem::with_id(app, "no_models", "暂无可用模型 (请先导入)", false, None::<&str>)?;
        model_submenu.append(&empty_item)?;
    } else {
        if is_active {
            let switch_hint = MenuItem::with_id(app, "switch_hint", "💡 点击将先停止当前服务", false, None::<&str>)?;
            model_submenu.append(&switch_hint)?;
            let hint_sep = PredefinedMenuItem::separator(app)?;
            model_submenu.append(&hint_sep)?;
        }

        for model in models {
            let display_name = model
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(model.name.as_str());
            let is_ninfer = model.path.to_lowercase().ends_with(".ninfer")
                || model.architecture.to_uppercase() == "NINFER";
            let format_tag = if is_ninfer { "[Ninfer]" } else { "[GGUF]" };
            let is_current = current_model_name.map(|cur| cur == display_name || cur == model.name).unwrap_or(false);
            let label = if is_current {
                format!("✓ {} {}", format_tag, display_name)
            } else {
                format!("{} {}", format_tag, display_name)
            };
            let item_id = format!("start_model:{}", model.id);
            let item = MenuItem::with_id(app, &item_id, &label, !is_current, None::<&str>)?;
            model_submenu.append(&item)?;
        }
    }
    menu.append(&model_submenu)?;

    let sep2 = PredefinedMenuItem::separator(app)?;
    menu.append(&sep2)?;

    // 4. 窗口控制
    let show_item = MenuItem::with_id(app, "show", "显示界面", true, None::<&str>)?;
    menu.append(&show_item)?;

    let sep3 = PredefinedMenuItem::separator(app)?;
    menu.append(&sep3)?;

    // 5. 退出
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    menu.append(&quit_item)?;

    Ok(menu)
}

/// 唤起主窗口的统一入口：显示 + 还原最小化 + 聚焦，并确保窗口落在当前可见屏幕内。
///
/// Windows 在显示器拓扑变化（拔插外接屏、改分辨率/DPI、睡眠唤醒、远程桌面）时只搬移
/// 可见窗口，隐藏中的窗口仍停留在旧坐标——从托盘 show() 后任务栏出现图标但屏幕上
/// 看不到主窗口，只能杀进程重开。这里在显示后校验窗口与现有显示器的可见重叠，
/// 不足时强制居中到最近的可见显示器，彻底规避该类问题。
fn show_window_onscreen(window: &tauri::WebviewWindow) {
    let _ = window.show();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.set_focus();

    // 与任一显示器的可见重叠都小于一条可拖拽的边条（96x40 物理像素）时判定"不可见"，
    // 交由 center() 落回最近的显示器。center() 会以窗口当前所属（最近的）显示器为基准。
    let pos = window.outer_position().ok();
    let size = window.outer_size().ok();
    let monitors = window.available_monitors().ok();
    if let (Some(pos), Some(size), Some(monitors)) = (pos, size, monitors) {
        const MIN_VISIBLE_W: i32 = 96;
        const MIN_VISIBLE_H: i32 = 40;
        let enough = monitors.iter().any(|m| {
            let mp = m.position();
            let ms = m.size();
            let overlap_w = (pos.x + size.width as i32).min(mp.x + ms.width as i32) - pos.x.max(mp.x);
            let overlap_h = (pos.y + size.height as i32).min(mp.y + ms.height as i32) - pos.y.max(mp.y);
            overlap_w >= MIN_VISIBLE_W && overlap_h >= MIN_VISIBLE_H
        });
        if !enough {
            let _ = window.center();
        }
    }
}

fn handle_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id.as_ref();
    match id {
        "show" | "status_label" => {
            if let Some(window) = app.get_webview_window("main") {
                show_window_onscreen(&window);
            }
        }
        "stop_service" => {
            let state = app.state::<ProcessState>();
            let _ = stop_server_internal(app, &state);
        }
        "open_webui" => {
            let state = app.state::<ProcessState>();
            let port = {
                let guard = state.0.lock().ok();
                guard.and_then(|g| g.as_ref().and_then(|m| m.status.port)).unwrap_or(8080)
            };
            let _ = open_url(app.clone(), format!("http://127.0.0.1:{}", port));
        }
        "copy_endpoint" => {
            let port = match get_tray_state() {
                TrayServerState::Starting { port, .. } | TrayServerState::Running { port, .. } => port,
                _ => {
                    let state = app.state::<ProcessState>();
                    let guard = state.0.lock().ok();
                    guard.and_then(|g| g.as_ref().and_then(|m| m.status.port)).unwrap_or(8080)
                }
            };
            let endpoint = format!("http://127.0.0.1:{}/v1", port);
            if let Err(e) = set_system_clipboard(&endpoint) {
                emit_log(app, "stderr", &format!("复制 API 接口失败: {}", e));
            } else {
                emit_log(app, "system", &format!("已复制 API 接口到剪贴板: {}", endpoint));
                if let Some(tray) = app.tray_by_id("main-tray") {
                    let _ = tray.set_tooltip(Some(format!("已复制 API 接口: {}", endpoint)));
                }
            }
        }
        "view_error" => {
            if let Some(window) = app.get_webview_window("main") {
                show_window_onscreen(&window);
            }
            let error_msg = if let TrayServerState::Failed { error, .. } = get_tray_state() {
                error
            } else {
                String::new()
            };
            let _ = app.emit("tray_view_error", error_msg);
        }
        "quit" => {
            app.exit(0);
        }
        s if s.starts_with("start_model:") => {
            let model_id = &s["start_model:".len()..];
            if let Ok(config) = read_config(app) {
                if let Some(model) = config.models.iter().find(|m| m.id == model_id) {
                    let profile_id = if config.preferred_model_id.as_deref() == Some(model_id) && config.preferred_profile_id.is_some() {
                        config.preferred_profile_id.clone().unwrap()
                    } else if let Some(p) = model.profiles.first() {
                        p.id.clone()
                    } else if let Some(p) = config.profiles.first() {
                        p.id.clone()
                    } else {
                        String::new()
                    };
                    if !profile_id.is_empty() {
                        let state = app.state::<ProcessState>();
                        if let Err(err) = start_server_internal(app, &state, model_id, &profile_id) {
                            emit_log(app, "stderr", &format!("托盘启动服务失败: {}", err));
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    let tray_state = get_tray_state();
    let menu = build_tray_menu(&handle, &tray_state)?;

    let icon = app.default_window_icon().cloned();

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("CookLLM · 本地大模型管理器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_tray_menu_event(app, event);
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    // 最小化状态下 is_visible() 也为 true：优先还原而不是隐藏，
                    // 同时避免产生"隐藏且最小化"的叠加态（该状态下还原容易出边角问题）。
                    if window.is_minimized().unwrap_or(false) {
                        show_window_onscreen(&window);
                    } else if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        show_window_onscreen(&window);
                    }
                }
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app)?;

    Ok(())
}

/* ==================== 全局快捷键自定义功能 ==================== */

#[derive(Default, Clone)]
struct RegisteredShortcuts {
    toggle_window: Option<Shortcut>,
    start_server: Option<Shortcut>,
    stop_server: Option<Shortcut>,
    switch_engine: Option<Shortcut>,
}

static REGISTERED_SHORTCUTS: OnceLock<Mutex<RegisteredShortcuts>> = OnceLock::new();

fn get_registered_shortcuts() -> &'static Mutex<RegisteredShortcuts> {
    REGISTERED_SHORTCUTS.get_or_init(|| Mutex::new(RegisteredShortcuts::default()))
}

fn resolve_default_model_and_profile(config: &AppConfig) -> Option<(String, String)> {
    if let Some(ref model_id) = config.preferred_model_id {
        if let Some(model) = config.models.iter().find(|m| &m.id == model_id) {
            let profile_id = if let Some(ref pid) = config.preferred_profile_id {
                pid.clone()
            } else if let Some(p) = model.profiles.first() {
                p.id.clone()
            } else if let Some(p) = config.profiles.first() {
                p.id.clone()
            } else {
                String::new()
            };
            if !profile_id.is_empty() {
                return Some((model.id.clone(), profile_id));
            }
        }
    }
    for model in &config.models {
        let profile_id = if let Some(p) = model.profiles.first() {
            p.id.clone()
        } else if let Some(p) = config.profiles.first() {
            p.id.clone()
        } else {
            String::new()
        };
        if !profile_id.is_empty() {
            return Some((model.id.clone(), profile_id));
        }
    }
    None
}

pub(crate) fn sync_global_shortcuts(app: &AppHandle, config: &AppConfig) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let mut registered = RegisteredShortcuts::default();
    let sc = config.shortcuts.clone().unwrap_or_default();

    if !sc.enabled {
        if let Ok(mut g) = get_registered_shortcuts().lock() {
            *g = registered;
        }
        return;
    }

    let try_register = |key_str: &str, _action_name: &str| -> Option<Shortcut> {
        let trimmed = key_str.trim();
        if trimmed.is_empty() {
            return None;
        }
        match trimmed.parse::<Shortcut>() {
            Ok(shortcut) => {
                match gs.register(shortcut.clone()) {
                    Ok(()) => Some(shortcut),
                    Err(_e) => {
                        eprintln!("注册快捷键 [{}] ({}) 失败: {}", _action_name, trimmed, _e);
                        None
                    }
                }
            }
            Err(_e) => {
                eprintln!("解析快捷键 [{}] ({}) 格式错误: {}", _action_name, trimmed, _e);
                None
            }
        }
    };

    if let Some(ref s) = sc.toggle_window {
        registered.toggle_window = try_register(s, "后台打开主界面");
    }
    if let Some(ref s) = sc.start_server {
        registered.start_server = try_register(s, "开启服务");
    }
    if let Some(ref s) = sc.stop_server {
        registered.stop_server = try_register(s, "关闭服务");
    }
    if let Some(ref s) = sc.switch_engine {
        registered.switch_engine = try_register(s, "打开引擎管理");
    }

    if let Ok(mut g) = get_registered_shortcuts().lock() {
        *g = registered;
    }
}

fn handle_global_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    let (is_toggle, is_start, is_stop, is_switch_engine) = {
        if let Ok(guard) = get_registered_shortcuts().lock() {
            (
                guard.toggle_window.as_ref() == Some(shortcut),
                guard.start_server.as_ref() == Some(shortcut),
                guard.stop_server.as_ref() == Some(shortcut),
                guard.switch_engine.as_ref() == Some(shortcut),
            )
        } else {
            (false, false, false, false)
        }
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if is_toggle {
            if let Some(window) = app.get_webview_window("main") {
                let is_minimized = window.is_minimized().unwrap_or(false);
                let is_visible = window.is_visible().unwrap_or(false);
                let is_focused = window.is_focused().unwrap_or(false);
                if !is_visible || is_minimized {
                    show_window_onscreen(&window);
                } else if is_focused {
                    let _ = window.hide();
                } else {
                    show_window_onscreen(&window);
                }
            }
        }

        if is_start {
            let state = app.state::<ProcessState>();
            let is_running = {
                let guard = state.0.lock().ok();
                guard.as_ref().map(|g| g.is_some()).unwrap_or(false)
            };
            if !is_running {
                if let Ok(config) = read_config(&app) {
                    if let Some((model_id, profile_id)) = resolve_default_model_and_profile(&config) {
                        if let Err(err) = start_server_internal(&app, &state, &model_id, &profile_id) {
                            emit_log(&app, "stderr", &format!("启动服务失败: {}", err));
                        }
                    }
                }
            }
        }

        if is_stop {
            let state = app.state::<ProcessState>();
            let is_running = {
                let guard = state.0.lock().ok();
                guard.as_ref().map(|g| g.is_some()).unwrap_or(false)
            };
            if is_running {
                let _ = stop_server_internal(&app, &state);
            }
        }

        if is_switch_engine {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("shortcut-open-engine-hub", ());
        }
    });
}



#[cfg(test)]
mod tests {
    use crate::engines::find_executable;
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

    #[test]
    fn find_server_executable_finds_branch_server() {
        use crate::engines::find_server_executable;
        let base = std::env::temp_dir().join("cookllm_find_test_branch");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("bin")).unwrap();
        fs::write(base.join("bin").join("llama-kvmem-server.exe"), "dummy-kvmem").unwrap();
        let found = find_server_executable(&base, 0).expect("should find custom branch server");
        assert!(found == base.join("bin").join("llama-kvmem-server.exe"), "found: {found:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn collect_server_candidates_filters_rpc_server() {
        use crate::engines::collect_server_candidates;
        let base = std::env::temp_dir().join("cookllm_collect_test_rpc");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // 模拟官方包：同时存在 llama-server.exe 与 ggml-rpc-server.exe
        fs::write(base.join("llama-server.exe"), "dummy-server").unwrap();
        fs::write(base.join("ggml-rpc-server.exe"), "dummy-rpc").unwrap();
        fs::write(base.join("llama-cli.exe"), "dummy-cli").unwrap();

        let mut candidates = Vec::new();
        collect_server_candidates(&base, &base, 0, &mut candidates);
        assert_eq!(candidates.len(), 1, "RPC 和 CLI 必须被排除，仅保留标准 server");
        assert_eq!(candidates[0].name, "llama-server.exe");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn extract_cuda_version_patterns() {
        use crate::system::{extract_cuda_full_version, extract_cuda_major_version};
        assert_eq!(extract_cuda_full_version("llama-b11149-bin-win-cuda-12.4-x64.zip"), "12.4");
        assert_eq!(extract_cuda_major_version("12.4"), "12");

        assert_eq!(extract_cuda_full_version("llama-b11149-bin-win-cuda-13.4-x64.zip"), "13.4");
        assert_eq!(extract_cuda_major_version("13.4"), "13");

        assert_eq!(extract_cuda_full_version("llama-b5000-bin-win-cuda-cu12.4-x64.zip"), "12.4");
        assert_eq!(extract_cuda_full_version("cudart-llama-bin-win-cuda-12.4-x64.zip"), "12.4");
        assert_eq!(extract_cuda_full_version("cudart-llama-bin-win-cu12.4-x64.zip"), "12.4");
        assert_eq!(extract_cuda_full_version("e:\\ai\\kvmem-v0.16.0-rc3-windows-x86_64-cuda13.2.86\\bin"), "13.2.86");
        assert_eq!(extract_cuda_major_version("13.2.86"), "13");

        assert_eq!(extract_cuda_full_version("llama-b11149-bin-win-vulkan-x64.zip"), "");
    }

    #[test]
    fn ninfer_quant_extraction_tests() {
        use crate::downloads::{extract_primary_quant_bits, extract_quant_bits_set};

        // 1-bit: Ternary / Bonsai / 1.58bit
        let s1 = vec!["sanbanfu/Ternary-Bonsai-2-27B-ninfer-v3-spliced.ninfer".into()];
        let b1 = extract_quant_bits_set(&s1);
        assert!(b1.contains(&1), "Ternary should match 1-bit");
        assert!(!b1.contains(&8), "Ternary 1.58bit should not falsely match 8-bit");

        // 2-bit & 3-bit: Swift-1.5 多量化
        let s2 = vec![
            "fyb423/Swift-1.5-Qwen3.8-27B-GSQ-RCO-NInfer".into(),
            "iq2_s".into(),
            "iq3_s".into(),
            "iq3_xxs".into(),
        ];
        let b2 = extract_quant_bits_set(&s2);
        assert!(b2.contains(&2), "Should match 2-bit");
        assert!(b2.contains(&3), "Should match 3-bit (IQ3 and GSQ)");

        // 4-bit: NVFP4
        let s3 = vec![
            "LittleStar888/qwen3_8_27b_nvfp4.ninfer".into(),
            "nvfp4".into(),
            "w4a4".into(),
        ];
        let b3 = extract_quant_bits_set(&s3);
        assert!(b3.contains(&4), "NVFP4/W4A4 should match 4-bit");
        assert_eq!(extract_primary_quant_bits(&s3), Some(4));

        // 16-bit: BF16
        let s4 = vec![
            "ByronLeeee/Xiaomi-OCR-0-Ninfer".into(),
            "bf16".into(),
        ];
        let b4 = extract_quant_bits_set(&s4);
        assert!(b4.contains(&16), "BF16 should match 16-bit");
    }
}

pub fn run() {
    let app_start_ms = now_ms();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_window_onscreen(&window);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessState::default())
        .manage(DownloadRegistry::default())
        .manage(TimingState(Mutex::new(StartupTiming {
            app_start_ms,
            before_builder_ms: now_ms(),
            after_build_ms: 0,
            page_load_ms: None,
            splash_shown_ms: None,
            react_mounted_ms: None,
            reported: false,
        })))
        .invoke_handler(tauri::generate_handler![downloads::hf_trending, downloads::hf_search, downloads::hf_list_files, downloads::hf_whoami, downloads::hf_avatar, downloads::hf_download, downloads::hf_download_url, downloads::hf_cancel_download, downloads::hf_pause_download, downloads::hf_clear_download, downloads::ms_trending, downloads::ms_search, downloads::ms_list_files, downloads::ms_avatar, downloads::ms_download, downloads::remove_local_file, downloads::reveal_in_folder, downloads::get_models_dir, downloads::pick_models_dir, config::load_config, config::save_config, process::start_server, process::stop_server, process::get_server_status, process::check_orphan_server, process::kill_orphan_server, system::get_gpu_stats, system::get_gpu_info, system::hardware_info, system::detect_hardware, system::test_proxy_connection, system::get_system_proxy, engines::get_llamacpp_status, engines::check_llamacpp_update, engines::download_llamacpp, engines::cancel_llamacpp_update, app_update::check_app_update, app_update::download_app_update, app_update::cancel_app_update, app_update::install_app_update, process::read_ninfer_request_log, pick_files, pick_folder, engines::pick_server_dir, engines::pick_server_file, expand_paths, inspect_gguf, paths_exist, config::export_config_backup, config::pick_config_backup, pick_directory, open_url, open_config_dir, clipboard_write, set_window_theme, show_main_window, report_startup_timing, set_shortcuts_recording_mode])
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(handle_global_shortcut)
                    .build(),
            )?;
            configure_main_window(app)?;
            setup_tray(app)?;
            if let Ok(config) = read_config(app.handle()) {
                sync_global_shortcuts(app.handle(), &config);
            }
            Ok(())
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



