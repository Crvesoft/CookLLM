import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { useI18n } from "../i18n";
import { cancelAppUpdate, downloadAppUpdate, installAppUpdate, onDownloadProgress, type DownloadProgress, type UpdateCheckResult } from "../tauri";
import { formatBytes } from "../utils";

type UpdatePhase = "info" | "download" | "ready" | "launch" | "error";

export default function AppUpdateDialog({ open, update, onClose }: { open: boolean; update: UpdateCheckResult | null; onClose: () => void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<UpdatePhase>("info");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [installerPath, setInstallerPath] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setPhase("info");
    setProgress(null);
    setInstallerPath("");
    setError("");
  }, [open, update?.latestTag]);

  useEffect(() => {
    if (!open || phase !== "download") return;
    let active = true;
    const unlisten = onDownloadProgress((payload) => {
      if (active) setProgress(payload);
    });
    return () => {
      active = false;
      void unlisten.then((listener) => listener?.());
    };
  }, [open, phase]);

  if (!open || !update) return null;

  const startDownload = async () => {
    setPhase("download");
    setError("");
    setProgress(null);
    try {
      const path = await downloadAppUpdate(update);
      setInstallerPath(path);
      setPhase("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase("error");
    }
  };

  const cancelDownload = async () => {
    await cancelAppUpdate();
    setPhase("info");
    setProgress(null);
  };

  const startInstall = async () => {
    setPhase("launch");
    try {
      await installAppUpdate(installerPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase("error");
    }
  };

  const speedText = progress?.speedBps ? `${formatBytes(progress.speedBps)}/s` : "";
  const percent = phase === "download" && progress ? Math.min(100, Math.max(0, progress.percent)) : phase === "ready" || phase === "launch" ? 100 : 0;
  const canClose = phase === "info" || phase === "error";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && canClose && onClose()}>
      <section className="import-modal update-modal" aria-live="polite">
        <header>
          <div>
            <span>{t("update.dialogTitle")}</span>
            <h2>{update.latestTag}</h2>
          </div>
          {canClose && <button className="ghost-icon" onClick={onClose} aria-label={t("cancel")}><X size={19} /></button>}
        </header>
        {phase === "download" ? (
          <div className="update-body">
            <div className="download-bar"><div className="download-bar-inner" style={{ width: `${percent}%` }} /></div>
            <div className="download-meta">
              <span>{percent}%</span>
              <span>{speedText}</span>
            </div>
            <p className="download-message">{progress?.message || t("update.downloading")}</p>
          </div>
        ) : (
          <div className="update-body">
            <p className="update-summary">{t("update.available", { tag: update.latestTag })}</p>
            <div className="update-changelog">
              <strong>{t("update.changelog")}</strong>
              <pre>{update.releaseNotes?.trim() || t("update.noChangelog")}</pre>
            </div>
            {phase === "ready" && <p className="update-ready-message">{t("update.ready")}</p>}
            {phase === "launch" && <p className="update-ready-message"><Loader2 size={14} className="spin" />{t("update.launching")}</p>}
            {phase === "error" && <p className="update-error">{error}</p>}
          </div>
        )}
        {phase !== "download" && (
          <footer>
            {phase === "ready" ? (
              <>
                <button className="secondary-button" onClick={onClose}>{t("update.later")}</button>
                <button className="primary-button update-button" onClick={() => void startInstall()}>{t("update.installReady")}</button>
              </>
            ) : phase === "error" ? (
              <>
                <button className="secondary-button" onClick={onClose}>{t("update.later")}</button>
                <button className="primary-button update-button" onClick={() => void startDownload()}><RefreshCw size={15} />{t("retry")}</button>
              </>
            ) : (
              <>
                <button className="secondary-button" onClick={onClose}>{t("update.later")}</button>
                <button className="primary-button update-button" onClick={() => void startDownload()}><Download size={15} />{t("update.installNow")}</button>
              </>
            )}
          </footer>
        )}
        {phase === "download" && (
          <footer>
            <button className="secondary-button" onClick={() => void cancelDownload()}>{t("cancel")}</button>
          </footer>
        )}
      </section>
    </div>
  );
}
