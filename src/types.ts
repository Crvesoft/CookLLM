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
  cacheTypeK: string;
  cacheTypeV: string;
  jinja: boolean;
  reasoning: string;
  reasoningEffort: string;
  loadMode: string;
  temperature: number;
  topP: number;
  minP: number;
  repeatPenalty: number;
  extraArgs: string;
  /** 该预设挂载的图像识别视觉模型（mmproj）路径；非空时以 --mmproj 附加启动 */
  mmprojPath?: string;
}

export interface AppConfig {
  serverPath: string;
  models: ModelAsset[];
  /** 旧版全局预设池，仅兼容旧配置读取；新配置预设已归入每个模型的 ModelAsset.profiles */
  profiles?: Profile[];
  theme?: "dark" | "light";
  /** 界面语言：zh（默认）/ en，设置页可切换并持久化 */
  language?: "zh" | "en";
  /** GPU performance monitor toggle (default on). */
  gpuMonitorEnabled?: boolean;
  /** 社区探索「筛选」侧边栏是否折叠（默认展开） */
  exploreSidebarCollapsed?: boolean;
  preferredModelId?: string;
  preferredProfileId?: string;
  /** 网络与代理配置（跟随系统 / 手动 HTTP/SOCKS5 代理 / GitHub 反代镜像） */
  network?: {
    proxyMode: "system" | "manual" | "direct";
    proxyUrl?: string;
  };
  /** 自定义 llama.cpp 安装目录（缺省为应用数据目录下的 llamacpp） */
  /** 自定义 llama.cpp 安装目录（缺省为应用数据目录下的 llamacpp） */
  llamacppDir?: string;
  /** 模型存储根目录（社区下载 / 自动扫描，缺省为应用数据目录下的 models） */
  modelsDir?: string;
  /** 启动时自动检测应用更新（默认开启） */
  autoUpdateEnabled?: boolean;
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
  repo: string;
  file: string;
  phase: "download" | "extract" | "install" | "done" | "paused" | "error" | string;
  percent: number;
  downloaded: number;
  total: number;
  speedBps: number;
  message: string;
}


