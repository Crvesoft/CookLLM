import { Activity, AlertTriangle, ArrowRight, Check, Database, Download, FolderOpen, Gauge, Github, Languages, Loader2, Moon, RefreshCw, RotateCw, SlidersHorizontal, SquareTerminal, Sun, Wifi, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APP_REPO, PROJECT_URL } from "../data";
import { useI18n } from "../i18n";
import { cn, formatBytes } from "../utils";
import { cancelLlamaCppUpdate, checkLlamaCppUpdate, detectHardware, downloadLlamaCpp, getAppVersion, getGpuInfo, getLlamaCppStatus, getModelsDir, getSystemProxy, onDownloadProgress, openConfigDir, openExternal, pickModelsDir, pickServerDir, testProxyConnection, type DownloadProgress, type GpuInfo, type HardwareSuggestion, type LlamaCppLocalStatus, type LlamaCppRelease, type ProxyTestResult, type UpdateCheckResult } from "../tauri";
import type { AppConfig, DiskUsage, LlamaLogPayload } from "../types";

type ProxyMode = "system" | "manual" | "direct";

export default function SettingsPage({ visible, config, appUpdate, checkingUpdate, onCheckUpdate, onPersist, onLog }: { visible: boolean; config: AppConfig; appUpdate: UpdateCheckResult | null; checkingUpdate: boolean; onCheckUpdate: (openWhenAvailable?: boolean) => Promise<UpdateCheckResult>; onPersist: (config: AppConfig, message?: string) => Promise<void>; onLog: (line: string, stream?: LlamaLogPayload["stream"]) => void }) {
  const { t } = useI18n();
  const [serverPath, setServerPath] = useState(config.serverPath);
  const [serverPicking, setServerPicking] = useState(false);
  const [serverBrowseError, setServerBrowseError] = useState<string | null>(null);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [modelsDisk, setModelsDisk] = useState<DiskUsage | null>(null);

  useEffect(() => {
    setServerPath(config.serverPath);
  }, [config.serverPath]);

  useEffect(() => { void getGpuInfo().then(setGpuInfo).catch(() => undefined); }, []);
  useEffect(() => { void getModelsDir().then(setModelsDisk).catch(() => undefined); }, [config.modelsDir]);

  const gpuOn = config.gpuMonitorEnabled !== false;
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

  const choose = async () => {
    setServerPicking(true); setServerBrowseError(null);
    try {
      const located = await pickServerDir();
      if (located) {
        setServerPath(located);
        await onPersist({ ...config, serverPath: located }, t("toast.settingsSaved"));
      }
    } catch (error) {
      setServerBrowseError(error instanceof Error ? error.message : String(error));
    } finally { setServerPicking(false); }
  };
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

  /* ==================== llama.cpp 引擎管理（阶段三） ==================== */
  const [hardware, setHardware] = useState<HardwareSuggestion | null>(null);
  const [engineStatus, setEngineStatus] = useState<LlamaCppLocalStatus | null>(null);
  const [remote, setRemote] = useState<LlamaCppRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [backend, setBackend] = useState<"cuda" | "vulkan" | "cpu">("cuda");
  const [cudaVersion, setCudaVersion] = useState("auto");
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<"updated" | "new" | null>(null);
  const checkResultTimer = useRef<number | null>(null);

  const BACKENDS: Array<{ value: "cuda" | "vulkan" | "cpu"; label: string }> = [
    { value: "cuda", label: "CUDA" },
    { value: "vulkan", label: "Vulkan" },
    { value: "cpu", label: "CPU" },
  ];

  const refreshEngine = async () => {
    try {
      const [hw, st] = await Promise.all([detectHardware(), getLlamaCppStatus()]);
      setHardware(hw);
      setEngineStatus(st);
      if (hw) setBackend(hw.recommendedBackend);
      else if (st?.localBackend) setBackend(st.localBackend);
    } catch { /* 非 Tauri 环境忽略 */ }
  };
  useEffect(() => { void refreshEngine(); }, []);

  const runCheck = async () => {
    if (checking) return;
    setChecking(true); setEngineError(null);
    try {
      const result = await checkLlamaCppUpdate(backend, cudaVersion);
      const local = engineStatus?.localVersion ?? "";
      const remoteTag = result.tag.toLowerCase();
      const upToDate = !!local && remoteTag.endsWith(local.toLowerCase());
      setRemote({ ...result, upToDate });
      setCheckResult(upToDate ? "updated" : "new");
      // 2 秒后自动恢复为「检查更新」
      if (checkResultTimer.current) window.clearTimeout(checkResultTimer.current);
      checkResultTimer.current = window.setTimeout(() => setCheckResult(null), 2000);
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : String(error));
      setRemote(null);
    } finally { setChecking(false); }
  };

    const backendLabel = (value: "cuda" | "vulkan" | "cpu") => value.toUpperCase();
  // 从远程资产提取可用的 CUDA 主版本（去重、降序）
  const cudaOptions = Array.from(new Set((remote?.assets ?? [])
    .filter((asset) => asset.backend === "cuda" && asset.cudaVersion)
    .map((asset) => asset.cudaVersion as string)))
    .sort((a, b) => Number(b) - Number(a));

  // 强制重装：忽略版本比较，直接重新下载安装（用于修复损坏文件）
  const forceReinstall = async () => {
    if (updating) return;
    if (!remote) {
      setChecking(true); setEngineError(null);
      try {
        const result = await checkLlamaCppUpdate(backend, cudaVersion);
        const local = engineStatus?.localVersion ?? "";
        const upToDate = !!local && result.tag.toLowerCase().endsWith(local.toLowerCase());
        setRemote({ ...result, upToDate });
        await runUpdate(backend);
      } catch (error) {
        setEngineError(error instanceof Error ? error.message : String(error));
      } finally { setChecking(false); }
      return;
    }
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
      await onPersist({ ...config, serverPath: path }, "");
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
      setChecking(true); setEngineError(null);
      try {
        const result = await checkLlamaCppUpdate(backend, cudaVersion);
        const local = engineStatus?.localVersion ?? "";
        const upToDate = !!local && result.tag.toLowerCase().endsWith(local.toLowerCase());
        setRemote({ ...result, upToDate });
        if (upToDate) return;
        await runUpdate(backend);
      } catch (error) {
        setEngineError(error instanceof Error ? error.message : String(error));
      } finally {
        setChecking(false);
      }
      return;
    }
    if (remote.upToDate) return;
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
    ? progress.speedBps >= 1024 * 1024
      ? (progress.speedBps / 1024 / 1024).toFixed(1) + " MB"
      : Math.round(progress.speedBps / 1024) + " KB"
    : "";

  const progressPercent = progress ? Math.min(100, progress.percent) : 0;
  const progressLabel =
    progress?.phase === "download"
      ? t("llama.progress.download", { percent: progressPercent })
      : progress?.phase === "extract"
        ? t("llama.progress.extract", { percent: progressPercent })
        : progress?.phase === "install"
          ? t("llama.progress.install")
          : progress?.phase === "done"
            ? t("llama.progress.done")
            : t("llama.updateBusy");

  return (
    <div hidden={!visible}>
      <section className="settings-stack">

                        {/* 网络与代理 */}
        <div className="settings-card">
          <div className="settings-card-icon cyan"><Wifi size={21} /></div>
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
{/* llama.cpp 引擎更新 */}
        <div className="settings-card engine-card">
          <div className="settings-card-icon amber"><Wrench size={21} /></div>
          <div className="settings-card-body">
            <div className="engine-head">
              <h3>{t("llama.title")}</h3>
              <span className="engine-spacer" />
              {isUpToDate && <span className="engine-badge ok"><Check size={12} />{t("llama.upToDate")}</span>}
              {hasNewVersion && <span className="engine-badge warn"><AlertTriangle size={12} />{t("llama.newVersionBadge")}</span>}
            </div>

            {/* 顶部版本看板：单行（当前 → 最新）大字体，右上角内嵌刷新按钮 */}
            <div className="engine-version-board">
              <span className="engine-version-label">{t("llama.currentShort")} <strong>{engineStatus?.localVersion ?? t("llama.localVersionNone")}{engineStatus?.localBackend ? " (" + backendLabel(engineStatus.localBackend) + ")" : ""}</strong></span>
              <ArrowRight size={14} className="engine-version-arrow" />
              <span className="engine-version-label">{t("llama.latestShort")} <strong className={hasNewVersion ? "new" : ""}>{remote?.tag ?? "--"}</strong></span>
            </div>

            {/* 卡片式后端选择：CUDA 版本下拉收进标题行，三卡天然等高 */}
            <div className="backend-seg">
              {BACKENDS.map((option) => (
                <button key={option.value} className={"backend-card" + (backend === option.value ? " active" : "")} onClick={() => setBackend(option.value)}>
                  <span className="backend-card-head">
                    <span className="backend-card-name">
                      {option.value === hardware?.recommendedBackend ? <Check size={12} /> : null}
                      {option.label}
                    </span>
                    {option.value === "cuda" && (
                      <select className="engine-select" value={cudaVersion} onChange={(e) => setCudaVersion(e.target.value)} onClick={(e) => e.stopPropagation()}>
                        <option value="auto">{t("llama.cudaAuto")}</option>
                        {cudaOptions.map((version) => <option key={version} value={version}>CUDA {version}</option>)}
                      </select>
                    )}
                  </span>
                  <span className="backend-card-sub">
                    {option.value === "cuda"
                      ? (hardware?.gpuName ?? t("llama.subNvidia"))
                      : option.value === "vulkan" ? t("llama.subVulkan") : t("llama.subCpu")}
                  </span>
                </button>
              ))}
            </div>

            {/* 路径输入框：浏览作为尾部附着按钮 */}
            <div className="engine-path">
              <span className="engine-path-label">{t("llama.installPath")}</span>
              <div className="engine-path-row">
                <input value={serverPath} onChange={(e) => setServerPath(e.target.value)} onBlur={(e) => saveServerPath(e.target.value)} placeholder="C:\llama.cpp\llama-server.exe" />
                <button className="engine-browse" disabled={serverPicking} onClick={() => void choose()}>{serverPicking ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />}{t("browse")}</button>
              </div>
            </div>

            {/* 底部按钮：次级描边 + 主橙色，统一靠右，宽度自适应 */}
            <div className="engine-actions">
              <button className="secondary-button compact" disabled={checking || updating} onClick={() => void runCheck()}>
                {checking ? <Loader2 size={14} className="spin" /> : checkResult ? <Check size={14} /> : <RefreshCw size={14} />}
                {checking ? t("llama.checking") : checkResult === "updated" ? t("llama.checkDoneShort") : checkResult === "new" ? t("llama.newVersionShort") : t("llama.check")}
              </button>
              {isUpToDate
                ? <button className="primary-button compact" disabled={updating || checking} onClick={() => void forceReinstall()}>{updating ? <Loader2 size={15} className="spin" /> : <RotateCw size={15} />}{t("llama.forceReinstall")}</button>
                : <button className="primary-button compact" disabled={updating || checking} onClick={() => void startUpdate()}>{updating ? <Loader2 size={15} className="spin" /> : <Download size={15} />}{remote ? t("llama.updateToTag", { tag: remote.tag }) : t("llama.checkAndUpdate")}</button>}
            </div>
            {serverBrowseError && <p className="import-error">{serverBrowseError}</p>}
            {engineError && <p className="import-error">{engineError}</p>}
          </div>
        </div>
{/* 常规偏好：列表项合并卡片 */}
        <div className="settings-card settings-group">
          <div className="settings-card-icon cyan"><SlidersHorizontal size={21} /></div>
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
                <span className="settings-row-label">{t("st.storageTitle")}</span>
                <span className="settings-row-desc">{t("st.storageDesc")}</span>
                <div className="settings-control">
                  <button className="secondary-button compact" onClick={() => void openConfigDir().catch(() => undefined)}><FolderOpen size={14} />{t("st.openConfigDir")}</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 关于与调试：项目信息为信息展示，检查更新靠右，测试日志幽灵化 */}
        <div className="settings-card settings-group">
          <div className="settings-card-icon amber"><Github size={21} /></div>
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

{/* 下载进度弹窗（可取消） */}
      {progress && (
        <div className="modal-backdrop">
          <div className="import-modal download-modal">
            <header><div><span>{t("llama.title")}</span><h2>{progressLabel}</h2></div></header>
            <div className="download-body">
              <div className="download-bar"><div className="download-bar-inner" style={{ width: progressPercent + "%" }} /></div>
              <div className="download-meta">
                <span>{progressLabel}</span>
                <span>{speedText ? speedText + "/s" : ""}</span>
              </div>
              <p className="download-message">{progress.message}</p>
              {updating && <button className="secondary-button" onClick={() => void cancelUpdate()} disabled={progress.phase === "done"}><X size={15} />{t("llama.cancelUpdate")}</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
