import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Download, FileText, Loader2, PackageCheck, RefreshCw, Rocket, Sparkles, X } from "lucide-react";
import { APP_VERSION } from "../data";
import { useI18n } from "../i18n";
import { cancelAppUpdate, downloadAppUpdate, installAppUpdate, onDownloadProgress, type DownloadProgress, type UpdateCheckResult } from "../tauri";
import { formatBytes, formatMB } from "../utils";

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
  const sizeText = progress && (progress.downloaded > 0 || progress.total > 0)
    ? progress.total > 0
      ? `${formatMB(progress.downloaded)} / ${formatMB(progress.total)}`
      : formatMB(progress.downloaded)
    : "";
  const percent = phase === "download" && progress ? Math.min(100, Math.max(0, progress.percent)) : phase === "ready" || phase === "launch" ? 100 : 0;
  const canClose = phase === "info" || phase === "error";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && canClose && onClose()}>
      <section className="import-modal update-modal" aria-live="polite" role="dialog" aria-modal="true">
        <header className="update-modal-header">
          <div className="update-modal-title">
            <Sparkles size={17} className="update-modal-icon" />
            <h2>{t("update.dialogTitle")}</h2>
            {update.latestTag && <span className="update-modal-tag">{update.latestTag}</span>}
          </div>
          {canClose && <button className="ghost-icon" onClick={onClose} aria-label={t("cancel")}><X size={18} /></button>}
        </header>

        {phase === "download" ? (
          <div className="update-body">
            <div className="download-minimal">
              <div className="download-minimal-header">
                <div className="download-minimal-left">
                  <span className="download-status-dot" />
                  <span className="download-status-title">正在下载安装包</span>
                  {speedText && <span className="download-status-speed">{speedText}</span>}
                </div>
                <div className="download-minimal-right">
                  {sizeText && <span className="download-status-size">{sizeText}</span>}
                  <span className="download-status-percent">{percent}%</span>
                </div>
              </div>

              <div className="download-bar">
                <div className="download-bar-inner" style={{ width: `${percent}%` }} />
              </div>

              <div className="download-minimal-sub">
                <span className="download-minimal-hint">下载中请保持应用开启，完成后将自动继续</span>
                {update.assetName && (
                  <span className="download-minimal-tag">
                    {update.assetName.toLowerCase().endsWith(".msi") ? "MSI 原地覆盖" : "EXE 安装包"}
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : phase === "ready" ? (
          <div className="update-body">
            <div className="download-done-simple">
              <div className="download-done-icon">
                <CheckCircle2 size={24} strokeWidth={2.4} />
              </div>
              <div className="download-done-info">
                <h3>新版本安装包已就绪</h3>
                <p>点击“立即安装”后应用将重启并自动完成覆盖升级</p>
              </div>
            </div>
          </div>
        ) : phase === "launch" ? (
          <div className="update-body">
            <div className="download-done-simple">
              <div className="download-done-icon spin">
                <Loader2 size={24} />
              </div>
              <div className="download-done-info">
                <h3>正在启动安装程序…</h3>
                <p>{t("update.launching")}</p>
              </div>
            </div>
          </div>
        ) : phase === "error" ? (
          <div className="update-body">
            <div className="download-done-simple">
              <div className="download-done-icon error">
                <AlertTriangle size={24} />
              </div>
              <div className="download-done-info">
                <h3>更新遇到问题</h3>
                <p>{error}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="update-body">
            <div className="update-version-card">
              <div className="update-version-col">
                <span className="update-version-tag">当前版本</span>
                <strong>v{APP_VERSION}</strong>
              </div>
              <div className="update-version-arrow">
                <ArrowRight size={15} />
              </div>
              <div className="update-version-col highlight">
                <span className="update-version-tag new">最新版本</span>
                <strong>{update.latestTag}</strong>
              </div>
              {update.assetName && (
                <div className="update-asset-pill" title={update.assetName}>
                  <PackageCheck size={13} />
                  <span>{update.assetName.toLowerCase().endsWith(".msi") ? "MSI 原地升级" : "EXE 安装包"}{update.assetSize ? ` · ${formatMB(update.assetSize)}` : ""}</span>
                </div>
              )}
            </div>

            <div className="update-changelog-wrap">
              <div className="update-changelog-header">
                <FileText size={13} />
                <strong>{t("update.changelog")}</strong>
              </div>
              <div className="update-changelog-content">
                <pre>{update.releaseNotes?.trim() || t("update.noChangelog")}</pre>
              </div>
            </div>
          </div>
        )}

        <footer>
          {phase === "ready" ? (
            <>
              <button className="secondary-button" onClick={onClose}>{t("update.later")}</button>
              <button className="primary-button update-button" onClick={() => void startInstall()}><Rocket size={14} />{t("update.installReady")}</button>
            </>
          ) : phase === "download" ? (
            <button className="secondary-button" onClick={() => void cancelDownload()}><X size={14} />{t("cancel")}</button>
          ) : phase === "launch" ? (
            <span className="download-footer-hint">准备就绪，软件即将重启…</span>
          ) : phase === "error" ? (
            <>
              <button className="secondary-button" onClick={onClose}>{t("update.later")}</button>
              <button className="primary-button update-button" onClick={() => void startDownload()}><RefreshCw size={14} />{t("retry")}</button>
            </>
          ) : (
            <>
              <button className="secondary-button" onClick={onClose}>{t("update.later")}</button>
              <button className="primary-button update-button" onClick={() => void startDownload()}><Download size={14} />{t("update.installNow")}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
