import { useEffect, useRef, useState } from "react";
import { APP_VERSION } from "../data";
import { checkForUpdate, type UpdateCheckResult } from "../tauri";
import type { AppConfig } from "../types";

/** 应用自更新：检查状态、更新弹窗与启动时自动检查（1.2s 延迟，避开首屏繁忙期） */
export function useAppUpdate(config: AppConfig, configReady: boolean) {
  const [appUpdate, setAppUpdate] = useState<UpdateCheckResult | null>(null);
  const [appUpdateDialogOpen, setAppUpdateDialogOpen] = useState(false);
  const [appUpdateChecking, setAppUpdateChecking] = useState(false);
  const startupUpdateCheckedRef = useRef(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configReady, config.autoUpdateEnabled]);

  return { appUpdate, appUpdateDialogOpen, setAppUpdateDialogOpen, appUpdateChecking, checkAppUpdate };
}
