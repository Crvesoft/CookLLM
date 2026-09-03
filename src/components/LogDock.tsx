import { ChevronDown, SquareTerminal } from "lucide-react";
import type React from "react";
import { useI18n } from "../i18n";
import { useEffect, useRef } from "react";
import type { LlamaLogPayload, ServerStatus } from "../types";
import { cn, lineKind, timeLabel } from "../utils";

interface LogDockProps {
  /** Dock 是否展开；收起时只显示底部状态栏（不遮挡 WebUI，WebUI 获得全部剩余高度） */
  open: boolean;
  /** 展开后的总高度 px（120 ~ 60% 视口），由 App 持久化到 localStorage */
  height: number;
  logs: LlamaLogPayload[];
  status: ServerStatus;
  /** 运行中的模型显示名，状态栏展示用 */
  modelName?: string;
  /** 服务异常（启动失败 / 进程意外退出）：状态栏变红并提示查看日志 */
  abnormal: boolean;
  /** 最近一次从日志解析到的生成吞吐，可选展示 */
  tokPerSec?: number | null;
  onToggle: () => void;
  onHeightChange: (height: number) => void;
  onClear: () => void;
}

/**
 * 会话页 Dock 日志：参与页面 flex 布局（非悬浮），收起 = 底部状态栏，展开 = 可调高度的日志面板。
 * 仅负责显示 / 隐藏；Rust 端日志监听与缓冲始终持续，关闭后再打开仍能看到之前的日志。
 */
export default function LogDock({ open, height, logs, status, modelName, abnormal, tokPerSec, onToggle, onHeightChange, onClear }: LogDockProps) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  // 展开后 / 新日志到达时立即跳到最后一行（无平滑动画：切页重新挂载时不会从首行可见地滑到底；与悬浮抽屉行为一致）
  useEffect(() => { if (open) endRef.current?.scrollIntoView(); }, [logs, open]);

  // ---- 拖动 Dock 上边缘调整高度（120px ~ 60% 视口）----
  /** 最新回调：全局监听经 ref 取值，避免闭包过期 */
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;
  /** 按压会话（按下 → 松开），同一时刻至多一个 */
  const dragState = useRef<{ startY: number; startH: number } | null>(null);
  /** rAF 合并：每帧最多提交一次——pointermove 可达百级 Hz，逐事件 setState 会让全 App 重渲染追不上指针（不跟手） */
  const pendingHeight = useRef<number | null>(null);
  const rafId = useRef(0);

  const startDrag = (e: React.PointerEvent) => {
    if (dragState.current || e.button !== 0) return;
    e.preventDefault();
    /** 捕获指针：否则拖动经过上方内嵌 WebUI（iframe）区域时事件改派给子文档，父窗口丢失 move/up——跟手冻结、松手后监听残留 */
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { startY: e.clientY, startH: height };

    const onMove = (event: PointerEvent) => {
      const drag = dragState.current;
      if (!drag) return;
      pendingHeight.current = Math.round(Math.max(120, Math.min(window.innerHeight * 0.6, drag.startH + (drag.startY - event.clientY))));
      if (!rafId.current) rafId.current = requestAnimationFrame(() => {
        rafId.current = 0;
        const h = pendingHeight.current;
        pendingHeight.current = null;
        if (h !== null && dragState.current) onHeightChangeRef.current(h);
      });
    };

    /** 松开 / 取消 / 窗口失焦（鼠标在窗口外松开时 pointerup 不会到达）：结束会话并移除监听——否则残留监听会让松手后指针悬停仍跟着变高度 */
    const finish = () => {
      dragState.current = null;
      pendingHeight.current = null;
      if (rafId.current) { cancelAnimationFrame(rafId.current); rafId.current = 0; }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  // 状态栏文案：异常 > 运行中（含吞吐）> 未启动
  const statusText = abnormal ? t("serviceAbnormal") : status.running ? `${modelName || t("modelFallback")} · Running${tokPerSec != null ? ` ${tokPerSec} tok/s` : ""}` : t("notStarted");

  if (!open) {
    return (
      <div className={cn("log-dock-bar", !abnormal && status.running && "running", abnormal && "abnormal")}>
        <span className="log-dock-status"><i aria-hidden="true" />{statusText}</span>
        <button className="log-dock-toggle" onClick={onToggle}><SquareTerminal size={14} /><span>{abnormal ? t("viewLogs") : t("runLogs")}</span></button>
      </div>
    );
  }

  return (
    <div className="log-dock-panel" style={{ height }}>
      <div className="log-dock-resize" title={t("resizeDockHint")} onPointerDown={startDrag} />
      <div className="console-toolbar">
        <div>
          <span className="dot red" /><span className="dot yellow" /><span className="dot green" />
          {abnormal && <em className="dock-error-badge">{t("serviceAbnormal")}</em>}
          <strong>llama-server · output</strong>
        </div>
        <div>
          <button onClick={onClear}>{t("clearLogs")}</button>
          <button onClick={onToggle} title={t("collapseDock")}><ChevronDown size={15} /></button>
        </div>
      </div>
      <div className="console-lines">
        {logs.length ? logs.map((log, index) => { const kind = lineKind(log.stream, log.line); return <div className={cn("log-line", kind)} key={`${log.timestamp}-${index}`}><span>{timeLabel(log.timestamp)}</span><em>{kind === "err" ? "ERR" : kind === "warn" ? "WRN" : kind === "system" ? "SYS" : "OUT"}</em><code>{log.line}</code></div>; }) : <div className="console-empty">{t("noLogs")}</div>}
        <div ref={endRef} />
      </div>
    </div>
  );
}
