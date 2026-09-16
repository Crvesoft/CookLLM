import { useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useI18n } from "../i18n";

interface Props {
  pids: number[];
  isStartingService?: boolean;
  onKill: () => void;
  onClose: () => void;
}

/** 检测到后台遗留未退出的 llama-server 进程时的极简提醒弹窗 */
export default function OrphanServerModal({ pids, isStartingService, onKill, onClose }: Props) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pidsText = pids.join(", ");

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="confirm-modal orphan-server-modal">
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
          <p style={{ margin: 0, lineHeight: 1.65 }}>
            {isStartingService
              ? t("orphan.descLaunch", { pids: pidsText })
              : t("orphan.descStartup", { pids: pidsText })}
          </p>
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11.5, padding: "2px 7px", borderRadius: 4, background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b", fontFamily: "JetBrains Mono, monospace", fontWeight: 600 }}>
              llama-server
            </span>
            <span style={{ fontSize: 11.5, color: "#8892a4", fontFamily: "JetBrains Mono, monospace" }}>
              PID: {pidsText}
            </span>
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
