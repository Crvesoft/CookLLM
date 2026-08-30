import { Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { GpuStats, ServerStatus, TokSample } from "../types";
import { cn } from "../utils";

const APP_VERSION = "0.1.0";
/** Token 速率采样在此窗口内视为"实时推理中"，过期回退 Idle（避免生成结束后仍显示旧速率） */
const TPS_FRESH_MS = 8000;
/** GPU 历史迷你图保留的采样数：90 × 2s 轮询 ≈ 3 分钟滚动窗口 */
const HISTORY_MAX = 90;
/** 占用率低于此值视为空闲（状态后缀）；高负载时隐藏 "Idle"，避免与百分比语义冲突 */
const IDLE_UTIL_MAX = 40;

interface GpuMonitorStripProps {
  gpuStats: GpuStats | null;
  tokSample: TokSample | null;
  /** llama-server 是否运行中（决定 Idle 状态后缀） */
  running: boolean;
}

/**
 * 高密度右锚定滚动迷你图（无轨道设计）：新样本从右缘推入、旧值左移；
 * 半透明填充 + 顶边实线。网格背景（横向四分线 × 纵向六列）始终渲染——没有数据时视图也不空荡；
 * 数据不足时在网格内从右侧生长（不跳动）。
 */
function Spark({ history, tone }: { history: number[]; tone: "mem" | "core" }) {
  const W = 100;
  const H = 72;
  const PAD = 4; // 上下留白，防止 0% / 100% 时线条贴边被裁
  const n = Math.min(history.length, HISTORY_MAX);
  const values = n ? history.slice(-n) : [];
  const m = values.length;

  // 网格：无条件渲染（含无数据时），避免视图空荡
  const grid = (
    <g className="ms-grid">
      {[1, 2, 3].map((i) => (<line key={`h${i}`} x1={0} y1={(H * i) / 4} x2={W} y2={(H * i) / 4} vectorEffect="non-scaling-stroke" />))}
      {[1, 2, 3, 4, 5].map((i) => (<line key={`v${i}`} x1={(W * i) / 6} y1={0} x2={(W * i) / 6} y2={H} vectorEffect="non-scaling-stroke" />))}
    </g>
  );

  if (m < 2) return <svg className={cn("ms-spark", tone)} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">{grid}</svg>;

  const coords: Array<[number, number]> = [];
  for (let j = 0; j < m; j++) {
    // 右锚定：最新样本固定在右缘，窗口未满时从右侧向左生长，满后整体左移滚动
    const slot = HISTORY_MAX - m + j;
    const x = (slot / (HISTORY_MAX - 1)) * W;
    const y = H - PAD - (Math.max(0, Math.min(100, values[j])) / 100) * (H - 2 * PAD);
    coords.push([x, y]);
  }
  const points = coords.map(([cx, cy]) => `${cx.toFixed(2)},${cy.toFixed(2)}`).join(" ");
  const [first] = coords;
  const last = coords[coords.length - 1];
  return (
    <svg className={cn("ms-spark", tone)} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {grid}
      <polygon points={`${points} ${last[0].toFixed(2)},${H} ${first[0].toFixed(2)},${H}`} />
      <polyline points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * 标题栏中间 GPU 性能监测横条（原左下角卡片的指标区）：章节标签「GPU性能监测」+ 两个指标视图并排，
 * 每格 = 左侧标题行 / 数值行纵排 + 右侧带网格迷你图；功耗与健康灯 / 版本号 / 设置仍留在左下角。
 */
export function GpuMonitorStrip({ gpuStats, tokSample, running }: GpuMonitorStripProps) {
  // 1s tick：驱动"速率过期 → Idle"的翻转（仅重渲染本横条，不波及整树）
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // ---- GPU 历史采样：每次轮询到达新读数即追加（仅前端保留，不落盘、不进 Rust）----
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const [coreHistory, setCoreHistory] = useState<number[]>([]);
  useEffect(() => {
    if (!gpuStats) return;
    const memPct = gpuStats.memoryUsedMb != null && gpuStats.memoryTotalMb ? (gpuStats.memoryUsedMb / gpuStats.memoryTotalMb!) * 100 : undefined;
    const corePct = typeof gpuStats.utilPercent === "number" ? Math.max(0, Math.min(100, gpuStats.utilPercent)) : undefined;
    if (memPct !== undefined) setMemHistory((previous) => [...previous.slice(-(HISTORY_MAX - 1)), memPct]);
    if (corePct !== undefined) setCoreHistory((previous) => [...previous.slice(-(HISTORY_MAX - 1)), corePct]);
  }, [gpuStats]);

  // ---- 硬件资源：显存（MiB → GB）与 GPU 核心负载 ----
  const totalMb = gpuStats?.memoryTotalMb ?? null;
  const usedMb = gpuStats?.memoryUsedMb ?? null;
  // 显存值 "14.9/16 GB"：紧凑格式适配窄视图、单位只出现一次
  const vramText = totalMb !== null && usedMb !== null ? `${(usedMb / 1024).toFixed(1)}/${Math.round(totalMb / 1024)} GB` : "--";

  // ---- 实时吞吐：采样新鲜则显示速率，否则按占用率决定是否标 Idle ----
  const liveRate = tokSample !== null && Date.now() - tokSample.at < TPS_FRESH_MS ? tokSample.rate : null;
  const utilPct = gpuStats?.utilPercent ?? null;
  const coreText = utilPct !== null ? `${Math.round(utilPct)}%` : "--";
  // 核心行状态后缀：推理中显示实时速率；仅运行且占用率低才标 Idle（高负载时隐藏，避免与百分比语义冲突）
  const coreState = liveRate !== null ? `${liveRate.toFixed(1)} t/s` : running && (utilPct ?? 0) < IDLE_UTIL_MAX ? "Idle" : null;

  return (
    <div className="gpu-monitor">
      <span className="gm-caption">GPU性能监测</span>
      <div className="gm-view" title="显存占用">
        <div className="gm-meta"><span className="ms-view-title">VRAM</span><span className="ms-val">{vramText}</span></div>
        <Spark history={memHistory} tone="mem" />
      </div>
      <div className={cn("gm-view", liveRate !== null && "live")} title="GPU 核心利用率">
        <div className="gm-meta"><span className="ms-view-title">3D(GPU)</span><span className="ms-val">{coreText}{coreState !== null && <em className="gm-state">{coreState}</em>}</span></div>
        <Spark history={coreHistory} tone="core" />
      </div>
    </div>
  );
}

interface MiniStatusBarProps {
  status: ServerStatus;
  /** 服务异常（启动失败 / 进程意外退出）→ 红灯 */
  abnormal: boolean;
  gpuStats: GpuStats | null;
  tokSample: TokSample | null;
}

/**
 * 左下角 GPU 性能监测 + 功耗合并卡片：GPU 指标区（VRAM / Core sparkline）在上，
 * 功耗行居中，健康灯 + 版本号沉底至其右端。
 */
export default function MiniStatusBar({ status, abnormal, gpuStats, tokSample }: MiniStatusBarProps) {
  const running = status.running;
  const powerText = gpuStats?.powerWatts != null ? `${Math.round(gpuStats.powerWatts)} W` : "--";

  // ---- GPU 历史采样：每次轮询到达新读数即追加（仅前端保留，不落盘、不进 Rust）----
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const [coreHistory, setCoreHistory] = useState<number[]>([]);
  useEffect(() => {
    if (!gpuStats) return;
    const memPct = gpuStats.memoryUsedMb != null && gpuStats.memoryTotalMb ? (gpuStats.memoryUsedMb / gpuStats.memoryTotalMb!) * 100 : undefined;
    const corePct = typeof gpuStats.utilPercent === "number" ? Math.max(0, Math.min(100, gpuStats.utilPercent)) : undefined;
    if (memPct !== undefined) setMemHistory((previous) => [...previous.slice(-(HISTORY_MAX - 1)), memPct]);
    if (corePct !== undefined) setCoreHistory((previous) => [...previous.slice(-(HISTORY_MAX - 1)), corePct]);
  }, [gpuStats]);

  // ---- 硬件资源：显存（MiB → GB）与 GPU 核心负载 ----
  const totalMb = gpuStats?.memoryTotalMb ?? null;
  const usedMb = gpuStats?.memoryUsedMb ?? null;
  const vramText = totalMb !== null && usedMb !== null ? `${(usedMb / 1024).toFixed(1)}/${Math.round(totalMb / 1024)} GB` : "--";

  // ---- 实时吞吐：采样新鲜则显示速率，否则按占用率决定是否标 Idle ----
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const liveRate = tokSample !== null && Date.now() - tokSample.at < TPS_FRESH_MS ? tokSample.rate : null;
  const utilPct = gpuStats?.utilPercent ?? null;
  const coreText = utilPct !== null ? `${Math.round(utilPct)}%` : "--";
  const coreState = liveRate !== null ? `${liveRate.toFixed(1)} t/s` : running && (utilPct ?? 0) < IDLE_UTIL_MAX ? "Idle" : null;

  return (
    <div className={cn("mini-status", running && "running", abnormal && "abnormal")}>
      {/* GPU 性能监测区 */}
      <span className="ms-caption">GPU性能监测</span>
      <div className="gm-view" title="显存占用">
        <div className="gm-meta"><span className="ms-view-title">VRAM</span><span className="ms-val">{vramText}</span></div>
        <Spark history={memHistory} tone="mem" />
      </div>
      <div className={cn("gm-view", liveRate !== null && "live")} title="GPU 核心利用率">
        <div className="gm-meta"><span className="ms-view-title">3D(GPU)</span><span className="ms-val">{coreText}{coreState !== null && <em className="gm-state">{coreState}</em>}</span></div>
        <Spark history={coreHistory} tone="core" />
      </div>
      {/* 功耗行 */}
      <div className="ms-power"><Zap size={11} aria-hidden="true" /><span>功耗</span><b>{powerText}</b><span className="ms-app-meta"><i className="ms-health" title={abnormal ? "服务异常" : running ? "运行中" : "未运行"} aria-hidden="true" /><span className="ms-version">v{APP_VERSION}</span></span></div>
    </div>
  );
}
