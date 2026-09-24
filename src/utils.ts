import type { LlamaLogPayload, ModelAsset } from "./types";
import { formatMessage, getLocale } from "./i18n";

export const ACCENTS = ["violet", "cyan", "amber", "rose"] as const;
export const EMPTY_STATUS = { running: false } as const;

/** 取模型的显示名：优先自定义名，否则用默认名 */
export function modelTitle(model: ModelAsset) {
  const custom = model.displayName?.trim();
  return custom || model.name;
}

/** 格式化字节（自适应 B / KB / MB / GB） */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return formatMessage(getLocale(), "bytes.unknown");
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

/** 转换为以 MB 为单位（如 "20.7 MB"） */
export function formatMB(bytes: number): string {
  if (!bytes || bytes <= 0) return "0.0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

/** 从文件名或路径中智能提取量化级别（支持 Q4_K_M、IQ4_XS、3.7bpw、F16 等） */
export function parseQuantization(path: string, fallback: string): string {
  const match = path.match(/(?:I?Q\d(?:_[A-Z0-9]+)+|\d+(?:\.\d+)?bpw|(?:FP|BF|F)16|(?:FP|F)32)/i)?.[0];
  if (!match) return fallback;
  return match.toLowerCase().endsWith("bpw") ? match : match.toUpperCase();
}

export function timeLabel(timestamp: number) {
  const locale = getLocale() === "en" ? "en-US" : "zh-CN";
  return new Date(timestamp).toLocaleTimeString(locale, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/** 逐字段 === 比较两个扁平对象；轮询结果未变化时保持旧引用，避免无意义的 setState 触发全树重渲染 */
export function shallowEqualFields<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a) as Array<keyof T>;
  const keysB = Object.keys(b) as Array<keyof T>;
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

export function newLog(line: string, stream: LlamaLogPayload["stream"] = "system"): LlamaLogPayload {
  return { line, stream, timestamp: Date.now() };
}

/** 下载速度格式化：MB/s 一位小数，否则 KB/s 取整；无速度返回空串 */
export function humanSpeed(speedBps: number): string {
  if (speedBps <= 0) return "";
  if (speedBps >= 1024 * 1024) return (speedBps / 1024 / 1024).toFixed(1) + " MB/s";
  return Math.round(speedBps / 1024) + " KB/s";
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

/** 版本号比较（兼容 v 前缀与不同段数）：release 比 current 新时返回 true */
export function isNewerVersion(release: string, current: string): boolean {
  const nums = (value: string) => value.replace(/^v/i, "").split(".").map((seg) => parseInt(seg, 10) || 0);
  const releaseNums = nums(release);
  const currentNums = nums(current);
  const maxLen = Math.max(releaseNums.length, currentNums.length);
  for (let index = 0; index < maxLen; index++) {
    const left = releaseNums[index] ?? 0;
    const right = currentNums[index] ?? 0;
    if (left !== right) return left > right;
  }
  // 各段数值相等（含版本相同）不算更新；带预发布后缀（-beta 等）的一方按旧版处理
  const releasePre = /[-+]/.test(release.replace(/^v/i, ""));
  const currentPre = /[-+]/.test(current.replace(/^v/i, ""));
  return !releasePre && currentPre;
}

/** 统一格式化引擎后端与 CUDA 版本标识：如 "CUDA 12.4"、"CUDA 12"、"Vulkan"、"CPU" */
export function formatEngineBackend(
  backend?: string | null,
  cudaVersion?: string | null,
): string {
  const b = (backend || "cuda").toLowerCase();
  if (b.includes("cuda")) {
    if (cudaVersion && cudaVersion.trim()) {
      const v = cudaVersion.trim().replace(/^cuda[-_]?/i, "").replace(/^cu/i, "");
      return `CUDA ${v}`;
    }
    const match = b.match(/(?:cuda[-_]?|cu)(\d+(?:\.\d+)?)/i);
    if (match && match[1]) {
      return `CUDA ${match[1]}`;
    }
    return "CUDA";
  }
  if (b === "vulkan") return "Vulkan";
  if (b === "cpu") return "CPU";
  return backend?.toUpperCase() || "CUDA";
}

