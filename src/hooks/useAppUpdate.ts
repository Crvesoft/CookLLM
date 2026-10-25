import { useEffect, useRef, useState } from "react";
import { APP_VERSION } from "../data";
import { checkForUpdate, type UpdateCheckResult } from "../tauri";
import type { AppConfig } from "../types";

/** 自动检测更新间隔：30 分钟，兼顾及时性与 GitHub 匿名 API 频率限制 */
const AUTO_UPDATE_INTERVAL_MINUTES = 30;
const AUTO_UPDATE_INTERVAL_MS = AUTO_UPDATE_INTERVAL_MINUTES * 60 * 1000;

/** 应用自更新：检查状态、更新弹窗，以及启动后持续定时自动检查 */
export function useAppUpdate(config: AppConfig, configReady: boolean) {
  const [appUpdate, setAppUpdate] = useState<UpdateCheckResult | null>(null);
  const [appUpdateDialogOpen, setAppUpdateDialogOpen] = useState(false);
  const [appUpdateChecking, setAppUpdateChecking] = useState(false);
  const notifiedTagRef = useRef<string | null>(null);

  const runCheck = async (openWhenAvailable: boolean, notifyOnlyNew: boolean, showChecking: boolean) => {
    if (showChecking) setAppUpdateChecking(true);
    try {
      const result = await checkForUpdate(APP_VERSION);
      setAppUpdate(result);
      if (result.status === "available" && openWhenAvailable) {
        const isNew = result.latestTag !== notifiedTagRef.current;
        if (!notifyOnlyNew || isNew) {
          notifiedTagRef.current = result.latestTag;
          setAppUpdateDialogOpen(true);
        }
      }
      return result;
    } finally {
      if (showChecking) setAppUpdateChecking(false);
    }
  };

  /** 手动检查：按钮展示检测中状态 */
  const checkAppUpdate = (openWhenAvailable = true, notifyOnlyNew = false) =>
    runCheck(openWhenAvailable, notifyOnlyNew, true);

  useEffect(() => {
    if (!configReady || config.autoUpdateEnabled === false) return;
    let interval: number | undefined;
    // 后台自动检测保持静默：不驱动按钮的“检测中”状态，避免布局抖动
    const run = () => { void runCheck(true, true, false).catch(() => undefined); };
    const startupTimer = window.setTimeout(() => {
      run();
      interval = window.setInterval(run, AUTO_UPDATE_INTERVAL_MS);
    }, 1200);
    return () => {
      window.clearTimeout(startupTimer);
      if (interval !== undefined) window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configReady, config.autoUpdateEnabled]);

  return { appUpdate, appUpdateDialogOpen, setAppUpdateDialogOpen, appUpdateChecking, checkAppUpdate };
}
