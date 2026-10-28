use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::system::get_installed_cuda_version;
use crate::{now_ms, refresh_tray_menu, sync_global_shortcuts};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelAsset {
    pub(crate) id: String,
    pub(crate) name: String,
    /// 自定义显示名；空则回退到 name。
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    pub(crate) path: String,
    pub(crate) size_bytes: u64,
    #[serde(default)]
    pub(crate) architecture: String,
    #[serde(default)]
    pub(crate) quantization: String,
    #[serde(default)]
    pub(crate) parameters: String,
    /// 该模型专属的运行预设。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) profiles: Vec<Profile>,
    /// 旧版全局预设引用，仅用于读取旧配置文件以回填 profiles。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) profile_ids: Vec<String>,
    /// 该模型的默认启动预设 id。
    #[serde(default)]
    pub(crate) default_profile_id: Option<String>,
    #[serde(default = "default_accent")]
    pub(crate) accent: String,
    /// 自定义标签（如角色扮演、代码、未知量化补录等）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) tags: Vec<String>,
    /// 架构/参数量/量化来源（gguf / ninfer / filename）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metadata_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default = "default_host")]
    pub(crate) host: String,
    #[serde(default = "default_port")]
    pub(crate) port: u16,
    #[serde(default)]
    pub(crate) gpu_layers: i32,
    #[serde(default = "default_context_size")]
    pub(crate) context_size: u32,
    #[serde(default = "default_threads")]
    pub(crate) threads: u16,
    #[serde(default = "default_parallel")]
    pub(crate) parallel: u32,
    #[serde(default = "default_batch_size")]
    pub(crate) batch_size: u32,
    #[serde(default = "default_ubatch_size")]
    pub(crate) ubatch_size: u32,
    #[serde(default = "default_flash_attention")]
    pub(crate) flash_attention: bool,
    #[serde(default)]
    pub(crate) ncmoe_layers: i32,
    #[serde(default)]
    pub(crate) mtp: bool,
    #[serde(default)]
    pub(crate) mtp_draft_path: Option<String>,
    #[serde(default = "default_spec_draft_n_max")]
    pub(crate) spec_draft_n_max: u32,
    /// 投机采样模式（none / mtp / dflash / draft）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) spec_type: Option<String>,
    #[serde(default = "default_cache_type")]
    pub(crate) cache_type_k: String,
    #[serde(default = "default_cache_type")]
    pub(crate) cache_type_v: String,
    #[serde(default)]
    pub(crate) jinja: bool,
    #[serde(default = "default_reasoning")]
    pub(crate) reasoning: String,
    #[serde(default = "default_reasoning")]
    pub(crate) reasoning_effort: String,
    #[serde(default)]
    pub(crate) reasoning_budget: Option<i32>,
    #[serde(default = "default_load_mode")]
    pub(crate) load_mode: String,
    #[serde(default = "default_temperature")]
    pub(crate) temperature: f64,
    #[serde(default = "default_top_p")]
    pub(crate) top_p: f64,
    #[serde(default = "default_min_p")]
    pub(crate) min_p: f64,
    #[serde(default = "default_repeat_penalty")]
    pub(crate) repeat_penalty: f64,
    #[serde(default)]
    pub(crate) extra_args: String,
    /// 该预设挂载的图像识别视觉模型（mmproj）；非空时以 --mmproj 附加启动。
    #[serde(default)]
    pub(crate) mmproj_path: Option<String>,
    /// 是否禁止将视觉模型卸载到显存，强制纯系统内存运行（--no-mmproj-offload）
    #[serde(default)]
    pub(crate) no_mmproj_offload: bool,
    /// 该预设关联的 llama.cpp / ninfer 引擎分支 ID；未指定或为空则跟随全局默认主引擎。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) engine_id: Option<String>,
    /// ninfer / ninfer-kvmem 专属：KV 缓存量化格式（如 bf16 / int8 / fp8 / rk8v4 / rk4v4 / rk4v4-e8 / rk2v4-e8 / nvfp4 / k8v4）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kv_dtype: Option<String>,
    /// ninfer 专属：预填充分块 Token 数（128 的倍数，如 256 / 512）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) prefill_chunk: Option<u32>,
    /// ninfer 专属：快速预热内核开关（--fast-prefill-kernel）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fast_prefill_kernel: Option<bool>,
    /// ninfer 专属：显存分配策略（strict / mixed / default）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cuda_memory_policy: Option<String>,
    /// ninfer 专属：CUDA 显卡序号（--device N）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) device_index: Option<u32>,
    /// ninfer 专属：硬件调优 Profile（off / auto / calibrate）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) device_profile: Option<String>,
    /// ninfer 专属：自定义 Jinja 对话模板路径（--chat-template FILE）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) chat_template_path: Option<String>,
    /// ninfer 专属：硬件路线 profile 配置文件路径（--device-profile-path FILE）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) device_profile_path: Option<String>,
    /// ninfer 专属：自适应 MTP 投机采样开关
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) spec_mtp: Option<bool>,
    /// ninfer 专属：投机采样算法（mtp / dflash / dflash2）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ninfer_spec_type: Option<String>,
    /// ninfer 专属：草稿 Token 步数（--draft-tokens N，DFlash 家族默认 5、MTP 默认 4）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) draft_tokens: Option<u32>,
    /// ninfer 专属：自适应草稿衰减（--adaptive-mtp）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) adaptive_mtp: Option<bool>,
    /// ninfer 专属：N-gram 匹配步数（--ngram-draft-tokens N）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ngram_draft_tokens: Option<u32>,
    /// 单 ninfer 专属：系统内存借用大小（--host-cache-mib MiB）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) host_cache_mib: Option<u32>,
    /// 单 ninfer 专属：KV 缓存总上限（--kv-capacity tokens）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kv_capacity: Option<u32>,
    /// ninfer-kvmem 专属：GPU 历史 KV 预算（--kvmem-budget tokens）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kvmem_budget: Option<u32>,
    /// ninfer-kvmem 专属：GPU 生成预留显存（--kvmem-gen-reserve tokens）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kvmem_gen_reserve: Option<u32>,
    /// ninfer-kvmem 专属：主机内存预算配额（--kvmem-host-mib MiB）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kvmem_host_mib: Option<u32>,
    /// ninfer-kvmem 专属：历史会话保持数量（--kvmem-sessions 1..16）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kvmem_sessions: Option<u32>,
    /// ninfer 专属：默认输出 Token 上限（--default-max-tokens；0 = 不限制生成到上下文耗尽。
    /// 思考 token 计入输出上限，服务端默认 8192 会截断 xhigh 长思考；NInfer 官方模板即为 0）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) default_max_tokens: Option<u32>,
    /// ninfer 专属：top-k 采样（--top-k N，0..20；NInfer 官方模板为 20）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) top_k: Option<u32>,
    /// ninfer 专属：采样随机种子（--seed N；NInfer 官方模板为 42，保证测试可复现）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) seed: Option<i64>,
    /// ninfer 专属：CUDA Graph 驱动状态预留显存（--cuda-graph-allowance-mib MiB；NInfer 官方模板为 72）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cuda_graph_allowance_mib: Option<u32>,
    /// ninfer 专属：启用图片与视频输入（--vision）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) vision: Option<bool>,
    /// ninfer 专属：快捷开启 CPU 视觉（--vision-cpu）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) vision_cpu: Option<bool>,
    /// ninfer 专属：视觉组件放置位置（--vision-residency，如 resident / overlay）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) vision_residency: Option<String>,
    /// ninfer 专属：每项媒体的视觉 token 上限（--vision-max-merged N）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) vision_max_merged: Option<u32>,
    /// ninfer 专属：已处理媒体缓存 MiB（--media-cache-mib MiB）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) media_cache_mib: Option<u32>,
    /// ninfer 专属：活跃媒体总预算 MiB（--media-live-mib MiB）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) media_live_mib: Option<u32>,
    /// ninfer 专属：媒体预处理线程数（--media-preprocess-threads N）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) media_preprocess_threads: Option<u32>,
    /// ninfer 专属：GDN 循环状态采用 FP16（--gdn-state-fp16）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) gdn_state_fp16: Option<bool>,
    /// ninfer 专属：混合前缀缓存优化（--use-alt-prefix-caching）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) use_alt_prefix_caching: Option<bool>,
    /// ninfer 专属：GPU 状态快照槽位（--device-snapshot-slots N）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) device_snapshot_slots: Option<u32>,
    /// ninfer 专属：保留历史思考（--preserve-thinking）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) preserve_thinking: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlamaEngine {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cuda_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<u64>,
    /// 引擎架构类型：llamacpp（默认） | ninfer | ninfer_kvmem
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) engine_type: Option<String>,
}

fn default_host() -> String { "0.0.0.0".into() }
fn default_port() -> u16 { 9931 }
fn default_context_size() -> u32 { 8192 }
fn default_threads() -> u16 { 8 }
fn default_batch_size() -> u32 { 512 }
fn default_flash_attention() -> bool { true }
fn default_temperature() -> f64 { 0.7 }
fn default_top_p() -> f64 { 0.9 }
fn default_min_p() -> f64 { 0.05 }
fn default_repeat_penalty() -> f64 { 1.1 }
fn default_accent() -> String { "violet".into() }
fn default_parallel() -> u32 { 1 }
fn default_ubatch_size() -> u32 { 256 }
fn default_cache_type() -> String { "f32".into() }
fn default_reasoning() -> String { "auto".into() }
fn default_load_mode() -> String { "mmap".into() }
fn default_spec_draft_n_max() -> u32 { 3 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppConfig {
    #[serde(default)]
    pub(crate) server_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) active_engine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) engines: Vec<LlamaEngine>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) models: Vec<ModelAsset>,
    /// 旧版全局预设池，仅兼容旧配置文件；新配置的预设已内置于每个模型。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) profiles: Vec<Profile>,
    /// 界面主题：light(默认) 或 dark。
    #[serde(default)]
    pub(crate) theme: Option<String>,
    /// 全局标签库池（用户自定义维护的标签列表）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) custom_tags: Vec<String>,
    /// 界面语言：zh（默认）/ en，设置页可切换并持久化
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) language: Option<String>,
    /// GPU performance monitor toggle (default on; AMD/unsupported GPUs can disable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) gpu_monitor_enabled: Option<bool>,
    /// 社区探索「刻面筛选」侧边栏是否折叠（默认展开）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) explore_sidebar_collapsed: Option<bool>,
    /// Hugging Face 授权 Token（门禁模型下载必需；明文保存在本地配置文件中）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) hf_token: Option<String>,
    /// 最近一次 whoami 验证通过的用户名（设置页展示「已绑定」状态用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) hf_token_user: Option<String>,
    pub(crate) preferred_model_id: Option<String>,
    pub(crate) preferred_profile_id: Option<String>,
    /// 网络与代理配置（跟随系统 / 手动代理 / GitHub 镜像）；缺省为跟随系统。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) network: Option<NetworkConfig>,
    /// 自定义 llama.cpp 安装目录；缺省为应用数据目录下的 llamacpp。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) llamacpp_dir: Option<String>,
    /// 模型存储根目录（社区下载 / 自动扫描）；缺省为应用数据目录下的 models。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) models_dir: Option<String>,
    /// 启动时自动检查应用更新；缺省开启。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) auto_update_enabled: Option<bool>,
    /// 关闭主窗口时是否最小化到托盘（缺省开启）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) minimize_to_tray_on_close: Option<bool>,
    /// 用户选定的硬件加速后端（cuda / vulkan / cpu）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) llama_backend: Option<String>,
    /// 用户选定的 CUDA 版本偏好（如 "13"、"13.4"、"12" 等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) llama_cuda_version: Option<String>,
    /// 全局快捷键自定义配置
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shortcuts: Option<ShortcutsConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutsConfig {
    #[serde(default = "default_false")]
    pub(crate) enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) toggle_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) start_server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) stop_server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) switch_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkConfig {
    /// "system"（跟随系统代理）/ "manual"（手动 HTTP/SOCKS5）/ "direct"（直连）
    #[serde(default = "default_proxy_mode")]
    pub(crate) proxy_mode: String,
    #[serde(default)]
    pub(crate) proxy_url: String,
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

fn default_false() -> bool {
    false
}

impl Default for ShortcutsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            toggle_window: Some("Alt+Shift+C".to_string()),
            start_server: Some("Alt+Shift+S".to_string()),
            stop_server: Some("Alt+Shift+X".to_string()),
            switch_engine: Some("Alt+Shift+E".to_string()),
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_path: String::new(),
            active_engine_id: None,
            engines: Vec::new(),
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
                ncmoe_layers: 0,
                mtp: false,
                mtp_draft_path: None,
                spec_draft_n_max: default_spec_draft_n_max(),
                spec_type: None,
                cache_type_k: default_cache_type(),
                cache_type_v: default_cache_type(),
                jinja: true,
                reasoning: default_reasoning(),
                reasoning_effort: default_reasoning(),
                reasoning_budget: None,
                load_mode: default_load_mode(),
                temperature: 0.7,
                top_p: 0.9,
                min_p: 0.05,
                repeat_penalty: 1.1,
                extra_args: String::new(),
                mmproj_path: None,
                no_mmproj_offload: false,
                engine_id: None,
                kv_dtype: None,
                prefill_chunk: None,
                fast_prefill_kernel: None,
                cuda_memory_policy: None,
                device_index: None,
                device_profile: None,
                chat_template_path: None,
                device_profile_path: None,
                spec_mtp: None,
                ninfer_spec_type: None,
                draft_tokens: None,
                adaptive_mtp: None,
                ngram_draft_tokens: None,
                host_cache_mib: None,
                kv_capacity: None,
                kvmem_budget: None,
                kvmem_gen_reserve: None,
                kvmem_host_mib: None,
                kvmem_sessions: None,
                default_max_tokens: None,
                top_k: None,
                seed: None,
                cuda_graph_allowance_mib: None,
                vision: None,
                vision_cpu: None,
                vision_residency: None,
                vision_max_merged: None,
                media_cache_mib: None,
                media_live_mib: None,
                media_preprocess_threads: None,
                gdn_state_fp16: None,
                use_alt_prefix_caching: None,
                device_snapshot_slots: None,
                preserve_thinking: None,
            }],
            theme: None,
            custom_tags: Vec::new(),
            language: None,
            gpu_monitor_enabled: None,
            explore_sidebar_collapsed: None,
            hf_token: None,
            hf_token_user: None,
            preferred_model_id: None,
            preferred_profile_id: None,
            network: None,
            llamacpp_dir: None,
            models_dir: None,
            auto_update_enabled: None,
            minimize_to_tray_on_close: None,
            llama_backend: None,
            llama_cuda_version: None,
            shortcuts: Some(ShortcutsConfig::default()),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("config.json"))
}

/// 配置读取缓存：按（路径, mtime）命中，避免每个命令都重新读盘解析 JSON
/// （hf_avatar 每个作者一次、hf_download / start_server 等十余处高频调用）。
/// save_config 落盘后 mtime 变化，缓存自动失效，无需手动清理。
struct ConfigCacheEntry {
    path: PathBuf,
    modified: Option<SystemTime>,
    config: AppConfig,
}
static CONFIG_CACHE: OnceLock<Mutex<Option<ConfigCacheEntry>>> = OnceLock::new();

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

pub(crate) fn read_config(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let modified = file_mtime(&path);
    if let Ok(guard) = CONFIG_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.path == path && entry.modified == modified {
                return Ok(entry.config.clone());
            }
        }
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut config: AppConfig = serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    for eng in &mut config.engines {
        let p = PathBuf::from(&eng.path);
        if let Some(parent) = p.parent() {
            if let Some(installed) = get_installed_cuda_version(parent) {
                eng.cuda_version = Some(installed);
            }
        }
    }
    if let Some(ref mut sc) = config.shortcuts {
        if sc.switch_engine.as_deref() == Some("Ctrl+E") {
            sc.switch_engine = Some("Alt+Shift+E".to_string());
        }
    }
    if let Ok(mut guard) = CONFIG_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some(ConfigCacheEntry { path: path.clone(), modified, config: config.clone() });
    }
    Ok(config)
}

#[tauri::command]
pub(crate) fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    read_config(&app)
}

fn save_config_internal(app: &AppHandle, config: &AppConfig, sync_shortcuts: bool) -> Result<(), String> {
    let path = config_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let contents = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&temporary, &contents).map_err(|error| error.to_string())?;
    // Windows 的 rename 不能覆盖已存在目标：旧文件先挪为 .bak，rename 失败立即回滚，任何一步中断都不会丢配置
    if path.exists() {
        fs::rename(&path, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::rename(&backup, &path);
        return Err(error.to_string());
    }
    let _ = fs::remove_file(&backup);
    if let Ok(mut guard) = CONFIG_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *guard = None;
    }
    refresh_tray_menu(app);
    if sync_shortcuts {
        sync_global_shortcuts(app, config);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    save_config_internal(&app, &config, true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigBackupEnvelope {
    kind: String,
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exported_at: Option<u64>,
    config: AppConfig,
}

/// 导出当前配置。去掉 Hugging Face Token 及绑定用户名，避免令牌与隐私信息外泄。
#[tauri::command]
pub(crate) fn export_config_backup(app: AppHandle) -> Result<String, String> {
    let mut config = read_config(&app)?;
    config.hf_token = None;
    config.hf_token_user = None;
    let backup = ConfigBackupEnvelope {
        kind: "cookllm-config".into(),
        version: 2,
        exported_at: Some(now_ms()),
        config,
    };
    let contents = serde_json::to_vec_pretty(&backup).map_err(|error| error.to_string())?;
    let file_name = format!("CookLLM-config-{}.json", backup.exported_at.unwrap_or(0));
    let Some(target) = app.dialog().file().set_file_name(&file_name).add_filter("CookLLM 配置", &["json"]).blocking_save_file() else {
        return Ok(String::new());
    };
    let Some(path) = target.as_path() else {
        return Err("无法写入所选路径".into());
    };
    fs::write(path, contents).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取一份备份。返回包含信封元数据和配置内容的 Envelope。
#[tauri::command]
pub(crate) fn pick_config_backup(app: AppHandle) -> Result<Option<ConfigBackupEnvelope>, String> {
    let Some(file_path) = app.dialog().file().add_filter("CookLLM 配置", &["json"]).blocking_pick_file() else {
        return Ok(None);
    };
    let Some(path) = file_path.as_path() else {
        return Err("无法读取所选文件".into());
    };
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&contents).map_err(|error| format!("配置文件不是有效 JSON：{}", error))?;
    let (kind, version, exported_at, config_value) = if value.get("kind").and_then(|item| item.as_str()) == Some("cookllm-config") {
        let v = value.get("version").and_then(|item| item.as_u64()).unwrap_or(1) as u32;
        let at = value.get("exported_at").or_else(|| value.get("exportedAt")).and_then(|item| item.as_u64());
        let cfg = value.get("config").cloned().ok_or_else(|| "配置备份缺少 config 字段".to_string())?;
        ("cookllm-config".to_string(), v, at, cfg)
    } else if value.get("models").is_some() || value.get("serverPath").is_some() {
        ("cookllm-config".to_string(), 1, None, value)
    } else {
        return Err("这不是 CookLLM 配置备份".into());
    };
    let config: AppConfig = serde_json::from_value(config_value).map_err(|error| format!("配置备份无法识别：{}", error))?;
    Ok(Some(ConfigBackupEnvelope {
        kind,
        version,
        exported_at,
        config,
    }))
}
