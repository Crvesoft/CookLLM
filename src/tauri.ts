import { getVersion as appVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { APP_REPO, APP_VERSION, PROJECT_URL } from "./data";
import { isNewerVersion } from "./utils";
import type { AppConfig, GpuStats, LlamaLogPayload, ServerStatus } from "./types";

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
}

export async function getGpuInfo(): Promise<GpuInfo | null> {
  if (!isTauri()) return null;
  return invoke<GpuInfo>("get_gpu_info");
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
}

/** 通过 GitHub Releases 检查新版本（匿名访问，无需密钥）；仓库无已发布版本时抛 Error("no-releases") */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const response = await fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(response.status === 404 ? "no-releases" : `HTTP ${response.status}`);
  const data = (await response.json()) as { tag_name?: string; html_url?: string };
  const latestTag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
  if (!latestTag) throw new Error("bad-response");
  return { status: isNewerVersion(latestTag, currentVersion) ? "available" : "latest", latestTag, releaseUrl: typeof data.html_url === "string" ? data.html_url : `${PROJECT_URL}/releases` };
}
