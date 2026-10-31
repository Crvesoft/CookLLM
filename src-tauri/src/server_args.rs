use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::config::read_config;
use crate::engines::detect_engine_type;

/// NInfer 结构化请求日志的增量读取游标：offset 指向下一次读取起点
pub(crate) struct RequestLogTail {
    pub(crate) path: PathBuf,
    pub(crate) offset: u64,
}

/// 一次服务启动所需的完整命令行计划：参数构建与进程生命周期解耦。
pub(crate) struct ServerLaunchPlan {
    pub(crate) command: Command,
    pub(crate) engine_type: String,
    pub(crate) engine_name: String,
    pub(crate) engine_backend: Option<String>,
    pub(crate) model_id: String,
    pub(crate) model_name: String,
    pub(crate) profile_id: String,
    pub(crate) profile_name: String,
    pub(crate) port: u16,
    pub(crate) request_log: Option<RequestLogTail>,
}

/// 自动发现官方 device-profiles.json 并智能同步/补全硬件优化路由到隔离缓存中。
/// 既保持了不同引擎路径之间的隔离防踩踏，又确保官方精心校准的 67 条 SM120/CUDA 优化内核路线（如 GDN 与 Attention 路由）100% 生效。
fn sync_official_device_profile_routes(engine_path: &str, isolated_path: &std::path::Path, target_schema: i64) {
    use std::path::{Path, PathBuf};
    let engine_file = Path::new(engine_path);
    let engine_dir = match engine_file.parent() {
        Some(d) => d,
        None => return,
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = engine_dir.parent() {
        candidates.push(parent.join("config").join("device-profiles.json"));
        candidates.push(parent.join("device-profiles.json"));
    }
    candidates.push(engine_dir.join("config").join("device-profiles.json"));
    candidates.push(engine_dir.join("device-profiles.json"));

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let base = Path::new(&local_app_data).join("NInferManager");
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                let sub = entry.path().join("config").join("device-profiles.json");
                if sub.is_file() {
                    candidates.push(sub);
                }
            }
        }
    }

    let official_path = match candidates.into_iter().find(|p| p.is_file()) {
        Some(p) => p,
        None => {
            if isolated_path.is_file() {
                ensure_device_profile_schema(isolated_path, target_schema);
            }
            return;
        }
    };

    if !isolated_path.is_file() {
        let _ = std::fs::copy(&official_path, isolated_path);
        ensure_device_profile_schema(isolated_path, target_schema);
        return;
    }

    let official_content = match std::fs::read_to_string(&official_path) {
        Ok(c) => c,
        Err(_) => {
            ensure_device_profile_schema(isolated_path, target_schema);
            return;
        }
    };
    let official_json: serde_json::Value = match serde_json::from_str(&official_content) {
        Ok(j) => j,
        Err(_) => {
            ensure_device_profile_schema(isolated_path, target_schema);
            return;
        }
    };

    let isolated_content = match std::fs::read_to_string(isolated_path) {
        Ok(c) => c,
        Err(_) => {
            ensure_device_profile_schema(isolated_path, target_schema);
            return;
        }
    };
    let mut isolated_json: serde_json::Value = match serde_json::from_str(&isolated_content) {
        Ok(j) => j,
        Err(_) => {
            ensure_device_profile_schema(isolated_path, target_schema);
            return;
        }
    };

    let mut changed = false;
    if let (Some(off_devices), Some(iso_devices)) = (
        official_json.get("devices").and_then(|v| v.as_array()),
        isolated_json.get_mut("devices").and_then(|v| v.as_array_mut()),
    ) {
        for off_dev in off_devices {
            let hw_class = off_dev.get("hardware_class").and_then(|v| v.as_str()).unwrap_or("");
            if hw_class.is_empty() {
                continue;
            }
            let off_routes = match off_dev.get("routes").and_then(|v| v.as_object()) {
                Some(r) => r,
                None => continue,
            };

            let iso_dev = iso_devices.iter_mut().find(|d| {
                d.get("hardware_class").and_then(|v| v.as_str()) == Some(hw_class)
            });

            if let Some(target_dev) = iso_dev {
                if let Some(iso_routes) = target_dev.get_mut("routes").and_then(|v| v.as_object_mut()) {
                    for (route_key, route_val) in off_routes {
                        let need_update = match iso_routes.get(route_key) {
                            None => true,
                            Some(val) => val != route_val,
                        };
                        if need_update {
                            iso_routes.insert(route_key.clone(), route_val.clone());
                            changed = true;
                        }
                    }
                }
            } else {
                iso_devices.push(off_dev.clone());
                changed = true;
            }
        }
    }

    if changed {
        if let Ok(serialized) = serde_json::to_string_pretty(&isolated_json) {
            let _ = std::fs::write(isolated_path, serialized);
        }
    }
    ensure_device_profile_schema(isolated_path, target_schema);
}

/// 自动发现引擎目录自带或 NInferManager 配置的官方 chat_template.jinja 对话模板绝对路径。
fn find_official_chat_template(engine_path: &str) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};
    let engine_file = Path::new(engine_path);
    let engine_dir = engine_file.parent()?;

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = engine_dir.parent() {
        candidates.push(parent.join("config").join("chat_template.jinja"));
        candidates.push(parent.join("chat_template.jinja"));
    }
    candidates.push(engine_dir.join("config").join("chat_template.jinja"));
    candidates.push(engine_dir.join("chat_template.jinja"));

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let base = Path::new(&local_app_data).join("NInferManager");
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                let sub = entry.path().join("config").join("chat_template.jinja");
                if sub.is_file() {
                    candidates.push(sub);
                }
            }
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// 确保 device-profiles.json 符合引擎所需的 schema_version 规范（标准 ninfer 为 1，ninfer_kvmem 为 2）。
/// 彻底修复不同引擎版本间 schema 不兼容导致引擎报
/// "not a ninfer.device-route-profiles v1 document" 或 "this build reads only version 2; recalibrate"
/// 并触发持续数十秒满载重复标定的严重缺陷。
pub(crate) fn ensure_device_profile_schema(path: &std::path::Path, expected_version: i64) {
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
            let is_device_route = json.get("schema")
                .and_then(|v| v.as_str())
                .map(|s| s == "ninfer.device-route-profiles")
                .unwrap_or(false);
            let version = json.get("schema_version").and_then(|v| v.as_i64()).unwrap_or(0);
            if is_device_route && version != expected_version {
                json["schema_version"] = serde_json::json!(expected_version);
                if let Ok(serialized) = serde_json::to_string_pretty(&json) {
                    let _ = std::fs::write(path, serialized);
                }
            }
        }
    }
}

/// 自动发现引擎目录自带或 NInferManager 配置的官方 device-profiles.json 硬件标定文件绝对路径。
fn find_official_device_profile(engine_path: &str, is_kvmem: bool) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};
    let engine_file = Path::new(engine_path);
    let engine_dir = engine_file.parent()?;

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = engine_dir.parent() {
        candidates.push(parent.join("config").join("device-profiles.json"));
        candidates.push(parent.join("device-profiles.json"));
    }
    candidates.push(engine_dir.join("config").join("device-profiles.json"));
    candidates.push(engine_dir.join("device-profiles.json"));

    // 注意：LOCALAPPDATA/NInferManager 属于标准 Ninfer 官方管理器的配置目录（schema_version: 1），
    // 仅在标准 ninfer 引擎下作为候选；对于 ninfer_kvmem 绝不直接返回此路径，避免互相踩踏与 schema 冲突。
    if !is_kvmem {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let base = Path::new(&local_app_data).join("NInferManager");
            if let Ok(entries) = std::fs::read_dir(&base) {
                for entry in entries.flatten() {
                    let sub = entry.path().join("config").join("device-profiles.json");
                    if sub.is_file() {
                        candidates.push(sub);
                    }
                }
            }
        }
    }

    let found = candidates.into_iter().find(|p| p.is_file());
    if let Some(ref p) = found {
        let expected_schema = if is_kvmem { 2 } else { 1 };
        ensure_device_profile_schema(p, expected_schema);
    }
    found
}

pub(crate) fn build_server_launch(app: &AppHandle, model_id: &str, profile_id: &str) -> Result<ServerLaunchPlan, String> {
    let config = read_config(app)?;
    let model = config.models.iter().find(|item| item.id == model_id).cloned().ok_or("未找到模型配置")?;
    let profile = model.profiles.iter().find(|item| item.id == profile_id)
        .or_else(|| config.profiles.iter().find(|item| item.id == profile_id))
        .cloned().ok_or("未找到运行预设")?;

    // 对外模型名：重命名（displayName）优先，无重命名时回退默认名；
    // API 请求（--alias / --model-id）、托盘与状态栏均以此为准
    let model_display_name = model
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(model.name.as_str())
        .to_string();

    let (chosen_path, engine_display_name, engine_display_backend) = if let Some(ref eid) = profile.engine_id.filter(|s| !s.trim().is_empty()) {
        let engine = config.engines.iter().find(|e| &e.id == eid)
            .ok_or_else(|| format!("未找到预设关联的引擎分支（ID: {}），请在预设中重新选择引擎或在设置中恢复该分支", eid))?;
        (engine.path.clone(), engine.name.clone(), engine.backend.clone())
    } else {
        let active_eng = config.active_engine_id.as_ref()
            .and_then(|aid| config.engines.iter().find(|e| &e.id == aid));
        let name = active_eng.map(|e| e.name.clone()).unwrap_or_else(|| "默认引擎".to_string());
        let backend = active_eng.and_then(|e| e.backend.clone());
        (config.server_path.clone(), name, backend)
    };

    if chosen_path.trim().is_empty() {
        return Err("请先在设置中指定 Server 可执行文件（如 llama-server.exe 或分支版本）".into());
    }
    if !PathBuf::from(&chosen_path).exists() {
        return Err(format!("引擎 Server 文件不存在：{}", chosen_path));
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
    let engine_type = detect_engine_type(&chosen_path);
    let mtp_draft_path = profile.mtp_draft_path.as_deref().filter(|p| !p.trim().is_empty());
    let resolved_spec_mode = profile.spec_type.as_deref().unwrap_or_else(|| {
        if profile.mtp {
            "mtp"
        } else if mtp_draft_path.is_some() {
            "draft"
        } else {
            "none"
        }
    });
    if engine_type != "ninfer" && engine_type != "ninfer_kvmem" {
        if resolved_spec_mode == "dflash" || resolved_spec_mode == "draft" {
            let draft = mtp_draft_path.ok_or_else(|| {
                if resolved_spec_mode == "dflash" {
                    "已启用 DFlash 投机采样，但未指定伴随草稿模型路径（-md）".to_string()
                } else {
                    "已启用外置草稿模型，但未指定草稿模型路径（-md）".to_string()
                }
            })?;
            if !PathBuf::from(draft).exists() {
                return Err(format!("Draft/DFlash 草稿模型不存在：{}", draft));
            }
        }
    }

    // 解析 extra_args 用于防冲突去重检测与后续参数拼接
    let extra_tokens = shlex::split(&profile.extra_args).unwrap_or_default();
    let has_extra_arg = |flag: &str| -> bool {
        extra_tokens.iter().any(|arg| arg == flag || arg.starts_with(&format!("{flag}=")))
    };

    let mut command = Command::new(&chosen_path);
    // 自动将子进程工作目录（Cwd）切换到引擎根目录（如 E:\AI\ninfer-run），
    // 确保与 NInferManager 官方启动机制 100% 一致，使相对路径（如 config/...）与引擎模块平滑加载
    if let Some(engine_dir) = std::path::Path::new(&chosen_path).parent() {
        let working_dir = if (engine_type == "ninfer" || engine_type == "ninfer_kvmem")
            && engine_dir.parent().map(|p| p.join("config").is_dir()).unwrap_or(false)
        {
            engine_dir.parent().unwrap()
        } else {
            engine_dir
        };
        command.current_dir(working_dir);

        // 自动探测并注入 unified 包自带的 runtime/cuda 动态库目录至 PATH，
        // 解决 CUDA 13/12 等外部 cuBLAS 依赖 (如 cublas64_13.dll、cublasLt64_13.dll) 缺失导致的弹窗与退出
        let mut current_ancestor = Some(engine_dir);
        let mut found_cuda_dir = None;
        for _ in 0..4 {
            if let Some(dir) = current_ancestor {
                let cand = dir.join("runtime").join("cuda");
                if cand.is_dir() {
                    found_cuda_dir = Some(cand);
                    break;
                }
                current_ancestor = dir.parent();
            } else {
                break;
            }
        }
        if let Some(cuda_dir) = found_cuda_dir {
            let current_path = std::env::var_os("PATH").unwrap_or_default();
            let mut new_path = cuda_dir.into_os_string();
            #[cfg(windows)]
            new_path.push(";");
            #[cfg(not(windows))]
            new_path.push(":");
            new_path.push(&current_path);
            command.env("PATH", new_path);
        }
    }
    // NInfer 结构化请求日志 tail 游标（第 14 节填充；llama.cpp 引擎保持 None）
    let mut ninfer_request_log_tail: Option<RequestLogTail> = None;

    if engine_type == "ninfer" || engine_type == "ninfer_kvmem" {
        // 0. 注入官方关键环境变量：跳过 Qwen 非必需的 Prefill 网格强制重排
        command.env("NINFER_PREFILL_ALIGN", "0");

        // 1. 模型路径：必须作为首个位置参数，绝对不能加 -m
        command.arg(&model.path);

        // 1.5 对外 API 模型名：重命名优先；用户 extra_args 显式传 --model-id 时不覆盖
        if !has_extra_arg("--model-id") {
            command.arg("--model-id").arg(&model_display_name);
        }

        // 2. 基础网络监听
        command
            .arg("--host").arg(&profile.host)
            .arg("--port").arg(profile.port.to_string())
            .arg("--cors");

        // 3. 上下文与槽位
        command
            .arg("--max-context").arg(profile.context_size.to_string())
            .arg("--max-concurrency").arg(profile.parallel.clamp(1, 8).to_string());

        // 3.5 默认输出上限 (--default-max-tokens)：
        // - 标准 NInfer (engine_type == "ninfer")：官方服务端硬编码缺省为 8192；若用户配置 0 (不设限) 或未设置，
        //   必须显式传 `--default-max-tokens 0` 才能生效为「生成直到上下文耗尽」，否则长思考/长输出会在 8192 token 处被截断报 output limit 并显示 Reasoning Cancelled。
        // - NInfer-KVMem (engine_type == "ninfer_kvmem")：要求参数必须为正数 (若传 0 会报 “--default-max-tokens must be positive”)，
        //   且 KVMem 服务端在缺省不传时会自动采用全局最大可用配额；因此 KVMem 仅当 tokens > 0 时才传递。
        if !has_extra_arg("--default-max-tokens") {
            let tokens = profile.default_max_tokens.unwrap_or(0);
            if engine_type == "ninfer" {
                command.arg("--default-max-tokens").arg(tokens.to_string());
            } else if tokens > 0 {
                command.arg("--default-max-tokens").arg(tokens.to_string());
            }
        }

        // 4. 预填充分块
        let prefill_chunk = profile.prefill_chunk.unwrap_or_else(|| {
            let b = profile.batch_size;
            if b > 0 && b % 128 == 0 { b } else { 256 }
        });
        command.arg("--prefill-chunk").arg(prefill_chunk.to_string());

        // 5. 快速预填充核函数（默认关闭）
        if profile.fast_prefill_kernel.unwrap_or(false) && !has_extra_arg("--fast-prefill-kernel") {
            command.arg("--fast-prefill-kernel");
        }

        // 5.5 GDN 循环状态 FP16（Swift / Qwen3.8 等 GDN 架构模型默认开启，大幅降低 Decode 显存读写带宽）
        if profile.gdn_state_fp16.unwrap_or(true) && !has_extra_arg("--gdn-state-fp16") {
            command.arg("--gdn-state-fp16");
        }

        // 5.6 混合前缀缓存优化与快照槽位（--use-alt-prefix-caching）
        // 注意：ninfer-kvmem-server 引擎独占接管会话历史缓存（exclusive ownership of history caching），
        // 传递 --use-alt-prefix-caching 或 --device-snapshot-slots 会与 KVMem 专属分层调度器冲突并导致拒启，
        // 因此前缀缓存与快照槽位仅在标准 ninfer 引擎下传递。
        if engine_type == "ninfer" {
            if profile.use_alt_prefix_caching.unwrap_or(true) && !has_extra_arg("--use-alt-prefix-caching") {
                command.arg("--use-alt-prefix-caching");
            }
            if let Some(slots) = profile.device_snapshot_slots {
                if slots > 0 && !has_extra_arg("--device-snapshot-slots") {
                    command.arg("--device-snapshot-slots").arg(slots.to_string());
                }
            }
        }

        // 6. KV 数据类型量化
        if !has_extra_arg("--kv-dtype") {
            let kv_dtype = profile.kv_dtype.as_deref().unwrap_or("k8v4").trim();
            if !kv_dtype.is_empty() {
                command.arg("--kv-dtype").arg(kv_dtype.to_lowercase());
            }
        }

        // 7. GPU 设备索引与硬件调优
        let device = profile.device_index.unwrap_or(0);
        command.arg("--device").arg(device.to_string());

        let device_profile = profile.device_profile.as_deref().unwrap_or("off");
        if !has_extra_arg("--device-profile") {
            command.arg("--device-profile").arg(device_profile);
        }

        // 7.2 设备 profile 文件路径 (--device-profile-path FILE)
        // 防踩踏隔离策略：若用户未显式传 --device-profile-path，且选择了 auto/calibrate 硬件标定，
        // 则按当前引擎执行程序的绝对路径计算隔离存储文件。
        // 同时自动发现官方 device-profiles.json 并智能同步/补全到隔离文件，按引擎架构匹配对应的 schema_version（标准 ninfer 为 1，KVMem 为 2），
        // 确保官方精心校准的 67 条 SM120/CUDA 优化内核路线（如 GDN 与 Attention 路由）100% 生效，启动即加载无需重标定。
        let is_kvmem = engine_type == "ninfer_kvmem";
        let target_schema: i64 = if is_kvmem { 2 } else { 1 };

        if let Some(ref path) = profile.device_profile_path {
            let p = path.trim();
            if !p.is_empty() && !has_extra_arg("--device-profile-path") {
                ensure_device_profile_schema(std::path::Path::new(p), target_schema);
                command.arg("--device-profile-path").arg(p);
            }
        } else if device_profile != "off" && !has_extra_arg("--device-profile-path") {
            if let Some(official_device_profile) = find_official_device_profile(&chosen_path, is_kvmem) {
                // 若发现官方自带或 NInferManager 配置的 device-profiles.json，直接以绝对路径传递，
                // 与 NInfer 官方启动机制 100% 一致，避免中间缓存同步脱节
                command.arg("--device-profile-path").arg(official_device_profile);
            } else if let Ok(app_dir) = app.path().app_data_dir() {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                chosen_path.to_lowercase().hash(&mut hasher);
                let hash_hex = format!("{:016x}", hasher.finish());
                let profiles_dir = app_dir.join("device_profiles");
                let _ = std::fs::create_dir_all(&profiles_dir);
                let isolated_path = profiles_dir.join(format!("profile_{}.json", hash_hex));
                sync_official_device_profile_routes(&chosen_path, &isolated_path, target_schema);
                command.arg("--device-profile-path").arg(isolated_path);
            }
        }

        // 7.3 对话模板路径 (--chat-template FILE)
        if let Some(ref path) = profile.chat_template_path {
            let p = path.trim();
            if !p.is_empty() && !has_extra_arg("--chat-template") {
                command.arg("--chat-template").arg(p);
            }
        } else if !has_extra_arg("--chat-template") {
            if let Some(official_template) = find_official_chat_template(&chosen_path) {
                command.arg("--chat-template").arg(official_template);
            }
        }

        // 7.5 CUDA Graph 驱动状态预留显存（NInfer 官方模板 72 MiB；与 device-profile auto 配套）
        if let Some(allowance) = profile.cuda_graph_allowance_mib {
            if !has_extra_arg("--cuda-graph-allowance-mib") {
                command.arg("--cuda-graph-allowance-mib").arg(allowance.to_string());
            }
        }

        // 8. 显存策略
        // 注意：KVMem 引擎具有自身严格的显存分层与历史缓存接管（exclusive ownership of history caching），
        // 传递 --cuda-memory-policy 会破坏 KVMem 历史独占权并导致 ninfer-kvmem-server 启动报错拒绝服务。
        // 因此 --cuda-memory-policy 仅在标准 ninfer 引擎下生效。
        if engine_type == "ninfer" {
            if let Some(ref policy) = profile.cuda_memory_policy {
                if !policy.is_empty() && !has_extra_arg("--cuda-memory-policy") {
                    command.arg("--cuda-memory-policy").arg(policy);
                }
            }
        }

        // 9. 投机采样 (MTP / DFlash / DFlash2 / Draft)
        // KVMem 引擎默认开启投机采样，但后端算法与草稿宽度均可配置（--spec mtp|dflash|dflash2）。
        let need_spec = if engine_type == "ninfer_kvmem" {
            profile.spec_mtp.unwrap_or(true)
        } else {
            profile.spec_mtp.unwrap_or(profile.mtp)
        };

        if need_spec && !has_extra_arg("--spec") {
            let spec_mode = match profile.ninfer_spec_type.as_deref() {
                Some("dflash2") => "dflash2",
                Some("dflash") => "dflash",
                _ => "mtp",
            };
            command.arg("--spec").arg(spec_mode);
            let default_tokens = if spec_mode == "dflash2" || spec_mode == "dflash" { 5 } else { 4 };
            let draft_tokens = profile.draft_tokens.unwrap_or_else(|| {
                // spec_draft_n_max 是 llama.cpp 的草稿宽度，只在 MTP 下沿用兜底；DFlash 家族用自身默认
                if spec_mode == "mtp" && profile.spec_draft_n_max > 0 { profile.spec_draft_n_max } else { default_tokens }
            }).clamp(1, 15);
            command.arg("--draft-tokens").arg(draft_tokens.to_string());

            let need_adaptive = profile.adaptive_mtp.unwrap_or(true);
            if need_adaptive && spec_mode == "mtp" && !has_extra_arg("--adaptive-mtp") {
                command.arg("--adaptive-mtp");
            }

            // 0 表示关闭 ngram 复制草稿，必须原样传递；DFlash 不依赖 ngram 提速，默认关闭
            let default_ngram = if spec_mode == "mtp" { 31 } else { 0 };
            let mut ngram = profile.ngram_draft_tokens.unwrap_or(default_ngram);
            if ngram > 0 {
                // DFlash 的复制轮在启动预热（CUDA Graph 捕获）时按 ngram 宽度建帧，
                // 宽度小于草稿宽度会直接崩溃：neural proposal is outside its supported frame
                if spec_mode != "mtp" {
                    ngram = ngram.max(draft_tokens);
                }
                if profile.parallel > 1 && ngram > 15 {
                    ngram = 15;
                }
            }
            command.arg("--ngram-draft-tokens").arg(ngram.min(63).to_string());
            if !has_extra_arg("--ngram-min-match") {
                command.arg("--ngram-min-match").arg("12");
            }
        } else if engine_type == "ninfer_kvmem" && !has_extra_arg("--spec") {
            // KVMem 检测到伴随权重时会自动启用 MTP，显式 none 才能让用户真正关闭投机采样
            command.arg("--spec").arg("none");
        }

        // 10. 深度思考
        let reasoning_mode = profile.reasoning.trim().to_lowercase();
        if reasoning_mode == "off" || reasoning_mode == "force-off" || reasoning_mode == "none" {
            if !has_extra_arg("--no-thinking") {
                command.arg("--no-thinking");
            }
        } else {
            if profile.preserve_thinking.unwrap_or(true) && !has_extra_arg("--preserve-thinking") {
                command.arg("--preserve-thinking");
            }
            let effort = profile.reasoning_effort.trim().to_lowercase();
            let valid_effort = match effort.as_str() {
                "xhigh" | "high" | "medium" | "low" | "minimal" | "none" => effort.as_str(),
                _ => "xhigh",
            };
            if !has_extra_arg("--default-reasoning-effort") {
                command.arg("--default-reasoning-effort").arg(valid_effort);
            }
        }

        // 11. 采样超参（温度 / Top-P / Min-P 来自预设；Top-K 与种子对齐 NInfer 官方模板）
        command
            .arg("--temperature").arg(profile.temperature.to_string())
            .arg("--top-p").arg(profile.top_p.to_string())
            .arg("--min-p").arg(profile.min_p.to_string());
        if let Some(topk) = profile.top_k {
            if topk > 0 && !has_extra_arg("--top-k") {
                command.arg("--top-k").arg(topk.to_string());
            }
        }
        if let Some(seed) = profile.seed {
            if seed >= 0 && !has_extra_arg("--seed") {
                command.arg("--seed").arg(seed.to_string());
            }
        }

        // 12. 引擎特有显存/KVMem 分层管理
        if engine_type == "ninfer_kvmem" {
            let budget = profile.kvmem_budget.unwrap_or(36864);
            let budget_aligned = (budget / 64) * 64;
            let gen_reserve = profile.kvmem_gen_reserve.unwrap_or(16384);
            let gen_reserve_aligned = (gen_reserve / 64) * 64;
            let host_mib = profile.kvmem_host_mib.unwrap_or(12288);
            let sessions = profile.kvmem_sessions.unwrap_or(1).clamp(1, 16);
            command
                .arg("--kvmem-budget").arg(budget_aligned.to_string())
                .arg("--kvmem-gen-reserve").arg(gen_reserve_aligned.to_string())
                .arg("--kvmem-host-mib").arg(host_mib.to_string())
                .arg("--kvmem-sessions").arg(sessions.to_string());

            // sink_tokens 与 recent_tokens 必须对齐 64，且 sink + recent <= budget
            let half_budget = (budget_aligned / 128) * 64;
            let default_keep = half_budget.min(5120).max(64);
            if !has_extra_arg("--kvmem-sink-tokens") {
                command.arg("--kvmem-sink-tokens").arg(default_keep.to_string());
            }
            if !has_extra_arg("--kvmem-recent-tokens") {
                command.arg("--kvmem-recent-tokens").arg(default_keep.to_string());
            }
        } else {
            let host_mib = profile.host_cache_mib.unwrap_or(6144);
            command.arg("--host-cache-mib").arg(host_mib.to_string());
            if let Some(cap) = profile.kv_capacity {
                if cap > 0 {
                    command.arg("--kv-capacity").arg(cap.to_string());
                }
            }
        }

        // 12.5 图片与视频 / 视觉多模态 (NInfer 原生视觉组件)
        let is_vision_cpu = profile.vision_cpu.unwrap_or(false)
            || profile.vision_residency.as_deref().map(|s| s.trim() == "cpu").unwrap_or(false)
            || has_extra_arg("--vision-cpu");

        let is_vision_enabled = profile.vision.unwrap_or(false)
            || is_vision_cpu
            || has_extra_arg("--vision");

        if is_vision_enabled && !has_extra_arg("--vision") {
            command.arg("--vision");
        }

        if is_vision_enabled {
            if is_vision_cpu {
                if !has_extra_arg("--vision-cpu") && !has_extra_arg("--vision-residency") {
                    command.arg("--vision-cpu");
                }
            } else if let Some(ref residency) = profile.vision_residency {
                let r = residency.trim();
                if !r.is_empty() && !has_extra_arg("--vision-residency") {
                    command.arg("--vision-residency").arg(r);
                }
            }

            if let Some(max_merged) = profile.vision_max_merged {
                if max_merged > 0 && !has_extra_arg("--vision-max-merged") {
                    command.arg("--vision-max-merged").arg(max_merged.to_string());
                }
            } else if is_vision_cpu && !has_extra_arg("--vision-max-merged") {
                command.arg("--vision-max-merged").arg("256");
            }

            if let Some(cache_mib) = profile.media_cache_mib {
                if !has_extra_arg("--media-cache-mib") {
                    command.arg("--media-cache-mib").arg(cache_mib.to_string());
                }
            }

            if let Some(live_mib) = profile.media_live_mib {
                if live_mib > 0 && !has_extra_arg("--media-live-mib") {
                    command.arg("--media-live-mib").arg(live_mib.to_string());
                }
            }

            if let Some(threads) = profile.media_preprocess_threads {
                if threads > 0 && !has_extra_arg("--media-preprocess-threads") {
                    command.arg("--media-preprocess-threads").arg(threads.to_string());
                }
            }
        }

        // 13. 用户自定义参数
        if !extra_tokens.is_empty() {
            command.args(&extra_tokens);
        }

        // 14. 结构化请求日志（--request-log-jsonl）：NInfer 官方监测平台同款数据源，
        // 全精度 timings / tokens / queue_wait 记录，与终端 stderr 文本日志相互独立。
        // 文件按引擎可执行路径哈希隔离，追加模式 + 64MiB 轮转（保留 4 份）。
        if !has_extra_arg("--request-log-jsonl") {
            if let Ok(app_dir) = app.path().app_data_dir() {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                chosen_path.to_lowercase().hash(&mut hasher);
                let logs_dir = app_dir.join("engine_logs");
                if std::fs::create_dir_all(&logs_dir).is_ok() {
                    let log_path = logs_dir.join(format!("requests_{:016x}.jsonl", hasher.finish()));
                    command.arg("--request-log-jsonl").arg(&log_path);
                    if !has_extra_arg("--request-log-max-mib") {
                        command.arg("--request-log-max-mib").arg("64");
                    }
                    if !has_extra_arg("--request-log-keep") {
                        command.arg("--request-log-keep").arg("4");
                    }
                    // 追加模式：游标锚定到现有文件末尾，只增量读取本次引擎运行新写入的记录
                    let offset = std::fs::metadata(&log_path).map(|meta| meta.len()).unwrap_or(0);
                    ninfer_request_log_tail = Some(RequestLogTail { path: log_path, offset });
                }
            }
        }
    } else {
        // llama.cpp 分支参数拼接（100% 保持原有逻辑）
        command
            .arg("-m").arg(&model.path);
        // 对外 API 模型名（--alias）：重命名优先；用户 extra_args 显式传 -a/--alias 时不覆盖
        if !has_extra_arg("--alias") && !has_extra_arg("-a") {
            command.arg("--alias").arg(&model_display_name);
        }
        if let Some(mmproj) = mmproj_path {
            command.arg("--mmproj").arg(mmproj);
            if profile.no_mmproj_offload && !has_extra_arg("--no-mmproj-offload") {
                command.arg("--no-mmproj-offload");
            }
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
            .arg("--temp").arg(profile.temperature.to_string())
            .arg("--top-p").arg(profile.top_p.to_string())
            .arg("--min-p").arg(profile.min_p.to_string())
            .arg("--repeat-penalty").arg(profile.repeat_penalty.to_string());

        if !has_extra_arg("--reasoning") {
            match profile.reasoning.trim().to_lowercase().as_str() {
                "on" => {
                    command.arg("--reasoning").arg("on");
                }
                "auto" => {
                    command.arg("--reasoning").arg("auto");
                }
                "force-off" => {
                    command.arg("--reasoning").arg("off");
                }
                _ => {}
            }
        }

        let reasoning_mode = profile.reasoning.trim().to_lowercase();
        if reasoning_mode != "off" && reasoning_mode != "none" && reasoning_mode != "force-off" {
            let effort = profile.reasoning_effort.trim().to_lowercase();
            if !effort.is_empty() && effort != "auto" && effort != "none" && !has_extra_arg("--reasoning-effort") {
                command.arg("--reasoning-effort").arg(&profile.reasoning_effort);
            }
            if let Some(budget) = profile.reasoning_budget {
                if budget >= 0 && !has_extra_arg("--reasoning-budget") {
                    command.arg("--reasoning-budget").arg(budget.to_string());
                }
            }
        }
        if profile.flash_attention {
            command.arg("--flash-attn").arg("on");
        }
        if profile.ncmoe_layers > 0 {
            command.arg("-ncmoe").arg(profile.ncmoe_layers.to_string());
        }
        match resolved_spec_mode {
            "dflash" => {
                if let Some(draft) = mtp_draft_path {
                    if !has_extra_arg("-md") && !has_extra_arg("--model-draft") {
                        command.arg("-md").arg(draft);
                    }
                }
                if !has_extra_arg("--spec-type") {
                    command.arg("--spec-type").arg("draft-dflash");
                }
                if !has_extra_arg("--spec-draft-n-max") {
                    command.arg("--spec-draft-n-max").arg(profile.spec_draft_n_max.to_string());
                }
            }
            "draft" => {
                if let Some(draft) = mtp_draft_path {
                    if !has_extra_arg("-md") && !has_extra_arg("--model-draft") {
                        command.arg("-md").arg(draft);
                    }
                }
                if !has_extra_arg("--spec-draft-n-max") {
                    command.arg("--spec-draft-n-max").arg(profile.spec_draft_n_max.to_string());
                }
            }
            "mtp" => {
                if !has_extra_arg("--spec-type") {
                    command.arg("--spec-type").arg("draft-mtp");
                }
                if !has_extra_arg("--spec-draft-n-max") {
                    command.arg("--spec-draft-n-max").arg(profile.spec_draft_n_max.to_string());
                }
            }
            _ => {}
        }
        if profile.jinja {
            command.arg("--jinja");
        }
        if !extra_tokens.is_empty() {
            command.args(&extra_tokens);
        }
    }
    Ok(ServerLaunchPlan {
        command,
        engine_type: engine_type.to_string(),
        engine_name: engine_display_name,
        engine_backend: engine_display_backend,
        model_id: model.id,
        model_name: model_display_name,
        profile_id: profile.id,
        profile_name: profile.name,
        port: profile.port,
        request_log: ninfer_request_log_tail,
    })
}
