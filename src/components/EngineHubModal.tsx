import { useState, useMemo, useEffect, useRef } from "react";
import {
  Cpu,
  Search,
  Check,
  Plus,
  FolderOpen,
  FileCode,
  Save,
  Trash2,
  X,
  Sparkles,
  Loader2,
} from "lucide-react";
import type { LlamaEngine } from "../types";
import { useI18n } from "../i18n";
import { cn, formatEngineBackend } from "../utils";
import { getLlamaCppStatus, pickServerFile, revealInFolder, type LlamaCppLocalStatus } from "../tauri";
import ConfirmModal from "./ConfirmModal";

interface EngineHubModalProps {
  open: boolean;
  onClose: () => void;
  activeEngineId: string | undefined;
  engines: LlamaEngine[];
  onSelectActiveEngine: (engine: LlamaEngine) => void;
  onSaveEngine: (engine: LlamaEngine) => void;
  onDeleteEngine: (engineId: string) => void;
  onOpenAddModal: () => void;
}

export default function EngineHubModal({
  open,
  onClose,
  activeEngineId,
  engines,
  onSelectActiveEngine,
  onSaveEngine,
  onDeleteEngine,
  onOpenAddModal,
}: EngineHubModalProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>(activeEngineId || engines[0]?.id || "");
  const [deletingEngine, setDeletingEngine] = useState<LlamaEngine | null>(null);

  // 详情编辑表单状态
  const [draftName, setDraftName] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [draftBackend, setDraftBackend] = useState("cuda");
  const [probing, setProbing] = useState(false);
  const [probeStatus, setProbeStatus] = useState<LlamaCppLocalStatus | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // 打开弹窗瞬间重置选中项为活跃引擎，弹窗开启期间保持当前浏览选择
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setQuery("");
      const initial = activeEngineId || engines[0]?.id || "";
      setSelectedId(initial);
    }
    prevOpenRef.current = open;
  }, [open, activeEngineId, engines]);

  // 全局 ESC 退出
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deletingEngine) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, deletingEngine]);

  // 过滤分支列表
  const filteredEngines = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return engines;
    return engines.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.path.toLowerCase().includes(q) ||
        (e.backend || "").toLowerCase().includes(q) ||
        (e.version || "").toLowerCase().includes(q),
    );
  }, [engines, query]);

  // 选中的分支对象
  const selectedEngine = useMemo(() => {
    return engines.find((e) => e.id === selectedId) || engines[0];
  }, [engines, selectedId]);

  // 选中切换时同步到表单
  useEffect(() => {
    if (selectedEngine) {
      setDraftName(selectedEngine.name);
      setDraftPath(selectedEngine.path);
      setDraftBackend(selectedEngine.backend || "cuda");
      setSaveSuccess(false);

      if (selectedEngine.path) {
        setProbing(true);
        void getLlamaCppStatus(selectedEngine.path)
          .then((st) => setProbeStatus(st))
          .catch(() => setProbeStatus(null))
          .finally(() => setProbing(false));
      } else {
        setProbeStatus(null);
      }
    }
  }, [selectedEngine]);

  // 检查是否有未保存修改
  const isModified = Boolean(
    selectedEngine &&
      (draftName.trim() !== selectedEngine.name ||
        draftPath.trim() !== selectedEngine.path ||
        draftBackend !== (selectedEngine.backend || "cuda")),
  );

  // 保存修改
  const handleSave = () => {
    if (!selectedEngine || !draftPath.trim()) return;
    const updated: LlamaEngine = {
      ...selectedEngine,
      name: draftName.trim() || selectedEngine.name,
      path: draftPath.trim(),
      backend: draftBackend,
      cudaVersion: draftBackend === "cuda" ? (probeStatus?.cudaVersion || selectedEngine.cudaVersion) : undefined,
      version: probeStatus?.localVersion || selectedEngine.version,
    };
    onSaveEngine(updated);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 1800);
  };

  // 浏览并更换服务端执行程序
  const handlePickFile = async () => {
    try {
      const manual = await pickServerFile();
      if (manual) {
        setDraftPath(manual);
        setProbing(true);
        const st = await getLlamaCppStatus(manual);
        setProbeStatus(st);
        if (st?.localBackend) setDraftBackend(st.localBackend);
        setProbing(false);
      }
    } catch {
      setProbing(false);
    }
  };

  if (!open) return null;

  const isActive = selectedEngine?.id === activeEngineId;

  return (
    <div
      className="modal-backdrop engine-hub-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="engine-hub-modal" role="dialog" aria-modal="true">
        {/* 顶部标题栏 */}
        <header className="engine-hub-header">
          <div className="engine-hub-header-title">
            <Cpu size={18} className="engine-hub-header-icon" />
            <h2>{t("llama.hubTitle")}</h2>
          </div>
          <button
            type="button"
            className="ghost-icon compact"
            aria-label={t("ariaClose")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {/* 双栏主体架构 */}
        <div className="engine-hub-body">
          {/* 左侧 Master 列表栏 */}
          <aside className="engine-hub-sidebar">
            <div className="engine-hub-search-wrap">
              <Search size={13} className="engine-hub-search-icon" />
              <input
                type="text"
                className="engine-hub-search-input"
                placeholder={t("llama.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="engine-hub-branch-list">
              {filteredEngines.length === 0 ? (
                <div className="engine-hub-empty">
                  <span>{t("llama.noMatchingBranches")}</span>
                </div>
              ) : (
                filteredEngines.map((item) => {
                  const isCurActive = item.id === activeEngineId;
                  const isCurSelected = item.id === selectedEngine?.id;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "engine-hub-branch-item",
                        isCurSelected && "selected",
                        isCurActive && "is-active",
                      )}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div className="engine-hub-item-left">
                        <span className="engine-hub-status-dot">
                          {isCurActive ? (
                            <Check size={13} className="engine-hub-check-active" />
                          ) : (
                            <span className="engine-hub-check-placeholder" />
                          )}
                        </span>
                        <span className="engine-hub-item-name" title={item.name}>
                          {item.name}
                        </span>
                      </div>
                      <div className="engine-hub-item-right">
                        <span
                          className={cn(
                            "engine-hub-tag backend",
                            (item.backend || "cuda").toLowerCase(),
                          )}
                        >
                          {formatEngineBackend(
                            item.backend,
                            item.cudaVersion || (item.id === selectedEngine?.id ? probeStatus?.cudaVersion : undefined),
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="engine-hub-sidebar-footer">
              <button
                type="button"
                className="secondary-button compact engine-hub-add-btn"
                onClick={onOpenAddModal}
              >
                <Plus size={13} />
                <span>{t("llama.addBranch")}</span>
              </button>
            </div>
          </aside>

          {/* 右侧 Detail 详情工作台 */}
          <main className="engine-hub-detail">
            {selectedEngine ? (
              <div className="engine-hub-detail-inner">
                {/* 详情顶栏标题与操作（统一UI风格，固定高度单行不换行） */}
                <div className="engine-hub-detail-top">
                  <div className="engine-hub-detail-identity">
                    <h3 title={selectedEngine.name}>{selectedEngine.name}</h3>
                    {isActive ? (
                      <span className="engine-hub-status-pill active">
                        <Check size={11} />
                        <span>{t("llama.activeBadge")}</span>
                      </span>
                    ) : (
                      <span className="engine-hub-status-pill standby">
                        <span>{t("llama.standbyBadge")}</span>
                      </span>
                    )}
                  </div>

                  <div className="engine-hub-detail-actions">
                    {!isActive && (
                      <button
                        type="button"
                        className="secondary-button compact engine-activate-btn"
                        onClick={() => onSelectActiveEngine(selectedEngine)}
                        title={t("llama.setActive")}
                      >
                        <Check size={12} />
                        <span>{t("llama.setActive")}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button compact"
                      title={t("llama.openFolder")}
                      onClick={() => void revealInFolder(selectedEngine.path)}
                    >
                      <FolderOpen size={13} />
                      <span>{t("llama.openFolder")}</span>
                    </button>
                    {engines.length > 1 && (
                      <button
                        type="button"
                        className="ghost-icon compact danger"
                        title={t("llama.deleteBranch")}
                        onClick={() => setDeletingEngine(selectedEngine)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* 字段 1：分支名称 */}
                <div className="engine-hub-field">
                  <label className="engine-hub-label">{t("llama.branchName")}</label>
                  <input
                    type="text"
                    className="engine-hub-input"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder={t("llama.branchNamePlaceholder")}
                  />
                </div>

                {/* 字段 2：服务端可执行文件路径 */}
                <div className="engine-hub-field">
                  <div className="engine-hub-label-row">
                    <label className="engine-hub-label">{t("llama.branchPath")}</label>
                    <button
                      type="button"
                      className="engine-hub-link-btn"
                      onClick={() => void handlePickFile()}
                    >
                      <FileCode size={12} />
                      <span>{t("llama.pickFile")}</span>
                    </button>
                  </div>
                  <input
                    type="text"
                    className="engine-hub-input monospace"
                    value={draftPath}
                    onChange={(e) => setDraftPath(e.target.value)}
                    placeholder="C:\llama.cpp\llama-server.exe"
                  />
                </div>

                {/* 字段 3：计算后端与状态检测 */}
                <div className="engine-hub-grid-row">
                  <div className="engine-hub-field">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label className="engine-hub-label">{t("llama.branchBackend")}</label>
                      {draftBackend === "cuda" && (probeStatus?.cudaVersion || selectedEngine.cudaVersion) && (
                        <span className="engine-pill-tag backend" style={{ padding: "1px 6px", fontSize: 10 }}>
                          {formatEngineBackend("cuda", probeStatus?.cudaVersion || selectedEngine.cudaVersion)}
                        </span>
                      )}
                    </div>
                    <select
                      className="engine-hub-select"
                      value={draftBackend}
                      onChange={(e) => setDraftBackend(e.target.value)}
                    >
                      <option value="cuda">CUDA (NVIDIA)</option>
                      <option value="vulkan">Vulkan (AMD / Intel / Multi-GPU)</option>
                      <option value="cpu">CPU (Generic)</option>
                    </select>
                  </div>

                  <div className="engine-hub-field">
                    <label className="engine-hub-label">{t("llama.branchVersion")}</label>
                    <div className="engine-hub-version-box">
                      <span className="engine-hub-version-tag">
                        {probeStatus?.localVersion || selectedEngine.version || "--"}
                      </span>
                      {probing && <Loader2 size={12} className="spin" />}
                    </div>
                  </div>
                </div>

                {/* 底部保存条 */}
                <div className="engine-hub-save-row">
                  {saveSuccess && (
                    <span className="engine-hub-saved-hint">
                      <Check size={13} /> {t("saved")}
                    </span>
                  )}
                  <button
                    type="button"
                    className="secondary-button compact engine-hub-save-btn"
                    disabled={!isModified || !draftPath.trim()}
                    onClick={handleSave}
                  >
                    <Save size={13} />
                    <span>{t("save")}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="engine-hub-no-selection">
                <span>{t("llama.noBranchSelected")}</span>
              </div>
            )}
          </main>
        </div>

        {/* 弹窗底栏说明与关闭按钮 */}
        <footer className="engine-hub-footer">
          <div className="engine-hub-footer-hint">
            <Sparkles size={13} />
            <span>{t("llama.presetEngineHint")}</span>
          </div>
          <button type="button" className="secondary-button compact" onClick={onClose}>
            {t("close")} (ESC)
          </button>
        </footer>
      </div>

      {/* 删除分支二次确认弹窗 */}
      {deletingEngine && (
        <ConfirmModal
          title={t("llama.deleteBranch")}
          description={t("llama.deleteBranchConfirm", { name: deletingEngine.name })}
          confirmLabel={t("confirmDeleteLabel")}
          onConfirm={() => {
            onDeleteEngine(deletingEngine.id);
            setDeletingEngine(null);
          }}
          onClose={() => setDeletingEngine(null)}
        />
      )}
    </div>
  );
}
