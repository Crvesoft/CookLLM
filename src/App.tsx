import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_CONFIG, DEFAULT_PROFILES, INITIAL_LOGS, migrateConfig, uid } from "./data";
import { getGpuStats, getServerStatus, isTauri, loadConfig, onLlamaLog, openExternal, saveConfig, setWindowTheme, startServer, stopServer } from "./tauri";
import type { PickedFile } from "./tauri";
import { PAGE_LOG_MODE, type AppConfig, type GpuStats, type LlamaLogPayload, type ModelAsset, type Page, type Profile, type ServerStatus, type TokSample } from "./types";
import { ACCENTS, EMPTY_STATUS, cn, fileName, modelTitle, newLog, parseTokPerSec } from "./utils";
import LogDock from "./components/LogDock";
import { LogsPage, Sidebar, Toast, Topbar } from "./components/Layout";
import ImportModelModal from "./components/ImportModelModal";
import ModelsPage from "./components/ModelsPage";
import ProfilesPage from "./components/ProfilesPage";
import Playground from "./components/Playground";
import SettingsPage from "./components/SettingsPage";
import ProfileEditor from "./components/ProfileEditor";

export default function App() {
  const [config, setConfig] = useState<AppConfig>(DEMO_CONFIG);
  /** GPU 性能监测开关（默认开启，设置页可关闭） */
  const gpuMonitorEnabled = config.gpuMonitorEnabled !== false;
  const [page, setPage] = useState<Page>("models");
  const [status, setStatus] = useState<ServerStatus>(EMPTY_STATUS);
  const [logs, setLogs] = useState<LlamaLogPayload[]>(INITIAL_LOGS);
  const [query, setQuery] = useState("");
  const [selectedProfiles, setSelectedProfiles] = useState<Record<string, string>>({});
  const [profileEditing, setProfileEditing] = useState<{ modelId: string; profile: Profile } | null>(null);
  // ---- Dock 日志状态（除"日志"整页外的所有页面共用同一份展开/高度状态）----
  /** Dock 默认收起：只显示底部状态栏，主区空间最大 */
  const [logDockOpen, setLogDockOpen] = useState(false);
  /** Dock 展开高度 px（120 ~ 60% 视口），持久化到 localStorage */
  const [logDockHeight, setLogDockHeight] = useState(() => { const stored = Number(localStorage.getItem("cookllm.logDock.height")); return Number.isFinite(stored) ? Math.max(120, Math.min(window.innerHeight * 0.6, stored)) : 280; });
  /** 服务异常：启动失败 / 进程意外退出；成功启动后清除 */
  const [serviceAbnormal, setServiceAbnormal] = useState(false);
  /** 最近一次从日志解析到的生成吞吐（带时间戳，微型状态卡据此判定"实时 / Idle"） */
  const [tokSample, setTokSample] = useState<TokSample | null>(null);
  /** GPU 实时指标（nvidia-smi，2s 轮询；浏览器模式恒为 null） */
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  /** 已武装：本次启动期间收到就绪日志后自动收起 Dock（停止 / 失败时重置，避免误关用户手动打开的 Dock） */
  const dockAutoCollapseRef = useRef(false);
  /** 本次退出是主动停止（区别于崩溃），由状态轮询消费 */
  const stopIntendedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menuModelId, setMenuModelId] = useState<string | null>(null);
  const [quickModelId, setQuickModelId] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  /** 侧边菜单收起（图标轨），持久化到 localStorage */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("cookllm.sidebar.collapsed") === "1");
  /** 配置加载完成前不启用 GPU/状态轮询，避免「关闭监测」用户首次挂载闪现图表 */
  const [configReady, setConfigReady] = useState(false);

  const appendLog = (line: string, stream: LlamaLogPayload["stream"] = "system") => setLogs((previous) => [...previous.slice(-999), newLog(line, stream)]);

  const adopt = (cfg: AppConfig) => {
    const usable = migrateConfig(cfg);
    setConfig(usable);
    setSelectedProfiles((previous) => {
      const next: Record<string, string> = {};
      for (const model of usable.models) {
        const prevId = model.profiles.some((p) => p.id === previous[model.id]) ? previous[model.id] : undefined;
        next[model.id] = prevId || model.defaultProfileId || model.profiles[0]?.id || "";
      }
      return next;
    });
  };

  useEffect(() => {
    let active = true; let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        if (isTauri()) {
          const loaded = await loadConfig();
          if (active && loaded) adopt(loaded);
          const current = await getServerStatus(); if (active) setStatus(current);
          unlisten = await onLlamaLog((payload) => {
            if (!active) return;
            setLogs((previous) => [...previous.slice(-999), payload]);
            // 检测到服务就绪 → 自动收起 Dock（仅启动期间武装，避免误关用户手动打开的 Dock）
            if (dockAutoCollapseRef.current && /is listening|listening on/i.test(payload.line)) { dockAutoCollapseRef.current = false; setLogDockOpen(false); }
            const tps = parseTokPerSec(payload.line); if (tps !== null) setTokSample({ rate: tps, at: Date.now() });
          });
        } else {
          const stored = localStorage.getItem("cookllm-config"); if (stored && active) { const parsed = JSON.parse(stored) as AppConfig; adopt(parsed); }
        }
      } catch (error) { appendLog(`初始化失败：${String(error)}`, "stderr"); }
      // 无论成功失败，配置读取阶段结束 → 解锁轮询
      if (active) setConfigReady(true);
    })();
    return () => { active = false; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauri() || !configReady) return;
    let active = true;
    const refresh = () => {
      void getServerStatus().then((st) => { if (active) setStatus(st); }).catch(() => undefined);
      // GPU 指标独立轮询：查询失败 / 无 NVIDIA 驱动 → null，卡片显示 "--"
      if (gpuMonitorEnabled) {
        // 响应到达时若已被关闭或 effect 已重跑（配置加载完成 / 用户切换），丢弃过期数据
        void getGpuStats().then((stats) => { if (active && gpuMonitorEnabled) setGpuStats(stats); }).catch(() => { if (active) setGpuStats(null); });
      } else {
        setGpuStats(null);
      }
    };
    // 挂载立即刷新一次（避免第一帧只显示版本号、2 秒后才出卡片）
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [gpuMonitorEnabled, configReady]);

  /** Dock 高度持久化：下次进入会话页时恢复 */
  useEffect(() => { localStorage.setItem("cookllm.logDock.height", String(logDockHeight)); }, [logDockHeight]);
  useEffect(() => { localStorage.setItem("cookllm.sidebar.collapsed", sidebarCollapsed ? "1" : "0"); }, [sidebarCollapsed]);

  /** 检测进程意外退出（运行中 → 停止，且不是主动停止）：标记服务异常并自动展开 Dock 显示 ERROR */
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const previous = prevRunningRef.current;
    if (previous && !status.running) {
      if (!stopIntendedRef.current) {
        appendLog("llama-server 进程意外退出", "stderr");
        setServiceAbnormal(true);
        setLogDockOpen(true);
      }
      stopIntendedRef.current = false;
    }
    prevRunningRef.current = status.running;
  }, [status.running]);

  /** 默认亮色主题；同时把标题栏同步给系统（Windows：暗色=黑，亮色=默认） */
  const theme = config.theme || "light";
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); void setWindowTheme(theme === "dark"); }, [theme]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), 2200); return () => window.clearTimeout(timeout); }, [toast]);

  const persist = async (next: AppConfig, message?: string) => {
    setConfig(next);
    try { await saveConfig(next); if (message) setToast(message); }
    catch (error) { appendLog(`配置保存失败：${String(error)}`, "stderr"); }
  };

  const activeModel = config.models.find((model) => model.id === status.modelId);
  const activeProfile = activeModel?.profiles.find((profile) => profile.id === status.profileId);
  /** 浏览器/iframe 无法导航到 0.0.0.0，统一替换为 127.0.0.1（用户显式配置的局域网 IP 保留原样） */
  const browserHost = (() => { const host = activeProfile?.host || "0.0.0.0"; return host === "0.0.0.0" ? "127.0.0.1" : host; })();
  const port = status.port || activeProfile?.port || 8080;
  const webUiUrl = `http://${browserHost}:${port}`;
  const openWebUi = async () => {
    if (!status.running) return;
    await openExternal(webUiUrl);
    setToast("已打开 Web UI");
  };

  const handleStart = async (model: ModelAsset) => {
    const profileId = selectedProfiles[model.id] || model.defaultProfileId || model.profiles[0]?.id || '';
    const profile = model.profiles.find((item) => item.id === profileId);
    if (!profile) return setToast("请先为模型添加运行预设");
    setBusy(true); setMenuModelId(null); appendLog(`正在启动 ${modelTitle(model)} · ${profile.name} …`);
    try {
      if (isTauri()) setStatus(await startServer(model.id, profile.id));
      else {
        await new Promise((resolve) => window.setTimeout(resolve, 650));
        setStatus({ running: true, pid: 18420, port: profile.port, modelId: model.id, modelName: model.name, profileId: profile.id, profileName: profile.name, startedAt: Date.now() });
        [`llama_model_loader: loaded meta data with ${model.parameters} parameters`, `load_tensors: offloading ${profile.gpuLayers} repeating layers to GPU`, `llama_context: n_ctx = ${profile.contextSize}, n_batch = ${profile.batchSize}, n_ubatch = ${profile.ubatchSize}`, `server is listening on http://${profile.host}:${profile.port}`].forEach((line, index) => window.setTimeout(() => appendLog(line, "stdout"), 180 * index));
      }
      setServiceAbnormal(false); // 启动成功 → 清除异常标记
      setTokSample(null);
      dockAutoCollapseRef.current = true; // 武装：本次启动期间收到就绪日志后自动收起 Dock
      if (page !== "logs") setLogDockOpen(true); // 所有 Dock 页启动时自动展开，显示加载日志；就绪后自动收起（日志整页本身就在看日志）
      setToast(`${modelTitle(model)} 已启动`);
    } catch (error) { appendLog(`启动失败：${String(error)}`, "stderr"); setServiceAbnormal(true); dockAutoCollapseRef.current = false; if (page !== "logs") setLogDockOpen(true); setToast("启动失败，请查看控制台"); }
    finally { setBusy(false); }
  };

  const handleStop = async () => {
    setBusy(true); appendLog("正在停止 llama-server …");
    stopIntendedRef.current = true; // 本次退出是主动停止 → 不判为服务异常
    dockAutoCollapseRef.current = false;
    try { if (isTauri()) setStatus(await stopServer()); else { await new Promise((resolve) => window.setTimeout(resolve, 380)); setStatus(EMPTY_STATUS); appendLog("llama-server 已停止"); } setToast("服务已停止"); }
    catch (error) { appendLog(`停止失败：${String(error)}`, "stderr"); }
    finally { setBusy(false); setTokSample(null); }
  };

  const addModelFromPaths = async (paths: { path: string; sizeBytes: number }[]) => {
    if (!paths.length) return;
    const existing = new Set(config.models.map((model) => model.path));
    const fresh = paths.filter((item) => !existing.has(item.path));
    if (!fresh.length) return setToast("所选模型已在仓库中");
    const additions: ModelAsset[] = fresh.map((item, index) => {
      const path = item.path;
      return { id: uid("model"), name: fileName(path).replace(/\.gguf$/i, "").replace(/[-_]/g, " "), path, sizeBytes: item.sizeBytes, architecture: "GGUF", quantization: path.match(/Q\d(?:_[A-Z0-9]+)+/i)?.[0]?.toUpperCase() || "未知量化", parameters: path.match(/\d+(?:\.\d+)?B/i)?.[0]?.toUpperCase() || "—", profiles: [{ ...DEFAULT_PROFILES[0], id: uid("profile") }], accent: ACCENTS[(config.models.length + index) % ACCENTS.length] };
    });
    setSelectedProfiles((previous) => { const next = { ...previous }; for (const model of additions) next[model.id] = model.profiles[0].id; return next; });
    await persist({ ...config, models: [...config.models, ...additions] }, additions.length === 1 ? "模型已加入仓库" : `已添加 ${additions.length} 个模型`);
  };
  /** 统一入口：打开导入弹窗（拖拽 / 选文件 / 选文件夹都在弹窗内完成） */
  const openImport = () => setImportOpen(true);
  const handleImportModels = async (paths: PickedFile[]) => {
    try { await addModelFromPaths(paths); }
    finally { setImportOpen(false); }
  };
  const removeModel = async (id: string) => {
    if (status.modelId === id) return setToast("请先停止正在运行的模型");
    setMenuModelId(null); await persist({ ...config, models: config.models.filter((model) => model.id !== id) }, "模型已移出仓库");
  };
  /** 拖拽排序提交（最终可见顺序）：拖动中页面只改本地预览，松手后一次性写盘。搜索过滤下的稳定交织——可见模型按新顺序填入原槽位，被过滤隐藏的保持原位 */
  const reorderModels = (visibleOrder: string[]) => {
    if (!visibleOrder.length) return;
    const visible = new Set(visibleOrder);
    const byId = new Map(config.models.map((item) => [item.id, item]));
    let cursor = 0;
    const list = config.models.map((item) => (visible.has(item.id) ? byId.get(visibleOrder[cursor++]) ?? item : item));
    if (list.every((item, index) => item.id === config.models[index].id)) return; // 顺序未变 → 不写盘、不打扰
    void persist({ ...config, models: list }, "已调整模型顺序");
  };
  /** 批量移出：运行中的模型不可删除，整批拦截 */
  const removeMultipleModels = async (ids: string[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const running = config.models.find((item) => status.modelId === item.id && idSet.has(item.id));
    if (running) return setToast("所选模型中有正在运行的，请先停止服务");
    await persist({ ...config, models: config.models.filter((model) => !idSet.has(model.id)) }, `已移出 ${ids.length} 个模型`);
  };
  const upsertProfile = (modelId: string, profile: Profile, message?: string) => {
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const profiles = model.profiles.some((item) => item.id === profile.id)
      ? model.profiles.map((item) => (item.id === profile.id ? profile : item))
      : [...model.profiles, profile];
    return persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles } : item)) }, message);
  };
  const saveProfile = async (modelId: string, profile: Profile, isDefault = false) => {
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const profiles = model.profiles.some((item) => item.id === profile.id)
      ? model.profiles.map((item) => (item.id === profile.id ? profile : item))
      : [...model.profiles, profile];
    const defaultProfileId = isDefault ? profile.id : (model.defaultProfileId === profile.id ? undefined : model.defaultProfileId);
    /** 编辑器里新开启「默认预设」时，同步模型仓库里的当前选择 */
    if (isDefault && model.defaultProfileId !== profile.id) setSelectedProfiles((previous) => ({ ...previous, [modelId]: profile.id }));
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles, defaultProfileId } : item)) }, "预设已保存");
    setProfileEditing(null);
  };
  const deleteProfile = async (modelId: string, id: string) => {
    if (status.modelId === modelId && status.profileId === id) return setToast("运行中的预设不可删除");
    const model = config.models.find((item) => item.id === modelId);
    const profiles = model ? model.profiles.filter((item) => item.id !== id) : [];
    setSelectedProfiles((previous) => (previous[modelId] === id ? { ...previous, [modelId]: profiles[0]?.id ?? "" } : previous));
    /** 删掉的若是默认预设，清掉悬空的 defaultProfileId */
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles, defaultProfileId: item.defaultProfileId === id ? undefined : item.defaultProfileId } : item)) }, "预设已删除");
  };
  /** 拖拽排序提交（同一模型内预设的最终顺序）：拖动中页面只改本地预览，松手后一次性写盘 */
  const reorderProfiles = (modelId: string, profileIds: string[]) => {
    if (!profileIds.length) return;
    const owner = config.models.find((item) => item.id === modelId);
    if (!owner || profileIds.length !== owner.profiles.length) return; // 数量对不上不提交，避免误删
    const byId = new Map(owner.profiles.map((profile) => [profile.id, profile]));
    const ordered = profileIds.flatMap((id) => { const profile = byId.get(id); return profile ? [profile] : []; });
    if (ordered.length !== owner.profiles.length) return; // 出现未知 id 不提交
    void persist({ ...config, models: config.models.map((item) => item.id === modelId ? { ...item, profiles: ordered } : item) }, "已调整预设顺序");
  };
  /** 批量删除：运行中的预设不可删除，整批拦截；同时清掉悬空的默认预设与当前选择 */
  const deleteMultipleProfiles = async (items: { modelId: string; profileId: string }[]) => {
    if (!items.length) return;
    const running = items.find((item) => status.modelId === item.modelId && status.profileId === item.profileId);
    if (running) return setToast("所选预设中有正在运行的，请先停止服务");
    const byModel = new Map<string, Set<string>>();
    for (const item of items) {
      const ids = byModel.get(item.modelId) ?? new Set<string>();
      ids.add(item.profileId);
      byModel.set(item.modelId, ids);
    }
    setSelectedProfiles((previous) => {
      const next = { ...previous };
      for (const [modelId, drop] of byModel) {
        const owner = config.models.find((item) => item.id === modelId);
        if (!owner || !drop.has(previous[modelId])) continue;
        next[modelId] = owner.profiles.find((profile) => !drop.has(profile.id))?.id ?? "";
      }
      return next;
    });
    await persist({ ...config, models: config.models.map((owner) => {
      const drop = byModel.get(owner.id);
      if (!drop || !drop.size) return owner;
      const profiles = owner.profiles.filter((profile) => !drop.has(profile.id));
      return { ...owner, profiles, defaultProfileId: owner.defaultProfileId && drop.has(owner.defaultProfileId) ? undefined : owner.defaultProfileId };
    }) }, `已删除 ${items.length} 组预设`);
  };
  const duplicateProfile = (modelId: string, profile: Profile) =>
    upsertProfile(modelId, { ...profile, id: uid("profile"), name: profile.name + " 副本" }, "已复制同模型副本");
  const setDefaultProfile = async (modelId: string, profileId: string) => {
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const makingDefault = model.defaultProfileId !== profileId;
    /** 设为默认即视为指定该预设启动，同步模型仓库里的当前选择 */
    if (makingDefault) setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }));
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, defaultProfileId: makingDefault ? profileId : undefined } : item)) }, makingDefault ? "已设为默认预设" : "已取消默认预设");
  };
  const renameModel = (modelId: string, displayName: string) => {
    const trimmed = displayName?.trim();
    void persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, displayName: trimmed ? trimmed : undefined } : item)) }, trimmed ? "已重命名" : "已恢复默认名称");
    setMenuModelId(null);
  };
  const setDefaultModel = (modelId: string) => {
    const makingDefault = config.preferredModelId !== modelId;
    void persist({ ...config, preferredModelId: makingDefault ? modelId : undefined }, makingDefault ? "已设为默认启动模型" : "已取消默认启动模型");
  };
  const startQuick = async () => {
    const id = quickModelId || config.preferredModelId || config.models[0]?.id || "";
    const model = config.models.find((item) => item.id === id) || config.models[0];
    if (!model) return setToast("请先添加一个模型");
    await handleStart(model);
  };
  const filteredModels = useMemo(() => { const q = query.trim().toLowerCase(); return q ? config.models.filter((model) => [modelTitle(model), model.architecture, model.quantization, model.path].join(" ").toLowerCase().includes(q)) : config.models; }, [config.models, query]);

  /** 当前页是否使用 Dock 日志（除"日志"整页外所有页面）：Dock 参与布局，无悬浮遮挡 */
  const isDockPage = PAGE_LOG_MODE[page] === "dock";

  return <div className={cn("app-shell", sidebarCollapsed && "sidebar-collapsed")}>
    <Sidebar page={page} onPage={setPage} modelCount={config.models.length} status={status} abnormal={serviceAbnormal} gpuStats={gpuStats} tokSample={tokSample} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} theme={theme} onToggleTheme={() => void persist({ ...config, theme: theme === "dark" ? "light" : "dark" })} />
    <div className={cn("workspace", isDockPage && "dock-mode")}><Topbar page={page} status={status} busy={busy} onToggleService={status.running ? handleStop : startQuick} models={config.models} modelId={quickModelId || config.preferredModelId || config.models[0]?.id || ""} onSelectModel={setQuickModelId} /><main className="main-content">
      {page === "models" && <ModelsPage config={config} models={filteredModels} status={status} selectedProfiles={selectedProfiles} busy={busy} query={query} onQuery={setQuery} onAddModel={openImport} onSelectProfile={(modelId, profileId) => setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }))} onStart={handleStart} onStop={handleStop} onEditProfile={(model, profile) => setProfileEditing({ modelId: model.id, profile })} onRenameModel={renameModel} onSetDefaultModel={setDefaultModel} onOpenProfiles={() => setPage("profiles")} menuModelId={menuModelId} onMenuModel={setMenuModelId} onRemoveModel={removeModel} onReorderModel={reorderModels} onDeleteMultipleModels={removeMultipleModels} />}
      {page === "profiles" && <ProfilesPage models={config.models} onEdit={(modelId, profile) => setProfileEditing({ modelId, profile })} onDelete={deleteProfile} onDuplicate={duplicateProfile} onSetDefault={setDefaultProfile} onReorderProfile={reorderProfiles} onDeleteProfiles={deleteMultipleProfiles} />}
      {/* 会话页保持常驻（隐藏而非卸载）：切换菜单不销毁内嵌 WebUI，回来时无需从聊天记录重新进入；WebUI 始终填满 Dock 下全部剩余高度 */}
      <Playground visible={page === "playground"} status={status} webUiUrl={webUiUrl} modelName={activeModel ? modelTitle(activeModel) : undefined} onOpenWebUi={openWebUi} />
      {page === "logs" && <LogsPage logs={logs} status={status} onClear={() => setLogs([])} />}
      {page === "settings" && <SettingsPage config={config} onPersist={persist} onLog={appendLog} />}
    </main>
    {/* Dock 日志参与布局（收起=底部状态栏 / 展开=可调高度面板），各页面共用同一份状态，不遮挡内容；仅"日志"整页除外 */}
    {isDockPage && <LogDock open={logDockOpen} height={logDockHeight} logs={logs} status={status} modelName={activeModel ? modelTitle(activeModel) : undefined} abnormal={serviceAbnormal} tokPerSec={tokSample ? tokSample.rate : null} onToggle={() => setLogDockOpen((value) => !value)} onHeightChange={setLogDockHeight} onClear={() => setLogs([])} />}
    </div>
    {profileEditing && <ProfileEditor profile={profileEditing.profile} defaultProfileId={config.models.find((m) => m.id === profileEditing.modelId)?.defaultProfileId} onClose={() => setProfileEditing(null)} onSave={(profile, isDefault) => saveProfile(profileEditing.modelId, profile, isDefault)} />}
    {importOpen && <ImportModelModal existingPaths={new Set(config.models.map((model) => model.path.toLowerCase()))} onClose={() => setImportOpen(false)} onImport={handleImportModels} />}
    {toast && <Toast>{toast}</Toast>}
  </div>;
}
