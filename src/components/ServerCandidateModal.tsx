import { useEffect } from "react";
import { Cpu, FileCode, FolderOpen, X } from "lucide-react";
import { useI18n } from "../i18n";
import { formatBytes } from "../utils";
import type { ServerCandidate } from "../tauri";

interface Props {
  candidates: ServerCandidate[];
  onSelect: (candidate: ServerCandidate) => void;
  onPickManualFile: () => void;
  onClose: () => void;
}

/** 检测到所选目录内有多个可用 server 程序时的候选选择弹窗 */
export default function ServerCandidateModal({ candidates, onSelect, onPickManualFile, onClose }: Props) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="confirm-modal" style={{ maxWidth: 540 }}>
        <header>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cpu size={18} style={{ color: "#dd8239", flex: "none" }} />
            {t("llama.candidateModalTitle")}
          </h2>
          <button className="ghost-icon" aria-label={t("ariaClose")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="confirm-modal-body">
          <p style={{ margin: 0, lineHeight: 1.65, fontSize: 13, color: "#8a94a6" }}>
            {t("llama.candidateModalDesc")}
          </p>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 280, overflowY: "auto" }}>
            {candidates.map((cand) => (
              <div
                key={cand.path}
                onClick={() => onSelect(cand)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  background: "rgba(255, 255, 255, 0.04)",
                  border: "1px solid rgba(255, 255, 255, 0.08)",
                  borderRadius: 8,
                  cursor: "pointer",
                  transition: "all .15s",
                }}
                className="candidate-item"
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <FileCode size={15} style={{ color: "#dd8239", flex: "none" }} />
                    <span style={{ fontWeight: 600, fontSize: 13, color: "#e5e7eb", fontFamily: "JetBrains Mono, monospace" }}>
                      {cand.name}
                    </span>
                    {cand.sizeBytes > 0 && (
                      <span style={{ fontSize: 11, color: "#6b7280" }}>
                        {formatBytes(cand.sizeBytes)}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11.5, color: "#9ca3af", fontFamily: "JetBrains Mono, monospace", wordBreak: "break-all" }}>
                    {cand.relPath}
                  </span>
                </div>
                <button
                  className="primary-button compact"
                  style={{ flex: "none", marginLeft: 12, height: 26, fontSize: 11.5 }}
                >
                  {t("select")}
                </button>
              </div>
            ))}
          </div>
        </div>
        <footer>
          <button className="secondary-button" onClick={onPickManualFile}>
            <FolderOpen size={14} />
            {t("llama.candidateManualFile")}
          </button>
          <button className="secondary-button" onClick={onClose}>
            {t("cancel")}
          </button>
        </footer>
      </div>
    </div>
  );
}
