import { getVersion as appVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { APP_REPO, APP_VERSION, PROJECT_URL } from "./data";
import { isNewerVersion } from "./utils";
import type { AppConfig, DiskUsage, EngineType, GpuStats, HfDownloadResult, HfFile, HfModel, LlamaBackend, LlamaLogPayload, ModelDownloadProgress, ProxyMode, ServerStatus } from "./types";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadConfig(): Promise<AppConfig | null> {
  if (!isTauri()) return null;
  return invoke<AppConfig>("load_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem("cookllm-config", JSON.stringify(config));
    return;
  }
  await invoke("save_config", { config });
}

export async function startServer(modelId: string, profileId: string): Promise<ServerStatus> {
  return invoke<ServerStatus>("start_server", { modelId, profileId });
}

export async function stopServer(): Promise<ServerStatus> {
  return invoke<ServerStatus>("stop_server");
}

export async function getServerStatus(): Promise<ServerStatus> {
  return invoke<ServerStatus>("get_server_status");
}

/** NInfer --request-log-jsonl 增量记录（server_start / request_start / request_done）；llama.cpp 或未运行返回空 */
export async function readNinferRequestLog(): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invoke<unknown[]>("read_ninfer_request_log");
}

export interface OrphanProcessItem {
  pid: number;
  name: string;
  path?: string | null;
}

export interface OrphanServerInfo {
  hasOrphan: boolean;
  pids: number[];
  processes?: OrphanProcessItem[];
}

/** 检测系统后台是否存在未被当前 CookLLM 托管的残留 server 进程 */
export async function checkOrphanServer(): Promise<OrphanServerInfo> {
  if (!isTauri()) return { hasOrphan: false, pids: [], processes: [] };
  return invoke<OrphanServerInfo>("check_orphan_server");
}

/** 终止指定的（或全部未托管的）后台残留 server 进程 */
export async function killOrphanServer(pids?: number[]): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("kill_orphan_server", { pids: pids ?? null });
}

/** GPU 实时指标（Rust 端 nvidia-smi）：浏览器 / 无 NVIDIA 驱动时返回 null */
export async function getGpuStats(): Promise<GpuStats | null> {
  if (!isTauri()) return null;
  return invoke<GpuStats | null>("get_gpu_stats");
}

export interface PickedFile { path: string; sizeBytes: number; }

export async function pickFiles(filters: string[]): Promise<PickedFile[]> {
  if (!isTauri()) return [];
  return invoke<PickedFile[]>("pick_files", { filters });
}

export async function pickFolder(): Promise<PickedFile[]> {
  if (!isTauri()) return [];
  return invoke<PickedFile[]>("pick_folder");
}

export interface ServerCandidate {
  name: string;
  path: string;
  relPath: string;
  sizeBytes: number;
}

export interface PickServerResult {
  status: "selected" | "multiple" | "none" | "cancelled";
  candidates: ServerCandidate[];
  selectedPath?: string | null;
}

/** 选择本机 llama.cpp 构建或安装目录，智能定位或返回多个候选程序 */
export async function pickServerDir(): Promise<PickServerResult> {
  if (!isTauri()) return { status: "cancelled", candidates: [] };
  return invoke<PickServerResult>("pick_server_dir");
}

/** 直接选择具体的 server 可执行文件（如 llama-server.exe、llama-kvmem-server.exe 等） */
export async function pickServerFile(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("pick_server_file");
}

/** 把拖入/选中的路径展开为 GGUF 文件列表：目录递归收集，文件按后缀过滤。 */
export async function expandPaths(paths: string[]): Promise<PickedFile[]> {
  if (!isTauri()) return [];
  return invoke<PickedFile[]>("expand_paths", { paths });
}

export async function onLlamaLog(handler: (payload: LlamaLogPayload) => void): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<LlamaLogPayload>("llama-log", (event) => handler(event.payload));
}

export async function onTrayViewError(handler: (errorMessage: string) => void): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<string>("tray_view_error", (event) => handler(event.payload));
}

/** 服务生命周期事件载荷：托盘 / 主界面任一侧发生启动、就绪、停止、失败时由后端广播 */
export interface ServerLifecyclePayload {
  /** starting = 进程已拉起（接口尚未就绪）；ready = HTTP 接口可服务；stopped = 主动停止；failed = 启动失败 / 进程意外退出 */
  phase: "starting" | "ready" | "stopped" | "failed";
  /** starting 时携带新服务的完整状态（running: true） */
  status?: ServerStatus | null;
  /** failed 时携带错误信息 */
  error?: string | null;
}

/** 订阅服务生命周期事件：保证托盘操作与主界面状态、过渡动画严格同步 */
export async function onServerLifecycle(handler: (payload: ServerLifecyclePayload) => void): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<ServerLifecyclePayload>("server-lifecycle", (event) => handler(event.payload));
}

/** 订阅后台配置更新事件 */
export async function onConfigUpdated(handler: (config: AppConfig) => void): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<AppConfig>("config-updated", (event) => handler(event.payload));
}

/** 订阅全局快捷键呼出引擎管理界面事件 */
export async function onShortcutOpenEngineHub(handler: () => void): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<void>("shortcut-open-engine-hub", () => handler());
}

/** Write to the system clipboard (Tauri fallback when the iframe Clipboard API fails). */
export async function writeClipboard(text: string): Promise<void> {
  if (!isTauri()) throw new Error("clipboard write is only available in Tauri");
  await invoke("clipboard_write", { text });
}

export interface GpuInfo {
  vendor: string;
  supported: boolean;
  /** GPU 总显存（MiB；无独显 / 非 NVIDIA 驱动时为空） */
  vramTotalMb?: number | null;
}

export async function getGpuInfo(): Promise<GpuInfo | null> {
  if (!isTauri()) return null;
  return invoke<GpuInfo>("get_gpu_info");
}

export interface GgufMeta {
  architecture: string;
  parameters: string;
  quantization: string;
  /** 层数（用于估算 KV 缓存体积；读不到时为 0） */
  blockCount: number;
  /** 真正缓存 KV 的层数（混合架构里 SSM 层不带 KV，未识别时等于 blockCount） */
  attentionLayerCount: number;
  headCount: number;
  headCountKv: number;
  headDim: number;
  contextLength: number;
  /** 模型文件字节数，供显存估算 */
  weightsBytes: number;
}

/** 读取 GGUF 文件头。浏览器模式或读取失败时返回空字段，调用方继续用文件名兜底。 */
export async function pathsExist(paths: string[]): Promise<string[]> {
  if (!isTauri() || !paths.length) return paths;
  return invoke<string[]>("paths_exist", { paths });
}

const EMPTY_GGUF_META: GgufMeta = {
  architecture: "",
  parameters: "",
  quantization: "",
  blockCount: 0,
  attentionLayerCount: 0,
  headCount: 0,
  headCountKv: 0,
  headDim: 0,
  contextLength: 0,
  weightsBytes: 0,
};

export async function inspectGguf(path: string): Promise<GgufMeta> {
  if (!isTauri()) return { ...EMPTY_GGUF_META };
  return invoke<GgufMeta>("inspect_gguf", { path });
}

export interface HardwareInfo {
  vendor: string;
  supported: boolean;
  vramTotalMb?: number | null;
  systemRamMb?: number | null;
  gpuName?: string | null;
  /** CUDA 计算能力主版本（Blackwell 为 12；非 NVIDIA 为空），判断 nvfp4 是否可用 */
  computeCapMajor?: number | null;
  cpuThreads?: number | null;
}

/** 读取本机硬件能力（显卡 / 显存 / 内存 / 线程数），供智能推荐估算使用。 */
export async function getHardwareInfo(): Promise<HardwareInfo | null> {
  if (!isTauri()) return null;
  return invoke<HardwareInfo>("hardware_info");
}

export interface ConfigBackupEnvelope {
  kind: string;
  version: number;
  exportedAt?: number;
  config: AppConfig;
}

/** 导出当前配置到用户选择的 JSON 文件；取消时返回空字符串。Token 不会写入备份。 */
export async function exportConfigBackup(): Promise<string> {
  if (!isTauri()) throw new Error("配置备份仅在桌面端可用");
  return invoke<string>("export_config_backup");
}

/** 选择并解析一份配置备份；用户取消时返回 null。 */
export async function pickConfigBackup(): Promise<ConfigBackupEnvelope | null> {
  if (!isTauri()) throw new Error("配置导入仅在桌面端可用");
  return invoke<ConfigBackupEnvelope | null>("pick_config_backup");
}


/** 打开系统目录选择对话框；取消时返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("pick_directory");
}

export async function openConfigDir(): Promise<void> {
  if (isTauri()) { await invoke("open_config_dir"); }
}
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) { await invoke("open_url", { url }); }
  else { window.open(url, "_blank"); }
}

/** 按应用主题同步系统标题栏：Windows 暗色主题显示黑色标题栏，亮色恢复默认。 */
export async function setWindowTheme(dark: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_window_theme", { dark });
}

/** 当前应用版本：Tauri 读打包版本（tauri.conf.json），浏览器模式回退到源码常量 */
export async function getAppVersion(): Promise<string> {
  if (isTauri()) return appVersion();
  return APP_VERSION;
}

/** 检测结果：latest=已是最新 / available=发现新版本 */
export interface UpdateCheckResult {
  status: "latest" | "available";
  /** 最新发布 tag（如 v0.2.0） */
  latestTag: string;
  /** 该版本的发布页地址 */
  releaseUrl: string;
  releaseNotes?: string | null;
  assetUrl?: string | null;
  assetName?: string | null;
  assetSize?: number | null;
  assetSha256?: string | null;
}

/** 通过 GitHub Releases 检查新版本（匿名访问，无需密钥）；仓库无已发布版本时抛 Error("no-releases") */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  if (isTauri()) return invoke<UpdateCheckResult>("check_app_update");
  const response = await fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(response.status === 404 ? "no-releases" : `HTTP ${response.status}`);
  const data = (await response.json()) as { tag_name?: string; html_url?: string; body?: string };
  const latestTag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
  if (!latestTag) throw new Error("bad-response");
  return {
    status: isNewerVersion(latestTag, currentVersion) ? "available" : "latest",
    latestTag,
    releaseUrl: typeof data.html_url === "string" ? data.html_url : `${PROJECT_URL}/releases`,
    releaseNotes: typeof data.body === "string" ? data.body : null,
    assetUrl: null,
    assetName: null,
    assetSize: null,
    assetSha256: null,
  };
}

export async function downloadAppUpdate(update: UpdateCheckResult): Promise<string> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  if (!update.assetUrl || !update.assetName) throw new Error("未找到 Windows 安装包");
  return invoke<string>("download_app_update", {
    url: update.assetUrl,
    fileName: update.assetName,
    size: update.assetSize ?? null,
    sha256: update.assetSha256 ?? null,
  });
}

export async function cancelAppUpdate(): Promise<void> {
  if (!isTauri()) return;
  await invoke("cancel_app_update");
}

export async function installAppUpdate(path: string): Promise<void> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  await invoke("install_app_update", { path });
}

/* ==================== 硬件探测（阶段一） ==================== */

export interface HardwareSuggestion {
  /** 推荐后端：cuda | vulkan | cpu */
  recommendedBackend: LlamaBackend;
  gpuName?: string | null;
  cudaSupported: boolean;
  vulkanSupported: boolean;
}

/** 探测当前运行环境并返回推荐的 llama.cpp 构建后端 */
export async function detectHardware(): Promise<HardwareSuggestion> {
  if (!isTauri()) return { recommendedBackend: "cpu", cudaSupported: false, vulkanSupported: false };
  return invoke<HardwareSuggestion>("detect_hardware");
}

/* ==================== 网络与代理（阶段二） ==================== */

export interface ProxyTestResult {
  ok: boolean;
  status: string;
  detail: string;
  latencyMs: number;
}

/** 测试与 GitHub 的连通性（按当前代理模式 / 代理地址 / 镜像地址） */
/** 读取系统代理地址（Windows 通过注册表探测，无则返回 null） */
export async function getSystemProxy(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_system_proxy");
}

export async function testProxyConnection(
  proxyMode: ProxyMode,
  proxyUrl: string,
): Promise<ProxyTestResult> {
  if (!isTauri()) return { ok: false, status: "N/A", detail: "仅 Tauri 桌面端可用", latencyMs: 0 };
  return invoke<ProxyTestResult>("test_proxy_connection", { proxyMode, proxyUrl });
}

/* ==================== llama.cpp 引擎管理（阶段三） ==================== */

export interface LlamaCppAsset {
  backend: LlamaBackend;
  /** CUDA 主版本（如 "12" / "13"）；非 cuda 后端为空字符串 */
  cudaVersion?: string;
  /** CUDA 完整版本（如 "12.4" / "13.4"）；非 cuda 后端为空字符串 */
  cudaFullVersion?: string;
  fileName: string;
  url: string;
  size: number;
}

export interface LlamaCppRelease {
  tag: string;
  assets: LlamaCppAsset[];
  /** 对应的 CUDA 运行时包（cudart-...zip），仅 cuda 后端有值 */
  cudartAssets?: LlamaCppAsset[];
  matchBackend: string;
  matchAsset?: LlamaCppAsset | null;
  /** 前端对比本地版本后设置：本地已是最新 */
  upToDate?: boolean;
}

export interface LlamaCppLocalStatus {
  installDir: string;
  localVersion?: string | null;
  localBackend: LlamaBackend;
  cudaVersion?: string | null;
  serverAvailable: boolean;
  serverPath?: string | null;
  engineType?: EngineType | null;
}

export interface DownloadProgress {
  phase: "download" | "extract" | "install" | "done" | string;
  percent: number;
  downloaded: number;
  total: number;
  speedBps: number;
  message: string;
}

/** 读取本地 llama.cpp 安装状态（版本 / 后端 / 可执行文件）；支持传入自定义路径或留空读取主引擎 */
export async function getLlamaCppStatus(customPath?: string | null): Promise<LlamaCppLocalStatus | null> {
  if (!isTauri()) return null;
  return invoke<LlamaCppLocalStatus>("get_llamacpp_status", { customPath: customPath ?? null });
}

/** 检查远程最新版本并匹配指定后端的 Windows 构建资产 */
export async function checkLlamaCppUpdate(backend?: string, cudaVersion?: string): Promise<LlamaCppRelease> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  const payload = { ...(backend ? { backend } : {}), ...(cudaVersion ? { cudaVersion } : {}) };
  return invoke<LlamaCppRelease>("check_llamacpp_update", payload);
}

/** 一键更新 / 重新安装 llama.cpp（返回安装后的 llama-server 路径） */
export async function downloadLlamaCpp(input: {
  backend: string;
  cudaVersion?: string;
  assetUrl?: string;
  assetName?: string;
  tag?: string;
}): Promise<string> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  return invoke<string>("download_llamacpp", {
    backend: input.backend,
    cudaVersion: input.cudaVersion ?? null,
    assetUrl: input.assetUrl ?? null,
    assetName: input.assetName ?? null,
    tag: input.tag ?? null,
  });
}

/** 取消正在进行的 llama.cpp 更新 */
export async function cancelLlamaCppUpdate(): Promise<void> {
  if (!isTauri()) return;
  await invoke("cancel_llamacpp_update");
}

/** 订阅下载 / 解压 / 安装进度事件 */
export async function onDownloadProgress(handler: (payload: DownloadProgress) => void): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<DownloadProgress>("download-progress", (event) => handler(event.payload));
}

/* ==================== 社区探索（HuggingFace） ==================== */

/** 读取当前模型存储目录与剩余空间 */
export async function getModelsDir(): Promise<DiskUsage | null> {
  if (!isTauri()) return null;
  return invoke<DiskUsage>("get_models_dir");
}

/** 选择模型存储目录（校验可写，不直接持久化） */
export async function pickModelsDir(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("pick_models_dir");
}

export type FormatFilter = "all" | "gguf" | "ninfer";

/** 本周 HuggingFace 热门模型（支持格式筛选） */
export async function hfTrending(limit?: number, ggufOnly?: boolean, skip?: number, sort?: string, quants?: number[], formatFilter?: FormatFilter): Promise<HfModel[]> {
  if (!isTauri()) return [];
  const payload = {
    ...(limit ? { limit } : {}),
    ...(ggufOnly !== undefined ? { ggufOnly } : {}),
    ...(formatFilter ? { formatFilter } : {}),
    ...(skip ? { skip } : {}),
    ...(sort ? { sort } : {}),
    ...(quants && quants.length ? { quants } : {})
  };
  return invoke<HfModel[]>("hf_trending", payload);
}

/** 搜索 HuggingFace 模型（支持格式筛选） */
export async function hfSearch(query: string, limit?: number, ggufOnly?: boolean, skip?: number, sort?: string, quants?: number[], formatFilter?: FormatFilter): Promise<HfModel[]> {
  if (!isTauri()) return [];
  const payload = {
    query,
    ...(limit ? { limit } : {}),
    ...(ggufOnly !== undefined ? { ggufOnly } : {}),
    ...(formatFilter ? { formatFilter } : {}),
    ...(skip ? { skip } : {}),
    ...(sort ? { sort } : {}),
    ...(quants && quants.length ? { quants } : {})
  };
  return invoke<HfModel[]>("hf_search", payload);
}

/** 列出仓库 main 分支的模型文件（支持按格式筛选） */
export async function hfListFiles(repo: string, formatFilter?: FormatFilter): Promise<HfFile[]> {
  if (!isTauri()) return [];
  return invoke<HfFile[]>("hf_list_files", { repo, ...(formatFilter ? { formatFilter } : {}) });
}

/** 验证 Hugging Face Token（/whoami-v2），成功返回绑定的用户名 */
export async function hfWhoami(token: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("hf_whoami", { token });
}

/** 获取 HF 作者（组织 / 用户）头像，返回 data URI；拉不到时返回 null（前端回退文字徽章） */
export async function hfAvatar(author: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("hf_avatar", { author });
}

/** 下载仓库文件到模型存储目录（流式 + 进度事件）；taskId 为前端生成的唯一任务标识 */
export async function hfDownload(repo: string, file: string, taskId: string): Promise<HfDownloadResult> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  return invoke<HfDownloadResult>("hf_download", { repo, file, taskId });
}

/* ==================== 社区探索（魔塔社区 ModelScope） ==================== */

/** 本周魔塔社区热门模型（支持格式筛选） */
export async function msTrending(limit?: number, ggufOnly?: boolean, skip?: number, sort?: string, quants?: number[], formatFilter?: FormatFilter): Promise<HfModel[]> {
  if (!isTauri()) return [];
  const payload = {
    ...(limit ? { limit } : {}),
    ...(ggufOnly !== undefined ? { ggufOnly } : {}),
    ...(formatFilter ? { formatFilter } : {}),
    ...(skip ? { skip } : {}),
    ...(sort ? { sort } : {}),
    ...(quants && quants.length ? { quants } : {})
  };
  return invoke<HfModel[]>("ms_trending", payload);
}

/** 搜索魔塔社区模型（支持格式筛选） */
export async function msSearch(query: string, limit?: number, ggufOnly?: boolean, skip?: number, sort?: string, quants?: number[], formatFilter?: FormatFilter): Promise<HfModel[]> {
  if (!isTauri()) return [];
  const payload = {
    query,
    ...(limit ? { limit } : {}),
    ...(ggufOnly !== undefined ? { ggufOnly } : {}),
    ...(formatFilter ? { formatFilter } : {}),
    ...(skip ? { skip } : {}),
    ...(sort ? { sort } : {}),
    ...(quants && quants.length ? { quants } : {})
  };
  return invoke<HfModel[]>("ms_search", payload);
}

/** 列出魔塔社区仓库中的模型文件（支持按格式筛选） */
export async function msListFiles(repo: string, formatFilter?: FormatFilter): Promise<HfFile[]> {
  if (!isTauri()) return [];
  return invoke<HfFile[]>("ms_list_files", { repo, ...(formatFilter ? { formatFilter } : {}) });
}

/** 获取魔搭作者（组织 / 用户）头像，返回 data URI；拉不到时返回 null（前端回退 ModelScope 官方徽章） */
export async function msAvatar(author: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("ms_avatar", { author });
}

/** 从魔塔社区下载模型文件（流式 + 进度事件）；taskId 为前端生成的唯一任务标识 */
export async function msDownload(repo: string, file: string, taskId: string): Promise<HfDownloadResult> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  return invoke<HfDownloadResult>("ms_download", { repo, file, taskId });
}

/** 从任意直链下载模型文件（流式 + 进度事件）；taskId 为前端生成的唯一任务标识 */
export async function hfDownloadUrl(url: string, taskId: string): Promise<HfDownloadResult> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  return invoke<HfDownloadResult>("hf_download_url", { url, taskId });
}

/** 取消指定下载任务（仅中止该 taskId 对应任务的下载线程，不影响其他下载） */
export async function hfCancelDownload(taskId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("hf_cancel_download", { taskId });
}

/** 暂停指定下载任务（后端置位该任务的暂停标志，下载循环下一轮退出并清理 .part） */
export async function hfPauseDownload(taskId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("hf_pause_download", { taskId });
}

/** 清除 / 摘除指定任务的控制器（重新发起下载或删除任务前调用，避免残留标志影响下一轮） */
export async function hfClearDownload(taskId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("hf_clear_download", { taskId });
}

/** 删除本地文件（下载管理中「取消任务并删除缓存」用；不删除库内已登记模型，由调用方先判断） */
export async function removeLocalFile(path: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("remove_local_file", { path });
}

/** 在系统资源管理器中定位并选中文件（不存在时打开其所在目录） */
export async function revealInFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("reveal_in_folder", { path });
}



/** 订阅模型下载进度事件 */
export async function onModelDownloadProgress(handler: (payload: ModelDownloadProgress) => void): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<ModelDownloadProgress>("model-download-progress", (event) => handler(event.payload));
}

/** 快捷键录制/弹窗模式切换：录制中临时解绑全局快捷键，避免与系统热键冲突与拦截 */
export async function setShortcutsRecordingMode(recording: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_shortcuts_recording_mode", { recording });
}
