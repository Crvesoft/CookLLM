import { AlertCircle, Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Database, Download, ExternalLink, FolderOpen, Globe, Loader2, PauseCircle, PlayCircle, RefreshCw, Search, SlidersHorizontal, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { hfListFiles, hfSearch, hfTrending, openExternal } from "../tauri";
import type { AppConfig, DiskUsage, HfFile, HfModel, ModelDownloadProgress } from "../types";
import { cn, formatBytes, fileName } from "../utils";

export interface ActiveDownload {
  /** 关联仓库（直链下载为 "direct-url"） */
  repo: string;
  file: string;
  sizeBytes: number;
  startedAt: number;
  status: "active" | "done" | "error" | "cancelled";
  percent?: number;
  downloaded?: number;
  total?: number;
  speedBps?: number;
  /** 完成 / 失败时的本地完整路径 */
  path?: string;
  /** 失败时的错误信息 */
  error?: string;
  /** 完成时间戳 */
  finishedAt?: number;
  /** 直链任务保留原始 URL（恢复 / 重试时重新发起） */
  url?: string;
}

interface Props {
  visible: boolean;
  config: AppConfig;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
  onToast: (message: string) => void;
  onLog: (line: string, stream?: "stdout" | "stderr" | "system") => void;
  diskUsage: DiskUsage | null;
  onPickModelsDir: () => Promise<void>;
  onDownload: (repo: string, file: string, sizeBytes: number) => void;
  activeDownloads: ActiveDownload[];
  progressMap: Record<string, ModelDownloadProgress>;
  onPauseAll: () => void;
  onResumeFailed: () => void;
  onClearDone: () => void;
  onCancelTask: (task: ActiveDownload, deleteCache?: boolean) => void;
  onRetry: (task: ActiveDownload) => void;
  onReveal: (path: string) => Promise<void>;
  onGoModels: () => void;
}

/* ---------------- 刻面筛选定义 ---------------- */

type FamilyKey = "all" | "qwen" | "llama" | "deepseek" | "glm" | "gemma" | "mistral" | "code";
type QuantKey = "all" | "q1" | "q2" | "q3" | "q4" | "q5" | "q6" | "q8" | "q16";
type TaskKey = "chat" | "code" | "vision" | "reasoning";

const FAMILIES: Array<{ key: FamilyKey; label: string; needles: string[] }> = [
  { key: "all", label: "explore.filterAll", needles: [] },
  { key: "qwen", label: "Qwen", needles: ["qwen"] },
  { key: "llama", label: "Llama", needles: ["llama"] },
  { key: "deepseek", label: "DeepSeek", needles: ["deepseek"] },
  { key: "glm", label: "GLM", needles: ["glm"] },
  { key: "gemma", label: "Gemma", needles: ["gemma"] },
  { key: "mistral", label: "Mistral", needles: ["mistral", "mixtral", "codestral"] },
  { key: "code", label: "explore.facetFamilyCode", needles: ["code", "coder", "starcoder"] },
];

const TASKS: Array<{ key: TaskKey; label: string; needles: string[] }> = [
  { key: "chat", label: "explore.facetTaskChat", needles: ["chat", "conversation", "text-generation", "instruct", "general", "alpaca"] },
  { key: "code", label: "explore.facetTaskCode", needles: ["code", "coder", "coding", "starcoder"] },
  { key: "vision", label: "explore.facetTaskVision", needles: ["vision", "multimodal", "vl", "mmproj", "image", "audio"] },
  { key: "reasoning", label: "explore.facetTaskReasoning", needles: ["reasoning", "r1", "cot", "think", "deepseek-r1"] },
];

const QUANTS: Array<{ key: QuantKey; label: string; bits: number[]; cls: string }> = [
  { key: "q1", label: "explore.quantBit1", bits: [1], cls: "quant-1" },
  { key: "q2", label: "explore.quantBit2", bits: [2], cls: "quant-2" },
  { key: "q3", label: "explore.quantBit3", bits: [3], cls: "quant-3" },
  { key: "q4", label: "explore.quantBit4", bits: [4], cls: "quant-4" },
  { key: "q5", label: "explore.quantBit5", bits: [5], cls: "quant-5" },
  { key: "q6", label: "explore.quantBit6", bits: [6], cls: "quant-6" },
  { key: "q8", label: "explore.quantBit8", bits: [8], cls: "quant-8" },
  { key: "q16", label: "explore.quantBit16", bits: [16], cls: "quant-16" },
];

/** 参数规模刻度：索引即档位，范围 [PARAM_EDGES[min], PARAM_EDGES[max+1]) */
const PARAM_EDGES = [0, 3, 7, 14, 32, 70, Infinity];
const PARAM_SLIDER_LABELS = ["<1B", "3B", "7B", "14B", "32B", ">70B"];
const PARAM_LAST_INDEX = PARAM_SLIDER_LABELS.length - 1;

/** 模型量化比特位：优先 Rust 解析字段，其次从推荐量化文件名提取 */
function modelQuantBits(model: HfModel): number | null {
  if (model.quantBits != null && model.quantBits > 0) return model.quantBits;
  if (model.sampleQuant) {
    const match = model.sampleQuant.toUpperCase().match(/IQ?(\d)/);
    if (match) return Number(match[1]);
  }
  return null;
}

/** 模型参数量展示文案（如 0.5B / 7B / 14B / 70B） */
function paramLabel(model: HfModel): string {
  const value = model.parametersB;
  if (!value || value <= 0) return "";
  if (value >= 100) return Math.round(value) + "B";
  if (Number.isInteger(value) || value >= 10) return Math.round(value) + "B";
  return value.toFixed(1).replace(/\.0$/, "") + "B";
}

/** 模型量化展示文案（如 Q4 / IQ3 / Q8），优先短标签 */
function quantLabel(model: HfModel): string {
  if (model.quantBits != null && model.quantBits > 0) return "Q" + model.quantBits;
  if (model.sampleQuant) {
    const match = model.sampleQuant.toUpperCase().match(/IQ?\d+/);
    if (match) return match[0];
  }
  return "";
}

/** 从模型标签 / 推荐量化中收集仓库包含的量化规格（如 ["Q2","Q4","Q8"]） */
function quantSpecsOf(model: HfModel): string[] {
  const seen = new Set<string>();
  const add = (text: string) => {
    for (const tok of text.toUpperCase().match(/IQ?\d+/g) ?? []) {
      const digits = tok.match(/(\d+)/)?.[1];
      if (digits) seen.add("Q" + digits);
    }
  };
  add(model.sampleQuant ?? "");
  for (const tag of model.tags) add(tag);
  return [...seen].slice(0, 3);
}

/** 从 GGUF 文件名提取量化比特位（Q4_K_M → 4、IQ3_M → 3、FP16/BF16 → 16） */
function quantBitsOfFile(name: string): number | null {
  const upper = name.toUpperCase();
  if (/F(?:P)?16|BF16|FP32|F32/.test(upper)) return 16;
  const match = upper.match(/IQ?(\d)/);
  return match ? Number(match[1]) : null;
}

const SORT_KEYS = ["downloads", "likes", "updated", "hot"] as const;
const HF_SORT: Record<SortKey, string> = {
  downloads: "downloads",
  likes: "likes",
  updated: "lastModified",
  hot: "trendingScore",
};
type SortKey = (typeof SORT_KEYS)[number];

export function humanSpeed(speedBps: number): string {
  if (speedBps <= 0) return "";
  if (speedBps >= 1024 * 1024) return (speedBps / 1024 / 1024).toFixed(1) + " MB/s";
  return Math.round(speedBps / 1024) + " KB/s";
}

/** 从文件名提取量化标签（如 Q4_K_M / IQ3_M / Q8_0） */
function quantBadge(name: string): string {
  const match = name.match(/[IQ]?\d(?:_[A-Z0-9]+)+/i);
  return match ? match[0].toUpperCase() : "";
}

/** 根据文件大小给出行内显存/运行建议标签 */
function vramTag(file: HfFile, t: (key: import("../i18n").MessageKey, vars?: Record<string, string | number>) => string): string | null {
  const gb = file.sizeBytes / 1024 / 1024 / 1024;
  if (!file.sizeBytes) return null;
  if (gb >= 24) return t("explore.vramShare");
  if (gb >= 8) return t("explore.vramFit", { vram: "16G" });
  return t("explore.vramLight");
}

interface FileRowProps {
  file: HfFile;
  progress?: ModelDownloadProgress;
  disabled: boolean;
  queued: boolean;
  preferred?: boolean;
  onDownload: (file: HfFile) => void;
}

function FileRow({ file, progress, disabled, queued, preferred, onDownload }: FileRowProps) {
  const { t } = useI18n();
  const active = progress !== undefined;
  const quant = quantBadge(file.name);
  return <div className={cn("hf-file-row", preferred && "hf-file-row-preferred")}>
    <div className="hf-file-main">
      {preferred && <Star size={12} className="hf-file-star" fill="currentColor" />}
      {quant && <span className={cn("hf-quant-badge", preferred && "preferred")}>{quant}</span>}
      <span className="hf-file-quant" title={file.name}>{fileName(file.name)}</span>
    </div>
    <div className="hf-file-side">
      <span className="hf-file-size">{formatBytes(file.sizeBytes)}</span>
      {vramTag(file, t) ? <span className="hf-vram-tag">{vramTag(file, t)}</span> : null}
    {!active ? (
      queued ? (
        <button className="hf-download-btn queued" disabled>
          <Check size={13} />{t("explore.inQueue")}
        </button>
      ) : (
        <button className="hf-download-btn" disabled={disabled} onClick={() => onDownload(file)}>
          ⤓ {t("explore.downloadShort")}
        </button>
      )
    ) : (
      <span className="hf-file-progress">
        <span className="hf-file-bar"><span style={{ width: progress.percent + "%" }} /></span>
        <em>{progress.percent}% {humanSpeed(progress.speedBps)}</em>
      </span>
      )}
    </div>
  </div>;
}

interface ModelRowProps {
  model: HfModel;
  preferredQuant: boolean;
  onViewFiles: () => void;
}

function ModelRow({ model, preferredQuant, onViewFiles }: ModelRowProps) {
  const { t } = useI18n();
  const parameter = paramLabel(model);
  const quant = quantLabel(model);
  const quantSpecs = quantSpecsOf(model);
  const updated = model.updatedAt ? model.updatedAt.slice(0, 10) : "";
  const fileCount = model.ggufCount >= 0 ? model.ggufCount : null;
  const metaBits = [
    updated ? t("explore.metaUpdated", { date: updated }) : "",
    fileCount != null ? t("explore.metaFiles", { count: fileCount }) : "",
    "GGUF",
  ].filter(Boolean);
  if (quantSpecs.length > 1) metaBits.push(t("explore.quantSpecs", { quants: quantSpecs.join("/") }));
  return (
    <div className={cn("hf-model-row", preferredQuant && "hf-model-row-preferred")}>
      <div className="hf-model-row-body">
        <div className="hf-model-main-col">
          <div className="hf-model-title-row">
            <span className="hf-model-icon">HF</span>
            <strong>{model.id}</strong>
            {preferredQuant && <span className="hf-quant-badge preferred" title={t("explore.quantPreferred", { quant: quant || "" })}><Star size={10} fill="currentColor" />{quant}</span>}
            {parameter && <span className="hf-param-badge" title={t("explore.facetParams")}>{parameter}</span>}
            {quant && !preferredQuant && <span className="hf-quant-badge" title={t("explore.facetQuant")}>{quant}</span>}
            <button className="hf-model-link" type="button" title={t("explore.openOnHf")} aria-label={t("explore.openOnHf")} onClick={(event) => { event.stopPropagation(); openHf(model.id); }}>
              <ExternalLink size={14} />
            </button>
          </div>
          <span className="hf-model-desc">{metaBits.join(" · ")}</span>
        </div>
        <div className="hf-model-side-col">
          <div className="hf-model-meta">
            <span className="likes" title={model.likes.toLocaleString()}><Star size={12} fill="currentColor" />{formatCount(model.likes)}</span>
            <span title={model.downloads.toLocaleString()}><Download size={12} />{formatCount(model.downloads)}</span>
          </div>
          <div className="hf-model-actions">
            <button className="secondary-button compact" onClick={onViewFiles}><Download size={13} />{t("explore.viewFilesShort")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FileModalProps {
  model: HfModel;
  files: HfFile[] | null;
  filesLoading: boolean;
  filesError: string | null;
  preferredBits: number[] | null;
  diskUsage: DiskUsage | null;
  progressMap: Record<string, ModelDownloadProgress>;
  queuedKeys: Set<string>;
  onDownloadFile: (file: HfFile) => void;
  onPickModelsDir: () => Promise<void>;
  onClose: () => void;
}

/** 通用文件下载弹窗：热门卡 / 模型列表共用，页面不滚动、卡片不内嵌展开 */
function FileModal({ model, files, filesLoading, filesError, preferredBits, diskUsage, progressMap, queuedKeys, onDownloadFile, onPickModelsDir, onClose }: FileModalProps) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  /** 偏好量化置顶：匹配行排最前并高亮，其余按文件名保持稳定 */
  const isPreferredFile = (name: string) => preferredBits != null && preferredBits.length > 0 && preferredBits.includes(quantBitsOfFile(name) ?? -1);
  const ordered = useMemo(() => {
    if (!preferredBits || preferredBits.length === 0 || !files) return files;
    const copy = [...files];
    copy.sort((a, b) => {
      const am = isPreferredFile(a.name) ? 0 : 1;
      const bm = isPreferredFile(b.name) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
    return copy;
  }, [files, preferredBits]);
  return (
    <div className="file-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="file-modal">
        <header>
          <div className="file-modal-head">
            <strong>{model.id}</strong>
            <span>⭐ {model.likes.toLocaleString()} · ⬇ {model.downloads.toLocaleString()} · {t("explore.fileCount", { count: files !== null ? files.length : (model.ggufCount >= 0 ? model.ggufCount : "—") })}</span>
          </div>
          <button className="ghost-icon" title={t("ariaClose")} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="file-modal-path">
          <span><FolderOpen size={14} />{diskUsage?.path ?? t("explore.storageDir")}{diskUsage ? " · " + t("explore.storageFree", { free: formatBytes(diskUsage.freeBytes) }) : ""}</span>
          <button className="secondary-button compact" onClick={() => void onPickModelsDir()}><FolderOpen size={13} />{t("explore.changeDir")}</button>
        </div>
        <div className="file-modal-body">
          {filesLoading && <span className="hf-files-hint"><Loader2 size={13} className="spin" />{t("explore.loading")}</span>}
          {filesError && <span className="hf-files-hint err">{filesError}</span>}
          {!filesLoading && !filesError && ordered !== null && (
            ordered.length === 0
              ? <span className="hf-files-hint">{t("explore.emptyFiles")}</span>
              : (
                <div className="hf-files-list">
                  {ordered.map((file) => (
                    <FileRow key={file.name} file={file} disabled={false} preferred={isPreferredFile(file.name)} queued={queuedKeys.has(model.id + "::" + file.name)} progress={progressMap[model.id + "::" + file.name]} onDownload={onDownloadFile} />
                  ))}
                </div>
              )
          )}
        </div>
        <footer>
          <button className="secondary-button compact" onClick={onClose}>{t("ariaClose")}</button>
        </footer>
      </section>
    </div>
  );
}

/* ---------------- 左侧刻面筛选侧边栏 ---------------- */

interface FacetSidebarProps {
  mobileOpen: boolean;
  collapsed: boolean;
  family: FamilyKey;
  quantBits: number[];
  tasks: TaskKey[];
  paramMin: number;
  paramMax: number;
  onSelectFamily: (key: FamilyKey) => void;
  onToggleQuant: (bits: number) => void;
  onSelectAllQuant: () => void;
  onToggleTask: (key: TaskKey) => void;
  onParamMin: (value: number) => void;
  onParamMax: (value: number) => void;
  onResetParams: () => void;
  onResetAll: () => void;
  onToggleCollapsed: () => void;
}

function FacetSidebar({ mobileOpen, collapsed, family, quantBits, tasks, paramMin, paramMax, onSelectFamily, onToggleQuant, onSelectAllQuant, onToggleTask, onParamMin, onParamMax, onResetParams, onResetAll, onToggleCollapsed }: FacetSidebarProps) {
  const { t } = useI18n();
  const lockRange = `${PARAM_SLIDER_LABELS[paramMin]} ~ ${PARAM_SLIDER_LABELS[paramMax]}`;
  const pctLeft = (paramMin / PARAM_LAST_INDEX) * 100;
  const pctWidth = ((paramMax - paramMin) / PARAM_LAST_INDEX) * 100;

  return (
    <aside className={cn("facet-sidebar", mobileOpen && "facet-mobile-open", collapsed && "facet-sidebar-collapsed")}>
      <div className="facet-sidebar-head">
        <strong className="facet-sidebar-title"><SlidersHorizontal size={14} />{t("explore.facetSidebar")}</strong>
        <div className="facet-sidebar-actions">
          <button className="facet-collapse-btn" onClick={onToggleCollapsed} title={collapsed ? t("explore.facetExpand") : t("explore.facetCollapse")} aria-label={collapsed ? t("explore.facetExpand") : t("explore.facetCollapse")}>
            <ChevronLeft size={16} className={cn("facet-collapse-icon", collapsed && "rotated")} />
          </button>
          <button className="facet-reset-all" onClick={onResetAll}>{t("explore.facetReset")}</button>
        </div>
      </div>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetFamily")}</strong>
        </div>
        <div className="facet-chips">
          {FAMILIES.map((item) => (
            <button key={item.key} className={cn("facet-chip", family === item.key && "active")} onClick={() => onSelectFamily(item.key)}>
              {item.label.startsWith("explore.") ? t(item.label as import("../i18n").MessageKey) : item.label}
            </button>
          ))}
        </div>
      </section>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetParams")}</strong>
          <button className="facet-reset" onClick={onResetParams}>{t("explore.facetReset")}</button>
        </div>
        <div className="facet-range-wrap">
          <div className="facet-range-stack">
            <div className="facet-range-track"><span style={{ left: pctLeft + "%", width: Math.max(pctWidth, 0) + "%" }} /></div>
            <span className="facet-range-thumb-label" style={{ left: `calc(6px + ${pctLeft}% - ${pctLeft * 0.12}px)` }}>{PARAM_SLIDER_LABELS[paramMin]}</span>
            <span className="facet-range-thumb-label" style={{ left: `calc(6px + ${(pctLeft + pctWidth)}% - ${(pctLeft + pctWidth) * 0.12}px)` }}>{PARAM_SLIDER_LABELS[paramMax]}</span>
            <input type="range" className="facet-range facet-range-min" min={0} max={PARAM_LAST_INDEX} step={1} value={paramMin} onChange={(event) => onParamMin(Number(event.target.value))} />
            <input type="range" className="facet-range facet-range-max" min={0} max={PARAM_LAST_INDEX} step={1} value={paramMax} onChange={(event) => onParamMax(Number(event.target.value))} />
          </div>
          <div className="facet-range-scale">
            {PARAM_SLIDER_LABELS.map((label) => <span key={label}>{label}</span>)}
          </div>
          {(paramMin > 0 || paramMax < PARAM_LAST_INDEX) && (
            <div className="facet-lock-line">{t("explore.facetParamsLocked", { range: lockRange })}</div>
          )}
        </div>
      </section>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetQuant")}</strong>
        </div>
        <div className="facet-chips facet-chips-quant">
          <button className={cn("facet-chip", quantBits.length === 0 && "active")} onClick={onSelectAllQuant}>{t("explore.quantAll")}</button>
          {QUANTS.map((item) => (
            <button key={item.key} className={cn("facet-chip", item.cls, quantBits.includes(item.bits[0]) && "active")} onClick={() => onToggleQuant(item.bits[0])} title={t(item.label as import("../i18n").MessageKey)}>
              {t(item.label as import("../i18n").MessageKey)}
            </button>
          ))}
        </div>
      </section>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetTasks")}</strong>
        </div>
        <div className="facet-chips facet-chips-tasks">
          {TASKS.map((item) => (
            <button key={item.key} className={cn("facet-chip", tasks.includes(item.key) && "active")} onClick={() => onToggleTask(item.key)}>
              {t(item.label as import("../i18n").MessageKey)}
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
export default function ExplorePage(props: Props) {
  const { t } = useI18n();
  const showToast = props.onToast;
  const [view, setView] = useState<"discover" | "tasks">("discover");
  const [query, setQuery] = useState("");
  const [ggufOnly, setGgufOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("hot");
  const [models, setModels] = useState<HfModel[]>([]);
  const [trending, setTrending] = useState<HfModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalModel, setModalModel] = useState<HfModel | null>(null);
  const [filesMap, setFilesMap] = useState<Record<string, HfFile[] | null>>({});
  const [filesLoading, setFilesLoading] = useState<Record<string, boolean>>({});
  const [filesError, setFilesError] = useState<Record<string, string | null>>({});
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendCollapsed, setTrendCollapsed] = useState(false);
  const [taskFilter, setTaskFilter] = useState<"all" | "active" | "done" | "failed">("all");
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // 刻面状态
  const [family, setFamily] = useState<FamilyKey>("all");
  const [quantBits, setQuantBits] = useState<number[]>([]);
  const [tasks, setTasks] = useState<TaskKey[]>([]);
  const [paramMin, setParamMin] = useState(0);
  const [paramMax, setParamMax] = useState(PARAM_LAST_INDEX);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => props.config.exploreSidebarCollapsed ?? false);
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width:1180px)").matches);
  const searchSeq = useRef(0);


  const searchRef = useRef<HTMLInputElement>(null);

  /** 量化偏好（多选）：同时用于服务端过滤参数与文件弹窗高亮 / 列表星标 */
  const quantPreferredBits = quantBits.length > 0 ? quantBits : null;

  /** 组合后的请求关键字：文本 + 家族 + 任务 + 量化偏好 + 参数档位；变化即触发服务端重查 */
  const effectiveKeyword = useMemo(() => {
    const parts: string[] = [];
    const text = query.trim();
    if (text) parts.push(text);
    if (family !== "all") {
      const fam = FAMILIES.find((item) => item.key === family);
      if (fam?.needles[0]) parts.push(fam.needles[0]);
    }
    for (const key of tasks) {
      const task = TASKS.find((item) => item.key === key);
      if (task?.needles[0]) parts.push(task.needles[0]);
    }
    // 量化偏好作为独立服务端过滤参数（hf_search/hf_trending 的 quants），不拼进关键词，
    // 避免触发 GGUF 仓库的多量化噪声；同时保留星标高亮（见 FileModal preferredBits）。
    if (paramMin > 0 || paramMax < PARAM_LAST_INDEX) {
      const label = (paramMin > 0 ? PARAM_SLIDER_LABELS[paramMin] : PARAM_SLIDER_LABELS[paramMax]).replace(/[<>]/g, "");
      if (label) parts.push(label);
    }
    return [...new Set(parts)].join(" ");
  }, [query, family, tasks, quantBits, paramMin, paramMax]);

  // Ctrl+K 聚焦搜索
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 初始化：加载趋势榜单 + 探测本机硬件
  useEffect(() => {
    void refreshTrending();
  }, []);

  // Narrow screens (<=1180px) switch the facet sidebar into a drawer
  useEffect(() => {
    const mq = window.matchMedia("(max-width:1180px)");
    const onChangeMq = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    mq.addEventListener("change", onChangeMq);
    return () => mq.removeEventListener("change", onChangeMq);
  }, []);

  const refreshTrending = async () => {
    setTrendingLoading(true);
    try {
      const result = await hfTrending(8, true);
      setTrending(result);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally { setTrendingLoading(false); }
  };

  const runSearch = async (notify?: boolean) => {
    const seq = ++searchSeq.current;
    const keyword = effectiveKeyword;
    setLoading(true); setError(null);
    let ok = false;
    let failMessage = "";
    try {
      const useGguf = ggufOnly && !keyword.toLowerCase().includes(".gguf");
      const quants = quantBits.length > 0 ? quantBits : undefined;
      const result = keyword ? await hfSearch(keyword, 30, useGguf, undefined, HF_SORT[sortKey], quants) : await hfTrending(30, useGguf, undefined, HF_SORT[sortKey], quants);
      if (seq !== searchSeq.current) return false; // 已发起更新的请求，丢弃过期结果
      setModels(result);
      setHasMore(result.length === 30);
      setFilesMap({});
      ok = true;
    } catch (err) {
      if (seq !== searchSeq.current) return false;
      const message = err instanceof Error ? err.message : String(err);
      failMessage = message;
      setError(message);
    } finally {
      if (seq === searchSeq.current) {
        setLoading(false);
        if (notify) showToast(ok ? t("explore.refreshed") : failMessage);
      }
    }
    return ok;
  };

  const refreshAll = async (notify = false) => {
    setRefreshing(true);
    setError(null);
    const [listOk, trendingOk] = await Promise.all([runSearch(false), refreshTrending()]);
    setRefreshing(false);
    if (notify) showToast(listOk && trendingOk ? t("explore.refreshed") : t("explore.refreshFailed"));
  };

  // 搜索防抖 300ms：文本 / 刻面 / 量化偏好 / 参数档位变化时向服务端重查并重置列表
  useEffect(() => {
    const timer = window.setTimeout(() => { void runSearch(); }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKeyword, ggufOnly, sortKey, quantBits]);

  /** 触底分页：追加下一页，而不是覆盖列表 */
  const loadMore = async () => {
    if (loading || loadingMore || !hasMore) return;
    const seq = searchSeq.current;
    const keyword = effectiveKeyword;
    const limit = 30;
    const skip = models.length;
    setLoadingMore(true);
    try {
      const useGguf = ggufOnly && !keyword.toLowerCase().includes(".gguf");
      const quants = quantBits.length > 0 ? quantBits : undefined;
      const next = keyword ? await hfSearch(keyword, limit, useGguf, skip, HF_SORT[sortKey], quants) : await hfTrending(limit, useGguf, skip, HF_SORT[sortKey], quants);
      const seen = new Set(models.map((item) => item.id));
      const added = next.filter((item) => !seen.has(item.id));
      if (seq !== searchSeq.current) {
        // 列表已被新查询重置，丢弃过期追加
      } else if (added.length === 0) {
        // 无新增数据视为加载完毕，避免哨兵反复触发转圈
        setHasMore(false);
      } else {
        setModels((previous) => [...previous, ...added]);
        setHasMore(next.length === limit);
      }
    } catch {
      setHasMore(false);
    } finally { setLoadingMore(false); }
  };

  /** 底部哨兵：仅当哨兵从视口外被用户滚动进入时才加载下一页（避免进页面就自动翻页） */
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return;
    let wasOutside = false;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          if (wasOutside) void loadMore();
          wasOutside = false;
        } else {
          wasOutside = true;
        }
      },
      { rootMargin: "0px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.length, hasMore, loadingMore, effectiveKeyword, ggufOnly]);

  /** 打开通用文件弹窗：热门卡 / 列表项共用，页面不滚动、卡片不内嵌展开 */
  const openFiles = (model: HfModel) => {
    setModalModel(model);
    if (filesMap[model.id] === undefined && !filesLoading[model.id]) {
      setFilesLoading((previous) => ({ ...previous, [model.id]: true }));
      setFilesError((previous) => ({ ...previous, [model.id]: null }));
      void hfListFiles(model.id).then((result) => {
        setFilesMap((previous) => ({ ...previous, [model.id]: result }));
      }).catch((err) => {
        setFilesError((previous) => ({ ...previous, [model.id]: err instanceof Error ? err.message : String(err) }));
      }).finally(() => {
        setFilesLoading((previous) => ({ ...previous, [model.id]: false }));
      });
    }
  };

  const diskGuard = (sizeBytes: number): boolean => {
    if (!props.diskUsage || sizeBytes <= 0) return true;
    if (props.diskUsage.freeBytes >= sizeBytes) return true;
    props.onLog(t("explore.insufficientSpace", { free: formatBytes(props.diskUsage.freeBytes), need: formatBytes(sizeBytes) }), "stderr");
    return false;
  };

  const downloadFile = (model: HfModel, file: HfFile) => {
    if (!diskGuard(file.sizeBytes)) return;
    props.onDownload(model.id, file.name, file.sizeBytes);
    const key = model.id + "::" + file.name;
    setQueued((previous) => new Set(previous).add(key));
    window.setTimeout(() => {
      setQueued((previous) => { const next = new Set(previous); next.delete(key); return next; });
    }, 2400);
  };

  const handleParamMin = (value: number) => {
    setParamMin(Math.min(value, paramMax));
  };
  const handleParamMax = (value: number) => {
    setParamMax(Math.max(value, paramMin));
  };
  const resetParams = () => {
    setParamMin(0);
    setParamMax(PARAM_LAST_INDEX);
  };
  const resetAll = () => {
    setFamily("all");
    setQuantBits([]);
    setTasks([]);
    resetParams();
  };
  const toggleQuant = (bits: number) => {
    setQuantBits((previous) => previous.includes(bits) ? previous.filter((item) => item !== bits) : [...previous, bits]);
  };
  const selectAllQuant = () => setQuantBits([]);
  const toggleTask = (key: TaskKey) => {
    setTasks((previous) => previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key]);
  };
  const toggleCollapsed = () => {
    if (isNarrow) {
      setSidebarCollapsed(false);
      setMobileSidebarOpen((v) => !v);
      return;
    }
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    setMobileSidebarOpen(false);
    void props.onPersist({ ...props.config, exploreSidebarCollapsed: next });
  };

  const sidebarHidden = isNarrow ? !mobileSidebarOpen : sidebarCollapsed;
  const facetCount = (family !== "all" ? 1 : 0) + (quantBits.length > 0 ? 1 : 0) + tasks.length + (paramMin > 0 || paramMax < PARAM_LAST_INDEX ? 1 : 0);

  const activeCount = props.activeDownloads.filter((item) => item.status === "active").length;
  const tasksActive = props.activeDownloads.filter((item) => item.status === "active");
  const tasksDone = props.activeDownloads.filter((item) => item.status === "done");
  const tasksFailed = props.activeDownloads.filter((item) => item.status === "error" || item.status === "cancelled");
  const shownTasks = taskFilter === "active" ? tasksActive : taskFilter === "done" ? tasksDone : taskFilter === "failed" ? tasksFailed : props.activeDownloads;
  const totalSpeed = tasksActive.reduce((sum, item) => sum + (item.speedBps || 0), 0);

  // 列表不再做本地刻面过滤：查询关键字已由 effectiveKeyword 携带至服务端，防止「假过滤」只显示 1 个模型。
  const sorted = [...models].sort((a, b) => {
    if (sortKey === "likes") return b.likes - a.likes;
    if (sortKey === "updated") return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    if (sortKey === "downloads") return b.downloads - a.downloads;
    return (b.downloads * 4 + b.likes) - (a.downloads * 4 + a.likes);
  });
  const searching = query.trim().length > 0;
  const queuedKeys = queued;

  return <div className="explore-page" hidden={!props.visible}>
    {/* 第 1 行：视图切换 + 存储目录（轻量化副信息条） */}
    <div className="library-bar explore-header">
      <div className="explore-view-tabs">
        <button className={cn("explore-view-tab", view === "discover" && "active")} onClick={() => setView("discover")}><Globe size={15} />{t("explore.viewDiscover")}</button>
        <button className={cn("explore-view-tab", view === "tasks" && "active")} onClick={() => setView("tasks")}><Download size={15} />{t("explore.viewTasks")}{activeCount > 0 && <em>{activeCount}</em>}</button>
      </div>
      <div className="explore-storage">
        <span title={t("explore.storageDir")}><FolderOpen size={13} />{props.diskUsage?.path ?? t("explore.storageDir")}</span>
        {props.diskUsage && <em className="explore-free-badge">{t("explore.storageFree", { free: formatBytes(props.diskUsage.freeBytes) })}</em>}
        <button className="explore-change-dir" onClick={() => void props.onPickModelsDir()}><FolderOpen size={12} />{t("explore.changeDir")}</button>
      </div>
    </div>

    {view === "discover" ? (
      <div className="facet-shell">
        <FacetSidebar
          mobileOpen={mobileSidebarOpen}
          collapsed={sidebarCollapsed}
          family={family}
          quantBits={quantBits}
          tasks={tasks}
          paramMin={paramMin}
          paramMax={paramMax}
          onSelectFamily={setFamily}
          onToggleQuant={toggleQuant}
          onSelectAllQuant={selectAllQuant}
          onToggleTask={toggleTask}
          onParamMin={handleParamMin}
          onParamMax={handleParamMax}
          onResetParams={resetParams}
          onResetAll={resetAll}
          onToggleCollapsed={toggleCollapsed}
        />
        <div className="facet-content">
          {/* 第 2 行：搜索（内嵌来源前缀）+ 排序 / GGUF */}
          <div className="explore-searchzone">
            {sidebarHidden && (
              <button className={"facet-search-toggle"} onClick={toggleCollapsed} title={t("explore.facetExpand")}>
                <ChevronRight size={14} />{t("explore.facetToggle")}{facetCount > 0 && <em>{facetCount}</em>}
              </button>
            )}
            <label className="search-box explore-search">
              <span className="explore-source"><span>🤗</span> HuggingFace<ChevronDown size={12} /></span>
              <Search size={14} />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("explore.searchPlaceholder")} />
              <kbd>Ctrl+K</kbd>
            </label>
            <div className="explore-search-tools">
              <select className="engine-select" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="downloads">{t("explore.sortDownloads")}</option>
                <option value="likes">{t("explore.sortLikes")}</option>
                <option value="updated">{t("explore.sortUpdated")}</option>
                <option value="hot">{t("explore.sortHot")}</option>
              </select>
              <button className="ghost-icon hf-icon-button" onClick={() => void refreshAll(true)} disabled={refreshing} title={t("explore.refreshList")} aria-label={t("explore.refreshList")}><RefreshCw size={15} className={cn("facet-refresh-icon", refreshing && "spin")} /></button>
              <label className="hf-gguf-toggle"><input type="checkbox" checked={ggufOnly} onChange={(e) => setGgufOnly(e.target.checked)} />{t("explore.ggufOnly")}</label>
            </div>
          </div>

          <div className="facet-scroll-area">
          <div className={cn("hf-list-refresh-veil", loading && "visible")} aria-hidden={!loading}>{loading ? <Loader2 size={20} className="spin" /> : null}</div>
          {!searching && facetCount === 0 && (
            <div className="section-title-row">
              <div><h2>🔥 {t("explore.trendingTitle")}</h2></div>
              <div className="library-tools">
                <span className="explore-updated">2026.09</span>
                <button className="ghost-icon hf-icon-button" title={trendCollapsed ? t("explore.trendingExpand") : t("explore.trendingCollapse")} aria-label={trendCollapsed ? t("explore.trendingExpand") : t("explore.trendingCollapse")} onClick={() => setTrendCollapsed((v) => !v)}>
                  {trendCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>
            </div>
          )}
          {!searching && facetCount === 0 && !trendCollapsed && (trendingLoading && trending.length === 0 ? (
            <div className="hf-trending">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="hf-trend-card hf-skeleton-card" key={index}>
                  <div className="hf-skeleton-line title" />
                  <div className="hf-skeleton-line text" />
                  <div className="hf-skeleton-line short" />
                </div>
              ))}
            </div>
          ) : (
            <div className="hf-trending">
              {trending.map((model) => (
                <div className="hf-trend-card" key={model.id}>
                  <div className="hf-model-title-row">
                    <span className="hf-model-icon">HF</span>
                    <strong>{model.id}</strong>
                    <button className="ghost-icon hf-icon-button" title={t("explore.openOnHf")} onClick={() => void openHf(model.id)}><ExternalLink size={14} /></button>
                  </div>
                  <span className="hf-model-desc">{model.name}</span>
                  <div className="hf-trend-meta">
                    <span title={model.likes.toLocaleString()}><Star size={12} fill="currentColor" />{formatCount(model.likes)}</span>
                    <span title={model.downloads.toLocaleString()}><Download size={12} />{formatCount(model.downloads)}</span>
                  </div>
                  {model.sampleQuant ? <span className="hf-quant-badge hf-trend-quant">{model.sampleQuant}</span> : null}
                  <div className="hf-trend-actions">
                    <button className="secondary-button compact" onClick={() => openFiles(model)}><Download size={13} />{t("explore.viewFilesShort")}</button>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* 模型列表标题 */}
          <div className="section-title-row">
            <div><h2>{searching ? t("explore.searchResults", { query: query.trim(), count: models.length }) : t("explore.modelList", { count: models.length })}</h2></div>
            <div className="library-tools">
              {facetCount > 0 && <span className="explore-updated">{t("explore.facetSidebar")} × {facetCount}</span>}
            </div>
          </div>
          {loading && models.length === 0 ? (
            <div className="hf-skeleton-list">
              {Array.from({ length: 5 }, (_, index) => (
                <div className="hf-model-row hf-skeleton-row" key={index}>
                  <div className="hf-model-row-body">
                    <span className="hf-model-icon hf-skeleton-block" />
                    <div className="hf-model-main-col">
                      <div className="hf-skeleton-line title" />
                      <div className="hf-skeleton-line text" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {error && !loading && <div className="hf-empty err"><p>{error}</p><span className="hf-net-hint">{t("explore.netErrorHint")}</span></div>}
          {!loading && !error && sorted.length === 0 && <div className="hf-empty"><h3>{t("explore.noResults")}</h3><p>{t("explore.noResultsDesc")}</p></div>}
          {sorted.map((model) => (
            <ModelRow key={model.id} model={model} preferredQuant={quantPreferredBits != null && modelQuantBits(model) != null && quantPreferredBits.includes(modelQuantBits(model)!)} onViewFiles={() => openFiles(model)} />
          ))}
          <div ref={loadMoreRef} className="hf-list-foot">
            {loadingMore && <><Loader2 size={14} className="spin" />{t("explore.loadingMore")}</>}
            {!loadingMore && !hasMore && models.length > 0 && <span>{t("explore.loadedAll")}</span>}
          </div>
          </div>
        </div>
      </div>
    ) : (
      /* ==================== 任务管理视图 ==================== */
      <div className="tasks-view">
        <div className="tasks-filterbar">
          <div className="explore-filters">
            {([["all", t("explore.tasksAll") + (props.activeDownloads.length ? " (" + props.activeDownloads.length + ")" : "")], ["active", t("explore.tasksActive") + (tasksActive.length ? " (" + tasksActive.length + ")" : "")], ["done", t("explore.tasksDone") + (tasksDone.length ? " (" + tasksDone.length + ")" : "")], ["failed", t("explore.tasksFailed") + (tasksFailed.length ? " (" + tasksFailed.length + ")" : "")]] as const).map(([key, label]) => (
              <button key={key} className={cn("explore-filter", taskFilter === key && "active")} onClick={() => setTaskFilter(key)}>{label}</button>
            ))}
          </div>
          <div className="library-actions">
            <button className="secondary-button compact" disabled={!tasksActive.length} onClick={props.onPauseAll}><PauseCircle size={14} />{t("explore.pauseAll")}</button>
            <button className="secondary-button compact" disabled={!tasksFailed.length} onClick={props.onResumeFailed}><PlayCircle size={14} />{t("explore.resumeAll")}</button>
            <button className="secondary-button compact" disabled={!tasksDone.length} onClick={props.onClearDone}><Trash2 size={14} />{t("explore.clearDone")}</button>
          </div>
        </div>

        {tasksActive.length > 0 && (
          <div className="tasks-section-title"><h2>{t("explore.tasksActive", { count: tasksActive.length })}</h2><span>{t("explore.totalSpeed", { speed: humanSpeed(totalSpeed) })}</span></div>
        )}
        {shownTasks.filter((item) => item.status === "active").map((item) => {
          const key = item.repo + "::" + item.file;
          const progress = props.progressMap[key];
          const percent = progress?.percent ?? item.percent ?? 0;
          const downloaded = progress?.downloaded ?? item.downloaded ?? 0;
          const total = progress?.total ?? item.total ?? item.sizeBytes ?? 0;
          const speed = progress?.speedBps ?? item.speedBps ?? 0;
          const etaSeconds = speed > 0 && total > downloaded ? Math.ceil((total - downloaded) / speed) : 0;
          const eta = etaSeconds > 0 ? String(Math.floor(etaSeconds / 60)).padStart(2, "0") + ":" + String(etaSeconds % 60).padStart(2, "0") : "--:--";
          const targetDir = props.diskUsage ? props.diskUsage.path + (item.repo !== "direct-url" ? "/" + (item.repo.split("/").pop() || "") : "") : "";
          return (
            <div className="task-card" key={key}>
              <div className="task-card-head">
                <span className="task-file-icon"><Database size={16} /></span>
                <div className="task-file-info">
                  <strong>{item.file}</strong>
                  <span>{t("explore.source", { repo: item.repo })} · {t("explore.target", { path: item.path ?? targetDir })}</span>
                </div>
                <div className="task-card-actions">
                  <button className="secondary-button compact" onClick={props.onPauseAll} title={t("explore.pauseAll")}><PauseCircle size={13} />{t("explore.pause")}</button>
                  <button className="danger-button compact" onClick={() => props.onCancelTask(item, true)} title={t("explore.cancelDelete")}><X size={13} />{t("explore.cancel")}</button>
                </div>
              </div>
              <div className="task-progress-row">
                <div className="hf-file-bar"><span style={{ width: percent + "%" }} /></div>
                <em>{percent}%</em>
              </div>
              <div className="task-meta-row">
                <span>{t("explore.progressLabel", { down: formatBytes(downloaded), total: formatBytes(total) })}</span>
                <span>{humanSpeed(speed)}</span>
                <span>{t("explore.eta", { eta })}</span>
              </div>
            </div>
          );
        })}

        {tasksDone.length > 0 && (
          <div className="tasks-section-title"><h2>{t("explore.tasksDone")} ({tasksDone.length})</h2></div>
        )}
        {tasksDone.length === 0 && taskFilter !== "active" && taskFilter !== "failed" && (
          <div className="tasks-empty"><span>{t("explore.noDoneTasks")}</span></div>
        )}
        {shownTasks.filter((item) => item.status === "done").map((item) => (
          <div className="task-card task-card-done" key={item.repo + "::" + item.file + "::" + (item.finishedAt ?? item.startedAt)}>
            <div className="task-card-head">
              <span className="task-file-icon"><Check size={16} /></span>
              <div className="task-file-info">
                <strong>{item.file}</strong>
                <span>{t("explore.syncedToLibrary")}</span>
              </div>
              <div className="task-card-actions">
                {item.path && <button className="secondary-button compact" onClick={() => void props.onReveal(item.path!)}><FolderOpen size={13} />{t("explore.openFolder")}</button>}
                <button className="secondary-button compact" onClick={props.onGoModels}><Boxes size={13} />{t("explore.goModels")}</button>
                {item.finishedAt ? <span className="task-done-time">{new Date(item.finishedAt).toLocaleString()}</span> : null}
              </div>
            </div>
          </div>
        ))}

        {shownTasks.filter((item) => item.status === "error" || item.status === "cancelled").length > 0 && (
          <div className="tasks-section-title"><h2>{t("explore.tasksFailed")} ({shownTasks.filter((item) => item.status === "error" || item.status === "cancelled").length})</h2></div>
        )}
        {shownTasks.filter((item) => item.status === "error" || item.status === "cancelled").map((item) => (
          <div className="task-card task-card-error" key={item.repo + "::" + item.file + "::" + (item.finishedAt ?? item.startedAt)}>
            <div className="task-card-head">
              <span className="task-file-icon err"><AlertCircle size={16} /></span>
              <div className="task-file-info">
                <strong>{item.file}</strong>
                <span>{item.error || t("explore.tasksFailed")}</span>
              </div>
              <div className="task-card-actions">
                <button className="secondary-button compact" onClick={() => props.onRetry(item)}><RefreshCw size={13} />{t("explore.resume")}</button>
                <button className="danger-button compact" onClick={() => props.onCancelTask(item, true)} title={t("explore.cancelDelete")}><Trash2 size={13} />{t("explore.cancel")}</button>
              </div>
            </div>
          </div>
        ))}

        {shownTasks.length === 0 && (
          <div className="hf-empty"><h3>{t("explore.noTasks")}</h3><p>{t("explore.noTasksDesc")}</p></div>
        )}
      </div>
    )}
  {modalModel && (
    <FileModal
      model={modalModel}
      files={filesMap[modalModel.id] ?? null}
      filesLoading={!!filesLoading[modalModel.id]}
      filesError={filesError[modalModel.id] ?? null}
      preferredBits={quantPreferredBits}
      diskUsage={props.diskUsage}
      progressMap={props.progressMap}
      queuedKeys={queuedKeys}
      onDownloadFile={(file) => downloadFile(modalModel, file)}
      onPickModelsDir={props.onPickModelsDir}
      onClose={() => setModalModel(null)}
    />
  )}
  </div>;
}

function openHf(id: string) {
  void openExternal("https://huggingface.co/" + id);
}

function formatCount(value: number) {
  const compact = (divisor: number, suffix: string) => {
    const scaled = Math.floor(value / divisor * 10) / 10;
    return scaled % 1 === 0 ? `${scaled}${suffix}` : `${scaled.toFixed(1)}${suffix}`;
  };
  if (value >= 1_000_000) return compact(1_000_000, "M");
  if (value >= 1_000) return compact(1_000, "k");
  return value.toLocaleString();
}
