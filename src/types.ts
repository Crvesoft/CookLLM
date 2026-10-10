export type Page = "models" | "explore" | "playground" | "profiles" | "settings" | "logs";

/** 各页面的日志显示方式：dock=参与页面布局的底部 Dock（除日志页外所有页面），page=整页视图 */
export type LogMode = "dock" | "page";

export const PAGE_LOG_MODE: Record<Page, LogMode> = {
  models: "dock", // 模型仓库：Dock 日志（与会话页统一）
  profiles: "dock", // 运行预设：Dock 日志（与会话页统一）
  explore: "dock", // 社区探索：Dock 日志（与会话页统一）

  playground: "dock", // 会话：Dock 日志（收起为底部状态栏，展开后 WebUI 自适应缩小）
  logs: "page", // 左菜单"日志"页：整页全屏视图，保持默认全屏显示
  settings: "dock", // 设置：Dock 日志（与会话页统一）
};

export interface ModelAsset {
  id: string;
  name: string;
  /** 自定义显示名；为空则回退到 name */
  displayName?: string;
  path: string;
  sizeBytes: number;
  architecture: string;
  quantization: string;
  parameters: string;
  /** 该模型专属的运行预设，互不共享 */
  profiles: Profile[];
  /** 默认启动预设 id（该模型启动时自动选中） */
  defaultProfileId?: string;
  accent: "violet" | "cyan" | "amber" | "rose";
  /** 自定义标签（如角色扮演、代码、未知量化补录等） */
  tags?: string[];
  /** 架构/参数量/量化来自 GGUF / NINFER 文件头，而非文件名猜测 */
  metadataSource?: "gguf" | "ninfer" | "filename";
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  host: string;
  port: number;
  gpuLayers: number;
  contextSize: number;
  threads: number;
  parallel: number;
  batchSize: number;
  ubatchSize: number;
  flashAttention: boolean;
  ncmoeLayers: number;
  mtp: boolean;
  mtpDraftPath?: string;
  specDraftNMax: number;
  cacheTypeK: string;
  cacheTypeV: string;
  jinja: boolean;
  reasoning: string;
  reasoningEffort: string;
  /** 思考 Token 预算（-1 为不限制，0 立即结束，>0 具体上限，对应 --reasoning-budget） */
  reasoningBudget?: number;
  loadMode: string;
  temperature: number;
  topP: number;
  minP: number;
  repeatPenalty: number;
  extraArgs: string;
  /** 该预设挂载的图像识别视觉模型（mmproj）路径；非空时以 --mmproj 附加启动 */
  mmprojPath?: string;
  /** 是否禁止将视觉多模态模型卸载到显存，强制纯系统内存运行（--no-mmproj-offload） */
  noMmprojOffload?: boolean;
  /** 该预设关联的 llama.cpp / ninfer 引擎分支 ID；未指定或为空则跟随全局默认引擎 */
  engineId?: string;

  /** ninfer / ninfer-kvmem 专属：KV 缓存量化类型（如 rk8v4 / int8 / bf16 / nvfp4） */
  kvDtype?: string;
  /** ninfer 专属：预填充分块 Token 数（128 的倍数，如 256 / 512） */
  prefillChunk?: number;
  /** ninfer 专属：快速预热内核开关（--fast-prefill-kernel） */
  fastPrefillKernel?: boolean;
  /** ninfer 专属：显存分配策略（strict / mixed / default） */
  cudaMemoryPolicy?: string;
  /** ninfer 专属：CUDA 显卡序号（--device N） */
  deviceIndex?: number;
  /** ninfer 专属：硬件调优 Profile（off / auto / calibrate） */
  deviceProfile?: string;
  /** ninfer 专属：自定义 Jinja 对话模板路径（--chat-template FILE） */
  chatTemplatePath?: string;
  /** ninfer 专属：硬件路线 profile 配置文件路径（--device-profile-path FILE） */
  deviceProfilePath?: string;
  /** ninfer 专属：自适应 MTP 投机采样开关 */
  specMtp?: boolean;
  /** ninfer 专属：MTP 草稿 Token 步数（--draft-tokens N） */
  draftTokens?: number;
  /** ninfer 专属：自适应草稿衰减（--adaptive-mtp） */
  adaptiveMtp?: boolean;
  /** ninfer 专属：N-gram 匹配步数（--ngram-draft-tokens N） */
  ngramDraftTokens?: number;
  /** 单 ninfer 专属：系统内存借用大小（--host-cache-mib MiB） */
  hostCacheMib?: number;
  /** 单 ninfer 专属：KV 缓存总上限（--kv-capacity tokens） */
  kvCapacity?: number;
  /** ninfer-kvmem 专属：GPU 历史 KV 预算（--kvmem-budget tokens） */
  kvmemBudget?: number;
  /** ninfer-kvmem 专属：GPU 生成预留显存（--kvmem-gen-reserve tokens） */
  kvmemGenReserve?: number;
  /** ninfer-kvmem 专属：主机内存预算配额（--kvmem-host-mib MiB） */
  kvmemHostMib?: number;
  /** ninfer-kvmem 专属：历史会话保持数量（--kvmem-sessions 1..16） */
  kvmemSessions?: number;
  /** ninfer 专属：默认输出 Token 上限（--default-max-tokens；0 = 不限制生成到上下文耗尽，未设置按引擎默认 8192） */
  defaultMaxTokens?: number;
  /** ninfer 专属：top-k 采样（--top-k，0..20） */
  topK?: number;
  /** ninfer 专属：采样随机种子（--seed） */
  seed?: number;
  /** ninfer 专属：CUDA Graph 驱动状态预留显存（--cuda-graph-allowance-mib MiB） */
  cudaGraphAllowanceMib?: number;
}

/** 托管的 llama.cpp / ninfer 引擎分支版本 */
export interface LlamaEngine {
  id: string;
  name: string;
  path: string;
  backend?: "cuda" | "vulkan" | "cpu" | string;
  cudaVersion?: string;
  version?: string;
  createdAt?: number;
  /** 引擎架构类型：llamacpp | ninfer | ninfer_kvmem */
  engineType?: "llamacpp" | "ninfer" | "ninfer_kvmem";
}

export interface AppConfig {
  serverPath: string;
  /** 当前激活的默认 llama.cpp / ninfer 引擎分支 ID */
  activeEngineId?: string;
  /** 已登记的 llama.cpp / ninfer 引擎分支列表 */
  engines?: LlamaEngine[];
  models: ModelAsset[];
  /** 旧版全局预设池，仅兼容旧配置读取；新配置预设已归入每个模型的 ModelAsset.profiles */
  profiles?: Profile[];
  theme?: "dark" | "light";
  /** 全局标签库池（用户自定义维护的标签列表） */
  customTags?: string[];
  /** 界面语言：zh（默认）/ en，设置页可切换并持久化 */
  language?: "zh" | "en";
  /** GPU performance monitor toggle (default on). */
  gpuMonitorEnabled?: boolean;
  /** 社区探索「筛选」侧边栏是否折叠（默认展开） */
  exploreSidebarCollapsed?: boolean;
  /** Hugging Face 授权 Token（门禁模型下载必需；明文保存在本地配置文件中） */
  hfToken?: string;
  /** 最近一次 whoami 验证通过的用户名（设置页展示「已绑定」状态用） */
  hfTokenUser?: string;
  preferredModelId?: string;
  preferredProfileId?: string;
  /** 网络与代理配置（跟随系统 / 手动 HTTP/SOCKS5 代理 / GitHub 反代镜像） */
  network?: {
    proxyMode: "system" | "manual" | "direct";
    proxyUrl?: string;
  };
  /** 自定义 llama.cpp 安装目录（缺省为应用数据目录下的 llamacpp） */
  llamacppDir?: string;
  /** 模型存储根目录（社区下载 / 自动扫描，缺省为应用数据目录下的 models） */
  modelsDir?: string;
  /** 启动时自动检测应用更新（默认开启） */
  autoUpdateEnabled?: boolean;
  /** 关闭主窗口时是否最小化到托盘（默认开启） */
  minimizeToTrayOnClose?: boolean;
  /** llama.cpp 选定的硬件加速后端（cuda / vulkan / cpu） */
  llamaBackend?: "cuda" | "vulkan" | "cpu";
  /** llama.cpp 选定的 CUDA 版本偏好（如 "13"、"13.4"、"12" 等） */
  llamaCudaVersion?: string;
}

export interface ServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  modelId?: string;
  modelName?: string;
  profileId?: string;
  profileName?: string;
  startedAt?: number;
  /** 启动当前服务所用的引擎分支名称 */
  engineName?: string;
  /** 启动当前服务所用的引擎计算后端 */
  engineBackend?: string;
  /** 启动当前服务所用的引擎架构类型 */
  engineType?: "llamacpp" | "ninfer" | "ninfer_kvmem";
}

/** GPU 实时指标（nvidia-smi 轮询，单位 MiB / % / W）；无 NVIDIA 驱动或字段不支持时为 null/缺省 */
export interface GpuStats {
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  utilPercent?: number;
  powerWatts?: number;
}

/** Token 速率采样：at 供微型状态卡做"新鲜度"判定，过期即回退 Idle */
export interface TokSample {
  rate: number;
  at: number;
}

/** 单次推理的结构化性能分析指标 */
export interface InferenceMetrics {
  id: string;
  timestamp: number;
  /** 实际逐字生成速率 (Decode, tokens/sec) */
  decodeTps?: number | null;
  /** 生成 Token 数量 */
  decodeTokens?: number | null;
  /** 生成阶段耗时 (ms) */
  decodeTimeMs?: number | null;
  /** 预热/首字提示词处理速率 (Prefill, tokens/sec) */
  prefillTps?: number | null;
  /** 提示词处理计算 Token 数量（实际参与 prefill 计算的 tokens） */
  prefillTokens?: number | null;
  /** 预热阶段耗时 (ms) */
  prefillTimeMs?: number | null;
  /** KV Cache 命中 Token 数量 */
  cachedTokens?: number | null;
  /** 总提示词 Token 数量（含已缓存） */
  promptTokens?: number | null;
  /** 缓存命中率 (0 ~ 100) */
  cacheHitRatio?: number | null;
  /** 首字延迟估算 (TTFT, ms) —— NInfer 口径：含排队等待 */
  ttftMs?: number | null;
  /** 排队等待耗时 (ms)，来自 NInfer done 行 queue 段或 JSONL engine_timing.queue_wait_seconds */
  queueMs?: number | null;
  /** 模型思考 tokens（NInfer JSONL result.model_thinking_tokens，含在产出内） */
  thinkingTokens?: number | null;
  /** 引擎实例 id（NInfer JSONL server_instance_id，用于引擎重启后的轮次隔离） */
  instanceId?: string | null;
  /** 请求任务 id（NInfer req#N / llama.cpp task id） */
  taskId?: string;
  /** 总耗时 (ms) */
  totalTimeMs?: number | null;
}

export interface LlamaLogPayload {
  stream: "stdout" | "stderr" | "system";
  line: string;
  timestamp: number;
}

/* ---------------- 社区探索（HuggingFace） ---------------- */

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export type CommunitySource = "hf" | "ms";

export interface HfModel {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  updatedAt: string;
  tags: string[];
  /** 已有 .gguf 文件总数（-1 表示未查询） */
  ggufCount: number;
  sampleQuant?: string | null;
  /** 从模型名 / 标签解析出的参数量（十亿）；无法识别时为 null */
  parametersB?: number | null;
  /** 从量化标签解析出的比特位（如 Q4_K_M → 4、IQ3_M → 3）；无法识别时为 null */
  quantBits?: number | null;
  /** 模型所属社区源（hf: HuggingFace，ms: ModelScope） */
  source?: CommunitySource;
}

export interface HfFile {
  name: string;
  sizeBytes: number;
}

export interface HfDownloadResult {
  path: string;
  sizeBytes: number;
}

export interface ModelDownloadProgress {
  /** 任务唯一标识（前端生成，取消 / 暂停按它精确命中单个任务） */
  taskId: string;
  repo: string;
  file: string;
  phase: "download" | "extract" | "install" | "done" | "paused" | "error" | string;
  percent: number;
  downloaded: number;
  total: number;
  speedBps: number;
  message: string;
}


