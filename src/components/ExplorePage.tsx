import {
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Download,
  EllipsisVertical,
  Flame,
  Globe,
  ListChecks,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { hfListFiles, hfSearch, hfTrending, msListFiles, msSearch, msTrending, type FormatFilter } from "../tauri";
import type { ActiveDownload, AppConfig, CommunitySource, DiskUsage, HfFile, HfModel, ModelDownloadProgress } from "../types";
import { cn, formatBytes, humanSpeed } from "../utils";
import ConfirmModal from "./ConfirmModal";
import { ModelScopeLogo } from "./explore/ModelAvatar";
import FacetSidebar from "./explore/FacetSidebar";
import FileModal from "./explore/FileModal";
import ModelRow from "./explore/ModelRow";
import TaskCardActive from "./explore/TaskCardActive";
import TaskCardDone from "./explore/TaskCardDone";
import TaskCardFailed from "./explore/TaskCardFailed";
import {
  FAMILIES,
  HF_SORT,
  MS_SORT,
  PARAM_LAST_INDEX,
  PARAM_SLIDER_LABELS,
  TASKS,
  modelQuantBits,
  type FamilyKey,
  type SortKey,
  type TaskKey,
} from "./explore/modelUtils";

interface Props {
  visible: boolean;
  config: AppConfig;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
  onToast: (message: string) => void;
  onLog: (line: string, stream?: "stdout" | "stderr" | "system") => void;
  diskUsage: DiskUsage | null;
  onPickModelsDir: () => Promise<void>;
  onDownload: (repo: string, file: string, sizeBytes: number, source?: CommunitySource) => void;
  activeDownloads: ActiveDownload[];
  progressMap: Record<string, ModelDownloadProgress>;
  /** 单任务暂停：仅中止该 taskId 的下载 */
  onPauseTask: (task: ActiveDownload) => void;
  /** 批量恢复选中的任务 */
  onResumeTasks: (ids: string[]) => void;
  /** 批量暂停选中的进行中任务 */
  onPauseTasks: (ids: string[]) => void;
  onClearDone: () => void;
  onCancelTask: (task: ActiveDownload, deleteCache?: boolean) => void;
  /** 单任务删除：可选择是否连同本地文件及模型库记录彻底删除 */
  onDeleteTask: (task: ActiveDownload, deleteLocalFile?: boolean) => void;
  /** 批量删除选中的任务：可选择是否连同本地文件彻底删除 */
  onDeleteTasks: (ids: string[], deleteLocalFiles?: boolean) => void;
  onRetry: (task: ActiveDownload) => void;
  onReveal: (path: string) => Promise<void>;
  /** 跳转到「设置」页（gated 需配置 Token 时一键跳转） */
  onGoSettings: () => void;
}

export default function ExplorePage(props: Props) {
  const { t } = useI18n();
  const showToast = props.onToast;
  const [view, setView] = useState<"discover" | "tasks">("discover");
  const [communitySource, setCommunitySource] = useState<CommunitySource>(() => {
    try {
      const saved = localStorage.getItem("cookllm_community_source");
      if (saved === "ms" || saved === "hf") return saved;
    } catch {}
    return "hf";
  });
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const sourceMenuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<FormatFilter>(() => {
    try {
      const saved = localStorage.getItem("cookllm_explore_format_filter");
      if (saved === "all" || saved === "gguf" || saved === "ninfer") return saved;
    } catch {}
    return "all";
  });
  const handleFormatFilterChange = (nextFilter: FormatFilter) => {
    setFormatFilter(nextFilter);
    try {
      localStorage.setItem("cookllm_explore_format_filter", nextFilter);
    } catch {}
    void refreshTrending(nextFilter);
  };
  const [sortKey, setSortKey] = useState<SortKey>("hot");
  const [models, setModels] = useState<HfModel[]>([]);
  const [trending, setTrending] = useState<HfModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalModel, setModalModel] = useState<HfModel | null>(null);
  const [filesMap, setFilesMap] = useState<Record<string, HfFile[] | null>>({});
  const [filesLoading, setFilesLoading] = useState<Record<string, boolean>>({});
  const [filesError, setFilesError] = useState<Record<string, string | null>>({});
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [discoverTab, setDiscoverTab] = useState<"trending" | "all">("trending");
  const [taskFilter, setTaskFilter] = useState<"all" | "active" | "done" | "failed">("all");
  /** 多选：任务卡片勾选集合（按 taskId）；切分类时清空避免隐藏勾选 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  /** 顶栏「⋮」更多操作菜单与「清空异常任务」确认框 */
  const [tasksMenuOpen, setTasksMenuOpen] = useState(false);
  const [confirmClearFailed, setConfirmClearFailed] = useState(false);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // 刻面状态
  const [family, setFamily] = useState<FamilyKey>("all");
  const [quantBits, setQuantBits] = useState<number[]>([]);
  const [tasks, setTasks] = useState<TaskKey[]>([]);
  const [paramMin, setParamMin] = useState(0);
  const [paramMax, setParamMax] = useState(PARAM_LAST_INDEX);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => props.config.exploreSidebarCollapsed ?? false);
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width:1180px)").matches);
  const searchSeq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  /** 量化偏好（多选）：同时用于服务端过滤参数与文件弹窗高亮 / 列表星标 */
  const quantPreferredBits = quantBits.length > 0 ? quantBits : null;

  /** 组合后的请求关键字：文本 + 家族 + 任务 + 量化偏好 + 参数档位；变化即触发服务端重查 */
  const effectiveKeyword = useMemo(() => {
    const parts: string[] = [];
    const text = query.trim();
    if (text) parts.push(text);
    if (family !== "all") {
      const fam = FAMILIES.find((item) => item.key === family);
      if (fam?.needles[0]) parts.push(fam.needles[0]);
    }
    for (const key of tasks) {
      const task = TASKS.find((item) => item.key === key);
      if (task?.needles[0]) parts.push(task.needles[0]);
    }
    // 量化偏好作为独立服务端过滤参数（hf_search/hf_trending 的 quants），不拼进关键词，
    // 避免触发 GGUF 仓库的多量化噪声；同时保留星标高亮（见 FileModal preferredBits）。
    if (paramMin > 0 || paramMax < PARAM_LAST_INDEX) {
      const label = (paramMin > 0 ? PARAM_SLIDER_LABELS[paramMin] : PARAM_SLIDER_LABELS[paramMax]).replace(/[<>]/g, "");
      if (label) parts.push(label);
    }
    return [...new Set(parts)].join(" ");
  }, [query, family, tasks, quantBits, paramMin, paramMax]);

  // 点击外部关闭源切换下拉
  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(e.target as Node)) {
        setSourceMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [sourceMenuOpen]);

  const handleCommunitySourceChange = (src: CommunitySource) => {
    if (src === communitySource) {
      setSourceMenuOpen(false);
      return;
    }
    setCommunitySource(src);
    try {
      localStorage.setItem("cookllm_community_source", src);
    } catch {}
    setSourceMenuOpen(false);
    setModels([]);
    setTrending([]);
    setFilesMap({});
    searchKeyRef.current = null;
  };

  // Ctrl+K 聚焦搜索（仅本页可见时监听，避免与模型页搜索框的快捷键重复抢占焦点）
  useEffect(() => {
    if (!props.visible) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.visible]);

  // 初始化及切换社区源：加载趋势榜单
  useEffect(() => {
    if (props.visible) {
      void refreshTrending();
    }
  }, [props.visible, communitySource]);

  // Narrow screens (<=1180px) switch the facet sidebar into a drawer
  useEffect(() => {
    const mq = window.matchMedia("(max-width:1180px)");
    const onChangeMq = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    mq.addEventListener("change", onChangeMq);
    return () => mq.removeEventListener("change", onChangeMq);
  }, []);

  const refreshTrending = async (overrideFilter?: FormatFilter) => {
    setTrendingLoading(true);
    const activeFilter = overrideFilter ?? formatFilter;
    try {
      const isMs = communitySource === "ms";
      const result = isMs
        ? await msTrending(10, activeFilter === "gguf", undefined, undefined, undefined, activeFilter)
        : await hfTrending(10, activeFilter === "gguf", undefined, undefined, undefined, activeFilter);
      setTrending(result);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally { setTrendingLoading(false); }
  };

  const runSearch = async (notify?: boolean) => {
    const seq = ++searchSeq.current;
    const keyword = effectiveKeyword;
    setLoading(true); setError(null);
    scrollAreaRef.current?.scrollTo({ top: 0 });
    let ok = false;
    let failMessage = "";
    try {
      const isMs = communitySource === "ms";
      const useGguf = formatFilter === "gguf" && !keyword.toLowerCase().includes(".gguf");
      const quants = quantBits.length > 0 ? quantBits : undefined;
      const sortParam = isMs ? MS_SORT[sortKey] : HF_SORT[sortKey];
      const result = keyword
        ? (isMs
            ? await msSearch(keyword, 30, useGguf, undefined, sortParam, quants, formatFilter)
            : await hfSearch(keyword, 30, useGguf, undefined, sortParam, quants, formatFilter))
        : (isMs
            ? await msTrending(30, useGguf, undefined, sortParam, quants, formatFilter)
            : await hfTrending(30, useGguf, undefined, sortParam, quants, formatFilter));
      if (seq !== searchSeq.current) return false; // 已发起更新的请求，丢弃过期结果
      setModels(result);
      setHasMore(result.length === 30);
      setFilesMap({});
      ok = true;
    } catch (err) {
      if (seq !== searchSeq.current) return false;
      const message = err instanceof Error ? err.message : String(err);
      failMessage = message;
      setError(message);
    } finally {
      if (seq === searchSeq.current) {
        setLoading(false);
        if (notify) showToast(ok ? t("explore.refreshed") : failMessage);
      }
    }
    return ok;
  };

  const refreshAll = async (notify = false) => {
    setRefreshing(true);
    setError(null);
    const [listOk, trendingOk] = await Promise.all([runSearch(false), refreshTrending()]);
    setRefreshing(false);
    if (notify) showToast(listOk && trendingOk ? t("explore.refreshed") : t("explore.refreshFailed"));
  };

  // 搜索防抖 300ms：文本 / 刻面 / 量化偏好 / 参数档位 / 格式筛选 / 社区源变化时向服务端重查并重置列表；
  // 仅本页可见时发起（含首次切入），避免应用启动即产生网络请求。
  // 切页返回时若搜索条件未变且已有数据 → 直接复用已加载列表，不再白屏转圈重查。
  const searchKeyRef = useRef<string | null>(null);
  const searchSignature = `${communitySource}|${effectiveKeyword}|${formatFilter}|${sortKey}|${quantBits.join(",")}`;
  useEffect(() => {
    if (!props.visible) return;
    if (searchKeyRef.current === searchSignature && models.length > 0) return;
    const timer = window.setTimeout(() => {
      void runSearch().then((ok) => { searchKeyRef.current = ok ? searchSignature : null; });
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSignature, props.visible]);

  /** 触底分页：追加下一页，而不是覆盖列表 */
  const loadMore = async () => {
    if (loading || loadingMore || !hasMore) return;
    const seq = searchSeq.current;
    const keyword = effectiveKeyword;
    const limit = 30;
    const skip = models.length;
    setLoadingMore(true);
    try {
      const isMs = communitySource === "ms";
      const useGguf = formatFilter === "gguf" && !keyword.toLowerCase().includes(".gguf");
      const quants = quantBits.length > 0 ? quantBits : undefined;
      const sortParam = isMs ? MS_SORT[sortKey] : HF_SORT[sortKey];
      const next = keyword
        ? (isMs
            ? await msSearch(keyword, limit, useGguf, skip, sortParam, quants, formatFilter)
            : await hfSearch(keyword, limit, useGguf, skip, sortParam, quants, formatFilter))
        : (isMs
            ? await msTrending(limit, useGguf, skip, sortParam, quants, formatFilter)
            : await hfTrending(limit, useGguf, skip, sortParam, quants, formatFilter));
      const seen = new Set(models.map((item) => item.id));
      const added = next.filter((item) => !seen.has(item.id));
      if (seq !== searchSeq.current) {
        // 列表已被新查询重置，丢弃过期追加
      } else if (added.length === 0) {
        // 无新增数据视为加载完毕，避免哨兵反复触发转圈
        setHasMore(false);
      } else {
        setModels((previous) => [...previous, ...added]);
        setHasMore(next.length === limit);
      }
    } catch {
      setHasMore(false);
    } finally { setLoadingMore(false); }
  };

  /** 底部哨兵：仅当哨兵从视口外被用户滚动进入时才加载下一页（避免进页面就自动翻页） */
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return;
    let wasOutside = false;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          if (wasOutside) void loadMore();
          wasOutside = false;
        } else {
          wasOutside = true;
        }
      },
      { rootMargin: "0px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.length, hasMore, loadingMore, effectiveKeyword, formatFilter]);

  /** 打开通用文件弹窗：热门卡 / 列表项共用，页面不滚动、卡片不内嵌展开。
   *  经 ref 转发保持引用稳定（内部逻辑每次渲染取最新），使 memo 的 ModelRow 在进度刷新时得以跳过重渲染 */
  const openFilesRef = useRef((_model: HfModel) => {});
  openFilesRef.current = (model: HfModel) => {
    setModalModel(model);
    const isMs = model.source === "ms";
    const cacheKey = `${model.id}::${formatFilter}`;
    if (filesMap[cacheKey] === undefined && !filesLoading[cacheKey]) {
      setFilesLoading((previous) => ({ ...previous, [cacheKey]: true }));
      setFilesError((previous) => ({ ...previous, [cacheKey]: null }));
      const fetchPromise = isMs ? msListFiles(model.id, formatFilter) : hfListFiles(model.id, formatFilter);
      void fetchPromise.then((result) => {
        setFilesMap((previous) => ({ ...previous, [cacheKey]: result }));
      }).catch((err) => {
        setFilesError((previous) => ({ ...previous, [cacheKey]: err instanceof Error ? err.message : String(err) }));
      }).finally(() => {
        setFilesLoading((previous) => ({ ...previous, [cacheKey]: false }));
      });
    }
  };
  const openFiles = useCallback((model: HfModel) => openFilesRef.current(model), []);

  const diskGuard = (sizeBytes: number): boolean => {
    if (!props.diskUsage || sizeBytes <= 0) return true;
    if (props.diskUsage.freeBytes >= sizeBytes) return true;
    props.onLog(t("explore.insufficientSpace", { free: formatBytes(props.diskUsage.freeBytes), need: formatBytes(sizeBytes) }), "stderr");
    return false;
  };

  const downloadFile = (model: HfModel, file: HfFile) => {
    if (!diskGuard(file.sizeBytes)) return;
    const isMs = model.source === "ms";
    props.onDownload(model.id, file.name, file.sizeBytes, isMs ? "ms" : "hf");
    const key = model.id + "::" + file.name;
    setQueued((previous) => new Set(previous).add(key));
    window.setTimeout(() => {
      setQueued((previous) => { const next = new Set(previous); next.delete(key); return next; });
    }, 2400);
  };

  const cancelDownloadFile = (model: HfModel, file: HfFile) => {
    const task = props.activeDownloads.find(
      (t) => t.repo === model.id && t.file === file.name
    );
    if (task) {
      props.onCancelTask(task, true);
    } else {
      props.onCancelTask({
        taskId: "",
        repo: model.id,
        file: file.name,
        sizeBytes: file.sizeBytes,
        startedAt: Date.now(),
        status: "active",
        percent: 0,
        downloaded: 0,
        total: file.sizeBytes,
        speedBps: 0,
      }, true);
    }
    const key = model.id + "::" + file.name;
    setQueued((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  };

  const handleParamMin = (value: number) => {
    setParamMin(Math.min(value, paramMax));
  };
  const handleParamMax = (value: number) => {
    setParamMax(Math.max(value, paramMin));
  };
  const resetParams = () => {
    setParamMin(0);
    setParamMax(PARAM_LAST_INDEX);
  };
  const resetAll = () => {
    setFamily("all");
    setQuantBits([]);
    setTasks([]);
    resetParams();
  };
  const toggleQuant = (bits: number) => {
    setQuantBits((previous) => previous.includes(bits) ? previous.filter((item) => item !== bits) : [...previous, bits]);
  };
  const selectAllQuant = () => setQuantBits([]);
  const toggleTask = (key: TaskKey) => {
    setTasks((previous) => previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key]);
  };
  const toggleCollapsed = () => {
    if (isNarrow) {
      setSidebarCollapsed(false);
      setMobileSidebarOpen((v) => !v);
      return;
    }
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    setMobileSidebarOpen(false);
    void props.onPersist({ ...props.config, exploreSidebarCollapsed: next });
  };

  const sidebarHidden = isNarrow ? !mobileSidebarOpen : sidebarCollapsed;
  const facetCount = (family !== "all" ? 1 : 0) + (quantBits.length > 0 ? 1 : 0) + tasks.length + (paramMin > 0 || paramMax < PARAM_LAST_INDEX ? 1 : 0);

  const { tasksActive, tasksDone, tasksFailed } = useMemo(() => {
    const active: ActiveDownload[] = [];
    const done: ActiveDownload[] = [];
    const failed: ActiveDownload[] = [];
    for (const item of props.activeDownloads) {
      if (item.status === "active") active.push(item);
      else if (item.status === "done") done.push(item);
      else if (item.status === "error" || item.status === "cancelled") failed.push(item);
    }
    return { tasksActive: active, tasksDone: done, tasksFailed: failed };
  }, [props.activeDownloads]);

  const activeCount = tasksActive.length;

  const shownTasks = useMemo(() => {
    if (taskFilter === "active") return tasksActive;
    if (taskFilter === "done") return tasksDone;
    if (taskFilter === "failed") return tasksFailed;
    return props.activeDownloads;
  }, [taskFilter, tasksActive, tasksDone, tasksFailed, props.activeDownloads]);

  const totalSpeed = useMemo(() => {
    return tasksActive.reduce((sum, item) => {
      const key = item.repo + "::" + item.file;
      const speed = props.progressMap[key]?.speedBps ?? item.speedBps ?? 0;
      return sum + speed;
    }, 0);
  }, [tasksActive, props.progressMap]);

  /** 勾选集合随任务列表自动收敛（清除完成 / 删除后残留的 id 不再生效） */
  const selectedTasks = useMemo(
    () => props.activeDownloads.filter((item) => selectedIds.has(item.taskId)),
    [props.activeDownloads, selectedIds]
  );
  const selectedInShownCount = useMemo(
    () => shownTasks.filter((item) => selectedIds.has(item.taskId)).length,
    [shownTasks, selectedIds]
  );
  const isAllSelected = shownTasks.length > 0 && selectedInShownCount === shownTasks.length;
  const isIndeterminate = selectedInShownCount > 0 && selectedInShownCount < shownTasks.length;

  const toggleSelect = (taskId: string) => setSelectedIds((previous) => {
    const next = new Set(previous);
    if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
    return next;
  });

  const toggleSelectAll = () => setSelectedIds((previous) => {
    const next = new Set(previous);
    if (isAllSelected) {
      for (const item of shownTasks) next.delete(item.taskId);
    } else {
      for (const item of shownTasks) next.add(item.taskId);
    }
    return next;
  });

  const canResumeSelected = useMemo(
    () => selectedTasks.some((item) => item.status === "error" || item.status === "cancelled"),
    [selectedTasks]
  );
  const canPauseSelected = useMemo(
    () => selectedTasks.some((item) => item.status === "active"),
    [selectedTasks]
  );

  const handleBatchResume = () => {
    const targets = selectedTasks
      .filter((item) => item.status === "error" || item.status === "cancelled")
      .map((item) => item.taskId);
    if (targets.length > 0) {
      props.onResumeTasks(targets);
    }
  };

  const handleBatchPause = () => {
    const targets = selectedTasks
      .filter((item) => item.status === "active")
      .map((item) => item.taskId);
    if (targets.length > 0) {
      props.onPauseTasks(targets);
    }
  };

  // 切换分类过滤时清空勾选，避免隐藏勾选混淆
  useEffect(() => { setSelectedIds(new Set()); setConfirmBatchDelete(false); }, [taskFilter]);

  // 列表不再做本地刻面过滤：查询关键字已由 effectiveKeyword 携带至服务端，防止「假过滤」只显示 1 个模型。
  // 排序仅在 models / sortKey 变化时重算（分页追加与轮询重渲染不再重复排序整表）。
  const sorted = useMemo(() => [...models].sort((a, b) => {
    if (sortKey === "likes") return b.likes - a.likes;
    if (sortKey === "updated") return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    if (sortKey === "downloads") return b.downloads - a.downloads;
    return (b.downloads * 4 + b.likes) - (a.downloads * 4 + a.likes);
  }), [models, sortKey]);
  const searching = query.trim().length > 0;
  const queuedKeys = queued;

  /** 单任务删除目标与“同时删除本地文件”勾选状态 */
  const [taskToDelete, setTaskToDelete] = useState<ActiveDownload | null>(null);
  const [deleteLocalFile, setDeleteLocalFile] = useState(false);
  /** 批量删除时的“同时删除本地文件”勾选状态 */
  const [batchDeleteLocalFiles, setBatchDeleteLocalFiles] = useState(false);

  return <div className="explore-page" hidden={!props.visible}>
    {/* 顶栏：视图切换（方案 A：极简留白，右侧完全留空不抢启动胶囊重心） */}
    <div className="explore-toolbar">
      <div className="explore-toolbar-left">
        <div className="explore-view-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "discover"}
            className={cn("explore-view-tab", view === "discover" && "active")}
            onClick={() => setView("discover")}
          >
            <Globe size={14} />
            <span>{t("explore.viewDiscover")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "tasks"}
            className={cn("explore-view-tab", view === "tasks" && "active")}
            onClick={() => setView("tasks")}
          >
            <Download size={14} />
            <span>{t("explore.viewTasks")}</span>
            {activeCount > 0 && <em className="explore-tab-count">{activeCount}</em>}
          </button>
        </div>
      </div>
    </div>

    {view === "discover" ? (
      <div className="facet-shell">
        <FacetSidebar
          mobileOpen={mobileSidebarOpen}
          collapsed={sidebarCollapsed}
          family={family}
          quantBits={quantBits}
          tasks={tasks}
          paramMin={paramMin}
          paramMax={paramMax}
          onSelectFamily={(fam) => {
            setFamily(fam);
            if (fam !== "all" && discoverTab !== "all") setDiscoverTab("all");
          }}
          onToggleQuant={(q) => {
            toggleQuant(q);
            if (discoverTab !== "all") setDiscoverTab("all");
          }}
          onSelectAllQuant={() => {
            selectAllQuant();
            if (discoverTab !== "all") setDiscoverTab("all");
          }}
          onToggleTask={(tk) => {
            toggleTask(tk);
            if (discoverTab !== "all") setDiscoverTab("all");
          }}
          onParamMin={(min) => {
            handleParamMin(min);
            if (discoverTab !== "all") setDiscoverTab("all");
          }}
          onParamMax={(max) => {
            handleParamMax(max);
            if (discoverTab !== "all") setDiscoverTab("all");
          }}
          onResetParams={resetParams}
          onResetAll={resetAll}
          onToggleCollapsed={toggleCollapsed}
        />
        <div className="facet-content">
          {/* 第 2 行：搜索（内嵌来源前缀）+ 排序 / GGUF */}
          <div className="explore-searchzone">
            {sidebarHidden && (
              <button type="button" className={"facet-search-toggle"} onClick={toggleCollapsed} title={t("explore.facetExpand")}>
                <ChevronRight size={14} />{t("explore.facetToggle")}{facetCount > 0 && <em>{facetCount}</em>}
              </button>
            )}
            <div className="search-box explore-search" title="Ctrl+K 快速聚焦">
              <div className="explore-source-wrapper" ref={sourceMenuRef}>
                <button
                  type="button"
                  className={cn("explore-source-btn", communitySource === "ms" && "source-ms")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSourceMenuOpen((v) => !v);
                  }}
                  title={communitySource === "ms" ? "ModelScope" : t("explore.sourceHf")}
                >
                  <span className="explore-source-icon">
                    {communitySource === "ms" ? <ModelScopeLogo size={15} /> : "🤗"}
                  </span>
                  <span className="explore-source-name">{communitySource === "ms" ? "ModelScope" : t("explore.sourceHf")}</span>
                  <ChevronDown size={12} className={cn("explore-source-arrow", sourceMenuOpen && "open")} />
                </button>
                {sourceMenuOpen && (
                  <div className="explore-source-dropdown" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={cn("explore-source-item", communitySource === "hf" && "active")}
                      onClick={() => handleCommunitySourceChange("hf")}
                    >
                      <span className="source-item-icon">🤗</span>
                      <span className="source-item-label">{t("explore.sourceHf")}</span>
                      {communitySource === "hf" && <Check size={14} className="source-item-check" />}
                    </button>
                    <button
                      type="button"
                      className={cn("explore-source-item", communitySource === "ms" && "active")}
                      onClick={() => handleCommunitySourceChange("ms")}
                    >
                      <span className="source-item-icon">
                        <ModelScopeLogo size={16} />
                      </span>
                      <span className="source-item-label">{t("explore.sourceMs")}</span>
                      {communitySource === "ms" && <Check size={14} className="source-item-check" />}
                    </button>
                  </div>
                )}
              </div>
              <Search size={14} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  const val = e.target.value;
                  setQuery(val);
                  if (val.trim() && discoverTab !== "all") {
                    setDiscoverTab("all");
                  }
                }}
                placeholder={t("explore.searchPlaceholder")}
              />
              <kbd>Ctrl+K</kbd>
            </div>
            <div className="explore-search-tools">
              <select className="explore-sort-select" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="downloads">{t("explore.sortDownloads")}</option>
                <option value="likes">{t("explore.sortLikes")}</option>
                <option value="updated">{t("explore.sortUpdated")}</option>
                <option value="hot">{t("explore.sortHot")}</option>
              </select>
              <button type="button" className="explore-refresh-btn" onClick={() => void refreshAll(true)} disabled={refreshing} title={t("explore.refreshList")} aria-label={t("explore.refreshList")}>
                <RefreshCw size={14} className={cn("facet-refresh-icon", refreshing && "spin")} />
              </button>
              <div className="explore-format-picker" title={t("explore.formatFilterTitle")}>
                <select
                  className={cn("explore-format-select", formatFilter)}
                  value={formatFilter}
                  onChange={(e) => handleFormatFilterChange(e.target.value as FormatFilter)}
                  aria-label={t("explore.formatFilterTitle")}
                >
                  <option value="all">{t("explore.formatAll")}</option>
                  <option value="gguf">{t("explore.formatGguf")}</option>
                  <option value="ninfer">{t("explore.formatNinfer")}</option>
                </select>
              </div>
            </div>
          </div>

          <div className="facet-scroll-wrap">
            <div className={cn("hf-list-refresh-veil", (loading || trendingLoading) && "visible")} aria-hidden={!loading && !trendingLoading}>
              {(loading || trendingLoading) ? <Loader2 size={24} className="spin" /> : null}
            </div>

            <div className="facet-scroll-area" ref={scrollAreaRef}>
              {/* 发现页二级分栏：本周热门趋势 vs 全部模型库 */}
              <div className="discover-segment-bar">
                <div className="discover-segments" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={discoverTab === "trending"}
                    className={cn("discover-segment-btn", discoverTab === "trending" && "active")}
                    onClick={() => {
                      setDiscoverTab("trending");
                      scrollAreaRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    <Flame size={14} className="segment-flame" />
                    <span>{t("explore.tabTrending")}</span>
                    {trending.length > 0 && <span className="segment-badge">{trending.length}</span>}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={discoverTab === "all"}
                    className={cn("discover-segment-btn", discoverTab === "all" && "active")}
                    onClick={() => {
                      setDiscoverTab("all");
                      scrollAreaRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    <Compass size={14} />
                    <span>{t("explore.tabAllModels")}</span>
                    {models.length > 0 && <span className="segment-badge">{models.length}</span>}
                  </button>
                </div>
                <div className="discover-segment-meta">
              {discoverTab === "trending" ? (
                <span className="explore-updated">{t("explore.trendingWeeklyBadge")}</span>
              ) : searching ? (
                <span className="explore-updated">{t("explore.searchResults", { query: query.trim(), count: models.length })}</span>
              ) : facetCount > 0 ? (
                <span className="explore-updated">{t("explore.facetSidebar")} × {facetCount}</span>
              ) : null}
            </div>
          </div>

          {discoverTab === "trending" ? (
            /* ==================== 本周热门趋势专属榜单 ==================== */
            <div className="hf-trending-list">
              {trendingLoading && trending.length === 0 ? (
                <div className="hf-skeleton-list">
                  {Array.from({ length: 5 }, (_, index) => (
                    <div className="hf-model-row hf-skeleton-row" key={index}>
                      <div className="hf-model-row-body">
                        <span className="hf-model-icon hf-skeleton-block" />
                        <div className="hf-model-main-col">
                          <div className="hf-skeleton-line title" />
                          <div className="hf-skeleton-line text" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : trending.length === 0 ? (
                <div className="hf-empty">
                  <h3>{t("explore.noResults")}</h3>
                  <p>{t("explore.noResultsDesc")}</p>
                </div>
              ) : (
                trending.map((model, index) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    rank={index + 1}
                    preferredQuant={quantPreferredBits != null && modelQuantBits(model) != null && quantPreferredBits.includes(modelQuantBits(model)!)}
                    onViewFiles={openFiles}
                  />
                ))
              )}
            </div>
          ) : (
            /* ==================== 全部模型库与搜索列表 ==================== */
            <div className="hf-all-models-list">
              {loading && models.length === 0 ? (
                <div className="hf-skeleton-list">
                  {Array.from({ length: 5 }, (_, index) => (
                    <div className="hf-model-row hf-skeleton-row" key={index}>
                      <div className="hf-model-row-body">
                        <span className="hf-model-icon hf-skeleton-block" />
                        <div className="hf-model-main-col">
                          <div className="hf-skeleton-line title" />
                          <div className="hf-skeleton-line text" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {error && !loading && (
                <div className="hf-empty err">
                  <p>{error}</p>
                  <span className="hf-net-hint">{communitySource === "ms" ? t("explore.netErrorHintMs") : t("explore.netErrorHint")}</span>
                </div>
              )}
              {!loading && !error && sorted.length === 0 && <div className="hf-empty"><h3>{t("explore.noResults")}</h3><p>{t("explore.noResultsDesc")}</p></div>}
              {sorted.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  preferredQuant={quantPreferredBits != null && modelQuantBits(model) != null && quantPreferredBits.includes(modelQuantBits(model)!)}
                  onViewFiles={openFiles}
                />
              ))}
              <div ref={loadMoreRef} className="hf-list-foot">
                {loadingMore && <><Loader2 size={14} className="spin" />{t("explore.loadingMore")}</>}
                {!loadingMore && !hasMore && models.length > 0 && <span>{t("explore.loadedAll")}</span>}
              </div>
            </div>
          )}
            </div>
          </div>
        </div>
      </div>
    ) : (
      /* ==================== 任务管理视图 ==================== */
      <div className="tasks-view">
        <div className="tasks-filterbar">
          {batchMode ? (
            <>
              {/* 批量选择模式：左侧全选 + 选中数量 */}
              <div className="tasks-filterbar-left">
                <label className="tasks-select-all" title={t("explore.selectAll")}>
                  <input
                    type="checkbox"
                    ref={(el) => {
                      if (el) el.indeterminate = isIndeterminate;
                    }}
                    checked={isAllSelected}
                    disabled={!shownTasks.length}
                    onChange={toggleSelectAll}
                  />
                  <span>{t("explore.selectAll")}</span>
                </label>
                <span className="task-batch-count">{t("explore.batchSelected", { count: selectedTasks.length })}</span>
              </div>
              {/* 批量选择模式：右侧智能操作按钮组 + 退出批量 */}
              <div className="tasks-batch-inline">
                <button
                  type="button"
                  className="task-inline-action"
                  disabled={!canResumeSelected}
                  onClick={handleBatchResume}
                >
                  <Play size={14} />
                  <span>{t("explore.start")}</span>
                </button>
                <button
                  type="button"
                  className="task-inline-action"
                  disabled={!canPauseSelected}
                  onClick={handleBatchPause}
                >
                  <Pause size={14} />
                  <span>{t("explore.pause")}</span>
                </button>
                <button
                  type="button"
                  className="task-inline-action danger"
                  disabled={selectedTasks.length === 0}
                  onClick={() => setConfirmBatchDelete(true)}
                >
                  <Trash2 size={14} />
                  <span>{t("explore.delete")}</span>
                </button>
                <span className="tasks-tools-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="task-batch-exit-btn"
                  title={t("explore.exitBatchManage")}
                  onClick={() => {
                    setBatchMode(false);
                    setSelectedIds(new Set());
                  }}
                >
                  <X size={14} />
                  <span>{t("explore.exitBatchManage")}</span>
                </button>
              </div>
            </>
          ) : (
            <>
              {/* 普通状态：左侧分类标签 */}
              <div className="explore-filters">
                {([
                  ["all", t("explore.tasksAll") + (props.activeDownloads.length ? ` (${props.activeDownloads.length})` : "")],
                  ["active", t("explore.tasksActive") + (tasksActive.length ? ` (${tasksActive.length})` : "")],
                  ["done", t("explore.tasksDone") + (tasksDone.length ? ` (${tasksDone.length})` : "")],
                  ["failed", t("explore.tasksFailed") + (tasksFailed.length ? ` (${tasksFailed.length})` : "")]
                ] as const).map(([key, label]) => (
                  <button key={key} className={cn("explore-filter", taskFilter === key && "active")} onClick={() => setTaskFilter(key)}>{label}</button>
                ))}
              </div>
              {/* 普通状态：右侧仅保留 [批量操作] 及更多菜单 (⋮) */}
              <div className="tasks-tools">
                <button
                  type="button"
                  className="task-batch-toggle-btn"
                  title={t("explore.batchManage")}
                  disabled={!shownTasks.length}
                  onClick={() => setBatchMode(true)}
                >
                  <ListChecks size={15} />
                  <span>{t("explore.batchManage")}</span>
                </button>
                <span className="tasks-tools-sep" aria-hidden="true" />
                <div className="task-menu-wrap">
                  <button className="ghost-icon hf-icon-button" title={t("explore.moreActions")} aria-label={t("explore.moreActions")} onClick={() => setTasksMenuOpen((value) => !value)}><EllipsisVertical size={16} /></button>
                  {tasksMenuOpen && <div className="menu-backdrop" onClick={() => setTasksMenuOpen(false)} />}
                  {tasksMenuOpen && (
                    <div className="context-menu tasks-menu">
                      <button onClick={() => { setTasksMenuOpen(false); props.onClearDone(); }}><Trash2 size={14} />{t("explore.clearDone")}</button>
                      <button className="danger" disabled={!tasksFailed.length} onClick={() => { setTasksMenuOpen(false); setConfirmClearFailed(true); }}><Trash2 size={14} />{t("explore.clearFailedTasks")}</button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 进行中任务分段 */}
        {(taskFilter === "all" || taskFilter === "active") && tasksActive.length > 0 && (
          <div className="tasks-section-title">
            <h2>{t("explore.tasksActive", { count: tasksActive.length })}</h2>
            <span>{t("explore.totalSpeed", { speed: humanSpeed(totalSpeed) })}</span>
          </div>
        )}
        {(taskFilter === "all" || taskFilter === "active") && tasksActive.map((item) => (
          <TaskCardActive
            key={item.taskId}
            item={item}
            progress={props.progressMap[item.repo + "::" + item.file]}
            batchMode={batchMode}
            selected={selectedIds.has(item.taskId)}
            onToggleSelect={toggleSelect}
            onPause={props.onPauseTask}
            onDelete={(task) => {
              setTaskToDelete(task);
              setDeleteLocalFile(false);
            }}
          />
        ))}

        {/* 失败/暂停任务分段 */}
        {(taskFilter === "all" || taskFilter === "failed") && tasksFailed.length > 0 && (
          <div className="tasks-section-title">
            <h2>{t("explore.tasksFailed")} ({tasksFailed.length})</h2>
          </div>
        )}
        {taskFilter === "failed" && tasksFailed.length === 0 && (
          <div className="tasks-empty"><span>{t("explore.noTasks")}</span></div>
        )}
        {(taskFilter === "all" || taskFilter === "failed") && tasksFailed.map((item) => (
          <TaskCardFailed
            key={item.taskId}
            item={item}
            batchMode={batchMode}
            selected={selectedIds.has(item.taskId)}
            onToggleSelect={toggleSelect}
            onRetry={props.onRetry}
            onGoSettings={props.onGoSettings}
            onDelete={(task) => {
              setTaskToDelete(task);
              setDeleteLocalFile(false);
            }}
          />
        ))}

        {/* 已完成任务分段 */}
        {(taskFilter === "all" || taskFilter === "done") && tasksDone.length > 0 && (
          <div className="tasks-section-title">
            <h2>{t("explore.tasksDone")} ({tasksDone.length})</h2>
          </div>
        )}
        {taskFilter === "done" && tasksDone.length === 0 && (
          <div className="tasks-empty"><span>{t("explore.noDoneTasks")}</span></div>
        )}
        {(taskFilter === "all" || taskFilter === "done") && tasksDone.map((item) => (
          <TaskCardDone
            key={item.taskId}
            item={item}
            batchMode={batchMode}
            selected={selectedIds.has(item.taskId)}
            onToggleSelect={toggleSelect}
            onReveal={props.onReveal}
            onDelete={(task) => {
              setTaskToDelete(task);
              setDeleteLocalFile(false);
            }}
          />
        ))}

        {/* 无任务空状态 */}
        {shownTasks.length === 0 && (
          <div className="hf-empty">
            <h3>{t("explore.noTasks")}</h3>
            <p>{t("explore.noTasksDesc")}</p>
          </div>
        )}
      </div>
    )}
  {confirmBatchDelete && selectedTasks.length > 0 && (
    <ConfirmModal
      title={t("explore.confirmDeleteTasksTitle")}
      description={
        <div className="delete-task-dialog">
          <p>{t("explore.confirmDeleteTasksDesc", { count: selectedTasks.length })}</p>
          {selectedTasks.some((item) => item.status === "done") && (
            <label className="delete-file-checkbox">
              <input
                type="checkbox"
                checked={batchDeleteLocalFiles}
                onChange={(e) => setBatchDeleteLocalFiles(e.target.checked)}
              />
              <span>{t("explore.batchAlsoDeleteFiles")}</span>
            </label>
          )}
        </div>
      }
      confirmLabel={batchDeleteLocalFiles ? t("explore.deleteTaskAndFile") : t("explore.delete")}
      onConfirm={() => {
        props.onDeleteTasks(selectedTasks.map((item) => item.taskId), batchDeleteLocalFiles);
        setSelectedIds(new Set());
        setConfirmBatchDelete(false);
        setBatchDeleteLocalFiles(false);
      }}
      onClose={() => {
        setConfirmBatchDelete(false);
        setBatchDeleteLocalFiles(false);
      }}
    />
  )}
  {taskToDelete && (
    <ConfirmModal
      title={
        taskToDelete.status === "active"
          ? t("explore.confirmCancelActiveTaskTitle")
          : t("explore.deleteTaskTitle")
      }
      description={
        <div className="delete-task-dialog">
          <p>
            {taskToDelete.status === "active"
              ? t("explore.confirmCancelActiveTaskDesc", { file: taskToDelete.file })
              : t("explore.deleteTaskDesc", { file: taskToDelete.file })}
          </p>
          {taskToDelete.status === "done" && (
            <label className="delete-file-checkbox">
              <input
                type="checkbox"
                checked={deleteLocalFile}
                onChange={(e) => setDeleteLocalFile(e.target.checked)}
              />
              <span>{t("explore.alsoDeleteFile")}</span>
            </label>
          )}
        </div>
      }
      confirmLabel={
        taskToDelete.status === "active"
          ? t("explore.confirmCancelActiveTaskBtn")
          : (deleteLocalFile ? t("explore.deleteTaskAndFile") : (taskToDelete.status === "done" ? t("explore.deleteRecordOnly") : t("explore.delete")))
      }
      onConfirm={() => {
        if (taskToDelete.status === "active") {
          props.onCancelTask(taskToDelete, true);
        } else {
          props.onDeleteTask(taskToDelete, deleteLocalFile);
        }
        setTaskToDelete(null);
        setDeleteLocalFile(false);
      }}
      onClose={() => {
        setTaskToDelete(null);
        setDeleteLocalFile(false);
      }}
    />
  )}
  {confirmClearFailed && tasksFailed.length > 0 && (
    <ConfirmModal
      title={t("explore.confirmClearFailedTitle")}
      description={t("explore.confirmClearFailedDesc", { count: tasksFailed.length })}
      confirmLabel={t("explore.delete")}
      onConfirm={() => {
        props.onDeleteTasks(tasksFailed.map((item) => item.taskId));
        setConfirmClearFailed(false);
      }}
      onClose={() => setConfirmClearFailed(false)}
    />
  )}
  {modalModel && (
    <FileModal
      model={modalModel}
      files={filesMap[`${modalModel.id}::${formatFilter}`] ?? null}
      filesLoading={!!filesLoading[`${modalModel.id}::${formatFilter}`]}
      filesError={filesError[`${modalModel.id}::${formatFilter}`] ?? null}
      preferredBits={quantPreferredBits}
      diskUsage={props.diskUsage}
      progressMap={props.progressMap}
      queuedKeys={queuedKeys}
      onDownloadFile={(file) => downloadFile(modalModel, file)}
      onCancelDownloadFile={(file) => cancelDownloadFile(modalModel, file)}
      onPickModelsDir={props.onPickModelsDir}
      onClose={() => setModalModel(null)}
    />
  )}
  </div>;
}