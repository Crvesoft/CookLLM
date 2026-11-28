import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_NINFER_CONVERTER_REPO, uid } from "../data";
import {
  cancelNinferConvert,
  cancelNinferConverterDownload,
  checkNinferConverterRelease,
  convertGgufToNinfer,
  downloadNinferConverter,
  fetchHfAuxConfigs,
  getNinferConverterStatus,
  hfSearch,
  importNinferConverterZip,
  inspectGgufForNinfer,
  msSearch,
  onNinferConvertLog,
  onNinferConvertProgress,
  onNinferConverterDownloadProgress,
  pickNinferConverterDir,
  removeNinferConverter,
} from "../tauri";
import type {
  AppConfig,
  HfModel,
  ModelAsset,
  NinferAuxConfigFetchResult,
  NinferConvertInspection,
  NinferConvertHistoryItem,
  NinferConvertLogEvent,
  NinferConvertOptions,
  NinferConvertProgress,
  NinferConvertResult,
  NinferConverterDownloadProgress,
  NinferConverterRelease,
  NinferConverterStatus,
} from "../types";
import { fileName, modelTitle } from "../utils";
import type { PersistConfig, Translate } from "./types";

interface UseNinferConvertOptions {
  config: AppConfig;
  getLatestConfig?: () => AppConfig;
  persist: PersistConfig;
  onSyncConfig?: () => Promise<void>;
  addModelFromPaths: (paths: { path: string; sizeBytes: number; name?: string }[]) => Promise<void>;
  setToast: (msg: string) => void;
  t: Translate;
}

const MAX_HISTORY_ITEMS = 50;

function isSameVersion(a?: string | null, b?: string | null): boolean {
  const na = (a || "").trim().replace(/^v/i, "").toLowerCase();
  const nb = (b || "").trim().replace(/^v/i, "").toLowerCase();
  return Boolean(na && nb && na === nb);
}

function isQuantOrWeightOnlyRepo(id: string): boolean {
  return /[-_](gguf|ninfer|exl2|mlx|awq|gptq)$/i.test(id.trim());
}

function normalizeGithubRepoInput(raw: string): string | null {
  let text = raw.trim().replace(/\/+$/, "");
  if (!text) return DEFAULT_NINFER_CONVERTER_REPO;
  text = text.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const parts = text.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const validSeg = (s: string) =>
    s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s);
  if (!validSeg(parts[0]) || !validSeg(parts[1])) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** GGUF → NInfer 转换域：插件包生命周期、预检、辅助配置拉取、转换执行与自动入库 */
export function useNinferConvert({
  config,
  getLatestConfig,
  persist,
  onSyncConfig,
  addModelFromPaths,
  setToast,
  t,
}: UseNinferConvertOptions) {
  const [targetModel, setTargetModel] = useState<ModelAsset | null>(null);
  const [minimized, setMinimized] = useState(false);
  const cancelRequestedRef = useRef(false);
  const [converterStatus, setConverterStatus] = useState<NinferConverterStatus | null>(null);
  const [remoteRelease, setRemoteRelease] = useState<NinferConverterRelease | null>(null);
  const [checkingRelease, setCheckingRelease] = useState(false);
  const [downloadingBundle, setDownloadingBundle] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<NinferConverterDownloadProgress | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<NinferConvertInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [fetchingAux, setFetchingAux] = useState(false);
  const [auxFetchResult, setAuxFetchResult] = useState<NinferAuxConfigFetchResult | null>(null);
  const [auxFetchError, setAuxFetchError] = useState<string | null>(null);
  const [searchingAux, setSearchingAux] = useState(false);
  const [auxSearchResults, setAuxSearchResults] = useState<HfModel[]>([]);
  const [auxSearchError, setAuxSearchError] = useState<string | null>(null);
  const [auxSearchQueried, setAuxSearchQueried] = useState(false);

  const [converting, setConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState<NinferConvertProgress | null>(null);
  const [convertLogs, setConvertLogs] = useState<NinferConvertLogEvent[]>([]);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertResult, setConvertResult] = useState<NinferConvertResult | null>(null);

  useEffect(() => {
    let u1: (() => void) | undefined;
    let u2: (() => void) | undefined;
    let u3: (() => void) | undefined;
    void onNinferConverterDownloadProgress((p) => setDownloadProgress(p)).then((fn) => {
      u1 = fn;
    });
    void onNinferConvertProgress((p) => setConvertProgress(p)).then((fn) => {
      u2 = fn;
    });
    void onNinferConvertLog((entry) => {
      setConvertLogs((prev) => {
        const next = prev.length >= 200 ? prev.slice(prev.length - 199) : prev;
        return [...next, entry];
      });
    }).then((fn) => {
      u3 = fn;
    });
    return () => {
      u1?.();
      u2?.();
      u3?.();
    };
  }, []);

  const syncRemoteWithStatus = useCallback((status: NinferConverterStatus) => {
    setRemoteRelease((prev) =>
      prev
        ? {
            ...prev,
            upToDate: Boolean(status.ready && isSameVersion(status.localVersion, prev.tag)),
          }
        : prev,
    );
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await getNinferConverterStatus();
      setConverterStatus(st);
      syncRemoteWithStatus(st);
      return st;
    } catch {
      return null;
    }
  }, [syncRemoteWithStatus]);

  const checkRelease = useCallback(async (repo?: string, silent = false) => {
    setCheckingRelease(true);
    if (!silent) setBundleError(null);
    try {
      const rel = await checkNinferConverterRelease(repo);
      setRemoteRelease(rel);
      return rel;
    } catch (err) {
      if (!silent) {
        setBundleError(err instanceof Error ? err.message : String(err));
      }
      return null;
    } finally {
      setCheckingRelease(false);
    }
  }, []);

  const minimizeModal = useCallback(() => {
    setMinimized(true);
  }, []);

  const expandModal = useCallback(() => {
    setMinimized(false);
  }, []);

  const openModal = useCallback(
    async (model: ModelAsset) => {
      if (converting) {
        setMinimized(false);
        return;
      }
      setMinimized(false);
      setTargetModel(model);
      setInspection(null);
      setInspectError(null);
      setAuxFetchResult(null);
      setAuxFetchError(null);
      setAuxSearchResults([]);
      setAuxSearchError(null);
      setAuxSearchQueried(false);
      setConvertError(null);
      setConvertResult(null);
      setConvertLogs([]);
      setConvertProgress(null);
      setBundleError(null);
      setInspecting(true);
      void checkRelease(undefined, true);
      try {
        const [st, insp] = await Promise.all([
          getNinferConverterStatus().catch(() => null),
          inspectGgufForNinfer(model.path),
        ]);
        if (st) {
          setConverterStatus(st);
          syncRemoteWithStatus(st);
        }
        setInspection(insp);
      } catch (err) {
        setInspectError(err instanceof Error ? err.message : String(err));
      } finally {
        setInspecting(false);
      }
    },
    [checkRelease, converting, syncRemoteWithStatus],
  );

  const closeModal = useCallback(() => {
    if (converting || downloadingBundle) return;
    setTargetModel(null);
    setMinimized(false);
  }, [converting, downloadingBundle]);

  const installBundleFromGithub = useCallback(
    async (repo?: string) => {
      if (downloadingBundle) return null;
      setDownloadingBundle(true);
      setBundleError(null);
      setDownloadProgress({ phase: "download", percent: 0, downloaded: 0, total: 0, speedBps: 0, message: "" });
      try {
        let rel = remoteRelease;
        if (!rel || (repo && rel.repo !== repo.trim())) {
          rel = await checkNinferConverterRelease(repo);
          setRemoteRelease(rel);
        }
        const status = await downloadNinferConverter({
          repo: rel?.repo || repo,
          assetUrl: rel?.assetUrl ?? undefined,
          assetName: rel?.assetName ?? undefined,
          tag: rel?.tag,
          sha256: rel?.assetSha256 ?? undefined,
        });
        setConverterStatus(status);
        syncRemoteWithStatus(status);
        await onSyncConfig?.().catch(() => undefined);
        setToast(t("convert.bundleReadyToast"));
        return status;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBundleError(msg);
        return null;
      } finally {
        setDownloadingBundle(false);
      }
    },
    [downloadingBundle, onSyncConfig, remoteRelease, setToast, syncRemoteWithStatus, t],
  );

  const cancelBundleDownload = useCallback(() => {
    void cancelNinferConverterDownload().catch(() => undefined);
  }, []);

  const importBundleZip = useCallback(async () => {
    setBundleError(null);
    try {
      const status = await importNinferConverterZip();
      if (status) {
        setConverterStatus(status);
        syncRemoteWithStatus(status);
        await onSyncConfig?.().catch(() => undefined);
        setToast(t("convert.bundleReadyToast"));
      }
      return status;
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [onSyncConfig, setToast, syncRemoteWithStatus, t]);

  const pickBundleDir = useCallback(async () => {
    setBundleError(null);
    try {
      const status = await pickNinferConverterDir();
      if (status) {
        setConverterStatus(status);
        syncRemoteWithStatus(status);
        await onSyncConfig?.().catch(() => undefined);
        setToast(t("convert.bundleReadyToast"));
      }
      return status;
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [onSyncConfig, setToast, syncRemoteWithStatus, t]);

  const uninstallBundle = useCallback(async () => {
    setBundleError(null);
    try {
      const status = await removeNinferConverter();
      setConverterStatus(status);
      syncRemoteWithStatus(status);
      await onSyncConfig?.().catch(() => undefined);
      setToast(t("convert.bundleRemovedToast"));
      return status;
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [onSyncConfig, setToast, syncRemoteWithStatus, t]);

  const saveConverterRepo = useCallback(
    async (repo: string): Promise<string | null> => {
      const normalized = normalizeGithubRepoInput(repo);
      if (!normalized) {
        setBundleError(t("convert.repoInvalidToast"));
        return null;
      }
      setBundleError(null);
      const isDefault =
        normalized.toLowerCase() === DEFAULT_NINFER_CONVERTER_REPO.toLowerCase();
      const targetRepo = isDefault ? DEFAULT_NINFER_CONVERTER_REPO : normalized;
      const latest = getLatestConfig ? getLatestConfig() : config;
      await persist({
        ...latest,
        ninferConverterRepo: isDefault ? undefined : targetRepo,
      });
      await refreshStatus();
      void checkRelease(targetRepo, true);
      setToast(
        isDefault
          ? t("convert.repoResetToast", { repo: targetRepo })
          : t("convert.repoSavedToast", { repo: targetRepo }),
      );
      return targetRepo;
    },
    [checkRelease, config, getLatestConfig, persist, refreshStatus, setToast, t],
  );

  const resetConverterRepo = useCallback(
    async (): Promise<string | null> => saveConverterRepo(DEFAULT_NINFER_CONVERTER_REPO),
    [saveConverterRepo],
  );

  const searchAuxRepos = useCallback(async (query: string, source: "hf" | "ms") => {
    const trimmed = query.trim();
    if (!trimmed) {
      setAuxSearchResults([]);
      setAuxSearchError(null);
      setAuxSearchQueried(false);
      return [];
    }
    setSearchingAux(true);
    setAuxSearchError(null);
    setAuxSearchQueried(true);
    try {
      const fn = source === "ms" ? msSearch : hfSearch;
      const list = await fn(trimmed, 20, false, 0, "downloads", undefined, "all");
      // 非 -GGUF/-NInfer 原始权重仓优先排前，方便直接选出含 config.json / tokenizer 的源仓库
      const sorted = [...list].sort(
        (a, b) => Number(isQuantOrWeightOnlyRepo(a.id)) - Number(isQuantOrWeightOnlyRepo(b.id)),
      );
      setAuxSearchResults(sorted);
      return sorted;
    } catch (err) {
      setAuxSearchResults([]);
      setAuxSearchError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setSearchingAux(false);
    }
  }, []);

  const clearAuxSearch = useCallback(() => {
    setAuxSearchResults([]);
    setAuxSearchError(null);
    setAuxSearchQueried(false);
  }, []);

  const fetchAuxConfigs = useCallback(async (repo: string, source: "hf" | "ms") => {
    setFetchingAux(true);
    setAuxFetchError(null);
    try {
      const result = await fetchHfAuxConfigs(repo, source);
      setAuxFetchResult(result);
      return result;
    } catch (err) {
      setAuxFetchError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setFetchingAux(false);
    }
  }, []);

  const appendHistory = useCallback(
    async (entry: NinferConvertHistoryItem) => {
      const latest = getLatestConfig ? getLatestConfig() : config;
      const next = [entry, ...(latest.ninferConvertHistory ?? [])].slice(0, MAX_HISTORY_ITEMS);
      await persist({ ...latest, ninferConvertHistory: next }).catch(() => undefined);
    },
    [config, getLatestConfig, persist],
  );

  const deleteHistoryItem = useCallback(
    async (id: string) => {
      const latest = getLatestConfig ? getLatestConfig() : config;
      const next = (latest.ninferConvertHistory ?? []).filter((item) => item.id !== id);
      await persist({ ...latest, ninferConvertHistory: next });
    },
    [config, getLatestConfig, persist],
  );

  const clearHistory = useCallback(async () => {
    const latest = getLatestConfig ? getLatestConfig() : config;
    if (!(latest.ninferConvertHistory ?? []).length) return;
    await persist({ ...latest, ninferConvertHistory: [] }, t("lab.historyClearedToast"));
  }, [config, getLatestConfig, persist, t]);

  const startConversion = useCallback(
    async (options: NinferConvertOptions, autoImport: boolean) => {
      if (converting) return null;
      cancelRequestedRef.current = false;
      const startedAt = Date.now();
      const sourceName =
        options.instanceName?.trim() ||
        (targetModel ? modelTitle(targetModel) : fileName(options.ggufPath).replace(/\.gguf$/i, ""));
      setConverting(true);
      setConvertError(null);
      setConvertResult(null);
      setConvertLogs([]);
      setConvertProgress({ phase: "prepare", percent: 0, current: 0, total: 0, message: "" });
      try {
        const result = await convertGgufToNinfer(options);
        setConvertResult(result);
        if (autoImport) {
          const customInstanceName = options.instanceName?.trim() || undefined;
          await addModelFromPaths([
            { path: result.outputPath, sizeBytes: result.sizeBytes, name: customInstanceName },
          ]);
        }
        await appendHistory({
          id: uid("conv"),
          sourcePath: options.ggufPath,
          sourceName,
          outputPath: result.outputPath,
          sizeBytes: result.sizeBytes,
          status: "success",
          includeMtp: options.includeMtp,
          visionPath: options.visionPath,
          recipe: options.recipe || "auto",
          durationSec: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
          createdAt: Date.now(),
        });
        setToast(t("convert.successToast"));
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setConvertError(msg);
        if (!cancelRequestedRef.current && msg !== "转换已取消") {
          await appendHistory({
            id: uid("conv"),
            sourcePath: options.ggufPath,
            sourceName,
            outputPath: options.outputPath,
            status: "failed",
            includeMtp: options.includeMtp,
            visionPath: options.visionPath,
            recipe: options.recipe || "auto",
            error: msg,
            durationSec: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
            createdAt: Date.now(),
          });
        }
        return null;
      } finally {
        setConverting(false);
      }
    },
    [addModelFromPaths, appendHistory, converting, setToast, t, targetModel],
  );

  const cancelConversion = useCallback(() => {
    cancelRequestedRef.current = true;
    void cancelNinferConvert().catch(() => undefined);
  }, []);

  return {
    targetModel,
    minimized,
    converterStatus,
    remoteRelease,
    checkingRelease,
    downloadingBundle,
    downloadProgress,
    bundleError,
    inspecting,
    inspection,
    inspectError,
    fetchingAux,
    auxFetchResult,
    auxFetchError,
    searchingAux,
    auxSearchResults,
    auxSearchError,
    auxSearchQueried,
    converting,
    convertProgress,
    convertLogs,
    convertError,
    convertResult,
    openModal,
    minimizeModal,
    expandModal,
    closeModal,
    refreshStatus,
    checkRelease,
    installBundleFromGithub,
    cancelBundleDownload,
    importBundleZip,
    pickBundleDir,
    uninstallBundle,
    saveConverterRepo,
    resetConverterRepo,
    searchAuxRepos,
    clearAuxSearch,
    fetchAuxConfigs,
    startConversion,
    cancelConversion,
    deleteHistoryItem,
    clearHistory,
  };
}
