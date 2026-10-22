import { AlertCircle, ExternalLink, KeyRound, Play, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { openExternal } from "../../tauri";
import type { ActiveDownload } from "../../types";
import { hfLicenseUrl } from "./modelUtils";
import { openTaskSource, TaskSourcePill } from "./TaskSourcePill";

interface Props {
  item: ActiveDownload;
  batchMode: boolean;
  selected: boolean;
  onToggleSelect: (taskId: string) => void;
  onRetry: (task: ActiveDownload) => void;
  onGoSettings: () => void;
  onDelete: (task: ActiveDownload) => void;
}

export default function TaskCardFailed({ item, batchMode, selected, onToggleSelect, onRetry, onGoSettings, onDelete }: Props) {
  const { t } = useI18n();
  const openLabel = item.errorKind === "no-permission"
    ? t("st.hfGatedNoPermission")
    : (item.source === "ms" ? t("explore.openOnMs") : t("explore.openOnHf"));

  return (
    <div className="task-card task-card-error">
      <div className="task-card-head">
        {batchMode && (
          <label className="task-card-check" title={t("explore.selectTask")}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(item.taskId)}
            />
          </label>
        )}
        <span className="task-file-icon err"><AlertCircle size={16} /></span>
        <div className="task-file-info">
          <div className="task-file-title-row">
            <strong>{item.file}</strong>
            <TaskSourcePill item={item} />
          </div>
          <span className="task-status-text">
            {item.errorKind === "needs-token" ? t("explore.statusUnauthorized")
              : item.errorKind === "no-permission" ? t("explore.statusNoPermission")
                : item.error || (item.status === "cancelled" ? t("explore.statusPaused") : t("explore.statusError"))}
          </span>
        </div>
        <div className="task-card-actions task-active-actions">
          {item.errorKind === "needs-token" && (
            <button
              type="button"
              className="task-circle-btn accent"
              title={t("st.hfGatedNeedToken")}
              aria-label={t("st.hfGatedNeedToken")}
              onClick={onGoSettings}
            >
              <KeyRound size={15} />
            </button>
          )}
          <button
            type="button"
            className="task-circle-btn"
            title={t("explore.resume")}
            aria-label={t("explore.resume")}
            onClick={() => onRetry(item)}
          >
            <Play size={15} />
          </button>
          {(item.repo !== "direct-url" || item.url) && (
            <button
              type="button"
              className="task-circle-btn"
              title={openLabel}
              aria-label={openLabel}
              onClick={() => {
                if (item.errorKind === "no-permission" && item.repo) {
                  void openExternal(hfLicenseUrl(item.repo));
                } else {
                  openTaskSource(item);
                }
              }}
            >
              <ExternalLink size={15} />
            </button>
          )}
          <button
            type="button"
            className="task-circle-btn danger"
            title={t("explore.delete")}
            aria-label={t("explore.delete")}
            onClick={() => onDelete(item)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
