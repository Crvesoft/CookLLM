import { Check, ChevronDown, Cpu, Download, Info, Loader2, RefreshCw, RotateCw, Settings, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { cancelLlamaCppUpdate, checkLlamaCppUpdate, detectHardware, downloadLlamaCpp, getLlamaCppStatus, onDownloadProgress, type DownloadProgress, type LlamaCppLocalStatus, type LlamaCppRelease } from "../../tauri";
import type { AppConfig, LlamaBackend, LlamaEngine, LlamaLogPayload } from "../../types";
import { cn, formatBytes, formatEngineBackend, formatMB, getEngineTypeDisplay } from "../../utils";

interface Props {
  config: AppConfig;
  activeEngine?: LlamaEngine;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
  onLog: (line: string, stream?: LlamaLogPayload["stream"]) => void;
  onOpenEngineHub?: () => void;
}

export default function EngineCard({ config, activeEngine, onPersist, onLog, onOpenEngineHub }: Props) {
  const { t } = useI18n();
  const [engineStatus, setEngineStatus] = useState<LlamaCppLocalStatus | null>(null);
  const [remote, setRemote] = useState<LlamaCppRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [backend, setBackend] = useState<LlamaBackend>(config.llamaBackend || "cuda");
  const [cudaVersion, setCudaVersion] = useState(config.llamaCudaVersion || "12");
  const [cudaMenuOpen, setCudaMenuOpen] = useState(false);
  const cudaMenuRef = useRef<HTMLDivElement>(null);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);

  const activeEngineType = getEngineTypeDisplay(activeEngine?.engineType, activeEngine?.path);
  const isLlamaCppEngine = activeEngineType.key === "llamacpp";

  useEffect(() => {
    if (config.llamaBackend) setBackend(config.llamaBackend);
    if (config.llamaCudaVersion) setCudaVersion(config.llamaCudaVersion);
  }, [config.llamaBackend, config.llamaCudaVersion]);

  useEffect(() => {
    if (!cudaMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (cudaMenuRef.current && !cudaMenuRef.current.contains(e.target as Node)) {
        setCudaMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCudaMenuOpen(false);
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cudaMenuOpen]);

  const refreshEngine = async (targetPath?: string) => {
    try {
      const p = targetPath ?? activeEngine?.path ?? config.serverPath;
      const [hw, st] = await Promise.all([
        detectHardware(),
        getLlamaCppStatus(p || undefined),
      ]);
      setEngineStatus(st);
      if (config.llamaBackend) {
        setBackend(config.llamaBackend);
      } else if (hw) {
        setBackend(hw.recommendedBackend);
      } else if (st?.localBackend) {
        setBackend(st.localBackend);
      }

      if (config.llamaCudaVersion) {
        setCudaVersion(config.llamaCudaVersion);
      } else if (st?.cudaVersion) {
        const major = st.cudaVersion.split(".")[0];
        if (major) setCudaVersion(major);
      }
    } catch { /* 非 Tauri 环境忽略 */ }
  };
  useEffect(() => {
    void refreshEngine(activeEngine?.path);
    void ensureRemote(undefined, undefined, true);
  }, [config.serverPath, config.activeEngineId]);

  /** 检查远程最新版本并与本地版本比对；检查更新 / 一键更新 / 强制重装三处共用的前置步骤 */
  const ensureRemote = async (
    overrideBackend?: LlamaBackend,
    overrideCuda?: string,
    silent = false
  ): Promise<LlamaCppRelease | null> => {
    const useBackend = overrideBackend ?? backend;
    const useCuda = overrideCuda ?? cudaVersion;
    setChecking(true);
    if (!silent) setEngineError(null);
    try {
      const result = await checkLlamaCppUpdate(useBackend, useCuda);
      const local = activeEngine?.version || engineStatus?.localVersion || "";
      const isSameBackend = engineStatus?.localBackend ? engineStatus.localBackend === useBackend : true;
      const upToDate = !!local && isSameBackend && result.tag.toLowerCase().endsWith(local.toLowerCase());
      const next = { ...result, upToDate };
      setRemote(next);
      return next;
    } catch (error) {
      if (!silent) setEngineError(error instanceof Error ? error.message : String(error));
      setRemote(null);
      return null;
    } finally {
      setChecking(false);
    }
  };

  const runCheck = async () => {
    if (checking) return;
    await ensureRemote();
  };

  // 从远程资产提取可用的 CUDA 主版本（去重、降序；远程尚未拉取时提供常用版本候选）
  const discoveredCuda = Array.from(
    new Set(
      (remote?.assets ?? [])
        .filter((asset) => asset.backend === "cuda" && asset.cudaVersion)
        .map((asset) => asset.cudaVersion as string)
    )
  ).sort((a, b) => Number(b) - Number(a));

  const cudaOptions = discoveredCuda.length > 0 ? discoveredCuda : ["13", "12", "11"];

  const cudaSelectOptions = cudaOptions.map((ver) => {
    const asset = remote?.assets?.find((a) => a.backend === "cuda" && a.cudaVersion === ver);
    const full = asset?.cudaFullVersion || (ver === "12" ? "12.4" : ver === "11" ? "11.8" : ver === "13" ? "13.4" : ver);
    const label = full && full !== ver ? `CUDA ${ver} (${full})` : `CUDA ${ver}`;
    return { value: ver, label, full };
  });

  const getCudaDisplayShort = () => {
    if (cudaVersion && cudaVersion !== "auto") {
      const opt = cudaSelectOptions.find((o) => o.value === cudaVersion);
      if (opt?.full) return opt.full;
      if (cudaVersion === "12") return "12.4";
      if (cudaVersion === "11") return "11.8";
      if (cudaVersion === "13") return "13.4";
      return cudaVersion;
    }
    if (engineStatus?.cudaVersion) return engineStatus.cudaVersion;
    if (activeEngine?.cudaVersion) return activeEngine.cudaVersion;
    return cudaSelectOptions[0]?.full || "12.4";
  };

  // 强制重装：忽略版本比较，直接重新下载安装（用于修复损坏文件）
  const forceReinstall = async () => {
    if (updating) return;
    if (!remote && !(await ensureRemote())) return;
    await runUpdate(backend);
  };

  const cancelUpdate = () => { void cancelLlamaCppUpdate().catch(() => undefined); };

  const runUpdate = async (useBackend: LlamaBackend) => {
    if (updating) return;
    setUpdating(true); setEngineError(null); setProgress({ phase: "download", percent: 0, downloaded: 0, total: 0, speedBps: 0, message: "" });
    let cancelled = false;
    try {
      const path = await downloadLlamaCpp({ backend: useBackend, cudaVersion, tag: remote?.tag });
      const parentDir = path.replace(/[/\\][^/\\]+$/, "");
      const newStatus = await getLlamaCppStatus(parentDir).catch(() => null);
      const installedCuda = newStatus?.cudaVersion || (useBackend === "cuda" ? getCudaDisplayShort() : undefined);
      const installedVer = newStatus?.localVersion || remote?.tag;

      let nextEngines = config.engines && config.engines.length > 0 ? [...config.engines] : [];
      if (config.activeEngineId && nextEngines.length > 0) {
        const idx = nextEngines.findIndex((e) => e.id === config.activeEngineId);
        if (idx >= 0) {
          nextEngines[idx] = {
            ...nextEngines[idx],
            path,
            backend: useBackend,
            cudaVersion: installedCuda,
            version: installedVer,
          };
        }
      } else if (nextEngines.length > 0) {
        nextEngines[0] = {
          ...nextEngines[0],
          path,
          backend: useBackend,
          cudaVersion: installedCuda,
          version: installedVer,
        };
      }
      await onPersist(
        {
          ...config,
          serverPath: path,
          llamaBackend: useBackend,
          llamaCudaVersion: cudaVersion,
          engines: nextEngines,
        },
        ""
      );
      onLog(t("llama.updated", { path }), "system");
      await refreshEngine();
      // 更新已完成：将 remote 标记为已是最新，避免按钮仍显示“立即更新”
      setRemote((prev) => (prev ? { ...prev, upToDate: true } : prev));
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      cancelled = raw.includes("取消");
      setEngineError(cancelled ? t("llama.cancelled") : raw);
      onLog(cancelled ? t("llama.cancelled") : t("llama.failed", { error: raw }), cancelled ? "system" : "stderr");
    } finally {
      setUpdating(false);
      window.setTimeout(() => setProgress(null), cancelled ? 400 : 1200);
    }
  };

  // 一键更新：未检查过则先检查；已是最新则直接返回；否则直接开始下载（不再弹确认窗）
  const startUpdate = async () => {
    if (updating) return;
    if (!remote) {
      const next = await ensureRemote();
      if (!next || next.upToDate) return;
    } else if (remote.upToDate) return;
    await runUpdate(backend);
  };
  // 订阅下载进度事件（仅 Tauri）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onDownloadProgress((payload) => {
      setProgress(payload);
      if (payload.phase === "done") {
        onLog(t("llama.progress.done"), "system");
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isUpToDate = remote !== null && remote.upToDate === true;

  const speedText = progress && progress.speedBps > 0
    ? `${formatBytes(progress.speedBps)}/s`
    : "";

  const sizeText = progress && (progress.downloaded > 0 || progress.total > 0)
    ? progress.total > 0
      ? `${formatMB(progress.downloaded)} / ${formatMB(progress.total)}`
      : formatMB(progress.downloaded)
    : "";

  const progressPercent = progress ? Math.min(100, progress.percent) : 0;

  return (
    <>
      <div className="settings-card engine-management-card">
        <div className="settings-card-header">
          <div className="settings-card-icon"><Settings size={16} /></div>
          <h3>{t("llama.title")}</h3>
          <div className="settings-card-header-actions">
            <button
              type="button"
              className="secondary-button compact engine-header-hub-btn"
              onClick={() => onOpenEngineHub?.()}
              title={t("llama.manageHubBtn")}
            >
              <Wrench size={13} />
              <span>{t("llama.manageHubBtn")}</span>
            </button>
          </div>
        </div>
        <div className="settings-card-body">
          {/* 行 1：当前运行分支 */}
          <div className="engine-card-row">
            <span className="engine-row-label">{t("llama.currentBranchTitle")}</span>
            <div className="engine-row-main">
              <span className="engine-name-text">{activeEngine?.name || "llama.cpp"}</span>
              <span className="engine-pill-tag backend">
                {formatEngineBackend(
                  activeEngine?.backend,
                  (activeEngine?.id === config.activeEngineId || !config.activeEngineId ? engineStatus?.cudaVersion : undefined) || activeEngine?.cudaVersion
                )}
              </span>
              {(activeEngine?.version || engineStatus?.localVersion) && (
                <span className="engine-pill-tag version">
                  {activeEngine?.version || engineStatus?.localVersion}
                </span>
              )}
            </div>
            <div className="engine-row-right">
              {isLlamaCppEngine ? (
                <div className="mini-seg engine-backend-seg" ref={cudaMenuRef}>
                  {/* CUDA 复合胶囊按钮 */}
                  <div className={cn("mini-seg-item cuda-compound-pill", backend === "cuda" && "active")}>
                    <button
                      type="button"
                      className="cuda-text-btn"
                      onClick={() => {
                        setBackend("cuda");
                        void onPersist({ ...config, llamaBackend: "cuda", llamaCudaVersion: cudaVersion }, "");
                        if (backend === "cuda") {
                          setCudaMenuOpen((prev) => !prev);
                        } else {
                          setCudaMenuOpen(false);
                          if (remote) void ensureRemote("cuda", cudaVersion);
                        }
                      }}
                    >
                      CUDA
                    </button>

                    <button
                      type="button"
                      className={cn("cuda-dropdown-trigger", cudaMenuOpen && "open")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (backend !== "cuda") {
                          setBackend("cuda");
                          void onPersist({ ...config, llamaBackend: "cuda", llamaCudaVersion: cudaVersion }, "");
                          if (remote) void ensureRemote("cuda", cudaVersion);
                        }
                        setCudaMenuOpen((prev) => !prev);
                      }}
                      title={t("llama.cudaVersionLabel")}
                    >
                      <span className="cuda-version-badge">({getCudaDisplayShort()})</span>
                      <ChevronDown size={11} className={cn("cuda-chevron", cudaMenuOpen && "open")} />
                    </button>

                    {/* 浮动下拉菜单 */}
                    {cudaMenuOpen && (
                      <div className="cuda-version-dropdown-menu" onClick={(e) => e.stopPropagation()}>
                        <div className="cuda-dropdown-list">
                          {cudaSelectOptions.map((opt) => {
                            const isSelected = cudaVersion === opt.value || (cudaVersion === "auto" && opt.value === "12");
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                className={cn("cuda-dropdown-item", isSelected && "selected")}
                                onClick={() => {
                                  setCudaVersion(opt.value);
                                  void onPersist({ ...config, llamaCudaVersion: opt.value, llamaBackend: "cuda" }, "");
                                  if (remote) void ensureRemote("cuda", opt.value);
                                  setCudaMenuOpen(false);
                                }}
                              >
                                <span className="opt-label">{opt.label}</span>
                                {isSelected && <Check size={13} className="opt-check" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  <span className="mini-seg-divider" />

                  {/* Vulkan */}
                  <button
                    type="button"
                    className={cn("mini-seg-btn", backend === "vulkan" && "active")}
                    onClick={() => {
                      setCudaMenuOpen(false);
                      setBackend("vulkan");
                      void onPersist({ ...config, llamaBackend: "vulkan" }, "");
                      if (remote) void ensureRemote("vulkan", cudaVersion);
                    }}
                  >
                    Vulkan
                  </button>

                  <span className="mini-seg-divider" />

                  {/* CPU */}
                  <button
                    type="button"
                    className={cn("mini-seg-btn", backend === "cpu" && "active")}
                    onClick={() => {
                      setCudaMenuOpen(false);
                      setBackend("cpu");
                      void onPersist({ ...config, llamaBackend: "cpu" }, "");
                      if (remote) void ensureRemote("cpu", cudaVersion);
                    }}
                  >
                    CPU
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {/* 行 2：版本状态 */}
          <div className="engine-card-row">
            <span className="engine-row-label">{t("llama.versionStatusTitle")}</span>
            <div className="engine-row-main">
              {isLlamaCppEngine ? (
                <span className="engine-status-text">
                  {t("llama.localVersionLabel")} {activeEngine?.version || engineStatus?.localVersion || t("llama.localVersionNone")}
                  {"  ·  "}
                  {t("llama.remoteVersionLabel")} {remote?.tag || (checking ? t("llama.checking") : "--")}
                </span>
              ) : (
                <span className="engine-status-text">
                  {t("llama.localVersionLabel")} {activeEngine?.version || engineStatus?.localVersion || t("llama.localVersionNone")}
                  {"  ·  "}
                  <span className="engine-nonllama-hint-inline">
                    <Info size={13} className="engine-nonllama-inline-icon" />
                    {t("llama.nonLlamaUpdateHint", { engine: activeEngineType.label })}
                  </span>
                </span>
              )}
            </div>
            <div className="engine-row-right">
              {isLlamaCppEngine && (
                <div className="engine-row-actions">
                  <button
                    type="button"
                    className="secondary-button compact"
                    disabled={checking || updating}
                    onClick={() => void runCheck()}
                  >
                    <RefreshCw size={13} className={checking ? "spin" : ""} />
                    <span>{t("llama.checkUpdateBtn")}</span>
                  </button>

                  {isUpToDate ? (
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={updating || checking}
                      onClick={() => void forceReinstall()}
                    >
                      <RotateCw size={13} className={updating ? "spin" : ""} />
                      <span>{t("llama.forceReinstall")}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="engine-primary-btn compact"
                      disabled={updating || checking}
                      onClick={() => void startUpdate()}
                    >
                      {updating ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                      <span>{remote?.tag ? t("llama.updateBtnTag", { tag: remote.tag }) : t("llama.checkAndUpdate")}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {engineError && <p className="import-error">{engineError}</p>}
        </div>
      </div>

      {/* 下载进度弹窗（极简设计） */}
      {progress && (
        <div className="modal-backdrop">
          <div className="import-modal download-modal" role="dialog" aria-modal="true">
            <header className="update-modal-header">
              <div className="update-modal-title">
                <Cpu size={17} className="update-modal-icon" />
                <h2>{t("llama.updateModalTitle")}</h2>
                {remote?.tag && <span className="update-modal-tag">{remote.tag}</span>}
              </div>
              {updating && progress.phase !== "done" && (
                <button className="ghost-icon" onClick={() => void cancelUpdate()} title={t("llama.cancelUpdate")}>
                  <X size={18} />
                </button>
              )}
            </header>

            <div className="download-body">
              {progress.phase === "done" ? (
                <div className="download-done-simple">
                  <div className="download-done-icon">
                    <Check size={24} strokeWidth={2.4} />
                  </div>
                  <div className="download-done-info">
                    <h3>llama.cpp 运行时更新完成</h3>
                    <p>{remote?.tag ? `${remote.tag} · ` : ""}已完成部署并热替换</p>
                  </div>
                </div>
              ) : (
                <div className="download-minimal">
                  <div className="download-minimal-header">
                    <div className="download-minimal-left">
                      <span className="download-status-dot" />
                      <span className="download-status-title">
                        {progress.phase === "extract"
                          ? "正在解压部署…"
                          : progress.phase === "install"
                            ? "正在覆盖安装…"
                            : "正在下载"}
                      </span>
                      {speedText && progress.phase === "download" && (
                        <span className="download-status-speed">{speedText}</span>
                      )}
                    </div>
                    <div className="download-minimal-right">
                      {sizeText && progress.phase === "download" && (
                        <span className="download-status-size">{sizeText}</span>
                      )}
                      <span className="download-status-percent">{progressPercent}%</span>
                    </div>
                  </div>

                  <div className="download-bar">
                    <div className="download-bar-inner" style={{ width: `${progressPercent}%` }} />
                  </div>

                  <div className="download-minimal-sub">
                    <span className="download-minimal-hint">
                      {progress.phase === "extract"
                        ? "解压部署中，请稍候…"
                        : progress.phase === "install"
                          ? "正在替换运行时文件…"
                          : "更新中请保持应用开启，完成后自动替换"}
                    </span>
                    <span className="download-minimal-tag">
                      {backend.toUpperCase()}{backend === "cuda" && cudaVersion && cudaVersion !== "auto" ? ` · CUDA ${cudaVersion}` : ""}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <footer>
              {progress.phase === "done" ? (
                <button className="primary-button" onClick={() => setProgress(null)}>
                  <Check size={14} />完成
                </button>
              ) : updating ? (
                <button className="secondary-button" onClick={() => void cancelUpdate()}>
                  <X size={14} />{t("llama.cancelUpdate")}
                </button>
              ) : (
                <button className="secondary-button" onClick={() => setProgress(null)}>
                  <X size={14} />关闭
                </button>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
