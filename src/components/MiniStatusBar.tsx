import { Moon, Sun, Zap } from "lucide-react";
import { useI18n } from "../i18n";
import { useEffect, useState } from "react";
import { APP_VERSION } from "../data";
import { getAppVersion } from "../tauri";
import type { GpuStats, ServerStatus } from "../types";
import { cn } from "../utils";
/** GPU 历史迷你图保留的采样数：90 × 2s 轮询 ≈ 3 分钟滚动窗口 */
const HISTORY_MAX = 90;
const SPARK_W = 80;
const SPARK_H = 36;
const SPARK_PAD = 2;

/**
 * 高密度右锚定滚动迷你图：新样本从右缘推入、旧值左移；
 * 网格（横向四分线 × 纵向六列 + 外框）始终渲染——没有数据时视图也不空荡，
 * 数据不足时在网格内从右侧生长（不跳动）。
 */
function Spark({ history }: { history: number[] }) {
  const values = history.slice(-HISTORY_MAX);
  const m = values.length;

  const grid = (
    <g className="ms-grid">
      {[1, 2, 3].map((i) => (<line key={`h${i}`} x1={0} y1={(SPARK_H * i) / 4} x2={SPARK_W} y2={(SPARK_H * i) / 4} vectorEffect="non-scaling-stroke" />))}
      {[1, 2, 3, 4, 5].map((i) => (<line key={`v${i}`} x1={(SPARK_W * i) / 6} y1={0} x2={(SPARK_W * i) / 6} y2={SPARK_H} vectorEffect="non-scaling-stroke" />))}
      <line className="edge" x1={0.5} y1={0.5} x2={SPARK_W - 0.5} y2={0.5} vectorEffect="non-scaling-stroke" />
      <line className="edge" x1={0.5} y1={SPARK_H - 0.5} x2={SPARK_W - 0.5} y2={SPARK_H - 0.5} vectorEffect="non-scaling-stroke" />
      <line className="edge" x1={0.5} y1={0.5} x2={0.5} y2={SPARK_H - 0.5} vectorEffect="non-scaling-stroke" />
      <line className="edge" x1={SPARK_W - 0.5} y1={0.5} x2={SPARK_W - 0.5} y2={SPARK_H - 0.5} vectorEffect="non-scaling-stroke" />
    </g>
  );

  if (m < 2) return <svg className="ms-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">{grid}</svg>;

  const coords: Array<[number, number]> = values.map((value, index) => {
    // 右锚定：最新样本固定在右缘，窗口未满时从右侧向左生长，满后整体左移滚动
    const slot = HISTORY_MAX - m + index;
    const x = (slot / (HISTORY_MAX - 1)) * SPARK_W;
    const y = SPARK_H - SPARK_PAD - (Math.max(0, Math.min(100, value)) / 100) * (SPARK_H - 2 * SPARK_PAD);
    return [x, y];
  });
  const linePath = coords.map(([cx, cy], index) => `${index === 0 ? "M" : "L"}${cx.toFixed(2)},${cy.toFixed(2)}`).join(" ");
  const [firstX] = coords[0];
  const [lastX] = coords[coords.length - 1];
  const areaPath = `${linePath} L${lastX.toFixed(2)},${SPARK_H} L${firstX.toFixed(2)},${SPARK_H} Z`;
  return (
    <svg className="ms-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="ms-area" d={areaPath} />
      {grid}
      <polyline points={coords.map(([cx, cy]) => `${cx.toFixed(2)},${cy.toFixed(2)}`).join(" ")} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface MiniStatusBarProps {
  status: ServerStatus;
  /** 服务异常（启动失败 / 进程意外退出）→ 红灯 */
  abnormal: boolean;
  gpuStats: GpuStats | null;
  /** 当前主题与切换回调（左下角快捷切换） */
  theme: string;
  updateAvailable?: boolean;
  onToggleTheme: () => void;
}

/**
 * 左下角 GPU 性能监测 + 功耗合并卡片：单面板仪表，指标数值在左、紧凑网格迷你图在右，
 * 底栏归组功耗、健康灯、版本号与主题切换。
 */
export default function MiniStatusBar({ status, abnormal, gpuStats, theme, updateAvailable, onToggleTheme }: MiniStatusBarProps) {
  const { t } = useI18n();
  const running = status.running;
  // no GPU data (AMD / Intel / no dGPU): hide the monitoring section entirely
  const hasGpu = gpuStats != null;
  const powerText = gpuStats?.powerWatts != null ? `${Math.round(gpuStats.powerWatts)} W` : "--";

  // ---- 版本号：Tauri 模式读 tauri.conf.json，浏览器回退到常量 ----
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  useEffect(() => { getAppVersion().then(setAppVersion); }, []);

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
  const usedGbText = usedMb !== null ? (usedMb / 1024).toFixed(1) : "--";
  const totalGbText = totalMb !== null ? `/ ${Math.round(totalMb / 1024)} GB` : "";
  const utilPct = gpuStats?.utilPercent ?? null;
  const utilText = utilPct !== null ? `${Math.round(utilPct)}` : "--";

  const themeToggle = (
    <button className="ms-theme-toggle" title={theme === "dark" ? t("toast.lightTheme") : t("toast.darkTheme")} aria-label={theme === "dark" ? t("toast.lightTheme") : t("toast.darkTheme")} onClick={onToggleTheme}>
      {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );

  return (
    <div className={cn("mini-status", running && "running", abnormal && "abnormal")}>
      {hasGpu ? (<>
      <span className="ms-caption">{t("gpuCaption")}</span>
      <div className="ms-metric" title={t("tooltipVram")}>
        <div className="ms-meta">
          <span className="ms-view-title">VRAM</span>
          <span className="ms-val"><b>{usedGbText}</b>{totalGbText && <span className="ms-unit">{totalGbText}</span>}</span>
        </div>
        <Spark history={memHistory} />
      </div>
      <div className="ms-metric" title={t("tooltipCore")}>
        <div className="ms-meta">
          <span className="ms-view-title">3D (GPU)</span>
          <span className="ms-val"><b>{utilText}</b>{utilPct !== null && <span className="ms-unit">%</span>}</span>
        </div>
        <Spark history={coreHistory} />
      </div>
      <div className="ms-power" title={t("powerLabel")}><Zap size={11} aria-hidden="true" /><b>{powerText}</b><span className="ms-app-meta"><i className="ms-health" title={abnormal ? t("serviceAbnormal") : running ? t("statusRunning") : t("statusStopped")} aria-hidden="true" /><span className="ms-version">v{appVersion}</span>{updateAvailable && <em className="ms-new-badge">NEW</em>}{themeToggle}</span></div>
        </>
      ) : (
        <div className="ms-power ms-power-only"><i className="ms-health" title={abnormal ? t("serviceAbnormal") : running ? t("statusRunning") : t("statusStopped")} aria-hidden="true" /><span className="ms-state-text">{running ? (abnormal ? t("serviceAbnormal") : t("serviceRunning")) : t("notStarted")}</span><span className="ms-app-meta"><span className="ms-version">v{appVersion}</span>{updateAvailable && <em className="ms-new-badge">NEW</em>}{themeToggle}</span></div>
      )}
    </div>
  );
}
