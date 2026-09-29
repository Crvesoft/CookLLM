import { Activity, ChevronDown, ChevronUp, SquareTerminal, Zap } from "lucide-react";
import type React from "react";
import { useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import type { InferenceMetrics, LlamaLogPayload, ServerStatus } from "../types";
import { cn, formatEngineBackend, lineKind, timeLabel } from "../utils";
import InferenceInspector from "./InferenceInspector";

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
  /** 结构化最新单次推理性能指标（含解码速率、预热速率、缓存命中等） */
  latestMetrics?: InferenceMetrics | null;
  /** 历史推理指标列表 */
  inferenceHistory?: InferenceMetrics[];
  /** 清空性能统计历史 */
  onClearHistory?: () => void;
  /** 当前主引擎分支名 */
  activeEngineName?: string;
  /** 当前主引擎计算后端 */
  activeEngineBackend?: string;
  /** 当前主引擎 CUDA 版本 */
  activeEngineCudaVersion?: string;
  /** 点击快速切换引擎面板 */
  onOpenEnginePicker?: () => void;
  onToggle: () => void;
  onHeightChange: (height: number) => void;
  onClear: () => void;
}

/**
 * 会话页 Dock 日志：参与页面 flex 布局（非悬浮）。单一容器高度在 34px（收起=状态栏）与展开高度间过渡，
 * 日志面板常驻挂载（只被高度裁剪），因此收展有平滑动画、日志滚动位置也不丢失。
 * 仅负责显示 / 隐藏；Rust 端日志监听与缓冲始终持续，关闭后再打开仍能看到之前的日志。
 */
export default function LogDock({
  open,
  height,
  logs,
  status,
  modelName,
  abnormal,
  tokPerSec,
  latestMetrics,
  inferenceHistory,
  onClearHistory,
  activeEngineName,
  activeEngineBackend,
  activeEngineCudaVersion,
  onOpenEnginePicker,
  onToggle,
  onHeightChange,
  onClear,
}: LogDockProps) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  /** 性能分析与运行日志记忆性选择：记录到 localStorage，保持上次的选择 */
  const [tab, setTabState] = useState<"logs" | "perf">(() => {
    try {
      const saved = localStorage.getItem("cookllm_dock_tab");
      if (saved === "logs" || saved === "perf") return saved;
    } catch {}
    return "logs";
  });

  const setTab = (newTab: "logs" | "perf") => {
    setTabState(newTab);
    try {
      localStorage.setItem("cookllm_dock_tab", newTab);
    } catch {}
  };

  /** 服务若关闭后重新启动，自动切回"运行日志"以便查看启动状态；其余情况（如菜单切换、折叠展开）保留记忆性选择 */
  const prevRunningRef = useRef(status.running);
  useEffect(() => {
    if (!prevRunningRef.current && status.running) {
      setTabState("logs");
      try {
        localStorage.setItem("cookllm_dock_tab", "logs");
      } catch {}
    }
    prevRunningRef.current = status.running;
  }, [status.running]);

  // 展开后 / 新日志到达时立即跳到最后一行（无平滑动画：切页重新挂载时不会从首行可见地滑到底；与悬浮抽屉行为一致）
  useEffect(() => { if (open) endRef.current?.scrollIntoView(); }, [logs, open]);

  // ---- 拖动 Dock 上边缘调整高度（120px ~ 60% 视口）----
  /** 拖拽中关闭高度过渡：否则面板高度过渡跟不上指针（不跟手） */
  const [resizing, setResizing] = useState(false);
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
    setResizing(true);

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

    /** 松开 / 取消 / 窗口失焦：结束会话，保持当前拖拽高度，无磁吸干预 */
    const finish = () => {
      dragState.current = null;
      pendingHeight.current = null;
      setResizing(false);
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

  /** 双击分割线在紧凑点（160px）与展开点（380px）之间快速吸附切换 */
  const handleDoubleClickResize = () => {
    const nextH = height >= 250 ? 160 : 380;
    onHeightChange(nextH);
  };

  // 状态栏基础文案：异常 > 运行中 > 未启动
  const baseModelText = modelName || t("modelFallback");
  const statusText = abnormal ? t("serviceAbnormal") : status.running ? `${baseModelText} · Running` : t("notStarted");

  return (
    <div className={cn("log-dock", open && "open", resizing && "resizing")} style={{ height: open ? height : 34 }}>
      <div className="log-dock-panel" aria-hidden={!open}>
        <div
          className="log-dock-resize"
          title={t("resizeDockHint")}
          onPointerDown={startDrag}
          onDoubleClick={handleDoubleClickResize}
        />
        <div className="console-toolbar">
          <div className="dock-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "logs"} className={cn("dock-tab", tab === "logs" && "active")} onClick={() => setTab("logs")}>
              <SquareTerminal size={12} />{t("dock.tabLogs")}
            </button>
            <button type="button" role="tab" aria-selected={tab === "perf"} className={cn("dock-tab", tab === "perf" && "active")} onClick={() => setTab("perf")}>
              <Activity size={12} />{t("dock.tabPerf")}
            </button>
            {abnormal && <em className="dock-error-badge">{t("serviceAbnormal")}</em>}
          </div>
          <div>
            {tab === "logs"
              ? <button onClick={onClear}>{t("clearLogs")}</button>
              : onClearHistory && <button onClick={onClearHistory}>{t("perf.clearStats")}</button>}
          </div>
        </div>

        {tab === "perf" ? (
          <div className="dock-perf-pane">
            <InferenceInspector
              metrics={latestMetrics ?? null}
              history={inferenceHistory || []}
              onClearHistory={onClearHistory}
              mode="dock"
              dockHeight={height}
            />
          </div>
        ) : (
          <div className="console-lines">
            {logs.length ? logs.map((log, index) => { const kind = lineKind(log.stream, log.line); return <div className={cn("log-line", kind)} key={`${log.timestamp}-${index}`}><span>{timeLabel(log.timestamp)}</span><em>{kind === "err" ? "ERR" : kind === "warn" ? "WRN" : kind === "system" ? "SYS" : "OUT"}</em><code>{log.line}</code></div>; }) : <div className="console-empty">{t("noLogs")}</div>}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <div className={cn("log-dock-bar", !abnormal && status.running && "running", abnormal && "abnormal")}>
        <div className="log-dock-bar-left">
          <span className="log-dock-status"><i aria-hidden="true" />{statusText}</span>

          {activeEngineName && onOpenEnginePicker && (
            <button
              type="button"
              className={cn("dock-engine-pill", status.running && "is-running")}
              onClick={onOpenEnginePicker}
              title={
                status.running
                  ? t("llama.dockEngineRunningTooltip", { name: activeEngineName })
                  : t("llama.dockEngineTooltip", { name: activeEngineName })
              }
            >
              <Zap size={11} className="dock-engine-zap" />
              <span className="dock-engine-name">{activeEngineName}</span>
              {activeEngineBackend && (
                <span className="dock-engine-backend">
                  {formatEngineBackend(activeEngineBackend, activeEngineCudaVersion)}
                </span>
              )}
            </button>
          )}
        </div>
        <button
          className="log-dock-toggle"
          onClick={onToggle}
          title={open ? t("collapseDock") : t("expandDock")}
        >
          {open ? (
            <ChevronDown size={15} />
          ) : (
            <>
              <SquareTerminal size={13} />
              <span>{abnormal ? t("viewLogs") : t("runLogs")}</span>
              <ChevronUp size={13} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
