import type { LlamaLogPayload, ModelAsset } from "./types";

export const ACCENTS = ["violet", "cyan", "amber", "rose"] as const;
export const EMPTY_STATUS = { running: false } as const;

/** 取模型的显示名：优先自定义名，否则用默认名 */
export function modelTitle(model: ModelAsset) {
  const custom = model.displayName?.trim();
  return custom || model.name;
}

export function formatBytes(bytes: number) {
  if (!bytes) return "未知大小";
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function newLog(line: string, stream: LlamaLogPayload["stream"] = "system"): LlamaLogPayload {
  return { line, stream, timestamp: Date.now() };
}
