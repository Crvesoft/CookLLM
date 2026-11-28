import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Info,
  Layers3,
  Loader2,
  Minimize2,
  Package,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  pickDirectory,
  pickFiles,
  pickNinferOutputFile,
  revealInFolder,
} from "../tauri";
import type {
  HfModel,
  ModelAsset,
  NinferAuxConfigFetchResult,
  NinferConvertInspection,
  NinferConvertLogEvent,
  NinferConvertOptions,
  NinferConvertProgress,
  NinferConvertResult,
  NinferConverterStatus,
} from "../types";
import { cn, formatBytes, modelTitle } from "../utils";

type AuxMode = "fetch" | "auto" | "local";

function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function looksLikeQuantRepo(id: string): boolean {
  return /[-_](gguf|ninfer|exl2|mlx|awq|gptq)$/i.test(id.trim());
}

function resolvePresetVisionSource(
  model: ModelAsset,
  selectedProfileId?: string,
): { path: string; profileName: string } | null {
  const defaultProfile =
    model.profiles.find((p) => p.id === model.defaultProfileId) || model.profiles[0];
  if (defaultProfile?.mmprojPath?.trim()) {
    return {
      path: defaultProfile.mmprojPath.trim(),
      profileName: defaultProfile.name,
    };
  }
  if (selectedProfileId) {
    const active = model.profiles.find((p) => p.id === selectedProfileId);
    if (active?.mmprojPath?.trim()) {
      return {
        path: active.mmprojPath.trim(),
        profileName: active.name,
      };
    }
  }
  return null;
}

interface Props {
  model: ModelAsset;
  selectedProfileId?: string;
  minimized: boolean;
  converterStatus: NinferConverterStatus | null;
  downloadingBundle: boolean;
  inspecting: boolean;
  inspection: NinferConvertInspection | null;
  inspectError: string | null;
  fetchingAux: boolean;
  auxFetchResult: NinferAuxConfigFetchResult | null;
  auxFetchError: string | null;
  searchingAux: boolean;
  auxSearchResults: HfModel[];
  auxSearchError: string | null;
  auxSearchQueried: boolean;
  converting: boolean;
  convertProgress: NinferConvertProgress | null;
  convertLogs: NinferConvertLogEvent[];
  convertError: string | null;
  convertResult: NinferConvertResult | null;
  onMinimize: () => void;
  onGoLabBundle?: () => void;
  onClose: () => void;
  onSearchAuxRepos: (query: string, source: "hf" | "ms") => Promise<HfModel[]>;
  onClearAuxSearch: () => void;
  onFetchAux: (repo: string, source: "hf" | "ms") => Promise<NinferAuxConfigFetchResult | null>;
  onStartConvert: (options: NinferConvertOptions, autoImport: boolean) => Promise<NinferConvertResult | null>;
  onCancelConvert: () => void;
}

function defaultOutputPath(ggufPath: string): string {
  const norm = ggufPath.trim();
  const slash = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  const dir = slash >= 0 ? norm.slice(0, slash + 1) : "";
  const file = slash >= 0 ? norm.slice(slash + 1) : norm;
  const stem = file
    .replace(/[-_]\d+[-_]of[-_]\d+\.gguf$/i, "")
    .replace(/\.gguf$/i, "");
  return `${dir}${stem || "model"}.ninfer`;
}

export default function ConvertNinferModal({
  model,
  selectedProfileId,
  minimized,
  converterStatus,
  downloadingBundle,
  inspecting,
  inspection,
  inspectError,
  fetchingAux,
  auxFetchResult,
  auxFetchError,
  searchingAux,
  auxSearchResults,
  auxSearchError,
  auxSearchQueried,
  converting,
  convertProgress,
  convertLogs,
  convertError,
  convertResult,
  onMinimize,
  onGoLabBundle,
  onClose,
  onSearchAuxRepos,
  onClearAuxSearch,
  onFetchAux,
  onStartConvert,
  onCancelConvert,
}: Props) {
  const { t } = useI18n();
  const [auxMode, setAuxMode] = useState<AuxMode>("fetch");
  const [auxRepo, setAuxRepo] = useState("Qwen/Qwen3.8-27B");
  const [auxSource, setAuxSource] = useState<"hf" | "ms">("hf");
  const [localAuxDir, setLocalAuxDir] = useState("");
  const [autoFallback, setAutoFallback] = useState(true);

  const [outputPath, setOutputPath] = useState(() => defaultOutputPath(model.path));
  const [instanceName, setInstanceName] = useState(() => modelTitle(model));
  const [includeMtp, setIncludeMtp] = useState(true);
  const [proposal, setProposal] = useState(true);
  const [autoImport, setAutoImport] = useState(true);

  const autoVisionSource = useMemo(
    () => resolvePresetVisionSource(model, selectedProfileId),
    [model, selectedProfileId],
  );
  const userEditedVisionRef = useRef(false);
  const progressCardRef = useRef<HTMLDivElement | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [visionPath, setVisionPath] = useState(() => autoVisionSource?.path ?? "");
  const [dflash2Path, setDflash2Path] = useState("");
  const [chatTemplatePath, setChatTemplatePath] = useState("");
  const [recipe, setRecipe] = useState("auto");
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    if (converting) {
      progressCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [converting]);

  useEffect(() => {
    userEditedVisionRef.current = false;
    setVisionPath(resolvePresetVisionSource(model, selectedProfileId)?.path ?? "");
    setOutputPath(defaultOutputPath(model.path));
    setInstanceName(modelTitle(model));
  }, [model.id]);

  useEffect(() => {
    if (!userEditedVisionRef.current && autoVisionSource?.path && !visionPath) {
      setVisionPath(autoVisionSource.path);
    }
  }, [autoVisionSource?.path, visionPath]);

  useEffect(() => {
    if (inspection?.recommendedHfRepo) {
      setAuxRepo(inspection.recommendedHfRepo);
    }
    if (inspection && !inspection.hasMtp) {
      setIncludeMtp(false);
    } else if (inspection?.hasMtp) {
      setIncludeMtp(true);
    }
  }, [inspection]);

  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (converting || downloadingBundle) {
        onMinimize();
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [converting, downloadingBundle, minimized, onClose, onMinimize]);

  const effectiveAuxDir = useMemo(() => {
    if (auxMode === "fetch") return auxFetchResult?.dir || "";
    if (auxMode === "local") return localAuxDir.trim();
    return "";
  }, [auxMode, auxFetchResult, localAuxDir]);

  const auxReady = useMemo(() => {
    if (auxMode === "auto") return Boolean(inspection?.hasTokenizerKv);
    if (auxMode === "fetch") {
      if (!auxFetchResult) return false;
      if (auxFetchResult.missingRequired.length === 0) return true;
      return autoFallback && Boolean(inspection?.hasTokenizerKv);
    }
    return Boolean(localAuxDir.trim());
  }, [auxMode, auxFetchResult, autoFallback, inspection?.hasTokenizerKv, localAuxDir]);

  const startBlockerReason = useMemo(() => {
    if (convertResult || converting) return null;
    if (inspecting) return t("convert.blockerInspecting");
    if (!inspection?.compatible) return t("convert.blockerIncompatible");
    if (!converterStatus?.ready) return t("convert.blockerBundle");
    if (auxMode === "fetch" && !auxFetchResult) return t("convert.blockerAuxFetch");
    if (auxMode === "fetch" && !auxReady) return t("convert.blockerAuxIncomplete");
    if (auxMode === "local" && !localAuxDir.trim()) return t("convert.blockerAuxLocal");
    if (auxMode === "auto" && !inspection?.hasTokenizerKv) return t("convert.blockerAuxAuto");
    if (!outputPath.trim()) return t("convert.blockerOutput");
    return null;
  }, [
    auxFetchResult,
    auxMode,
    auxReady,
    convertResult,
    converterStatus?.ready,
    converting,
    inspecting,
    inspection?.compatible,
    inspection?.hasTokenizerKv,
    localAuxDir,
    outputPath,
    t,
  ]);

  const canStart = Boolean(
    !inspecting &&
      inspection?.compatible &&
      converterStatus?.ready &&
      outputPath.trim() &&
      auxReady &&
      !converting &&
      !downloadingBundle &&
      !convertResult,
  );

  const showContextualFallback = Boolean(
    inspection?.hasTokenizerKv &&
      (auxMode === "local" || (auxMode === "fetch" && Boolean(auxFetchResult?.missingRequired.length))),
  );

  const handleBrowseOutput = async () => {
    const slash = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
    const dir = slash >= 0 ? outputPath.slice(0, slash) : undefined;
    const name = slash >= 0 ? outputPath.slice(slash + 1) : outputPath;
    const chosen = await pickNinferOutputFile(name || "model.ninfer", dir);
    if (chosen) setOutputPath(chosen);
  };

  const handlePickLocalAux = async () => {
    const dir = await pickDirectory();
    if (dir) setLocalAuxDir(dir);
  };

  const handlePickVision = async () => {
    const picked = await pickFiles(["gguf"]);
    if (picked[0]?.path) {
      userEditedVisionRef.current = true;
      setVisionPath(picked[0].path);
    }
  };

  const handlePickDflash2 = async () => {
    const picked = await pickFiles(["gguf", "safetensors"]);
    if (picked[0]?.path) setDflash2Path(picked[0].path);
  };

  const handlePickTemplate = async () => {
    const picked = await pickFiles(["jinja", "txt"]);
    if (picked[0]?.path) setChatTemplatePath(picked[0].path);
  };

  const handleStart = async () => {
    if (!canStart) return;
    setShowLogs(true);
    await onStartConvert(
      {
        ggufPath: model.path,
        outputPath: outputPath.trim(),
        instanceName: instanceName.trim() || undefined,
        auxDir: effectiveAuxDir || undefined,
        autoReconstruct: auxMode === "auto" || autoFallback,
        includeMtp,
        visionPath: visionPath.trim() || undefined,
        dflash2Path: dflash2Path.trim() || undefined,
        chatTemplatePath: chatTemplatePath.trim() || undefined,
        proposal,
        recipe: recipe === "auto" ? undefined : recipe,
      },
      autoImport,
    );
  };

  const fullMetaTooltip = inspection
    ? t("convert.metaSummary", {
        arch: inspection.architecture || "—",
        layers: inspection.blockCount,
        hidden: inspection.hiddenSize,
        heads: inspection.attentionHeads,
        kvHeads: inspection.kvHeads,
        tensors: inspection.tensorCount,
      })
    : undefined;

  return (
    <div
      className={cn("modal-backdrop", minimized && "is-minimized")}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (converting || downloadingBundle) {
          onMinimize();
        } else {
          onClose();
        }
      }}
    >
      <section className="convert-modal" role="dialog" aria-modal="true">
        <header>
          <div className="convert-icon-tile">
            <ArrowRightLeft size={19} />
          </div>
          <div className="auto-head-text">
            <div className="auto-head-tagline">
              <span>{t("convert.tag")}</span>
              <span className="convert-format-tag">GGUF</span>
            </div>
            <h2 title={modelTitle(model)}>{t("convert.heading", { model: modelTitle(model) })}</h2>
          </div>
          <div className="auto-head-spacer" />
          <button
            type="button"
            className="secondary-button compact convert-collapse-btn"
            onClick={onMinimize}
            title={t("convert.minimizeHint")}
          >
            <Minimize2 size={13} />
            {t("convert.minimize")}
          </button>
          <button
            className="ghost-icon"
            aria-label={t("ariaClose")}
            disabled={converting || downloadingBundle}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="convert-body">
          {!converterStatus?.ready && (
            <div className="convert-alert warn convert-alert-inline">
              <Package size={14} />
              <span style={{ flex: 1 }}>{t("convert.bundleMissingModalHint")}</span>
              <button
                type="button"
                className="convert-inline-link"
                onClick={() => (onGoLabBundle ? onGoLabBundle() : onMinimize())}
              >
                {t("convert.bundleGoInstall")}
              </button>
            </div>
          )}

          {/* 精简预检条：兼容时收成单行，不兼容/有告警再展开 */}
          <div className="convert-preflight-strip" title={fullMetaTooltip}>
            {inspecting ? (
              <span className="convert-preflight-status">
                <Loader2 size={13} className="spin" />
                {t("convert.checking")}
              </span>
            ) : inspection?.compatible ? (
              <>
                <span className="convert-pill ok">
                  <Check size={11} />
                  {t("convert.compatibleShort")}
                </span>
                <span className="convert-preflight-meta">
                  {t("convert.preflightCompact", {
                    arch: inspection.architecture || "—",
                    layers: inspection.blockCount,
                    hidden: inspection.hiddenSize,
                  })}
                </span>
                {inspection.hasMtp && (
                  <span className="convert-pill neutral">{t("convert.mtpShort")}</span>
                )}
                {inspection.splitInfo && (
                  <span className="convert-pill neutral">
                    <Layers3 size={11} />
                    {t("convert.splitSummary", {
                      found: inspection.splitInfo.found,
                      total: inspection.splitInfo.total,
                    })}
                  </span>
                )}
              </>
            ) : (
              <span className="convert-pill err">
                <AlertTriangle size={12} />
                {t("convert.incompatible")}
              </span>
            )}
          </div>

          {inspectError && <div className="convert-alert">{inspectError}</div>}
          {inspection?.blockReason && <div className="convert-alert">{inspection.blockReason}</div>}
          {inspection?.warnings.map((w) => (
            <div key={w} className="convert-alert warn">
              {w}
            </div>
          ))}

          {/* 步骤 1. 辅助配置文件来源 */}
          {inspection?.compatible && (
            <div className="convert-card">
              <div className="convert-card-head">
                <div className="convert-step-title">
                  <span className="convert-step-num">1</span>
                  <h3>{t("convert.auxTitle")}</h3>
                  {auxReady && (
                    <span className="convert-pill ok">
                      <Check size={11} />
                      {t("convert.auxReadyTag")}
                    </span>
                  )}
                </div>
                <div className="convert-seg" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={auxMode === "fetch"}
                    className={cn(auxMode === "fetch" && "active")}
                    disabled={converting}
                    onClick={() => setAuxMode("fetch")}
                  >
                    {t("convert.auxModeFetch")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={auxMode === "auto"}
                    className={cn(auxMode === "auto" && "active")}
                    disabled={converting}
                    onClick={() => setAuxMode("auto")}
                  >
                    {t("convert.auxModeAuto")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={auxMode === "local"}
                    className={cn(auxMode === "local" && "active")}
                    disabled={converting}
                    onClick={() => setAuxMode("local")}
                  >
                    {t("convert.auxModeLocal")}
                  </button>
                </div>
              </div>

              {auxMode === "fetch" && (
                <>
                  <div className="convert-row">
                    <div className="convert-seg">
                      <button
                        type="button"
                        className={cn(auxSource === "hf" && "active")}
                        disabled={searchingAux || fetchingAux || converting}
                        onClick={() => {
                          setAuxSource("hf");
                          onClearAuxSearch();
                        }}
                      >
                        HuggingFace
                      </button>
                      <button
                        type="button"
                        className={cn(auxSource === "ms" && "active")}
                        disabled={searchingAux || fetchingAux || converting}
                        onClick={() => {
                          setAuxSource("ms");
                          onClearAuxSearch();
                        }}
                      >
                        ModelScope
                      </button>
                    </div>
                    <input
                      className="convert-input"
                      value={auxRepo}
                      onChange={(e) => setAuxRepo(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        const q = auxRepo.trim();
                        if (!q) return;
                        if (q.includes("/") && !q.includes(" ")) {
                          void onFetchAux(q, auxSource);
                        } else {
                          void onSearchAuxRepos(q, auxSource);
                        }
                      }}
                      placeholder={t("convert.auxRepoPlaceholder")}
                      disabled={fetchingAux || converting}
                    />
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={searchingAux || fetchingAux || converting || !auxRepo.trim()}
                      onClick={() => void onSearchAuxRepos(auxRepo, auxSource)}
                    >
                      {searchingAux ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
                      {searchingAux ? t("convert.auxSearching") : t("convert.auxSearchBtn")}
                    </button>
                    <button
                      type="button"
                      className={cn(auxFetchResult ? "secondary-button compact" : "primary-button compact")}
                      disabled={fetchingAux || converting || !auxRepo.trim()}
                      onClick={() => void onFetchAux(auxRepo, auxSource)}
                    >
                      {fetchingAux ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                      {fetchingAux ? t("convert.auxFetching") : t("convert.auxFetchBtn")}
                    </button>
                  </div>

                  {!auxFetchResult && !auxFetchError && !fetchingAux && (
                    <div className="convert-step-tip">
                      <ArrowRight size={13} />
                      <span>{t("convert.auxPendingHint")}</span>
                    </div>
                  )}

                  {auxSearchError && <div className="convert-alert">{auxSearchError}</div>}

                  {(auxSearchResults.length > 0 || (auxSearchQueried && !searchingAux && !auxSearchError)) && (
                    <div className="convert-search-box">
                      <div className="convert-search-head">
                        <span>{t("convert.auxSearchResults", { count: auxSearchResults.length })}</span>
                        <button
                          type="button"
                          className="convert-inline-link"
                          onClick={onClearAuxSearch}
                        >
                          {t("convert.auxSearchCollapse")}
                        </button>
                      </div>
                      {auxSearchResults.length === 0 ? (
                        <div className="convert-search-empty">{t("convert.auxSearchEmpty")}</div>
                      ) : (
                        <div className="convert-search-list">
                          {auxSearchResults.map((item) => {
                            const selected = auxRepo.trim().toLowerCase() === item.id.toLowerCase();
                            const quantRepo = looksLikeQuantRepo(item.id);
                            return (
                              <button
                                key={item.id}
                                type="button"
                                className={cn("convert-search-item", selected && "active")}
                                disabled={fetchingAux || converting}
                                onClick={() => setAuxRepo(item.id)}
                              >
                                <span className="convert-search-id">
                                  <span title={item.id}>{item.id}</span>
                                  {quantRepo && (
                                    <span className="convert-pill neutral">{t("convert.auxRepoQuantTag")}</span>
                                  )}
                                </span>
                                <span className="convert-search-meta">
                                  {item.downloads > 0 && <span>↓{formatCompactCount(item.downloads)}</span>}
                                  {item.likes > 0 && <span>♥{formatCompactCount(item.likes)}</span>}
                                  {selected && <Check size={12} />}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {auxFetchError && <div className="convert-alert">{auxFetchError}</div>}

                  {auxFetchResult && (
                    <div className="convert-aux-feedback">
                      <div
                        className="convert-alert ok convert-alert-inline"
                        title={auxFetchResult.files.join(", ")}
                      >
                        <Check size={14} />
                        <div className="convert-aux-summary-text">
                          <strong>
                            {auxFetchResult.repo
                              ? t("convert.auxFetchedFrom", {
                                  count: auxFetchResult.files.length,
                                  repo: auxFetchResult.repo,
                                })
                              : t("convert.auxFetched", { count: auxFetchResult.files.length })}
                          </strong>
                          <span className="convert-aux-files-inline">
                            {auxFetchResult.files.join(", ")}
                          </span>
                        </div>
                      </div>
                      {auxFetchResult.missingRequired.length > 0 && (
                        <div className="convert-alert warn convert-alert-inline">
                          <AlertTriangle size={14} />
                          <span>
                            {autoFallback && inspection.hasTokenizerKv
                              ? t("convert.auxMissing", {
                                  files: auxFetchResult.missingRequired.join(", "),
                                })
                              : inspection.hasTokenizerKv
                                ? t("convert.auxMissingNeedFallback", {
                                    files: auxFetchResult.missingRequired.join(", "),
                                  })
                                : t("convert.auxMissingFatal", {
                                    files: auxFetchResult.missingRequired.join(", "),
                                  })}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {auxMode === "auto" && (
                <>
                  <p className="convert-hint">{t("convert.auxAutoHint")}</p>
                  {!inspection.hasTokenizerKv && (
                    <div className="convert-alert">{t("convert.auxAutoNoTok")}</div>
                  )}
                </>
              )}

              {auxMode === "local" && (
                <>
                  <div className="convert-row">
                    <input
                      className="convert-input"
                      value={localAuxDir}
                      onChange={(e) => setLocalAuxDir(e.target.value)}
                      placeholder={t("convert.auxLocalHint")}
                      disabled={converting}
                    />
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={converting}
                      onClick={() => void handlePickLocalAux()}
                    >
                      <FolderOpen size={12} />
                      {t("convert.auxPickLocal")}
                    </button>
                  </div>
                </>
              )}

              {showContextualFallback && (
                <label className="convert-check">
                  <input
                    type="checkbox"
                    checked={autoFallback}
                    disabled={converting}
                    onChange={(e) => setAutoFallback(e.target.checked)}
                  />
                  {t("convert.auxAutoFallback")}
                </label>
              )}
            </div>
          )}

          {/* 步骤 2. 输出设置与选项 */}
          {inspection?.compatible && (
            <div className="convert-card">
              <div className="convert-card-head">
                <div className="convert-step-title">
                  <span className="convert-step-num">2</span>
                  <h3>{t("convert.outputSection")}</h3>
                </div>
                <button
                  type="button"
                  className="convert-link-btn"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {t("convert.advancedToggle")}
                  {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              </div>

              <div className="convert-grid">
                <div className="convert-field full">
                  <label>{t("convert.outputPath")}</label>
                  <div className="convert-row">
                    <input
                      className="convert-input"
                      value={outputPath}
                      onChange={(e) => setOutputPath(e.target.value)}
                      disabled={converting}
                    />
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={converting}
                      onClick={() => void handleBrowseOutput()}
                    >
                      {t("convert.browse")}
                    </button>
                  </div>
                </div>

                <div className="convert-field">
                  <label>{t("convert.instanceName")}</label>
                  <input
                    className="convert-input"
                    value={instanceName}
                    onChange={(e) => setInstanceName(e.target.value)}
                    disabled={converting}
                  />
                </div>

                <div className="convert-field">
                  <div className="convert-field-label-row">
                    <label>{t("convert.visionPath")}</label>
                    {autoVisionSource && visionPath.trim() === autoVisionSource.path && (
                      <span className="convert-pill ok">
                        <Check size={11} />
                        {t("convert.visionAutoLinked", { preset: autoVisionSource.profileName })}
                      </span>
                    )}
                  </div>
                  <div className="convert-row">
                    <input
                      className="convert-input"
                      value={visionPath}
                      placeholder={t("convert.visionPlaceholder")}
                      title={visionPath || undefined}
                      onChange={(e) => {
                        userEditedVisionRef.current = true;
                        setVisionPath(e.target.value);
                      }}
                      disabled={converting}
                    />
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={converting}
                      onClick={() => void handlePickVision()}
                    >
                      {t("convert.browse")}
                    </button>
                    {visionPath && (
                      <button
                        type="button"
                        className="convert-link-btn"
                        disabled={converting}
                        onClick={() => {
                          userEditedVisionRef.current = true;
                          setVisionPath("");
                        }}
                      >
                        {t("convert.clear")}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="convert-checks-inline">
                {inspection.hasMtp && (
                  <label className="convert-check">
                    <input
                      type="checkbox"
                      checked={includeMtp}
                      disabled={converting}
                      onChange={(e) => setIncludeMtp(e.target.checked)}
                    />
                    {t("convert.includeMtp")}
                  </label>
                )}

                <label className="convert-check">
                  <input
                    type="checkbox"
                    checked={proposal}
                    disabled={converting}
                    onChange={(e) => setProposal(e.target.checked)}
                  />
                  {t("convert.includeProposal")}
                </label>

                <label className="convert-check">
                  <input
                    type="checkbox"
                    checked={autoImport}
                    disabled={converting}
                    onChange={(e) => setAutoImport(e.target.checked)}
                  />
                  {t("convert.autoImport")}
                </label>
              </div>

              {showAdvanced && (
                <div className="convert-grid convert-advanced-box">
                  <div className="convert-field">
                    <label>{t("convert.dflash2Path")}</label>
                    <div className="convert-row">
                      <input
                        className="convert-input"
                        value={dflash2Path}
                        onChange={(e) => setDflash2Path(e.target.value)}
                        disabled={converting}
                      />
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={converting}
                        onClick={() => void handlePickDflash2()}
                      >
                        {t("convert.browse")}
                      </button>
                      {dflash2Path && (
                        <button
                          type="button"
                          className="convert-link-btn"
                          disabled={converting}
                          onClick={() => setDflash2Path("")}
                        >
                          {t("convert.clear")}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="convert-field">
                    <label>{t("convert.recipeLabel")}</label>
                    <select
                      className="convert-input"
                      value={recipe}
                      disabled={converting}
                      onChange={(e) => setRecipe(e.target.value)}
                    >
                      <option value="auto">{t("convert.recipeAuto")}</option>
                      <option value="qwen3_5_dense_gguf">qwen3_5_dense_gguf (KVMem / 0.8B~27B)</option>
                      <option value="qwen3_8_27b_gguf">qwen3_8_27b_gguf (Ryan-gsq / ninfer-all)</option>
                    </select>
                  </div>

                  <div className="convert-field full">
                    <label>{t("convert.chatTemplatePath")}</label>
                    <div className="convert-row">
                      <input
                        className="convert-input"
                        value={chatTemplatePath}
                        onChange={(e) => setChatTemplatePath(e.target.value)}
                        disabled={converting}
                      />
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={converting}
                        onClick={() => void handlePickTemplate()}
                      >
                        {t("convert.browse")}
                      </button>
                      {chatTemplatePath && (
                        <button
                          type="button"
                          className="convert-link-btn"
                          disabled={converting}
                          onClick={() => setChatTemplatePath("")}
                        >
                          {t("convert.clear")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 步骤 3. 转换进度与日志 */}
          {(converting || convertProgress || convertError || convertResult) && (
            <div className="convert-card" ref={progressCardRef}>
              {convertProgress && (
                <div className="convert-progress-wrap">
                  <div className="convert-progress-bar">
                    <div style={{ width: `${Math.min(100, convertProgress.percent)}%` }} />
                  </div>
                  <div className="convert-progress-meta">
                    <span>{convertProgress.message || convertProgress.phase}</span>
                    <span>
                      {convertProgress.total > 0
                        ? `${convertProgress.current}/${convertProgress.total} (${convertProgress.percent}%)`
                        : `${convertProgress.percent}%`}
                    </span>
                  </div>
                </div>
              )}

              {convertError && <div className="convert-alert">{convertError}</div>}

              {convertResult && (
                <div className="convert-alert ok">
                  <strong>{t("convert.successTitle")}</strong>：{convertResult.outputPath} (
                  {formatBytes(convertResult.sizeBytes)})
                </div>
              )}

              {convertLogs.length > 0 && (
                <>
                  <button
                    type="button"
                    className="convert-link-btn"
                    onClick={() => setShowLogs((v) => !v)}
                  >
                    {t("convert.logsToggle", { count: convertLogs.length })}
                    {showLogs ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  {showLogs && (
                    <pre className="convert-logs">
                      {convertLogs.map((l) => l.line).join("\n")}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <footer>
          <div className="convert-footer-actions">
            {convertResult ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void revealInFolder(convertResult.outputPath)}
              >
                <FolderOpen size={14} />
                {t("convert.revealOutput")}
              </button>
            ) : converting ? (
              <div className="convert-footer-blocker converting">
                <Loader2 size={13} className="spin" />
                {convertProgress && (
                  <strong className="convert-progress-pct">{convertProgress.percent}%</strong>
                )}
                <span className="convert-footer-msg">
                  {convertProgress?.message || t("convert.converting")}
                </span>
              </div>
            ) : (
              startBlockerReason && (
                <div className="convert-footer-blocker">
                  <Info size={13} />
                  <span>{startBlockerReason}</span>
                </div>
              )
            )}
          </div>
          <div className="convert-footer-actions">
            {converting ? (
              <>
                <button type="button" className="secondary-button" onClick={onMinimize}>
                  <Minimize2 size={14} />
                  {t("convert.minimizeBg")}
                </button>
                <button type="button" className="secondary-button" onClick={onCancelConvert}>
                  {t("convert.cancelConvert")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={downloadingBundle}
                  onClick={onClose}
                >
                  {convertResult ? t("convert.doneClose") : t("convert.close")}
                </button>
                {!convertResult && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!canStart}
                    title={startBlockerReason ?? undefined}
                    onClick={() => void handleStart()}
                  >
                    <ArrowRightLeft size={14} />
                    {t("convert.start")}
                  </button>
                )}
              </>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
