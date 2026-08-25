import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_CONFIG, DEFAULT_PROFILES, INITIAL_LOGS, migrateConfig, uid } from "./data";
import { getServerStatus, isTauri, loadConfig, onLlamaLog, openExternal, saveConfig, startServer, stopServer } from "./tauri";
import type { PickedFile } from "./tauri";
import type { AppConfig, ChatMessage, LlamaLogPayload, ModelAsset, Page, Profile, ServerStatus } from "./types";
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
  const [messages, setMessages] = useState<ChatMessage[]>(() => { try { const raw = localStorage.getItem("cookllm-chat"); if (raw) return JSON.parse(raw) as ChatMessage[]; } catch { /* ignore */ } return []; });
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

  useEffect(() => { document.documentElement.setAttribute("data-theme", config.theme || "dark"); }, [config.theme]);
  useEffect(() => { try { localStorage.setItem("cookllm-chat", JSON.stringify(messages.slice(-200))); } catch { /* ignore */ } }, [messages]);

  useEffect(() => { if (consoleOpen) logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, consoleOpen]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), 2200); return () => window.clearTimeout(timeout); }, [toast]);

  const persist = async (next: AppConfig, message?: string) => {
    setConfig(next);
    try { await saveConfig(next); if (message) setToast(message); }
    catch (error) { appendLog(`配置保存失败：${String(error)}`, "stderr"); }
  };

  const activeModel = config.models.find((model) => model.id === status.modelId);
  const activeProfile = activeModel?.profiles.find((profile) => profile.id === status.profileId);
  const baseUrl = `http://${activeProfile?.host || "0.0.0.0"}:${status.port || activeProfile?.port || 8080}/v1`;
  const webUiPort = status.port || activeProfile?.port || 8080;
  const webUiUrl = `http://${activeProfile?.host || "0.0.0.0"}:${webUiPort}`;
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
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles, defaultProfileId } : item)) }, "预设已保存");
    setProfileEditing(null);
  };
  const deleteProfile = async (modelId: string, id: string) => {
    if (status.modelId === modelId && status.profileId === id) return setToast("运行中的预设不可删除");
    const model = config.models.find((item) => item.id === modelId);
    const profiles = model ? model.profiles.filter((item) => item.id !== id) : [];
    setSelectedProfiles((previous) => (previous[modelId] === id ? { ...previous, [modelId]: profiles[0]?.id ?? "" } : previous));
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles } : item)) }, "预设已删除");
  };
  const duplicateProfile = (modelId: string, profile: Profile) =>
    upsertProfile(modelId, { ...profile, id: uid("profile"), name: profile.name + " 副本" }, "已复制同模型副本");
  const renameModel = (modelId: string, displayName: string) => {
    const trimmed = displayName?.trim();
    void persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, displayName: trimmed ? trimmed : undefined } : item)) }, trimmed ? "已重命名" : "已恢复默认名称");
    setMenuModelId(null);
  };
  const setDefaultModelById = (modelId: string) =>
    void persist({ ...config, preferredModelId: modelId }, "已设为默认启动模型");
  const startQuick = async () => {
    const id = quickModelId || config.preferredModelId || config.models[0]?.id || "";
    const model = config.models.find((item) => item.id === id) || config.models[0];
    if (!model) return setToast("请先添加一个模型");
    await handleStart(model);
  };
  const filteredModels = useMemo(() => { const q = query.trim().toLowerCase(); return q ? config.models.filter((model) => [model.name, model.architecture, model.quantization, model.path].join(" ").toLowerCase().includes(q)) : config.models; }, [config.models, query]);

  return <div className="app-shell">
    <Sidebar page={page} onPage={setPage} modelCount={config.models.length} theme={config.theme || "dark"} onSetTheme={(t) => void persist({ ...config, theme: t })} />
    <div className="workspace"><Topbar query={query} onQuery={setQuery} running={status.running} busy={busy} onToggleService={status.running ? handleStop : startQuick} models={config.models} modelId={quickModelId || config.preferredModelId || config.models[0]?.id || ""} onSelectModel={setQuickModelId} /><main className="main-content">
      {page === "models" && <ModelsPage config={config} models={filteredModels} status={status} selectedProfiles={selectedProfiles} busy={busy} onAddModel={openImport} onSelectProfile={(modelId, profileId) => setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }))} onStart={handleStart} onEditProfile={(model, profile) => setProfileEditing({ modelId: model.id, profile })} onRenameModel={renameModel} onSetDefaultModel={setDefaultModelById} onOpenProfiles={() => setPage("profiles")} menuModelId={menuModelId} onMenuModel={setMenuModelId} onRemoveModel={removeModel} />}
      {page === "profiles" && <ProfilesPage models={config.models} onEdit={(modelId, profile) => setProfileEditing({ modelId, profile })} onDelete={deleteProfile} onDuplicate={duplicateProfile} />}
      {page === "playground" && <Playground status={status} baseUrl={baseUrl} modelName={activeModel ? modelTitle(activeModel) : undefined} messages={messages} setMessages={setMessages} onOpenWebUi={openWebUi} />}
      {page === "logs" && <LogsPage logs={logs} status={status} onClear={() => setLogs([])} />}
      {page === "settings" && <SettingsPage config={config} onPersist={persist} onLog={appendLog} />}
    </main></div>
    <ConsoleDrawer logs={logs} open={consoleOpen} status={status} logEndRef={logEndRef} onToggle={() => setConsoleOpen((value) => !value)} onClear={() => setLogs([])} hidden={page === "logs"} />
    {profileEditing && <ProfileEditor profile={profileEditing.profile} defaultProfileId={config.models.find((m) => m.id === profileEditing.modelId)?.defaultProfileId} onClose={() => setProfileEditing(null)} onSave={(profile, isDefault) => saveProfile(profileEditing.modelId, profile, isDefault)} />}
    {importOpen && <ImportModelModal existingPaths={new Set(config.models.map((model) => model.path.toLowerCase()))} onClose={() => setImportOpen(false)} onImport={handleImportModels} />}
    {toast && <Toast>{toast}</Toast>}
  </div>;
}
