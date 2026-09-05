import { getVersion as appVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { APP_REPO, APP_VERSION, PROJECT_URL } from "./data";
import { isNewerVersion } from "./utils";
import type { AppConfig, DiskUsage, GpuStats, HfDownloadResult, HfFile, HfModel, LlamaLogPayload, ModelDownloadProgress, ServerStatus } from "./types";

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

/** 选择本机 llama.cpp 构建目录，自动定位该目录（或其子目录）中的 llama-server.exe；取消时返回空串 */
export async function pickServerDir(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("pick_server_dir");
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

/** 汇总本机硬件能力：显卡厂商 / 显存 + 总物理内存（供「适配本机」一键边界计算） */
export interface HardwareInfo {
  vendor: string;
  supported: boolean;
  /** GPU 总显存（MiB；无独显 / 非 NVIDIA 驱动时为空） */
  vramTotalMb?: number | null;
  /** Windows 可见总物理内存（MiB）；非 Windows 平台为空 */
  systemRamMb?: number | null;
}

export async function getHardwareInfo(): Promise<HardwareInfo | null> {
  if (!isTauri()) return null;
  return invoke<HardwareInfo>("hardware_info");
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
  recommendedBackend: "cuda" | "vulkan" | "cpu";
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
  proxyMode: "system" | "manual" | "direct",
  proxyUrl: string,
): Promise<ProxyTestResult> {
  if (!isTauri()) return { ok: false, status: "N/A", detail: "仅 Tauri 桌面端可用", latencyMs: 0 };
  return invoke<ProxyTestResult>("test_proxy_connection", { proxyMode, proxyUrl });
}

/* ==================== llama.cpp 引擎管理（阶段三） ==================== */

export interface LlamaCppAsset {
  backend: "cuda" | "vulkan" | "cpu";
  /** CUDA 主版本（如 "12" / "13"）；非 cuda 后端为空字符串 */
  cudaVersion?: string;
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
  localBackend: "cuda" | "vulkan" | "cpu";
  serverAvailable: boolean;
  serverPath?: string | null;
}

export interface DownloadProgress {
  phase: "download" | "extract" | "install" | "done" | string;
  percent: number;
  downloaded: number;
  total: number;
  speedBps: number;
  message: string;
}

/** 读取本地 llama.cpp 安装状态（版本 / 后端 / 可执行文件） */
export async function getLlamaCppStatus(): Promise<LlamaCppLocalStatus | null> {
  if (!isTauri()) return null;
  return invoke<LlamaCppLocalStatus>("get_llamacpp_status");
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

/** 本周 HuggingFace 热门模型（可选仅 GGUF） */
export async function hfTrending(limit?: number, ggufOnly?: boolean, skip?: number, sort?: string, quants?: number[]): Promise<HfModel[]> {
  if (!isTauri()) return [];
  const payload = { ...(limit ? { limit } : {}), ...(ggufOnly ? { ggufOnly } : {}), ...(skip ? { skip } : {}), ...(sort ? { sort } : {}), ...(quants && quants.length ? { quants } : {}) };
  return invoke<HfModel[]>("hf_trending", payload);
}

/** 搜索 HuggingFace 模型（可选仅 GGUF） */
export async function hfSearch(query: string, limit?: number, ggufOnly?: boolean, skip?: number, sort?: string, quants?: number[]): Promise<HfModel[]> {
  if (!isTauri()) return [];
  const payload = { query, ...(limit ? { limit } : {}), ...(ggufOnly ? { ggufOnly } : {}), ...(skip ? { skip } : {}), ...(sort ? { sort } : {}), ...(quants && quants.length ? { quants } : {}) };
  return invoke<HfModel[]>("hf_search", payload);
}

/** 列出仓库 main 分支的 .gguf 文件 */
export async function hfListFiles(repo: string): Promise<HfFile[]> {
  if (!isTauri()) return [];
  return invoke<HfFile[]>("hf_list_files", { repo });
}

/** 下载仓库文件到模型存储目录（流式 + 进度事件） */
export async function hfDownload(repo: string, file: string): Promise<HfDownloadResult> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  return invoke<HfDownloadResult>("hf_download", { repo, file });
}

/** 从任意直链下载模型文件（流式 + 进度事件） */
export async function hfDownloadUrl(url: string): Promise<HfDownloadResult> {
  if (!isTauri()) throw new Error("仅 Tauri 桌面端可用");
  return invoke<HfDownloadResult>("hf_download_url", { url });
}

/** 取消正在进行的模型下载 */
export async function hfCancelDownload(): Promise<void> {
  if (!isTauri()) return;
  await invoke("hf_cancel_download");
}

/** 暂停全部正在进行的模型下载（后端置位暂停标志，下载循环在下一轮退出并清理 .part） */
export async function hfPauseDownloads(): Promise<void> {
  if (!isTauri()) return;
  await invoke("hf_pause_downloads");
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
