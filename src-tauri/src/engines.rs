use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::app_update::{
    emit_download_progress, fetch_github_release_with_fallback, stream_download_with_fallback,
    CancelFlag, CancelGuard,
};
use crate::config::{read_config, save_config, AppConfig};
use crate::system::{
    build_net_client, detect_hardware, extract_cuda_full_version, extract_cuda_major_version,
    get_installed_cuda_version, has_cuda_runtime_dll, is_cuda_runtime_complete,
};
use crate::now_ms;
use crate::process::ProcessState;

/// 智能识别引擎架构类型：llamacpp | ninfer | ninfer_kvmem
pub(crate) fn detect_engine_type(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| lower.clone());
    if name.contains("ninfer") && (name.contains("kvmem") || lower.contains("kvmem")) {
        "ninfer_kvmem"
    } else if name.starts_with("ninfer") || name.contains("ninfer") {
        "ninfer"
    } else {
        "llamacpp"
    }
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

/// 在目录树中查找可执行文件：当前目录优先，其次按子目录就近递归，深度上限 6。
pub(crate) fn find_executable(dir: &Path, exe_name: &str, depth: usize) -> Option<PathBuf> {
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

/// 智能探测目录树中的 server 可执行文件（如 llama-server.exe、llama-kvmem-server.exe 等）
pub(crate) fn find_server_executable(dir: &Path, depth: usize) -> Option<PathBuf> {
    let default_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    // 1) 优先查找官方标准名
    if let Some(standard) = find_executable(dir, default_name, depth) {
        return Some(standard);
    }
    // 2) 就近模糊匹配带 server 的分支可执行程序
    find_server_fuzzy(dir, depth)
}

fn find_server_fuzzy(dir: &Path, depth: usize) -> Option<PathBuf> {
    let entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
    let mut candidate_llama_server = None;
    let mut candidate_any_server = None;

    for entry in &entries {
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            let is_exe = if cfg!(windows) {
                name.ends_with(".exe")
            } else {
                !name.contains('.') || name.ends_with(".bin")
            };
            if is_exe {
                // 排除 RPC 节点服务与工具
                if name.contains("rpc") || name.contains("test") || name.contains("bench") || name.contains("quantize") || name.contains("cli") {
                    continue;
                }
                if (name.starts_with("llama") && name.contains("server")) || name.starts_with("ninfer") {
                    candidate_llama_server = Some(path);
                    break;
                } else if (name.contains("server") || name.contains("serve")) && candidate_any_server.is_none() {
                    candidate_any_server = Some(path);
                }
            }
        }
    }
    if let Some(found) = candidate_llama_server.or(candidate_any_server) {
        return Some(found);
    }

    if depth >= 6 {
        return None;
    }
    for entry in entries {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(found) = find_server_fuzzy(&path, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerCandidate {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) rel_path: String,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickServerResult {
    status: String, // "selected" | "multiple" | "none" | "cancelled"
    candidates: Vec<ServerCandidate>,
    selected_path: Option<String>,
}

pub(crate) fn collect_server_candidates(root: &Path, dir: &Path, depth: usize, out: &mut Vec<ServerCandidate>) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let name_lower = name.to_lowercase();
            let is_exe = if cfg!(windows) {
                name_lower.ends_with(".exe")
            } else {
                !name_lower.contains('.') || name_lower.ends_with(".bin")
            };
            if is_exe {
                // 必须明确排除 RPC 节点服务（如 ggml-rpc-server.exe）、命令行客户端、量化/基准测试等非 LLM API 服务
                if name_lower.contains("rpc")
                    || name_lower.contains("test")
                    || name_lower.contains("bench")
                    || name_lower.contains("quantize")
                    || name_lower.contains("cli")
                    || name_lower.contains("simple")
                {
                    continue;
                }
                let is_server = name_lower == "llama-server.exe"
                    || name_lower == "llama-server"
                    || (name_lower.starts_with("llama") && name_lower.contains("server"))
                    || (name_lower.contains("llama") && name_lower.contains("server"))
                    || (name_lower.ends_with("-server.exe") || name_lower.ends_with("_server.exe"))
                    || name_lower == "ninfer-serve.exe"
                    || name_lower == "ninfer-serve"
                    || (name_lower.starts_with("ninfer") && (name_lower.contains("serve") || name_lower.contains("server")));
                if is_server {
                    let rel_path = path.strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| name.clone());
                    let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    out.push(ServerCandidate {
                        name,
                        path: path.to_string_lossy().to_string(),
                        rel_path,
                        size_bytes,
                    });
                }
            }
        } else if path.is_dir() && depth < 6 {
            subdirs.push(path);
        }
    }
    for sub in subdirs {
        collect_server_candidates(root, &sub, depth + 1, out);
    }
}

/// 选择本机 llama.cpp 构建或安装目录，智能定位或返回多个候选程序。
#[tauri::command]
pub(crate) fn pick_server_dir(app: AppHandle) -> Result<PickServerResult, String> {
    let Some(file_path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(PickServerResult {
            status: "cancelled".into(),
            candidates: Vec::new(),
            selected_path: None,
        });
    };
    let Some(folder) = file_path.as_path() else {
        return Ok(PickServerResult {
            status: "cancelled".into(),
            candidates: Vec::new(),
            selected_path: None,
        });
    };

    let mut candidates = Vec::new();
    collect_server_candidates(folder, folder, 0, &mut candidates);

    if candidates.is_empty() {
        return Ok(PickServerResult {
            status: "none".into(),
            candidates: Vec::new(),
            selected_path: None,
        });
    }

    // 排序策略：
    // 1. 官方标准名 llama-server.exe / llama-server 绝对优先；
    // 2. 相对路径浅优先（根目录下的优先于深层子目录 / 副本）；
    // 3. 字典序
    candidates.sort_by(|a, b| {
        let is_std_a = a.name.eq_ignore_ascii_case("llama-server.exe") || a.name == "llama-server";
        let is_std_b = b.name.eq_ignore_ascii_case("llama-server.exe") || b.name == "llama-server";
        if is_std_a != is_std_b {
            return if is_std_a { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        let depth_a = a.rel_path.split(['/', '\\']).count();
        let depth_b = b.rel_path.split(['/', '\\']).count();
        depth_a.cmp(&depth_b).then_with(|| a.name.cmp(&b.name))
    });

    // 统计有多少种【不同名称】的 Server 程序
    let distinct_names: std::collections::HashSet<_> = candidates
        .iter()
        .map(|c| c.name.to_lowercase())
        .collect();

    // 若所有候选文件的程序名称相同（例如只有原版 llama-server.exe，或工程根目录与 build/ 产物重名）：
    // 自动选取最优的一个（最浅层/标准名），零弹窗直接应用！
    if distinct_names.len() <= 1 {
        let path = candidates[0].path.clone();
        Ok(PickServerResult {
            status: "selected".into(),
            candidates,
            selected_path: Some(path),
        })
    } else {
        // 确实存在多种不同名称的分支程序（如 llama-server.exe 与 llama-kvmem-server.exe 并存）：
        // 此时按程序名去重，仅为每种分支保留最优的一条候选供用户点选
        let mut seen = std::collections::HashSet::new();
        let mut unique_candidates = Vec::new();
        for c in candidates {
            if seen.insert(c.name.to_lowercase()) {
                unique_candidates.push(c);
            }
        }
        Ok(PickServerResult {
            status: "multiple".into(),
            candidates: unique_candidates,
            selected_path: None,
        })
    }
}

/// 直接选择具体的 server 可执行文件（如 llama-server.exe、llama-kvmem-server.exe 等）。
/// 用户取消时返回空串。
#[tauri::command]
pub(crate) fn pick_server_file(app: AppHandle) -> Result<String, String> {
    let mut builder = app.dialog().file();
    #[cfg(windows)]
    {
        builder = builder.add_filter("可执行程序 (*.exe)", &["exe"]);
    }
    let Some(file_path) = builder.blocking_pick_file() else {
        return Ok(String::new());
    };
    let Some(path) = file_path.as_path() else {
        return Ok(String::new());
    };
    Ok(path.to_string_lossy().to_string())
}

/* ==================== 阶段三：llama.cpp 获取、解压与原子覆盖 ==================== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlamaCppAsset {
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
pub(crate) struct LlamaCppRelease {
    tag: String,
    assets: Vec<LlamaCppAsset>,
    /// 对应的 CUDA 运行时包（cudart-...zip），仅 cuda 后端时有值
    cudart_assets: Vec<LlamaCppAsset>,
    match_backend: String,
    match_asset: Option<LlamaCppAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlamaCppLocalStatus {
    install_dir: String,
    local_version: Option<String>,
    local_backend: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cuda_version: Option<String>,
    server_available: bool,
    server_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine_type: Option<String>,
}

/// llama.cpp 官方仓库（2024 起迁移到 ggml-org，旧 ggerganov 已 301 重定向）。
const LLAMA_CPP_REPO: &str = "ggml-org/llama.cpp";
fn llama_api_base() -> String {
    format!("https://api.github.com/repos/{}", LLAMA_CPP_REPO)
}

fn llama_exe_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
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

/// 读取本地安装状态（纯本地逻辑，不访问网络）。支持指定 custom_path 检测特定分支或目录。
#[tauri::command]
pub(crate) fn get_llamacpp_status(app: AppHandle, custom_path: Option<String>) -> Result<LlamaCppLocalStatus, String> {
    let config = read_config(&app)?;
    let (server_path, install_dir) = if let Some(target) = custom_path.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(target);
        if p.is_file() {
            let parent = p.parent().map(|dir| dir.to_path_buf()).unwrap_or_else(|| p.clone());
            (Some(p), parent)
        } else if p.is_dir() {
            let exe = find_server_executable(&p, 0);
            (exe, p)
        } else {
            (None, p)
        }
    } else {
        // 先检查配置中当前激活引擎的路径
        let active_engine_path = {
            let active_id = config.active_engine_id.as_deref().unwrap_or_default();
            config.engines.iter().find(|e| e.id == active_id).map(|e| e.path.trim().to_string())
        }.filter(|s| !s.is_empty());

        let target_str = active_engine_path.unwrap_or_else(|| config.server_path.trim().to_string());
        if !target_str.is_empty() {
            let p = PathBuf::from(&target_str);
            if p.is_file() {
                let parent = p.parent().map(|dir| dir.to_path_buf()).unwrap_or_else(|| p.clone());
                (Some(p), parent)
            } else if p.is_dir() {
                let exe = find_server_executable(&p, 0);
                (exe, p)
            } else {
                (None, p)
            }
        } else {
            let install_dir = llamacpp_root(&app, &config)?;
            let server_path = if install_dir.exists() {
                find_server_executable(&install_dir, 0)
            } else {
                None
            };
            (server_path, install_dir)
        }
    };

    let mut local_backend = "cpu".into();
    let mut local_version = None;
    if let Some(exe) = server_path.as_ref() {
        let exe_str = exe.to_string_lossy().to_string();
        let engine_type = detect_engine_type(&exe_str);
        let bin_dir = exe.parent().unwrap_or(&install_dir).to_path_buf();

        if engine_type == "ninfer" || engine_type == "ninfer_kvmem" {
            local_backend = "cuda".into();
            let mut local_cuda_version = None;
            let build_info_candidates = [
                bin_dir.join("BUILD-INFO.json"),
                bin_dir.parent().map(|p| p.join("BUILD-INFO.json")).unwrap_or_default(),
                bin_dir.parent().and_then(|p| p.parent()).map(|p| p.join("BUILD-INFO.json")).unwrap_or_default(),
            ];
            for cand in &build_info_candidates {
                if cand.is_file() {
                    if let Ok(content) = fs::read_to_string(cand) {
                        if let Ok(info) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Some(rel) = info.get("release").and_then(|v| v.as_str()) {
                                local_version = Some(rel.to_string());
                            }
                            if let Some(cuda) = info.pointer("/build/cuda_version").and_then(|v| v.as_str()) {
                                local_cuda_version = Some(cuda.to_string());
                            }
                            break;
                        }
                    }
                }
            }
            if local_cuda_version.is_none() {
                local_cuda_version = get_installed_cuda_version(&bin_dir);
            }
            if local_version.is_none() {
                local_version = Some(if engine_type == "ninfer_kvmem" { "KVMem-sm120a".into() } else { "NInfer".into() });
            }
            return Ok(LlamaCppLocalStatus {
                install_dir: install_dir.to_string_lossy().to_string(),
                local_version,
                local_backend,
                cuda_version: local_cuda_version,
                server_available: true,
                server_path: Some(exe_str),
                engine_type: Some(engine_type.to_string()),
            });
        }

        local_version = local_llamacpp_version(&bin_dir);
        // 如果未通过目录提取到构建版本号，尝试读取匹配引擎配置中的 version
        if local_version.is_none() {
            if let Some(matched) = config.engines.iter().find(|e| {
                if let Some(active_id) = config.active_engine_id.as_deref() {
                    if e.id == active_id { return true; }
                }
                e.path.eq_ignore_ascii_case(&exe_str)
            }) {
                local_version = matched.version.clone();
            }
        }
        // 优先读安装时写入的 backend.txt，回退按路径名与 DLL 推断
        if let Ok(text) = fs::read_to_string(bin_dir.join("backend.txt")) {
            let value = text.trim().to_lowercase();
            if value == "cuda" || value == "vulkan" || value == "cpu" {
                local_backend = value;
            }
        } else {
            let path_text = bin_dir.to_string_lossy().to_lowercase();
            let has_cuda = path_text.contains("cuda") || has_cuda_runtime_dll(&bin_dir, "13") || has_cuda_runtime_dll(&bin_dir, "12") || has_cuda_runtime_dll(&bin_dir, "11");
            let has_vulkan = path_text.contains("vulkan") || bin_dir.join("vulkan-1.dll").is_file();
            local_backend = if has_cuda { "cuda" } else if has_vulkan { "vulkan" } else { "cpu" }.into();
        }
        let mut local_cuda_version = None;
        if local_backend == "cuda" {
            local_cuda_version = get_installed_cuda_version(&bin_dir);
            if local_cuda_version.is_none() {
                if let Some(matched) = config.engines.iter().find(|e| {
                    if let Some(active_id) = config.active_engine_id.as_deref() {
                        if e.id == active_id { return true; }
                    }
                    e.path.eq_ignore_ascii_case(&exe_str)
                }) {
                    local_cuda_version = matched.cuda_version.clone();
                }
            }
        }
        return Ok(LlamaCppLocalStatus {
            install_dir: install_dir.to_string_lossy().to_string(),
            local_version,
            local_backend,
            cuda_version: local_cuda_version,
            server_available: server_path.as_ref().map(|p| p.is_file()).unwrap_or(false),
            server_path: server_path.map(|path| path.to_string_lossy().to_string()),
            engine_type: Some("llamacpp".into()),
        });
    }
    Ok(LlamaCppLocalStatus {
        install_dir: install_dir.to_string_lossy().to_string(),
        local_version,
        local_backend,
        cuda_version: None,
        server_available: false,
        server_path: None,
        engine_type: None,
    })
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
        let cuda_full_version = if backend == "cuda" { extract_cuda_full_version(&lower) } else { String::new() };
        let cuda_version = if backend == "cuda" { extract_cuda_major_version(&cuda_full_version) } else { String::new() };
        out.push(LlamaCppAsset { backend: backend.into(), cuda_version, cuda_full_version, file_name: name.to_string(), url, size });
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
        let cuda_version = extract_cuda_major_version(&cuda_full_version);
        out.push(LlamaCppAsset { backend: "cuda".into(), cuda_version, cuda_full_version, file_name: name.to_string(), url, size });
    }
    out
}

/// 根据主构建的 CUDA 完整版本匹配运行时包：优先精确版本，其次同主版本，最后任意 cuda。
fn pick_cudart_asset<'a>(assets: &'a [LlamaCppAsset], cuda_full: &str) -> Option<&'a LlamaCppAsset> {
    if cuda_full.is_empty() {
        return assets.iter().find(|asset| asset.backend == "cuda");
    }
    let major = extract_cuda_major_version(cuda_full);
    assets
        .iter()
        .find(|asset| asset.cuda_full_version == cuda_full)
        .or_else(|| assets.iter().find(|asset| !major.is_empty() && asset.cuda_version == major))
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
            // 指定了 CUDA 主版本则精确匹配；若传入 "13.4" 或 "13" 均能命中
            let version = if cuda_version == "auto" || cuda_version.is_empty() { "12" } else { cuda_version };
            let version_major = extract_cuda_major_version(version);
            assets
                .iter()
                .find(|asset| {
                    asset.backend == "cuda"
                        && (asset.cuda_version == version
                            || asset.cuda_full_version == version
                            || (!version_major.is_empty() && (asset.cuda_version == version_major || asset.cuda_full_version.starts_with(&version_major))))
                })
                .or_else(|| {
                    if cuda_version == "auto" || cuda_version.is_empty() {
                        assets.iter().find(|asset| asset.backend == "cuda" && (asset.cuda_version == "13" || asset.cuda_full_version.starts_with("13")))
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
pub(crate) async fn check_llamacpp_update(app: AppHandle, backend: Option<String>, cuda_version: Option<String>) -> Result<LlamaCppRelease, String> {
    tauri::async_runtime::spawn_blocking(move || check_llamacpp_update_impl(&app, backend, cuda_version))
        .await
        .map_err(|error| format!("检查更新任务中断：{}", error))?
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
fn extract_zip_archive(cancel: CancelFlag, zip_path: &Path, dest_dir: &Path, app: &AppHandle) -> Result<(), String> {
    emit_download_progress(app, "extract", 0, 0, 0, 0, "开始解压");
    let file = fs::File::open(zip_path).map_err(|error| format!("打开压缩包失败：{}", error))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("读取压缩包失败：{}", error))?;
    let total_entries = archive.len();
    for index in 0..total_entries {
        if cancel.cancelled() {
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
    // 保留旧目录中目标目录缺失的 DLL（如 cudart 等 CUDA 运行时）及元数据文件，best effort
    if backup.exists() {
        if let Ok(entries) = fs::read_dir(&backup) {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_dll = path.extension().map(|ext| ext.eq_ignore_ascii_case("dll")).unwrap_or(false);
                let is_cuda_meta = path.file_name().map(|n| n == "cuda_version.txt").unwrap_or(false);
                if (!is_dll && !is_cuda_meta) || !path.is_file() {
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

/// llama.cpp 引擎更新链路的取消标志（与应用自更新互不影响）。
static LLAMACPP_UPDATE_CANCEL: AtomicBool = AtomicBool::new(false);

/// 取消正在进行的 llama.cpp 更新（下载 / 解压阶段）。
#[tauri::command]
pub(crate) fn cancel_llamacpp_update() -> Result<(), String> {
    CancelFlag(&LLAMACPP_UPDATE_CANCEL).cancel();
    Ok(())
}

/// 一键更新 / 重新安装 llama.cpp（内部阻塞实现）。
fn download_llamacpp_impl(app: AppHandle, backend: String, cuda_version: Option<String>, asset_url: Option<String>, asset_name: Option<String>, tag: Option<String>) -> Result<String, String> {
    // 引擎更新链路：RAII 守卫负责在任何退出路径复位取消标志（只影响本链路，不波及应用自更新）
    let cancel = CancelFlag(&LLAMACPP_UPDATE_CANCEL);
    let _guard = CancelGuard(cancel);
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
    if let Err(error) = stream_download_with_fallback(cancel, &client, &download_url, &zip_path, &app) {
        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_dir_all(&temp_root);
        return Err(error);
    }
    if let Err(error) = extract_zip_archive(cancel, &zip_path, &extract_dir, &app) {
        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_dir_all(&temp_root);
        return Err(error);
    }

    // 4.5) cuda 后端：检查是否需要配套的 cudart 运行时包。
    // 若当前安装目录中已具备同主版本且完整的 CUDA 运行时 DLL（如 cudart64_12.dll + cublas64_12.dll），
    // 且 CUDA 版本未发生变化，则无需重新下载与解压 CUDA 运行时包，直接复用现有环境！
    if backend == "cuda" && !cudart_url.is_empty() && !cudart_name.is_empty() {
        let target_cuda_major = if !cuda_full.is_empty() {
            extract_cuda_major_version(&cuda_full)
        } else {
            extract_cuda_major_version(&file_name)
        };

        let installed_cuda = get_installed_cuda_version(&target);
        let runtime_complete = !target_cuda_major.is_empty() && is_cuda_runtime_complete(&target, &target_cuda_major);
        let same_version = installed_cuda
            .as_deref()
            .map(|v| extract_cuda_major_version(v) == target_cuda_major)
            .unwrap_or(false);

        if runtime_complete && same_version {
            let display_ver = if !cuda_full.is_empty() { cuda_full.as_str() } else { target_cuda_major.as_str() };
            emit_download_progress(&app, "install", 0, 0, 0, 0, format!("检测到已有完整的 CUDA {} 运行时且未发生变更，复用现有环境，跳过下载", display_ver));
        } else {
            let cache_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("llamacpp_cache");
            fs::create_dir_all(&cache_dir).map_err(|e| format!("创建 CUDA 缓存目录失败：{}", e))?;
            let cached_zip = cache_dir.join(&cudart_name);
            let mut need_download = false;
            if cached_zip.exists() {
                emit_download_progress(&app, "extract", 0, 0, 0, 0, format!("使用本地缓存的 CUDA 运行时 {}", cudart_name));
                if let Err(_error) = extract_zip_archive(cancel, &cached_zip, &extract_dir, &app) {
                    // 缓存损坏：删除后重新下载
                    let _ = fs::remove_file(&cached_zip);
                    need_download = true;
                }
            } else {
                need_download = true;
            }
            if need_download {
                emit_download_progress(&app, "download", 0, 0, 0, 0, format!("正在下载 CUDA 运行时 {}", cudart_name));
                if let Err(error) = stream_download_with_fallback(cancel, &client, &cudart_url, &cached_zip, &app) {
                    let _ = fs::remove_file(&cached_zip);
                    let _ = fs::remove_dir_all(&temp_root);
                    return Err(format!("下载 CUDA 运行时失败：{}", error));
                }
                if let Err(error) = extract_zip_archive(cancel, &cached_zip, &extract_dir, &app) {
                    let _ = fs::remove_file(&cached_zip);
                    let _ = fs::remove_dir_all(&temp_root);
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
        return Err(error);
    }
    if backend == "cuda" && !cuda_full.is_empty() {
        let _ = fs::write(target.join("cuda_version.txt"), format!("{}\n", cuda_full));
    }

    // 7) 更新配置：serverPath 指向新引擎，并持久化安装目录；若当前在多分支中，同步更新该分支信息
    let new_server_path = find_executable(&target, llama_exe_name(), 0)
        .ok_or("安装后未找到 llama-server.exe".to_string())?;
    let mut updated = read_config(&app)?;
    let new_path_str = new_server_path.to_string_lossy().to_string();
    updated.server_path = new_path_str.clone();
    updated.llamacpp_dir = Some(target.to_string_lossy().to_string());
    updated.llama_backend = Some(backend.clone());
    if backend == "cuda" {
        if !cuda_full.is_empty() {
            updated.llama_cuda_version = Some(cuda_full.clone());
        } else if let Some(v) = cuda_version.as_ref() {
            updated.llama_cuda_version = Some(v.clone());
        }
    }
    let saved_cuda_ver = if backend == "cuda" {
        if !cuda_full.is_empty() {
            Some(cuda_full.clone())
        } else {
            get_installed_cuda_version(&target)
        }
    } else {
        None
    };
    if let Some(active_id) = updated.active_engine_id.as_ref() {
        if let Some(active_eng) = updated.engines.iter_mut().find(|e| &e.id == active_id) {
            active_eng.path = new_path_str.clone();
            active_eng.backend = Some(backend.clone());
            active_eng.cuda_version = saved_cuda_ver.clone();
            active_eng.version = Some(version.clone());
        }
    } else if !updated.engines.is_empty() {
        updated.engines[0].path = new_path_str.clone();
        updated.engines[0].backend = Some(backend.clone());
        updated.engines[0].cuda_version = saved_cuda_ver;
        updated.engines[0].version = Some(version.clone());
    }
    save_config(app.clone(), updated)?;

    // 8) 清理临时的下载与解压文件
    let _ = fs::remove_file(&zip_path);
    let _ = fs::remove_dir_all(&temp_root);
    emit_download_progress(&app, "done", 100, 0, 0, 0, "更新完成");
    Ok(new_server_path.to_string_lossy().to_string())
}

/// 一键更新 / 重新安装 llama.cpp：检查服务未运行 -> 解析资产 -> 下载 -> 解压 -> 原子替换 -> 更新配置。
#[tauri::command]
pub(crate) async fn download_llamacpp(app: AppHandle, backend: String, cuda_version: Option<String>, asset_url: Option<String>, asset_name: Option<String>, tag: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || download_llamacpp_impl(app, backend, cuda_version, asset_url, asset_name, tag))
        .await
        .map_err(|error| format!("更新任务中断：{}", error))?
}



