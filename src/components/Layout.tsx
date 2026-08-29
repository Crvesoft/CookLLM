import { Check, MessageSquareText, Play, SlidersHorizontal, Square, SquareTerminal, Boxes, type LucideIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";
import type { GpuStats, LlamaLogPayload, ModelAsset, Page, ServerStatus, TokSample } from "../types";
import { cn, lineKind, modelTitle, timeLabel } from "../utils";
import { LlamaMark } from "./LlamaMark";
import MiniStatusBar from "./MiniStatusBar";

export function Sidebar({ page, onPage, modelCount, status, abnormal, gpuStats, tokSample }: { page: Page; onPage: (page: Page) => void; modelCount: number; status: ServerStatus; abnormal: boolean; gpuStats: GpuStats | null; tokSample: TokSample | null }) {
  const nav: Array<{ id: Page; label: string; icon: LucideIcon; badge?: string }> = [
    { id: "models", label: "模型仓库", icon: Boxes, badge: String(modelCount) },
    { id: "profiles", label: "运行预设", icon: SlidersHorizontal },
    { id: "playground", label: "会话", icon: MessageSquareText },
    { id: "logs", label: "日志", icon: SquareTerminal },
  ];
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark"><LlamaMark size={36} /></div><div><strong>CookLLM</strong></div></div>
    <div className="side-section-label">工作区</div>
    <nav className="side-nav">{nav.map((item) => { const Icon = item.icon; return <button key={item.id} className={cn("side-link", page === item.id && "active")} onClick={() => onPage(item.id)}><Icon size={18} /><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}</button>; })}</nav>
    <div className="sidebar-spacer" />
    <MiniStatusBar page={page} onPage={onPage} status={status} abnormal={abnormal} gpuStats={gpuStats} tokSample={tokSample} />
  </aside>;
}

const PAGE_LABELS: Record<Page, string> = { models: "模型仓库", profiles: "运行预设", playground: "会话", logs: "日志", settings: "偏好设置" };

export function Topbar({ page, status, busy, onToggleService, models, modelId, onSelectModel }: { page: Page; status: ServerStatus; busy: boolean; onToggleService: () => void; models: ModelAsset[]; modelId: string; onSelectModel: (id: string) => void }) {
  /** 状态融入模型组件：运行中用只读胶囊替代下拉框（绿点 + 名称 · 量化），停止服务后自动还原为可选下拉框 */
  const active = models.find((model) => model.id === status.modelId);
  const runningLabel = active ? `${modelTitle(active)} · ${active.quantization}` : status.modelName || "运行中的模型";
  return <header className="topbar" data-tauri-drag-region><div className="breadcrumbs"><strong>{PAGE_LABELS[page]}</strong></div><div className="topbar-actions">{status.running ? <span className="running-capsule" title={`正在运行：${runningLabel}`}><i aria-hidden="true" /><span>{runningLabel}</span></span> : <label className="topbar-model" title="快速启动的模型"><select value={modelId} onChange={(e) => onSelectModel(e.target.value)} disabled={!models.length}>{!models.length && <option value="">选择模型</option>}{models.map((item) => <option key={item.id} value={item.id}>{modelTitle(item)}</option>)}</select></label>}<button className={cn("service-toggle", status.running && "running")} disabled={busy} onClick={onToggleService}>{status.running ? <><Square size={13} fill="currentColor" />关闭服务</> : <><Play size={14} fill="currentColor" />启动服务</>}</button></div></header>;
}

export function LogsPage({ logs, status, onClear }: { logs: LlamaLogPayload[]; status: ServerStatus; onClear: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  // 立即跳到最后一行（无平滑动画，避免切页时从首行可见地滑到底）
  useEffect(() => { endRef.current?.scrollIntoView(); }, [logs]);
  return <div className="logs-page"><div className="console-toolbar"><div><span className="dot red" /><span className="dot yellow" /><span className="dot green" /><strong>llama-server · output</strong>{status.running ? <span className="live-badge"><i />运行中</span> : <span className="logs-idle">未运行</span>}</div><div><button onClick={onClear}>清空</button></div></div><div className="console-lines">{logs.length ? logs.map((log, index) => { const kind = lineKind(log.stream, log.line); return <div className={cn("log-line", kind)} key={`${log.timestamp}-${index}`}><span>{timeLabel(log.timestamp)}</span><em>{kind === "err" ? "ERR" : kind === "warn" ? "WRN" : kind === "system" ? "SYS" : "OUT"}</em><code>{log.line}</code></div>; }) : <div className="console-empty">暂无日志输出</div>}<div ref={endRef} /></div></div>;
}

export function Toast({ children }: { children: React.ReactNode }) { return <div className="toast"><Check size={15} />{children}</div>; }
