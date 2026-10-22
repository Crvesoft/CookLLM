import type { MessageKey } from "../i18n";
import type { AppConfig, LlamaLogPayload } from "../types";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type AppendLog = (line: string, stream?: LlamaLogPayload["stream"]) => void;

export type PersistConfig = (next: AppConfig, message?: string) => Promise<void>;
