import type { AppConfig, LlamaLogPayload, ModelAsset, Profile } from "./types";
import { formatMessage, getLocale } from "./i18n";

/** 当前应用版本（与 tauri.conf.json / package.json 保持一致）：浏览器模式回退值，检测更新的比较基线 */
export const APP_VERSION = "0.3.1";
/** 项目信息：GitHub 仓库（owner/repo）与主页地址 */
export const APP_REPO = "Crvesoft/CookLLM";
export const PROJECT_URL = `https://github.com/${APP_REPO}`;

export const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 合并导入的配置：同路径模型保留本机条目并补齐缺失预设；调用方传入本机不存在的路径集合。 */
export function mergeImportedConfig(current: AppConfig, incoming: AppConfig, missingPaths: Set<string> = new Set()): { config: AppConfig; added: number; updated: number; skipped: number } {
  const missing = (path?: string) => missingPaths.has((path || "").toLowerCase());
  const byPath = new Map(current.models.map((model) => [model.path.toLowerCase(), model]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const models = [...current.models];
  for (const raw of incoming.models || []) {
    const path = raw.path?.trim();
    if (!path || missing(path)) { skipped += 1; continue; }
    const existing = byPath.get(path.toLowerCase());
    if (!existing) {
      models.push(raw);
      added += 1;
      continue;
    }
    const known = new Set(existing.profiles.map((profile) => profile.id));
    const profiles = [...existing.profiles];
    for (const profile of raw.profiles || []) {
      if (!known.has(profile.id)) profiles.push(profile);
    }
    const index = models.findIndex((model) => model.id === existing.id);
    if (index >= 0 && profiles.length !== existing.profiles.length) {
      models[index] = { ...existing, profiles, tags: existing.tags?.length ? existing.tags : raw.tags };
      updated += 1;
    }
  }
  const engines = [...(current.engines || [])];
  const engineIds = new Set(engines.map((engine) => engine.id));
  for (const engine of incoming.engines || []) {
    if (engine.path?.trim() && !missing(engine.path) && !engineIds.has(engine.id)) engines.push(engine);
  }
  return {
    config: {
      ...current,
      models,
      engines,
      customTags: Array.from(new Set([...(current.customTags || []), ...(incoming.customTags || [])])),
      serverPath: current.serverPath || incoming.serverPath,
      activeEngineId: current.activeEngineId || incoming.activeEngineId,
    },
    added,
    updated,
    skipped,
  };
}
export const DEFAULT_PROFILES: Profile[] = [
  { id: "balanced", name: "均衡模式", description: "日常对话与编码的推荐配置", host: "0.0.0.0", port: 9931, gpuLayers: 35, contextSize: 8192, threads: 8, parallel: 1, batchSize: 512, ubatchSize: 256, flashAttention: true, ncmoeLayers: 0, mtp: false, mtpDraftPath: undefined, specDraftNMax: 3, cacheTypeK: "f32", cacheTypeV: "f32", jinja: true, reasoning: "auto", reasoningEffort: "auto", reasoningBudget: -1, noMmprojOffload: false, loadMode: "mmap", temperature: 0.7, topP: 0.9, minP: 0.05, repeatPenalty: 1.1, extraArgs: "" },
  { id: "deep-thought", name: "深度思考", description: "长上下文与稳定输出，适合复杂推理", host: "0.0.0.0", port: 9931, gpuLayers: 48, contextSize: 32768, threads: 10, parallel: 1, batchSize: 512, ubatchSize: 256, flashAttention: true, ncmoeLayers: 0, mtp: false, mtpDraftPath: undefined, specDraftNMax: 3, cacheTypeK: "q8_0", cacheTypeV: "q8_0", jinja: true, reasoning: "on", reasoningEffort: "high", reasoningBudget: -1, noMmprojOffload: false, loadMode: "mmap", temperature: 0.55, topP: 0.92, minP: 0.03, repeatPenalty: 1.08, extraArgs: "" },
  { id: "low-memory", name: "低显存", description: "保守卸载与小批次，降低资源占用", host: "0.0.0.0", port: 9931, gpuLayers: 12, contextSize: 4096, threads: 6, parallel: 1, batchSize: 128, ubatchSize: 128, flashAttention: true, ncmoeLayers: 0, mtp: false, mtpDraftPath: undefined, specDraftNMax: 3, cacheTypeK: "f16", cacheTypeV: "f16", jinja: false, reasoning: "auto", reasoningEffort: "auto", reasoningBudget: -1, noMmprojOffload: false, loadMode: "mmap", temperature: 0.75, topP: 0.9, minP: 0.05, repeatPenalty: 1.12, extraArgs: "" },
];

/** ninfer 模型导入时的默认预设：对齐 NInfer 官方 s-128k 推荐配置，仅此一个 */
export const DEFAULT_NINFER_PROFILES: Profile[] = [
  {
    id: "s-128k",
    name: "NInfer · 128K",
    description: "对齐 NInfer 官方推荐：xhigh 深度思考 · 输出不设限 · rk8v4 KV",
    host: "127.0.0.1",
    port: 18081,
    gpuLayers: 99,
    contextSize: 131072,
    threads: 8,
    parallel: 1,
    batchSize: 512,
    ubatchSize: 256,
    flashAttention: true,
    ncmoeLayers: 0,
    mtp: true,
    specDraftNMax: 4,
    cacheTypeK: "rk8v4",
    cacheTypeV: "rk8v4",
    jinja: true,
    reasoning: "on",
    reasoningEffort: "xhigh",
    reasoningBudget: -1,
    noMmprojOffload: false,
    loadMode: "mmap",
    temperature: 1.0,
    topP: 0.95,
    minP: 0.0,
    repeatPenalty: 1.0,
    extraArgs: "",
    kvDtype: "rk8v4",
    prefillChunk: 256,
    fastPrefillKernel: true,
    cudaMemoryPolicy: "strict",
    deviceIndex: 0,
    deviceProfile: "off",
    specMtp: true,
    draftTokens: 4,
    adaptiveMtp: true,
    ngramDraftTokens: 31,
    hostCacheMib: 6144,
    kvCapacity: 131072,
    defaultMaxTokens: 0,
    topK: 20,
    seed: 42,
    cudaGraphAllowanceMib: 72,
  },
];

/** 挑取若干默认预设作为某模型的专属副本（浅拷贝即可，Profile 全部为原始字段） */
export function defaultsFor(ids: string[]): Profile[] {
  const owned = ids.map((id) => DEFAULT_PROFILES.find((p) => p.id === id)).filter((p): p is Profile => Boolean(p));
  return (owned.length ? owned : [DEFAULT_PROFILES[0]]).map((p) => ({ ...p, id: uid("profile") }));
}

/** 根据模型文件类型（.gguf / .ninfer）智能匹配生成全套初始预设副本 */
export function defaultProfilesForModel(path: string): Profile[] {
  if (path.toLowerCase().endsWith(".ninfer")) {
    return DEFAULT_NINFER_PROFILES.map((p) => ({ ...p, id: uid("profile") }));
  }
  return defaultsFor(["balanced", "deep-thought", "low-memory"]);
}

export const DEMO_MODELS: ModelAsset[] = [
  { id: "qwen-25-32b", name: "Qwen 2.5 32B Instruct", path: "D:\\Models\\Qwen2.5-32B-Instruct-Q4_K_M.gguf", sizeBytes: 19_840_000_000, architecture: "Qwen2", quantization: "Q4_K_M", parameters: "32.8B", profiles: defaultsFor(["balanced", "deep-thought", "low-memory"]), accent: "violet" },
  { id: "llama-31-8b", name: "Llama 3.1 8B Instruct", path: "D:\\Models\\Meta-Llama-3.1-8B-Instruct-Q6_K.gguf", sizeBytes: 6_610_000_000, architecture: "Llama", quantization: "Q6_K", parameters: "8.0B", profiles: defaultsFor(["balanced", "low-memory"]), accent: "cyan" },
  { id: "deepseek-r1-14b", name: "DeepSeek R1 Distill 14B", path: "D:\\Models\\DeepSeek-R1-Distill-Qwen-14B-Q5_K_M.gguf", sizeBytes: 10_120_000_000, architecture: "Qwen2", quantization: "Q5_K_M", parameters: "14.8B", profiles: defaultsFor(["deep-thought", "balanced"]), accent: "amber" },
];
export const DEMO_CONFIG: AppConfig = {
  serverPath: "C:\\llama.cpp\\llama-server.exe",
  activeEngineId: "engine-default",
  engines: [
    {
      id: "engine-default",
      name: "官方 CUDA",
      path: "C:\\llama.cpp\\llama-server.exe",
      backend: "cuda",
      version: "b11060",
    },
  ],
  models: DEMO_MODELS,
  preferredModelId: "qwen-25-32b",
  preferredProfileId: "deep-thought",
};

/** 兼容旧配置文件：旧版预设存在全局池 config.profiles，并按模型 profileIds 引用。此处把每个模型缺少的预设回填为它自己的副本。 */
export function migrateConfig(config: AppConfig): AppConfig {
  const models = (config.models || []).map((model) => {
    const hasProfiles = Boolean(model.profiles && model.profiles.length > 0);
    const legacyIds = (model as unknown as { profileIds?: string[] }).profileIds;
    const profiles = hasProfiles
      ? model.profiles
      : (legacyIds && legacyIds.length ? defaultsFor(legacyIds) : [{ ...DEFAULT_PROFILES[0], id: uid("profile") }]);
    return {
      ...model,
      profiles: profiles.map((p) => {
        const legacy = p as Profile & { ncmoe?: boolean };
        const hasNcmoe = typeof (p as Partial<Profile>).ncmoeLayers === "number";
        const hasMtp = typeof (p as Partial<Profile>).mtp === "boolean";
        const hasMtpDraft = typeof (p as Partial<Profile>).mtpDraftPath === "string" && Boolean((p as Partial<Profile>).mtpDraftPath?.trim());
        const hasSpecDraftNMax = typeof (p as Partial<Profile>).specDraftNMax === "number";
        const rawBudget = (p as Partial<Profile>).reasoningBudget;
        const hasReasoningBudget = typeof rawBudget === "number" && Number.isFinite(rawBudget);
        const hasNoMmprojOffload = typeof (p as Partial<Profile>).noMmprojOffload === "boolean";
        return {
          ...p,
          ncmoeLayers: hasNcmoe ? (p as Profile).ncmoeLayers : (legacy.ncmoe ? 1 : 0),
          mtp: hasMtp ? (p as Profile).mtp : false,
          mtpDraftPath: hasMtpDraft ? (p as Profile).mtpDraftPath : undefined,
          specDraftNMax: hasSpecDraftNMax ? (p as Profile).specDraftNMax : 3,
          reasoningBudget: hasReasoningBudget ? Math.max(-1, Math.trunc(rawBudget!)) : -1,
          noMmprojOffload: hasNoMmprojOffload ? (p as Profile).noMmprojOffload : false,
        };
      }),
    };
  });

  // 引擎多分支迁移：若 engines 为空且 serverPath 存在，自动初始化一个默认分支并同步
  let engines = config.engines ? [...config.engines] : [];
  let activeEngineId = config.activeEngineId;
  const currentPath = (config.serverPath || "").trim();

  if (engines.length === 0 && currentPath) {
    const defaultId = uid("engine");
    engines = [
      {
        id: defaultId,
        name: "默认引擎",
        path: currentPath,
        backend: "cuda",
      },
    ];
    activeEngineId = defaultId;
  }

  if (engines.length > 0) {
    if (!activeEngineId || !engines.some((e) => e.id === activeEngineId)) {
      activeEngineId = engines[0].id;
    }
    const active = engines.find((e) => e.id === activeEngineId);
    if (active && active.path) {
      config.serverPath = active.path;
    }
  }

  return { ...config, models, engines, activeEngineId };
}
export const INITIAL_LOGS: LlamaLogPayload[] = [
  { stream: "system", line: "CookLLM runtime initialized · waiting for a model", timestamp: Date.now() - 1800 },
  // 模块加载时按当前语言生成（一次性日志行，切换语言后不重译）
  { stream: "stdout", line: formatMessage(getLocale(), "log.readyLine"), timestamp: Date.now() - 900 },
];

export const DEFAULT_TAG_POOL_ZH = [
  "角色扮演",
  "代码编程",
  "逻辑推理",
  "文本创作",
  "视觉多模态",
  "中文增强",
  "工具调用",
  "长文本",
  "无审查",
];

export const DEFAULT_TAG_POOL_EN = [
  "Roleplay",
  "Coding",
  "Reasoning",
  "Writing",
  "Vision",
  "ToolCall",
  "LongContext",
  "Uncensored",
];
