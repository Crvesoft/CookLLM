import { Check, Loader2, Star, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { HfFile, ModelDownloadProgress } from "../../types";
import { cn, fileName, formatBytes, humanSpeed } from "../../utils";
import { quantBadge, vramTag } from "./modelUtils";

interface FileRowProps {
  file: HfFile;
  progress?: ModelDownloadProgress;
  disabled: boolean;
  queued: boolean;
  preferred?: boolean;
  onDownload: (file: HfFile) => void;
  onCancel?: (file: HfFile) => void;
}

function fileFormatBadge(name: string, t: ReturnType<typeof useI18n>["t"]) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".gguf")) {
    return {
      className: "gguf",
      text: "GGUF",
      title: t("models.formatGgufTitle"),
    };
  }
  if (lower.endsWith(".ninfer")) {
    return {
      className: "ninfer",
      text: "NINFER",
      title: t("models.formatNinferTitle"),
    };
  }
  if (lower.endsWith(".safetensors")) {
    return {
      className: "safetensors",
      text: "SAFE",
      title: "Safetensors 权重文件",
    };
  }
  const extMatch = lower.match(/\.([a-z0-9]{1,6})$/);
  const ext = extMatch ? extMatch[1].toUpperCase() : "FILE";
  return {
    className: "other",
    text: ext,
    title: `${ext} 文件`,
  };
}

export default function FileRow({ file, progress, disabled, queued, preferred, onDownload, onCancel }: FileRowProps) {
  const { t } = useI18n();
  const active = progress !== undefined && progress.phase !== "paused" && progress.phase !== "cancelled" && progress.phase !== "error";
  const quant = quantBadge(file.name);
  const speed = active ? humanSpeed(progress.speedBps) : "";
  const fmt = fileFormatBadge(file.name, t);

  return (
    <div className={cn("hf-file-row", preferred && "hf-file-row-preferred", active && "downloading")}>
      <div className="hf-file-main">
        {preferred && <Star size={12} className="hf-file-star" fill="currentColor" />}
        <span
          className={cn("hf-file-format-badge", fmt.className)}
          title={fmt.title}
        >
          {fmt.text}
        </span>
        {quant && <span className={cn("hf-quant-badge", preferred && "preferred")}>{quant}</span>}
        <span className="hf-file-quant" title={file.name}>{fileName(file.name)}</span>
      </div>
      <div className="hf-file-side">
        <span className="hf-file-size">{formatBytes(file.sizeBytes)}</span>
        {speed ? <span className="hf-file-speed">{speed}</span> : null}
        {(() => { const tag = vramTag(file, t); return tag ? <span className="hf-vram-tag">{tag}</span> : null; })()}
        {active ? (
          <button
            type="button"
            className="hf-download-btn downloading"
            title={t("explore.cancel")}
            onClick={() => onCancel?.(file)}
          >
            <span
              className="btn-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
            />
            <span className="btn-content-downloading">
              <Loader2 size={12} className="spin" />
              <em>{progress.percent}%</em>
            </span>
            <span className="btn-content-cancel">
              <X size={13} />
              <span>{t("explore.cancel")}</span>
            </span>
          </button>
        ) : queued ? (
          <button
            type="button"
            className="hf-download-btn queued"
            title={t("explore.cancel")}
            onClick={() => onCancel?.(file)}
          >
            <span className="btn-content-queued">
              <Check size={12} />
              <span>{t("explore.inQueue")}</span>
            </span>
            <span className="btn-content-cancel">
              <X size={13} />
              <span>{t("explore.cancel")}</span>
            </span>
          </button>
        ) : (
          <button className="hf-download-btn" disabled={disabled} onClick={() => onDownload(file)}>
            ⤓ {t("explore.downloadShort")}
          </button>
        )}
      </div>
    </div>
  );
}
