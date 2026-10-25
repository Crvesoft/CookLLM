import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEMO_CONFIG, DEFAULT_PROFILES, DEFAULT_NINFER_PROFILES, migrateConfig, uid } from "./data";
import { setLocale, useI18n } from "./i18n";
import { checkOrphanServer, exportConfigBackup, getGpuStats, getServerStatus, isTauri, loadConfig, onConfigUpdated, onShortcutOpenEngineHub, onLlamaLog, onServerLifecycle, onTrayViewError, openExternal, pathsExist, pickConfigBackup, pickDirectory, saveConfig, setWindowTheme, type ConfigBackupEnvelope } from "./tauri";
import { PAGE_LOG_MODE, type AppConfig, type Page, type ServerStatus } from "./types";
import { EMPTY_STATUS, cn, modelTitle, parseTokPerSec, shallowEqualFields, isKeyboardEventMatchingShortcut, DEFAULT_SHORTCUTS } from "./utils";
import LogDock from "./components/LogDock";
import { LogsPage, Sidebar, Toast, Topbar } from "./components/Layout";
import ImportModelModal from "./components/ImportModelModal";
import ModelsPage from "./components/ModelsPage";
import ProfilesPage from "./components/ProfilesPage";
import Playground from "./components/Playground";
import SettingsPage from "./components/SettingsPage";
import ExplorePage from "./components/ExplorePage";
import ProfileEditor from "./components/ProfileEditor";
import AppUpdateDialog from "./components/AppUpdateDialog";
import OrphanServerModal from "./components/OrphanServerModal";
import EngineHubModal from "./components/EngineHubModal";
import EngineModal from "./components/EngineModal";
import BackupImportModal from "./components/BackupImportModal";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useDownloads } from "./hooks/useDownloads";
import { useEngines } from "./hooks/useEngines";
import { useLogs } from "./hooks/useLogs";
import { useModelLibrary } from "./hooks/useModelLibrary";
import { useServiceController } from "./hooks/useServiceController";
import { useToast } from "./hooks/useToast";

/**
 * 服务「真正就绪」日志特征：引擎加载完毕并开始监听。
 * llama.cpp 输出 "server is listening on ..."，Ninfer 输出 "listening on http://..."。
 * 这是最快的就绪信号；后端探针还会在 HTTP 接口真正可服务后广播 ready，
 * 兜底日志文案随引擎版本变化的场景（如 Ninfer 未输出可匹配的监听行）。
 */
const READY_LOG_RE = /is listening|listening on/i;

export default function App() {
  /** 界面语言：文案经 t() 查当前 locale；locale 由 AppConfig.language 驱动（adopt/persist 时同步） */
  const { t } = useI18n();
  const { toast, setToast } = useToast();
  const { logs, appendLog, queueLogs, clearLogs } = useLogs();
  const [config, setConfig] = useState<AppConfig>(DEMO_CONFIG);
  /** config 镜像：下载完成回调等长周期闭包读取最新配置，避免用过期快照覆盖用户中途的修改 */
  const configRef = useRef(config);
  configRef.current = config;
  const [page, setPage] = useState<Page>("models");
  /** page 镜像：生命周期事件等一次性注册的监听器读取实时页面，避免闭包过期 */
  const pageRef = useRef(page);
  pageRef.current = page;
  const [status, setStatus] = useState<ServerStatus>(EMPTY_STATUS);

  /** 配置写盘唯一入口：先更新界面，再持久化；失败仅记日志，不打断当前交互 */
  const persist = async (next: AppConfig, message?: string) => {
    setConfig(next);
    /** 语言随本次保存立即生效（值未变时为空操作） */
    setLocale(next.language ?? "zh");
    try { await saveConfig(next); if (message) setToast(message); }
    catch (error) { appendLog(t("log.saveConfigFailed", { error: String(error) }), "stderr"); }
  };

  const { appEngines, activeAppEngine, handleSelectActiveEngine, handleSaveEngine, handleDeleteEngine } = useEngines({ config, persist, setToast, t });
  const {
    query, setQuery, menuModelId, setMenuModelId, selectedProfiles, setSelectedProfiles,
    profileEditing, setProfileEditing, importOpen, setImportOpen, openImport, handleImportModels,
    filteredModels, removeModel, reorderModels, removeMultipleModels,
    saveProfile, deleteProfile, reorderProfiles, deleteMultipleProfiles, duplicateProfile,
    setDefaultProfile, renameModel, updateModelTags, setDefaultModel,
  } = useModelLibrary({ config, status, persist, setToast, t });
  // ---- Dock 日志状态（除"日志"整页外的所有页面共用同一份展开/高度状态）----
  /** Dock 默认收起：只显示底部状态栏，主区空间最大 */
  const [logDockOpen, setLogDockOpen] = useState(false);
  /** Dock 展开高度 px（120 ~ 60% 视口），持久化到 localStorage */
  const [logDockHeight, setLogDockHeight] = useState(() => { const stored = Number(localStorage.getItem("cookllm.logDock.height")); return Number.isFinite(stored) ? Math.max(120, Math.min(window.innerHeight * 0.6, stored)) : 160; });
  const [quickModelId, setQuickModelId] = useState("");
  /** 侧边菜单收起（图标轨），持久化到 localStorage */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("cookllm.sidebar.collapsed") === "1");
  /** 会话沉浸模式（仅在会话页生效，隐藏侧边栏与会话顶栏，保留窗口标题栏） */
  const [zenMode, setZenMode] = useState(false);
  /** 配置加载完成前不启用 GPU/状态轮询，避免「关闭监测」用户首次挂载闪现图表 */
  const [configReady, setConfigReady] = useState(false);

  const { appUpdate, appUpdateDialogOpen, setAppUpdateDialogOpen, appUpdateChecking, checkAppUpdate } = useAppUpdate(config, configReady);
  const {
    downloads, modelProgress, diskUsage, justImportedIds,
    handleModelDownload, handlePauseTask, handleResumeTasks, handlePauseTasks,
    handleClearDone, handleCancelTask, handleDeleteTask, deleteTasksImpl,
    handleRetry, handleReveal, pickModelsDirFlow,
  } = useDownloads({ config, configRef, configReady, persist, setToast, appendLog, setSelectedProfiles, t });
  const {
    serviceAbnormal, tokSample, setTokSample, inferenceTrackerRef, latestInference, setLatestInference, inferenceHistory, setInferenceHistory,
    gpuStats, setGpuStats, busy, serviceStarting, startingModelId,
    markServiceReady, serverLifecycleHandlerRef,
    handleStart, handleStop, handleClearInferenceStats,
    orphanPids, orphanProcesses, orphanPendingModel, setOrphanPids, setOrphanProcesses,
    handleKillOrphan, handleCloseOrphanModal,
  } = useServiceController({ config, configReady, pageRef, status, setStatus, selectedProfiles, setMenuModelId, setLogDockOpen, setToast, appendLog, t });

  /** llama.cpp 运行时管理中心（Alt+Shift+E） */
  const [engineHubOpen, setEngineHubOpen] = useState(false);
  const [engineAddModalOpen, setEngineAddModalOpen] = useState(false);
  /** 配置备份导入向导弹窗 */
  const [backupImportEnvelope, setBackupImportEnvelope] = useState<ConfigBackupEnvelope | null>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      const rawShortcut = config.shortcuts?.switchEngine;
      const configuredShortcut = rawShortcut !== undefined ? rawShortcut : DEFAULT_SHORTCUTS.switchEngine;
      if (!configuredShortcut || !configuredShortcut.trim()) {
        return;
      }

      if (isKeyboardEventMatchingShortcut(e, configuredShortcut)) {
        e.preventDefault();
        setEngineHubOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [config.shortcuts?.switchEngine]);

  const adopt = (cfg: AppConfig) => {
    const usable = migrateConfig(cfg);
    setConfig(usable);
    /** 从磁盘配置同步界面语言（未设置过则回退中文） */
    setLocale(usable.language ?? "zh");
    setSelectedProfiles((previous) => {
      const next: Record<string, string> = {};
      for (const model of usable.models) {
        const prevId = model.profiles.some((p) => p.id === previous[model.id]) ? previous[model.id] : undefined;
        next[model.id] = prevId || model.defaultProfileId || model.profiles[0]?.id || "";
      }
      return next;
    });
    // 若历史配置中有缺少预设的模型，通过 migrateConfig 自动补齐后静默回写磁盘
    const needPersist = usable.models.some((m, idx) => m.profiles.length !== (cfg.models?.[idx]?.profiles?.length ?? 0));
    if (needPersist) {
      void saveConfig(usable);
    }
  };

  useEffect(() => {
    let active = true; let unlisten: (() => void) | undefined; let unlistenLifecycle: (() => void) | undefined; let unlistenConfig: (() => void) | undefined; let unlistenEngineHub: (() => void) | undefined;
    void (async () => {
      try {
        if (isTauri()) {
          // 挂载时立即并行查询一次 GPU 状态，无需排队等待配置与日志监听就绪
          void getGpuStats().then((stats) => {
            if (active && stats) {
              setGpuStats((prev) => (prev !== null && shallowEqualFields(prev, stats) ? prev : stats));
              try { localStorage.setItem("cookllm.last_gpu_stats", JSON.stringify(stats)); } catch {}
            }
          }).catch(() => undefined);

          const loaded = await loadConfig();
          if (active && loaded) adopt(loaded);
          const current = await getServerStatus(); if (active) setStatus(current);
          // 检测是否存在上次运行未正常退出的后台残留 llama-server 进程
          void checkOrphanServer().then((orphanInfo) => {
            if (active && orphanInfo.hasOrphan && orphanInfo.pids.length > 0) {
              setOrphanPids(orphanInfo.pids);
              setOrphanProcesses(orphanInfo.processes ?? null);
              appendLog(t("orphan.detectedLog", { pids: orphanInfo.pids.join(", ") }), "system");
            }
          }).catch(() => undefined);
          // 服务生命周期事件：托盘启动/停止时同步主界面过渡动画与异常标记（ref 转发读取最新闭包）
          unlistenLifecycle = await onServerLifecycle((payload) => {
            if (active) serverLifecycleHandlerRef.current(payload);
          });
          // 快捷键等后台操作触发的配置变更事件
          unlistenConfig = await onConfigUpdated((updated) => {
            if (active && updated) adopt(updated);
          });
          // 全局快捷键呼出引擎管理界面事件
          unlistenEngineHub = await onShortcutOpenEngineHub(() => {
            if (active) setEngineHubOpen((prev) => !prev);
          });
          unlisten = await onLlamaLog((payload) => {
            if (!active) return;
            queueLogs([payload]);
            // 服务「真正」就绪 = 引擎加载完毕并开始监听（llama.cpp: server is listening / Ninfer: listening on）。
            // 与后端探针广播的 ready 事件互为兜底：任一先到都会收尾过渡动画。
            // 该信号同时驱动「自动收起 Dock」「结束启动旋转动画」「播报已启动」，保证三者同步完成。
            if (READY_LOG_RE.test(payload.line)) markServiceReady();

            // 结构化推理指标跟踪（Prefill / Decode / KV Cache 命中）
            const trackerRes = inferenceTrackerRef.current.processLine(payload.line);
            if (trackerRes.updated && trackerRes.latest) {
              setLatestInference({ ...trackerRes.latest });
              setInferenceHistory(inferenceTrackerRef.current.getHistory());
              const speed = trackerRes.latest.decodeTps ?? trackerRes.latest.prefillTps;
              if (speed != null) setTokSample({ rate: speed, at: Date.now() });
            } else {
              const tps = parseTokPerSec(payload.line);
              if (tps !== null) setTokSample({ rate: tps, at: Date.now() });
            }
          });
          void onTrayViewError((errMsg) => {
            if (!active) return;
            setLogDockOpen(true);
            if (errMsg) {
              setToast(errMsg);
            }
          });
        } else {
          const stored = localStorage.getItem("cookllm-config"); if (stored && active) { const parsed = JSON.parse(stored) as AppConfig; adopt(parsed); }
        }
      } catch (error) { appendLog(t("log.initFailed", { error: String(error) }), "stderr"); }
      // 无论成功失败，配置读取阶段结束 → 解锁轮询
      if (active) setConfigReady(true);
    })();
    return () => { active = false; unlisten?.(); unlistenLifecycle?.(); unlistenConfig?.(); unlistenEngineHub?.(); };
  }, []);



  /** Dock 高度持久化：下次进入会话页时恢复 */
  useEffect(() => { localStorage.setItem("cookllm.logDock.height", String(logDockHeight)); }, [logDockHeight]);
  useEffect(() => { localStorage.setItem("cookllm.sidebar.collapsed", sidebarCollapsed ? "1" : "0"); }, [sidebarCollapsed]);

  /** 默认亮色主题；同时把标题栏同步给系统（Windows：暗色=黑，亮色=默认） */
  const theme = config.theme || "light";
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("cookllm.theme", theme);
    } catch {}
    void setWindowTheme(theme === "dark");
  }, [theme]);

  /** 首帧完成渲染后显示窗口：使用双 requestAnimationFrame 确保 React DOM 真正绘制到 WebView2 缓冲区后再显示窗口，彻底消除黑屏与闪烁 */
  useLayoutEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let count = 0;
    const checkFrame = () => {
      if (cancelled) return;
      count++;
      if (count >= 2) {
        invoke("show_main_window").catch(() => {});
        const now = Date.now();
        const startup = window.__startup;
        invoke("report_startup_timing", {
          pageLoadMs: startup?.wall0 ?? now,
          splashShownMs: startup?.domReady || now,
          reactMountedMs: now,
        }).catch(() => {});
      } else {
        requestAnimationFrame(checkFrame);
      }
    };
    requestAnimationFrame(checkFrame);
    return () => {
      cancelled = true;
    };
  }, []);

  // 离开会话页时自动退出沉浸模式
  useEffect(() => {
    if (page !== "playground" && zenMode) {
      setZenMode(false);
    }
  }, [page, zenMode]);

  // F11 快捷键切换会话沉浸模式（非会话页不拦截，且绝不占用/拦截 WebUI 设置等常用的 Esc 键）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11" && page === "playground") {
        e.preventDefault();
        setZenMode((v) => !v);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [page]);



  const activeModel = config.models.find((model) => model.id === status.modelId);
  const activeProfile = activeModel?.profiles.find((profile) => profile.id === status.profileId);

  /** 底部状态栏胶囊展示的引擎分支：运行中准确展示当前服务实际使用的引擎分支，未运行时展示全局默认引擎 */
  const dockEngine = useMemo(() => {
    if (status.running) {
      if (activeProfile?.engineId) {
        const matched = appEngines.find((e) => e.id === activeProfile.engineId);
        if (matched) return matched;
      }
      if (status.engineName) {
        const matched = appEngines.find((e) => e.name === status.engineName);
        if (matched) return matched;
        return {
          id: "running",
          name: status.engineName,
          path: "",
          backend: status.engineBackend || "cuda",
        };
      }
    }
    return activeAppEngine;
  }, [status.running, status.engineName, status.engineBackend, activeProfile?.engineId, appEngines, activeAppEngine]);
  /** 浏览器/iframe 无法导航到 0.0.0.0，统一替换为 127.0.0.1（用户显式配置的局域网 IP 保留原样） */
  const browserHost = (() => { const host = activeProfile?.host || "0.0.0.0"; return host === "0.0.0.0" ? "127.0.0.1" : host; })();
  const port = status.port || activeProfile?.port || 9931;
  const webUiUrl = `http://${browserHost}:${port}`;
  const openWebUi = async () => {
    if (!status.running) return;
    await openExternal(webUiUrl);
    setToast(t("toast.webUiOpened"));
  };

  const exportBackup = async () => {
    try {
      const path = await exportConfigBackup();
      if (path) setToast(t("toast.backupExported"));
    } catch (error) {
      setToast(t("toast.backupFailed", { error: String(error) }));
    }
  };
  const importBackup = async () => {
    try {
      const envelope = await pickConfigBackup();
      if (!envelope) return;
      const migrated = migrateConfig(envelope.config);
      setBackupImportEnvelope({
        ...envelope,
        config: migrated,
      });
    } catch (error) {
      setToast(t("toast.backupFailed", { error: String(error) }));
    }
  };
  const startQuick = async () => {
    const id = quickModelId || config.preferredModelId || config.models[0]?.id || "";
    const model = config.models.find((item) => item.id === id) || config.models[0];
    if (!model) return setToast(t("toast.addFirst"));
    await handleStart(model);
  };

  /** 当前页是否使用 Dock 日志（除"日志"整页外所有页面）：Dock 参与布局，无悬浮遮挡 */
  const isDockPage = PAGE_LOG_MODE[page] === "dock";

  /** 侧边栏「社区探索」下载角标：后台有进行中任务时显示数量 + 环形总进度 */
  const activeTaskList = downloads.filter((item) => item.status === "active");
  const exploreActive = activeTaskList.length;
  const exploreBadge = exploreActive > 0 ? String(exploreActive) : undefined;
  /** 环形进度的总进度：按各任务已下载字节数加权（无总量的任务不计入分母） */
  const exploreProgressBytes = activeTaskList.reduce((sum, item) => ({ downloaded: sum.downloaded + (item.downloaded || 0), total: sum.total + (item.total && item.total > 0 ? item.total : 0) }), { downloaded: 0, total: 0 });
  const exploreProgress = exploreProgressBytes.total > 0 ? Math.min(100, Math.round((exploreProgressBytes.downloaded / exploreProgressBytes.total) * 100)) : 0;

  return <div className={cn("app-shell", sidebarCollapsed && "sidebar-collapsed", zenMode && "zen-mode")}>
    <Sidebar page={page} onPage={setPage} downloadBadge={exploreBadge} badgeProgress={exploreActive > 0 ? exploreProgress : undefined} updateAvailable={appUpdate?.status === "available"} status={status} abnormal={serviceAbnormal} gpuStats={gpuStats} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} theme={theme} onToggleTheme={() => void persist({ ...config, theme: theme === "dark" ? "light" : "dark" })} />
    <div className={cn("workspace", isDockPage && "dock-mode")}><Topbar page={page} status={status} abnormal={serviceAbnormal} busy={busy} serviceStarting={serviceStarting} onToggleService={status.running || serviceStarting ? handleStop : startQuick} models={config.models} modelId={quickModelId || config.preferredModelId || config.models[0]?.id || ""} onSelectModel={setQuickModelId} zenMode={zenMode} onToggleZenMode={() => setZenMode((v) => !v)} /><main className="main-content">
      {page === "models" && <ModelsPage config={config} models={filteredModels} status={status} selectedProfiles={selectedProfiles} busy={busy} serviceStarting={serviceStarting} startingModelId={startingModelId} query={query} onQuery={setQuery} onAddModel={openImport} onSelectProfile={(modelId, profileId) => setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }))} onStart={handleStart} onStop={handleStop} onEditProfile={(model, profile) => setProfileEditing({ modelId: model.id, profile })} onAddProfile={(model) => { const isN = model.path.toLowerCase().endsWith(".ninfer"); const baseP = isN ? DEFAULT_NINFER_PROFILES[0] : DEFAULT_PROFILES[0]; setProfileEditing({ modelId: model.id, profile: { ...baseP, id: uid("profile"), name: t("newProfile") } }); }} onRenameModel={renameModel} onUpdateModelTags={updateModelTags} onSetDefaultModel={setDefaultModel} onOpenProfiles={() => setPage("profiles")} menuModelId={menuModelId} onMenuModel={setMenuModelId} onRemoveModel={removeModel} onReorderModel={reorderModels} onDeleteMultipleModels={removeMultipleModels} justImportedIds={justImportedIds} onToast={setToast} />}
      <ExplorePage visible={page === "explore"} config={config} onPersist={persist} onToast={setToast} onLog={appendLog} diskUsage={diskUsage} onPickModelsDir={pickModelsDirFlow} onDownload={handleModelDownload} activeDownloads={downloads} progressMap={modelProgress} onPauseTask={handlePauseTask} onResumeTasks={handleResumeTasks} onPauseTasks={handlePauseTasks} onClearDone={handleClearDone} onCancelTask={handleCancelTask} onDeleteTask={handleDeleteTask} onDeleteTasks={deleteTasksImpl} onRetry={handleRetry} onReveal={handleReveal} onGoSettings={() => setPage("settings")} />
      {page === "profiles" && <ProfilesPage models={config.models} engines={config.engines} activeEngineId={config.activeEngineId} onEdit={(modelId, profile) => setProfileEditing({ modelId, profile })} onDelete={deleteProfile} onDuplicate={duplicateProfile} onSetDefault={setDefaultProfile} onReorderProfile={reorderProfiles} onDeleteProfiles={deleteMultipleProfiles} />}
      {/* 会话页保持常驻（隐藏而非卸载）：切换菜单不销毁内嵌 WebUI，回来时无需从聊天记录重新进入；WebUI 始终填满 Dock 下全部剩余高度 */}
      <Playground visible={page === "playground"} status={status} webUiUrl={webUiUrl} modelName={activeModel ? modelTitle(activeModel) : undefined} onOpenWebUi={openWebUi} zenMode={zenMode} onToggleZenMode={() => setZenMode((v) => !v)} />
      {page === "logs" && (
        <LogsPage
          logs={logs}
          status={status}
          tokPerSec={tokSample ? tokSample.rate : null}
          latestMetrics={latestInference}
          inferenceHistory={inferenceHistory}
          onClearHistory={handleClearInferenceStats}
          onClear={clearLogs}
        />
      )}
      <SettingsPage visible={page === "settings"} config={config} activeEngine={activeAppEngine} appUpdate={appUpdate} checkingUpdate={appUpdateChecking} onCheckUpdate={checkAppUpdate} onPersist={persist} onLog={appendLog} onOpenEngineHub={() => setEngineHubOpen(true)} onExportBackup={exportBackup} onImportBackup={importBackup} />
    </main>
      {/* Dock 日志参与布局（收起=底部状态栏 / 展开=可调高度面板），各页面共用同一份状态，不遮挡内容；仅"日志"整页除外 */}
      {isDockPage && (
        <LogDock
          open={logDockOpen}
          height={logDockHeight}
          logs={logs}
          status={status}
          modelName={activeModel ? modelTitle(activeModel) : undefined}
          profileName={activeProfile?.name || status.profileName}
          abnormal={serviceAbnormal}
          tokPerSec={tokSample ? tokSample.rate : null}
          latestMetrics={latestInference}
          inferenceHistory={inferenceHistory}
          onClearHistory={handleClearInferenceStats}
          activeEngineName={dockEngine?.name}
          activeEngineBackend={dockEngine?.backend}
          activeEngineCudaVersion={dockEngine?.cudaVersion}
          onOpenEnginePicker={() => setEngineHubOpen(true)}
          onToggle={() => setLogDockOpen((value) => !value)}
          onHeightChange={setLogDockHeight}
          onClear={clearLogs}
        />
      )}
    </div>
    {profileEditing && <ProfileEditor engines={config.engines} activeEngineId={config.activeEngineId} model={config.models.find((m) => m.id === profileEditing.modelId)} profile={profileEditing.profile} defaultProfileId={config.models.find((m) => m.id === profileEditing.modelId)?.defaultProfileId} onClose={() => setProfileEditing(null)} onSave={(profile, isDefault) => saveProfile(profileEditing.modelId, profile, isDefault)} />}
    {importOpen && <ImportModelModal existingPaths={new Set(config.models.map((model) => model.path.toLowerCase()))} onClose={() => setImportOpen(false)} onImport={handleImportModels} />}
    <EngineHubModal
      open={engineHubOpen}
      onClose={() => setEngineHubOpen(false)}
      activeEngineId={config.activeEngineId}
      engines={appEngines}
      onSelectActiveEngine={handleSelectActiveEngine}
      onSaveEngine={handleSaveEngine}
      onDeleteEngine={handleDeleteEngine}
      onOpenAddModal={() => setEngineAddModalOpen(true)}
    />
    {engineAddModalOpen && (
      <EngineModal
        onSave={(engine, setAsActive) => {
          let nextEngines = config.engines && config.engines.length > 0 ? [...config.engines] : [];
          nextEngines.push(engine);
          const nextActiveId = setAsActive ? engine.id : config.activeEngineId;
          const nextServerPath = setAsActive ? engine.path : config.serverPath;
          void persist(
            {
              ...config,
              engines: nextEngines,
              activeEngineId: nextActiveId,
              serverPath: nextServerPath,
            },
            t("toast.settingsSaved"),
          );
          setEngineAddModalOpen(false);
        }}
        onClose={() => setEngineAddModalOpen(false)}
      />
    )}
    {toast && <Toast>{toast}</Toast>}
    <AppUpdateDialog open={appUpdateDialogOpen} update={appUpdate} onClose={() => setAppUpdateDialogOpen(false)} />
    {orphanPids && orphanPids.length > 0 && (
      <OrphanServerModal
        pids={orphanPids}
        processes={orphanProcesses ?? undefined}
        isStartingService={Boolean(orphanPendingModel)}
        onKill={handleKillOrphan}
        onAdoptPath={async (path) => {
          let nextEngines = config.engines && config.engines.length > 0 ? [...config.engines] : [];
          if (config.activeEngineId) {
            const idx = nextEngines.findIndex((e) => e.id === config.activeEngineId);
            if (idx >= 0) nextEngines[idx] = { ...nextEngines[idx], path };
          }
          await persist({ ...config, serverPath: path, engines: nextEngines }, t("toast.settingsSaved"));
          setToast(t("toast.settingsSaved"));
        }}
        onClose={handleCloseOrphanModal}
      />
    )}
    {backupImportEnvelope && (
      <BackupImportModal
        envelope={backupImportEnvelope}
        currentConfig={config}
        onConfirm={async (merged, summaryToast) => {
          await persist(merged, summaryToast);
          setBackupImportEnvelope(null);
        }}
        onClose={() => setBackupImportEnvelope(null)}
        checkPathsExist={pathsExist}
        onPickFolder={pickDirectory}
      />
    )}
  </div>;
}
