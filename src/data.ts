import type { AppConfig, LlamaLogPayload, ModelAsset, Profile } from "./types";
import { formatMessage, getLocale } from "./i18n";

/** 当前应用版本（与 tauri.conf.json / package.json 保持一致）：浏览器模式回退值，检测更新的比较基线 */
export const APP_VERSION = "0.1.2";
/** 项目信息：GitHub 仓库（owner/repo）与主页地址 */
export const APP_REPO = "Crvesoft/CookLLM";
export const PROJECT_URL = `https://github.com/${APP_REPO}`;

export const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export const DEFAULT_PROFILES: Profile[] = [
  { id: "balanced", name: "均衡模式", description: "日常对话与编码的推荐配置", host: "0.0.0.0", port: 9931, gpuLayers: 35, contextSize: 8192, threads: 8, parallel: 1, batchSize: 512, ubatchSize: 256, flashAttention: true, cacheTypeK: "f32", cacheTypeV: "f32", jinja: true, reasoning: "auto", reasoningEffort: "auto", loadMode: "mmap", temperature: 0.7, topP: 0.9, minP: 0.05, repeatPenalty: 1.1, extraArgs: "" },
  { id: "deep-thought", name: "深度思考", description: "长上下文与稳定输出，适合复杂推理", host: "0.0.0.0", port: 9931, gpuLayers: 48, contextSize: 32768, threads: 10, parallel: 1, batchSize: 512, ubatchSize: 256, flashAttention: true, cacheTypeK: "q8_0", cacheTypeV: "q8_0", jinja: true, reasoning: "on", reasoningEffort: "high", loadMode: "mmap", temperature: 0.55, topP: 0.92, minP: 0.03, repeatPenalty: 1.08, extraArgs: "" },
  { id: "low-memory", name: "低显存", description: "保守卸载与小批次，降低资源占用", host: "0.0.0.0", port: 9931, gpuLayers: 12, contextSize: 4096, threads: 6, parallel: 1, batchSize: 128, ubatchSize: 128, flashAttention: true, cacheTypeK: "f16", cacheTypeV: "f16", jinja: false, reasoning: "auto", reasoningEffort: "auto", loadMode: "mmap", temperature: 0.75, topP: 0.9, minP: 0.05, repeatPenalty: 1.12, extraArgs: "" },
];

/** 挑取若干默认预设作为某模型的专属副本（浅拷贝即可，Profile 全部为原始字段） */
function defaultsFor(ids: string[]): Profile[] {
  const owned = ids.map((id) => DEFAULT_PROFILES.find((p) => p.id === id)).filter((p): p is Profile => Boolean(p));
  return (owned.length ? owned : [DEFAULT_PROFILES[0]]).map((p) => ({ ...p }));
}

export const DEMO_MODELS: ModelAsset[] = [
  { id: "qwen-25-32b", name: "Qwen 2.5 32B Instruct", path: "D:\\Models\\Qwen2.5-32B-Instruct-Q4_K_M.gguf", sizeBytes: 19_840_000_000, architecture: "Qwen2", quantization: "Q4_K_M", parameters: "32.8B", profiles: defaultsFor(["balanced", "deep-thought", "low-memory"]), accent: "violet" },
  { id: "llama-31-8b", name: "Llama 3.1 8B Instruct", path: "D:\\Models\\Meta-Llama-3.1-8B-Instruct-Q6_K.gguf", sizeBytes: 6_610_000_000, architecture: "Llama", quantization: "Q6_K", parameters: "8.0B", profiles: defaultsFor(["balanced", "low-memory"]), accent: "cyan" },
  { id: "deepseek-r1-14b", name: "DeepSeek R1 Distill 14B", path: "D:\\Models\\DeepSeek-R1-Distill-Qwen-14B-Q5_K_M.gguf", sizeBytes: 10_120_000_000, architecture: "Qwen2", quantization: "Q5_K_M", parameters: "14.8B", profiles: defaultsFor(["deep-thought", "balanced"]), accent: "amber" },
];
export const DEMO_CONFIG: AppConfig = { serverPath: "C:\\llama.cpp\\llama-server.exe", models: DEMO_MODELS, preferredModelId: "qwen-25-32b", preferredProfileId: "deep-thought" };

/** 兼容旧配置文件：旧版预设存在全局池 config.profiles，并按模型 profileIds 引用。此处把每个模型缺少的预设回填为它自己的副本。 */
export function migrateConfig(config: AppConfig): AppConfig {
  const legacy = config.profiles || [];
  const models = (config.models || []).map((model) => {
    const profiles = model.profiles && model.profiles.length
      ? model.profiles
      : defaultsFor((model as unknown as { profileIds?: string[] }).profileIds || []);
    return { ...model, profiles: profiles.map((p) => ({ ...p })) };
  });
  return { ...config, models };
}
export const INITIAL_LOGS: LlamaLogPayload[] = [
  { stream: "system", line: "CookLLM runtime initialized · waiting for a model", timestamp: Date.now() - 1800 },
  // 模块加载时按当前语言生成（一次性日志行，切换语言后不重译）
  { stream: "stdout", line: formatMessage(getLocale(), "log.readyLine"), timestamp: Date.now() - 900 },
];
