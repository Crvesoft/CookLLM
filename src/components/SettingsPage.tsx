import { Activity, AlertTriangle, ArrowRight, Check, ChevronDown, ChevronRight, Cpu, Download, Eye, EyeOff, FolderOpen, Github, KeyRound, Languages, Loader2, Moon, Pencil, Plus, RefreshCw, RotateCw, Search, SlidersHorizontal, Sparkles, Star, Sun, Trash2, Wifi, Wrench, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APP_REPO, PROJECT_URL } from "../data";
import { useI18n } from "../i18n";
import { cn, formatBytes, formatMB, formatEngineBackend } from "../utils";
import { cancelLlamaCppUpdate, checkLlamaCppUpdate, checkOrphanServer, detectHardware, downloadLlamaCpp, getAppVersion, getGpuInfo, getLlamaCppStatus, getModelsDir, getSystemProxy, hfWhoami, onDownloadProgress, openConfigDir, openExternal, pickModelsDir, pickServerDir, pickServerFile, revealInFolder, testProxyConnection, type DownloadProgress, type GpuInfo, type HardwareSuggestion, type LlamaCppLocalStatus, type LlamaCppRelease, type OrphanProcessItem, type ProxyTestResult, type ServerCandidate, type UpdateCheckResult } from "../tauri";
import type { AppConfig, DiskUsage, LlamaEngine, LlamaLogPayload } from "../types";
import ConfirmModal from "./ConfirmModal";
import EngineModal from "./EngineModal";

type ProxyMode = "system" | "manual" | "direct";

export default function SettingsPage({ visible, config, appUpdate, checkingUpdate, onCheckUpdate, onPersist, onLog, onOpenEngineHub }: { visible: boolean; config: AppConfig; appUpdate: UpdateCheckResult | null; checkingUpdate: boolean; onCheckUpdate: (openWhenAvailable?: boolean) => Promise<UpdateCheckResult>; onPersist: (config: AppConfig, message?: string) => Promise<void>; onLog: (line: string, stream?: LlamaLogPayload["stream"]) => void; onOpenEngineHub?: () => void }) {
  const { t } = useI18n();
  const [serverPath, setServerPath] = useState(config.serverPath);
  const [serverBrowseError, setServerBrowseError] = useState<string | null>(null);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [modelsDisk, setModelsDisk] = useState<DiskUsage | null>(null);

  const [engineModalOpen, setEngineModalOpen] = useState(false);
  const [editingEngine, setEditingEngine] = useState<LlamaEngine | null>(null);
  const [deletingEngine, setDeletingEngine] = useState<LlamaEngine | null>(null);

  useEffect(() => {
    setServerPath(config.serverPath);
  }, [config.serverPath]);

  useEffect(() => { void getGpuInfo().then(setGpuInfo).catch(() => undefined); }, []);
  useEffect(() => { void getModelsDir().then(setModelsDisk).catch(() => undefined); }, [config.modelsDir]);

  const engines: LlamaEngine[] = config.engines && config.engines.length > 0
    ? config.engines
    : config.serverPath
      ? [{ id: "engine-default", name: "默认引擎", path: config.serverPath, backend: "cuda" }]
      : [];

  const activeEngine = engines.find((e) => e.id === config.activeEngineId)
    || engines.find((e) => e.path.toLowerCase() === serverPath.toLowerCase())
    || engines[0];

  const handleSaveEngine = async (engine: LlamaEngine, setAsActive: boolean) => {
    let nextEngines = config.engines && config.engines.length > 0 ? [...config.engines] : (config.serverPath ? [{ id: "engine-default", name: "默认引擎", path: config.serverPath, backend: "cuda" }] : []);
    const existingIndex = nextEngines.findIndex((e) => e.id === engine.id);
    if (existingIndex >= 0) {
      nextEngines[existingIndex] = engine;
    } else {
      nextEngines.push(engine);
    }
    let nextActiveId = config.activeEngineId || engine.id;
    let nextServerPath = config.serverPath;
    if (setAsActive || !config.activeEngineId) {
      nextActiveId = engine.id;
      nextServerPath = engine.path;
    } else if (engine.id === config.activeEngineId) {
      nextServerPath = engine.path;
    }
    setServerPath(nextServerPath);
    await onPersist({ ...config, engines: nextEngines, activeEngineId: nextActiveId, serverPath: nextServerPath }, t("toast.settingsSaved"));
    setEngineModalOpen(false);
    setEditingEngine(null);
    void refreshEngine();
  };

  const handleSetActiveEngine = async (engine: LlamaEngine) => {
    setServerPath(engine.path);
    await onPersist({ ...config, activeEngineId: engine.id, serverPath: engine.path }, t("toast.settingsSaved"));
    void refreshEngine();
  };

  const handleDeleteEngine = async (engineId: string) => {
    const nextEngines = (config.engines || []).filter((e) => e.id !== engineId);
    let nextActiveId = config.activeEngineId;
    let nextServerPath = config.serverPath;
    if (config.activeEngineId === engineId) {
      if (nextEngines.length > 0) {
        nextActiveId = nextEngines[0].id;
        nextServerPath = nextEngines[0].path;
      } else {
        nextActiveId = undefined;
      }
    }
    setServerPath(nextServerPath);
    await onPersist({ ...config, engines: nextEngines, activeEngineId: nextActiveId, serverPath: nextServerPath }, t("toast.settingsSaved"));
    setDeletingEngine(null);
    void refreshEngine();
  };

  const handleRevealFolder = async (filePath: string) => {
    try {
      await revealInFolder(filePath);
    } catch (err) {
      onLog(err instanceof Error ? err.message : String(err), "stderr");
    }
  };

  const gpuOn = config.gpuMonitorEnabled !== false;
  const trayOn = config.minimizeToTrayOnClose !== false;
  const saveServerPath = (value: string) => {
    setServerPath(value);
    if (value.trim() && value !== config.serverPath) void onPersist({ ...config, serverPath: value.trim() }, t("toast.settingsSaved"));
  };

  const chooseModelsDir = async () => {
    try {
      const picked = await pickModelsDir();
      if (!picked) return;
      await onPersist({ ...config, modelsDir: picked }, t("toast.dirChanged"));
      const usage = await getModelsDir();
      setModelsDisk(usage);
    } catch (error) {
      onLog(error instanceof Error ? error.message : String(error), "stderr");
    }
  };

  const [detectedServer, setDetectedServer] = useState<OrphanProcessItem | null>(null);

  // ---- 项目信息：当前版本 + 检测更新（GitHub Releases）----
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => { void getAppVersion().then(setAppVersion).catch(() => undefined); }, []);
  type UpdateState = { phase: "idle" } | { phase: "checking" } | { phase: "done"; result: UpdateCheckResult } | { phase: "error"; message: string };
  const [update, setUpdate] = useState<UpdateState>({ phase: "idle" });
  const [updateCheckDone, setUpdateCheckDone] = useState(false);
  const updateCheckTimer = useRef<number | null>(null);
  const updateAvailable = appUpdate?.status === "available";
  const autoUpdateEnabled = config.autoUpdateEnabled !== false;
  const runUpdateCheck = async () => {
    if (checkingUpdate) return;
    setUpdate({ phase: "checking" });
    try {
      const result = await onCheckUpdate(true);
      setUpdate({ phase: "done", result });
      setUpdateCheckDone(true);
      if (updateCheckTimer.current) window.clearTimeout(updateCheckTimer.current);
      updateCheckTimer.current = window.setTimeout(() => setUpdateCheckDone(false), 2000);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      setUpdate({ phase: "error", message: raw === "no-releases" ? t("st.updateNoReleases") : t("st.updateError", { error: raw }) });
      setUpdateCheckDone(false);
    }
  };

  /* ==================== 网络与代理（阶段二） ==================== */
  const network = config.network ?? { proxyMode: "system" as const, proxyUrl: "" };
  const [proxyMode, setProxyMode] = useState<ProxyMode>(network.proxyMode);
  const [proxyUrl, setProxyUrl] = useState(network.proxyUrl ?? "");
  const [netTesting, setNetTesting] = useState(false);
  const [netResult, setNetResult] = useState<ProxyTestResult | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [systemProxy, setSystemProxy] = useState<string | null>(null);
  useEffect(() => { void getSystemProxy().then(setSystemProxy).catch(() => undefined); }, []);

  const NET_MODES: Array<{ value: ProxyMode; label: string }> = [
    { value: "system", label: t("net.modeSystem") },
    { value: "manual", label: t("net.modeManual") },
    { value: "direct", label: t("net.modeDirect") },
  ];

  const persistNetwork = (mode: ProxyMode, proxy: string) => {
    void onPersist(
      { ...config, network: { proxyMode: mode, proxyUrl: proxy } },
      t("net.saved"),
    );
  };

  const runProxyTest = async () => {
    setNetTesting(true); setNetResult(null); setNetError(null);
    try {
      const result = await testProxyConnection(proxyMode, proxyUrl);
      setNetResult(result);
      if (result.ok) persistNetwork(proxyMode, proxyUrl);
    } catch (error) {
      setNetError(error instanceof Error ? error.message : String(error));
    } finally { setNetTesting(false); }
  };

  /* ==================== Hugging Face Token 授权（阶段二・下载源凭据） ==================== */
  const [hfTokenDraft, setHfTokenDraft] = useState(config.hfToken ?? "");
  const [hfShowToken, setHfShowToken] = useState(false);
  const [hfTesting, setHfTesting] = useState(false);
  const [hfTestResult, setHfTestResult] = useState<{ ok: boolean; username?: string; detail?: string } | null>(null);
  const [hfError, setHfError] = useState<string | null>(null);
  const [hfSaved, setHfSaved] = useState(false);

  useEffect(() => {
    setHfTokenDraft(config.hfToken ?? "");
  }, [config.hfToken]);

  const runHfTokenTest = async () => {
    const value = hfTokenDraft.trim();
    if (!value) {
      setHfError(t("st.hfTokenEmpty"));
      return;
    }
    setHfTesting(true); setHfTestResult(null); setHfError(null);
    try {
      const username = await hfWhoami(value);
      setHfTestResult({ ok: true, username });
      await onPersist({ ...config, hfToken: value, hfTokenUser: username }, t("st.hfTokenVerified", { user: username }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setHfTestResult({ ok: false, detail });
    } finally { setHfTesting(false); }
  };

  const saveHfToken = () => {
    const value = hfTokenDraft.trim();
    if (!value) {
      void onPersist({ ...config, hfToken: undefined, hfTokenUser: undefined }, t("st.hfTokenCleared"));
      setHfTestResult(null); setHfError(null);
      return;
    }
    void onPersist({ ...config, hfToken: value }, t("st.hfTokenSaved"));
    setHfSaved(true);
    window.setTimeout(() => setHfSaved(false), 2000);
  };

  /* ==================== llama.cpp 引擎管理（阶段三） ==================== */
  const [hardware, setHardware] = useState<HardwareSuggestion | null>(null);
  const [engineStatus, setEngineStatus] = useState<LlamaCppLocalStatus | null>(null);
  const [remote, setRemote] = useState<LlamaCppRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [backend, setBackend] = useState<"cuda" | "vulkan" | "cpu">(config.llamaBackend || "cuda");
  const [cudaVersion, setCudaVersion] = useState(config.llamaCudaVersion || "12");
  const [cudaMenuOpen, setCudaMenuOpen] = useState(false);
  const cudaMenuRef = useRef<HTMLDivElement>(null);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<"updated" | "new" | null>(null);
  const checkResultTimer = useRef<number | null>(null);

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

  const BACKENDS: Array<{ value: "cuda" | "vulkan" | "cpu"; label: string }> = [
    { value: "cuda", label: "CUDA" },
    { value: "vulkan", label: "Vulkan" },
    { value: "cpu", label: "CPU" },
  ];

  const refreshEngine = async () => {
    try {
      const [hw, st, orphan] = await Promise.all([
        detectHardware(),
        getLlamaCppStatus(),
        checkOrphanServer().catch(() => null),
      ]);
      setHardware(hw);
      setEngineStatus(st);
      if (orphan && orphan.processes && orphan.processes.length > 0) {
        setDetectedServer(orphan.processes[0]);
      } else {
        setDetectedServer(null);
      }
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
    void refreshEngine();
    void ensureRemote(undefined, undefined, true);
  }, []);

  /** 检查远程最新版本并与本地版本比对；检查更新 / 一键更新 / 强制重装三处共用的前置步骤 */
  const ensureRemote = async (
    overrideBackend?: "cuda" | "vulkan" | "cpu",
    overrideCuda?: string,
    silent = false
  ): Promise<LlamaCppRelease | null> => {
    const useBackend = overrideBackend ?? backend;
    const useCuda = overrideCuda ?? cudaVersion;
    setChecking(true);
    if (!silent) setEngineError(null);
    try {
      const result = await checkLlamaCppUpdate(useBackend, useCuda);
      const local = engineStatus?.localVersion ?? "";
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
    const next = await ensureRemote();
    if (!next) return;
    setCheckResult(next.upToDate ? "updated" : "new");
    // 2 秒后自动恢复为「检查更新」
    if (checkResultTimer.current) window.clearTimeout(checkResultTimer.current);
    checkResultTimer.current = window.setTimeout(() => setCheckResult(null), 2000);
  };

  const backendLabel = (value: "cuda" | "vulkan" | "cpu") => value.toUpperCase();
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

  // 点击“一键更新”后先弹确认窗（自动识别硬件并推荐后端）
  const cancelUpdate = () => { void cancelLlamaCppUpdate().catch(() => undefined); };

  const runUpdate = async (useBackend: "cuda" | "vulkan" | "cpu") => {
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
      setServerPath(path);
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

  const hasNewVersion = remote !== null && !remote.upToDate;
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
    <div hidden={!visible}>
      <section className="settings-stack">

                        {/* 网络与代理 */}
        <div className="settings-card">
          <div className="settings-card-icon"><Wifi size={18} /></div>
          <div className="settings-card-body">
            <h3>{t("net.title")}</h3>
            <div className="net-row">
              <span className="net-mode-label">{t("net.mode")}</span>
              <select
                className="net-select"
                value={proxyMode}
                onChange={(e) => { setProxyMode(e.target.value as ProxyMode); setNetResult(null); }}
              >
                {NET_MODES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              {proxyMode === "system" ? (
                <span className="net-status">{systemProxy ? t("net.systemProxy", { proxy: systemProxy }) : t("net.noSystemProxy")}</span>
              ) : proxyMode === "manual" ? (
                <input className="net-input" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder={t("net.proxyUrlPlaceholder")} />
              ) : (
                <span className="net-status">{t("net.directHint")}</span>
              )}
              <button className="secondary-button compact net-test" onClick={() => void runProxyTest()} disabled={netTesting}>
                {netTesting ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />}
                {netTesting ? t("net.testing") : t("net.test")}
              </button>
            </div>
            {netResult?.ok && <span className="net-tag ok"><Check size={13} />{t("net.testLatency", { latency: netResult.latencyMs })}</span>}
            {netResult && !netResult.ok && <span className="net-tag err"><AlertTriangle size={13} />{netResult.detail || netResult.status}</span>}
            {netError && <p className="import-error">{netError}</p>}
          </div>
        </div>
        {/* 下载授权：Hugging Face Gated 模型下载凭据 */}
        <div className="settings-card">
          <div className="settings-card-icon"><KeyRound size={18} /></div>
          <div className="settings-card-body">
            <h3>{t("st.hfTokenTitle")}</h3>
            <p className="about-desc">{t("st.hfTokenDesc")}</p>
            {/* 第一行：平台标题 + 状态胶囊（两端对齐） */}
            <div className="hf-token-head">
              <div className="hf-token-title">
                <strong>{t("st.hfTokenLabel")}</strong>
                <span>{t("st.hfTokenNeedRead")}</span>
              </div>
              <span className={cn("hf-token-pill", hfTestResult?.ok || (config.hfToken && !hfTestResult) ? "ok" : hfTestResult && !hfTestResult.ok ? "err" : "idle")}>
                {hfTestResult?.ok ? <Check size={12} /> : hfTestResult && !hfTestResult.ok ? <AlertTriangle size={12} /> : config.hfToken ? <Check size={12} /> : null}
                {hfTestResult?.ok
                  ? t("st.hfTokenBound", { user: hfTestResult.username || "…" })
                  : hfTestResult && !hfTestResult.ok
                    ? t("st.hfTokenInvalid")
                    : config.hfToken
                      ? t("st.hfTokenBound", { user: config.hfTokenUser || "…" })
                      : t("st.hfTokenNotSet")}
              </span>
            </div>
            {/* 第二行：输入框 + 测试 + 保存（水平并排） */}
            <div className="hf-token-controls">
              <div className="hf-token-field">
                <input
                  type={hfShowToken ? "text" : "password"}
                  className="net-input"
                  value={hfTokenDraft}
                  onChange={(e) => { setHfTokenDraft(e.target.value); setHfTestResult(null); setHfError(null); }}
                  placeholder={t("st.hfTokenPlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button className="hf-token-eye" type="button" title={hfShowToken ? t("st.hfTokenHide") : t("st.hfTokenShow")} onClick={() => setHfShowToken((value) => !value)}>
                  {hfShowToken ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button className="secondary-button compact hf-token-test" onClick={() => void runHfTokenTest()} disabled={hfTesting}>
                {hfTesting ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
                <span className="hf-token-btn-label">{hfTesting ? t("st.hfTokenTesting") : t("st.hfTokenTest")}</span>
              </button>
              <button className="secondary-button compact hf-token-save" onClick={saveHfToken} disabled={hfTesting}>
                {hfSaved ? <Check size={14} /> : null}
                <span className="hf-token-btn-label">{t("st.hfTokenSave")}</span>
              </button>
            </div>
            {hfError && <p className="hf-token-error">{hfError}</p>}
          </div>
        </div>
        {/* llama.cpp 管理及更新 */}
        <div className="settings-card settings-group engine-management-card">
          <div className="settings-card-icon"><Cpu size={18} /></div>
          <div className="settings-card-body">
            {/* 顶栏：标题 + 描述 + 右侧管理版本全局入口 */}
            <div className="engine-card-header">
              <div className="engine-card-header-left">
                <h3>{t("llama.title")}</h3>
                <p className="about-desc">{t("llama.desc")}</p>
              </div>
              <button
                type="button"
                className="secondary-button compact engine-header-hub-btn"
                onClick={() => onOpenEngineHub?.()}
                title="Ctrl+E"
              >
                <Wrench size={13} />
                <span>{t("llama.manageHubBtn")}</span>
                <kbd className="engine-kbd">Ctrl+E</kbd>
              </button>
            </div>

            {/* 单一聚合主卡片 */}
            <div className="engine-unified-card">
              {/* 第一行：当前运行分支 */}
              <div className="engine-unified-branch-row">
                <span className="engine-unified-label">{t("llama.currentBranchPrefix")}</span>
                <span className="engine-unified-name">{activeEngine?.name || "llama.cpp"}</span>
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

              {/* 分割线 */}
              <div className="engine-unified-divider" />

              {/* 第二行：硬件加速环境单选 + 版本信息状态 */}
              <div className="engine-unified-status-row">
                <div className="engine-backend-control-group">
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
                            // 若已处于 CUDA 分支，再次点击 CUDA 文本也可顺畅触发/收起版本菜单
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
                </div>

                <div className="engine-unified-version-group">
                  <span className="engine-ver-item">
                    <span className="ver-key">{t("llama.localVersionLabel")}</span>
                    <span className="ver-val">{engineStatus?.localVersion || t("llama.localVersionNone")}</span>
                  </span>
                  <span className="engine-ver-item">
                    <span className="ver-key">{t("llama.remoteVersionLabel")}</span>
                    <span className={cn("ver-val", hasNewVersion && "new")}>
                      {remote?.tag || (checking ? t("llama.checking") : "--")}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {/* 右下角操作聚合 */}
            <div className="engine-unified-actions">
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

            {serverBrowseError && <p className="import-error">{serverBrowseError}</p>}
            {engineError && <p className="import-error">{engineError}</p>}
          </div>
        </div>
{/* 常规偏好：列表项合并卡片 */}
        <div className="settings-card settings-group">
          <div className="settings-card-icon"><SlidersHorizontal size={18} /></div>
          <div className="settings-card-body">
            <h3>{t("st.preferencesTitle")}</h3>
            <div className="settings-list">
              <div className="settings-row">
                <span className="settings-row-label">{t("st.themeTitle")}</span>
                <span className="settings-row-desc">{t("st.themeDesc")}</span>
                <div className="settings-control">
                  <div className="mini-seg">
                    <button className={config.theme === "light" ? "active" : ""} onClick={() => void onPersist({ ...config, theme: "light" }, t("toast.lightTheme"))}><Sun size={13} />{t("lightLabel")}</button>
                    <button className={config.theme !== "light" ? "active" : ""} onClick={() => void onPersist({ ...config, theme: "dark" }, t("toast.darkTheme"))}><Moon size={13} />{t("darkLabel")}</button>
                  </div>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("st.langTitle")}</span>
                <span className="settings-row-desc">{t("st.langDesc")}</span>
                <div className="settings-control">
                  <div className="mini-seg">
                    <button className={config.language === "en" ? "" : "active"} onClick={() => void onPersist({ ...config, language: "zh" }, t("toast.languageSet", { label: "简体中文" }))}><Languages size={13} />简体中文</button>
                    <button className={config.language === "en" ? "active" : ""} onClick={() => void onPersist({ ...config, language: "en" }, t("toast.languageSet", { label: "English" }))}><Languages size={13} />English</button>
                  </div>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("st.storageTitle")}</span>
                <span className="settings-row-desc">{t("st.storageDesc")}</span>
                <div className="settings-control">
                  <button className="secondary-button compact" onClick={() => void openConfigDir().catch(() => undefined)}><FolderOpen size={14} />{t("st.openConfigDir")}</button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("st.modelsDirTitle")}</span>
                <span className="settings-row-desc">{modelsDisk ? t("st.modelsDirDesc", { free: formatBytes(modelsDisk.freeBytes) }) : t("st.modelsDirDesc", { free: "--" })}</span>
                <div className="settings-control">
                  <button className="secondary-button compact" onClick={() => void chooseModelsDir()}><FolderOpen size={14} />{t("st.changeDir")}</button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("st.gpuTitle")}</span>
                <span className="settings-row-desc">{gpuInfo === null ? t("gpu.detecting") : gpuInfo.vendor === "nvidia" ? t("gpu.nvidia") : gpuInfo.vendor === "amd" ? t("gpu.amd") : t("gpu.none")}</span>
                <div className="settings-control">
                  <button className={"switch" + (gpuOn ? " on" : "")} onClick={() => void onPersist({ ...config, gpuMonitorEnabled: !gpuOn }, gpuOn ? t("toast.gpuOff") : t("toast.gpuOn"))} role="switch" aria-checked={gpuOn}>
                    <span className="switch-knob" />
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("st.trayTitle")}</span>
                <span className="settings-row-desc">{t("st.trayDesc")}</span>
                <div className="settings-control">
                  <button className={"switch" + (trayOn ? " on" : "")} onClick={() => void onPersist({ ...config, minimizeToTrayOnClose: !trayOn }, trayOn ? t("toast.trayOff") : t("toast.trayOn"))} role="switch" aria-checked={trayOn}>
                    <span className="switch-knob" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 关于与调试：项目信息为信息展示，检查更新靠右，测试日志幽灵化 */}
        <div className="settings-card settings-group">
          <div className="settings-card-icon"><Github size={18} /></div>
          <div className="settings-card-body">
            <h3>{t("st.aboutTitle")}</h3>
            <p className="about-desc">{t("st.aboutDesc")}</p>
            <div className="about-layout">
              <div className="about-info">
                <span className="app-version-badge">{appVersion ? "v" + appVersion : "--"}{updateAvailable && <em className="version-new-badge">NEW</em>}</span>
                <button className="repo-link" title={PROJECT_URL} onClick={() => void openExternal(PROJECT_URL)}><Github size={13} />{APP_REPO}</button>
                <button className="ghost-link" onClick={() => onLog("diagnostics: UI event bridge is working", "system")}><Activity size={12} />{t("sendTestLog")}</button>
              </div>
              <div className="about-update-control">
                <label className="auto-update-toggle">
                  <button className={cn("switch", autoUpdateEnabled && "on")} role="switch" aria-checked={autoUpdateEnabled} aria-label={t("st.autoUpdate")} onClick={() => void onPersist({ ...config, autoUpdateEnabled: !autoUpdateEnabled }, t("toast.settingsSaved"))}>
                    <span className="switch-knob" />
                  </button>
                  <span>{t("st.autoUpdate")}</span>
                </label>
                <button className="secondary-button compact" disabled={checkingUpdate} onClick={() => void runUpdateCheck()}>
                  {checkingUpdate ? <Loader2 size={14} className="spin" /> : updateCheckDone ? <Check size={14} /> : <RefreshCw size={14} />}
                  {checkingUpdate ? t("st.checkingUpdate") : updateCheckDone ? t("st.checkDoneShort") : t("st.checkUpdate")}
                </button>
              </div>
            </div>
            {update.phase === "error" && <div className="about-result"><span className="storage-note err"><AlertTriangle size={15} />{update.message}</span></div>}
          </div>
        </div>
      </section>

      {/* 下载进度弹窗（极简设计） */}
      {progress && (
        <div className="modal-backdrop">
          <div className="import-modal download-modal" role="dialog" aria-modal="true">
            <header className="update-modal-header">
              <div className="update-modal-title">
                <Cpu size={17} className="update-modal-icon" />
                <h2>{t("llama.title")}</h2>
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
      {engineModalOpen && (
        <EngineModal
          engine={editingEngine}
          isDefault={editingEngine ? editingEngine.id === activeEngine?.id : false}
          onSave={handleSaveEngine}
          onClose={() => {
            setEngineModalOpen(false);
            setEditingEngine(null);
          }}
        />
      )}
      {deletingEngine && (
        <ConfirmModal
          title={t("llama.deleteBranch")}
          description={t("llama.deleteBranchConfirm", { name: deletingEngine.name })}
          confirmLabel={t("confirmDeleteLabel")}
          onConfirm={() => void handleDeleteEngine(deletingEngine.id)}
          onClose={() => setDeletingEngine(null)}
        />
      )}
    </div>
  );
};
