import { Check, ExternalLink, FolderOpen, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import type { ActiveDownload } from "../../types";
import { openTaskSource, TaskSourcePill } from "./TaskSourcePill";

interface Props {
  item: ActiveDownload;
  batchMode: boolean;
  selected: boolean;
  onToggleSelect: (taskId: string) => void;
  onReveal: (path: string) => Promise<void>;
  onDelete: (task: ActiveDownload) => void;
}

export default function TaskCardDone({ item, batchMode, selected, onToggleSelect, onReveal, onDelete }: Props) {
  const { t } = useI18n();
  return (
    <div className="task-card task-card-done">
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
        <span className="task-file-icon ok"><Check size={16} /></span>
        <div className="task-file-info">
          <div className="task-file-title-row">
            <strong>{item.file}</strong>
            <TaskSourcePill item={item} />
          </div>
          <span>{t("explore.syncedToLibrary")}</span>
        </div>
        <div className="task-card-actions task-active-actions">
          {item.finishedAt ? <span className="task-done-time">{new Date(item.finishedAt).toLocaleString()}</span> : null}
          {item.path && (
            <button
              type="button"
              className="task-circle-btn"
              title={t("explore.openFolder")}
              aria-label={t("explore.openFolder")}
              onClick={() => void onReveal(item.path!)}
            >
              <FolderOpen size={15} />
            </button>
          )}
          {(item.repo !== "direct-url" || item.url) && (
            <button
              type="button"
              className="task-circle-btn"
              title={item.source === "ms" ? t("explore.openOnMs") : t("explore.openOnHf")}
              aria-label={item.source === "ms" ? t("explore.openOnMs") : t("explore.openOnHf")}
              onClick={() => openTaskSource(item)}
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
