import { useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Activity } from "lucide-react";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import type { InferenceMetrics, RealtimeTpsSample } from "../types";
import { cn } from "../utils";
import { pointsToSmoothPath, useElementSize } from "./inferenceChartUtils";

const WINDOW_MS = 60_000;
const TURN_MAX = 12;

type RealtimeKind = "decode" | "prefill";

const KIND_STYLE: Record<RealtimeKind, { color: string; titleKey: MessageKey; gradId: string }> = {
  decode: { color: "#ff8c42", titleKey: "perf.realtimeDecode", gradId: "rtDecodeArea" },
  prefill: { color: "#38bdf8", titleKey: "perf.realtimePrefill", gradId: "rtPrefillArea" },
};

export interface RealtimeTurn {
  item: InferenceMetrics;
  live: boolean;
  order: number;
}

type TurnKind = "ttft" | "mtp";

interface TurnValueText {
  now: string;
  unit: string;
  text: string;
}

/** 毫秒延迟自适应单位：亚秒保留整数 ms，秒级保留 2 位小数 */
function formatLatency(ms: number): TurnValueText {
  if (ms < 1000) {
    const text = `${Math.round(ms)} ms`;
    return { now: String(Math.round(ms)), unit: " ms", text };
  }
  const sec = ms / 1000;
  const now = sec >= 10 ? sec.toFixed(1) : sec.toFixed(2);
  return { now, unit: " s", text: `${now} s` };
}

function formatPercent(value: number): TurnValueText {
  const now = value.toFixed(1);
  return { now, unit: " %", text: `${now}%` };
}

const TURN_STYLE: Record<
  TurnKind,
  {
    titleKey: MessageKey;
    hintKey: MessageKey;
    emptyKey: MessageKey;
    color: string;
    gradId: string;
    /** Y 轴自适应下限，避免全等低值时曲线贴顶 */
    minMax: number;
    /** Y 轴上限（接受率固定 100%） */
    maxCap?: number;
    pick: (item: InferenceMetrics) => number | null;
    format: (value: number) => TurnValueText;
  }
> = {
  ttft: {
    titleKey: "perf.realtimeTtft",
    hintKey: "perf.ttftHint",
    emptyKey: "perf.ttftWaiting",
    color: "#a78bfa",
    gradId: "rtTtftArea",
    minMax: 50,
    pick: (item) => (item.ttftMs != null && item.ttftMs > 0 ? item.ttftMs : null),
    format: formatLatency,
  },
  mtp: {
    titleKey: "perf.realtimeMtp",
    hintKey: "perf.mtpHint",
    emptyKey: "perf.mtpWaiting",
    color: "#f472b6",
    gradId: "rtMtpArea",
    minMax: 10,
    maxCap: 100,
    pick: (item) =>
      item.mtpAcceptRatio != null && Number.isFinite(item.mtpAcceptRatio) && item.mtpDraftTokens
        ? Math.max(0, Math.min(100, item.mtpAcceptRatio))
        : null,
    format: formatPercent,
  },
};

/** 分析页实时区：Decode / Prefill 逐秒；TTFT 与 MTP 草稿接受率按轮次（MTP 未开启时自动隐藏） */
export function RealtimeThroughputRow({
  samples,
  running,
  turns,
  mtpEnabled,
}: {
  samples: RealtimeTpsSample[];
  running?: boolean;
  turns?: RealtimeTurn[];
  mtpEnabled?: boolean;
}) {
  const turnList = turns || [];
  // MTP 卡片：运行配置开启 MTP，或历史轮次已带接受率数据时展示；否则整列隐藏
  const showMtp = Boolean(mtpEnabled) || turnList.some((turn) => turn.item.mtpAcceptRatio != null);
  return (
    <div className={cn("inf-realtime-row", !showMtp && "cols-3")}>
      <RealtimeThroughputCard kind="decode" samples={samples} running={running} />
      <RealtimeThroughputCard kind="prefill" samples={samples} running={running} />
      <RealtimeTurnCard kind="ttft" turns={turnList} running={running} />
      {showMtp && <RealtimeTurnCard kind="mtp" turns={turnList} running={running} />}
    </div>
  );
}

function CardHead({ title, windowText, live, showState }: { title: string; windowText: string; live: boolean; showState: boolean }) {
  return (
    <div className="inf-realtime-head">
      <span className="inf-realtime-title">
        <Activity size={12} />
        <i className="rt-dot" aria-hidden="true" />
        {title}
      </span>
      <span className="inf-realtime-head-right">
        <span className="inf-realtime-window">{windowText}</span>
        {showState && (
          <span className={cn("inf-realtime-state", live && "live")}>
            <i aria-hidden="true" />
            {live ? "LIVE" : "IDLE"}
          </span>
        )}
      </span>
    </div>
  );
}

function RealtimeThroughputCard({ kind, samples, running }: { kind: RealtimeKind; samples: RealtimeTpsSample[]; running?: boolean }) {
  const { t } = useI18n();
  const style = KIND_STYLE[kind];
  const [bodyRef, size] = useElementSize<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const data = useMemo(() => {
    const pick = (sample: RealtimeTpsSample) => (kind === "decode" ? sample.decodeTps : sample.prefillTps);
    const end = samples.length ? samples[samples.length - 1].t : Date.now();
    const start = end - WINDOW_MS;
    const visible = samples.filter((sample) => sample.t >= start);
    const values = visible.map(pick);
    const peak = values.length ? Math.max(...values) : 0;
    const measured = values.filter((value) => value > 0);
    const avg = measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : 0;
    // 最近一次爆发只在当前 60s 窗口内回显，避免曲线已空却还显示窗口外的旧值
    let lastBurst: { value: number; t: number } | null = null;
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const value = pick(visible[index]);
      if (value > 0) {
        lastBurst = { value, t: visible[index].t };
        break;
      }
    }
    return {
      start,
      end,
      visible,
      values,
      peak,
      avg,
      current: values.length ? values[values.length - 1] : 0,
      lastBurst,
      chartMax: Math.max(10, peak * 1.15),
    };
  }, [kind, samples]);

  const W = Math.max(80, size.width);
  const H = Math.max(36, size.height);
  const PAD_T = 6;
  const PAD_B = 12;
  const PAD_X = 8;
  const innerW = Math.max(10, W - PAD_X * 2);
  const innerH = Math.max(10, H - PAD_T - PAD_B);
  const baselineY = PAD_T + innerH;

  const chart = useMemo(() => {
    const points = data.visible.map((sample, index) => {
      const value = data.values[index];
      return {
        x: PAD_X + ((sample.t - data.start) / WINDOW_MS) * innerW,
        y: PAD_T + innerH - (Math.min(data.chartMax, value) / data.chartMax) * innerH,
        value,
        t: sample.t,
      };
    });
    if (data.peak <= 0 || points.length === 0) return { points, lineD: "", areaD: "" };
    if (points.length === 1) return { points, lineD: "", areaD: "" };
    const smooth = pointsToSmoothPath(points.map((point) => [point.x, point.y] as [number, number]), baselineY, PAD_T);
    return { points, ...smooth };
  }, [baselineY, data, innerH, innerW]);

  const hovered = hoverIdx != null ? chart.points[hoverIdx] : null;
  const liveNow = data.current > 0;
  // Prefill 只在请求开始时突发，当前秒为 0 时回显最近一次突发的速率，避免卡片看起来「没有值」
  const staleBurst = !hovered && kind === "prefill" && !liveNow ? data.lastBurst : null;
  const staleAge = staleBurst ? Math.max(0, Math.round((data.end - staleBurst.t) / 1000)) : 0;
  const displayValue = hovered ? hovered.value : staleBurst ? staleBurst.value : data.current;
  const hasPeak = data.peak > 0;
  const emptyText = running ? t("perf.realtimeWaiting") : t("perf.realtimeStopped");
  // Prefill 为 0 但 Decode 仍在运行时，说明请求正在进行、只是本窗口无 Prefill，不能显示「等待推理请求」
  const decodeActive = samples.length > 0 && samples[samples.length - 1].decodeTps > 0;
  const idleText = kind === "prefill" && decodeActive ? t("perf.realtimeNoPrefill") : emptyText;
  const subText = staleBurst
    ? `${t("perf.peakShort")} ${Math.max(data.peak, staleBurst.value).toFixed(1)} · ${t("perf.ago", { n: staleAge })}`
    : hasPeak
      ? `${t("perf.peakShort")} ${data.peak.toFixed(1)} · ${t("perf.avgShort")} ${data.avg.toFixed(1)}`
      : "";

  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!chart.points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const targetT = data.start + ratio * WINDOW_MS;
    let best = 0;
    let bestDelta = Infinity;
    chart.points.forEach((point, index) => {
      const delta = Math.abs(point.t - targetT);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    });
    setHoverIdx(best);
  };

  const gridLines = useMemo(
    () =>
      [PAD_T, PAD_T + innerH / 2, baselineY].map((y, index) => (
        <line key={index} x1={PAD_X} y1={y} x2={PAD_X + innerW} y2={y} />
      )),
    [PAD_T, baselineY, innerH, innerW]
  );

  return (
    <div className={cn("inf-page-card", "inf-realtime-card", kind)}>
      <CardHead title={t(style.titleKey)} windowText={t("perf.realtimeWindow")} live={liveNow} showState={Boolean(running)} />

      <div className="inf-realtime-metric">
        <b className={cn("inf-realtime-now", staleBurst && "stale")} title={t("perf.realtimeHint")}>
          {data.visible.length ? displayValue.toFixed(1) : "—"}
          <small> tok/s</small>
        </b>
        <span className="inf-realtime-sub" title={subText}>
          {subText}
        </span>
      </div>

      <div
        className="inf-realtime-chart"
        ref={bodyRef}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="inf-realtime-svg" aria-hidden="true">
          <defs>
            <linearGradient id={style.gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={style.color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={style.color} stopOpacity="0.015" />
            </linearGradient>
          </defs>
          <g className="rt-grid">{gridLines}</g>
          {hasPeak && chart.areaD && <path d={chart.areaD} fill={`url(#${style.gradId})`} />}
          {hasPeak && chart.lineD && (
            <path
              d={chart.lineD}
              fill="none"
              stroke={style.color}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hasPeak && chart.points.length === 1 && (
            <circle cx={chart.points[0].x} cy={chart.points[0].y} r="2.4" fill={style.color} />
          )}
          {hovered && (
            <>
              <line
                x1={hovered.x}
                y1={PAD_T}
                x2={hovered.x}
                y2={baselineY}
                stroke={style.color}
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.5"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={hovered.x} cy={hovered.y} r="3" fill={style.color} vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>
        {!hasPeak && !staleBurst && <div className="inf-realtime-empty">{idleText}</div>}
        {hovered && (
          <div className="inf-realtime-tip" style={{ left: `${Math.min(92, Math.max(8, (hovered.x / W) * 100))}%` }}>
            {hovered.value.toFixed(1)} tok/s · -{Math.max(0, Math.round((data.end - hovered.t) / 1000))}s
          </div>
        )}
        <div className="inf-realtime-axis">
          <span>60s</span>
          <span>{t("perf.now")}</span>
        </div>
      </div>
    </div>
  );
}

/** 按轮次统计的窄卡片：TTFT 首字延迟 / MTP 草稿接受率 */
function RealtimeTurnCard({ kind, turns, running }: { kind: TurnKind; turns: RealtimeTurn[]; running?: boolean }) {
  const { t } = useI18n();
  const style = TURN_STYLE[kind];
  const [bodyRef, size] = useElementSize<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const data = useMemo(() => {
    const visible = turns
      .map((turn) => ({ turn, value: style.pick(turn.item) }))
      .filter((entry): entry is { turn: RealtimeTurn; value: number } => entry.value != null)
      .slice(0, TURN_MAX)
      .reverse();
    const values = visible.map((entry) => entry.value);
    const peak = values.length ? Math.max(...values) : 0;
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const chartMax = Math.min(style.maxCap ?? Infinity, Math.max(style.minMax, peak * 1.15));
    return {
      visible,
      values,
      peak,
      avg,
      latest: values.length ? values[values.length - 1] : 0,
      chartMax,
    };
  }, [style, turns]);

  const W = Math.max(80, size.width);
  const H = Math.max(36, size.height);
  const PAD_T = 6;
  const PAD_B = 12;
  const PAD_X = 8;
  const innerW = Math.max(10, W - PAD_X * 2);
  const innerH = Math.max(10, H - PAD_T - PAD_B);
  const baselineY = PAD_T + innerH;

  const chart = useMemo(() => {
    const count = data.visible.length;
    // 轮次不足上限时把点位均匀铺满整行，避免历史曲线全部挤在右侧
    const xAt = (index: number) => (count <= 1 ? PAD_X + innerW / 2 : PAD_X + (index / (count - 1)) * innerW);
    const points = data.visible.map((entry, index) => ({
      x: xAt(index),
      y: PAD_T + innerH - (Math.min(data.chartMax, entry.value) / data.chartMax) * innerH,
      value: entry.value,
      turn: entry.turn,
    }));
    if (points.length < 2) return { points, lineD: "", areaD: "" };
    const smooth = pointsToSmoothPath(points.map((point) => [point.x, point.y] as [number, number]), baselineY, PAD_T);
    return { points, ...smooth };
  }, [baselineY, data, innerH, innerW]);

  const hasData = data.visible.length > 0;
  const latestTurn = hasData ? data.visible[data.visible.length - 1].turn : null;
  const hovered = hoverIdx != null ? chart.points[hoverIdx] : null;
  const latestText = style.format(data.latest);
  const subText = hasData
    ? `${t("perf.peakShort")} ${style.format(data.peak).text} · ${t("perf.avgShort")} ${style.format(data.avg).text}`
    : "";
  const emptyText = running ? t(style.emptyKey) : t("perf.realtimeStopped");
  const firstOrder = data.visible[0]?.turn.order;
  const lastOrder = latestTurn?.order;

  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!chart.points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const target = PAD_X + ratio * innerW;
    let best = 0;
    let bestDelta = Infinity;
    chart.points.forEach((point, index) => {
      const delta = Math.abs(point.x - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    });
    setHoverIdx(best);
  };

  return (
    <div className={cn("inf-page-card", "inf-realtime-card", kind)}>
      {/* 按轮次归档的指标没有逐秒 LIVE/IDLE 语义，右上角只显示当前绘制的轮数 */}
      <CardHead
        title={t(style.titleKey)}
        windowText={hasData ? t("perf.turnWindow", { n: data.visible.length }) : ""}
        live={false}
        showState={false}
      />

      <div className="inf-realtime-metric">
        <b className="inf-realtime-now" title={t(style.hintKey)}>
          {hasData ? latestText.now : "—"}
          {hasData && <small>{latestText.unit}</small>}
        </b>
        <span className="inf-realtime-sub" title={subText}>
          {subText}
        </span>
      </div>

      <div
        className="inf-realtime-chart"
        ref={bodyRef}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="inf-realtime-svg" aria-hidden="true">
          <defs>
            <linearGradient id={style.gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={style.color} stopOpacity="0.2" />
              <stop offset="100%" stopColor={style.color} stopOpacity="0.015" />
            </linearGradient>
          </defs>
          <g className="rt-grid">
            {[PAD_T, PAD_T + innerH / 2, baselineY].map((y, index) => (
              <line key={index} x1={PAD_X} y1={y} x2={PAD_X + innerW} y2={y} />
            ))}
          </g>
          {hasData && chart.areaD && <path d={chart.areaD} fill={`url(#${style.gradId})`} />}
          {hasData && chart.lineD && (
            <path
              d={chart.lineD}
              fill="none"
              stroke={style.color}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hasData && chart.points.map((point) => (
            <circle key={point.turn.item.id} cx={point.x} cy={point.y} r="2" fill={style.color} opacity="0.85" />
          ))}
          {hovered && (
            <>
              <line
                x1={hovered.x}
                y1={PAD_T}
                x2={hovered.x}
                y2={baselineY}
                stroke={style.color}
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.5"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={hovered.x} cy={hovered.y} r="3" fill={style.color} vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>
        {!hasData && <div className="inf-realtime-empty">{emptyText}</div>}
        {hovered && (
          <div className="inf-realtime-tip" style={{ left: `${Math.min(92, Math.max(8, (hovered.x / W) * 100))}%` }}>
            {t("perf.turnIndex", { index: hovered.turn.order })} · {style.format(hovered.value).text}
          </div>
        )}
        <div className="inf-realtime-axis">
          <span>{firstOrder != null ? t("perf.turnIndex", { index: firstOrder }) : ""}</span>
          <span>{firstOrder != null && lastOrder !== firstOrder ? t("perf.turnIndex", { index: lastOrder as number }) : ""}</span>
        </div>
      </div>
    </div>
  );
}
