import { ExternalLink, FolderOpen, Loader2, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useI18n } from "../../i18n";
import type { DiskUsage, HfFile, HfModel, ModelDownloadProgress } from "../../types";
import { formatBytes } from "../../utils";
import FileRow from "./FileRow";
import { openHf, openMs, quantBitsOfFile } from "./modelUtils";

interface FileModalProps {
  model: HfModel;
  files: HfFile[] | null;
  filesLoading: boolean;
  filesError: string | null;
  preferredBits: number[] | null;
  diskUsage: DiskUsage | null;
  progressMap: Record<string, ModelDownloadProgress>;
  queuedKeys: Set<string>;
  onDownloadFile: (file: HfFile) => void;
  onCancelDownloadFile?: (file: HfFile) => void;
  onPickModelsDir: () => Promise<void>;
  onClose: () => void;
}

/** 通用文件下载弹窗：热门卡 / 模型列表共用，页面不滚动、卡片不内嵌展开 */
export default function FileModal({ model, files, filesLoading, filesError, preferredBits, diskUsage, progressMap, queuedKeys, onDownloadFile, onCancelDownloadFile, onPickModelsDir, onClose }: FileModalProps) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  /** 偏好量化置顶：匹配行排最前并高亮，其余按文件名保持稳定 */
  const isPreferredFile = (name: string) => preferredBits != null && preferredBits.length > 0 && preferredBits.includes(quantBitsOfFile(name) ?? -1);
  const ordered = useMemo(() => {
    if (!preferredBits || preferredBits.length === 0 || !files) return files;
    const copy = [...files];
    copy.sort((a, b) => {
      const am = isPreferredFile(a.name) ? 0 : 1;
      const bm = isPreferredFile(b.name) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
    return copy;
  }, [files, preferredBits]);
  return (
    <div className="file-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="file-modal">
        <header>
          <div className="file-modal-head">
            <div className="file-modal-title">
              <strong title={model.id}>{model.id}</strong>
              <button
                className="hf-model-link"
                type="button"
                title={model.source === "ms" ? t("explore.openOnMs") : t("explore.openOnHf")}
                aria-label={model.source === "ms" ? t("explore.openOnMs") : t("explore.openOnHf")}
                onClick={() => {
                  if (model.source === "ms") openMs(model.id);
                  else openHf(model.id);
                }}
              >
                <ExternalLink size={14} />
              </button>
            </div>
            <span>⭐ {model.likes.toLocaleString()} · ⬇ {model.downloads.toLocaleString()} · {t("explore.fileCount", { count: files !== null ? files.length : (model.ggufCount >= 0 ? model.ggufCount : "—") })}</span>
          </div>
          <button className="ghost-icon" title={t("ariaClose")} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="file-modal-path">
          <span title={diskUsage?.path ?? t("explore.storageDir")}><FolderOpen size={14} />{diskUsage?.path ?? t("explore.storageDir")}{diskUsage ? " · " + t("explore.storageFree", { free: formatBytes(diskUsage.freeBytes) }) : ""}</span>
          <button className="secondary-button compact" onClick={() => void onPickModelsDir()}><FolderOpen size={13} />{t("explore.changeDir")}</button>
        </div>
        <div className="file-modal-body">
          {filesLoading && <span className="hf-files-hint"><Loader2 size={13} className="spin" />{t("explore.loading")}</span>}
          {filesError && <span className="hf-files-hint err">{filesError}</span>}
          {!filesLoading && !filesError && ordered !== null && (
            ordered.length === 0
              ? <span className="hf-files-hint">{t("explore.emptyFiles")}</span>
              : (
                <div className="hf-files-list">
                  {ordered.map((file) => (
                    <FileRow key={file.name} file={file} disabled={false} preferred={isPreferredFile(file.name)} queued={queuedKeys.has(model.id + "::" + file.name)} progress={progressMap[model.id + "::" + file.name]} onDownload={onDownloadFile} onCancel={onCancelDownloadFile} />
                  ))}
                </div>
              )
          )}
        </div>
        <footer>
          <button className="secondary-button compact" onClick={onClose}>{t("ariaClose")}</button>
        </footer>
      </section>
    </div>
  );
}
