import { Activity, AlertTriangle, Check, Github, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APP_REPO, PROJECT_URL } from "../../data";
import { useI18n } from "../../i18n";
import { getAppVersion, openExternal, type UpdateCheckResult } from "../../tauri";
import type { AppConfig, LlamaLogPayload } from "../../types";
import { cn } from "../../utils";

interface Props {
  config: AppConfig;
  appUpdate: UpdateCheckResult | null;
  checkingUpdate: boolean;
  onCheckUpdate: (openWhenAvailable?: boolean) => Promise<UpdateCheckResult>;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
  onLog: (line: string, stream?: LlamaLogPayload["stream"]) => void;
}

type UpdateState = { phase: "idle" } | { phase: "checking" } | { phase: "done"; result: UpdateCheckResult } | { phase: "error"; message: string };

export default function AboutCard({ config, appUpdate, checkingUpdate, onCheckUpdate, onPersist, onLog }: Props) {
  const { t } = useI18n();
  const [appVersion, setAppVersion] = useState("");
  const [update, setUpdate] = useState<UpdateState>({ phase: "idle" });
  const [updateCheckDone, setUpdateCheckDone] = useState(false);
  const updateCheckTimer = useRef<number | null>(null);
  const updateAvailable = appUpdate?.status === "available";
  const autoUpdateEnabled = config.autoUpdateEnabled !== false;

  useEffect(() => { void getAppVersion().then(setAppVersion).catch(() => undefined); }, []);

  const runUpdateCheck = async () => {
    if (checkingUpdate) return;
    setUpdate({ phase: "checking" });
    try {
      const result = await onCheckUpdate(true);
      setUpdate({ phase: "done", result });
      setUpdateCheckDone(true);
      if (updateCheckTimer.current) window.clearTimeout(updateCheckTimer.current);
      updateCheckTimer.current = window.setTimeout(() => setUpdateCheckDone(false), 2000);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      setUpdate({ phase: "error", message: raw === "no-releases" ? t("st.updateNoReleases") : t("st.updateError", { error: raw }) });
      setUpdateCheckDone(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-icon"><Github size={16} /></div>
        <h3>{t("st.aboutTitle")}</h3>
      </div>
      <div className="settings-card-body">
        <p className="about-desc">{t("st.aboutDesc")}</p>
        <div className="about-info">
          <span className="app-version-badge">{appVersion ? "v" + appVersion : "--"}{updateAvailable && <em className="version-new-badge">NEW</em>}</span>
          <button className="repo-link" title={PROJECT_URL} onClick={() => void openExternal(PROJECT_URL)}><Github size={13} />{APP_REPO}</button>
          <button className="ghost-link" onClick={() => onLog("diagnostics: UI event bridge is working", "system")}><Activity size={12} />{t("sendTestLog")}</button>
          <div className="about-update-control">
            <label className="auto-update-toggle">
              <span>{t("st.autoUpdate")}</span>
              <button className={cn("switch", autoUpdateEnabled && "on")} role="switch" aria-checked={autoUpdateEnabled} aria-label={t("st.autoUpdate")} onClick={() => void onPersist({ ...config, autoUpdateEnabled: !autoUpdateEnabled }, t("toast.settingsSaved"))}>
                <span className="switch-knob" />
              </button>
            </label>
            <button className="secondary-button compact" disabled={checkingUpdate} onClick={() => void runUpdateCheck()}>
              {checkingUpdate ? <Loader2 size={14} className="spin" /> : updateCheckDone ? <Check size={14} /> : <RefreshCw size={14} />}
              {checkingUpdate ? t("st.checkingUpdate") : updateCheckDone ? t("st.checkDoneShort") : t("st.checkUpdate")}
            </button>
          </div>
        </div>
        {update.phase === "error" && <div className="about-result"><span className="storage-note err"><AlertTriangle size={15} />{update.message}</span></div>}
      </div>
    </div>
  );
}
