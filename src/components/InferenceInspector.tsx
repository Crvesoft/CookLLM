import { useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { useI18n } from "../i18n";
import type { InferenceMetrics } from "../types";
import {
  cn,
  computeSessionStats,
  classifyRoundStatus,
  matchesInferenceFilter,
  type RoundStatus,
  type InferenceFilterType,
} from "../utils";
import { HistoryDetailsTable, InferenceFilterDropdown } from "./InferenceCharts";

interface InferenceInspectorProps {
  metrics: InferenceMetrics | null;
  history: InferenceMetrics[];
  onClearHistory?: () => void;
  compact?: boolean;
  mode?: "dock" | "page";
  dockHeight?: number;
}

/** 速率：两位小数；缺失时不显示 0，避免把未知伪装成测到的数据 */
function speed(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

/** 动态监听容器尺寸，保证 SVG 在 1:1 坐标系下渲染，圆形与描边绝对保真、不被拉伸变形 */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 330, height: 110 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setSize({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size] as const;
}

/** 将离散折线坐标转换为平滑三次贝塞尔曲线及闭合面积路径，消除生硬尖锐折角 */
function pointsToSmoothPath(
  pts: [number, number][],
  baselineY: number,
  padT: number
): { lineD: string; areaD: string } {
  if (pts.length < 2) return { lineD: "", areaD: "" };
  if (pts.length === 2) {
    const [p0, p1] = pts;
    const dx = p1[0] - p0[0];
    const cp1x = p0[0] + dx * 0.45;
    const cp2x = p1[0] - dx * 0.45;
    const lineD = `M ${p0[0].toFixed(1)} ${p0[1].toFixed(1)} C ${cp1x.toFixed(1)} ${p0[1].toFixed(1)}, ${cp2x.toFixed(1)} ${p1[1].toFixed(1)}, ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
    const areaD = `${lineD} L ${p1[0].toFixed(1)} ${baselineY.toFixed(1)} L ${p0[0].toFixed(1)} ${baselineY.toFixed(1)} Z`;
    return { lineD, areaD };
  }

  // 多轮次使用 Catmull-Rom 三次贝塞尔样条平滑，消除剧烈的锯齿折角
  const tension = 0.2;
  let lineD = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    let cp1x = p1[0] + (p2[0] - p0[0]) * tension;
    let cp1y = p1[1] + (p2[1] - p0[1]) * tension;

    let cp2x = p2[0] - (p3[0] - p1[0]) * tension;
    let cp2y = p2[1] - (p3[1] - p1[1]) * tension;

    // 约束控制点不超出图表上下边界
    cp1y = Math.max(padT, Math.min(baselineY, cp1y));
    cp2y = Math.max(padT, Math.min(baselineY, cp2y));

    lineD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }

  const startX = pts[0][0].toFixed(1);
  const endX = pts[pts.length - 1][0].toFixed(1);
  const bY = baselineY.toFixed(1);
  const areaD = `${lineD} L ${endX} ${bY} L ${startX} ${bY} Z`;

  return { lineD, areaD };
}

interface ThroughputTrendCardProps {
  turns: { item: InferenceMetrics; live: boolean; order: number }[];
  totalTurnsCount?: number;
  filterType?: InferenceFilterType;
  onFilterChange?: (filter: InferenceFilterType) => void;
  selectedId: string | null;
  pinnedId?: string | null;
  onSelectTurn?: (id: string) => void;
  sessionStats: ReturnType<typeof computeSessionStats>;
}

/** 右上角历史轮次吞吐趋势平滑面积曲线卡片（Decode 与 Prefill 双曲线同屏对比，与左下角 GPU 监控网格风格天然统一） */
function ThroughputTrendCard({
  turns,
  totalTurnsCount,
  filterType,
  onFilterChange,
  selectedId,
  pinnedId,
  onSelectTurn,
  sessionStats,
}: ThroughputTrendCardProps) {
  const { t } = useI18n();
  const [bodyRef, size] = useElementSize<HTMLDivElement>();

  // 历史轮次按时间正序排列（从早到晚，第 1 轮 -> 第 N 轮），完整保留所有轮次，绝不人为剔除
  const chrono = useMemo(() => [...turns].reverse(), [turns]);

  // 提取历史轮次与当前活跃轮次中的有效数值（只要测出了速率即纳入真实曲线展示）
  const validDecodeRates = useMemo(() => {
    return chrono
      .filter((turn) => turn.item.decodeTps != null && turn.item.decodeTps > 0)
      .map((turn) => turn.item.decodeTps!);
  }, [chrono]);

  const validPrefillRates = useMemo(() => {
    return chrono
      .filter((turn) => turn.item.prefillTps != null && turn.item.prefillTps > 0)
      .map((turn) => turn.item.prefillTps!);
  }, [chrono]);

  const showDecode = filterType !== "prefill";
  const showPrefill = filterType !== "decode";

  // 依据当前筛选动态决定 Y 轴上限：
  // 若只看 Decode，则完全不受 Prefill 巨额数值压扁；若只看 Prefill，则专注 Prefill 刻度；全部或完整时两者统一物理比例尺
  const maxRate = useMemo(() => {
    const rates: number[] = [];
    if (showDecode) rates.push(...validDecodeRates);
    if (showPrefill) rates.push(...validPrefillRates);
    return Math.max(0, ...rates);
  }, [showDecode, showPrefill, validDecodeRates, validPrefillRates]);

  const chartMax = Math.max(30, maxRate * 1.15);

  const W = Math.max(120, size.width);
  const H = Math.max(60, size.height);
  const PAD_T = 10;
  const PAD_B = 14;
  const PAD_X = 14;
  const innerW = Math.max(10, W - PAD_X * 2);
  const innerH = Math.max(10, H - PAD_T - PAD_B);
  const baselineY = PAD_T + innerH;

  // 映射所有轮次：保留完整 X 轴连续性，流式活跃轮次测得速率实时上屏，绝不误判为 0 tok/s
  const trendPoints = useMemo(() => {
    return chrono.map((turn, idx) => {
      const status = classifyRoundStatus(turn.item, turn.live);
      const isLive = turn.live;

      const rawDecode = turn.item.decodeTps != null && turn.item.decodeTps > 0 ? turn.item.decodeTps : null;
      const rawPrefill = turn.item.prefillTps != null && turn.item.prefillTps > 0 ? turn.item.prefillTps : null;

      const x =
        chrono.length <= 1
          ? PAD_X + innerW / 2
          : PAD_X + (idx / (chrono.length - 1)) * innerW;

      const decodeY = rawDecode != null
        ? PAD_T + innerH - (Math.max(0, Math.min(chartMax, rawDecode)) / chartMax) * innerH
        : null;

      const prefillY = rawPrefill != null
        ? PAD_T + innerH - (Math.max(0, Math.min(chartMax, rawPrefill)) / chartMax) * innerH
        : null;

      return {
        x,
        decodeY,
        prefillY,
        rawDecode,
        rawPrefill,
        turn,
        status,
        idx,
        isLive,
      };
    });
  }, [chrono, chartMax, PAD_X, PAD_T, innerW, innerH]);

  // Decode 全量有效点连贯曲线（将有效轮次连续平滑连接，避免碎片化断裂）
  const decodePath = useMemo(() => {
    const validPts: [number, number][] = trendPoints
      .filter((p) => p.decodeY !== null)
      .map((p) => [p.x, p.decodeY!]);
    if (validPts.length < 2) {
      return { pts: validPts, lineD: "", areaD: "" };
    }
    const smooth = pointsToSmoothPath(validPts, baselineY, PAD_T);
    return { pts: validPts, lineD: smooth.lineD, areaD: smooth.areaD };
  }, [trendPoints, baselineY, PAD_T]);

  // Prefill 全量有效点连贯曲线
  const prefillPath = useMemo(() => {
    const validPts: [number, number][] = trendPoints
      .filter((p) => p.prefillY !== null)
      .map((p) => [p.x, p.prefillY!]);
    if (validPts.length < 2) {
      return { pts: validPts, lineD: "", areaD: "" };
    }
    const smooth = pointsToSmoothPath(validPts, baselineY, PAD_T);
    return { pts: validPts, lineD: smooth.lineD, areaD: smooth.areaD };
  }, [trendPoints, baselineY, PAD_T]);

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (trendPoints.length === 0 || !bodyRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    const scaleX = rect.width > 0 ? W / rect.width : 1;
    const mouseX = (e.clientX - rect.left) * scaleX;

    let closestIdx = 0;
    let minDist = Infinity;
    trendPoints.forEach((p, idx) => {
      const dist = Math.abs(p.x - mouseX);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = idx;
      }
    });

    setHoveredIdx(closestIdx);
  };

  const handlePointerLeave = () => {
    setHoveredIdx(null);
  };

  const handleClick = () => {
    if (hoveredIdx != null && trendPoints[hoveredIdx]) {
      const turnId = trendPoints[hoveredIdx].turn.item.id;
      onSelectTurn?.(turnId === (pinnedId ?? selectedId) ? "" : turnId);
    }
  };

  const hoveredPoint = hoveredIdx != null ? trendPoints[hoveredIdx] : null;
  const selectedTurn = turns.find((t) => t.item.id === selectedId);
  const isGenerating = turns.some((t) => t.live);

  // 与左下角 GPU 监控相同的网格设计：横向 4 分线 × 纵向 5 分线
  const gridLines = (
    <g className="trend-grid">
      {[1, 2, 3].map((i) => (
        <line
          key={`h${i}`}
          x1={PAD_X}
          y1={PAD_T + (innerH * i) / 4}
          x2={W - PAD_X}
          y2={PAD_T + (innerH * i) / 4}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {[1, 2, 3, 4].map((i) => (
        <line
          key={`v${i}`}
          x1={PAD_X + (innerW * i) / 5}
          y1={PAD_T}
          x2={PAD_X + (innerW * i) / 5}
          y2={PAD_T + innerH}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <line x1={PAD_X} y1={baselineY} x2={W - PAD_X} y2={baselineY} vectorEffect="non-scaling-stroke" />
    </g>
  );

  const isDualMode = showDecode && showPrefill;

  const tooltipY = hoveredPoint
    ? (showDecode ? hoveredPoint.decodeY : null) ?? (showPrefill ? hoveredPoint.prefillY : null) ?? (baselineY - 30)
    : baselineY;

  return (
    <div className="inf-page-card inf-trend-card">
      {/* 顶部标题与双指标图例 + 紧凑下拉筛选 + 快速指标栏 */}
      <div className="inf-trend-top">
        <div className="inf-card-header">
          <div className="inf-trend-title-wrap">
            <Activity size={12} style={{ color: "#ff8c42", flexShrink: 0 }} />
            <span className="inf-card-title">{t("perf.throughputTrend")}</span>
            <span className="inf-trend-badge">
              {totalTurnsCount != null && totalTurnsCount !== turns.length
                ? `${turns.length}/${totalTurnsCount}`
                : `${turns.length}轮`}
            </span>
          </div>

          <div className="inf-trend-header-right">
            <div className="inf-trend-legend">
              {showDecode && (
                <span className="legend-item decode">
                  <i className="legend-dot decode" />
                  <span>Decode</span>
                </span>
              )}
              {showPrefill && (
                <span className="legend-item prefill">
                  <i className="legend-dot prefill" />
                  <span>Prefill</span>
                </span>
              )}
            </div>

            {filterType && onFilterChange && (
              <InferenceFilterDropdown value={filterType} onChange={onFilterChange} />
            )}
          </div>
        </div>

        {/* 指标放上方：随筛选动态调整，避免呈现无关或全空的指标 */}
        <div className="inf-trend-header-stats">
          {filterType === "prefill" ? (
            <>
              <div className="trend-stat">
                <span>{t("perf.avgPrefill")}</span>
                <b>
                  {sessionStats.avgPrefillTps != null ? `${sessionStats.avgPrefillTps}` : "—"}
                  <small> tok/s</small>
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validPrefillTurns })}</em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.peakPrefill")}</span>
                <b>
                  {sessionStats.peakPrefillTps != null ? `${sessionStats.peakPrefillTps}` : "—"}
                  <small> tok/s</small>
                </b>
                <em>
                  {sessionStats.peakPrefillTurnOrder != null
                    ? t("perf.turnIndex", { index: sessionStats.peakPrefillTurnOrder })
                    : "—"}
                </em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.avgTtft")}</span>
                <b>
                  {sessionStats.avgTtftMs != null ? duration(sessionStats.avgTtftMs) : "—"}
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validTtftTurns })}</em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.statCache")}</span>
                <b>
                  {sessionStats.avgCacheHitRatio != null ? `${sessionStats.avgCacheHitRatio}%` : "—"}
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validCacheTurns })}</em>
              </div>
            </>
          ) : filterType === "decode" ? (
            <>
              <div className="trend-stat">
                <span>{t("perf.avgDecode")}</span>
                <b>
                  {sessionStats.avgDecodeTps != null ? `${sessionStats.avgDecodeTps}` : "—"}
                  <small> tok/s</small>
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validDecodeTurns })}</em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.peakDecode")}</span>
                <b>
                  {sessionStats.peakDecodeTps != null ? `${sessionStats.peakDecodeTps}` : "—"}
                  <small> tok/s</small>
                </b>
                <em>
                  {sessionStats.peakDecodeTurnOrder != null
                    ? t("perf.turnIndex", { index: sessionStats.peakDecodeTurnOrder })
                    : "—"}
                </em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.avgTtft")}</span>
                <b>
                  {sessionStats.avgTtftMs != null ? duration(sessionStats.avgTtftMs) : "—"}
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validTtftTurns })}</em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.statTokens")}</span>
                <b>
                  {sessionStats.totalTokens > 0 ? tokens(sessionStats.totalTokens) : "—"}
                  <small> tok</small>
                </b>
                <em>{t("perf.statRequests")}</em>
              </div>
            </>
          ) : (
            <>
              <div className="trend-stat">
                <span>{t("perf.avgDecode")}</span>
                <b>
                  {sessionStats.avgDecodeTps != null ? `${sessionStats.avgDecodeTps}` : "—"}
                  <small> tok/s</small>
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validDecodeTurns })}</em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.peakDecode")}</span>
                <b>
                  {sessionStats.peakDecodeTps != null ? `${sessionStats.peakDecodeTps}` : "—"}
                  <small> tok/s</small>
                </b>
                <em>
                  {sessionStats.peakDecodeTurnOrder != null
                    ? t("perf.turnIndex", { index: sessionStats.peakDecodeTurnOrder })
                    : "—"}
                </em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.avgPrefill")}</span>
                <b>
                  {sessionStats.avgPrefillTps != null ? `${sessionStats.avgPrefillTps}` : "—"}
                  <small> tok/s</small>
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validPrefillTurns })}</em>
              </div>
              <div className="trend-stat">
                <span>{t("perf.avgTtft")}</span>
                <b>
                  {sessionStats.avgTtftMs != null ? duration(sessionStats.avgTtftMs) : "—"}
                </b>
                <em>{t("perf.validTurns", { count: sessionStats.validTtftTurns })}</em>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 核心交互曲线图区：依据筛选类型动态绘制对应曲线，重叠时以虚实交替高对比呈现 */}
      <div
        className="inf-trend-body"
        ref={bodyRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="inf-trend-svg">
          <defs>
            <linearGradient id="trendAreaGradDecode" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff8c42" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#ff8c42" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="trendAreaGradPrefill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* 背景参考网格 */}
          {gridLines}

          {/* 悬停准星竖向指示虚线 */}
          {hoveredPoint && (
            <line
              x1={hoveredPoint.x}
              y1={PAD_T}
              x2={hoveredPoint.x}
              y2={baselineY}
              stroke={filterType === "prefill" ? "#38bdf8" : "#ff8c42"}
              strokeWidth="1.2"
              strokeDasharray="3 3"
              opacity="0.65"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Prefill 平滑虚线曲线 */}
          {showPrefill && prefillPath.areaD && (
            <path d={prefillPath.areaD} fill="url(#trendAreaGradPrefill)" />
          )}
          {showPrefill && prefillPath.lineD && (
            <path
              d={prefillPath.lineD}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1.8"
              strokeDasharray="4 3"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Decode 连贯平滑曲线与渐变面积（仅当包含 Decode 筛选时绘制） */}
          {showDecode && decodePath.areaD && (
            <path d={decodePath.areaD} fill="url(#trendAreaGradDecode)" />
          )}
          {showDecode && decodePath.lineD && (
            <path
              d={decodePath.lineD}
              fill="none"
              stroke="#ff8c42"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* 无效轮次在 X 轴基线上呈现淡灰色特殊标记，保留 X 轴轮次完整性 */}
          {trendPoints
            .filter((p) => p.decodeY === null && p.prefillY === null)
            .map((p) => {
              const isSelected = p.turn.item.id === (pinnedId ?? selectedId);
              const isHovered = p.idx === hoveredIdx;
              return (
                <g
                  key={`null-${p.turn.item.id}`}
                  className={cn("inf-trend-node-null", isSelected && "selected", isHovered && "hovered")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTurn?.(p.turn.item.id === (pinnedId ?? selectedId) ? "" : p.turn.item.id);
                  }}
                >
                  <title>{`#${p.turn.order} 轮: ${p.status === "context-kv" ? "上下文/KV操作" : "无有效吞吐"}`}</title>
                  {(isSelected || isHovered) && (
                    <circle
                      cx={p.x}
                      cy={baselineY}
                      r={6}
                      fill="none"
                      stroke="#64748b"
                      strokeWidth="1.2"
                      opacity="0.7"
                    />
                  )}
                  <circle
                    cx={p.x}
                    cy={baselineY}
                    r={2.2}
                    fill={p.status === "context-kv" ? "#34d399" : "#64748b"}
                    opacity="0.6"
                  />
                </g>
              );
            })}

          {/* Prefill 有效数据节点（仅当包含 Prefill 筛选时呈现） */}
          {showPrefill && trendPoints
            .filter((p) => p.prefillY !== null)
            .map((p) => {
              const isSelected = p.turn.item.id === (pinnedId ?? selectedId);
              const isHovered = p.idx === hoveredIdx;
              const r = isSelected || isHovered ? 4 : trendPoints.length > 16 ? 2.2 : 2.8;
              return (
                <g
                  key={`pnode-${p.turn.item.id}`}
                  className={cn("inf-trend-node", isSelected && "selected", isHovered && "hovered", p.isLive && "live")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTurn?.(p.turn.item.id === (pinnedId ?? selectedId) ? "" : p.turn.item.id);
                  }}
                >
                  <title>{`#${p.turn.order} 轮 Prefill: ${p.rawPrefill!.toFixed(2)} tok/s`}</title>
                  {(isSelected || isHovered) && (
                    <circle
                      cx={p.x}
                      cy={p.prefillY!}
                      r={isHovered ? 8 : 6.5}
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth="1.8"
                      opacity={isHovered ? 0.95 : 0.85}
                    />
                  )}
                  {p.isLive && !isSelected && !isHovered && (
                    <circle
                      cx={p.x}
                      cy={p.prefillY!}
                      r={5.5}
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth="1.2"
                      opacity="0.75"
                      strokeDasharray="2 2"
                    />
                  )}
                  <circle
                    cx={p.x}
                    cy={p.prefillY!}
                    r={r}
                    fill={isHovered ? "#bae6fd" : isSelected ? "#7dd3fc" : "#38bdf8"}
                  />
                </g>
              );
            })}

          {/* Decode 有效数据节点（仅当包含 Decode 筛选时呈现） */}
          {showDecode && trendPoints
            .filter((p) => p.decodeY !== null)
            .map((p) => {
              const isSelected = p.turn.item.id === (pinnedId ?? selectedId);
              const isHovered = p.idx === hoveredIdx;
              const r = isSelected || isHovered ? 4 : trendPoints.length > 16 ? 2.2 : 2.8;
              return (
                <g
                  key={`dnode-${p.turn.item.id}`}
                  className={cn("inf-trend-node", isSelected && "selected", isHovered && "hovered", p.isLive && "live")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTurn?.(p.turn.item.id === (pinnedId ?? selectedId) ? "" : p.turn.item.id);
                  }}
                >
                  <title>{`#${p.turn.order} 轮 Decode: ${p.rawDecode!.toFixed(2)} tok/s`}</title>
                  {(isSelected || isHovered) && (
                    <circle
                      cx={p.x}
                      cy={p.decodeY!}
                      r={isHovered ? 8 : 6.5}
                      fill="none"
                      stroke="#ff8c42"
                      strokeWidth="1.8"
                      opacity={isHovered ? 0.95 : 0.85}
                    />
                  )}
                  {p.isLive && !isSelected && !isHovered && (
                    <circle
                      cx={p.x}
                      cy={p.decodeY!}
                      r={5.5}
                      fill="none"
                      stroke="#ff8c42"
                      strokeWidth="1.2"
                      opacity="0.75"
                      strokeDasharray="2 2"
                    />
                  )}
                  <circle
                    cx={p.x}
                    cy={p.decodeY!}
                    r={r}
                    fill={isHovered ? "#ffd2a6" : isSelected ? "#ffc28d" : "#ff8c42"}
                  />
                </g>
              );
            })}
        </svg>

        {/* 悬停浮窗：四象限自适应防溢出定位 + 显式呈现 Token 数与性能参数 */}
        {hoveredPoint && (() => {
          const isRightSide = hoveredPoint.x > W * 0.52;
          const activeY = (showDecode && hoveredPoint.decodeY !== null ? hoveredPoint.decodeY : null)
            ?? (showPrefill && hoveredPoint.prefillY !== null ? hoveredPoint.prefillY : null)
            ?? (baselineY - 10);
          const isBottomSide = activeY > H * 0.46;

          return (
            <div
              className={cn(
                "inf-trend-tooltip",
                isRightSide ? "pos-left" : "pos-right",
                isBottomSide ? "align-bottom" : "align-top"
              )}
              style={{
                left: `${Math.max(PAD_X, Math.min(W - PAD_X, hoveredPoint.x))}px`,
                top: `${Math.max(PAD_T, Math.min(baselineY, activeY))}px`,
              }}
            >
              <div className="tooltip-head">
                <span className="tooltip-turn">{t("perf.turnIndex", { index: hoveredPoint.turn.order })}</span>
                <span className={cn("tooltip-status-tag", hoveredPoint.status)}>
                  {hoveredPoint.status === "generating"
                    ? t("perf.status.generating")
                    : hoveredPoint.status === "complete"
                    ? t("perf.status.complete")
                    : hoveredPoint.status === "decode-only"
                    ? t("perf.status.decodeOnly")
                    : hoveredPoint.status === "prefill-only"
                    ? t("perf.status.prefillOnly")
                    : hoveredPoint.status === "context-kv"
                    ? t("perf.status.contextKv")
                    : t("perf.status.noThroughput")}
                </span>
              </div>

              <div className="tooltip-rows">
                {/* 若选了 prefill 筛选，优先在第一行展示 Prefill；否则默认 Decode 优先 */}
                {filterType === "prefill" ? (
                  <>
                    <div className="tooltip-row">
                      <span>Prefill</span>
                      <b className={hoveredPoint.turn.item.prefillTps && hoveredPoint.turn.item.prefillTps > 0 ? "text-cyan" : "text-muted"}>
                        {hoveredPoint.turn.item.prefillTps != null && hoveredPoint.turn.item.prefillTps > 0
                          ? `${hoveredPoint.turn.item.prefillTps.toFixed(1)} tok/s`
                          : "—"}
                        {hoveredPoint.turn.item.promptTokens != null && hoveredPoint.turn.item.promptTokens > 0 && (
                          <span className="tooltip-token-badge">
                            {tokens(hoveredPoint.turn.item.promptTokens)} tok
                          </span>
                        )}
                      </b>
                    </div>
                    {showDecode && (
                      <div className="tooltip-row">
                        <span>Decode</span>
                        <b className={hoveredPoint.turn.item.decodeTps && hoveredPoint.turn.item.decodeTps > 0 ? "text-orange" : "text-muted"}>
                          {hoveredPoint.turn.item.decodeTps != null && hoveredPoint.turn.item.decodeTps > 0
                            ? `${hoveredPoint.turn.item.decodeTps.toFixed(2)} tok/s`
                            : "—"}
                          {hoveredPoint.turn.item.decodeTokens != null && hoveredPoint.turn.item.decodeTokens > 0 && (
                            <span className="tooltip-token-badge">
                              {tokens(hoveredPoint.turn.item.decodeTokens)} tok
                            </span>
                          )}
                        </b>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {showDecode && (
                      <div className="tooltip-row">
                        <span>Decode</span>
                        <b className={hoveredPoint.turn.item.decodeTps && hoveredPoint.turn.item.decodeTps > 0 ? "text-orange" : "text-muted"}>
                          {hoveredPoint.turn.item.decodeTps != null && hoveredPoint.turn.item.decodeTps > 0
                            ? `${hoveredPoint.turn.item.decodeTps.toFixed(2)} tok/s`
                            : "—"}
                          {hoveredPoint.turn.item.decodeTokens != null && hoveredPoint.turn.item.decodeTokens > 0 && (
                            <span className="tooltip-token-badge">
                              {tokens(hoveredPoint.turn.item.decodeTokens)} tok
                            </span>
                          )}
                        </b>
                      </div>
                    )}
                    {showPrefill && (
                      <div className="tooltip-row">
                        <span>Prefill</span>
                        <b className={hoveredPoint.turn.item.prefillTps && hoveredPoint.turn.item.prefillTps > 0 ? "text-cyan" : "text-muted"}>
                          {hoveredPoint.turn.item.prefillTps != null && hoveredPoint.turn.item.prefillTps > 0
                            ? `${hoveredPoint.turn.item.prefillTps.toFixed(1)} tok/s`
                            : "—"}
                          {hoveredPoint.turn.item.promptTokens != null && hoveredPoint.turn.item.promptTokens > 0 && (
                            <span className="tooltip-token-badge">
                              {tokens(hoveredPoint.turn.item.promptTokens)} tok
                            </span>
                          )}
                        </b>
                      </div>
                    )}
                  </>
                )}

                {hoveredPoint.turn.item.ttftMs != null && hoveredPoint.turn.item.ttftMs > 0 && (
                  <div className="tooltip-row">
                    <span>TTFT</span>
                    <b>{duration(hoveredPoint.turn.item.ttftMs)}</b>
                  </div>
                )}

                {(hoveredPoint.status === "context-kv" || (hoveredPoint.turn.item.cacheHitRatio != null && hoveredPoint.turn.item.cacheHitRatio > 0)) && (
                  <div className="tooltip-row">
                    <span>KV Cache</span>
                    <b className="text-emerald">
                      {hoveredPoint.turn.item.cacheHitRatio != null
                        ? `${hoveredPoint.turn.item.cacheHitRatio.toFixed(1)}%`
                        : "—"}
                      {hoveredPoint.turn.item.cachedTokens != null && hoveredPoint.turn.item.cachedTokens > 0 && (
                        <span className="tooltip-token-badge">
                          {tokens(hoveredPoint.turn.item.cachedTokens)} tok
                        </span>
                      )}
                    </b>
                  </div>
                )}

                {hoveredPoint.turn.item.totalTimeMs != null && hoveredPoint.turn.item.totalTimeMs > 0 && (
                  <div className="tooltip-row total-time">
                    <span>{t("perf.totalTime")}</span>
                    <b>{duration(hoveredPoint.turn.item.totalTimeMs)}</b>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* 无轮次数据或筛选无结果时的状态占位 */}
        {trendPoints.length === 0 && (
          <div className="inf-trend-empty-overlay">
            <span>
              {isGenerating
                ? t("perf.pending")
                : turns.length === 0
                ? t("perf.noMatchingTurns")
                : t("perf.noValue")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** 1 秒以下用毫秒，以上用秒，避免同一面板里混用两种写法 */
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

export default function InferenceInspector({
  metrics,
  history,
  mode = "dock",
  dockHeight,
}: InferenceInspectorProps) {
  const { t } = useI18n();
  /** null 表示跟随最新一轮；点历史行后锁定到该轮 id */
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const [filterType, setFilterType] = useState<InferenceFilterType>(() => {
    try {
      const saved = localStorage.getItem("cookllm_inference_filter");
      if (saved === "complete" || saved === "decode" || saved === "prefill" || saved === "all") {
        return saved;
      }
    } catch {
      // ignore
    }
    return "all";
  });

  const liveId = metrics?.id ?? null;
  const liveInHistory = liveId != null && history.some((item) => item.id === liveId);
  /** 尚未进入历史的独立轮次快照 */
  const liveOnly = metrics && !liveInHistory ? metrics : null;

  // 真正处于正在生成状态：未提交至历史、未产生最终总耗时、且在近期（6s内）有活跃数据流
  const isTrulyLive = Boolean(
    liveOnly &&
    !liveOnly.totalTimeMs &&
    (Date.now() - (liveOnly.timestamp || 0) < 6000)
  );

  // 新一轮真正开始生成时回到实时，避免用户停在上一轮看不到当前数据
  useEffect(() => {
    if (isTrulyLive) setPinnedId(null);
  }, [isTrulyLive, liveId]);

  // 清空历史时自动重置锁定状态
  useEffect(() => {
    if (!history.length && !metrics) {
      setPinnedId(null);
    }
  }, [history.length, metrics]);

  const allTurns = useMemo(() => {
    const list: { item: InferenceMetrics; live: boolean; order: number }[] = [];
    if (liveOnly) {
      list.push({
        item: liveOnly,
        live: isTrulyLive,
        order: history.length + 1,
      });
    }
    history.forEach((item, index) => {
      // 历史记录中的所有轮次均属已完成，绝不标记为 live
      list.push({ item, live: false, order: history.length - index });
    });
    return list;
  }, [history, liveOnly, isTrulyLive]);

  const handleFilterChange = (next: InferenceFilterType) => {
    setFilterType(next);
    if (pinnedId) {
      const stillValid = allTurns.some(
        (turn) => turn.item.id === pinnedId && matchesInferenceFilter(turn.item, turn.live, next)
      );
      if (!stillValid) setPinnedId(null);
    }
    try {
      localStorage.setItem("cookllm_inference_filter", next);
    } catch {
      // ignore
    }
  };

  const filteredTurns = useMemo(() => {
    return allTurns.filter((turn) => matchesInferenceFilter(turn.item, turn.live, filterType));
  }, [allTurns, filterType]);

  const selected = (pinnedId ? filteredTurns.find((turn) => turn.item.id === pinnedId)?.item : null)
    ?? filteredTurns[0]?.item
    ?? (pinnedId ? allTurns.find((turn) => turn.item.id === pinnedId)?.item : null)
    ?? allTurns[0]?.item
    ?? null;

  const sessionStats = useMemo(() => {
    const filteredHistory = filteredTurns.filter((t) => !t.live).map((t) => t.item);
    const orders = filteredTurns.filter((t) => !t.live).map((t) => t.order);
    return computeSessionStats(filteredHistory, orders);
  }, [filteredTurns]);

  if (!selected) {
    return (
      <div className={cn("inf-inspector inf-empty", mode === "page" ? "mode-page" : "mode-dock")}>
        <div className="inf-empty-content">
          <span className="inf-empty-dash">—</span>
          <span>{t("perf.waitingInference")}</span>
        </div>
      </div>
    );
  }

  const isSelectedFilteredOut = filteredTurns.length === 0 || !filteredTurns.some((t) => t.item.id === selected.id);

  const streaming = Boolean(selected.decodeTokens && !selected.totalTimeMs && !selected.prefillTimeMs);
  const prefillPhase = Boolean(selected.prefillTps != null && !selected.decodeTokens);
  const decodeTokens = selected.decodeTokens ?? 0;
  const prefillTokens = selected.prefillTokens ?? 0;
  const cachedTokens = selected.cachedTokens ?? 0;
  const totalPromptTokens = selected.promptTokens ?? (prefillTokens > 0 ? prefillTokens + cachedTokens : 0);
  const hasContext = totalPromptTokens > 0;
  const cacheRatio = selected.cacheHitRatio ?? (hasContext && selected.cachedTokens != null ? (cachedTokens / totalPromptTokens) * 100 : null);
  const cachePct = hasContext && cacheRatio != null ? Math.min(100, Math.max(0, Math.round(cacheRatio))) : null;
  const computePct = cachePct != null ? 100 - cachePct : null;
  const prefillMs = selected.prefillTimeMs && selected.prefillTimeMs > 0 ? selected.prefillTimeMs : null;
  const decodeMs = selected.decodeTimeMs && selected.decodeTimeMs > 0 ? selected.decodeTimeMs : null;
  const queueMs = selected.queueMs != null && selected.queueMs > 0 ? selected.queueMs : null;
  const totalMs = selected.totalTimeMs && selected.totalTimeMs > 0
    ? selected.totalTimeMs
    : prefillMs != null && decodeMs != null ? prefillMs + decodeMs : null;
  const ttftMs = selected.ttftMs && selected.ttftMs > 0 ? selected.ttftMs : prefillMs;
  // 耗时构成：排队（NInfer TTFT 含排队）+ Prefill 计算 + Decode，按三者之和归一化
  const timed = (queueMs ?? 0) + (prefillMs ?? 0) + (decodeMs ?? 0);
  const queuePct = queueMs != null && timed > 0 ? Math.round((queueMs / timed) * 100) : null;
  const prefillPct = prefillMs != null && timed > 0 ? Math.round((prefillMs / timed) * 100) : null;
  const decodePct = decodeMs != null && timed > 0 ? Math.max(0, 100 - (queuePct ?? 0) - (prefillPct ?? 0)) : null;

  const decodeSub = decodeTokens > 0
    ? `${tokens(decodeTokens)} tok${decodeMs ? ` · ${duration(decodeMs)}` : ""}${selected.thinkingTokens != null && selected.thinkingTokens > 0 ? ` · ${t("perf.thinkingTokens", { n: tokens(selected.thinkingTokens) })}` : ""}`
    : prefillPhase ? t("perf.pending") : "";
  const prefillSub = prefillTokens > 0
    ? `${tokens(prefillTokens)} tok${prefillMs ? ` · ${duration(prefillMs)}` : ""}`
    : selected.prefillTps != null ? t("perf.inputProcessing") : "";

  const kpis: { key: string; value: string; name: string; sub: string }[] = [
    { key: "decode", value: selected.decodeTps != null ? `${speed(selected.decodeTps)} tok/s` : "—", name: "Decode", sub: decodeSub },
    { key: "prefill", value: selected.prefillTps != null ? `${speed(selected.prefillTps)} tok/s` : "—", name: "Prefill", sub: prefillSub },
    {
      key: "ttft",
      value: ttftMs != null ? duration(ttftMs) : streaming ? t("perf.pending") : "—",
      name: "TTFT",
      // NInfer 口径 TTFT 含排队：排队显著时直接在副标题量化，避免误读为模型慢
      sub: ttftMs != null ? (queueMs != null ? t("perf.ttftWithQueue", { queue: duration(queueMs) }) : t("perf.firstToken")) : "",
    },
    { key: "total", value: totalMs != null ? duration(totalMs) : "—", name: "Total", sub: totalMs != null ? t("perf.requestTime") : "" },
  ];

  const selectedTurn = filteredTurns.find((turn) => turn.item.id === selected.id)
    ?? allTurns.find((turn) => turn.item.id === selected.id);
  const isSelectedLive = selectedTurn?.live ?? false;
  const selectedOrder = selectedTurn?.order ?? 1;

  const isDockExpanded = mode === "dock" && (dockHeight == null || dockHeight >= 220);

  // 1. 抽屉模式（mode === "dock"）：纯净高效、无分类干扰，保留全量历史轮次
  if (mode === "dock") {
    return (
      <div className={cn("inf-inspector inf-split mode-dock", isDockExpanded ? "is-expanded" : "is-compact")}>
        <aside className="inf-history">
          <div className="inf-history-list">
            {allTurns.map((turn) => {
              const active = turn.item.id === selected.id;
              const isPinned = turn.item.id === pinnedId;
              return (
                <button
                  type="button"
                  key={turn.item.id}
                  className={cn("inf-turn", active && "active", isPinned && "pinned", turn.live && "live")}
                  onClick={() => setPinnedId(isPinned ? null : turn.item.id)}
                  title={
                    isPinned ? "已锁定该轮（点击取消锁定回到实时）" :
                    turn.item.decodeTps != null && turn.item.decodeTps > 0
                      ? `${t("perf.statDecode")}: ${turn.item.decodeTps.toFixed(2)} tok/s`
                      : turn.item.totalTimeMs != null && turn.item.totalTimeMs > 0
                      ? `${t("perf.totalTime")}: ${duration(turn.item.totalTimeMs)}`
                      : undefined
                  }
                >
                  <span className="inf-turn-time">{clock(turn.item.timestamp)}</span>
                  <span className="inf-turn-name">
                    <i className={cn("inf-dot", turn.live ? "live" : "idle")} aria-hidden="true" />
                    <span className="inf-turn-text">
                      {turn.live && !history.some((item) => item.id === turn.item.id) ? t("perf.liveTurn") : t("perf.turnIndex", { index: turn.order })}
                    </span>
                  </span>
                  <span className="inf-turn-rate">
                    {turn.item.decodeTps != null && turn.item.decodeTps > 0
                      ? `${turn.item.decodeTps.toFixed(1)} tok/s`
                      : "—"}
                  </span>
                </button>
              );
            })}
            {!allTurns.length && <div className="inf-history-empty">{t("perf.historyEmpty")}</div>}
          </div>
        </aside>

        <div className="inf-detail">
          {/* 第一层：4 个核心 KPI */}
          <div className="inf-kpis">
            {kpis.map((kpi) => (
              <div className={cn("inf-kpi", kpi.key)} key={kpi.key}>
                <b>{kpi.value}</b>
                <span>{kpi.name}</span>
                <em>{kpi.sub || "\u00a0"}</em>
              </div>
            ))}
          </div>

          {/* 第二层：上下文、KV Cache、耗时构成 */}
          <div className="inf-details">
            <div className="inf-block">
              <span className="inf-block-title">{t("perf.context")}</span>
              <b>{hasContext ? `${tokens(totalPromptTokens)} tok` : "—"}</b>
              <em>{cachePct != null ? t("perf.contextMix", { cached: cachePct, compute: computePct ?? 0 }) : t("perf.unavailable")}</em>
            </div>

            <div className="inf-block kv-cache">
              <span className="inf-block-title">KV Cache</span>
              <b>{cacheRatio != null ? `${cacheRatio.toFixed(1)}%` : "—"}</b>
              {cachePct != null && (
                <i className="inf-thin-bar" aria-hidden="true"><span style={{ width: `${cachePct}%` }} /></i>
              )}
              <em>{hasContext ? `${tokens(cachedTokens)} / ${tokens(totalPromptTokens)} tok` : t("perf.unavailable")}</em>
            </div>

            <div className="inf-block inf-timing">
              <span className="inf-block-title">{t("perf.timing")}</span>
              {queueMs != null && (
                <div className="inf-time-row">
                  <span>{t("perf.queue")}</span>
                  <b>{duration(queueMs)}</b>
                  <em>{queuePct != null ? `${queuePct}%` : ""}</em>
                  <i aria-hidden="true"><span className="queue" style={{ width: `${queuePct ?? 0}%` }} /></i>
                </div>
              )}
              <div className="inf-time-row">
                <span>Prefill</span>
                <b>{duration(prefillMs)}</b>
                <em>{prefillPct != null ? `${prefillPct}%` : ""}</em>
                <i aria-hidden="true"><span className="prefill" style={{ width: `${prefillPct ?? 0}%` }} /></i>
              </div>
              <div className="inf-time-row">
                <span>Decode</span>
                <b>{duration(decodeMs)}</b>
                <em>{decodePct != null ? `${decodePct}%` : ""}</em>
                <i aria-hidden="true"><span className="decode" style={{ width: `${decodePct ?? 0}%` }} /></i>
              </div>
            </div>
          </div>

          {/* 第三层：本会话统计（拉高时展示，紧凑状态隐藏以保全主内容） */}
          {isDockExpanded && (
            <div className="inf-session">
              <div className="inf-session-head">
                <span>{t("perf.sessionAvg")}</span>
              </div>
              <div className="inf-session-grid">
                <div><b>{sessionStats.turns}</b><em>{t("perf.statRequests")}</em></div>
                <div><b>{sessionStats.avgDecodeTps ?? "—"}<small> tok/s</small></b><em>{t("perf.statDecode")}</em></div>
                <div><b>{sessionStats.avgPrefillTps ?? "—"}<small> tok/s</small></b><em>{t("perf.statPrefill")}</em></div>
                <div><b>{sessionStats.avgCacheHitRatio != null ? `${sessionStats.avgCacheHitRatio}%` : "—"}</b><em>{t("perf.statCache")}</em></div>
                <div><b>{tokens(sessionStats.totalPromptTokens)}<small> tok</small></b><em>{t("perf.statPromptTokens")}</em></div>
                <div><b>{tokens(sessionStats.totalTokens)}<small> tok</small></b><em>{t("perf.statTokens")}</em></div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 2. 独立菜单页面模式（mode === "page"）：通栏总览（大看板 + 右上角 220px 关键参数图表）+ 全量明细大表
  return (
    <div className="inf-inspector mode-page">
      <div className="inf-page-main">
        {/* 顶部总览卡片（左侧大看板 + 右上角关键参数图表） */}
        <div className="inf-page-overview">
          <div className="inf-page-card inf-current-card">
            <div className="inf-card-header">
              <div className="inf-card-badge-wrap">
                <span className={cn("inf-card-badge", isSelectedLive && "live")}>
                  {isSelectedLive && <i className="inf-dot" aria-hidden="true" />}
                  {isSelectedLive ? t("perf.liveTurn") : t("perf.turnIndex", { index: selectedOrder })}
                  {isSelectedFilteredOut && filterType !== "all" && (
                    <small style={{ marginLeft: 5, opacity: 0.7, fontSize: 10, fontWeight: 400 }}>
                      ({t("perf.noMatchingTurns")})
                    </small>
                  )}
                </span>
                <span className="inf-card-clock">{clock(selected.timestamp)}</span>
              </div>
            </div>

            {/* 第一层：4 个核心 KPI */}
            <div className="inf-kpis">
              {kpis.map((kpi) => (
                <div className={cn("inf-kpi", kpi.key)} key={kpi.key}>
                  <b>{kpi.value}</b>
                  <span>{kpi.name}</span>
                  <em>{kpi.sub || "\u00a0"}</em>
                </div>
              ))}
            </div>

            {/* 第二层：上下文、KV Cache、耗时构成 */}
            <div className="inf-details">
              <div className="inf-block">
                <span className="inf-block-title">{t("perf.context")}</span>
                <b>{hasContext ? `${tokens(totalPromptTokens)} tok` : "—"}</b>
                <em>{cachePct != null ? t("perf.contextMix", { cached: cachePct, compute: computePct ?? 0 }) : t("perf.unavailable")}</em>
              </div>

              <div className="inf-block kv-cache">
                <span className="inf-block-title">KV Cache</span>
                <b>{cacheRatio != null ? `${cacheRatio.toFixed(1)}%` : "—"}</b>
                {cachePct != null && (
                  <i className="inf-thin-bar" aria-hidden="true"><span style={{ width: `${cachePct}%` }} /></i>
                )}
                <em>{hasContext ? `${tokens(cachedTokens)} / ${tokens(totalPromptTokens)} tok` : t("perf.unavailable")}</em>
              </div>

              <div className="inf-block inf-timing">
                <span className="inf-block-title">{t("perf.timing")}</span>
                {queueMs != null && (
                  <div className="inf-time-row">
                    <span>{t("perf.queue")}</span>
                    <b>{duration(queueMs)}</b>
                    <em>{queuePct != null ? `${queuePct}%` : ""}</em>
                    <i aria-hidden="true"><span className="queue" style={{ width: `${queuePct ?? 0}%` }} /></i>
                  </div>
                )}
                <div className="inf-time-row">
                  <span>Prefill</span>
                  <b>{duration(prefillMs)}</b>
                  <em>{prefillPct != null ? `${prefillPct}%` : ""}</em>
                  <i aria-hidden="true"><span className="prefill" style={{ width: `${prefillPct ?? 0}%` }} /></i>
                </div>
                <div className="inf-time-row">
                  <span>Decode</span>
                  <b>{duration(decodeMs)}</b>
                  <em>{decodePct != null ? `${decodePct}%` : ""}</em>
                  <i aria-hidden="true"><span className="decode" style={{ width: `${decodePct ?? 0}%` }} /></i>
                </div>
              </div>
            </div>

            {/* 第三层：本轮会话统计做成像底部抽屉那样的效果，放在正在生成下面 */}
            <div className="inf-session">
              <div className="inf-session-head">
                <span>{t("perf.sessionAvg")}</span>
              </div>
              <div className="inf-session-grid">
                <div><b>{sessionStats.turns}</b><em>{t("perf.statRequests")}</em></div>
                <div><b>{sessionStats.avgDecodeTps ?? "—"}<small> tok/s</small></b><em>{t("perf.statDecode")}</em></div>
                <div><b>{sessionStats.avgPrefillTps ?? "—"}<small> tok/s</small></b><em>{t("perf.statPrefill")}</em></div>
                <div><b>{sessionStats.avgCacheHitRatio != null ? `${sessionStats.avgCacheHitRatio}%` : "—"}</b><em>{t("perf.statCache")}</em></div>
                <div><b>{tokens(sessionStats.totalPromptTokens)}<small> tok</small></b><em>{t("perf.statPromptTokens")}</em></div>
                <div><b>{tokens(sessionStats.totalTokens)}<small> tok</small></b><em>{t("perf.statTokens")}</em></div>
              </div>
            </div>
          </div>

          {/* 右上角：历史轮次吞吐趋势卡片（宽度加宽，与左下角 GPU 监控风格天然统一，联动数据筛选） */}
          <ThroughputTrendCard
            turns={filteredTurns}
            totalTurnsCount={allTurns.length}
            filterType={filterType}
            onFilterChange={handleFilterChange}
            selectedId={selected.id}
            pinnedId={pinnedId}
            onSelectTurn={(id) => setPinnedId(id || null)}
            sessionStats={sessionStats}
          />
        </div>

        {/* 底部：全量历史轮次明细表（沉浸式填满剩余空白空间，联动数据筛选） */}
        <HistoryDetailsTable
          turns={filteredTurns}
          totalTurnsCount={allTurns.length}
          filterType={filterType}
          onFilterChange={handleFilterChange}
          selectedId={selected.id}
          pinnedId={pinnedId}
          onSelectTurn={(id) => setPinnedId(id || null)}
        />
      </div>
    </div>
  );
}
