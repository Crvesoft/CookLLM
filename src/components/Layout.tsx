import { Check, ChevronDown, ChevronRight, Maximize2, MessageSquareText, Minimize2, Moon, Play, Settings2, SlidersHorizontal, Square, SquareTerminal, Sun, Boxes, X, Search, type LucideIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { LlamaLogPayload, ModelAsset, Page, ServerStatus } from "../types";
import { cn, modelTitle, timeLabel } from "../utils";
import { LlamaMark } from "./LlamaMark";

export function Sidebar({ page, onPage, modelCount, theme, onSetTheme }: { page: Page; onPage: (page: Page) => void; modelCount: number; theme: "dark" | "light"; onSetTheme: (theme: "dark" | "light") => void }) {
  const nav: Array<{ id: Page; label: string; icon: LucideIcon; badge?: string }> = [
    { id: "models", label: "模型仓库", icon: Boxes, badge: String(modelCount) },
    { id: "profiles", label: "运行预设", icon: SlidersHorizontal },
    { id: "playground", label: "会话", icon: MessageSquareText },
    { id: "logs", label: "日志", icon: SquareTerminal },
  ];
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark"><LlamaMark size={21} /></div><div><strong>CookLLM</strong></div></div>
    <div className="side-section-label">工作区</div>
    <nav className="side-nav">{nav.map((item) => { const Icon = item.icon; return <button key={item.id} className={cn("side-link", page === item.id && "active")} onClick={() => onPage(item.id)}><Icon size={18} /><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}</button>; })}</nav>
    <div className="sidebar-spacer" />
    <div className="sidebar-footer"><span>v0.1.0</span><span className="sidebar-footer-actions"><button className={cn("theme-icon-button", page === "settings" && "active")} title="偏好设置" onClick={() => onPage("settings")}><Settings2 size={15} /></button><button className="theme-icon-button" title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"} onClick={() => onSetTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}</button></span></div>
  </aside>;
}

export function Topbar({ query, onQuery, running, busy, onToggleService, models, modelId, onSelectModel }: { query: string; onQuery: (value: string) => void; running: boolean; busy: boolean; onToggleService: () => void; models: ModelAsset[]; modelId: string; onSelectModel: (id: string) => void }) {
  return <header className="topbar" data-tauri-drag-region><div className="breadcrumbs"><span>本地工作区</span><ChevronRight size={14} /><strong>模型调度</strong></div><div className="topbar-actions"><label className="search-box"><Search size={16} /><input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="搜索模型、量化或路径…" /><kbd>⌘ K</kbd></label><label className="topbar-model" title="快速启动的模型"><select value={modelId} onChange={(e) => onSelectModel(e.target.value)} disabled={!models.length}>{!models.length && <option value="">选择模型</option>}{models.map((item) => <option key={item.id} value={item.id}>{modelTitle(item)}</option>)}</select></label><button className={cn("service-toggle", running && "running")} disabled={busy} onClick={onToggleService}>{running ? <><Square size={13} fill="currentColor" />关闭服务</> : <><Play size={14} fill="currentColor" />启动服务</>}</button></div></header>;
}

// llama.cpp 日志行着色：按流与 llama.cpp 日志级别（I/W/E）分类
const lineKind = (stream: LlamaLogPayload["stream"], line: string): "system" | "err" | "warn" | "msg" => {
  if (stream === "system") return "system";
  if (stream === "stderr") {
    // llama.cpp 日志格式：时间戳 + 级别字母（I/W/E），如 "0.00.105.500 I cmn  ..."
    const tag = line.match(/^\S+\s+([IWE])\s/)?.at(1)?.toUpperCase();
    if (tag === "E") return "err";
    if (tag === "W") return "warn";
  }
  return "msg";
};

export function LogsPage({ logs, status, onClear }: { logs: LlamaLogPayload[]; status: ServerStatus; onClear: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  return <div className="logs-page"><div className="console-toolbar"><div><span className="dot red" /><span className="dot yellow" /><span className="dot green" /><strong>llama-server · output</strong>{status.running ? <span className="live-badge"><i />运行中</span> : <span className="logs-idle">未运行</span>}</div><div><button onClick={onClear}>清空</button></div></div><div className="console-lines">{logs.length ? logs.map((log, index) => { const kind = lineKind(log.stream, log.line); return <div className={cn("log-line", kind)} key={`${log.timestamp}-${index}`}><span>{timeLabel(log.timestamp)}</span><em>{kind === "err" ? "ERR" : kind === "warn" ? "WRN" : kind === "system" ? "SYS" : "OUT"}</em><code>{log.line}</code></div>; }) : <div className="console-empty">暂无日志输出</div>}<div ref={endRef} /></div></div>;
}

export function ConsoleDrawer({ logs, open, status, logEndRef, onToggle, onClear, hidden }: { logs: LlamaLogPayload[]; open: boolean; status: ServerStatus; logEndRef: React.RefObject<HTMLDivElement | null>; onToggle: () => void; onClear: () => void; hidden?: boolean }) {
  // 高度拖拽：height 为像素值，或用 "max" 表示展开到 55vh
  const [height, setHeight] = useState<number | "max">(190);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.max(120, Math.min(window.innerHeight * 0.75, drag.startH + (drag.startY - e.clientY)));
    setHeight(next);
  };
  const onUp = () => { dragRef.current = null; window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height === "max" ? window.innerHeight * 0.55 : height };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const toggleHeight = () => setHeight((h) => (h === "max" ? 190 : "max"));
  const maximized = height === "max";
  return <div className={cn("console-drawer", open && "open")} style={hidden ? { display: "none" } : undefined}><button className="console-tab" onClick={onToggle}><SquareTerminal size={16} /><span>运行日志</span><i className={status.running ? "online" : ""} />{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>{open && <div className={cn("console-shell", maximized && "expanded")} style={{ height: maximized ? "55vh" : `${height}px` }}><div className="console-resize" title="拖动调整高度" onPointerDown={startDrag} onDoubleClick={toggleHeight} /><div className="console-toolbar"><div><span className="dot red" /><span className="dot yellow" /><span className="dot green" /><strong>llama-server · output</strong></div><div><button onClick={onClear}>清空</button><button onClick={toggleHeight}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button><button onClick={onToggle}><X size={15} /></button></div></div><div className="console-lines">{logs.length ? logs.map((log, index) => { const kind = lineKind(log.stream, log.line); return <div className={cn("log-line", kind)} key={`${log.timestamp}-${index}`}><span>{timeLabel(log.timestamp)}</span><em>{kind === "err" ? "ERR" : kind === "warn" ? "WRN" : kind === "system" ? "SYS" : "OUT"}</em><code>{log.line}</code></div>; }) : <div className="console-empty">暂无日志输出</div>}<div ref={logEndRef} /></div></div>}</div>;
}

export function Toast({ children }: { children: React.ReactNode }) { return <div className="toast"><Check size={15} />{children}</div>; }
