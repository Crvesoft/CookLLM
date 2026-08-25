export type Page = "models" | "playground" | "profiles" | "settings" | "logs";

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
}

export interface AppConfig {
  serverPath: string;
  models: ModelAsset[];
  /** 旧版全局预设池，仅兼容旧配置读取；新配置预设已归入每个模型的 ModelAsset.profiles */
  profiles?: Profile[];
  theme?: "dark" | "light";
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

export interface LlamaLogPayload {
  stream: "stdout" | "stderr" | "system";
  line: string;
  timestamp: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
