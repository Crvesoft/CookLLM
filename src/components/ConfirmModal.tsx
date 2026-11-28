import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n";

interface Props {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** 批量删除等破坏性操作的二次确认弹窗 */
export default function ConfirmModal({ title, description, confirmLabel, confirmDisabled, onConfirm, onClose }: Props) {
  const { t } = useI18n();
  /** Esc 关闭，与导入弹窗一致 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !confirmDisabled) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDisabled, onClose]);

  return <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && !confirmDisabled && onClose()}>
    <div className="confirm-modal">
      <header><h2>{title}</h2><button className="ghost-icon" aria-label={t("ariaClose")} disabled={confirmDisabled} onClick={onClose}><X size={18} /></button></header>
      <div className="confirm-modal-body">{description}</div>
      <footer><button className="secondary-button" disabled={confirmDisabled} onClick={onClose}>{t("cancel")}</button><button className="danger-button" disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel ?? t("confirmDeleteLabel")}</button></footer>
    </div>
  </div>;
}
