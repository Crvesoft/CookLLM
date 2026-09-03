export type Page = "models" | "playground" | "profiles" | "settings" | "logs";

/** 各页面的日志显示方式：dock=参与页面布局的底部 Dock（除日志页外所有页面），page=整页视图 */
export type LogMode = "dock" | "page";

export const PAGE_LOG_MODE: Record<Page, LogMode> = {
  models: "dock", // 模型仓库：Dock 日志（与会话页统一）
  profiles: "dock", // 运行预设：Dock 日志（与会话页统一）
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
  preferredModelId?: string;
  preferredProfileId?: string;
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
