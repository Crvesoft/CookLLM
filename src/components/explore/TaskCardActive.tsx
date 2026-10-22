import { ArrowDown, Clock, Database, ExternalLink, FileText, Pause, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import type { ActiveDownload, ModelDownloadProgress } from "../../types";
import { formatBytes, humanSpeed } from "../../utils";
import { openTaskSource, TaskSourcePill } from "./TaskSourcePill";

interface Props {
  item: ActiveDownload;
  progress?: ModelDownloadProgress;
  batchMode: boolean;
  selected: boolean;
  onToggleSelect: (taskId: string) => void;
  onPause: (task: ActiveDownload) => void;
  onDelete: (task: ActiveDownload) => void;
}

export default function TaskCardActive({ item, progress, batchMode, selected, onToggleSelect, onPause, onDelete }: Props) {
  const { t } = useI18n();
  const percent = progress?.percent ?? item.percent ?? 0;
  const downloaded = progress?.downloaded ?? item.downloaded ?? 0;
  const total = progress?.total ?? item.total ?? item.sizeBytes ?? 0;
  const speed = progress?.speedBps ?? item.speedBps ?? 0;
  const etaSeconds = speed > 0 && total > downloaded ? Math.ceil((total - downloaded) / speed) : 0;
  let eta = "--:--";
  if (etaSeconds > 0) {
    const hours = Math.floor(etaSeconds / 3600);
    const mins = Math.floor((etaSeconds % 3600) / 60);
    const secs = etaSeconds % 60;
    eta = hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  const percentFormatted = typeof percent === "number"
    ? (percent % 1 === 0 ? String(percent) : percent.toFixed(1))
    : "0";

  return (
    <div className="task-card task-card-active">
      {/* 底层融合淡色半透进度条 */}
      <div
        className="task-card-bg-progress"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />

      {/* 卡片主内容（处于上层，不受半透背景干扰） */}
      <div className="task-card-active-content">
        {/* 1. 左侧文件信息与多选 */}
        <div className="task-active-left">
          {batchMode && (
            <label className="task-card-check" title={t("explore.selectTask")}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelect(item.taskId)}
              />
            </label>
          )}
          <span className="task-file-icon dl">
            <Database size={16} />
          </span>
          <div className="task-file-info">
            <div className="task-file-title-row">
              <strong className="task-active-filename" title={item.file}>{item.file}</strong>
              <TaskSourcePill item={item} />
            </div>
            <div className="task-active-meta">
              <span className="task-active-size">
                <FileText size={12} className="task-meta-icon" />
                <span>{formatBytes(downloaded)} / {formatBytes(total)}</span>
              </span>
            </div>
          </div>
        </div>

        {/* 竖线分割 */}
        <div className="task-stat-divider" />

        {/* 2. 当前速度列 */}
        <div className="task-stat-col col-speed">
          <div className="task-stat-val task-stat-speed">
            <ArrowDown size={14} className="task-speed-arrow" />
            <span>{humanSpeed(speed) || "0 KB/s"}</span>
          </div>
        </div>

        {/* 竖线分割 */}
        <div className="task-stat-divider" />

        {/* 3. 百分比完成度列 */}
        <div className="task-stat-col col-percent">
          <div className="task-stat-val task-stat-percent">
            <span>{percentFormatted}%</span>
          </div>
        </div>

        {/* 竖线分割 */}
        <div className="task-stat-divider" />

        {/* 4. 预计剩余时间列 */}
        <div className="task-stat-col col-eta">
          <div className="task-stat-val task-stat-eta">
            <Clock size={13} className="task-eta-clock" />
            <span>{eta !== "--:--" ? t("explore.statEtaVal", { eta }) : "--:--"}</span>
          </div>
        </div>

        {/* 5. 右侧操作按钮组 */}
        <div className="task-active-actions">
          <button
            type="button"
            className="task-circle-btn"
            title={t("explore.pause")}
            aria-label={t("explore.pause")}
            onClick={() => onPause(item)}
          >
            <Pause size={15} />
          </button>
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
            title={t("explore.cancelDelete")}
            aria-label={t("explore.cancelDelete")}
            onClick={() => onDelete(item)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
