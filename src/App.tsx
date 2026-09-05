import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_CONFIG, DEFAULT_PROFILES, INITIAL_LOGS, migrateConfig, uid } from "./data";
import { setLocale, useI18n } from "./i18n";
import { checkForUpdate, getGpuStats, getModelsDir, getServerStatus, hfCancelDownload, hfDownload, hfDownloadUrl, hfPauseDownloads, isTauri, loadConfig, onLlamaLog, openExternal, pickModelsDir, removeLocalFile, revealInFolder, saveConfig, setWindowTheme, startServer, stopServer, type UpdateCheckResult } from "./tauri";
import type { ActiveDownload } from "./components/ExplorePage";
import type { PickedFile } from "./tauri";
import { onModelDownloadProgress } from "./tauri";
import type { DiskUsage, ModelDownloadProgress } from "./types";
import { PAGE_LOG_MODE, type AppConfig, type GpuStats, type LlamaLogPayload, type ModelAsset, type Page, type Profile, type ServerStatus, type TokSample } from "./types";
import { ACCENTS, EMPTY_STATUS, cn, fileName, formatBytes, modelTitle, newLog, parseTokPerSec } from "./utils";
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
import { APP_VERSION } from "./data";

/** 下载任务持久化 key：重开程序后恢复任务列表（含未完成的断点续传） */
const DOWNLOADS_STORAGE_KEY = "cookllm.downloads";
/** 自动续传全局一次性标记（StrictMode 双挂载 / 组件重建不会重复发起） */
let autoResumeTriggered = false;

function loadStoredDownloads(): ActiveDownload[] {
  try {
    const raw = localStorage.getItem(DOWNLOADS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActiveDownload[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function App() {
  /** 界面语言：文案经 t() 查当前 locale；locale 由 AppConfig.language 驱动（adopt/persist 时同步） */
  const { t } = useI18n();
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
  /** 社区探索：下载中任务（持久化到 localStorage，重开程序后恢复并自动续传） */
  const [downloads, setDownloads] = useState<ActiveDownload[]>(loadStoredDownloads);
  /** 社区探索：模型下载实时进度（仓库文件名 -> 进度） */
  const [modelProgress, setModelProgress] = useState<Record<string, ModelDownloadProgress>>({});
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);
  const [appUpdate, setAppUpdate] = useState<UpdateCheckResult | null>(null);
  const [appUpdateDialogOpen, setAppUpdateDialogOpen] = useState(false);
  const [appUpdateChecking, setAppUpdateChecking] = useState(false);
  const startupUpdateCheckedRef = useRef(false);
  /** 社区探索下载完成后刚导入的模型 id（卡片显示「刚刚导入」绿色 Badge，一定时间后消失） */
  const [justImportedIds, setJustImportedIds] = useState<Set<string>>(new Set());
  /** 下载任务镜像（供进度回调读取，避免闭包过期） */
  const downloadsRef = useRef<ActiveDownload[]>([]);
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
      } catch (error) { appendLog(t("log.initFailed", { error: String(error) }), "stderr"); }
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
        appendLog(t("log.unexpectedExit"), "stderr");
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



  // 读取模型存储目录与可用空间（配置加载完成后）
  useEffect(() => {
    if (!isTauri()) return;
    void getModelsDir().then((usage) => setDiskUsage(usage)).catch(() => undefined);
  }, [config.modelsDir]);

  const checkAppUpdate = async (openWhenAvailable = true) => {
    setAppUpdateChecking(true);
    try {
      const result = await checkForUpdate(APP_VERSION);
      setAppUpdate(result);
      if (result.status === "available" && openWhenAvailable) setAppUpdateDialogOpen(true);
      return result;
    } finally {
      setAppUpdateChecking(false);
    }
  };

  useEffect(() => {
    if (!configReady || config.autoUpdateEnabled === false || startupUpdateCheckedRef.current) return;
    startupUpdateCheckedRef.current = true;
    const timer = window.setTimeout(() => { void checkAppUpdate().catch(() => undefined); }, 1200);
    return () => window.clearTimeout(timer);
  }, [configReady, config.autoUpdateEnabled]);

  // 持久化任务列表：任何变更自动写盘（localStorage），重开程序后恢复
  useEffect(() => {
    try { localStorage.setItem(DOWNLOADS_STORAGE_KEY, JSON.stringify(downloads)); } catch { /* 忽略写入失败 */ }
  }, [downloads]);

  // 任务镜像随 state 同步（集中兜底，覆盖恢复初始值与所有 setDownloads 路径）
  useEffect(() => { downloadsRef.current = downloads; }, [downloads]);

  /** 启动一次通用下载启动器：仓库文件 / 直链统一走这里（自动续传复用） */
  const launchDownload = (entry: ActiveDownload) => {
    const run = entry.url ? hfDownloadUrl(entry.url) : hfDownload(entry.repo, entry.file);
    void run.then((result) => {
      appendLog(t("explore.downloaded") + ": " + result.path, "system");
      void importDownloadedModel(entry, result.path, result.sizeBytes);
    }).catch((error) => {
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("取消") || raw.includes("暂停")) { setToast(t("toast.downloadCancelled")); }
      else { appendLog(t("explore.error", { error: raw }), "stderr"); }
      const failed: ActiveDownload = { ...entry, status: "error", error: raw, speedBps: 0, finishedAt: Date.now() };
      setDownloads((previous) => previous.map((item) => (item.repo + "::" + item.file === entry.repo + "::" + entry.file ? failed : item)));
      downloadsRef.current = downloadsRef.current.map((item) => (item.repo + "::" + item.file === entry.repo + "::" + entry.file ? failed : item));
    });
  };

  // 启动后自动续传：恢复的任务中以 active 开场（上次退出时未完成）→ 重新发起下载（后端 .part 断点续传）
  useEffect(() => {
    if (!isTauri() || !configReady || autoResumeTriggered) return;
    const pending = downloadsRef.current.filter((item) => item.status === "active");
    if (!pending.length) return;
    autoResumeTriggered = true;
    const timer = window.setTimeout(() => {
      for (const task of pending) {
        const entry: ActiveDownload = { ...task, startedAt: Date.now(), status: "active", percent: 0, downloaded: 0, total: task.total ?? task.sizeBytes, speedBps: 0 };
        setDownloads((previous) => [...previous.filter((item) => !(item.repo === task.repo && item.file === task.file)), entry]);
        launchDownload(entry);
      }
      if (pending.length) setToast(t("toast.downloadQueued"));
    }, 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configReady]);

  // 订阅模型下载进度：同步任务状态（percent/speed/status），完成时标记 done 并延迟清理 progressMap
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const patchTask = (repo: string, file: string, patch: Partial<ActiveDownload>) => {
      const key = repo + "::" + file;
      setDownloads((previous) => previous.map((item) => (item.repo + "::" + item.file === key ? { ...item, ...patch } : item)));
      downloadsRef.current = downloadsRef.current.map((item) => (item.repo + "::" + item.file === key ? { ...item, ...patch } : item));
    };
    void onModelDownloadProgress((payload) => {
      const key = payload.repo + "::" + payload.file;
      setModelProgress((previous) => ({ ...previous, [key]: payload }));
      if (payload.phase === "done") {
        patchTask(payload.repo, payload.file, { status: "done", percent: 100, downloaded: payload.downloaded, total: payload.total, speedBps: 0, finishedAt: Date.now() });
        window.setTimeout(() => {
          setModelProgress((previous) => {
            const next = { ...previous };
            delete next[key];
            return next;
          });
        }, 1800);
      } else if (payload.phase === "error") {
        patchTask(payload.repo, payload.file, { status: "error", error: payload.message || "download failed", speedBps: 0, finishedAt: Date.now() });
      } else {
        patchTask(payload.repo, payload.file, { status: "active", percent: payload.percent, downloaded: payload.downloaded, total: payload.total, speedBps: payload.speedBps });
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = async (next: AppConfig, message?: string) => {
    setConfig(next);
    /** 语言随本次保存立即生效（值未变时为空操作） */
    setLocale(next.language ?? "zh");
    try { await saveConfig(next); if (message) setToast(message); }
    catch (error) { appendLog(t("log.saveConfigFailed", { error: String(error) }), "stderr"); }
  };


  /** 下载完成：仅把文件登记为本地资产（不自动创建预设、不自动启动），badge 打上「刚刚下载」 */
  const importDownloadedModel = async (download: ActiveDownload, path: string, sizeBytes?: number) => {
    try {
      const existing = new Set(config.models.map((model) => model.path.toLowerCase()));
      if (existing.has(path.toLowerCase())) {
        setDownloads((previous) => previous.map((item) => (item.repo + "::" + item.file === download.repo + "::" + download.file ? { ...item, status: "done" as const, path, finishedAt: Date.now() } : item)));
        return;
      }
      const name = fileName(path).replace(/\.gguf$/i, "").replace(/[-_]/g, " ");
      const paramMatch = path.match(/\d+(?:\.\d+)?B/i)?.[0]?.toUpperCase();
      const parameters = paramMatch || "—";
      const model: ModelAsset = {
        id: uid("model"),
        name,
        path,
        sizeBytes: sizeBytes ?? download.sizeBytes,
        architecture: "GGUF",
        quantization: path.match(/Q\d(?:_[A-Z0-9]+)+/i)?.[0]?.toUpperCase() || t("model.unknownQuant"),
        parameters,
        profiles: [],
        accent: ACCENTS[config.models.length % ACCENTS.length],
      };
      setJustImportedIds((previous) => new Set(previous).add(model.id));
      window.setTimeout(() => { setJustImportedIds((previous) => { const next = new Set(previous); next.delete(model.id); return next; }); }, 6000);
      setDownloads((previous) => previous.map((item) => (item.repo + "::" + item.file === download.repo + "::" + download.file ? { ...item, status: "done" as const, path, finishedAt: Date.now() } : item)));
      await persist({ ...config, models: [...config.models, model] }, t("toast.downloadImported", { name }));
    } catch (error) {
      appendLog(t("log.saveConfigFailed", { error: String(error) }), "stderr");
    }
  };

  /** 社区探索：点击下载 → 登记任务（task 池）+ 提示，进度由后端事件推送 */
  const handleModelDownload = (repo: string, file: string, sizeBytes: number) => {
    const entry: ActiveDownload = { repo, file, sizeBytes, startedAt: Date.now(), status: "active", percent: 0, downloaded: 0, total: sizeBytes, speedBps: 0 };
    setDownloads((previous) => [...previous.filter((item) => !(item.repo === repo && item.file === file)), entry]);
    downloadsRef.current = [...downloadsRef.current.filter((item) => !(item.repo === repo && item.file === file)), entry];
    void hfDownload(repo, file).then((result) => {
      appendLog(t("explore.downloaded") + ": " + result.path, "system");
      void importDownloadedModel(entry, result.path, result.sizeBytes);
    }).catch((error) => {
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("取消") || raw.includes("暂停")) { setToast(t("toast.downloadCancelled")); }
      else { appendLog(t("explore.error", { error: raw }), "stderr"); }
      const failed: ActiveDownload = { ...entry, status: "error", error: raw, speedBps: 0, finishedAt: Date.now() };
      setDownloads((previous) => previous.map((item) => (item.repo === repo && item.file === file ? failed : item)));
      downloadsRef.current = downloadsRef.current.map((item) => (item.repo === repo && item.file === file ? failed : item));
    });
    setToast(t("toast.downloadStarted"));
  };

  /** ===== 任务管理：暂停 / 重试 / 清理 / 取消 / 定位 ===== */
  const cancelTaskImpl = (task: ActiveDownload, withDelete: boolean) => {
    hfCancelDownload().catch(() => undefined);
    const failed: ActiveDownload = { ...task, status: "cancelled", error: "cancelled", speedBps: 0, finishedAt: Date.now() };
    setDownloads((previous) => previous.map((item) => (item.repo + "::" + item.file === task.repo + "::" + task.file ? failed : item)));
    downloadsRef.current = downloadsRef.current.map((item) => (item.repo + "::" + item.file === task.repo + "::" + task.file ? failed : item));
    if (withDelete) {
      // 已完成任务用 task.path；下载中则按 modelsRoot + repoDir + file 构造（含 .gguf.part 断点文件）
      const base = task.path || (diskUsage?.path ? diskUsage.path.replace(/[\\/]+$/, "") + (task.repo !== "direct-url" ? "/" + (task.repo.split("/").pop() || "") : "") : "");
      if (base) {
        void removeLocalFile(base).catch(() => undefined);
        void removeLocalFile(base + ".part").catch(() => undefined);
      }
    }
    setToast(t("toast.downloadCancelled"));
  };
  /** 暂停全部（后端置位暂停标志，下载循环下一轮退出并保留 .part） */
  const handlePauseAll = () => {
    void hfPauseDownloads().catch(() => undefined);
    setToast(t("toast.pausedAll"));
  };
  /** 恢复失败/已暂停任务：重新放入任务池并重新发起下载 */
  const handleResumeFailed = () => {
    const failedTasks = downloadsRef.current.filter((item) => item.status === "error" || item.status === "cancelled");
    setDownloads((previous) => previous.filter((item) => !(item.status === "error" || item.status === "cancelled")));
    downloadsRef.current = downloadsRef.current.filter((item) => !(item.status === "error" || item.status === "cancelled"));
    for (const task of failedTasks) {
      const entry: ActiveDownload = { ...task, startedAt: Date.now(), status: "active" as const, percent: 0, downloaded: 0, total: task.total ?? task.sizeBytes, speedBps: 0 };
      setDownloads((previous) => [...previous.filter((item) => !(item.repo === task.repo && item.file === task.file)), entry]);
      downloadsRef.current = [...downloadsRef.current.filter((item) => !(item.repo === task.repo && item.file === task.file)), entry];
      const run = task.url ? hfDownloadUrl(task.url) : hfDownload(task.repo, task.file);
      void run.then((result) => {
        appendLog(t("explore.downloaded") + ": " + result.path, "system");
        void importDownloadedModel(entry, result.path, result.sizeBytes);
      }).catch((error) => {
        const raw = error instanceof Error ? error.message : String(error);
        const failed: ActiveDownload = { ...entry, status: "error", error: raw, speedBps: 0, finishedAt: Date.now() };
        setDownloads((previous) => previous.map((item) => (item.repo === task.repo && item.file === task.file ? failed : item)));
        downloadsRef.current = downloadsRef.current.map((item) => (item.repo === task.repo && item.file === task.file ? failed : item));
      });
    }
    if (failedTasks.length) setToast(t("toast.resumedAll"));
  };
  /** 清除完成记录 */
  const handleClearDone = () => {
    setDownloads((previous) => previous.filter((item) => item.status !== "done"));
    downloadsRef.current = downloadsRef.current.filter((item) => item.status !== "done");
    setToast(t("toast.queueCleared"));
  };
  /** 单任务：暂停 / 取消并删除缓存 */
  const handleCancelTask = (task: ActiveDownload, deleteCache = false) => cancelTaskImpl(task, deleteCache);
  /** 单任务重试 */
  const handleRetry = (task: ActiveDownload) => {
    const entry: ActiveDownload = { ...task, startedAt: Date.now(), status: "active" as const, percent: 0, downloaded: 0, total: task.total ?? task.sizeBytes, speedBps: 0 };
    setDownloads((previous) => previous.map((item) => (item.repo === task.repo && item.file === task.file ? entry : item)));
    downloadsRef.current = downloadsRef.current.map((item) => (item.repo === task.repo && item.file === task.file ? entry : item));
    const run = task.url ? hfDownloadUrl(task.url) : hfDownload(task.repo, task.file);
    void run.then((result) => {
      appendLog(t("explore.downloaded") + ": " + result.path, "system");
      void importDownloadedModel(entry, result.path, result.sizeBytes);
    }).catch((error) => {
      const raw = error instanceof Error ? error.message : String(error);
      const failed: ActiveDownload = { ...entry, status: "error", error: raw, speedBps: 0, finishedAt: Date.now() };
      setDownloads((previous) => previous.map((item) => (item.repo === task.repo && item.file === task.file ? failed : item)));
      downloadsRef.current = downloadsRef.current.map((item) => (item.repo === task.repo && item.file === task.file ? failed : item));
    });
  };
  const handleReveal = async (path: string) => { await revealInFolder(path); };
  const goModels = () => { setPage("models"); };

  /** 设置页 / 社区探索共用：选择模型存储目录 */
  const pickModelsDirFlow = async () => {
    try {
      const picked = await pickModelsDir();
      if (!picked) return;
      const nextConfig = { ...config, modelsDir: picked };
      await persist(nextConfig, t("toast.dirChanged"));
      const usage = await getModelsDir();
      setDiskUsage(usage);
    } catch (error) {
      appendLog(t("explore.error", { error: error instanceof Error ? error.message : String(error) }), "stderr");
    }
  };

  const activeModel = config.models.find((model) => model.id === status.modelId);
  const activeProfile = activeModel?.profiles.find((profile) => profile.id === status.profileId);
  /** 浏览器/iframe 无法导航到 0.0.0.0，统一替换为 127.0.0.1（用户显式配置的局域网 IP 保留原样） */
  const browserHost = (() => { const host = activeProfile?.host || "0.0.0.0"; return host === "0.0.0.0" ? "127.0.0.1" : host; })();
  const port = status.port || activeProfile?.port || 9931;
  const webUiUrl = `http://${browserHost}:${port}`;
  const openWebUi = async () => {
    if (!status.running) return;
    await openExternal(webUiUrl);
    setToast(t("toast.webUiOpened"));
  };

  const handleStart = async (model: ModelAsset) => {
    const profileId = selectedProfiles[model.id] || model.defaultProfileId || model.profiles[0]?.id || '';
    const profile = model.profiles.find((item) => item.id === profileId);
    if (!profile) return setToast(t("toast.addProfileFirst"));
    setBusy(true); setMenuModelId(null); appendLog(t("toast.starting", { model: modelTitle(model), profile: profile.name }));
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
      if (profile.mmprojPath) appendLog(`--mmproj ${profile.mmprojPath}`, "stdout");
      if (page !== "logs") setLogDockOpen(true); // 所有 Dock 页启动时自动展开，显示加载日志；就绪后自动收起（日志整页本身就在看日志）
      setToast(t("toast.started", { model: modelTitle(model) }));
    } catch (error) { appendLog(t("log.startFailed", { error: String(error) }), "stderr"); setServiceAbnormal(true); dockAutoCollapseRef.current = false; if (page !== "logs") setLogDockOpen(true); setToast(t("toast.startFailedToast")); }
    finally { setBusy(false); }
  };

  const handleStop = async () => {
    setBusy(true); appendLog(t("log.stopping"));
    stopIntendedRef.current = true; // 本次退出是主动停止 → 不判为服务异常
    dockAutoCollapseRef.current = false;
    try { if (isTauri()) setStatus(await stopServer()); else { await new Promise((resolve) => window.setTimeout(resolve, 380)); setStatus(EMPTY_STATUS); appendLog(t("log.stopSuccess")); } setToast(t("toast.stopped")); }
    catch (error) { appendLog(t("log.stopFailed", { error: String(error) }), "stderr"); }
    finally { setBusy(false); setTokSample(null); }
  };

  const addModelFromPaths = async (paths: { path: string; sizeBytes: number }[]) => {
    if (!paths.length) return;
    const existing = new Set(config.models.map((model) => model.path));
    const fresh = paths.filter((item) => !existing.has(item.path));
    if (!fresh.length) return setToast(t("toast.alreadyInLibrary"));
    const additions: ModelAsset[] = fresh.map((item, index) => {
      const path = item.path;
      return { id: uid("model"), name: fileName(path).replace(/\.gguf$/i, "").replace(/[-_]/g, " "), path, sizeBytes: item.sizeBytes, architecture: "GGUF", quantization: path.match(/Q\d(?:_[A-Z0-9]+)+/i)?.[0]?.toUpperCase() || t("model.unknownQuant"), parameters: path.match(/\d+(?:\.\d+)?B/i)?.[0]?.toUpperCase() || "—", profiles: [{ ...DEFAULT_PROFILES[0], id: uid("profile") }], accent: ACCENTS[(config.models.length + index) % ACCENTS.length] };
    });
    setSelectedProfiles((previous) => { const next = { ...previous }; for (const model of additions) next[model.id] = model.profiles[0].id; return next; });
    await persist({ ...config, models: [...config.models, ...additions] }, t(additions.length === 1 ? "toast.modelAdded" : "toast.modelsAdded", { count: additions.length }));
  };
  /** 统一入口：打开导入弹窗（拖拽 / 选文件 / 选文件夹都在弹窗内完成） */
  const openImport = () => setImportOpen(true);
  const handleImportModels = async (paths: PickedFile[]) => {
    try { await addModelFromPaths(paths); }
    finally { setImportOpen(false); }
  };
  const removeModel = async (id: string) => {
    if (status.modelId === id) return setToast(t("toast.stopFirst"));
    setMenuModelId(null); await persist({ ...config, models: config.models.filter((model) => model.id !== id) }, t("toast.modelRemoved"));
  };
  /** 拖拽排序提交（最终可见顺序）：拖动中页面只改本地预览，松手后一次性写盘。搜索过滤下的稳定交织——可见模型按新顺序填入原槽位，被过滤隐藏的保持原位 */
  const reorderModels = (visibleOrder: string[]) => {
    if (!visibleOrder.length) return;
    const visible = new Set(visibleOrder);
    const byId = new Map(config.models.map((item) => [item.id, item]));
    let cursor = 0;
    const list = config.models.map((item) => (visible.has(item.id) ? byId.get(visibleOrder[cursor++]) ?? item : item));
    if (list.every((item, index) => item.id === config.models[index].id)) return; // 顺序未变 → 不写盘、不打扰
    void persist({ ...config, models: list }, t("toast.orderUpdated"));
  };
  /** 批量移出：运行中的模型不可删除，整批拦截 */
  const removeMultipleModels = async (ids: string[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const running = config.models.find((item) => status.modelId === item.id && idSet.has(item.id));
    if (running) return setToast(t("toast.runningSelectedModels"));
    await persist({ ...config, models: config.models.filter((model) => !idSet.has(model.id)) }, t("toast.modelsRemoved", { count: ids.length }));
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
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles, defaultProfileId } : item)) }, t("toast.profileSaved"));
    setProfileEditing(null);
  };
  const deleteProfile = async (modelId: string, id: string) => {
    if (status.modelId === modelId && status.profileId === id) return setToast(t("toast.runningProfileLocked"));
    const model = config.models.find((item) => item.id === modelId);
    const profiles = model ? model.profiles.filter((item) => item.id !== id) : [];
    setSelectedProfiles((previous) => (previous[modelId] === id ? { ...previous, [modelId]: profiles[0]?.id ?? "" } : previous));
    /** 删掉的若是默认预设，清掉悬空的 defaultProfileId */
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles, defaultProfileId: item.defaultProfileId === id ? undefined : item.defaultProfileId } : item)) }, t("toast.profileDeleted"));
  };
  /** 拖拽排序提交（同一模型内预设的最终顺序）：拖动中页面只改本地预览，松手后一次性写盘 */
  const reorderProfiles = (modelId: string, profileIds: string[]) => {
    if (!profileIds.length) return;
    const owner = config.models.find((item) => item.id === modelId);
    if (!owner || profileIds.length !== owner.profiles.length) return; // 数量对不上不提交，避免误删
    const byId = new Map(owner.profiles.map((profile) => [profile.id, profile]));
    const ordered = profileIds.flatMap((id) => { const profile = byId.get(id); return profile ? [profile] : []; });
    if (ordered.length !== owner.profiles.length) return; // 出现未知 id 不提交
    void persist({ ...config, models: config.models.map((item) => item.id === modelId ? { ...item, profiles: ordered } : item) }, t("toast.profilesOrderUpdated"));
  };
  /** 批量删除：运行中的预设不可删除，整批拦截；同时清掉悬空的默认预设与当前选择 */
  const deleteMultipleProfiles = async (items: { modelId: string; profileId: string }[]) => {
    if (!items.length) return;
    const running = items.find((item) => status.modelId === item.modelId && status.profileId === item.profileId);
    if (running) return setToast(t("toast.runningSelectedProfiles"));
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
    }) }, t("toast.profilesDeleted", { count: items.length }));
  };
  const duplicateProfile = (modelId: string, profile: Profile) =>
    upsertProfile(modelId, { ...profile, id: uid("profile"), name: profile.name + t("profile.copySuffix") }, t("toast.profileCopied"));
  const setDefaultProfile = async (modelId: string, profileId: string) => {
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const makingDefault = model.defaultProfileId !== profileId;
    /** 设为默认即视为指定该预设启动，同步模型仓库里的当前选择 */
    if (makingDefault) setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }));
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, defaultProfileId: makingDefault ? profileId : undefined } : item)) }, t(makingDefault ? "toast.defaultSet" : "toast.defaultUnset"));
  };
  const renameModel = (modelId: string, displayName: string) => {
    const trimmed = displayName?.trim();
    void persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, displayName: trimmed ? trimmed : undefined } : item)) }, t(trimmed ? "toast.renamed" : "toast.nameRestored"));
    setMenuModelId(null);
  };
  const setDefaultModel = (modelId: string) => {
    const makingDefault = config.preferredModelId !== modelId;
    void persist({ ...config, preferredModelId: makingDefault ? modelId : undefined }, t(makingDefault ? "toast.launchModelSet" : "toast.launchModelUnset"));
  };
  const startQuick = async () => {
    const id = quickModelId || config.preferredModelId || config.models[0]?.id || "";
    const model = config.models.find((item) => item.id === id) || config.models[0];
    if (!model) return setToast(t("toast.addFirst"));
    await handleStart(model);
  };
  const filteredModels = useMemo(() => { const q = query.trim().toLowerCase(); return q ? config.models.filter((model) => [modelTitle(model), model.architecture, model.quantization, model.path].join(" ").toLowerCase().includes(q)) : config.models; }, [config.models, query]);

  /** 当前页是否使用 Dock 日志（除"日志"整页外所有页面）：Dock 参与布局，无悬浮遮挡 */
  const isDockPage = PAGE_LOG_MODE[page] === "dock";

  /** 侧边栏「社区探索」下载角标：后台有进行中任务时动态显示数量 */
  const exploreActive = downloads.filter((item) => item.status === "active").length;
  const exploreBadge = exploreActive > 0 ? String(exploreActive) : undefined;

  return <div className={cn("app-shell", sidebarCollapsed && "sidebar-collapsed")}>
    <Sidebar page={page} onPage={setPage} modelCount={config.models.length} downloadBadge={exploreBadge} updateAvailable={appUpdate?.status === "available"} status={status} abnormal={serviceAbnormal} gpuStats={gpuStats} tokSample={tokSample} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} theme={theme} onToggleTheme={() => void persist({ ...config, theme: theme === "dark" ? "light" : "dark" })} />
    <div className={cn("workspace", isDockPage && "dock-mode")}><Topbar page={page} status={status} busy={busy} onToggleService={status.running ? handleStop : startQuick} models={config.models} modelId={quickModelId || config.preferredModelId || config.models[0]?.id || ""} onSelectModel={setQuickModelId} /><main className="main-content">
      {page === "models" && <ModelsPage config={config} models={filteredModels} status={status} selectedProfiles={selectedProfiles} busy={busy} query={query} onQuery={setQuery} onAddModel={openImport} onSelectProfile={(modelId, profileId) => setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }))} onStart={handleStart} onStop={handleStop} onEditProfile={(model, profile) => setProfileEditing({ modelId: model.id, profile })} onAddProfile={(model) => setProfileEditing({ modelId: model.id, profile: { ...DEFAULT_PROFILES[0], id: uid("profile"), name: t("newProfile") } })} onRenameModel={renameModel} onSetDefaultModel={setDefaultModel} onOpenProfiles={() => setPage("profiles")} menuModelId={menuModelId} onMenuModel={setMenuModelId} onRemoveModel={removeModel} onReorderModel={reorderModels} onDeleteMultipleModels={removeMultipleModels} downloads={downloads} modelProgress={modelProgress} justImportedIds={justImportedIds} />}
      <ExplorePage visible={page === "explore"} config={config} onPersist={persist} onToast={setToast} onLog={appendLog} diskUsage={diskUsage} onPickModelsDir={pickModelsDirFlow} onDownload={handleModelDownload} activeDownloads={downloads} progressMap={modelProgress} onPauseAll={handlePauseAll} onResumeFailed={handleResumeFailed} onClearDone={handleClearDone} onCancelTask={handleCancelTask} onRetry={handleRetry} onReveal={handleReveal} onGoModels={goModels} />
      {page === "profiles" && <ProfilesPage models={config.models} onEdit={(modelId, profile) => setProfileEditing({ modelId, profile })} onDelete={deleteProfile} onDuplicate={duplicateProfile} onSetDefault={setDefaultProfile} onReorderProfile={reorderProfiles} onDeleteProfiles={deleteMultipleProfiles} />}
      {/* 会话页保持常驻（隐藏而非卸载）：切换菜单不销毁内嵌 WebUI，回来时无需从聊天记录重新进入；WebUI 始终填满 Dock 下全部剩余高度 */}
      <Playground visible={page === "playground"} status={status} webUiUrl={webUiUrl} modelName={activeModel ? modelTitle(activeModel) : undefined} onOpenWebUi={openWebUi} />
      {page === "logs" && <LogsPage logs={logs} status={status} onClear={() => setLogs([])} />}
      <SettingsPage visible={page === "settings"} config={config} appUpdate={appUpdate} checkingUpdate={appUpdateChecking} onCheckUpdate={checkAppUpdate} onOpenUpdate={() => setAppUpdateDialogOpen(true)} onPersist={persist} onLog={appendLog} />
    </main>
    {/* Dock 日志参与布局（收起=底部状态栏 / 展开=可调高度面板），各页面共用同一份状态，不遮挡内容；仅"日志"整页除外 */}
    {isDockPage && <LogDock open={logDockOpen} height={logDockHeight} logs={logs} status={status} modelName={activeModel ? modelTitle(activeModel) : undefined} abnormal={serviceAbnormal} tokPerSec={tokSample ? tokSample.rate : null} onToggle={() => setLogDockOpen((value) => !value)} onHeightChange={setLogDockHeight} onClear={() => setLogs([])} />}
    </div>
    {profileEditing && <ProfileEditor model={config.models.find((m) => m.id === profileEditing.modelId)} profile={profileEditing.profile} defaultProfileId={config.models.find((m) => m.id === profileEditing.modelId)?.defaultProfileId} onClose={() => setProfileEditing(null)} onSave={(profile, isDefault) => saveProfile(profileEditing.modelId, profile, isDefault)} />}
    {importOpen && <ImportModelModal existingPaths={new Set(config.models.map((model) => model.path.toLowerCase()))} onClose={() => setImportOpen(false)} onImport={handleImportModels} />}
    {toast && <Toast>{toast}</Toast>}
    <AppUpdateDialog open={appUpdateDialogOpen} update={appUpdate} onClose={() => setAppUpdateDialogOpen(false)} />
  </div>;
}
