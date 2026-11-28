import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FlaskConical,
  FolderOpen,
  HardDrive,
  HardDriveDownload,
  History,
  Info,
  Layers3,
  Loader2,
  Maximize2,
  Package,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_NINFER_CONVERTER_REPO } from "../data";
import { useI18n } from "../i18n";
import {
  findSplitGroup,
  inspectGguf,
  pathsExist,
  pickFiles,
  revealInFolder,
  splitInfoFromGroup,
} from "../tauri";
import type {
  AppConfig,
  ModelAsset,
  NinferConvertHistoryItem,
  NinferConvertProgress,
  NinferConvertResult,
  NinferConverterDownloadProgress,
  NinferConverterRelease,
  NinferConverterStatus,
} from "../types";
import { cn, fileName, formatBytes, formatMB, modelTitle, parseQuantization } from "../utils";
import { ModelFormatBadge } from "./ModelFormatBadge";

type LabFeatureId = "convert";
type ConvertSubView = "models" | "history";

interface Props {
  config: AppConfig;
  converterStatus: NinferConverterStatus | null;
  remoteRelease: NinferConverterRelease | null;
  checkingRelease: boolean;
  downloadingBundle: boolean;
  downloadProgress: NinferConverterDownloadProgress | null;
  bundleError: string | null;
  activeTargetModel: ModelAsset | null;
  minimized: boolean;
  converting: boolean;
  convertProgress: NinferConvertProgress | null;
  convertResult: NinferConvertResult | null;
  convertError: string | null;
  onRefreshConverterStatus: () => Promise<NinferConverterStatus | null>;
  onCheckRelease: (repo?: string, silent?: boolean) => Promise<NinferConverterRelease | null>;
  onDownloadBundle: (repo?: string) => Promise<NinferConverterStatus | null>;
  onCancelDownload: () => void;
  onImportBundleZip: () => Promise<NinferConverterStatus | null>;
  onPickBundleDir: () => Promise<NinferConverterStatus | null>;
  onUninstallBundle: () => Promise<NinferConverterStatus | null>;
  onSaveRepo: (repo: string) => Promise<string | null>;
  onResetRepo: () => Promise<string | null>;
  onOpenConvert: (model: ModelAsset) => void;
  onExpandConvert: () => void;
  onCloseConvert: () => void;
  onDeleteHistory: (id: string) => Promise<void>;
  onClearHistory: () => Promise<void>;
}

function normalizePathKey(p: string): string {
  return p.trim().replace(/\//g, "\\").toLowerCase();
}

/** 仅展示上一级文件夹与文件名，减少列表长路径视觉噪音 */
function compactFilePath(p: string): string {
  const parts = p.trim().split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return p.trim();
  const sep = p.includes("\\") ? "\\" : "/";
  return `${parts[parts.length - 2]}${sep}${parts[parts.length - 1]}`;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatHistoryTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function LabPage({
  config,
  converterStatus,
  remoteRelease,
  checkingRelease,
  downloadingBundle,
  downloadProgress,
  bundleError,
  activeTargetModel,
  minimized,
  converting,
  convertProgress,
  convertResult,
  convertError,
  onRefreshConverterStatus,
  onCheckRelease,
  onDownloadBundle,
  onCancelDownload,
  onImportBundleZip,
  onPickBundleDir,
  onUninstallBundle,
  onSaveRepo,
  onResetRepo,
  onOpenConvert,
  onExpandConvert,
  onCloseConvert,
  onDeleteHistory,
  onClearHistory,
}: Props) {
  const { t } = useI18n();
  const [activeFeature, setActiveFeature] = useState<LabFeatureId>("convert");
  const [convertSubView, setConvertSubView] = useState<ConvertSubView>("models");
  const [query, setQuery] = useState("");
  const [pickingFile, setPickingFile] = useState(false);
  const [bundleSettingsOpen, setBundleSettingsOpen] = useState(false);
  const [repoInput, setRepoInput] = useState(
    config.ninferConverterRepo || converterStatus?.repo || DEFAULT_NINFER_CONVERTER_REPO,
  );
  const [existingOutputs, setExistingOutputs] = useState<Set<string>>(new Set());
  const checkedOnOpenRef = useRef(false);

  const history = config.ninferConvertHistory ?? [];

  useEffect(() => {
    const nextRepo =
      config.ninferConverterRepo || converterStatus?.repo || DEFAULT_NINFER_CONVERTER_REPO;
    setRepoInput(nextRepo);
  }, [config.ninferConverterRepo, converterStatus?.repo]);

  useEffect(() => {
    void onRefreshConverterStatus();
    if (!checkedOnOpenRef.current) {
      checkedOnOpenRef.current = true;
      void onCheckRelease(undefined, true);
    }
  }, [onRefreshConverterStatus, onCheckRelease]);

  useEffect(() => {
    const targets = Array.from(
      new Set(
        history
          .filter((item) => item.status === "success" && item.outputPath.trim())
          .map((item) => item.outputPath.trim()),
      ),
    );
    if (!targets.length) {
      setExistingOutputs(new Set());
      return;
    }
    let active = true;
    void pathsExist(targets)
      .then((found) => {
        if (active) {
          setExistingOutputs(new Set(found.map(normalizePathKey)));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [history, convertSubView]);

  const latestSuccessBySource = useMemo(() => {
    const map = new Map<string, NinferConvertHistoryItem>();
    for (const item of history) {
      if (item.status !== "success" || !item.sourcePath.trim()) continue;
      const key = normalizePathKey(item.sourcePath);
      if (!map.has(key)) {
        map.set(key, item);
      }
    }
    return map;
  }, [history]);

  const ggufModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return config.models.filter((model) => {
      const lowerPath = model.path.toLowerCase();
      if (!lowerPath.endsWith(".gguf")) return false;
      if (fileName(lowerPath).startsWith("mmproj")) return false;
      if (!q) return true;
      return [modelTitle(model), model.architecture, model.quantization, model.path]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [config.models, query]);

  const totalGgufCount = useMemo(
    () =>
      config.models.filter(
        (m) => m.path.toLowerCase().endsWith(".gguf") && !fileName(m.path).toLowerCase().startsWith("mmproj"),
      ).length,
    [config.models],
  );

  const buildTransientModel = async (path: string, sizeBytes?: number): Promise<ModelAsset> => {
    const [group, meta] = await Promise.all([
      findSplitGroup(path).catch(() => null),
      inspectGguf(path).catch(() => null),
    ]);
    const targetPath = group?.primaryPath ?? path;
    const finalBytes = group && group.totalBytes > 0 ? group.totalBytes : (sizeBytes ?? 0);
    const stem = (group?.prefix ?? fileName(targetPath).replace(/\.gguf$/i, "")).replace(/[-_]/g, " ");
    return {
      id: `lab-disk:${targetPath}`,
      name: stem || fileName(targetPath),
      path: targetPath,
      sizeBytes: finalBytes,
      architecture: meta?.architecture || "GGUF",
      quantization: parseQuantization(targetPath, "") || meta?.quantization || t("model.unknownQuant"),
      parameters: meta?.parameters || targetPath.match(/\d+(?:\.\d+)?B/i)?.[0]?.toUpperCase() || "—",
      profiles: [],
      accent: "amber",
      splitInfo: group ? splitInfoFromGroup(group) : undefined,
    };
  };

  const handlePickDiskGguf = async () => {
    if (pickingFile || converting) return;
    setPickingFile(true);
    try {
      const picked = await pickFiles(["gguf"]);
      const item = picked[0];
      if (!item?.path) return;
      const transientModel = await buildTransientModel(item.path, item.sizeBytes);
      onOpenConvert(transientModel);
    } finally {
      setPickingFile(false);
    }
  };

  const handleReconvertHistory = async (item: NinferConvertHistoryItem) => {
    if (converting) {
      onExpandConvert();
      return;
    }
    const existing = config.models.find(
      (m) => normalizePathKey(m.path) === normalizePathKey(item.sourcePath),
    );
    if (existing) {
      onOpenConvert(existing);
      return;
    }
    const transient = await buildTransientModel(item.sourcePath);
    onOpenConvert(transient);
  };

  const activeRepo =
    config.ninferConverterRepo || converterStatus?.repo || DEFAULT_NINFER_CONVERTER_REPO;
  const isCustomRepo =
    activeRepo.trim().toLowerCase() !== DEFAULT_NINFER_CONVERTER_REPO.toLowerCase();
  const isRepoInputDefault =
    !isCustomRepo &&
    repoInput.trim().toLowerCase() === DEFAULT_NINFER_CONVERTER_REPO.toLowerCase();

  const hasRemoteUpdate = Boolean(
    converterStatus?.ready && remoteRelease?.tag && !remoteRelease.upToDate,
  );
  const needsPrimaryDownload = !converterStatus?.ready || hasRemoteUpdate;
  const dlSpeed =
    downloadProgress && downloadProgress.speedBps > 0
      ? `${formatBytes(downloadProgress.speedBps)}/s`
      : "";
  const dlSize =
    downloadProgress && (downloadProgress.downloaded > 0 || downloadProgress.total > 0)
      ? downloadProgress.total > 0
        ? `${formatMB(downloadProgress.downloaded)} / ${formatMB(downloadProgress.total)}`
        : formatMB(downloadProgress.downloaded)
      : "";

  const bundleSummaryLine = (() => {
    if (!converterStatus?.ready) {
      return t("convert.bundleNotInstalledHint");
    }
    if (hasRemoteUpdate && remoteRelease?.tag) {
      return remoteRelease.assetSize
        ? t("convert.bundleSummaryUpdate", {
            tag: remoteRelease.tag,
            size: formatBytes(remoteRelease.assetSize),
          })
        : t("convert.bundleSummaryUpdateNoSize", { tag: remoteRelease.tag });
    }
    if (isCustomRepo) {
      return t("convert.bundleSummaryCustomRepo", { repo: activeRepo });
    }
    return t("convert.bundleSummaryReady", { repo: activeRepo });
  })();

  return (
    <div className="lab-shell">
      {/* 顶部功能栏：按实验室功能划分，同一功能的子视图/记录收在对应功能界面内部 */}
      <div className="lab-topbar">
        <div className="lab-topbar-left">
          <div className="explore-view-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeFeature === "convert"}
              className={cn("explore-view-tab", activeFeature === "convert" && "active")}
              onClick={() => setActiveFeature("convert")}
            >
              <ArrowRightLeft size={14} />
              <span>{t("lab.toolConvertTitle")}</span>
            </button>
          </div>
        </div>

        <div className="lab-topbar-actions">
          {activeFeature === "convert" && (
            <button
              type="button"
              className="primary-button"
              disabled={pickingFile || converting}
              title={converting ? t("lab.convertingBusyHint") : t("lab.pickDiskGgufTitle")}
              onClick={() => void handlePickDiskGguf()}
            >
              <FolderOpen size={15} />
              {t("lab.pickDiskGguf")}
            </button>
          )}
        </div>
      </div>

      {/* 实验室状态说明（测试阶段提示，可随时在设置隐藏） */}
      <div className="lab-beta-banner">
        <FlaskConical size={15} />
        <p>{t("lab.betaNotice")}</p>
      </div>

      {activeFeature === "convert" && (
        <div className="lab-workspace">
          {/* 1. 精简整合包环境条 + 按需展开环境设置 */}
          <div className="lab-card lab-bundle-card">
            <div className="lab-bundle-row">
              <div className="lab-bundle-lead">
                <div className={cn("lab-bundle-icon", converterStatus?.ready && "ready")}>
                  <Package size={16} />
                </div>
                <div className="lab-bundle-text">
                  <div className="lab-bundle-title-row">
                    <h3>{t("convert.bundleTitle")}</h3>
                    {converterStatus?.ready ? (
                      <span className="convert-pill ok">
                        <Check size={11} />
                        {converterStatus.localVersion
                          ? t("convert.bundleReady", { version: converterStatus.localVersion })
                          : t("convert.bundleReadyUnknown")}
                      </span>
                    ) : converterStatus?.installed ? (
                      <span className="convert-pill warn">{t("convert.bundleIncomplete")}</span>
                    ) : (
                      <span className="convert-pill neutral">{t("convert.bundleMissing")}</span>
                    )}
                    {hasRemoteUpdate && remoteRelease?.tag && (
                      <span className="convert-pill warn">
                        {t("convert.bundleUpdateAvailable", { tag: remoteRelease.tag })}
                      </span>
                    )}
                  </div>
                  <p className="lab-bundle-sub">{bundleSummaryLine}</p>
                </div>
              </div>

              <div className="lab-bundle-actions">
                {downloadingBundle ? (
                  <button
                    type="button"
                    className="secondary-button compact"
                    onClick={onCancelDownload}
                  >
                    {t("convert.cancelDownload")}
                  </button>
                ) : needsPrimaryDownload ? (
                  <>
                    <button
                      type="button"
                      className="primary-button compact"
                      disabled={converting}
                      onClick={() => void onDownloadBundle(repoInput)}
                    >
                      <Download size={13} />
                      {hasRemoteUpdate && remoteRelease?.tag
                        ? t("convert.updateBundle", { tag: remoteRelease.tag })
                        : remoteRelease?.tag
                          ? t("convert.downloadBundleTag", { tag: remoteRelease.tag })
                          : t("convert.downloadBundle")}
                    </button>
                    {!converterStatus?.ready && (
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={converting}
                        onClick={() => void onImportBundleZip()}
                      >
                        <HardDriveDownload size={12} />
                        {t("convert.importZip")}
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary-button compact"
                    disabled={checkingRelease || converting}
                    onClick={() => void onCheckRelease(repoInput)}
                  >
                    <RefreshCw size={12} className={cn(checkingRelease && "spin")} />
                    {t("convert.checkRelease")}
                  </button>
                )}

                <button
                  type="button"
                  className={cn("secondary-button compact", bundleSettingsOpen && "active")}
                  onClick={() => setBundleSettingsOpen((v) => !v)}
                  aria-expanded={bundleSettingsOpen}
                >
                  <SlidersHorizontal size={12} />
                  <span>{t("convert.bundleManage")}</span>
                  {bundleSettingsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              </div>
            </div>

            {downloadingBundle && downloadProgress && (
              <div className="convert-progress-wrap">
                <div className="convert-progress-bar">
                  <div style={{ width: `${Math.min(100, downloadProgress.percent)}%` }} />
                </div>
                <div className="convert-progress-meta">
                  <span>{downloadProgress.message || downloadProgress.phase}</span>
                  <span>{[dlSize, dlSpeed].filter(Boolean).join(" · ") || `${downloadProgress.percent}%`}</span>
                </div>
              </div>
            )}

            {bundleError && <div className="convert-alert">{bundleError}</div>}

            {bundleSettingsOpen && (
              <div className="lab-bundle-drawer">
                <div className="lab-bundle-drawer-grid">
                  <div className="lab-bundle-setting">
                    <span className="lab-setting-label">{t("convert.localVersionLabel")}</span>
                    <div className="lab-setting-value-row">
                      <span className="lab-setting-mono">
                        {converterStatus?.ready
                          ? converterStatus.localVersion || t("convert.versionUnknown")
                          : t("convert.notInstalledShort")}
                        {converterStatus?.upstreamCommit
                          ? ` · ${converterStatus.upstreamCommit.slice(0, 7)}`
                          : ""}
                      </span>
                      <span className="lab-setting-muted">
                        / {t("convert.remoteVersionLabel")}:{" "}
                        {checkingRelease
                          ? t("convert.checkingVersion")
                          : remoteRelease
                            ? `${remoteRelease.tag}${remoteRelease.assetSize ? ` (${formatBytes(remoteRelease.assetSize)})` : ""}`
                            : t("convert.versionNotChecked")}
                      </span>
                    </div>
                  </div>

                  <div className="lab-bundle-setting">
                    <span className="lab-setting-label">{t("convert.installDirLabel")}</span>
                    <div className="lab-setting-value-row">
                      <span
                        className="lab-setting-mono truncate"
                        title={converterStatus?.installDir || ""}
                      >
                        {converterStatus?.installDir || "—"}
                      </span>
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={downloadingBundle || converting}
                        onClick={() => void onPickBundleDir()}
                      >
                        <FolderOpen size={12} />
                        {t("convert.pickDir")}
                      </button>
                    </div>
                  </div>

                  <div className="lab-bundle-setting full">
                    <div className="lab-setting-label-row">
                      <span className="lab-setting-label">{t("convert.repoShortLabel")}</span>
                      <span className="lab-setting-hint">
                        {t("convert.bundleDefaultRepoHint", { repo: DEFAULT_NINFER_CONVERTER_REPO })}
                      </span>
                    </div>
                    <div className="lab-repo-controls">
                      <input
                        className="convert-input"
                        value={repoInput}
                        onChange={(e) => setRepoInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          void onSaveRepo(repoInput).then((saved) => {
                            if (saved) setRepoInput(saved);
                          });
                        }}
                        placeholder={DEFAULT_NINFER_CONVERTER_REPO}
                        disabled={downloadingBundle || converting}
                        aria-label={t("convert.repoLabel")}
                      />
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={downloadingBundle || converting}
                        onClick={() =>
                          void onSaveRepo(repoInput).then((saved) => {
                            if (saved) setRepoInput(saved);
                          })
                        }
                      >
                        {t("convert.saveRepo")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={downloadingBundle || converting || isRepoInputDefault}
                        title={t("convert.resetRepoTitle", { repo: DEFAULT_NINFER_CONVERTER_REPO })}
                        onClick={() =>
                          void onResetRepo().then((restored) => {
                            if (restored) setRepoInput(restored);
                          })
                        }
                      >
                        <RotateCcw size={12} />
                        {t("convert.resetRepo")}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="lab-bundle-drawer-foot">
                  <div className="convert-actions-group">
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={checkingRelease || downloadingBundle || converting}
                      onClick={() => void onCheckRelease(repoInput)}
                    >
                      <RefreshCw size={12} className={cn(checkingRelease && "spin")} />
                      {t("convert.checkRelease")}
                    </button>
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={downloadingBundle || converting}
                      onClick={() => void onImportBundleZip()}
                    >
                      <HardDriveDownload size={12} />
                      {t("convert.importZip")}
                    </button>
                  </div>

                  {converterStatus?.installed && (
                    <button
                      type="button"
                      className="convert-danger-ghost"
                      disabled={downloadingBundle || converting}
                      onClick={() => void onUninstallBundle()}
                    >
                      <Trash2 size={12} />
                      {t("convert.uninstallBundle")}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 2. 当前后台/收起的转换任务快捷恢复卡 */}
          {activeTargetModel && (minimized || converting || convertResult || convertError) && (
            <div className="lab-active-task-card">
              <div className="lab-active-task-head">
                <div className="lab-active-task-info">
                  {converting ? (
                    <Loader2 size={16} className="spin" />
                  ) : convertResult ? (
                    <Check size={16} />
                  ) : convertError ? (
                    <AlertTriangle size={16} />
                  ) : (
                    <ArrowRightLeft size={16} />
                  )}
                  <div className="lab-active-task-text">
                    <strong>{modelTitle(activeTargetModel)}</strong>
                    <span>
                      {converting
                        ? t("lab.activeTaskConverting", {
                            msg: convertProgress?.message || t("convert.converting"),
                            percent: convertProgress?.percent ?? 0,
                          })
                        : convertResult
                          ? t("lab.activeTaskDone", { path: fileName(convertResult.outputPath) })
                          : convertError
                            ? t("lab.activeTaskFailed", { error: convertError })
                            : t("lab.activeTaskMinimized")}
                    </span>
                  </div>
                </div>
                <div className="lab-card-actions">
                  <button
                    type="button"
                    className="primary-button compact"
                    onClick={onExpandConvert}
                  >
                    <Maximize2 size={13} />
                    {t("lab.expandTaskBtn")}
                  </button>
                  {!converting && (
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={onCloseConvert}
                      title={t("lab.dismissTaskBtn")}
                    >
                      <X size={13} />
                      {t("lab.dismissTaskBtn")}
                    </button>
                  )}
                </div>
              </div>
              {converting && convertProgress && (
                <div className="convert-progress-wrap">
                  <div className="convert-progress-bar">
                    <div style={{ width: `${Math.min(100, convertProgress.percent)}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 3. 模型仓库中的 GGUF 模型 / 转换记录（舒展两行卡片） */}
          <div className="lab-card">
            {convertSubView === "models" ? (
              <>
                <div className="lab-toolbar">
                  <div className="lab-card-title">
                    <div className="lab-title-line">
                      <h3>{t("lab.libraryGgufTitle")}</h3>
                      <span className="lab-title-count">
                        {t("lab.libraryGgufCount", { count: totalGgufCount })}
                      </span>
                    </div>
                    <span className="lab-count-tag">{t("lab.convertShortNote")}</span>
                  </div>
                  <div className="lab-card-actions">
                    {totalGgufCount > 3 && (
                      <label className="search-box">
                        <Search size={14} />
                        <input
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder={t("lab.searchPlaceholder")}
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      className="secondary-button compact lab-history-entry-btn"
                      onClick={() => setConvertSubView("history")}
                    >
                      <History size={13} />
                      <span>{t("lab.tabHistory")}</span>
                      {history.length > 0 && <em className="lab-history-badge">{history.length}</em>}
                    </button>
                  </div>
                </div>

                <div className="lab-compat-banner">
                  <Info size={14} />
                  <span>{t("lab.compatNotice")}</span>
                </div>

                {ggufModels.length > 0 ? (
                  <div className="lab-model-list">
                    {ggufModels.map((model) => {
                      const defaultProfile =
                        model.profiles.find((p) => p.id === model.defaultProfileId) || model.profiles[0];
                      const hasBoundVision = Boolean(defaultProfile?.mmprojPath?.trim());
                      const prevSuccess = latestSuccessBySource.get(normalizePathKey(model.path));
                      const prevExists = Boolean(
                        prevSuccess && existingOutputs.has(normalizePathKey(prevSuccess.outputPath)),
                      );
                      const isThisActive = activeTargetModel?.id === model.id;
                      const busyOther = converting && !isThisActive;
                      return (
                        <div key={model.id} className="lab-model-row">
                          <div className="lab-model-main">
                            <ModelFormatBadge isNinfer={false} compact />
                            <div className="lab-model-info">
                              <div className="lab-model-title">
                                <strong>{modelTitle(model)}</strong>
                                {prevSuccess && (
                                  <button
                                    type="button"
                                    className={cn("lab-converted-chip", !prevExists && "past")}
                                    title={
                                      prevExists
                                        ? t("lab.convertedChipTitle", { path: prevSuccess.outputPath })
                                        : t("lab.convertedPastTitle", { path: prevSuccess.outputPath })
                                    }
                                    onClick={() => setConvertSubView("history")}
                                  >
                                    <Check size={11} />
                                    {prevExists ? t("lab.convertedChip") : t("lab.convertedPastChip")}
                                  </button>
                                )}
                                {hasBoundVision && (
                                  <span
                                    className="lab-vision-chip"
                                    title={defaultProfile?.mmprojPath}
                                  >
                                    {t("lab.visionLinkedChip")}
                                  </span>
                                )}
                              </div>
                              <div className="lab-model-meta">
                                {model.parameters && model.parameters !== "—" && (
                                  <>
                                    <span>{model.parameters}</span>
                                    <span>·</span>
                                  </>
                                )}
                                <span>{model.quantization}</span>
                                <span>·</span>
                                <span>
                                  <HardDrive size={11} />
                                  {formatBytes(model.sizeBytes)}
                                </span>
                                {model.splitInfo && (
                                  <>
                                    <span>·</span>
                                    <span>
                                      <Layers3 size={11} />
                                      {t("convert.splitSummary", {
                                        found: model.splitInfo.found,
                                        total: model.splitInfo.total,
                                      })}
                                    </span>
                                  </>
                                )}
                                <span>·</span>
                                <span className="lab-model-short-path" title={model.path}>
                                  {compactFilePath(model.path)}
                                </span>
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="secondary-button lab-convert-btn"
                            disabled={busyOther}
                            title={busyOther ? t("lab.convertingBusyHint") : undefined}
                            onClick={() => (isThisActive ? onExpandConvert() : onOpenConvert(model))}
                          >
                            {isThisActive && converting ? (
                              <Loader2 size={14} className="spin" />
                            ) : (
                              <ArrowRightLeft size={14} />
                            )}
                            {isThisActive && converting
                              ? t("lab.viewProgressBtn")
                              : isThisActive && minimized
                                ? t("convert.expand")
                                : prevSuccess
                                  ? t("lab.reconvertBtn")
                                  : t("lab.convertBtn")}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="lab-empty">
                    <ArrowRightLeft size={22} />
                    <p>{totalGgufCount === 0 ? t("lab.emptyGguf") : t("lab.emptySearch")}</p>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="lab-toolbar">
                  <div className="lab-card-title">
                    <div className="lab-title-line">
                      <h3>{t("lab.historyTitle")}</h3>
                    </div>
                    <span className="lab-count-tag">
                      {t("lab.historyCount", { count: history.length })}
                    </span>
                  </div>
                  <div className="lab-card-actions">
                    {history.length > 0 && (
                      <button
                        type="button"
                        className="secondary-button compact"
                        onClick={() => void onClearHistory()}
                      >
                        <Trash2 size={12} />
                        {t("lab.clearHistory")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={() => setConvertSubView("models")}
                    >
                      <ArrowLeft size={13} />
                      {t("lab.backToModels")}
                    </button>
                  </div>
                </div>

                {history.length > 0 ? (
                  <div className="lab-history-list">
                    {history.map((item) => {
                      const isOk = item.status === "success";
                      const outputExists = Boolean(
                        isOk && existingOutputs.has(normalizePathKey(item.outputPath)),
                      );
                      const dur = formatDuration(item.durationSec);
                      return (
                        <div key={item.id} className="lab-history-row">
                          <div className="lab-history-head">
                            <div className="lab-history-title">
                              <span className={cn("convert-pill", isOk ? "ok" : "err")}>
                                {isOk ? <Check size={11} /> : <AlertTriangle size={11} />}
                                {isOk ? t("lab.historySuccess") : t("lab.historyFailed")}
                              </span>
                              <strong>{item.sourceName || fileName(item.sourcePath)}</strong>
                              {item.includeMtp && <span className="convert-pill neutral">MTP</span>}
                              {item.visionPath && (
                                <span className="convert-pill neutral">{t("lab.historyVisionTag")}</span>
                              )}
                            </div>
                            <div className="lab-history-actions">
                              {isOk && item.sizeBytes ? (
                                <span className="lab-history-meta-text">{formatBytes(item.sizeBytes)}</span>
                              ) : null}
                              {dur && (
                                <span className="lab-history-meta-text">
                                  <Clock size={11} />
                                  {dur}
                                </span>
                              )}
                              <span className="lab-history-time">{formatHistoryTime(item.createdAt)}</span>
                              {outputExists && (
                                <button
                                  type="button"
                                  className="secondary-button compact"
                                  onClick={() => void revealInFolder(item.outputPath)}
                                >
                                  <FolderOpen size={12} />
                                  {t("convert.revealOutput")}
                                </button>
                              )}
                              <button
                                type="button"
                                className="secondary-button compact"
                                disabled={converting}
                                onClick={() => void handleReconvertHistory(item)}
                              >
                                <ArrowRightLeft size={12} />
                                {t("lab.reconvertBtn")}
                              </button>
                              <button
                                type="button"
                                className="ghost-icon"
                                title={t("lab.deleteHistoryItem")}
                                aria-label={t("lab.deleteHistoryItem")}
                                onClick={() => void onDeleteHistory(item.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>

                          <div className="lab-history-path-summary">
                            <span title={item.sourcePath}>{compactFilePath(item.sourcePath)}</span>
                            <span className="lab-history-arrow" aria-hidden="true">→</span>
                            <span title={item.outputPath}>{compactFilePath(item.outputPath)}</span>
                            {isOk && !outputExists && (
                              <em className="lab-history-missing">{t("lab.historyOutputMissing")}</em>
                            )}
                          </div>

                          {!isOk && item.error && <div className="convert-alert">{item.error}</div>}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="lab-empty">
                    <History size={22} />
                    <p>{t("lab.historyEmpty")}</p>
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={() => setConvertSubView("models")}
                    >
                      <ArrowLeft size={13} />
                      {t("lab.backToModels")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
