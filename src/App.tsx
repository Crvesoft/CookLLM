import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_CONFIG, DEFAULT_PROFILES, INITIAL_LOGS, migrateConfig, uid } from "./data";
import { getServerStatus, isTauri, loadConfig, onLlamaLog, openExternal, saveConfig, setWindowTheme, startServer, stopServer } from "./tauri";
import type { PickedFile } from "./tauri";
import type { AppConfig, LlamaLogPayload, ModelAsset, Page, Profile, ServerStatus } from "./types";
import { ACCENTS, EMPTY_STATUS, fileName, modelTitle, newLog } from "./utils";
import { ConsoleDrawer, LogsPage, Sidebar, Toast, Topbar } from "./components/Layout";
import ImportModelModal from "./components/ImportModelModal";
import ModelsPage from "./components/ModelsPage";
import ProfilesPage from "./components/ProfilesPage";
import Playground from "./components/Playground";
import SettingsPage from "./components/SettingsPage";
import ProfileEditor from "./components/ProfileEditor";

export default function App() {
  const [config, setConfig] = useState<AppConfig>(DEMO_CONFIG);
  const [page, setPage] = useState<Page>("models");
  const [status, setStatus] = useState<ServerStatus>(EMPTY_STATUS);
  const [logs, setLogs] = useState<LlamaLogPayload[]>(INITIAL_LOGS);
  const [query, setQuery] = useState("");
  const [selectedProfiles, setSelectedProfiles] = useState<Record<string, string>>({});
  const [profileEditing, setProfileEditing] = useState<{ modelId: string; profile: Profile } | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menuModelId, setMenuModelId] = useState<string | null>(null);
  const [quickModelId, setQuickModelId] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

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
          unlisten = await onLlamaLog((payload) => active && setLogs((previous) => [...previous.slice(-999), payload]));
        } else {
          const stored = localStorage.getItem("cookllm-config"); if (stored && active) { const parsed = JSON.parse(stored) as AppConfig; adopt(parsed); }
        }
      } catch (error) { appendLog(`初始化失败：${String(error)}`, "stderr"); }
    })();
    return () => { active = false; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const timer = window.setInterval(() => { void getServerStatus().then(setStatus).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  /** 默认亮色主题；同时把标题栏同步给系统（Windows：暗色=黑，亮色=默认） */
  const theme = config.theme || "light";
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); void setWindowTheme(theme === "dark"); }, [theme]);
  useEffect(() => { if (consoleOpen) logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, consoleOpen]);
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
      setToast(`${modelTitle(model)} 已启动`);
    } catch (error) { appendLog(`启动失败：${String(error)}`, "stderr"); setToast("启动失败，请查看控制台"); }
    finally { setBusy(false); }
  };

  const handleStop = async () => {
    setBusy(true); appendLog("正在停止 llama-server …");
    try { if (isTauri()) setStatus(await stopServer()); else { await new Promise((resolve) => window.setTimeout(resolve, 380)); setStatus(EMPTY_STATUS); appendLog("llama-server 已停止"); } setToast("服务已停止"); }
    catch (error) { appendLog(`停止失败：${String(error)}`, "stderr"); }
    finally { setBusy(false); }
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
  const filteredModels = useMemo(() => { const q = query.trim().toLowerCase(); return q ? config.models.filter((model) => [model.name, model.architecture, model.quantization, model.path].join(" ").toLowerCase().includes(q)) : config.models; }, [config.models, query]);

  return <div className="app-shell">
    <Sidebar page={page} onPage={setPage} modelCount={config.models.length} theme={theme} onSetTheme={(t) => void persist({ ...config, theme: t })} />
    <div className="workspace"><Topbar page={page} query={query} onQuery={setQuery} running={status.running} busy={busy} onToggleService={status.running ? handleStop : startQuick} models={config.models} modelId={quickModelId || config.preferredModelId || config.models[0]?.id || ""} onSelectModel={setQuickModelId} /><main className="main-content">
      {page === "models" && <ModelsPage config={config} models={filteredModels} status={status} selectedProfiles={selectedProfiles} busy={busy} onAddModel={openImport} onSelectProfile={(modelId, profileId) => setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }))} onStart={handleStart} onStop={handleStop} onEditProfile={(model, profile) => setProfileEditing({ modelId: model.id, profile })} onRenameModel={renameModel} onSetDefaultModel={setDefaultModel} onOpenProfiles={() => setPage("profiles")} menuModelId={menuModelId} onMenuModel={setMenuModelId} onRemoveModel={removeModel} onReorderModel={reorderModels} onDeleteMultipleModels={removeMultipleModels} />}
      {page === "profiles" && <ProfilesPage models={config.models} onEdit={(modelId, profile) => setProfileEditing({ modelId, profile })} onDelete={deleteProfile} onDuplicate={duplicateProfile} onSetDefault={setDefaultProfile} onReorderProfile={reorderProfiles} onDeleteProfiles={deleteMultipleProfiles} />}
      {/* 会话页保持常驻（隐藏而非卸载）：切换菜单不销毁内嵌 WebUI，回来时无需从聊天记录重新进入 */}
      <div className="playground-pane" hidden={page !== "playground"}><Playground status={status} webUiUrl={webUiUrl} modelName={activeModel ? modelTitle(activeModel) : undefined} onOpenWebUi={openWebUi} /></div>
      {page === "logs" && <LogsPage logs={logs} status={status} onClear={() => setLogs([])} />}
      {page === "settings" && <SettingsPage config={config} onPersist={persist} onLog={appendLog} />}
    </main></div>
    <ConsoleDrawer logs={logs} open={consoleOpen} status={status} logEndRef={logEndRef} onToggle={() => setConsoleOpen((value) => !value)} onClear={() => setLogs([])} hidden={page === "logs"} />
    {profileEditing && <ProfileEditor profile={profileEditing.profile} defaultProfileId={config.models.find((m) => m.id === profileEditing.modelId)?.defaultProfileId} onClose={() => setProfileEditing(null)} onSave={(profile, isDefault) => saveProfile(profileEditing.modelId, profile, isDefault)} />}
    {importOpen && <ImportModelModal existingPaths={new Set(config.models.map((model) => model.path.toLowerCase()))} onClose={() => setImportOpen(false)} onImport={handleImportModels} />}
    {toast && <Toast>{toast}</Toast>}
  </div>;
}
