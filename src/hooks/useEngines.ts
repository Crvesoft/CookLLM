import { useMemo } from "react";
import type { AppConfig, LlamaEngine } from "../types";
import type { PersistConfig, Translate } from "./types";

interface UseEnginesOptions {
  config: AppConfig;
  persist: PersistConfig;
  setToast: (message: string) => void;
  t: Translate;
}

/** 引擎注册表：兼容旧版单 serverPath 配置，统一输出引擎列表与当前生效引擎 */
export function useEngines({ config, persist, setToast, t }: UseEnginesOptions) {
  const appEngines = useMemo<LlamaEngine[]>(() => {
    return config.engines && config.engines.length > 0
      ? config.engines
      : config.serverPath
        ? [{ id: "engine-default", name: "默认引擎", path: config.serverPath, backend: "cuda" }]
        : [];
  }, [config.engines, config.serverPath]);

  const activeAppEngine = useMemo(() => {
    return (
      appEngines.find((e) => e.id === config.activeEngineId) ||
      appEngines.find((e) => e.path.toLowerCase() === (config.serverPath || "").toLowerCase()) ||
      appEngines[0]
    );
  }, [appEngines, config.activeEngineId, config.serverPath]);

  const handleSelectActiveEngine = async (engine: LlamaEngine) => {
    setToast(t("llama.switchedTo", { name: engine.name }));
    await persist({
      ...config,
      activeEngineId: engine.id,
      serverPath: engine.path,
    });
  };

  const handleSaveEngine = async (engine: LlamaEngine) => {
    const nextEngines = config.engines && config.engines.length > 0 ? [...config.engines] : [];
    const idx = nextEngines.findIndex((e) => e.id === engine.id);
    if (idx >= 0) {
      nextEngines[idx] = engine;
    } else {
      nextEngines.push(engine);
    }
    const isCurActive = engine.id === config.activeEngineId;
    await persist(
      {
        ...config,
        engines: nextEngines,
        serverPath: isCurActive ? engine.path : config.serverPath,
      },
      t("toast.settingsSaved"),
    );
  };

  const handleDeleteEngine = async (engineId: string) => {
    const nextEngines = (config.engines || []).filter((e) => e.id !== engineId);
    let nextActiveId = config.activeEngineId;
    let nextServerPath = config.serverPath;
    if (config.activeEngineId === engineId && nextEngines.length > 0) {
      nextActiveId = nextEngines[0].id;
      nextServerPath = nextEngines[0].path;
    }
    await persist(
      {
        ...config,
        engines: nextEngines,
        activeEngineId: nextActiveId,
        serverPath: nextServerPath,
      },
      t("toast.settingsSaved"),
    );
  };

  return { appEngines, activeAppEngine, handleSelectActiveEngine, handleSaveEngine, handleDeleteEngine };
}
