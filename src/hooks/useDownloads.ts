import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { defaultProfilesForModel, uid } from "../data";
import { getModelsDir, hfCancelDownload, hfClearDownload, hfDownload, hfDownloadUrl, hfPauseDownload, inspectGguf, isTauri, msDownload, onModelDownloadProgress, pickModelsDir, removeLocalFile, revealInFolder } from "../tauri";
import type { ActiveDownload, AppConfig, CommunitySource, DiskUsage, DownloadErrorCode, DownloadErrorPayload, ModelAsset, ModelDownloadProgress } from "../types";
import { ACCENTS, fileName, parseQuantization } from "../utils";
import type { AppendLog, PersistConfig, Translate } from "./types";

/** 下载任务持久化 key：重开程序后恢复任务列表（含未完成的断点续传） */
const DOWNLOADS_STORAGE_KEY = "cookllm.downloads";
/** 自动续传全局一次性标记（StrictMode 双挂载 / 组件重建不会重复发起） */
let autoResumeTriggered = false;

function loadStoredDownloads(): ActiveDownload[] {
  try {
    const raw = localStorage.getItem(DOWNLOADS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActiveDownload[];
    return Array.isArray(parsed) ? parsed.map((item) => ({ ...item, taskId: item.taskId || uid("download") })) : [];
  } catch {
    return [];
  }
}

function toDownloadError(error: unknown): DownloadErrorPayload {
  if (typeof error === "object" && error !== null) {
    const payload = error as Partial<DownloadErrorPayload>;
    if (typeof payload.code === "string" && typeof payload.message === "string") {
      return { code: payload.code as DownloadErrorCode, message: payload.message };
    }
  }
  return { code: "download_failed", message: error instanceof Error ? error.message : String(error) };
}

interface UseDownloadsOptions {
  config: AppConfig;
  configRef: MutableRefObject<AppConfig>;
  configReady: boolean;
  persist: PersistConfig;
  setToast: (message: string) => void;
  appendLog: AppendLog;
  setSelectedProfiles: Dispatch<SetStateAction<Record<string, string>>>;
  t: Translate;
}

/** 社区探索下载任务：任务池、进度订阅、暂停/续传/取消/删除，以及下载完成后的模型入库 */
export function useDownloads({ config, configRef, configReady, persist, setToast, appendLog, setSelectedProfiles, t }: UseDownloadsOptions) {
  /** 社区探索：下载中任务（持久化到 localStorage，重开程序后恢复并自动续传） */
  const [downloads, setDownloads] = useState<ActiveDownload[]>(loadStoredDownloads);
  /** 社区探索：模型下载实时进度（仓库::文件名 -> 进度） */
  const [modelProgress, setModelProgress] = useState<Record<string, ModelDownloadProgress>>({});
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);
  /** 社区探索下载完成后刚导入的模型 id（卡片显示「刚刚导入」绿色 Badge，一定时间后消失） */
  const [justImportedIds, setJustImportedIds] = useState<Set<string>>(new Set());
  /** 下载任务镜像（供进度回调读取，避免闭包过期） */
  const downloadsRef = useRef<ActiveDownload[]>([]);
  /** 任务列表唯一变更入口：state 与镜像 ref 在同一处更新，所有下载任务的增删改都走它（消除成对双写） */
  const mutateDownloads = (updater: (previous: ActiveDownload[]) => ActiveDownload[]) => {
    setDownloads((previous) => {
      const next = updater(previous);
      downloadsRef.current = next;
      return next;
    });
  };
  const pauseRequestedRef = useRef<Set<string>>(new Set());
  const cancelledTaskIdsRef = useRef<Set<string>>(new Set());

  const clearProgressKey = (repo: string, file: string) => {
    const key = repo + "::" + file;
    setModelProgress((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  /** 按唯一 taskId 合并更新单个下载任务（进度回调/取消/暂停/删除共用） */
  const patchByTaskId = (taskId: string, patch: Partial<ActiveDownload>) => {
    mutateDownloads((previous) => previous.map((item) => (item.taskId === taskId ? { ...item, ...patch } : item)));
  };

  /** 下载失败：记录错误信息与闭环引导类型 */
  const settleEntry = (entry: ActiveDownload, error: DownloadErrorPayload, kind?: ActiveDownload["errorKind"]): ActiveDownload => ({
    ...entry,
    status: "error",
    error: error.message || t("explore.statusError"),
    errorKind: kind,
    speedBps: 0,
    finishedAt: Date.now(),
  });

  const getTaskFilePath = (task: ActiveDownload): string => {
    if (task.path) return task.path;
    if (!diskUsage?.path) return "";
    const root = diskUsage.path.replace(/[\\/]+$/, "");
    if (task.repo === "direct-url") {
      return root + "/" + task.file;
    }
    const repoDir = task.repo.split("/").pop() || task.repo;
    const sanitized = repoDir.replace(/[^a-zA-Z0-9\-_.]/g, "_") || "model";
    return root + "/" + sanitized + "/" + task.file;
  };

  /** 清理某任务在本地的缓存文件：目标文件 + .part 断点文件（已入库的完成任务由调用方跳过） */
  const removeTaskFiles = (task: ActiveDownload) => {
    const file = getTaskFilePath(task);
    if (file) {
      void removeLocalFile(file).catch(() => undefined);
      void removeLocalFile(file + ".part").catch(() => undefined);
    }
  };

  /** 下载完成：仅把主模型登记为本地资产（mmproj 图识模型仅保存文件供预设挂载，不自动入库），badge 打上「刚刚下载」 */
  const importDownloadedModel = async (download: ActiveDownload, path: string, sizeBytes?: number) => {
    try {
      const fileBaseName = fileName(path);
      // 图识视觉模型（mmproj）是辅助模型，需通过启动参数 --mmproj 挂载在主模型预设下，不作为独立模型入库
      if (fileBaseName.toLowerCase().includes("mmproj")) {
        patchByTaskId(download.taskId, { status: "done" as const, path, finishedAt: Date.now() });
        setToast(t("toast.downloadDoneMmproj", { name: fileBaseName }));
        return;
      }

      // 下载耗时数分钟，期间用户可能改过设置：读最新 config 而非发起下载时的闭包快照，
      // 否则 persist 会把用户中途修改的主题 / 语言 / 代理等一并回滚
      const currentConfig = configRef.current;
      const existing = new Set(currentConfig.models.map((model) => model.path.toLowerCase()));
      if (existing.has(path.toLowerCase())) {
        patchByTaskId(download.taskId, { status: "done" as const, path, finishedAt: Date.now() });
        return;
      }
      const name = fileBaseName.replace(/\.(gguf|ninfer)$/i, "").replace(/[-_]/g, " ");
      const isNinfer = path.toLowerCase().endsWith(".ninfer");
      const isGguf = path.toLowerCase().endsWith(".gguf");
      const ext = (path.split(".").pop() || "FILE").toUpperCase();
      const meta = await inspectGguf(path).catch(() => ({ architecture: "", parameters: "", quantization: "" }));
      const paramMatch = path.match(/\d+(?:\.\d+)?B/i)?.[0]?.toUpperCase();
      const parameters = meta.parameters || paramMatch || "—";
      const initialProfiles = defaultProfilesForModel(path);
      const defaultProfile = initialProfiles[0];
      const model: ModelAsset = {
        id: uid("model"),
        name,
        path,
        sizeBytes: sizeBytes ?? download.sizeBytes,
        architecture: meta.architecture || (isNinfer ? "NINFER" : isGguf ? "GGUF" : ext),
        quantization: meta.quantization || parseQuantization(path, t("model.unknownQuant")),
        parameters,
        metadataSource: meta.architecture || meta.quantization || meta.parameters ? (isNinfer ? "ninfer" : isGguf ? "gguf" : "filename") : "filename",
        profiles: initialProfiles,
        accent: ACCENTS[currentConfig.models.length % ACCENTS.length],
      };
      setSelectedProfiles((previous) => ({ ...previous, [model.id]: defaultProfile.id }));
      setJustImportedIds((previous) => new Set(previous).add(model.id));
      window.setTimeout(() => { setJustImportedIds((previous) => { const next = new Set(previous); next.delete(model.id); return next; }); }, 6000);
      patchByTaskId(download.taskId, { status: "done" as const, path, finishedAt: Date.now() });
      await persist({ ...currentConfig, models: [...currentConfig.models, model] }, t("toast.downloadImported", { name }));
    } catch (error) {
      appendLog(t("log.saveConfigFailed", { error: String(error) }), "stderr");
    }
  };

  /** 进行中进度的节流挂起表（taskId → 待刷新进度）：任务进入终态 / 用户暂停取消时必须清掉，
   *  否则挂起的旧进度会在 200ms 后把已暂停的任务写回「进行中」，出现速度冻结的假进行中 */
  const pendingProgressRef = useRef(new Map<string, { timer: number; payload: ModelDownloadProgress }>());
  const cancelPendingProgress = (taskId: string) => {
    const pending = pendingProgressRef.current.get(taskId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingProgressRef.current.delete(taskId);
  };

  /** 启动一次通用下载启动器：仓库文件 / 直链统一走这里（自动续传 / 恢复 / 重试复用）。
   *  每次都以唯一 taskId 发起，后端按 taskId 注册独立控制器，取消 / 暂停不会串扰其他任务。 */
  const launchDownload = (entry: ActiveDownload) => {
    pauseRequestedRef.current.delete(entry.taskId);
    void (async () => {
      // 必须先等摘除旧控制器完成、再发起下载：两个 invoke 若乱序，hf_clear_download 会把
      // 刚注册的新控制器摘掉，此后暂停 / 取消永远找不到控制器（孤儿循环停不下来）
      try { await hfClearDownload(entry.taskId); } catch { /* 旧控制器不存在时忽略 */ }
      const run = entry.url
        ? hfDownloadUrl(entry.url, entry.taskId)
        : entry.source === "ms"
        ? msDownload(entry.repo, entry.file, entry.taskId)
        : hfDownload(entry.repo, entry.file, entry.taskId);
      void run.then((result) => {
        appendLog(t("explore.downloaded") + ": " + result.path, "system");
        void importDownloadedModel(entry, result.path, result.sizeBytes);
      }).catch((error) => {
        const isCancelled = cancelledTaskIdsRef.current.has(entry.taskId);
        cancelledTaskIdsRef.current.delete(entry.taskId);
        const downloadError = toDownloadError(error);
        if (downloadError.code === "download_taken_over") {
          // 该 taskId 已被新一轮下载接管：旧循环静默退出，状态由新循环负责
          return;
        }
        if (isCancelled || downloadError.code === "download_cancelled") {
          cancelPendingProgress(entry.taskId);
          clearProgressKey(entry.repo, entry.file);
          mutateDownloads((previous) => previous.filter((item) => item.taskId !== entry.taskId));
          return;
        }
        if (downloadError.code === "download_paused") {
          cancelPendingProgress(entry.taskId);
          clearProgressKey(entry.repo, entry.file);
          patchByTaskId(entry.taskId, { status: "cancelled", error: t("explore.statusPaused"), speedBps: 0, finishedAt: Date.now() });
          return;
        }
        clearProgressKey(entry.repo, entry.file);
        const kind = downloadError.code === "hf_gated_need_token" ? "needs-token" : downloadError.code === "hf_gated_no_permission" ? "no-permission" : undefined;
        const failed = settleEntry(entry, downloadError, kind);
        appendLog(t("explore.error", { error: failed.error ?? downloadError.message }), "stderr");
        patchByTaskId(entry.taskId, failed);
      });
    })();
  };

  // 持久化任务列表：变更后 400ms 无新变更才写盘（下载进度高频 patch 不会逐次 stringify 落盘）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(DOWNLOADS_STORAGE_KEY, JSON.stringify(downloads)); } catch { /* 忽略写入失败 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [downloads]);

  // 任务镜像随 state 同步（集中兜底，覆盖恢复初始值与所有 setDownloads 路径）
  useEffect(() => { downloadsRef.current = downloads; }, [downloads]);

  // 启动后自动续传：恢复的任务中以 active 开场（上次退出时未完成）→ 重新发起下载（后端 .part 断点续传）
  useEffect(() => {
    if (!isTauri() || !configReady || autoResumeTriggered) return;
    const pending = downloadsRef.current.filter((item) => item.status === "active");
    if (!pending.length) return;
    autoResumeTriggered = true;
    const timer = window.setTimeout(() => {
      for (const task of pending) {
        const entry: ActiveDownload = { ...task, startedAt: Date.now(), status: "active", percent: 0, downloaded: 0, total: task.total ?? task.sizeBytes, speedBps: 0 };
        mutateDownloads((previous) => [...previous.filter((item) => !(item.repo === task.repo && item.file === task.file)), entry]);
        launchDownload(entry);
      }
      if (pending.length) setToast(t("toast.downloadQueued"));
    }, 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configReady]);

  // 订阅模型下载进度：同步任务状态（percent/speed/status），完成时标记 done 并延迟清理 progressMap。
  // 进行中进度按 200ms/任务 节流合并（事件频率≈网络吞吐，逐条 setState 会让整树跟着进度刷屏）；
  // done/paused/cancelled/error 等结构性状态立即生效。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const pendingProgress = pendingProgressRef.current;
    const flushProgress = (taskId: string) => {
      const pending = pendingProgress.get(taskId);
      if (!pending) return;
      pendingProgress.delete(taskId);
      const payload = pending.payload;
      const key = payload.repo + "::" + payload.file;
      setModelProgress((previous) => ({ ...previous, [key]: payload }));
      mutateDownloads((previous) => previous.map((item) => (item.taskId === taskId ? { ...item, status: "active" as const, percent: payload.percent, downloaded: payload.downloaded, total: payload.total, speedBps: payload.speedBps } : item)));
    };
    const patchTask = (taskId: string, patch: Partial<ActiveDownload>) => {
      mutateDownloads((previous) => previous.map((item) => (item.taskId === taskId ? { ...item, ...patch } : item)));
    };
    void onModelDownloadProgress((payload) => {
      // 展示用进度表仍按 仓库::文件名 索引（FileModal / 模型仓库下载占位共用），任务状态则按 taskId 精确命中
      const key = payload.repo + "::" + payload.file;
      if (payload.phase === "done") {
        cancelPendingProgress(payload.taskId);
        setModelProgress((previous) => ({ ...previous, [key]: payload }));
        patchTask(payload.taskId, { status: "done", percent: 100, downloaded: payload.downloaded, total: payload.total, speedBps: 0, finishedAt: Date.now() });
        window.setTimeout(() => {
          clearProgressKey(payload.repo, payload.file);
        }, 1800);
      } else if (payload.phase === "paused") {
        cancelPendingProgress(payload.taskId);
        clearProgressKey(payload.repo, payload.file);
        // 单任务 / 全部暂停：归入「暂停」Tab（保留 .part 断点，可继续）
        patchTask(payload.taskId, { status: "cancelled", error: t("explore.statusPaused"), speedBps: 0, finishedAt: Date.now() });
      } else if (payload.phase === "cancelled") {
        cancelPendingProgress(payload.taskId);
        clearProgressKey(payload.repo, payload.file);
        mutateDownloads((previous) => previous.filter((item) => item.taskId !== payload.taskId));
      } else if (payload.phase === "error") {
        cancelPendingProgress(payload.taskId);
        clearProgressKey(payload.repo, payload.file);
        patchTask(payload.taskId, { status: "error", error: payload.message || "download failed", speedBps: 0, finishedAt: Date.now() });
      } else {
        // 已暂停 / 已取消 / 已删除的任务忽略其迟到的「进行中」事件，防止假复活
        const current = downloadsRef.current.find((item) => item.taskId === payload.taskId);
        if (!current || current.status !== "active") return;
        const pending = pendingProgress.get(payload.taskId);
        if (pending) {
          pending.payload = payload;
        } else {
          const timer = window.setTimeout(() => flushProgress(payload.taskId), 200);
          pendingProgress.set(payload.taskId, { timer, payload });
        }
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => {
      unlisten?.();
      for (const pending of pendingProgress.values()) window.clearTimeout(pending.timer);
      pendingProgress.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 读取模型存储目录与可用空间（配置加载完成后）
  useEffect(() => {
    if (!isTauri()) return;
    void getModelsDir().then((usage) => setDiskUsage(usage)).catch(() => undefined);
  }, [config.modelsDir]);

  /** 社区探索：点击下载 → 登记任务（task 池，附唯一 taskId）+ 提示，进度由后端事件推送 */
  const handleModelDownload = (repo: string, file: string, sizeBytes: number, source?: CommunitySource) => {
    const entry: ActiveDownload = { taskId: uid("download"), repo, file, sizeBytes, startedAt: Date.now(), status: "active", source: source ?? (repo.includes("modelscope") ? "ms" : "hf"), percent: 0, downloaded: 0, total: sizeBytes, speedBps: 0 };
    mutateDownloads((previous) => [...previous.filter((item) => !(item.repo === repo && item.file === file)), entry]);
    launchDownload(entry);
    setToast(t("toast.downloadStarted"));
  };

  /** 重新发起某任务的下载（失败 / 暂停任务恢复与单任务重试共用），按原 taskId 重打后端控制器 */
  const relaunchTask = (task: ActiveDownload) => {
    const entry: ActiveDownload = { ...task, startedAt: Date.now(), status: "active" as const, percent: 0, downloaded: 0, total: task.total ?? task.sizeBytes, speedBps: 0 };
    patchByTaskId(task.taskId, entry);
    launchDownload(entry);
  };

  /** 取消单个任务：直接从列表删除任务并清理未完成缓存文件，不移入「暂停」界面 */
  const cancelTaskImpl = (task: ActiveDownload, withDelete = true) => {
    const matched = task.taskId
      ? downloadsRef.current.find((item) => item.taskId === task.taskId)
      : downloadsRef.current.find((item) => item.repo === task.repo && item.file === task.file);
    const targetTask = matched || task;

    if (targetTask.taskId) {
      cancelledTaskIdsRef.current.add(targetTask.taskId);
      cancelPendingProgress(targetTask.taskId);
      void hfCancelDownload(targetTask.taskId).catch(() => undefined);
    }
    mutateDownloads((previous) => previous.filter((item) =>
      (targetTask.taskId ? item.taskId !== targetTask.taskId : !(item.repo === targetTask.repo && item.file === targetTask.file))
    ));

    if (withDelete) removeTaskFiles(targetTask);
    clearProgressKey(targetTask.repo, targetTask.file);
    setToast(t("toast.downloadCancelled"));
  };

  /** 暂停单个任务（保留 .part 断点，可继续）；只作用于该 taskId，归入「暂停」界面 */
  const handlePauseTask = (task: ActiveDownload) => {
    void hfPauseDownload(task.taskId).catch(() => undefined);
    cancelPendingProgress(task.taskId);
    patchByTaskId(task.taskId, { status: "cancelled", error: t("explore.statusPaused"), speedBps: 0, finishedAt: Date.now() });
    clearProgressKey(task.repo, task.file);
    setToast(t("toast.taskPaused"));
  };

  /** 批量恢复：遍历选中的 taskId 逐个重新发起下载（并发/排队由后端调度） */
  const handleResumeTasks = (ids: string[]) => {
    const idSet = new Set(ids);
    const targets = downloadsRef.current.filter((item) => idSet.has(item.taskId) && (item.status === "error" || item.status === "cancelled"));
    for (const task of targets) relaunchTask(task);
    if (targets.length) setToast(t("toast.batchResumed", { count: targets.length }));
  };

  /** 批量暂停：仅对选中的进行中任务触发中止（按各自 taskId） */
  const handlePauseTasks = (ids: string[]) => {
    const idSet = new Set(ids);
    const targets = downloadsRef.current.filter((item) => idSet.has(item.taskId) && item.status === "active");
    for (const task of targets) {
      void hfPauseDownload(task.taskId).catch(() => undefined);
      cancelPendingProgress(task.taskId);
      patchByTaskId(task.taskId, { status: "cancelled", error: t("explore.statusPaused"), speedBps: 0, finishedAt: Date.now() });
      clearProgressKey(task.repo, task.file);
    }
    if (targets.length) setToast(t("toast.batchPaused", { count: targets.length }));
  };

  /** 删除任务：从前端响应式列表彻底移除，并同步清理本地未完成缓存（.part 断点等）。
   *  若 deleteLocalFiles = true，还会彻底删除本地硬盘文件，并同步从模型仓库 config.models 中移除并持久化。 */
  const deleteTasksImpl = async (ids: string[], deleteLocalFiles = false) => {
    const idSet = new Set(ids);
    const targets = downloadsRef.current.filter((item) => idSet.has(item.taskId));
    if (!targets.length) return;
    // 先按 taskId 中止仍在下载的任务，再清缓存、移记录
    for (const task of targets) {
      cancelledTaskIdsRef.current.add(task.taskId);
      cancelPendingProgress(task.taskId);
      clearProgressKey(task.repo, task.file);
      if (task.status === "active") void hfCancelDownload(task.taskId).catch(() => undefined);
    }
    mutateDownloads((previous) => previous.filter((item) => !idSet.has(item.taskId)));

    if (deleteLocalFiles) {
      const removedPaths = new Set<string>();
      for (const task of targets) {
        if (task.path) {
          removedPaths.add(task.path.toLowerCase());
          void removeLocalFile(task.path).catch(() => undefined);
        }
        removeTaskFiles(task);
      }
      const nextModels = config.models.filter((model) => !removedPaths.has(model.path.toLowerCase()));
      if (nextModels.length !== config.models.length) {
        await persist({ ...config, models: nextModels });
      }
      void getModelsDir().then(setDiskUsage).catch(() => undefined);
      setToast(t("toast.tasksAndFilesDeleted", { count: targets.length }));
    } else {
      for (const task of targets) {
        if (task.status === "done" && task.path) continue; // 已同步进模型仓库，不删库内文件
        removeTaskFiles(task);
      }
      setToast(t("toast.tasksDeleted", { count: targets.length }));
    }
  };

  /** 单任务删除 */
  const handleDeleteTask = (task: ActiveDownload, deleteLocalFile = false) => void deleteTasksImpl([task.taskId], deleteLocalFile);
  /** 清除完成记录 */
  const handleClearDone = () => {
    mutateDownloads((previous) => previous.filter((item) => item.status !== "done"));
    setToast(t("toast.queueCleared"));
  };
  /** 单任务：暂停 / 取消并删除缓存 */
  const handleCancelTask = (task: ActiveDownload, deleteCache = false) => cancelTaskImpl(task, deleteCache);
  /** 单任务重试 */
  const handleRetry = (task: ActiveDownload) => relaunchTask(task);
  const handleReveal = async (path: string) => { await revealInFolder(path); };

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

  return {
    downloads, modelProgress, diskUsage, justImportedIds,
    handleModelDownload, handlePauseTask, handleResumeTasks, handlePauseTasks,
    handleClearDone, handleCancelTask, handleDeleteTask, deleteTasksImpl,
    handleRetry, handleReveal, pickModelsDirFlow,
  };
}
