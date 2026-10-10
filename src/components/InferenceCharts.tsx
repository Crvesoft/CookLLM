import { Zap, Filter, ChevronDown, Check } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { InferenceMetrics } from "../types";
import { cn, classifyRoundStatus, type InferenceFilterType } from "../utils";

export interface TurnData {
  item: InferenceMetrics;
  live: boolean;
  order: number;
}

/**
 * 紧凑下拉式数据筛选选择器（节省空间，支持全部/完整推理/Decode/Prefill快速切换）
 */
export function InferenceFilterDropdown({
  value,
  onChange,
  className,
}: {
  value: InferenceFilterType;
  onChange: (filter: InferenceFilterType) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleOutsideClick);
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  const options: { id: InferenceFilterType; label: string; dotClass?: string }[] = [
    { id: "all", label: t("perf.filterAll") },
    { id: "complete", label: t("perf.filterComplete"), dotClass: "complete" },
    { id: "decode", label: t("perf.filterDecode"), dotClass: "decode" },
    { id: "prefill", label: t("perf.filterPrefill"), dotClass: "prefill" },
  ];

  const currentLabel = options.find((opt) => opt.id === value)?.label ?? t("perf.filterAll");

  return (
    <div className={cn("inf-filter-dropdown-wrap", className)} ref={containerRef}>
      <button
        type="button"
        className={cn("inf-filter-dropdown-btn", value !== "all" && `active active-${value}`, open && "open")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        <Filter size={9.5} className="inf-filter-icon" />
        <span className="inf-filter-text">{currentLabel}</span>
        <ChevronDown size={9.5} className={cn("inf-filter-arrow", open && "open")} />
      </button>

      {open && (
        <div className="inf-filter-menu" onClick={(e) => e.stopPropagation()}>
          {options.map((opt) => {
            const isSelected = opt.id === value;
            return (
              <button
                key={opt.id}
                type="button"
                className={cn("inf-filter-menu-item", opt.id, isSelected && "selected")}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
              >
                {opt.dotClass && <i className={cn("filter-item-dot", opt.dotClass)} />}
                <span className="filter-item-label">{opt.label}</span>
                {isSelected && <Check size={11} className="filter-item-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface HistoryDetailsTableProps {
  turns: TurnData[];
  totalTurnsCount?: number;
  filterType?: InferenceFilterType;
  onFilterChange?: (filter: InferenceFilterType) => void;
  selectedId: string | null;
  pinnedId?: string | null;
  onSelectTurn: (id: string) => void;
}

function speed(val: number | null | undefined): string {
  return val == null || !Number.isFinite(val) ? "—" : val.toFixed(2);
}

function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function tokens(count: number): string {
  if (count >= 10000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * 历史全量轮次明细数据表（沉浸式填满独立日志页面下半部空白）
 */
export function HistoryDetailsTable({
  turns,
  totalTurnsCount,
  filterType,
  onFilterChange,
  selectedId,
  pinnedId,
  onSelectTurn,
}: HistoryDetailsTableProps) {
  const { t } = useI18n();

  return (
    <div className="inf-page-table-card">
      <div className="inf-table-header">
        <div className="inf-table-title-wrap">
          <Zap size={13} className="text-orange" />
          <span className="inf-table-title">{t("perf.historyTable")}</span>
          <span className="inf-table-badge">
            {totalTurnsCount != null && totalTurnsCount !== turns.length
              ? t("perf.filteredCount", { shown: turns.length, total: totalTurnsCount })
              : t("perf.turnsCount", { count: turns.length })}
          </span>
        </div>

        {filterType && onFilterChange && (
          <div className="inf-table-actions">
            <InferenceFilterDropdown value={filterType} onChange={onFilterChange} />
          </div>
        )}
      </div>

      <div className="inf-table-scroll">
        <table className="inf-data-table">
          <thead>
            <tr>
              <th className="col-turn">{t("perf.colTurn")}</th>
              <th className="col-time">{t("perf.colTime")}</th>
              <th className="col-speed">{t("perf.colDecodeTps")}</th>
              <th className="col-speed">{t("perf.colPrefillTps")}</th>
              <th className="col-ttft">{t("perf.colTtft")}</th>
              <th className="col-context">{t("perf.colContext")}</th>
              <th className="col-cache">{t("perf.colCache")}</th>
              <th className="col-timing">{t("perf.colTiming")}</th>
              <th className="col-total">{t("perf.colTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {turns.map(({ item, live, order }) => {
              const active = item.id === selectedId;
              const isPinned = pinnedId === item.id;
              const prefillMs = item.prefillTimeMs && item.prefillTimeMs > 0 ? item.prefillTimeMs : null;
              const decodeMs = item.decodeTimeMs && item.decodeTimeMs > 0 ? item.decodeTimeMs : null;
              const totalMs = item.totalTimeMs && item.totalTimeMs > 0
                ? item.totalTimeMs
                : prefillMs != null && decodeMs != null ? prefillMs + decodeMs : null;
              const ttftMs = item.ttftMs && item.ttftMs > 0 ? item.ttftMs : prefillMs;
              // 耗时构成含排队（NInfer 口径 TTFT 含 queue，需单列出来才不被误读为 prefill/decode 慢）
              const queueMs = item.queueMs != null && item.queueMs > 0 ? item.queueMs : null;
              const timed = (queueMs ?? 0) + (prefillMs ?? 0) + (decodeMs ?? 0);
              const queuePct = queueMs != null && timed > 0 ? Math.round((queueMs / timed) * 100) : null;
              const prefillPct = timed > 0 && prefillMs != null ? Math.round((prefillMs / timed) * 100) : null;
              const decodePct = timed > 0 && decodeMs != null ? Math.max(0, 100 - (queuePct ?? 0) - (prefillPct ?? 0)) : null;

              const promptTokens = item.promptTokens ?? ((item.prefillTokens ?? 0) + (item.cachedTokens ?? 0));
              const decodeTokens = item.decodeTokens ?? 0;
              const cacheRatio = item.cacheHitRatio ?? (promptTokens > 0 && item.cachedTokens != null ? (item.cachedTokens / promptTokens) * 100 : null);

              const status = classifyRoundStatus(item, live);
              const statusLabel =
                status === "generating"
                  ? t("perf.status.generating")
                  : status === "complete"
                  ? t("perf.status.complete")
                  : status === "decode-only"
                  ? t("perf.status.decodeOnly")
                  : status === "prefill-only"
                  ? t("perf.status.prefillOnly")
                  : status === "context-kv"
                  ? t("perf.status.contextKv")
                  : t("perf.status.noThroughput");

              return (
                <tr
                  key={item.id}
                  className={cn("inf-table-row", active && "active", isPinned && "pinned", live && "live", `status-${status}`)}
                  onClick={() => onSelectTurn(isPinned ? "" : item.id)}
                  title={isPinned ? "已锁定该轮（点击取消锁定回到实时）" : undefined}
                >
                  <td className="col-turn">
                    <span className={cn("inf-turn-badge", live && "live")}>
                      <i className={cn("inf-dot", live ? "live" : "idle")} aria-hidden="true" />
                      <span className="inf-turn-text">
                        {live ? t("perf.liveTurn") : t("perf.turnIndex", { index: order })}
                      </span>
                    </span>
                  </td>
                  <td className="col-time">{clock(item.timestamp)}</td>
                  <td className={cn("col-speed text-decode", (!item.decodeTps || item.decodeTps <= 0) && "text-muted")}>
                    <b>{item.decodeTps != null && item.decodeTps > 0 ? `${speed(item.decodeTps)}` : "—"}</b>
                    {item.decodeTps != null && item.decodeTps > 0 && <small> tok/s</small>}
                  </td>
                  <td className={cn("col-speed text-prefill", (!item.prefillTps || item.prefillTps <= 0) && "text-muted")}>
                    <b>{item.prefillTps != null && item.prefillTps > 0 ? `${speed(item.prefillTps)}` : "—"}</b>
                    {item.prefillTps != null && item.prefillTps > 0 && <small> tok/s</small>}
                  </td>
                  <td className="col-ttft">{duration(ttftMs)}</td>
                  <td className="col-context">
                    <span>{tokens(promptTokens)} / {tokens(decodeTokens)}</span>
                  </td>
                  <td className="col-cache">
                    {cacheRatio != null ? (
                      <div className="inf-table-cache">
                        <span>{cacheRatio.toFixed(1)}%</span>
                        <i className="inf-thin-bar">
                          <span style={{ width: `${Math.min(100, Math.max(0, cacheRatio))}%` }} />
                        </i>
                      </div>
                    ) : "—"}
                  </td>
                  <td className="col-timing">
                    {timed > 0 && (prefillPct != null || decodePct != null) ? (
                      <div className="inf-table-timing">
                        <div className="inf-timing-split-bar">
                          {queuePct != null && queuePct > 0 && (
                            <span className="queue" style={{ width: `${queuePct}%` }} title={`Queue: ${queuePct}%`} />
                          )}
                          {prefillPct != null && (
                            <span className="prefill" style={{ width: `${prefillPct}%` }} title={`Prefill: ${prefillPct}%`} />
                          )}
                          {decodePct != null && (
                            <span className="decode" style={{ width: `${decodePct}%` }} title={`Decode: ${decodePct}%`} />
                          )}
                        </div>
                        <small>
                          {queuePct != null && queuePct > 0 ? `${queuePct}% / ` : ""}{prefillPct ?? 0}% / {decodePct ?? 0}%
                        </small>
                      </div>
                    ) : "—"}
                  </td>
                  <td className="col-total">{duration(totalMs)}</td>
                </tr>
              );
            })}
            {turns.length === 0 && (
              <tr className="inf-table-empty-row">
                <td colSpan={9} style={{ textAlign: "center", padding: "36px 0", color: "#636f80" }}>
                  {t("perf.noMatchingTurns")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
