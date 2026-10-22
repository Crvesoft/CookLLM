import type { MessageKey } from "../../i18n";
import { openExternal } from "../../tauri";
import type { HfFile, HfModel } from "../../types";

/* ---------------- 刻面筛选定义 ---------------- */

export type FamilyKey = "all" | "qwen" | "llama" | "deepseek" | "glm" | "gemma" | "mistral" | "code";
export type QuantKey = "all" | "q1" | "q2" | "q3" | "q4" | "q5" | "q6" | "q8" | "q16";
export type TaskKey = "chat" | "code" | "vision" | "reasoning";
export type SortKey = "downloads" | "likes" | "updated" | "hot";

export const FAMILIES: Array<{ key: FamilyKey; label: string; needles: string[] }> = [
  { key: "all", label: "explore.filterAll", needles: [] },
  { key: "qwen", label: "Qwen", needles: ["qwen"] },
  { key: "llama", label: "Llama", needles: ["llama"] },
  { key: "deepseek", label: "DeepSeek", needles: ["deepseek"] },
  { key: "glm", label: "GLM", needles: ["glm"] },
  { key: "gemma", label: "Gemma", needles: ["gemma"] },
  { key: "mistral", label: "Mistral", needles: ["mistral", "mixtral", "codestral"] },
  { key: "code", label: "explore.facetFamilyCode", needles: ["code", "coder", "starcoder"] },
];

export const TASKS: Array<{ key: TaskKey; label: string; needles: string[] }> = [
  { key: "chat", label: "explore.facetTaskChat", needles: ["chat", "conversation", "text-generation", "instruct", "general", "alpaca"] },
  { key: "code", label: "explore.facetTaskCode", needles: ["code", "coder", "coding", "starcoder"] },
  { key: "vision", label: "explore.facetTaskVision", needles: ["vision", "multimodal", "vl", "mmproj", "image", "audio"] },
  { key: "reasoning", label: "explore.facetTaskReasoning", needles: ["reasoning", "r1", "cot", "think", "deepseek-r1"] },
];

export const QUANTS: Array<{ key: QuantKey; label: string; bits: number[]; cls: string }> = [
  { key: "q1", label: "explore.quantBit1", bits: [1], cls: "quant-1" },
  { key: "q2", label: "explore.quantBit2", bits: [2], cls: "quant-2" },
  { key: "q3", label: "explore.quantBit3", bits: [3], cls: "quant-3" },
  { key: "q4", label: "explore.quantBit4", bits: [4], cls: "quant-4" },
  { key: "q5", label: "explore.quantBit5", bits: [5], cls: "quant-5" },
  { key: "q6", label: "explore.quantBit6", bits: [6], cls: "quant-6" },
  { key: "q8", label: "explore.quantBit8", bits: [8], cls: "quant-8" },
  { key: "q16", label: "explore.quantBit16", bits: [16], cls: "quant-16" },
];

export const PARAM_SLIDER_LABELS = ["<1B", "3B", "7B", "14B", "32B", ">70B"];
export const PARAM_LAST_INDEX = PARAM_SLIDER_LABELS.length - 1;

export const HF_SORT: Record<SortKey, string> = {
  downloads: "downloads",
  likes: "likes",
  updated: "lastModified",
  hot: "trendingScore",
};
export const MS_SORT: Record<SortKey, string> = {
  downloads: "downloads",
  likes: "likes",
  updated: "last_modified",
  hot: "default",
};

/** 模型量化比特位：优先 Rust 解析字段，其次从推荐量化/标签/文件名提取 */
export function modelQuantBits(model: HfModel): number | null {
  if (model.quantBits != null && model.quantBits > 0) return model.quantBits;
  const sources = [model.sampleQuant, model.id, ...model.tags].filter(Boolean) as string[];
  for (const src of sources) {
    const upper = src.toUpperCase();
    if (/TERNARY|1\.58-?BIT|PTQ1|BONSAI|1-?BIT/.test(upper)) return 1;
    if (/PQ2|2-?BIT|IQ2/.test(upper)) return 2;
    if (/IQ3|GSQ|3-?BIT/.test(upper)) return 3;
    if (/NVFP4|NF4|W4A4|FP4|INT4|4-?BIT/.test(upper)) return 4;
    if (/5-?BIT/.test(upper)) return 5;
    if (/6-?BIT/.test(upper)) return 6;
    if (/FP8|INT8|W8A8/.test(upper) || (!upper.includes("1.58") && /8-?BIT/.test(upper))) return 8;
    if (/BF16|FP16|16-?BIT/.test(upper)) return 16;
    const match = upper.match(/IQ?(\d)/);
    if (match) return Number(match[1]);
  }
  return null;
}

/** 模型参数量展示文案（如 0.5B / 7B / 14B / 70B） */
export function paramLabel(model: HfModel): string {
  const value = model.parametersB;
  if (!value || value <= 0) return "";
  if (value >= 100) return Math.round(value) + "B";
  if (Number.isInteger(value) || value >= 10) return Math.round(value) + "B";
  return value.toFixed(1).replace(/\.0$/, "") + "B";
}

/** 模型量化展示文案（如 Q4 / IQ3 / NVFP4 / PQ2 / 1.58b 等），优先短标签 */
export function quantLabel(model: HfModel): string {
  const sqUpper = (model.sampleQuant || "").toUpperCase();
  if (sqUpper.includes("NVFP4")) return "NVFP4";
  if (sqUpper.includes("W4A4")) return "W4A4";
  if (sqUpper.includes("NF4")) return "NF4";
  if (sqUpper.includes("PQ2")) return "PQ2";
  if (sqUpper.includes("GSQ")) return "GSQ";
  if (sqUpper.includes("TERNARY") || sqUpper.includes("1.58BIT") || sqUpper.includes("1.58-BIT") || sqUpper.includes("BONSAI")) return "1.58b";
  if (sqUpper.includes("BF16")) return "BF16";
  if (sqUpper.includes("FP16")) return "FP16";
  if (sqUpper.includes("FP8")) return "FP8";
  if (sqUpper.includes("INT8")) return "INT8";
  if (sqUpper.includes("INT4")) return "INT4";

  if (model.quantBits != null && model.quantBits > 0) return "Q" + model.quantBits;
  if (model.sampleQuant) {
    const match = model.sampleQuant.toUpperCase().match(/IQ?\d+/);
    if (match) return match[0];
  }
  return "";
}

/** 从模型标签 / 推荐量化中收集仓库包含的量化规格（如 ["Q2","Q4","Q8"] / ["NVFP4", "FP8"]） */
export function quantSpecsOf(model: HfModel): string[] {
  const seen = new Set<string>();
  const add = (text: string) => {
    const upper = text.toUpperCase();
    if (upper.includes("NVFP4")) seen.add("NVFP4");
    if (upper.includes("NF4")) seen.add("NF4");
    if (upper.includes("W4A4")) seen.add("W4A4");
    if (upper.includes("PQ2")) seen.add("PQ2");
    if (upper.includes("GSQ")) seen.add("GSQ");
    if (upper.includes("TERNARY") || upper.includes("1.58BIT") || upper.includes("1.58-BIT") || upper.includes("BONSAI")) seen.add("1.58b");
    if (upper.includes("BF16")) seen.add("BF16");
    if (upper.includes("FP8")) seen.add("FP8");
    if (upper.includes("INT8")) seen.add("INT8");
    for (const tok of upper.match(/IQ?\d+/g) ?? []) {
      const digits = tok.match(/(\d+)/)?.[1];
      if (digits) seen.add("Q" + digits);
    }
  };
  add(model.sampleQuant ?? "");
  for (const tag of model.tags) add(tag);
  return [...seen].slice(0, 3);
}

/** 从 GGUF / NINFER 文件名提取量化比特位（Q4_K_M → 4、IQ3_M → 3、NVFP4 → 4、PQ2 → 2、Ternary → 1、FP16/BF16 → 16） */
export function quantBitsOfFile(name: string): number | null {
  const upper = name.toUpperCase();
  if (/F(?:P)?16|BF16|FP32|F32/.test(upper)) return 16;
  if (/NVFP4|NF4|W4A4|INT4|FP4/.test(upper)) return 4;
  if (/PQ2|2-?BIT/.test(upper)) return 2;
  if (/GSQ|IQ3/.test(upper)) return 3;
  if (/TERNARY|1\.58-?BIT|PTQ1|BONSAI/.test(upper)) return 1;
  if (/FP8|INT8|W8A8/.test(upper) || (!upper.includes("1.58") && /8-?BIT/.test(upper))) return 8;
  const match = upper.match(/IQ?(\d)/);
  return match ? Number(match[1]) : null;
}

/** 从文件名提取量化标签（如 Q4_K_M / IQ3_M / NVFP4 / PQ2） */
export function quantBadge(name: string): string {
  const upper = name.toUpperCase();
  if (upper.includes("NVFP4")) return "NVFP4";
  if (upper.includes("W4A4")) return "W4A4";
  if (upper.includes("NF4")) return "NF4";
  if (upper.includes("PQ2_0") || upper.includes("PQ2")) return "PQ2";
  if (upper.includes("GSQ")) return "GSQ";
  if (upper.includes("TERNARY")) return "Ternary";
  if (upper.includes("BONSAI")) return "Bonsai";
  if (upper.includes("BF16")) return "BF16";
  const match = name.match(/[IQ]?\d(?:_[A-Z0-9]+)+/i);
  return match ? match[0].toUpperCase() : "";
}

/** 根据文件大小给出行内显存/运行建议标签 */
export function vramTag(file: HfFile, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string | null {
  const gb = file.sizeBytes / 1024 / 1024 / 1024;
  if (!file.sizeBytes) return null;
  if (gb >= 24) return t("explore.vramShare");
  if (gb >= 8) return t("explore.vramFit", { vram: "16G" });
  return t("explore.vramLight");
}

export function openHf(id: string) {
  void openExternal("https://huggingface.co/" + id);
}

export function openMs(id: string) {
  void openExternal("https://modelscope.cn/models/" + id);
}

export function formatCount(value: number) {
  const compact = (divisor: number, suffix: string) => {
    const scaled = Math.floor(value / divisor * 10) / 10;
    return scaled % 1 === 0 ? `${scaled}${suffix}` : `${scaled.toFixed(1)}${suffix}`;
  };
  if (value >= 1_000_000) return compact(1_000_000, "M");
  if (value >= 1_000) return compact(1_000, "k");
  return value.toLocaleString();
}

/** 模型仓库的 HF 许可协议签署页（gated 模型无访问权限时引导用户前往同意）。 */
export function hfLicenseUrl(repo: string): string {
  const id = repo.trim().replace(/\/+$/, "");
  return `https://huggingface.co/${id}`;
}
