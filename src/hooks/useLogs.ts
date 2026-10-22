import { useRef, useState } from "react";
import { INITIAL_LOGS } from "../data";
import type { LlamaLogPayload } from "../types";
import { newLog } from "../utils";

/** 日志缓冲上限：长时间运行不无限增长 */
const LOG_LIMIT = 1000;

/** 日志状态：100ms 批量 flush，避免 llama-server 启动期逐行推送触发全树重渲染 */
export function useLogs() {
  const [logs, setLogs] = useState<LlamaLogPayload[]>(INITIAL_LOGS);
  const logBufferRef = useRef<LlamaLogPayload[]>([]);
  const logTimerRef = useRef<number | null>(null);

  const flushLogs = () => {
    logTimerRef.current = null;
    if (!logBufferRef.current.length) return;
    const batch = logBufferRef.current;
    logBufferRef.current = [];
    setLogs((previous) => [...previous, ...batch].slice(-LOG_LIMIT));
  };

  const queueLogs = (entries: LlamaLogPayload[]) => {
    logBufferRef.current.push(...entries);
    if (logTimerRef.current === null) logTimerRef.current = window.setTimeout(flushLogs, 100);
  };

  const appendLog = (line: string, stream: LlamaLogPayload["stream"] = "system") => queueLogs([newLog(line, stream)]);

  const clearLogs = () => setLogs([]);

  return { logs, appendLog, queueLogs, clearLogs };
}
