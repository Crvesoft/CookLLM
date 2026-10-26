import type { AppConfig, LlamaEngine, LlamaLogPayload, ModelAsset, Profile } from "./types";
import { formatMessage, getLocale } from "./i18n";
import { DEFAULT_SHORTCUTS } from "./utils";

/** 当前应用版本（与 tauri.conf.json / package.json 保持一致）：浏览器模式回退值，检测更新的比较基线 */
export const APP_VERSION = "0.4.2";
/** 项目信息：GitHub 仓库（owner/repo）与主页地址 */
export const APP_REPO = "Crvesoft/CookLLM";
export const PROJECT_URL = `https://github.com/${APP_REPO}`;

export const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export interface MergeImportOptions {
  /** 导入模式：merge (智能合并) | overwrite (完全覆盖) */
  mode?: "merge" | "overwrite";
  /** 当同路径/同ID模型在本地存在时，是否使用备份中的预设参数更新本地同名预设（默认 true） */
  updateExistingProfiles?: boolean;
  /** 是否合并全局应用设置（网络代理、首选引擎/模型、界面偏好等；默认 true） */
  importAppSettings?: boolean;
  /** 物理路径不存在的模型处理方式：keep (保留条目并可后续重设路径) | skip (跳过)；默认 keep */
  missingPathStrategy?: "keep" | "skip";
  /** 路径重映射：用于跨机或换盘迁移，将旧路径前缀替换为新路径前缀 */
  pathRemap?: { from: string; to: string };
}

export interface MergeImportResult {
  config: AppConfig;
  addedModels: number;
  updatedModels: number;
  skippedModels: number;
  addedEngines: number;
  importedSettings: boolean;
}

/** 路径前缀重映射辅助：将 Windows 或通用文件路径从旧目录前缀映射到新目录 */
export function applyPathRemap(path: string | undefined, remap?: { from: string; to: string }): string {
  if (!path || !remap || !remap.from?.trim() || !remap.to?.trim()) return path || "";
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const normPath = path.replace(/\\/g, "/");
  const normFrom = normalize(remap.from.trim());
  const normTo = normalize(remap.to.trim());

  if (normPath.toLowerCase() === normFrom.toLowerCase()) {
    return path.includes("\\") ? normTo.replace(/\//g, "\\") : normTo;
  }
  if (normPath.toLowerCase().startsWith(normFrom.toLowerCase() + "/")) {
    const rest = normPath.slice(normFrom.length + 1);
    const joined = `${normTo}/${rest}`;
    return path.includes("\\") ? joined.replace(/\//g, "\\") : joined;
  }
  return path;
}

/** 合并导入的配置：同路径模型保留本机条目并补齐缺失预设；支持跨机迁移保留、路径重映射与覆盖/合并模式。 */
export function mergeImportedConfig(
  current: AppConfig,
  incoming: AppConfig,
  missingPaths: Set<string> = new Set(),
  options: MergeImportOptions = {}
): MergeImportResult {
  const mode = options.mode || "merge";
  const updateExistingProfiles = options.updateExistingProfiles ?? true;
  const importAppSettings = options.importAppSettings ?? true;
  const missingPathStrategy = options.missingPathStrategy ?? "keep";
  const remap = options.pathRemap;

  const remapModel = (model: ModelAsset): ModelAsset => {
    if (!remap) return model;
    return {
      ...model,
      path: applyPathRemap(model.path, remap),
      profiles: (model.profiles || []).map((p) => ({
        ...p,
        mmprojPath: p.mmprojPath ? applyPathRemap(p.mmprojPath, remap) : undefined,
        mtpDraftPath: p.mtpDraftPath ? applyPathRemap(p.mtpDraftPath, remap) : undefined,
        chatTemplatePath: p.chatTemplatePath ? applyPathRemap(p.chatTemplatePath, remap) : undefined,
      })),
    };
  };

  const remapEngine = (engine: LlamaEngine): LlamaEngine => {
    if (!remap) return engine;
    return {
      ...engine,
      path: applyPathRemap(engine.path, remap),
    };
  };

  const remappedIncomingModels = (incoming.models || []).map(remapModel);
  const remappedIncomingEngines = (incoming.engines || []).map(remapEngine);

  const isMissing = (path?: string) => {
    if (!path) return true;
    return missingPaths.has(path.toLowerCase());
  };

  let addedModels = 0;
  let updatedModels = 0;
  let skippedModels = 0;
  let addedEngines = 0;

  if (mode === "overwrite") {
    const models: ModelAsset[] = [];
    for (const raw of remappedIncomingModels) {
      if (missingPathStrategy === "skip" && isMissing(raw.path)) {
        skippedModels += 1;
        continue;
      }
      models.push(raw);
      addedModels += 1;
    }

    const engines: LlamaEngine[] = [];
    for (const engine of remappedIncomingEngines) {
      if (missingPathStrategy === "skip" && isMissing(engine.path)) {
        continue;
      }
      engines.push(engine);
      addedEngines += 1;
    }

    return {
      config: {
        ...current,
        serverPath: incoming.serverPath || current.serverPath,
        activeEngineId: incoming.activeEngineId || current.activeEngineId,
        engines,
        models,
        customTags: Array.from(new Set([...(current.customTags || []), ...(incoming.customTags || [])])),
        theme: incoming.theme ?? current.theme,
        language: incoming.language ?? current.language,
        gpuMonitorEnabled: incoming.gpuMonitorEnabled ?? current.gpuMonitorEnabled,
        exploreSidebarCollapsed: incoming.exploreSidebarCollapsed ?? current.exploreSidebarCollapsed,
        preferredModelId: incoming.preferredModelId ?? current.preferredModelId,
        preferredProfileId: incoming.preferredProfileId ?? current.preferredProfileId,
        network: incoming.network ?? current.network,
        llamacppDir: incoming.llamacppDir ?? current.llamacppDir,
        modelsDir: incoming.modelsDir ?? current.modelsDir,
        autoUpdateEnabled: incoming.autoUpdateEnabled ?? current.autoUpdateEnabled,
        minimizeToTrayOnClose: incoming.minimizeToTrayOnClose ?? current.minimizeToTrayOnClose,
        llamaBackend: incoming.llamaBackend ?? current.llamaBackend,
        llamaCudaVersion: incoming.llamaCudaVersion ?? current.llamaCudaVersion,
        shortcuts: incoming.shortcuts
          ? { ...DEFAULT_SHORTCUTS, ...incoming.shortcuts }
          : current.shortcuts,
      },
      addedModels,
      updatedModels: 0,
      skippedModels,
      addedEngines,
      importedSettings: true,
    };
  }

  // Merge Mode
  const byPath = new Map(current.models.map((model) => [model.path.toLowerCase(), model]));
  const byId = new Map(current.models.map((model) => [model.id, model]));
  const models = [...current.models];

  for (const raw of remappedIncomingModels) {
    const path = raw.path?.trim();
    if (!path && !raw.id) {
      skippedModels += 1;
      continue;
    }
    if (missingPathStrategy === "skip" && isMissing(path)) {
      skippedModels += 1;
      continue;
    }

    const existing = (path ? byPath.get(path.toLowerCase()) : undefined) || byId.get(raw.id);
    if (!existing) {
      models.push(raw);
      addedModels += 1;
      continue;
    }

    let modelChanged = false;
    const existingIndex = models.findIndex((m) => m.id === existing.id);
    if (existingIndex < 0) continue;

    const existingProfileMap = new Map(existing.profiles.map((p) => [p.id, p]));
    const mergedProfiles = [...existing.profiles];

    for (const incomingProfile of raw.profiles || []) {
      const target = existingProfileMap.get(incomingProfile.id);
      if (!target) {
        mergedProfiles.push(incomingProfile);
        modelChanged = true;
      } else if (updateExistingProfiles) {
        const idx = mergedProfiles.findIndex((p) => p.id === incomingProfile.id);
        if (idx >= 0) {
          mergedProfiles[idx] = { ...target, ...incomingProfile };
          modelChanged = true;
        }
      }
    }

    const mergedTags = Array.from(new Set([...(existing.tags || []), ...(raw.tags || [])]));
    if (mergedTags.length !== (existing.tags || []).length) {
      modelChanged = true;
    }

    const displayName = existing.displayName || raw.displayName;
    if (displayName !== existing.displayName) {
      modelChanged = true;
    }

    const defaultProfileId = existing.defaultProfileId || raw.defaultProfileId;
    if (defaultProfileId !== existing.defaultProfileId) {
      modelChanged = true;
    }

    if (modelChanged) {
      models[existingIndex] = {
        ...existing,
        displayName,
        defaultProfileId,
        profiles: mergedProfiles,
        tags: mergedTags.length ? mergedTags : undefined,
      };
      updatedModels += 1;
    }
  }

  const engines = [...(current.engines || [])];
  const engineIds = new Set(engines.map((e) => e.id));
  const enginePaths = new Set(engines.map((e) => e.path.toLowerCase()));

  for (const engine of remappedIncomingEngines) {
    if (missingPathStrategy === "skip" && isMissing(engine.path)) {
      continue;
    }
    if (!engineIds.has(engine.id) && !enginePaths.has(engine.path.toLowerCase())) {
      engines.push(engine);
      addedEngines += 1;
    }
  }

  const mergedConfig: AppConfig = {
    ...current,
    models,
    engines,
    customTags: Array.from(new Set([...(current.customTags || []), ...(incoming.customTags || [])])),
    serverPath: current.serverPath || incoming.serverPath,
    activeEngineId: current.activeEngineId || incoming.activeEngineId,
  };

  if (importAppSettings) {
    if (incoming.network && (!current.network || current.network.proxyMode === "system")) {
      mergedConfig.network = incoming.network;
    }
    if (incoming.llamaBackend && !current.llamaBackend) {
      mergedConfig.llamaBackend = incoming.llamaBackend;
    }
    if (incoming.llamaCudaVersion && !current.llamaCudaVersion) {
      mergedConfig.llamaCudaVersion = incoming.llamaCudaVersion;
    }
    if (incoming.modelsDir && !current.modelsDir) {
      mergedConfig.modelsDir = incoming.modelsDir;
    }
    if (incoming.llamacppDir && !current.llamacppDir) {
      mergedConfig.llamacppDir = incoming.llamacppDir;
    }
    if (incoming.theme && !current.theme) {
      mergedConfig.theme = incoming.theme;
    }
    if (incoming.language && !current.language) {
      mergedConfig.language = incoming.language;
    }
    if (incoming.preferredModelId && !current.preferredModelId) {
      mergedConfig.preferredModelId = incoming.preferredModelId;
    }
    if (incoming.preferredProfileId && !current.preferredProfileId) {
      mergedConfig.preferredProfileId = incoming.preferredProfileId;
    }
    const booleanSettings = ["gpuMonitorEnabled", "exploreSidebarCollapsed", "autoUpdateEnabled", "minimizeToTrayOnClose"] as const;
    for (const key of booleanSettings) {
      if (incoming[key] !== undefined && current[key] === undefined) {
        mergedConfig[key] = incoming[key];
      }
    }
    if (incoming.shortcuts) {
      mergedConfig.shortcuts = {
        ...(current.shortcuts ?? DEFAULT_SHORTCUTS),
        ...incoming.shortcuts,
      };
    }
  }

  return {
    config: mergedConfig,
    addedModels,
    updatedModels,
    skippedModels,
    addedEngines,
    importedSettings: importAppSettings,
  };
}
export const DEFAULT_PROFILES: Profile[] = [
  { id: "balanced", name: "均衡模式", description: "日常对话与编码的推荐配置", host: "0.0.0.0", port: 9931, gpuLayers: 35, contextSize: 8192, threads: 8, parallel: 1, batchSize: 512, ubatchSize: 256, flashAttention: true, ncmoeLayers: 0, mtp: false, mtpDraftPath: undefined, specDraftNMax: 3, cacheTypeK: "f32", cacheTypeV: "f32", jinja: true, reasoning: "auto", reasoningEffort: "auto", reasoningBudget: -1, noMmprojOffload: false, loadMode: "mmap", temperature: 0.7, topP: 0.9, minP: 0.05, repeatPenalty: 1.1, extraArgs: "", kvmemBudget: 36864, kvmemGenReserve: 16384 },
  { id: "deep-thought", name: "深度思考", description: "长上下文与稳定输出，适合复杂推理", host: "0.0.0.0", port: 9931, gpuLayers: 48, contextSize: 32768, threads: 10, parallel: 1, batchSize: 512, ubatchSize: 256, flashAttention: true, ncmoeLayers: 0, mtp: false, mtpDraftPath: undefined, specDraftNMax: 3, cacheTypeK: "q8_0", cacheTypeV: "q8_0", jinja: true, reasoning: "on", reasoningEffort: "high", reasoningBudget: -1, noMmprojOffload: false, loadMode: "mmap", temperature: 0.55, topP: 0.92, minP: 0.03, repeatPenalty: 1.08, extraArgs: "", kvmemBudget: 36864, kvmemGenReserve: 16384 },
  { id: "low-memory", name: "低显存", description: "保守卸载与小批次，降低资源占用", host: "0.0.0.0", port: 9931, gpuLayers: 12, contextSize: 4096, threads: 6, parallel: 1, batchSize: 128, ubatchSize: 128, flashAttention: true, ncmoeLayers: 0, mtp: false, mtpDraftPath: undefined, specDraftNMax: 3, cacheTypeK: "f16", cacheTypeV: "f16", jinja: false, reasoning: "auto", reasoningEffort: "auto", reasoningBudget: -1, noMmprojOffload: false, loadMode: "mmap", temperature: 0.75, topP: 0.9, minP: 0.05, repeatPenalty: 1.12, extraArgs: "", kvmemBudget: 36864, kvmemGenReserve: 16384 },
];

/** ninfer 模型导入时的默认预设：对齐 NInfer 官方 64K 纯文本推荐配置，仅此一个 */
export const DEFAULT_NINFER_PROFILES: Profile[] = [
  {
    id: "s-64k",
    name: "NInfer · 64K",
    description: "对齐 NInfer 官方推荐：64K 纯文本 · xhigh 深度思考 · 输出不设限 · k8v4 KV",
    host: "127.0.0.1",
    port: 18081,
    gpuLayers: 99,
    contextSize: 65536,
    threads: 8,
    parallel: 1,
    batchSize: 512,
    ubatchSize: 256,
    flashAttention: true,
    ncmoeLayers: 0,
    mtp: true,
    specDraftNMax: 4,
    cacheTypeK: "k8v4",
    cacheTypeV: "k8v4",
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
    kvDtype: "k8v4",
    prefillChunk: 256,
    fastPrefillKernel: false,
    cudaMemoryPolicy: "default",
    deviceIndex: 0,
    deviceProfile: "auto",
    specMtp: true,
    draftTokens: 4,
    adaptiveMtp: true,
    ngramDraftTokens: 31,
    hostCacheMib: 6144,
    kvCapacity: 65536,
    defaultMaxTokens: 0,
    topK: 20,
    seed: 42,
    cudaGraphAllowanceMib: 72,
    gdnStateFp16: true,
    useAltPrefixCaching: true,
    deviceSnapshotSlots: 1,
    preserveThinking: true,
    vision: false,
    visionCpu: false,
    kvmemBudget: 36864,
    kvmemGenReserve: 16384,
    kvmemHostMib: 16384,
    kvmemSessions: 1,
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
        const hasKvmemBudget = typeof (p as Partial<Profile>).kvmemBudget === "number";
        const hasKvmemGenReserve = typeof (p as Partial<Profile>).kvmemGenReserve === "number";
        return {
          ...p,
          ncmoeLayers: hasNcmoe ? (p as Profile).ncmoeLayers : (legacy.ncmoe ? 1 : 0),
          mtp: hasMtp ? (p as Profile).mtp : false,
          mtpDraftPath: hasMtpDraft ? (p as Profile).mtpDraftPath : undefined,
          specDraftNMax: hasSpecDraftNMax ? (p as Profile).specDraftNMax : 3,
          reasoningBudget: hasReasoningBudget ? Math.max(-1, Math.trunc(rawBudget!)) : -1,
          noMmprojOffload: hasNoMmprojOffload ? (p as Profile).noMmprojOffload : false,
          kvmemBudget: hasKvmemBudget ? (p as Profile).kvmemBudget : 36864,
          kvmemGenReserve: hasKvmemGenReserve ? (p as Profile).kvmemGenReserve : 16384,
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

  let shortcuts = config.shortcuts
    ? {
        ...DEFAULT_SHORTCUTS,
        ...config.shortcuts,
      }
    : {
        ...DEFAULT_SHORTCUTS,
        enabled: false,
      };

  if (shortcuts.switchEngine === "Ctrl+E") {
    shortcuts.switchEngine = "Alt+Shift+E";
  }

  return { ...config, models, engines, activeEngineId, shortcuts };
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
