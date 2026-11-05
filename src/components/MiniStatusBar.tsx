import { Moon, Sun, Thermometer, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APP_VERSION } from "../data";
import { useI18n } from "../i18n";
import { getAppVersion } from "../tauri";
import type { PerfItemId, PerfMonitorConfig, PerformanceStats, ServerStatus } from "../types";
import { cn } from "../utils";

/** 环形缓冲长度：2s 采样约覆盖 3 分钟，右对齐绘制让曲线从有数据处开始 */
const HISTORY_LEN = 90;

type Tone = "amber" | "teal";

const clampPct = (value: number) => Math.max(0, Math.min(100, value));
const usedGbText = (mb: number) => (mb / 1024).toFixed(1);
const totalGbText = (mb: number) => `${Math.round(mb / 1024)}G`;
const toneClass = (tone: Tone) => `ms-tone-${tone}`;

interface Metric {
  id: PerfItemId;
  short: string;
  tile: string;
  tone: Tone;
  value: string;
  unit?: string;
  title: string;
  series: number[];
}

interface SparkProps {
  values: number[];
  w: number;
  h: number;
  grid?: boolean;
}

/** 网格底纹 + 面积 + 折线迷你图；已有采样铺满整宽，preserveAspectRatio=none 拉伸，描边保持 1px */
function Spark({ values, w, h, grid = false }: SparkProps) {
  const pad = 2;
  let line = "";
  let area = "";
  if (values.length) {
    const ys = values.map((value) => h - pad - (clampPct(value) / 100) * (h - pad * 2));
    const points: Array<[number, number]> = ys.map((y, index) => [values.length === 1 ? 0 : (index / (values.length - 1)) * w, y]);
    // 只有一个采样时补到右边界，先画一条水平基线而不是空白
    if (values.length === 1) points.push([w, ys[0]]);
    line = `M${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" L")}`;
    area = `${line} L${w.toFixed(2)},${h} L0,${h} Z`;
  }
  return (
    <svg className="ms-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {area && <path className="area" d={area} />}
      {grid && (
        <g className="grid">
          {[1, 2, 3].map((i) => (
            <line key={`h${i}`} x1={0} y1={(h * i) / 4} x2={w} y2={(h * i) / 4} vectorEffect="non-scaling-stroke" />
          ))}
          {[1, 2, 3, 4, 5].map((i) => (
            <line key={`v${i}`} x1={(w * i) / 6} y1={0} x2={(w * i) / 6} y2={h} vectorEffect="non-scaling-stroke" />
          ))}
          <line className="edge" x1={0.5} y1={0.5} x2={w - 0.5} y2={0.5} vectorEffect="non-scaling-stroke" />
          <line className="edge" x1={0.5} y1={h - 0.5} x2={w - 0.5} y2={h - 0.5} vectorEffect="non-scaling-stroke" />
          <line className="edge" x1={0.5} y1={0.5} x2={0.5} y2={h - 0.5} vectorEffect="non-scaling-stroke" />
          <line className="edge" x1={w - 0.5} y1={0.5} x2={w - 0.5} y2={h - 0.5} vectorEffect="non-scaling-stroke" />
        </g>
      )}
      {line && <path className="line" d={line} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

interface MiniStatusBarProps {
  status: ServerStatus;
  /** 服务异常（启动失败 / 进程意外退出）→ 红灯 */
  abnormal: boolean;
  perfStats: PerformanceStats | null;
  /** DIY 配置：开关、顺序与每项展示样式 */
  perfConfig: PerfMonitorConfig;
  /** 当前主题与切换回调（左下角快捷切换） */
  theme: string;
  updateAvailable?: boolean;
  onToggleTheme: () => void;
}

/**
 * 左下角性能监测卡片：按 DIY 顺序渲染大图 / 中图 / 小图 / 文本，
 * 相邻的小图两两并排、落单时整行显示；功耗与温度固定为底栏文字，不参与配置。
 */
export default function MiniStatusBar({ status, abnormal, perfStats, perfConfig, theme, updateAvailable, onToggleTheme }: MiniStatusBarProps) {
  const { t } = useI18n();
  const running = status.running;
  const gpu = perfStats?.gpu ?? null;

  // ---- 版本号：Tauri 模式读 tauri.conf.json，浏览器回退到常量 ----
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  useEffect(() => { getAppVersion().then(setAppVersion); }, []);

  // ---- 曲线历史：每项指标保存最近 90 个百分比采样 ----
  const [series, setSeries] = useState<Record<PerfItemId, number[]>>(() => ({ gpu: [], cpu: [], vram: [], memory: [] }));
  const lastStatsRef = useRef<PerformanceStats | null>(null);
  useEffect(() => {
    if (!perfStats || perfStats === lastStatsRef.current) return;
    lastStatsRef.current = perfStats;
    const ng = perfStats.gpu;
    const samples: Array<[PerfItemId, number | null]> = [
      ["gpu", ng?.utilPercent ?? null],
      ["vram", ng?.memoryUsedMb != null && ng.memoryTotalMb ? (ng.memoryUsedMb / ng.memoryTotalMb) * 100 : null],
      ["cpu", perfStats.cpuPercent ?? null],
      ["memory", perfStats.memoryUsedMb != null && perfStats.memoryTotalMb ? (perfStats.memoryUsedMb / perfStats.memoryTotalMb) * 100 : null],
    ];
    setSeries((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, value] of samples) {
        if (value == null || !Number.isFinite(value)) continue;
        const arr = [...next[id], clampPct(value)];
        if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
        next[id] = arr;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [perfStats]);

  const vramPercent = gpu?.memoryUsedMb != null && gpu.memoryTotalMb ? clampPct((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100) : null;
  const memPercent = perfStats?.memoryUsedMb != null && perfStats.memoryTotalMb ? clampPct((perfStats.memoryUsedMb / perfStats.memoryTotalMb) * 100) : null;

  /** 按监测项构建可展示指标；数据不可用（如无 NVIDIA 驱动）时不渲染空壳 */
  const metricOf = (id: PerfItemId): Metric | null => {
    switch (id) {
      case "gpu": {
        if (gpu?.utilPercent == null) return null;
        const percent = clampPct(gpu.utilPercent);
        return { id, short: t("perf.shortGpu"), tile: t("perf.tileGpu"), tone: "amber", value: `${Math.round(percent)}`, unit: "%", title: t("tooltipCore"), series: series.gpu };
      }
      case "vram": {
        if (vramPercent == null || gpu?.memoryUsedMb == null || !gpu.memoryTotalMb) return null;
        return { id, short: t("perf.shortVram"), tile: t("perf.tileVram"), tone: "amber", value: usedGbText(gpu.memoryUsedMb), unit: `/${totalGbText(gpu.memoryTotalMb)}`, title: t("tooltipVram"), series: series.vram };
      }
      case "cpu": {
        if (perfStats?.cpuPercent == null) return null;
        const percent = clampPct(perfStats.cpuPercent);
        return { id, short: t("perf.shortCpu"), tile: t("perf.shortCpu"), tone: "teal", value: `${Math.round(percent)}`, unit: "%", title: t("tooltipCpu"), series: series.cpu };
      }
      case "memory": {
        if (memPercent == null || perfStats?.memoryUsedMb == null || !perfStats.memoryTotalMb) return null;
        return { id, short: t("perf.shortMemory"), tile: t("perf.shortMemory"), tone: "teal", value: usedGbText(perfStats.memoryUsedMb), unit: `/${totalGbText(perfStats.memoryTotalMb)}`, title: t("tooltipMemory"), series: series.memory };
      }
    }
  };

  const metrics = perfConfig.order
    .filter((id) => perfConfig.items[id])
    .map(metricOf)
    .filter((metric): metric is Metric => metric != null);

  // ---- 分块：大图 / 中图 / 文本各占一行，小图连续收集为双列网格 ----
  type Block = { kind: "large" | "medium" | "text"; metric: Metric } | { kind: "compact"; metrics: Metric[] };
  const blocks: Block[] = [];
  let compact: Metric[] = [];
  const flushCompact = () => {
    if (!compact.length) return;
    blocks.push({ kind: "compact", metrics: compact });
    compact = [];
  };
  for (const metric of metrics) {
    const style = perfConfig.styles[metric.id];
    if (style === "small") {
      compact.push(metric);
    } else {
      flushCompact();
      blocks.push({ kind: style, metric });
    }
  }
  flushCompact();

  const renderValue = (metric: Metric) => (
    <span className="ms-val">{metric.value}{metric.unit && <i className="ms-unit">{metric.unit}</i>}</span>
  );

  const renderTile = (metric: Metric) => (
    <div key={metric.id} className={cn("ms-tile", toneClass(metric.tone))} title={metric.title}>
      <div className="ms-tile-top">
        <span className="ms-tile-label"><i className="ms-dot" /><span className="ms-tile-name">{metric.tile}</span></span>
        <span className="ms-tile-val">{metric.value}{metric.unit && <i className="ms-unit">{metric.unit}</i>}</span>
      </div>
      <Spark values={metric.series} w={100} h={16} grid />
    </div>
  );

  const themeToggle = (
    <button className="ms-theme-toggle" title={theme === "dark" ? t("toast.lightTheme") : t("toast.darkTheme")} aria-label={theme === "dark" ? t("toast.lightTheme") : t("toast.darkTheme")} onClick={onToggleTheme}>
      {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  );

  const metaTail = (<>
    <span className="ms-version">v{appVersion}</span>
    {updateAvailable && <em className="ms-new-badge">NEW</em>}
    {themeToggle}
  </>);

  const health = <i className="ms-health" title={abnormal ? t("serviceAbnormal") : running ? t("statusRunning") : t("statusStopped")} aria-hidden="true" />;

  // 功耗 / 温度：底栏固定读数，可在设置中分别隐藏
  const powerWatts = gpu?.powerWatts ?? null;
  const temperatureC = gpu?.temperatureC ?? null;
  const showPower = perfConfig.env.power && powerWatts != null;
  const showTemp = perfConfig.env.temp && temperatureC != null;
  const env = showPower || showTemp ? (
    <span className="ms-env">
      {showPower && (
        <span className="ms-env-item" title={t("perf.itemPower")}>
          <Zap size={11} aria-hidden="true" />{Math.round(powerWatts ?? 0)}<i>W</i>
        </span>
      )}
      {showTemp && (
        <span className="ms-env-item" title={t("perf.itemTemp")}>
          <Thermometer size={11} aria-hidden="true" />{Math.round(temperatureC ?? 0)}<i>°C</i>
        </span>
      )}
    </span>
  ) : null;

  return (
    <div className={cn("mini-status", running && "running", abnormal && "abnormal")}>
      {metrics.length === 0 ? (
        <div className="ms-status-only">
          {health}
          <span className="ms-state-text">{running ? (abnormal ? t("serviceAbnormal") : t("serviceRunning")) : t("notStarted")}</span>
          <span className="ms-app-meta">{metaTail}</span>
        </div>
      ) : (<>
        <div className="ms-caption-row">
          <span className="ms-caption">{t("perfCaption")}</span>
          <span className="ms-cadence">2s</span>
        </div>
        {blocks.map((block, index) => {
          if (block.kind === "compact") {
            const rows: Metric[][] = [];
            for (let i = 0; i < block.metrics.length; i += 2) rows.push(block.metrics.slice(i, i + 2));
            return (
              <div key={`compact-${index}`} className="ms-compact">
                {rows.map((row, rowIndex) => (
                  <div key={rowIndex} className={"ms-compact-row" + (row.length === 1 ? " is-single" : "")}>{row.map(renderTile)}</div>
                ))}
              </div>
            );
          }
          const { metric } = block;
          if (block.kind === "large") {
            return (
              <div key={metric.id} className={cn("ms-large", toneClass(metric.tone))} title={metric.title}>
                <div className="ms-head">
                  <span className="ms-label"><i className="ms-dot" />{metric.short}</span>
                  {renderValue(metric)}
                </div>
                <Spark values={metric.series} w={100} h={26} grid />
              </div>
            );
          }
          if (block.kind === "medium") {
            return (
              <div key={metric.id} className={cn("ms-medium", toneClass(metric.tone))} title={metric.title}>
                <div className="ms-meta">
                  <span className="ms-label"><i className="ms-dot" />{metric.short}</span>
                  {renderValue(metric)}
                </div>
                <Spark values={metric.series} w={80} h={36} grid />
              </div>
            );
          }
          return (
            <div key={metric.id} className={cn("ms-text-row", toneClass(metric.tone))} title={metric.title}>
              <span className="ms-label"><i className="ms-dot" />{metric.short}</span>
              <span className="ms-text-val">{metric.value}{metric.unit && <i className="ms-unit">{metric.unit}</i>}</span>
            </div>
          );
        })}
        <div className="ms-bottom">
          {env}
          <span className="ms-app-meta">{health}{metaTail}</span>
        </div>
      </>)}
    </div>
  );
}
