import type { InferenceMetrics, LlamaLogPayload, ModelAsset } from "./types";
import { formatMessage, getLocale } from "./i18n";
import { writeClipboard } from "./tauri";

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

export type EngineTypeKey = "llamacpp" | "ninfer" | "ninfer_kvmem";

/** 智能推断可执行程序的引擎类型 */
export function detectEngineType(path?: string): EngineTypeKey {
  if (!path) return "llamacpp";
  const lower = path.toLowerCase();
  const file = lower.split(/[\/\\]/).pop() || lower;
  if (file.includes("ninfer") && (file.includes("kvmem") || lower.includes("kvmem"))) {
    return "ninfer_kvmem";
  }
  if (file.startsWith("ninfer") || file.includes("ninfer")) {
    return "ninfer";
  }
  return "llamacpp";
}

/** 获取引擎架构类型元数据（key 与规范显示名称：llama.cpp | ninfer | kvmem-ninfer） */
export function getEngineTypeDisplay(
  engineType?: string | null,
  path?: string | null,
): { key: EngineTypeKey; label: "llama.cpp" | "ninfer" | "kvmem-ninfer" } {
  let key: EngineTypeKey = "llamacpp";
  if (engineType === "ninfer_kvmem" || engineType === "ninfer" || engineType === "llamacpp") {
    key = engineType;
  } else if (path) {
    key = detectEngineType(path);
  }
  const label =
    key === "ninfer_kvmem" ? "kvmem-ninfer" : key === "ninfer" ? "ninfer" : "llama.cpp";
  return { key, label };
}

/** 从文件名或路径中智能提取量化级别（支持 Q4_K_M、IQ4_XS、RK8V4、INT8、3.7bpw、F16 等） */
export function parseQuantization(path: string, fallback: string): string {
  const match = path.match(/(?:I?Q\d(?:_[A-Z0-9]+)+|\d+(?:\.\d+)?bpw|(?:FP|BF|F)16|(?:FP|F)32|RK8V4|K8V4|NVFP4|INT8|INT4|GSQ)/i)?.[0];
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

/** llama.cpp / ninfer 日志行着色：按流与日志级别（I/W/E 或 INFO/WARNING/ERROR 单词）分类 */
export const lineKind = (stream: LlamaLogPayload["stream"], line: string): "system" | "err" | "warn" | "msg" => {
  if (stream === "system") return "system";
  if (stream === "stderr") {
    // llama.cpp 日志格式：时间戳 + 级别字母（I/W/E），如 "0.00.105.500 I cmn  ..."
    const tag = line.match(/^\S+\s+([IWE])\s/)?.at(1)?.toUpperCase();
    if (tag === "E") return "err";
    if (tag === "W") return "warn";
    // ninfer 日志格式：日期 + 时间 + 级别单词，如 "2026-10-08 11:13:18.505  INFO  req#1 done | ..."
    const word = line.match(/^\S+\s+\S+\s+(INFO|WARN(?:ING)?|ERROR|CRITICAL|FATAL)\b/i)?.at(1)?.toUpperCase();
    if (word === "ERROR" || word === "CRITICAL" || word === "FATAL") return "err";
    if (word === "WARN" || word === "WARNING") return "warn";
  }
  return "msg";
};

export interface LogTimingFragment {
  type: "task_start" | "task_end" | "prefill" | "decode" | "decode_progress" | "total" | "cache" | "ttft" | "queue" | "generic_speed";
  taskId?: string;
  speed?: number; // tokens/sec
  tokens?: number;
  timeMs?: number;
  msPerToken?: number;
  cachedTokens?: number;
  totalPromptTokens?: number;
  cacheHitRatio?: number;
}

/**
 * 解析 NInfer 时长字段（实测自 ninfer-serve.exe stderr done 行）：
 * - 亚秒 → `65.5 ms` / `389 ms`
 * - 秒级 → `2.1s`
 * - 超过 1 分钟 → 复合格式 `1m 51.9s` / `11m 6.14s`（甚至 `1h 2m 3.4s`）
 * 匹配失败返回 undefined。
 */
export function parseNinferDurationMs(raw: string): number | undefined {
  const m = raw
    .trim()
    .match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*(ms|s))?\s*$/i);
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return undefined;
  let ms = 0;
  if (m[1] != null) ms += parseFloat(m[1]) * 3600000;
  if (m[2] != null) ms += parseFloat(m[2]) * 60000;
  if (m[3] != null) ms += m[4] && m[4].toLowerCase() === "ms" ? parseFloat(m[3]) : parseFloat(m[3]) * 1000;
  // Math.round 消除 2.1s → 2100.0000000000002 类浮点噪声
  return ms > 0 ? Math.round(ms) : undefined;
}

/**
 * 从 llama.cpp 日志行精准解析不同阶段的性能与缓存数据片段列表：
 * 单行日志可能同时包含多个指标（如完成时的 prompt eval time + eval time + total time）
 */
export function parseInferenceLogFragments(line: string): LogTimingFragment[] {
  const fragments: LogTimingFragment[] = [];

  // 剥离 ANSI 转义序列（终端彩色输出模式下避免污染正则匹配）
  line = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  // 提取 llama.cpp 任务 ID (例如 "task 3930" 或 "task: 3930" 或 "task 0")
  const taskMatch = line.match(/\btask(?:_id)?[:\s]+(\d+)\b/i);
  const taskId = taskMatch ? taskMatch[1] : undefined;

  // 0.1 Ninfer 原生请求启动感知（实测自 ninfer-serve.exe 控制台，stderr，" | " 分段）：
  // "req#12 started | openai-chat non-stream | 1 message | max output 256 | thinking low | preserve thinking"
  const ninferStartMatch = line.match(/\breq#(\d+)\s+started\b/i);
  if (ninferStartMatch) {
    fragments.push({
      type: "task_start",
      taskId: ninferStartMatch[1],
    });
    return fragments;
  }

  // 0.2 Ninfer 原生请求完成/终止感知（实测格式）：
  // "req#12 done | openai-chat | output limit | prompt 60 | output 256 | cache 0 (0.0%) | TTFT 65.5 ms | total 2.1s | prefill 937.3 tok/s | decode 123.2 tok/s | mtp accepted 176/287 (61.3%)"
  // 变体: total 可为 "620 ms"，超过 1 分钟转复合 "1m 51.9s"；排队时多出 "| queue 1m 49.7s |" 段且 TTFT 含排队；
  // cancelled / failed / rejected 终止行仅作 task_end 兜底
  const ninferDoneMatch = line.match(/\breq#(\d+)\s+done\b/i);
  const ninferEndMatch = ninferDoneMatch || line.match(/\breq#(\d+)\s+(?:cancelled|failed|rejected)\b/i);
  if (ninferEndMatch) {
    const reqId = ninferEndMatch[1];
    if (ninferDoneMatch) {
      const promptMatch = line.match(/\bprompt\s+(\d+)\b/i);
      const outputMatch = line.match(/\boutput\s+(\d+)\b/i);
      const cacheMatch = line.match(/\bcache\s+(\d+)\s*\(([^)]*)\)/i);
      // 时长字段实测格式（ninfer-serve stderr）: "TTFT 65.5 ms" / "total 2.1s" / "total 620 ms"
      // 超过 1 分钟的时长会转成复合格式 "1m 51.9s" / "11m 6.14s" —— 旧版单值正则必失配，导致墙钟回填虚高
      const durationAfter = (keyword: string): number | undefined => {
        const kw = line.match(new RegExp(`\\b${keyword}\\s+([^|]+)`, "i"));
        return kw ? parseNinferDurationMs(kw[1]) : undefined;
      };
      const ttftMs = durationAfter("TTFT");
      const totalTimeMs = durationAfter("total");
      const queueMs = durationAfter("queue");
      const prefillMatch = line.match(/\bprefill\s+([0-9.]+)\s*tok\/s/i);
      const decodeMatch = line.match(/\bdecode\s+([0-9.]+)\s*tok\/s/i);

      const promptTokens = promptMatch ? parseInt(promptMatch[1], 10) : undefined;
      const decodeTokens = outputMatch ? parseInt(outputMatch[1], 10) : undefined;
      const cachedTokens = cacheMatch ? parseInt(cacheMatch[1], 10) : 0;
      const cachePct = cacheMatch ? cacheMatch[2].match(/([0-9.]+)\s*%/) : null;
      const prefillTps = prefillMatch ? parseFloat(prefillMatch[1]) : undefined;
      const decodeTps = decodeMatch ? parseFloat(decodeMatch[1]) : undefined;
      // TTFT 含排队等待（实测 req#3: TTFT 1m49.8s = queue 1m49.7s + prefill 0.089s）；
      // 纯 prefill 计算时间 = TTFT − queue（与 NInfer 官方平台"处理时间"口径一致）
      const prefillComputeMs = ttftMs != null && queueMs != null ? Math.max(0, ttftMs - queueMs) : ttftMs;

      const cacheHitRatio = cachePct
        ? parseFloat(cachePct[1])
        : promptTokens && promptTokens > 0 ? (cachedTokens / promptTokens) * 100 : 0;
      const computedPrefill = promptTokens != null ? Math.max(0, promptTokens - cachedTokens) : undefined;
      const decodeTimeMs = totalTimeMs != null && ttftMs != null && totalTimeMs >= ttftMs
        ? Math.max(0, totalTimeMs - ttftMs)
        : decodeTokens && decodeTps && decodeTps > 0
        ? Math.round((decodeTokens / decodeTps) * 1000)
        : undefined;

      fragments.push({
        type: "cache",
        taskId: reqId,
        totalPromptTokens: promptTokens,
        cachedTokens,
        cacheHitRatio,
      });

      if (prefillTps != null || ttftMs != null || computedPrefill != null) {
        fragments.push({
          type: "prefill",
          taskId: reqId,
          tokens: computedPrefill,
          timeMs: prefillComputeMs,
          speed: prefillTps,
        });
      }

      if (ttftMs != null) {
        fragments.push({ type: "ttft", taskId: reqId, timeMs: Math.round(ttftMs) });
      }
      if (queueMs != null) {
        fragments.push({ type: "queue", taskId: reqId, timeMs: Math.round(queueMs) });
      }

      if (decodeTps != null || decodeTokens != null || decodeTimeMs != null) {
        fragments.push({
          type: "decode",
          taskId: reqId,
          tokens: decodeTokens,
          speed: decodeTps,
          timeMs: decodeTimeMs,
        });
      }

      if (totalTimeMs != null) {
        fragments.push({
          type: "total",
          taskId: reqId,
          timeMs: totalTimeMs,
          tokens: decodeTokens,
        });
      }
    }

    fragments.push({
      type: "task_end",
      taskId: reqId,
    });
    return fragments;
  }

  // 0.25 Ninfer 周期吞吐面板行（--log-stats-interval-ms，会话级 5s 窗口聚合，非单请求粒度）：
  // "throughput | 5.0s | prefill 12.0 tok/s (60 tok) | decode 50.9 tok/s (255 tok) | running 0 | batch 1.00 | host 1.1% (55.7 ms)"
  // 显式忽略：防止落入下方 generic_speed 兜底，把聚合速率误写入当前轮次
  if (/\bthroughput\s*\|/.test(line)) {
    return fragments;
  }

  // 0.3 任务分配/启动感知（例如 "slot launch_slot_: id 0 | task 0 | processing task"）
  if (/slot\s+launch_slot_.*?processing\s+task|launch_slot_:.*?task\s+\d+/i.test(line)) {
    fragments.push({
      type: "task_start",
      taskId,
    });
  }

  // 0.5 任务完成感知（例如 "slot release_slot_: id 0 | task 0" 或 "HTTP/1.1 200 OK"）
  if (/slot\s+release_slot_|release_slot_:.*?task\s+\d+|request\s+finished|HTTP\/1\.[01]\s+200/i.test(line)) {
    fragments.push({
      type: "task_end",
      taskId,
    });
  }

  // 1. slot print_timing 生成进度/实时吞吐（llama-server 正在生成中每 ~3 秒打印一次）
  // 例如: "slot print_timing: id 0 | task 0 | n_gen = 413, tg = 45.55 t/s, tg_3s = 46.35 t/s"
  const slotGenMatch = line.match(/n_gen\s*=\s*(\d+).*?\btg\s*=\s*([0-9.]+)\s*(?:tokens?|toks?|runs?|t)?(?:\/|\s+per\s+)?(?:seconds?|secs?|s)\b/i);
  if (slotGenMatch) {
    fragments.push({
      type: "decode_progress",
      taskId,
      tokens: parseInt(slotGenMatch[1], 10),
      speed: parseFloat(slotGenMatch[2]),
    });
  }

  // 2. Prefill / Prompt Eval 吞吐与耗时
  // 格式 A (完整与自适应): "prompt eval time = 120.40 ms / 62 tokens ( 1.94 ms per token, 514.95 tokens per second)"
  // 兼容: "tokens per second" / "tokens/s" / "t/s" / "runs/s" / "ms/t" 等变体
  const promptMatch = line.match(/prompt\s+eval\s+time\s*=\s*([0-9.]+)\s*ms(?:\s*\/\s*([0-9]+)\s*(?:tokens?|runs?))?(?:\s*\(\s*([0-9.]+)\s*ms(?:\s*per\s*token|\/t)?(?:,\s*([0-9.]+)\s*(?:tokens?|toks?|runs?|t)?(?:\/|\s+per\s+)?(?:seconds?|secs?|s)?)?\))?/i);
  // 新版 llama.cpp（仅当预热超过 3 秒时打印，短请求没有这行）:
  // "prompt processing, n_tokens = 512, progress = 0.42, t = 4.20 s / 121.90 tokens per second"
  const promptProgressMatch = !promptMatch
    ? line.match(/prompt\s+processing,\s*n_tokens\s*=\s*(\d+).*?\bt\s*=\s*([0-9.]+)\s*s\s*\/\s*([0-9.]+)\s*(?:tokens?|toks?|runs?|t)?(?:\/|\s+per\s+)?(?:seconds?|secs?|s)\b/i)
    : null;
  if (promptMatch) {
    const timeMs = parseFloat(promptMatch[1]);
    const tokens = promptMatch[2] ? parseInt(promptMatch[2], 10) : undefined;
    const msPerToken = promptMatch[3] ? parseFloat(promptMatch[3]) : undefined;
    let speed = promptMatch[4] ? parseFloat(promptMatch[4]) : undefined;
    if (speed == null && tokens && timeMs > 0) {
      speed = (tokens / timeMs) * 1000;
    }
    fragments.push({
      type: "prefill",
      taskId,
      timeMs,
      tokens,
      msPerToken,
      speed,
    });
  } else if (promptProgressMatch) {
    const tokens = parseInt(promptProgressMatch[1], 10);
    const timeMs = parseFloat(promptProgressMatch[2]) * 1000;
    fragments.push({
      type: "prefill",
      taskId,
      tokens,
      timeMs,
      speed: parseFloat(promptProgressMatch[3]),
    });
  }

  // 格式 B: "slot print_timing: ... prompt_eval: n_tokens = 62, t = 120.40 ms, speed = 514.95 t/s" 或包含 n_prompt 与 t_prompt_ms
  const slotPromptMatch = line.match(/(?:n_prompt|n_tokens)\s*=\s*(\d+).*?(?:t_prompt_ms|t)\s*=\s*([0-9.]+)\s*ms.*?(?:speed|pp|tg)\s*=\s*([0-9.]+)\s*(?:tokens?|toks?|runs?|t)?(?:\/|\s+per\s+)?(?:seconds?|secs?|s)\b/i)
    || line.match(/(?:t_prompt_ms|t)\s*=\s*([0-9.]+)\s*ms.*?(?:n_prompt|n_tokens)\s*=\s*(\d+).*?(?:speed|pp|tg)\s*=\s*([0-9.]+)\s*(?:tokens?|toks?|runs?|t)?(?:\/|\s+per\s+)?(?:seconds?|secs?|s)\b/i);
  if (slotPromptMatch && !promptMatch && !promptProgressMatch) {
    const isTokensFirst = !slotPromptMatch[0].startsWith("t");
    const tokens = parseInt(isTokensFirst ? slotPromptMatch[1] : slotPromptMatch[2], 10);
    const timeMs = parseFloat(isTokensFirst ? slotPromptMatch[2] : slotPromptMatch[1]);
    fragments.push({
      type: "prefill",
      taskId,
      tokens,
      timeMs,
      speed: parseFloat(slotPromptMatch[3]),
    });
  }

  // 3. Decode / Eval 逐字生成吞吐与耗时（前缀绝不能包含 prompt）
  // 格式 A: "eval time = 2450.12 ms / 80 runs ( 30.63 ms per token, 32.65 tokens per second)" (兼容 tokens/sec, toks/sec, t/s)
  const decodeMatch = line.match(/(?<!prompt\s+)\beval\s+time\s*=\s*([0-9.]+)\s*ms(?:\s*\/\s*([0-9]+)\s*(?:tokens?|runs?))?(?:\s*\(\s*([0-9.]+)\s*ms(?:\s*per\s*token|\/t)?(?:,\s*([0-9.]+)\s*(?:tokens?|toks?|runs?|t)?(?:\/|\s+per\s+)?(?:seconds?|secs?|s)?)?\))?/i);
  if (decodeMatch) {
    const timeMs = parseFloat(decodeMatch[1]);
    const tokens = decodeMatch[2] ? parseInt(decodeMatch[2], 10) : undefined;
    const msPerToken = decodeMatch[3] ? parseFloat(decodeMatch[3]) : undefined;
    let speed = decodeMatch[4] ? parseFloat(decodeMatch[4]) : undefined;
    if (speed == null && tokens && timeMs > 0) {
      speed = (tokens / timeMs) * 1000;
    }
    fragments.push({
      type: "decode",
      taskId,
      timeMs,
      tokens,
      msPerToken,
      speed,
    });
  }

  // 4. KV Cache 命中与 Slot 缓存状态
  // 格式 A: "processing: 512 tokens (450 cached)" 或 "prompt: 512 tokens (450 cached"
  const cacheSlotMatch = line.match(/(?:processing:|prompt:?)\s*([0-9]+)\s*tokens?\s*\(\s*([0-9]+)\s*cached/i);
  if (cacheSlotMatch) {
    const total = parseInt(cacheSlotMatch[1], 10);
    const cached = parseInt(cacheSlotMatch[2], 10);
    fragments.push({
      type: "cache",
      taskId,
      totalPromptTokens: total,
      cachedTokens: cached,
      cacheHitRatio: total > 0 ? (cached / total) * 100 : 0,
    });
  }

  // 格式 B: "n_past = 450, n_prompt = 512" (n_past 是 KV 缓存复用数, n_prompt 是总提示词数)
  const slotPastMatch = line.match(/\bn_past\s*=\s*(\d+).*?\b(?:n_prompt|n_tokens)\s*=\s*(\d+)/i)
    || line.match(/\b(?:n_prompt|n_tokens)\s*=\s*(\d+).*?\bn_past\s*=\s*(\d+)/i);
  if (slotPastMatch && !cacheSlotMatch) {
    const isPastFirst = slotPastMatch[0].includes("n_past");
    const cached = parseInt(isPastFirst ? slotPastMatch[1] : slotPastMatch[2], 10);
    const total = parseInt(isPastFirst ? slotPastMatch[2] : slotPastMatch[1], 10);
    fragments.push({
      type: "cache",
      taskId,
      totalPromptTokens: total,
      cachedTokens: cached,
      cacheHitRatio: total > 0 ? (cached / total) * 100 : 0,
    });
  }

  // 格式 C: "prompt evaluated, 512 tokens, 450 tokens cached" 或 "prompt evaluated: 512 tokens, 450 cached"
  const cacheEvalMatch = line.match(/prompt\s+evaluated:?\s*([0-9]+)\s*tokens?,?\s*([0-9]+)\s*(?:tokens?\s*)?cached/i);
  if (cacheEvalMatch && !cacheSlotMatch && !slotPastMatch) {
    const total = parseInt(cacheEvalMatch[1], 10);
    const cached = parseInt(cacheEvalMatch[2], 10);
    fragments.push({
      type: "cache",
      taskId,
      totalPromptTokens: total,
      cachedTokens: cached,
      cacheHitRatio: total > 0 ? (cached / total) * 100 : 0,
    });
  }

  // 格式 D: "cached 450 tokens (87.89% cache hit)"
  const cacheHitMatch = line.match(/cached\s*([0-9]+)\s*tokens?\s*\(([0-9.]+)%\s*cache\s*hit\)/i);
  if (cacheHitMatch) {
    const cached = parseInt(cacheHitMatch[1], 10);
    const ratio = parseFloat(cacheHitMatch[2]);
    fragments.push({
      type: "cache",
      taskId,
      cachedTokens: cached,
      cacheHitRatio: ratio,
    });
  }

  // 格式 E: debug-slot "[debug] slot 0: prefix match 95% (cached 8192/8192 tokens)"
  const debugSlotMatch = line.match(/prefix\s+match\s+([0-9.]+)%\s*\(cached\s+(\d+)\/(\d+)\s+tokens\)/i);
  if (debugSlotMatch) {
    fragments.push({
      type: "cache",
      taskId,
      cacheHitRatio: parseFloat(debugSlotMatch[1]),
      cachedTokens: parseInt(debugSlotMatch[2], 10),
      totalPromptTokens: parseInt(debugSlotMatch[3], 10),
    });
  }

  // 格式 F（当前 llama.cpp 默认 INFO 日志，不依赖 --verbose）:
  // "selected slot by LCP similarity, f_sim_best = 0.873 (> 0.100 thold), f_keep = 0.910"
  // f_sim 是命中前缀占本次提示词的比例，即 KV 缓存命中率
  const lcpMatch = line.match(/selected\s+slot\s+by\s+LCP\s+similarity,\s*f_sim(?:_best)?\s*=\s*([0-9.]+)/i);
  if (lcpMatch && !debugSlotMatch) {
    const ratio = Math.min(1, Math.max(0, parseFloat(lcpMatch[1])));
    fragments.push({
      type: "cache",
      taskId,
      cacheHitRatio: ratio * 100,
    });
  }

  // 5. 总耗时
  // 格式 A: "total time = 2600.00 ms / 142 tokens" 或 "total time = 52.89 s"
  const totalMatch = line.match(/(?:^|[^\w])total\s+time\s*=\s*([0-9.]+)\s*(ms|s)(?:\s*\/\s*([0-9]+)\s*(?:tokens?|runs?))?/i);
  if (totalMatch) {
    const isSeconds = totalMatch[2].toLowerCase() === "s";
    const val = parseFloat(totalMatch[1]);
    fragments.push({
      type: "total",
      taskId,
      timeMs: isSeconds ? val * 1000 : val,
      tokens: totalMatch[3] ? parseInt(totalMatch[3], 10) : undefined,
    });
  }

  // 6. 通用 tokens/sec 或 t/s 兜底（仅在未识别出专用片段时）
  if (fragments.length === 0) {
    const genericMatch = line.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:tokens?|toks?|runs?|t)(?:\/|\s+per\s+)(?:seconds?|secs?|s)\b/i)
      || line.match(/([0-9]+(?:\.[0-9]+)?)\s*t\/s\b/i);
    if (genericMatch) {
      fragments.push({
        type: "generic_speed",
        taskId,
        speed: parseFloat(genericMatch[1]),
      });
    }
  }

  return fragments;
}

export function parseInferenceLogLine(line: string): LogTimingFragment | null {
  const frags = parseInferenceLogFragments(line);
  return frags.length > 0 ? frags[0] : null;
}

/** 从 llama.cpp 日志行提取生成吞吐（如 "43.2 tokens/sec" 或 "66.42 t/s"），未匹配返回 null */
export function parseTokPerSec(line: string): number | null {
  const frags = parseInferenceLogFragments(line);
  let prefillSpeed: number | null = null;
  for (const frag of frags) {
    if (frag.type === "decode" || frag.type === "decode_progress" || frag.type === "generic_speed") {
      if (frag.speed != null) return frag.speed;
    }
    if (frag.type === "prefill" && frag.speed != null && prefillSpeed == null) {
      prefillSpeed = frag.speed;
    }
  }
  if (prefillSpeed != null) return prefillSpeed;
  const match = line.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:tokens?|toks?|runs?|t)(?:\/|\s+per\s+)(?:seconds?|secs?|s)\b/i)
    || line.match(/([0-9]+(?:\.[0-9]+)?)\s*t\/s\b/i);
  return match ? Number(match[1]) : null;
}

/**
 * 推理指标聚合跟踪器：聚合单次问答中跨日志行输出的
 * Cache Hit -> Prompt Eval -> Token Eval -> Total Time，生成完整的单次推理画像与历史列表
 */
export class InferenceTracker {
  private current: Partial<InferenceMetrics> & { taskId?: string; lastUpdateAt?: number; taskStartTime?: number } = {};
  private history: InferenceMetrics[] = [];
  private maxHistory: number = 100;
  private lastCommittedTaskId: string | null = null;
  /** Ninfer /stats counters 差分基线：每次轮询刷新，用于把累计计数器换算为窗口内瞬时增量 */
  private ninferCounterBase: { at: number; decode: number | null; prefill: number | null; reused: number | null } | null = null;
  /** 当前 NInfer 引擎实例 id（--request-log-jsonl 的 server_start 事件） */
  private ninferInstanceId: string | null = null;
  /** 引擎启动时间锚点（reset 时刻）：早于它的 JSONL 记录视为旧实例残留，直接忽略 */
  private ninferLogSinceTs: number = 0;

  public hasActiveTurn(): boolean {
    return Boolean(this.current.id);
  }

  public processLine(line: string): { updated: boolean; latest: InferenceMetrics | null; isTurnFinished: boolean } {
    const frags = parseInferenceLogFragments(line);
    if (!frags.length) return { updated: false, latest: this.getLatest(), isTurnFinished: false };

    const now = Date.now();
    let hasFinishedFrag = false;

    for (const frag of frags) {
      // 任务启动或 taskId 发生更迭：提交上一轮，开启新一轮
      if (frag.type === "task_start" || (frag.taskId && this.current.taskId && frag.taskId !== this.current.taskId)) {
        if (frag.type === "task_start" && frag.taskId && this.current.taskId === frag.taskId) {
          // 同一请求重复的 task_start（如 /stats 轮询先建轮、随后 req#N started 日志才到达）：
          // 仅刷新心跳并沿用当前轮，避免把一次请求拆成两轮
          this.current.lastUpdateAt = now;
        } else {
          if (this.current.decodeTokens || this.current.prefillTokens || this.current.decodeTps || this.current.prefillTps) {
            this.commitCurrent();
          }
          this.current = {
            id: `inf-${now}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            taskId: frag.taskId,
            lastUpdateAt: now,
            taskStartTime: now,
            instanceId: this.ninferInstanceId ?? undefined,
          };
        }
      }

      if (!this.current.id) {
        this.current.id = `inf-${now}-${Math.random().toString(36).slice(2, 6)}`;
        this.current.timestamp = now;
        if (frag.taskId) this.current.taskId = frag.taskId;
        if (frag.type === "task_start") this.current.taskStartTime = now;
      } else if (frag.taskId && !this.current.taskId) {
        this.current.taskId = frag.taskId;
      }

      this.current.lastUpdateAt = now;

      if (frag.type === "cache") {
        if (frag.cachedTokens != null) this.current.cachedTokens = frag.cachedTokens;
        if (frag.totalPromptTokens != null) this.current.promptTokens = frag.totalPromptTokens;
        if (frag.cacheHitRatio != null) this.current.cacheHitRatio = frag.cacheHitRatio;
      } else if (frag.type === "prefill") {
        if (frag.tokens != null) this.current.prefillTokens = frag.tokens;
        if (frag.timeMs != null) this.current.prefillTimeMs = frag.timeMs;
        if (frag.speed != null) this.current.prefillTps = frag.speed;
        if (frag.timeMs != null) this.current.ttftMs = frag.timeMs;
        if (this.current.promptTokens == null && frag.tokens != null) {
          this.current.promptTokens = (this.current.cachedTokens || 0) + frag.tokens;
        }
      } else if (frag.type === "decode" || frag.type === "decode_progress") {
        if (frag.tokens != null) this.current.decodeTokens = frag.tokens;
        if (frag.speed != null) this.current.decodeTps = frag.speed;
        if (frag.timeMs != null) {
          this.current.decodeTimeMs = frag.timeMs;
        } else if (frag.tokens != null && frag.speed != null && frag.speed > 0) {
          this.current.decodeTimeMs = Math.round((frag.tokens / frag.speed) * 1000);
        }
        // 如果是从任务启动到第一次收到生成心跳，计算实际首字延迟（TTFT）与预热耗时
        if (this.current.taskStartTime && this.current.ttftMs == null) {
          const elapsed = Math.max(1, now - this.current.taskStartTime);
          this.current.ttftMs = elapsed;
          if (this.current.prefillTimeMs == null) {
            this.current.prefillTimeMs = elapsed;
          }
          if (this.current.promptTokens && this.current.prefillTps == null) {
            this.current.prefillTps = parseFloat(((this.current.promptTokens / (elapsed / 1000))).toFixed(1));
          }
        }
      } else if (frag.type === "total") {
        if (frag.timeMs != null) this.current.totalTimeMs = frag.timeMs;
        if (frag.tokens != null && this.current.decodeTokens == null) {
          this.current.decodeTokens = frag.tokens;
        }
      } else if (frag.type === "ttft") {
        // NInfer done 行的权威 TTFT（含排队等待）；覆盖 prefill 片段兜底设置的近似值
        if (frag.timeMs != null) this.current.ttftMs = frag.timeMs;
      } else if (frag.type === "queue") {
        if (frag.timeMs != null) this.current.queueMs = frag.timeMs;
      } else if (frag.type === "generic_speed") {
        if (this.current.decodeTps == null && frag.speed != null) {
          this.current.decodeTps = frag.speed;
        }
      }

      if (frag.type === "decode" || frag.type === "total" || frag.type === "task_end") {
        hasFinishedFrag = true;
      }
    }

    // 明确收到正式结束日志（eval time、total time 或 release_slot / 200 OK），且有数据时，立即归档本轮
    if (hasFinishedFrag && (this.current.decodeTokens || this.current.prefillTokens || this.current.promptTokens || this.current.decodeTps)) {
      const taskStart = this.current.taskStartTime || this.current.timestamp || now;
      const elapsed = Math.max(1, now - taskStart);
      if (this.current.totalTimeMs == null) {
        this.current.totalTimeMs = elapsed;
      }
      if (this.current.decodeTokens && this.current.decodeTps == null && (elapsed >= 200 || this.current.decodeTokens <= 2)) {
        const decodeElapsed = Math.max(1, elapsed - (this.current.prefillTimeMs || 0));
        const calculated = parseFloat(((this.current.decodeTokens / (decodeElapsed / 1000))).toFixed(1));
        if (calculated <= 3000) {
          this.current.decodeTps = calculated;
        }
      }
      const finished = this.commitCurrent();
      return { updated: true, latest: finished || this.getLatest(), isTurnFinished: true };
    }

    // 实时更新当前快照
    const snapshot = this.buildMetricsSnapshot();
    return { updated: true, latest: snapshot, isTurnFinished: false };
  }

  /**
   * 从 llama-server 原生 /slots 端点注入真实底层状态（跨越终端日志缺失限制）
   */
  public updateFromSlot(data: {
    taskId?: string | number;
    promptTokens?: number;
    cachedTokens?: number;
    cacheHitRatio?: number;
    decodeTokens?: number;
    prefillTps?: number;
    prefillTimeMs?: number;
    decodeTps?: number;
    isProcessing?: boolean;
  }): { updated: boolean; latest: InferenceMetrics | null; isTurnFinished?: boolean } {
    const now = Date.now();
    const strTaskId = data.taskId != null ? String(data.taskId) : undefined;

    // 1. 如果当前没有处于处理中状态（isProcessing === false）：
    if (!data.isProcessing) {
      // 场景 A：当前并没有正在进行的活跃轮次，或者该任务已经归档过了 -> 直接忽略，杜绝死循环生成幽灵轮次！
      if (!this.current.id || (strTaskId && strTaskId === this.lastCommittedTaskId)) {
        return { updated: false, latest: this.getLatest() };
      }

      // 场景 B：之前确实在跟踪该轮次（this.current.id 存在），收到 isProcessing === false 意味着刚刚结束
      if (this.current.id && (this.current.decodeTokens || this.current.promptTokens || this.current.decodeTps || this.current.prefillTps)) {
        const taskStart = this.current.taskStartTime || this.current.timestamp || now;
        const elapsed = Math.max(1, now - taskStart);
        if (this.current.totalTimeMs == null) {
          this.current.totalTimeMs = elapsed;
        }
        if (this.current.decodeTokens && this.current.decodeTps == null && (elapsed >= 200 || this.current.decodeTokens <= 2)) {
          const decodeElapsed = Math.max(1, elapsed - (this.current.prefillTimeMs || 0));
          const calculated = parseFloat(((this.current.decodeTokens / (decodeElapsed / 1000))).toFixed(1));
          if (calculated <= 3000) {
            this.current.decodeTps = calculated;
          }
        }
        const finished = this.commitCurrent();
        return { updated: true, latest: finished || this.getLatest(), isTurnFinished: true };
      }

      return { updated: false, latest: this.getLatest() };
    }

    // 2. 当前处于活跃推理状态（isProcessing === true）：
    // 若 taskId 发生了更迭，先归档上一轮
    if (strTaskId && this.current.taskId && strTaskId !== this.current.taskId) {
      if (this.current.decodeTokens || this.current.prefillTokens || this.current.decodeTps || this.current.prefillTps || this.current.promptTokens) {
        this.commitCurrent();
      }
      this.current = {
        id: `inf-${now}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        taskId: strTaskId,
        lastUpdateAt: now,
        taskStartTime: now,
        instanceId: this.ninferInstanceId ?? undefined,
      };
    }

    // 开启新一轮跟踪
    if (!this.current.id) {
      this.current.id = `inf-${now}-${Math.random().toString(36).slice(2, 6)}`;
      this.current.timestamp = now;
      this.current.taskStartTime = now;
      if (strTaskId) this.current.taskId = strTaskId;
    }

    let changed = false;

    if (data.promptTokens != null && data.promptTokens > 0 && this.current.promptTokens !== data.promptTokens) {
      this.current.promptTokens = data.promptTokens;
      changed = true;
    }
    if (data.cachedTokens != null && this.current.cachedTokens !== data.cachedTokens) {
      this.current.cachedTokens = data.cachedTokens;
      changed = true;
    }
    if (data.cacheHitRatio != null && this.current.cacheHitRatio !== data.cacheHitRatio) {
      this.current.cacheHitRatio = data.cacheHitRatio;
      changed = true;
    }
    if (data.decodeTokens != null && data.decodeTokens > 0 && (this.current.decodeTokens == null || data.decodeTokens > this.current.decodeTokens)) {
      this.current.decodeTokens = data.decodeTokens;
      changed = true;
    }
    // 预热指标以 /slots 为准：短提示词不会打印 prompt processing 行，只有端点有完整数值
    if (data.prefillTps != null && data.prefillTps > 0 && this.current.prefillTps !== data.prefillTps) {
      this.current.prefillTps = data.prefillTps;
      changed = true;
    }
    if (data.prefillTimeMs != null && data.prefillTimeMs > 0 && this.current.prefillTimeMs !== data.prefillTimeMs) {
      this.current.prefillTimeMs = data.prefillTimeMs;
      changed = true;
    }
    if (data.decodeTps != null && data.decodeTps > 0 && this.current.decodeTps !== data.decodeTps) {
      this.current.decodeTps = data.decodeTps;
      changed = true;
    }

    // 智能补全预热速率：已有提示词 Token 数量，且有测量出的预热延迟
    if (this.current.promptTokens && this.current.prefillTimeMs && this.current.prefillTps == null && this.current.prefillTimeMs > 0) {
      this.current.prefillTps = parseFloat(((this.current.promptTokens / (this.current.prefillTimeMs / 1000))).toFixed(1));
      changed = true;
    }

    if (!changed) {
      return { updated: false, latest: this.getLatest() };
    }

    this.current.lastUpdateAt = now;
    const snapshot = this.buildMetricsSnapshot();
    return { updated: true, latest: snapshot, isTurnFinished: false };
  }

  /**
   * 从 Ninfer 原生 /stats 与 /slots 端点同步实时指标
   * 注意（实测结论）：/stats 的 throughput_tokens_per_second 是自引擎启动以来的累计平均值，
   * 并非当前瞬时速率，直接写入轮次会把"历史平均"误当"本轮速率"造成数据失真；
   * 这里改用 counters（committed_decode_tokens / computed_prefill_tokens / reused_prompt_tokens）
   * 的轮询差分计算窗口内真实速率与增量，单请求的最终精确值仍以 done 日志行为准。
   */
  public updateFromNinfer(data: {
    stats?: any;
    slots?: any;
  }): { updated: boolean; latest: InferenceMetrics | null; isTurnFinished?: boolean } {
    const stats = data.stats;
    const slots = data.slots;
    const now = Date.now();

    const isSlotProcessing = Array.isArray(slots) && slots.some((s: any) => s.is_processing);
    const reqs = stats?.requests;
    const isProcessing = Boolean(isSlotProcessing || (reqs && (reqs.running > 0 || reqs.prefilling > 0 || reqs.decode_ready > 0)));

    // 计数器差分基线：无论忙闲每次轮询都刷新，保证差分窗口不跨越请求边界混入上一请求数据
    const counters = stats?.counters;
    const cDecode = typeof counters?.committed_decode_tokens === "number" ? counters.committed_decode_tokens : null;
    const cPrefill = typeof counters?.computed_prefill_tokens === "number" ? counters.computed_prefill_tokens : null;
    const cReused = typeof counters?.reused_prompt_tokens === "number" ? counters.reused_prompt_tokens : null;
    const prevBase = this.ninferCounterBase;
    this.ninferCounterBase = { at: now, decode: cDecode, prefill: cPrefill, reused: cReused };

    if (!isProcessing) {
      if (!this.current.id) {
        return { updated: false, latest: this.getLatest() };
      }
      if (this.current.decodeTokens || this.current.promptTokens || this.current.prefillTokens || this.current.cachedTokens || this.current.decodeTps || this.current.prefillTps) {
        const taskStart = this.current.taskStartTime || this.current.timestamp || now;
        const elapsed = Math.max(1, now - taskStart);
        if (this.current.totalTimeMs == null) {
          this.current.totalTimeMs = elapsed;
        }
        const finished = this.commitCurrent();
        return { updated: true, latest: finished || this.getLatest(), isTurnFinished: true };
      }
      // 空轮清理：done 日志行已归档、轮询又短暂探到处理态落回时遗留的无数据轮，直接清空避免幻影活跃轮
      this.current = {};
      return { updated: false, latest: this.getLatest() };
    }

    if (!this.current.id) {
      // 兜底开轮：日志路径错过 req#N started 行时（如日志级别关闭）由轮询建轮；
      // 不设 taskId，随后到达的 req#N started 会以更迭语义自然接管空轮
      this.current.id = `inf-${now}-${Math.random().toString(36).slice(2, 6)}`;
      this.current.timestamp = now;
      this.current.taskStartTime = now;
      this.current.instanceId = this.ninferInstanceId ?? undefined;
    }

    // 处理期间持续刷新心跳：即使计数器短暂无增量（长 prefill、排队等），
    // 也不会被 App 层的 checkIdleTimeout 当作停更而把一次生成误切成多轮
    this.current.lastUpdateAt = now;

    let changed = false;
    if (prevBase) {
      const dtSec = Math.max(0.05, (now - prevBase.at) / 1000);
      const dDecode = cDecode != null && prevBase.decode != null ? cDecode - prevBase.decode : 0;
      const dPrefill = cPrefill != null && prevBase.prefill != null ? cPrefill - prevBase.prefill : 0;
      const dReused = cReused != null && prevBase.reused != null ? cReused - prevBase.reused : 0;
      if (dDecode > 0) {
        this.current.decodeTokens = (this.current.decodeTokens || 0) + dDecode;
        const tps = dDecode / dtSec;
        if (tps > 0 && tps <= 5000) {
          this.current.decodeTps = parseFloat(tps.toFixed(1));
        }
        changed = true;
      }
      if (dPrefill > 0) {
        this.current.prefillTokens = (this.current.prefillTokens || 0) + dPrefill;
        changed = true;
      }
      if (dReused > 0) {
        this.current.cachedTokens = (this.current.cachedTokens || 0) + dReused;
        changed = true;
      }
    }

    if (!changed) {
      return { updated: false, latest: this.getLatest() };
    }

    const snapshot = this.buildMetricsSnapshot();
    return { updated: true, latest: snapshot, isTurnFinished: false };
  }

  /**
   * NInfer 原生 --request-log-jsonl 结构化记录合并（与 NInfer 官方监测平台同数据源）。
   * request_done 事件携带全精度 timings / tokens / queue 指标，作为权威值覆盖 stderr 文本解析结果；
   * server_start 事件用于锁定当前引擎实例 id（stderr 轮次据此打戳，引擎重启后互不串扰）。
   */
  public applyNinferRequestLog(records: unknown[]): { updated: boolean; latest: InferenceMetrics | null } {
    let updated = false;
    let latest: InferenceMetrics | null = null;
    const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
    for (const rec of records) {
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, any>;
      const instanceId = typeof r.server_instance_id === "string" ? r.server_instance_id : undefined;
      const ts = typeof r.timestamp_unix_ms === "number" ? r.timestamp_unix_ms : 0;
      if (r.event === "server_start") {
        if (instanceId) this.ninferInstanceId = instanceId;
        continue;
      }
      if (r.event !== "request_done") continue; // request_start / throughput 记录暂不消费
      // 轮转重读时旧实例残留记录直接忽略（允许 2s 时钟容差）
      if (this.ninferLogSinceTs && ts && ts < this.ninferLogSinceTs - 2000) continue;
      const req = r.request || {};
      const res = r.result || {};
      const t = r.timings_seconds || {};
      const et = r.engine_timing || {};
      const taskId = req.request_id != null ? String(req.request_id) : undefined;
      if (!taskId) continue;
      const ttftMs = num(t.ttft);
      const totalMs = num(t.total);
      const queueMs = num(et.queue_wait_seconds);
      const decodeMs = num(t.decode);
      const prefillMs = num(t.prefill);
      const promptTokens = num(res.prompt_tokens);
      const cachedTokens = num(res.prefix_cache_hit_tokens) ?? 0;
      const decodeTokens = num(res.completion_tokens);
      const thinkingTokens = num(res.model_thinking_tokens);
      const computedPrefill = num(res.computed_prefill_tokens)
        ?? (promptTokens != null ? Math.max(0, promptTokens - cachedTokens) : null);
      const exact: Partial<InferenceMetrics> = {
        taskId,
        instanceId: instanceId ?? null,
        promptTokens,
        cachedTokens,
        cacheHitRatio: promptTokens != null && promptTokens > 0 ? parseFloat(((cachedTokens / promptTokens) * 100).toFixed(1)) : null,
        prefillTokens: computedPrefill,
        prefillTimeMs: prefillMs != null ? Math.round(prefillMs * 1000) : null,
        prefillTps: prefillMs != null && prefillMs > 0 && computedPrefill != null ? parseFloat((computedPrefill / prefillMs).toFixed(1)) : null,
        ttftMs: ttftMs != null ? Math.round(ttftMs * 1000) : null,
        queueMs: queueMs != null ? Math.round(queueMs * 1000) : null,
        decodeTokens,
        thinkingTokens,
        decodeTimeMs: decodeMs != null ? Math.round(decodeMs * 1000) : null,
        decodeTps: decodeMs != null && decodeMs > 0 && decodeTokens != null ? parseFloat((decodeTokens / decodeMs).toFixed(1)) : null,
        totalTimeMs: totalMs != null ? Math.round(totalMs * 1000) : null,
      };

      // 1) 活跃轮次同实例同 taskId（或轮询兜底开的无 taskId 轮，开始时间早于本 done 记录）：
      //    就地覆盖为权威值后立即归档（done 已落地），避免随后兜底归档出重复轮次
      const currentMatches =
        this.current.taskId === taskId && (this.current.instanceId == null || this.current.instanceId === instanceId)
        || (this.current.taskId == null && this.current.taskStartTime != null && ts > 0 && this.current.taskStartTime <= ts);
      if (currentMatches) {
        this.current = { ...this.current, ...exact, timestamp: this.current.timestamp };
        const finished = this.commitCurrent();
        if (finished) {
          updated = true;
          latest = finished;
        }
        continue;
      }
      // 2) 已归档轮次（stderr 先建）：权威覆盖，保留原 id/timestamp（React key 稳定）
      const idx = this.history.findIndex((h) => h.taskId === taskId && (h.instanceId == null || h.instanceId === instanceId));
      if (idx >= 0) {
        const prev = this.history[idx];
        this.history[idx] = { ...prev, ...exact, timestamp: prev.timestamp, instanceId: prev.instanceId ?? exact.instanceId ?? null };
        updated = true;
        latest = this.history[idx];
        continue;
      }
      // 3) stderr 完全没跟上的请求（日志级别关闭 / 中途接管）：补录为已完成轮次
      const added: InferenceMetrics = {
        id: `inf-jsonl-${instanceId ?? "x"}-${taskId}`,
        timestamp: ts || Date.now(),
        ...exact,
      } as InferenceMetrics;
      this.history = [added, ...this.history].slice(0, this.maxHistory);
      updated = true;
      latest = added;
    }
    return { updated, latest };
  }

  /**
   * 空闲超时保底检查：若超过指定毫秒数（默认 3 秒）未收到任何 Token 增量，自动归档结算当前未完成轮次
   */
  public checkIdleTimeout(maxIdleMs: number = 3000): { updated: boolean; latest: InferenceMetrics | null } {
    if (!this.current.id || (!this.current.decodeTokens && !this.current.promptTokens && !this.current.decodeTps)) {
      return { updated: false, latest: this.getLatest() };
    }
    const now = Date.now();
    const last = this.current.lastUpdateAt || this.current.timestamp || now;
    if (now - last >= maxIdleMs) {
      const taskStart = this.current.taskStartTime || this.current.timestamp || now;
      const elapsed = Math.max(1, last - taskStart);
      if (this.current.totalTimeMs == null) {
        this.current.totalTimeMs = elapsed;
      }
      if (this.current.decodeTokens && this.current.decodeTps == null && (elapsed >= 200 || this.current.decodeTokens <= 2)) {
        const decodeElapsed = Math.max(1, elapsed - (this.current.prefillTimeMs || 0));
        const calculated = parseFloat(((this.current.decodeTokens / (decodeElapsed / 1000))).toFixed(1));
        if (calculated <= 3000) {
          this.current.decodeTps = calculated;
        }
      }
      const finished = this.commitCurrent();
      return { updated: true, latest: finished || this.getLatest() };
    }
    return { updated: false, latest: this.getLatest() };
  }

  /**
   * 显式提交归档当前活跃轮次
   */
  public commitActiveTurn(): { updated: boolean; latest: InferenceMetrics | null } {
    if (this.current.decodeTokens || this.current.promptTokens || this.current.decodeTps || this.current.prefillTps) {
      const now = Date.now();
      const taskStart = this.current.taskStartTime || this.current.timestamp || now;
      const elapsed = Math.max(1, now - taskStart);
      if (this.current.totalTimeMs == null) {
        this.current.totalTimeMs = elapsed;
      }
      const finished = this.commitCurrent();
      return { updated: true, latest: finished || this.getLatest() };
    }
    return { updated: false, latest: this.getLatest() };
  }

  private buildMetricsSnapshot(): InferenceMetrics {
    const promptCount = this.current.promptTokens ?? this.current.prefillTokens ?? null;
    const cachedCount = this.current.cachedTokens ?? null;
    let ratio = this.current.cacheHitRatio;
    if (ratio == null && cachedCount != null && promptCount && promptCount > 0) {
      ratio = (cachedCount / promptCount) * 100;
    }

    return {
      id: this.current.id || `inf-${Date.now()}`,
      timestamp: this.current.timestamp || Date.now(),
      taskId: this.current.taskId,
      instanceId: this.current.instanceId ?? null,
      decodeTps: this.current.decodeTps ?? null,
      decodeTokens: this.current.decodeTokens ?? null,
      decodeTimeMs: this.current.decodeTimeMs ?? null,
      prefillTps: this.current.prefillTps ?? null,
      prefillTokens: this.current.prefillTokens ?? null,
      prefillTimeMs: this.current.prefillTimeMs ?? null,
      cachedTokens: cachedCount,
      promptTokens: promptCount,
      cacheHitRatio: ratio != null ? parseFloat(ratio.toFixed(1)) : null,
      ttftMs: this.current.ttftMs ?? this.current.prefillTimeMs ?? null,
      queueMs: this.current.queueMs ?? null,
      thinkingTokens: this.current.thinkingTokens ?? null,
      totalTimeMs: this.current.totalTimeMs ?? (
        (this.current.prefillTimeMs || 0) + (this.current.decodeTimeMs || 0) || null
      ),
    };
  }

  private commitCurrent(): InferenceMetrics | null {
    if (this.current.taskId) {
      this.lastCommittedTaskId = this.current.taskId;
    }
    // 只有当至少有一个实际有效数据时才进入历史记录，杜绝全 null 的空轮次
    if (!this.current.decodeTokens && !this.current.prefillTokens && !this.current.decodeTps && !this.current.prefillTps && this.current.cacheHitRatio == null) {
      this.current = {};
      return null;
    }

    const complete = this.buildMetricsSnapshot();
    this.history = [complete, ...this.history.filter((item) => item.id !== complete.id)].slice(0, this.maxHistory);
    this.current = {};
    return complete;
  }

  public getLatest(): InferenceMetrics | null {
    if (this.current.decodeTps || this.current.decodeTokens || this.current.prefillTps || this.current.prefillTokens || this.current.promptTokens || this.current.cacheHitRatio != null || this.current.cachedTokens) {
      return this.buildMetricsSnapshot();
    }
    return this.history[0] || null;
  }

  public getHistory(): InferenceMetrics[] {
    return [...this.history];
  }

  public reset(): void {
    this.current = {};
    this.history = [];
    this.lastCommittedTaskId = null;
    this.ninferCounterBase = null;
    this.ninferInstanceId = null;
    this.ninferLogSinceTs = Date.now();
  }
}

export type RoundStatus =
  | "generating"       // 正在生成
  | "complete"         // 完整推理 (has valid decode and prefill/ttft)
  | "decode-only"      // 仅 Decode 有效 (has valid decode, but no prefill/ttft)
  | "prefill-only"     // 仅 Prefill 有效 (has valid prefill, but no decode)
  | "context-kv"       // 上下文 / KV 操作 (no throughput, but has prompt/cached tokens or KV Cache activity)
  | "no-throughput";   // 无有效吞吐数据

/**
 * 根据单次推理数据建立语义化轮次分类：
 * 绝不将缺少吐字时间或无吞吐数据的轮次误判为 0 tok/s，而是区分完整推理、仅Decode、仅Prefill、上下文/KV操作、无吞吐数据
 */
export function classifyRoundStatus(
  item: InferenceMetrics,
  isLive: boolean = false
): RoundStatus {
  if (isLive) return "generating";

  const hasDecode = item.decodeTps != null && item.decodeTps > 0;
  const hasPrefill = item.prefillTps != null && item.prefillTps > 0;
  const hasTtft = item.ttftMs != null && item.ttftMs > 0;

  if (hasDecode && (hasPrefill || hasTtft)) {
    return "complete";
  }
  if (hasDecode) {
    return "decode-only";
  }
  if (hasPrefill) {
    return "prefill-only";
  }

  // 上下文 / KV 操作：没有生成吞吐，但有明显的缓存命中或上下文计算记录
  const hasCacheActivity =
    (item.cachedTokens != null && item.cachedTokens > 0) ||
    (item.cacheHitRatio != null && item.cacheHitRatio > 0);
  const hasContextActivity =
    (item.promptTokens != null && item.promptTokens > 0) &&
    (!item.decodeTokens || item.decodeTokens === 0);

  if (hasCacheActivity || hasContextActivity) {
    return "context-kv";
  }

  return "no-throughput";
}

export interface InferenceSessionStats {
  turns: number;
  totalTokens: number;
  totalPromptTokens: number;

  // Decode 统计（仅统计有效值 > 0，绝不把无效轮次当作 0 参与平均）
  avgDecodeTps: number | null;
  validDecodeTurns: number;
  peakDecodeTps: number | null;
  peakDecodeTurnOrder: number | null;

  // Prefill 统计（仅统计有效值 > 0）
  avgPrefillTps: number | null;
  validPrefillTurns: number;
  peakPrefillTps: number | null;
  peakPrefillTurnOrder: number | null;

  // TTFT 统计（仅统计有效延迟 > 0）
  avgTtftMs: number | null;
  validTtftTurns: number;
  minTtftMs: number | null;
  minTtftTurnOrder: number | null;

  // KV Cache 统计
  avgCacheHitRatio: number | null;
  validCacheTurns: number;
}

export type InferenceFilterType = "all" | "complete" | "decode" | "prefill";

/**
 * 判断单次推理记录是否符合指定的性能筛选维度：
 * - all: 全部轮次
 * - complete: 完整推理（同时具有有效的 Decode 与 Prefill 速率）
 * - decode: 具备有效 Decode 速率
 * - prefill: 具备有效 Prefill 速率
 */
export function matchesInferenceFilter(
  item: InferenceMetrics,
  live: boolean,
  filter: InferenceFilterType
): boolean {
  if (filter === "all") return true;

  const hasDecode = item.decodeTps != null && item.decodeTps > 0;
  const hasPrefill = item.prefillTps != null && item.prefillTps > 0;

  switch (filter) {
    case "complete":
      return hasDecode && hasPrefill;
    case "decode":
      return hasDecode;
    case "prefill":
      return hasPrefill;
    default:
      return true;
  }
}

export function computeSessionStats(
  history: InferenceMetrics[],
  orders?: number[]
): InferenceSessionStats {
  const totalRounds = history.length;
  if (!totalRounds) {
    return {
      turns: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      avgDecodeTps: null,
      validDecodeTurns: 0,
      peakDecodeTps: null,
      peakDecodeTurnOrder: null,
      avgPrefillTps: null,
      validPrefillTurns: 0,
      peakPrefillTps: null,
      peakPrefillTurnOrder: null,
      avgTtftMs: null,
      validTtftTurns: 0,
      minTtftMs: null,
      minTtftTurnOrder: null,
      avgCacheHitRatio: null,
      validCacheTurns: 0,
    };
  }

  let totalGenTokens = 0;
  let totalPrompt = 0;

  let sumDecodeTps = 0;
  let countDecodeTps = 0;
  let peakDecodeTps: number | null = null;
  let peakDecodeTurnOrder: number | null = null;

  let sumPrefillTps = 0;
  let countPrefillTps = 0;
  let peakPrefillTps: number | null = null;
  let peakPrefillTurnOrder: number | null = null;

  let sumTtftMs = 0;
  let countTtftMs = 0;
  let minTtftMs: number | null = null;
  let minTtftTurnOrder: number | null = null;

  let sumCacheHit = 0;
  let countCacheHit = 0;

  for (let index = 0; index < totalRounds; index++) {
    const item = history[index];
    const order = orders && orders[index] != null ? orders[index] : totalRounds - index;

    if (item.decodeTokens) totalGenTokens += item.decodeTokens;
    if (item.promptTokens) totalPrompt += item.promptTokens;

    // Decode: 仅统计有效吞吐 > 0
    if (item.decodeTps != null && item.decodeTps > 0) {
      sumDecodeTps += item.decodeTps;
      countDecodeTps++;
      if (peakDecodeTps === null || item.decodeTps > peakDecodeTps) {
        peakDecodeTps = item.decodeTps;
        peakDecodeTurnOrder = order;
      }
    }

    // Prefill: 仅统计有效吞吐 > 0
    if (item.prefillTps != null && item.prefillTps > 0) {
      sumPrefillTps += item.prefillTps;
      countPrefillTps++;
      if (peakPrefillTps === null || item.prefillTps > peakPrefillTps) {
        peakPrefillTps = item.prefillTps;
        peakPrefillTurnOrder = order;
      }
    }

    // TTFT: 仅统计有效延迟 > 0
    if (item.ttftMs != null && item.ttftMs > 0) {
      sumTtftMs += item.ttftMs;
      countTtftMs++;
      if (minTtftMs === null || item.ttftMs < minTtftMs) {
        minTtftMs = item.ttftMs;
        minTtftTurnOrder = order;
      }
    }

    // Cache Hit Ratio: 仅统计数值有效
    if (item.cacheHitRatio !== null && item.cacheHitRatio !== undefined && Number.isFinite(item.cacheHitRatio)) {
      sumCacheHit += item.cacheHitRatio;
      countCacheHit++;
    }
  }

  return {
    turns: totalRounds,
    totalTokens: totalGenTokens,
    totalPromptTokens: totalPrompt,
    avgDecodeTps: countDecodeTps ? parseFloat((sumDecodeTps / countDecodeTps).toFixed(1)) : null,
    validDecodeTurns: countDecodeTps,
    peakDecodeTps: peakDecodeTps !== null ? parseFloat((peakDecodeTps as number).toFixed(2)) : null,
    peakDecodeTurnOrder,
    avgPrefillTps: countPrefillTps ? parseFloat((sumPrefillTps / countPrefillTps).toFixed(1)) : null,
    validPrefillTurns: countPrefillTps,
    peakPrefillTps: peakPrefillTps !== null ? parseFloat((peakPrefillTps as number).toFixed(2)) : null,
    peakPrefillTurnOrder,
    avgTtftMs: countTtftMs ? parseFloat((sumTtftMs / countTtftMs).toFixed(1)) : null,
    validTtftTurns: countTtftMs,
    minTtftMs,
    minTtftTurnOrder,
    avgCacheHitRatio: countCacheHit ? parseFloat((sumCacheHit / countCacheHit).toFixed(1)) : null,
    validCacheTurns: countCacheHit,
  };
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

/** 统一格式化引擎后端与 CUDA 版本标识：如 "CUDA 12.4"、"CUDA 12"、"Vulkan"、"CPU" 及 ninfer 分支标签 */
export function formatEngineBackend(
  backend?: string | null,
  cudaVersion?: string | null,
  engineType?: "llamacpp" | "ninfer" | "ninfer_kvmem" | string | null,
): string {
  const b = (backend || "cuda").toLowerCase();
  let base = "CUDA";
  if (b.includes("cuda")) {
    if (cudaVersion && cudaVersion.trim()) {
      const v = cudaVersion.trim().replace(/^cuda[-_]?/i, "").replace(/^cu/i, "");
      base = `CUDA ${v}`;
    } else {
      const match = b.match(/(?:cuda[-_]?|cu)(\d+(?:\.\d+)?)/i);
      base = match && match[1] ? `CUDA ${match[1]}` : "CUDA";
    }
  } else if (b === "vulkan") {
    base = "Vulkan";
  } else if (b === "cpu") {
    base = "CPU";
  } else {
    base = backend?.toUpperCase() || "CUDA";
  }

  if (engineType === "ninfer_kvmem") {
    return base.toLowerCase().includes("kvmem") ? base : `${base} · KVMem`;
  }
  if (engineType === "ninfer") {
    return base.toLowerCase().includes("ninfer") ? base : `${base} · NInfer`;
  }
  return base;
}

/** 统一写入系统剪贴板（优先 navigator.clipboard，异常或不支持时回退 writeClipboard） */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    await writeClipboard(text);
    return true;
  } catch {}
  return false;
}

/** 格式化日志列表为纯文本字符串（每行格式为：[HH:mm:ss] [SYS/OUT/ERR/WRN] log line） */
export function formatLogsPlainText(logs: LlamaLogPayload[]): string {
  return logs
    .map((log) => {
      const kind = lineKind(log.stream, log.line);
      const tag = kind === "err" ? "ERR" : kind === "warn" ? "WRN" : kind === "system" ? "SYS" : "OUT";
      return `${timeLabel(log.timestamp)} [${tag}] ${log.line}`;
    })
    .join("\n");
}

