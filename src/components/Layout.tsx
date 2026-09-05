import { Check, MessageSquareText, PanelLeftClose, PanelLeftOpen, Play, Settings, SlidersHorizontal, Square, SquareTerminal, Boxes, Globe, type LucideIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import type { GpuStats, LlamaLogPayload, ModelAsset, Page, ServerStatus, TokSample } from "../types";
import { cn, lineKind, modelTitle, timeLabel } from "../utils";
import { LlamaMark } from "./LlamaMark";
import MiniStatusBar from "./MiniStatusBar";

export function Sidebar({ page, onPage, downloadBadge, updateAvailable, status, abnormal, gpuStats, tokSample, collapsed, onToggleCollapsed, theme, onToggleTheme }: { page: Page; onPage: (page: Page) => void; downloadBadge?: string; updateAvailable?: boolean; status: ServerStatus; abnormal: boolean; gpuStats: GpuStats | null; tokSample: TokSample | null; collapsed: boolean; onToggleCollapsed: () => void; theme: string; onToggleTheme: () => void }) {
  const { t } = useI18n();
  const nav: Array<{ id: Page; label: string; icon: LucideIcon; badge?: string; badgeClass?: string; dot?: boolean }> = [
    { id: "models", label: t("nav.models"), icon: Boxes },
    { id: "profiles", label: t("nav.profiles"), icon: SlidersHorizontal },
    { id: "explore", label: t("nav.explore"), icon: Globe, badge: downloadBadge, badgeClass: "download-badge" },

    { id: "playground", label: t("nav.playground"), icon: MessageSquareText },
    { id: "logs", label: t("nav.logs"), icon: SquareTerminal },
    { id: "settings", label: t("nav.settings"), icon: Settings },
  ];
  return <aside className={cn("sidebar", collapsed && "collapsed")}>
    <div className="brand"><div className="brand-mark"><LlamaMark size={36} /></div><div className="brand-name"><strong>CookLLM</strong></div><button className="sidebar-toggle" title={collapsed ? t("expandMenu") : t("collapseMenu")} aria-label={collapsed ? t("expandMenu") : t("collapseMenu")} onClick={onToggleCollapsed}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
    <div className="side-section-label">{t("workspace")}</div>
    <nav className="side-nav">{nav.map((item) => { const Icon = item.icon; return <button key={item.id} title={collapsed ? item.label : undefined} className={cn("side-link", page === item.id && "active")} onClick={() => onPage(item.id)}><Icon size={18} /><span>{item.label}</span>{item.badge && <em className={item.badgeClass}>{item.badge}</em>}{item.dot && <i className="update-dot" aria-hidden="true" />}</button>; })}</nav>
    <div className="sidebar-spacer" />
    {/* 收起时仅用 CSS 隐藏（保持挂载）：迷你图的采样历史在收放之间不丢失 */}
    <MiniStatusBar status={status} abnormal={abnormal} gpuStats={gpuStats} tokSample={tokSample} theme={theme} updateAvailable={updateAvailable} onToggleTheme={onToggleTheme} />
  </aside>;
}

export function Topbar({ page, status, busy, onToggleService, models, modelId, onSelectModel }: { page: Page; status: ServerStatus; busy: boolean; onToggleService: () => void; models: ModelAsset[]; modelId: string; onSelectModel: (id: string) => void }) {
  const { t } = useI18n();
  /** 状态融入模型组件：运行中用只读胶囊替代下拉框（绿点 + 名称 · 量化），停止服务后自动还原为可选下拉框 */
  const active = models.find((model) => model.id === status.modelId);
  const runningLabel = active ? `${modelTitle(active)} · ${active.quantization}` : status.modelName || t("modelFallback");
  return <header className="topbar" data-tauri-drag-region><div className="breadcrumbs"><strong>{t(page === "models" ? "nav.models" : page === "explore" ? "nav.explore" : page === "profiles" ? "nav.profiles" : page === "playground" ? "nav.playground" : page === "logs" ? "nav.logs" : "nav.settings")}</strong></div><div className="topbar-actions">{status.running ? <span className="running-capsule" title={t("runningPrefix", { label: runningLabel })}><i aria-hidden="true" /><span>{runningLabel}</span></span> : <label className="topbar-model" title={t("selectModel")}><select value={modelId} onChange={(e) => onSelectModel(e.target.value)} disabled={!models.length}>{!models.length && <option value="">{t("selectModel")}</option>}{models.map((item) => <option key={item.id} value={item.id}>{modelTitle(item)}</option>)}</select></label>}<button className={cn("service-toggle", status.running && "running")} disabled={busy} onClick={onToggleService}>{status.running ? <><Square size={13} fill="currentColor" />{t("stopService")}</> : <><Play size={14} fill="currentColor" />{t("startService")}</>}</button></div></header>;
}

export function LogsPage({ logs, status, onClear }: { logs: LlamaLogPayload[]; status: ServerStatus; onClear: () => void }) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  // 立即跳到最后一行（无平滑动画，避免切页时从首行可见地滑到底）
  useEffect(() => { endRef.current?.scrollIntoView(); }, [logs]);
  return <div className="logs-page"><div className="console-toolbar"><div><span className="dot red" /><span className="dot yellow" /><span className="dot green" /><strong>llama-server · output</strong>{status.running ? <span className="live-badge"><i />{t("statusRunning")}</span> : <span className="logs-idle">{t("statusStopped")}</span>}</div><div><button onClick={onClear}>{t("clearLogs")}</button></div></div><div className="console-lines">{logs.length ? logs.map((log, index) => { const kind = lineKind(log.stream, log.line); return <div className={cn("log-line", kind)} key={`${log.timestamp}-${index}`}><span>{timeLabel(log.timestamp)}</span><em>{kind === "err" ? "ERR" : kind === "warn" ? "WRN" : kind === "system" ? "SYS" : "OUT"}</em><code>{log.line}</code></div>; }) : <div className="console-empty">{t("noLogs")}</div>}<div ref={endRef} /></div></div>;
}

export function Toast({ children }: { children: React.ReactNode }) { return <div className="toast"><Check size={15} />{children}</div>; }
