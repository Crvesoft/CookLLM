import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { checkOrphanServer, getGpuStats, getServerStatus, isTauri, killOrphanServer, readNinferRequestLog, startServer, stopServer, type OrphanProcessItem, type ServerLifecyclePayload } from "../tauri";
import type { AppConfig, GpuStats, InferenceMetrics, ModelAsset, Page, ServerStatus, TokSample } from "../types";
import { EMPTY_STATUS, InferenceTracker, modelTitle, shallowEqualFields } from "../utils";
import type { AppendLog, Translate } from "./types";

interface UseServiceControllerOptions {
  config: AppConfig;
  configReady: boolean;
  pageRef: MutableRefObject<Page>;
  status: ServerStatus;
  setStatus: Dispatch<SetStateAction<ServerStatus>>;
  selectedProfiles: Record<string, string>;
  setMenuModelId: Dispatch<SetStateAction<string | null>>;
  setLogDockOpen: Dispatch<SetStateAction<boolean>>;
  setToast: (message: string) => void;
  appendLog: AppendLog;
  t: Translate;
}

/** 服务控制器：状态/GPU 轮询、推理指标聚合、启动/停止、异常判定、生命周期同步与孤儿进程处理 */
export function useServiceController({ config, configReady, pageRef, status, setStatus, selectedProfiles, setMenuModelId, setLogDockOpen, setToast, appendLog, t }: UseServiceControllerOptions) {
  /** GPU 性能监测开关（默认开启，设置页可关闭） */
  const gpuMonitorEnabled = config.gpuMonitorEnabled !== false;
  /** 服务异常：启动失败 / 进程意外退出；成功启动后清除 */
  const [serviceAbnormal, setServiceAbnormal] = useState(false);
  /** 最近一次从日志解析到的生成吞吐（带时间戳，微型状态卡据此判定"实时 / Idle"） */
  const [tokSample, setTokSample] = useState<TokSample | null>(null);
  /** 推理指标聚合跟踪器：精准解析 Prefill、Decode、KV Cache 命中与首字耗时 */
  const inferenceTrackerRef = useRef(new InferenceTracker());
  const [latestInference, setLatestInference] = useState<InferenceMetrics | null>(null);
  const [inferenceHistory, setInferenceHistory] = useState<InferenceMetrics[]>([]);
  /** GPU 实时指标（nvidia-smi，2s 轮询；浏览器模式恒为 null；初始从本地缓存读取实现首帧秒显） */
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(() => {
    try {
      const raw = localStorage.getItem("cookllm.last_gpu_stats");
      return raw ? (JSON.parse(raw) as GpuStats) : null;
    } catch {
      return null;
    }
  });
  /** 已武装：本次启动期间收到就绪日志后自动收起 Dock（停止 / 失败时重置，避免误关用户手动打开的 Dock） */
  const dockAutoCollapseRef = useRef(false);
  /** 本次退出是主动停止（区别于崩溃），由状态轮询消费 */
  const stopIntendedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  /** 启动中：进程已拉起但服务端口尚未就绪（按钮显示旋转过渡，避免生硬地直接切为停止图标） */
  const [serviceStarting, setServiceStarting] = useState(false);
  const [startingModelId, setStartingModelId] = useState<string | null>(null);
  /** 最近一次启动（UI 或托盘）的时间戳：启动后短暂窗口内 running=false 的轮询结果视为 spawn 前采样的过期数据 */
  const lifecycleStartingAtRef = useRef(0);
  const serviceStartingRef = useRef(false);
  const serviceStartingTimerRef = useRef<number | null>(null);
  /** 启动编排序号：新的启动 / 主动停止递增，使旧流程在 await 之后自动失效 */
  const startSeqRef = useRef(0);
  /** 启动编排进行中：此间收到的 stopped 广播来自被替换的旧进程，不应结束新启动的过渡动画 */
  const startingNewRef = useRef(false);

  const endServiceStarting = () => {
    if (serviceStartingTimerRef.current) {
      window.clearTimeout(serviceStartingTimerRef.current);
      serviceStartingTimerRef.current = null;
    }
    serviceStartingRef.current = false;
    startingNewRef.current = false;
    setServiceStarting(false);
    setStartingModelId(null);
  };
  const beginServiceStarting = (modelId?: string | null) => {
    serviceStartingRef.current = true;
    setServiceStarting(true);
    if (modelId) setStartingModelId(modelId);
    if (serviceStartingTimerRef.current) window.clearTimeout(serviceStartingTimerRef.current);
    // 安全兜底：即便就绪日志缺失，也不会让按钮无限旋转（远超大型模型加载耗时）
    serviceStartingTimerRef.current = window.setTimeout(() => endServiceStarting(), 900000);
  };
  /** 待播报的「已启动」提示：延迟到服务真正就绪（与 Dock 收起同步）后再弹出 */
  const pendingStartedToastRef = useRef<string | null>(null);
  /**
   * 服务真正就绪：同步完成三件事 —— 收起 Dock、结束启动旋转动画、播报「已启动」。
   * 三者必须同步，避免出现「还在转圈却提示已启动」的割裂感。
   */
  const markServiceReady = () => {
    // 切换旧服务期间可能仍有旧进程的就绪日志，不能据此结束新服务的启动过渡
    if (startingNewRef.current) return;
    if (dockAutoCollapseRef.current) { dockAutoCollapseRef.current = false; setLogDockOpen(false); }
    if (serviceStartingRef.current) endServiceStarting();
    const pending = pendingStartedToastRef.current;
    if (pending) { pendingStartedToastRef.current = null; setToast(t("toast.started", { model: pending })); }
  };
  /** 后台残留 llama-server 孤儿进程检测状态 */
  const [orphanPids, setOrphanPids] = useState<number[] | null>(null);
  const [orphanProcesses, setOrphanProcesses] = useState<OrphanProcessItem[] | null>(null);
  const [orphanPendingModel, setOrphanPendingModel] = useState<ModelAsset | null>(null);

  // 状态与 GPU 轮询：2s 一次；数据未变化时保持旧引用，避免全树重渲染
  useEffect(() => {
    if (!isTauri() || !configReady) return;
    let active = true;
    const refresh = () => {
      // 浅比较后去重：数据未变化时保持旧引用，避免每 2s 的轮询触发全树重渲染
      void getServerStatus().then((st) => {
        if (!active) return;
        // 启动后宽限窗口内的 running=false 是 spawn 前采样的过期轮询结果：
        // 直接应用会误杀刚点亮的过渡动画，甚至把成功启动误判为「意外退出」（真实失败由 failed 事件 / 下一轮轮询兜底）
        const staleDuringStart = !st.running && serviceStartingRef.current
          && (startingNewRef.current || Date.now() - lifecycleStartingAtRef.current < 4000);
        if (!staleDuringStart) {
          setStatus((prev) => (shallowEqualFields(prev, st) ? prev : st));
          // 服务已停止（含启动失败 / 进程意外退出）：结束启动中的旋转过渡
          if (!st.running && serviceStartingRef.current) endServiceStarting();
        }
        // 当服务处于运行状态时，同步底层实时指标（针对不同引擎自动自适应）
        if (st.running && st.port) {
          const isNinfer = st.engineType === "ninfer" || st.engineType === "ninfer_kvmem";
          if (isNinfer) {
            void Promise.all([
              fetch(`http://127.0.0.1:${st.port}/stats`, { signal: AbortSignal.timeout(1000) })
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null),
              fetch(`http://127.0.0.1:${st.port}/slots`, { signal: AbortSignal.timeout(1000) })
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null),
              readNinferRequestLog().catch(() => [] as unknown[]),
            ]).then(([statsData, slotsData, jsonlRecords]) => {
              if (!active) return;
              // 结构化 JSONL 权威值优先合并（全精度 timings / tokens / queue_wait），
              // 再由 /stats + /slots 计数器差分补充进行中的轮次
              if (Array.isArray(jsonlRecords) && jsonlRecords.length) {
                const jr = inferenceTrackerRef.current.applyNinferRequestLog(jsonlRecords);
                if (jr.updated) {
                  if (jr.latest) setLatestInference({ ...jr.latest });
                  setInferenceHistory(inferenceTrackerRef.current.getHistory());
                }
              }
              const res = inferenceTrackerRef.current.updateFromNinfer({
                stats: statsData,
                slots: slotsData,
              });
              if (res.updated && res.latest) {
                setLatestInference({ ...res.latest });
                setInferenceHistory(inferenceTrackerRef.current.getHistory());
                const speed = res.latest.decodeTps ?? res.latest.prefillTps;
                if (speed != null) setTokSample({ rate: speed, at: Date.now() });
              } else {
                const timeoutRes = inferenceTrackerRef.current.checkIdleTimeout(3000);
                if (timeoutRes.updated && timeoutRes.latest) {
                  setLatestInference({ ...timeoutRes.latest });
                  setInferenceHistory(inferenceTrackerRef.current.getHistory());
                }
              }
            }).catch(() => undefined);
          } else {
            // llama.cpp 专属直连 /slots 端点
            void fetch(`http://127.0.0.1:${st.port}/slots`, { signal: AbortSignal.timeout(1000) })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
              .then((data) => {
                if (!active || !data) return;
                const slots = Array.isArray(data) ? data : (data.value && Array.isArray(data.value) ? data.value : []);
                if (!slots.length) return;
                const activeSlot = slots.find((s: any) => s.is_processing);
                const anyProcessing = Boolean(activeSlot);
                // 若当前完全没有槽位在运行，且跟踪器也没有活跃未完成的轮次，说明服务处于纯空闲状态，直接跳过
                if (!anyProcessing && !inferenceTrackerRef.current.hasActiveTurn()) {
                  return;
                }
                const slot = activeSlot || slots[0];
                if (!slot) return;
                // 当前 llama.cpp 的缓存数与速率不在 slot 顶层，而在 timings（cache_n / prompt_per_second）
                const timings = slot.timings && typeof slot.timings === "object" ? slot.timings : null;
                const promptTokens = slot.n_prompt_tokens ?? timings?.prompt_n ?? slot.prompt_n ?? slot.n_prompt_tokens_processed;
                const cachedTokens = slot.n_prompt_tokens_cache ?? timings?.cache_n ?? slot.n_past ?? 0;
                const cacheHitRatio = promptTokens && promptTokens > 0 ? (cachedTokens / promptTokens) * 100 : undefined;
                const decodeTokens = slot.next_token?.[0]?.n_decoded ?? timings?.predicted_n ?? slot.n_decoded ?? slot.predicted_n;
                const res = inferenceTrackerRef.current.updateFromSlot({
                  taskId: slot.id_task,
                  promptTokens,
                  cachedTokens,
                  cacheHitRatio: cacheHitRatio != null ? parseFloat(cacheHitRatio.toFixed(1)) : undefined,
                  decodeTokens,
                  prefillTps: timings?.prompt_per_second ?? slot.prompt_per_second,
                  prefillTimeMs: timings?.prompt_ms ?? slot.prompt_ms ?? slot.t_prompt_processing,
                  decodeTps: timings?.predicted_per_second ?? slot.predicted_per_second,
                  isProcessing: anyProcessing,
                });
                if (res.updated && res.latest) {
                  setLatestInference({ ...res.latest });
                  setInferenceHistory(inferenceTrackerRef.current.getHistory());
                  const speed = res.latest.decodeTps ?? res.latest.prefillTps;
                  if (speed != null) setTokSample({ rate: speed, at: Date.now() });
                } else {
                  // 空闲超时兜底检查（若生成停止但无显式完成信号，3 秒内自动结算）
                  const timeoutRes = inferenceTrackerRef.current.checkIdleTimeout(3000);
                  if (timeoutRes.updated && timeoutRes.latest) {
                    setLatestInference({ ...timeoutRes.latest });
                    setInferenceHistory(inferenceTrackerRef.current.getHistory());
                  }
                }
              })
              .catch(() => undefined);
          }
        }
      }).catch(() => undefined);
      // GPU 指标独立轮询：查询失败 / 无 NVIDIA 驱动 → null，卡片显示 "--"
      if (gpuMonitorEnabled) {
        // 响应到达时若已被关闭或 effect 已重跑（配置加载完成 / 用户切换），丢弃过期数据
        void getGpuStats().then((stats) => {
          if (!active || !gpuMonitorEnabled) return;
          setGpuStats((prev) => (prev === null && stats === null) || (prev !== null && stats !== null && shallowEqualFields(prev, stats)) ? prev : stats);
          if (stats) {
            try { localStorage.setItem("cookllm.last_gpu_stats", JSON.stringify(stats)); } catch {}
          } else {
            try { localStorage.removeItem("cookllm.last_gpu_stats"); } catch {}
          }
        }).catch(() => {
          if (active) {
            setGpuStats((prev) => (prev === null ? prev : null));
            try { localStorage.removeItem("cookllm.last_gpu_stats"); } catch {}
          }
        });
      } else {
        setGpuStats(null);
        try { localStorage.removeItem("cookllm.last_gpu_stats"); } catch {}
      }
    };
    // 挂载立即刷新一次（避免第一帧只显示版本号、2 秒后才出卡片）
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [gpuMonitorEnabled, configReady]);

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

  /**
   * 服务生命周期事件：托盘 / 主界面任一侧的启动、停止、失败都会广播到此处，
   * 保证两侧状态完全同步（过渡动画、异常标记、意外退出判定），与 handleStart / handleStop 行为对齐。
   * 通过 ref 转发以读取最新闭包（监听器仅注册一次，避免捕获过期的 page / t）。
   */
  const handleServerLifecycle = (payload: ServerLifecyclePayload) => {
    if (payload.phase === "starting" && payload.status) {
      const next = payload.status;
      startingNewRef.current = false;
      // 与 handleStart 对齐：进入启动过渡动画 + 清除异常标记 + 武装就绪后自动收起 Dock + 就绪提示
      lifecycleStartingAtRef.current = Date.now();
      setServiceAbnormal(false);
      inferenceTrackerRef.current.reset();
      setLatestInference(null);
      setInferenceHistory([]);
      setTokSample(null);
      dockAutoCollapseRef.current = true;
      pendingStartedToastRef.current = next.modelName || null;
      if (next.modelId) setStartingModelId(next.modelId);
      setStatus((prev) => (shallowEqualFields(prev, next) ? prev : next));
      if (!serviceStartingRef.current) beginServiceStarting(next.modelId);
      if (pageRef.current !== "logs") setLogDockOpen(true);
    } else if (payload.phase === "ready") {
      // 后端 HTTP 探针确认接口可服务：与日志就绪信号等价，统一收尾过渡动画 / Dock / 播报
      markServiceReady();
    } else if (payload.phase === "stopped") {
      // 切换模型/引擎时，启动流程内部会先停掉旧进程：这条 stopped 属于旧服务，
      // 只同步状态，保留新模型正在进行的启动过渡动画
      if (startingNewRef.current) {
        if (prevRunningRef.current) {
          stopIntendedRef.current = true;
          setStatus(EMPTY_STATUS);
        }
        return;
      }
      // 主动停止（含托盘）：立即结束过渡动画、撤销就绪提示；状态仍在运行时同步为停止并放行意外退出判定
      endServiceStarting();
      setStartingModelId(null);
      pendingStartedToastRef.current = null;
      dockAutoCollapseRef.current = false;
      if (prevRunningRef.current) {
        stopIntendedRef.current = true;
        setStatus(EMPTY_STATUS);
      }
    } else if (payload.phase === "failed") {
      // 启动失败 / 进程意外退出：结束过渡动画并标记服务异常（错误详情由后端日志另行输出）
      endServiceStarting();
      pendingStartedToastRef.current = null;
      dockAutoCollapseRef.current = false;
      setServiceAbnormal(true);
      if (pageRef.current !== "logs") setLogDockOpen(true);
    }
  };
  const serverLifecycleHandlerRef = useRef(handleServerLifecycle);
  serverLifecycleHandlerRef.current = handleServerLifecycle;

  const handleStop = async () => {
    startSeqRef.current += 1; // 取消仍在编排中的启动流程
    setBusy(true); setStartingModelId(null); endServiceStarting(); pendingStartedToastRef.current = null; appendLog(t("log.stopping"));
    stopIntendedRef.current = true; // 本次退出是主动停止 → 不判为服务异常
    dockAutoCollapseRef.current = false;
    try { if (isTauri()) setStatus(await stopServer()); else { await new Promise((resolve) => window.setTimeout(resolve, 380)); setStatus(EMPTY_STATUS); appendLog(t("log.stopSuccess")); } setToast(t("toast.stopped")); }
    catch (error) { appendLog(t("log.stopFailed", { error: String(error) }), "stderr"); }
    finally { setBusy(false); setTokSample(null); }
  };

  const handleStart = async (model: ModelAsset) => {
    const profileId = selectedProfiles[model.id] || model.defaultProfileId || model.profiles[0]?.id || '';
    const profile = model.profiles.find((item) => item.id === profileId);
    if (!profile) return setToast(t("toast.addProfileFirst"));

    // 1. 若点击的是当前正在运行或正在启动中的同一个模型 -> 视为停止/暂停
    if ((status.running && status.modelId === model.id) || (startingModelId === model.id)) {
      return handleStop();
    }

    const switching = Boolean(status.running || serviceStarting || startingModelId);
    const engineName = profile.engineId
      ? config.engines?.find((e) => e.id === profile.engineId)?.name || profile.engineId
      : config.engines?.find((e) => e.id === config.activeEngineId)?.name || "默认引擎";

    // 点击即进入启动过渡：切换旧服务与孤儿进程检测都要 await 数百毫秒以上，
    // 先在同一次事件里切到旋转态，避免 IPC 往返期间按钮毫无反馈；序号用于让旧流程在 await 后失效
    const seq = ++startSeqRef.current;
    startingNewRef.current = switching;
    setBusy(true);
    setStartingModelId(model.id);
    beginServiceStarting(model.id);
    lifecycleStartingAtRef.current = Date.now();
    setMenuModelId(null);
    setServiceAbnormal(false);
    inferenceTrackerRef.current.reset();
    setLatestInference(null);
    setInferenceHistory([]);
    setTokSample(null);
    dockAutoCollapseRef.current = true;
    pendingStartedToastRef.current = modelTitle(model);
    appendLog(t("toast.starting", { model: modelTitle(model), profile: `${profile.name} [${engineName}]` }));

    // 2. 若当前有其他模型正在运行或处于启动中 -> 先停止旧模型，再切换启动新选择的模型
    if (switching) {
      stopIntendedRef.current = true;
      appendLog("正在停止当前服务并切换启动新模型…", "system");
      try {
        if (isTauri()) await stopServer();
        else setStatus(EMPTY_STATUS);
      } catch (err) {
        console.warn("停止前序服务失败", err);
      }
      if (seq !== startSeqRef.current) return;
      // 停止旧服务可能耗时数秒：重置轮询宽限窗口，避免过期 running=false 误杀新启动的过渡动画
      lifecycleStartingAtRef.current = Date.now();
    }

    // 启动前安全检测：检查后台是否有未被托管的残留 llama-server，防止双模型并发占用显存
    if (isTauri()) {
      try {
        const orphanInfo = await checkOrphanServer();
        if (seq !== startSeqRef.current) return;
        if (orphanInfo.hasOrphan && orphanInfo.pids.length > 0) {
          endServiceStarting();
          setBusy(false);
          pendingStartedToastRef.current = null;
          dockAutoCollapseRef.current = false;
          setOrphanPendingModel(model);
          setOrphanPids(orphanInfo.pids);
          setOrphanProcesses(orphanInfo.processes ?? null);
          return;
        }
      } catch { }
    }

    try {
      if (isTauri()) {
        const next = await startServer(model.id, profile.id);
        if (seq !== startSeqRef.current) return;
        startingNewRef.current = false;
        setStatus(next);
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 650));
        if (seq !== startSeqRef.current) return;
        startingNewRef.current = false;
        setStatus({
          running: true,
          pid: 18420,
          port: profile.port,
          modelId: model.id,
          modelName: modelTitle(model),
          profileId: profile.id,
          profileName: profile.name,
          startedAt: Date.now(),
          engineName,
          engineBackend: profile.engineId ? config.engines?.find((e) => e.id === profile.engineId)?.backend : "cuda",
        });
        [`llama_model_loader: loaded meta data with ${model.parameters} parameters`, `load_tensors: offloading ${profile.gpuLayers} repeating layers to GPU`, `llama_context: n_ctx = ${profile.contextSize}, n_batch = ${profile.batchSize}, n_ubatch = ${profile.ubatchSize}`, `server is listening on http://${profile.host}:${profile.port}`].forEach((line, index) => window.setTimeout(() => { if (seq !== startSeqRef.current) return; appendLog(line, "stdout"); if (index === 3) markServiceReady(); }, 180 * index));
      }
      if (seq !== startSeqRef.current) return;
      setServiceAbnormal(false); // 启动成功 → 清除异常标记
      appendLog(`[engine] ${engineName}`, "system");
      const currentEng = profile.engineId ? config.engines?.find((e) => e.id === profile.engineId) : config.engines?.find((e) => e.id === config.activeEngineId);
      const isLlama = !currentEng || currentEng.engineType === "llamacpp" || !currentEng.engineType;
      if (isLlama) {
        if (profile.mmprojPath) appendLog(`--mmproj ${profile.mmprojPath}`, "stdout");
        if (profile.mtpDraftPath) appendLog(`-md ${profile.mtpDraftPath}`, "stdout");
        if (profile.mtp && !profile.mtpDraftPath) appendLog(`--spec-type draft-mtp`, "stdout");
        if (profile.mtp || profile.mtpDraftPath) appendLog(`--spec-draft-n-max ${profile.specDraftNMax ?? 2}`, "stdout");
      }
      if (pageRef.current !== "logs") setLogDockOpen(true); // 所有 Dock 页启动时自动展开，显示加载日志；就绪后自动收起（日志整页本身就在看日志）
      // 「已启动」提示延迟到服务真正就绪后再播报（与 Dock 收起、旋转动画结束同步）；若就绪日志已提前到达则立即补播报
      if (!serviceStartingRef.current) markServiceReady();
    } catch (error) {
      if (seq !== startSeqRef.current) return;
      pendingStartedToastRef.current = null;
      appendLog(t("log.startFailed", { error: String(error) }), "stderr");
      setServiceAbnormal(true);
      dockAutoCollapseRef.current = false;
      endServiceStarting();
      if (pageRef.current !== "logs") setLogDockOpen(true);
      setToast(t("toast.startFailedToast"));
    } finally {
      if (seq === startSeqRef.current) setBusy(false);
    }
  };

  /** 清空当前模型会话的推理性能历史与统计 */
  const handleClearInferenceStats = () => {
    inferenceTrackerRef.current.reset();
    setLatestInference(null);
    setInferenceHistory([]);
    setTokSample(null);
  };

  /** 终止后台残留的 llama-server 进程 */
  const handleKillOrphan = async () => {
    const pids = orphanPids || [];
    const pendingModel = orphanPendingModel;
    setOrphanPids(null);
    setOrphanProcesses(null);
    setOrphanPendingModel(null);
    try {
      const killed = await killOrphanServer(pids);
      appendLog(t("orphan.killedLog", { count: killed }), "system");
      setToast(t("orphan.killedToast", { count: killed }));
      if (pendingModel) {
        window.setTimeout(() => {
          void handleStart(pendingModel);
        }, 300);
      }
    } catch (error) {
      appendLog(t("orphan.killFailed", { error: String(error) }), "stderr");
      setToast(t("orphan.killFailed", { error: String(error) }));
    }
  };

  const handleCloseOrphanModal = () => {
    setOrphanPids(null);
    setOrphanProcesses(null);
    setOrphanPendingModel(null);
  };

  return {
    serviceAbnormal, tokSample, setTokSample, inferenceTrackerRef, latestInference, setLatestInference, inferenceHistory, setInferenceHistory,
    gpuStats, setGpuStats, busy, serviceStarting, startingModelId,
    markServiceReady, serverLifecycleHandlerRef,
    handleStart, handleStop, handleClearInferenceStats,
    orphanPids, orphanProcesses, orphanPendingModel, setOrphanPids, setOrphanProcesses,
    handleKillOrphan, handleCloseOrphanModal,
  };
}
