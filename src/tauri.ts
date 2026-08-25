import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, LlamaLogPayload, ServerStatus } from "./types";

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

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) { await invoke("open_url", { url }); }
  else { window.open(url, "_blank"); }
}
