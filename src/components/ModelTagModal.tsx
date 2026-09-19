import { useState, useEffect, type KeyboardEvent } from "react";
import { Tag, Plus, X, Save, Check, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { ModelAsset } from "../types";
import { modelTitle } from "../utils";
import { DEFAULT_TAG_POOL_ZH, DEFAULT_TAG_POOL_EN } from "../data";

interface Props {
  model: ModelAsset;
  tagPool?: string[];
  onSave: (quantization: string, assignedTags: string[], nextTagPool: string[]) => void;
  onClose: () => void;
}

const COMMON_QUANTS = [
  "Q4_K_M",
  "Q5_K_M",
  "Q8_0",
  "Q4_0",
  "IQ4_XS",
  "3.7bpw",
  "4.0bpw",
  "F16",
  "BF16",
];

export default function ModelTagModal({ model, tagPool: initialPool, onSave, onClose }: Props) {
  const { t, locale } = useI18n();
  const defaultPool = locale === "en" ? DEFAULT_TAG_POOL_EN : DEFAULT_TAG_POOL_ZH;

  const [quant, setQuant] = useState(
    model.quantization === t("model.unknownQuant") ? "" : model.quantization
  );
  const [assignedTags, setAssignedTags] = useState<string[]>(model.tags ? [...model.tags] : []);

  // 包含内置预设与用户全局自定义的标签池，自动合并当前模型已有的 tags
  const [pool, setPool] = useState<string[]>(() => {
    const base = initialPool && initialPool.length > 0 ? initialPool : defaultPool;
    const combined = Array.from(new Set([...base, ...(model.tags || [])]));
    return combined;
  });

  const [newTagInput, setNewTagInput] = useState("");

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 新建标签并直接关联至当前模型
  const handleCreateTag = () => {
    const trimmed = newTagInput.trim();
    if (!trimmed) return;
    if (!pool.includes(trimmed)) {
      setPool([...pool, trimmed]);
    }
    if (!assignedTags.includes(trimmed)) {
      setAssignedTags([...assignedTags, trimmed]);
    }
    setNewTagInput("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCreateTag();
    }
  };

  // 为当前模型解绑标签
  const handleUnassignTag = (tagToRemove: string) => {
    setAssignedTags(assignedTags.filter((t) => t !== tagToRemove));
  };

  // 点击标签库中的标签，切换绑定状态
  const handleToggleTag = (tag: string) => {
    if (assignedTags.includes(tag)) {
      setAssignedTags(assignedTags.filter((t) => t !== tag));
    } else {
      setAssignedTags([...assignedTags, tag]);
    }
  };

  // 从全局标签库中彻底删除标签
  const handleDeleteFromPool = (tagToDelete: string) => {
    setPool(pool.filter((t) => t !== tagToDelete));
    setAssignedTags(assignedTags.filter((t) => t !== tagToDelete));
  };

  const handleSave = () => {
    onSave(quant.trim() || t("model.unknownQuant"), assignedTags, pool);
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 1100 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="confirm-modal tag-manager-modal" style={{ width: 520, maxWidth: "92vw" }}>
        <header>
          <div className="tag-modal-title-wrap">
            <div className="tag-modal-icon">
              <Tag size={18} />
            </div>
            <div>
              <h2>{t("tagModal.title")}</h2>
              <span className="tag-modal-subtitle">{modelTitle(model)}</span>
            </div>
          </div>
          <button className="ghost-icon" aria-label={t("ariaClose")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="tag-modal-body">
          {/* Section 1: 量化信息 */}
          <div className="tag-modal-section">
            <div className="tag-section-head">
              <label>{t("tagModal.quantLabel")}</label>
              <span className="tag-section-hint">{t("tagModal.quantHint")}</span>
            </div>
            <div className="tag-quant-input-row">
              <input
                type="text"
                value={quant}
                onChange={(e) => setQuant(e.target.value)}
                placeholder={t("model.unknownQuant")}
                className="tag-main-input"
              />
            </div>
            <div className="tag-chips-row">
              {COMMON_QUANTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`tag-chip-btn ${quant.toUpperCase() === q.toUpperCase() ? "active" : ""}`}
                  onClick={() => setQuant(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Section 2: 当前模型已绑定标签 */}
          <div className="tag-modal-section">
            <div className="tag-section-head">
              <div className="section-label-with-count">
                <label>{t("tagModal.assignedTagsLabel")}</label>
                {assignedTags.length > 0 && (
                  <span className="count-pill">{assignedTags.length}</span>
                )}
              </div>
              <span className="tag-section-hint">{t("tagModal.assignedTagsHint")}</span>
            </div>

            <div className="active-tags-cloud">
              {assignedTags.length > 0 ? (
                assignedTags.map((tag) => (
                  <span key={tag} className="tag-badge">
                    <span>{tag}</span>
                    <button
                      type="button"
                      aria-label="Remove tag from model"
                      title={t("tagModal.assignedTagsHint")}
                      onClick={() => handleUnassignTag(tag)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))
              ) : (
                <span className="tag-empty-tip">{t("tagModal.emptyAssigned")}</span>
              )}
            </div>
          </div>

          {/* Section 3: 全局标签库管理（新增 / 删除 / 快速关联） */}
          <div className="tag-modal-section">
            <div className="tag-section-head">
              <label>{t("tagModal.poolLabel")}</label>
              <span className="tag-section-hint">{t("tagModal.poolHint")}</span>
            </div>

            {/* 新增标签行 */}
            <div className="tag-input-row">
              <input
                type="text"
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("tagModal.createPlaceholder")}
                className="tag-main-input"
              />
              <button
                type="button"
                className="secondary-button tag-add-btn"
                onClick={handleCreateTag}
                disabled={!newTagInput.trim()}
              >
                <Plus size={14} />
                <span>{t("tagModal.createBtn")}</span>
              </button>
            </div>

            {/* 标签池列表 */}
            <div className="pool-tags-cloud">
              {pool.map((tag) => {
                const isAssigned = assignedTags.includes(tag);
                return (
                  <div
                    key={tag}
                    className={`pool-tag-item ${isAssigned ? "assigned" : ""}`}
                    onClick={() => handleToggleTag(tag)}
                  >
                    <span className="pool-tag-status-icon">
                      {isAssigned ? <Check size={11} strokeWidth={2.5} /> : <Plus size={11} />}
                    </span>
                    <span className="pool-tag-name">{tag}</span>
                    <button
                      type="button"
                      className="pool-tag-delete-btn"
                      title={t("tagModal.deleteTagTooltip")}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteFromPool(tag);
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="button" className="primary-button" onClick={handleSave}>
            <Save size={15} />
            <span>{t("save")}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
