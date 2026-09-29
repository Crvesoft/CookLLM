import { useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { OrphanProcessItem } from "../tauri";

interface Props {
  pids: number[];
  processes?: OrphanProcessItem[];
  isStartingService?: boolean;
  onKill: () => void;
  onAdoptPath?: (path: string) => void;
  onClose: () => void;
}

/** 检测到后台遗留未退出的 server 进程时的提醒弹窗 */
export default function OrphanServerModal({ pids, processes, isStartingService, onKill, onAdoptPath, onClose }: Props) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pidsText = pids.join(", ");

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="confirm-modal orphan-server-modal" style={{ width: "min(580px, 94vw)", maxWidth: "94vw" }}>
        <header>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={18} style={{ color: "#f59e0b", flex: "none" }} />
            {t("orphan.title")}
          </h2>
          <button className="ghost-icon" aria-label={t("ariaClose")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="confirm-modal-body">
          <p className="orphan-desc-text">
            {isStartingService
              ? t("orphan.descLaunch", { pids: pidsText })
              : t("orphan.descStartup", { pids: pidsText })}
          </p>
          <div className="orphan-proc-list">
            {processes && processes.length > 0 ? (
              processes.map((proc) => (
                <div key={proc.pid} className="orphan-proc-card">
                  <div className="orphan-proc-head">
                    <div className="orphan-proc-meta">
                      <span className="orphan-proc-name">{proc.name}</span>
                      <span className="orphan-proc-pid">PID: {proc.pid}</span>
                    </div>
                    {proc.path && onAdoptPath && (
                      <button
                        className="secondary-button compact orphan-proc-adopt-btn"
                        onClick={() => onAdoptPath(proc.path!)}
                      >
                        {t("orphan.useAsServerPath")}
                      </button>
                    )}
                  </div>
                  {proc.path && (
                    <div className="orphan-proc-path" title={proc.path}>
                      {proc.path}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="orphan-proc-card">
                <div className="orphan-proc-head">
                  <div className="orphan-proc-meta">
                    <span className="orphan-proc-name">llama-server</span>
                    <span className="orphan-proc-pid">PID: {pidsText}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose}>
            {isStartingService ? t("cancel") : t("orphan.ignoreBtn")}
          </button>
          <button className="danger-button" onClick={onKill} autoFocus>
            {isStartingService ? t("orphan.killAndStartBtn") : t("orphan.killBtn")}
          </button>
        </footer>
      </div>
    </div>
  );
}
