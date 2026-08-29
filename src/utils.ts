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

/** llama.cpp 日志行着色：按流与 llama.cpp 日志级别（I/W/E）分类 */
export const lineKind = (stream: LlamaLogPayload["stream"], line: string): "system" | "err" | "warn" | "msg" => {
  if (stream === "system") return "system";
  if (stream === "stderr") {
    // llama.cpp 日志格式：时间戳 + 级别字母（I/W/E），如 "0.00.105.500 I cmn  ..."
    const tag = line.match(/^\S+\s+([IWE])\s/)?.at(1)?.toUpperCase();
    if (tag === "E") return "err";
    if (tag === "W") return "warn";
  }
  return "msg";
};

/** 从 llama.cpp 日志行提取生成吞吐（如 "43.2 tokens/sec"），未匹配返回 null */
export function parseTokPerSec(line: string): number | null {
  const match = line.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:tokens?|toks?)\/sec/i);
  return match ? Number(match[1]) : null;
}
