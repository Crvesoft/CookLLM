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
  GitBranch,
  Wrench,
  Loader2,
} from "lucide-react";
import type { LlamaEngine } from "../types";
import { useI18n } from "../i18n";
import type { EngineType } from "../types";
import { cn, formatEngineBackend, detectEngineType, getEngineTypeDisplay } from "../utils";
import {
  getLlamaCppStatus,
  pickServerDir,
  pickServerFile,
  revealInFolder,
  type LlamaCppLocalStatus,
  type ServerCandidate,
} from "../tauri";
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
  const [probing, setProbing] = useState(false);
  const [probeStatus, setProbeStatus] = useState<LlamaCppLocalStatus | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [dirCandidates, setDirCandidates] = useState<ServerCandidate[] | null>(null);

  // 打开弹窗瞬间重置选中项为活跃引擎，弹窗开启期间保持当前浏览选择
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setQuery("");
      setDirCandidates(null);
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
    return engines.filter((e) => {
      const typeInfo = getEngineTypeDisplay(e.engineType, e.path);
      return (
        e.name.toLowerCase().includes(q) ||
        e.path.toLowerCase().includes(q) ||
        (e.backend || "").toLowerCase().includes(q) ||
        (e.version || "").toLowerCase().includes(q) ||
        typeInfo.label.toLowerCase().includes(q)
      );
    });
  }, [engines, query]);

  // 选中的分支对象
  const selectedEngine = useMemo(() => {
    return engines.find((e) => e.id === selectedId) || engines[0];
  }, [engines, selectedId]);

  // 选中切换时同步到表单并探测；探测结果只用于展示，持久化仅由保存按钮触发
  useEffect(() => {
    if (selectedEngine) {
      setDraftName(selectedEngine.name);
      setDraftPath(selectedEngine.path);
      setSaveSuccess(false);
      setDirCandidates(null);

      if (selectedEngine.path) {
        setProbing(true);
        setProbeStatus(null);
        void getLlamaCppStatus(selectedEngine.path)
          .then((st) => setProbeStatus(st))
          .catch(() => setProbeStatus(null))
          .finally(() => setProbing(false));
      } else {
        setProbeStatus(null);
      }
    }
  }, [selectedEngine]);

  // 探测到的运行时元数据与已保存值不同：允许通过保存按钮显式更新
  const probeChanged = Boolean(
    selectedEngine &&
      probeStatus &&
      ((probeStatus.cudaVersion && probeStatus.cudaVersion !== selectedEngine.cudaVersion) ||
        (probeStatus.localVersion && probeStatus.localVersion !== selectedEngine.version) ||
        (probeStatus.engineType && probeStatus.engineType !== selectedEngine.engineType)),
  );

  // 检查是否有未保存修改
  const isModified = Boolean(
    selectedEngine &&
      (draftName.trim() !== selectedEngine.name ||
        draftPath.trim() !== selectedEngine.path ||
        probeChanged),
  );

  // 保存修改（引擎架构类型自动识别填充）
  const handleSave = () => {
    if (!selectedEngine || !draftPath.trim()) return;
    const inferredType = (probeStatus?.engineType as EngineType) || detectEngineType(draftPath.trim());
    const updated: LlamaEngine = {
      ...selectedEngine,
      name: draftName.trim() || selectedEngine.name,
      path: draftPath.trim(),
      cudaVersion: probeStatus?.cudaVersion || selectedEngine.cudaVersion,
      version: probeStatus?.localVersion || selectedEngine.version,
      engineType: inferredType,
    };
    onSaveEngine(updated);
    setDirCandidates(null);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 1800);
  };

  // 应用新的可执行文件路径并重新探测运行时信息
  const applyDraftPath = async (targetPath: string) => {
    setDraftPath(targetPath);
    setProbing(true);
    setProbeStatus(null);
    try {
      const st = await getLlamaCppStatus(targetPath);
      setProbeStatus(st);
    } catch {
      setProbeStatus(null);
    } finally {
      setProbing(false);
    }
  };

  // 选择目录并自动识别其中的 server 程序
  const handlePickDir = async () => {
    try {
      const result = await pickServerDir();
      if (result.status === "selected" && result.selectedPath) {
        setDirCandidates(null);
        await applyDraftPath(result.selectedPath);
      } else if (result.status === "multiple") {
        setDirCandidates(result.candidates);
        const first = result.candidates[0];
        if (first) await applyDraftPath(first.path);
      } else if (result.status === "none") {
        const manual = await pickServerFile();
        if (manual) {
          setDirCandidates(null);
          await applyDraftPath(manual);
        }
      }
    } catch {
      setProbing(false);
    }
  };

  // 浏览并更换服务端执行程序
  const handlePickFile = async () => {
    try {
      const manual = await pickServerFile();
      if (manual) {
        setDirCandidates(null);
        await applyDraftPath(manual);
      }
    } catch {
      setProbing(false);
    }
  };

  const handleSelectCandidate = (candidate: ServerCandidate) => {
    setDirCandidates(null);
    void applyDraftPath(candidate.path);
  };

  if (!open) return null;

  const isActive = selectedEngine?.id === activeEngineId;
  const hasDirCandidates = Boolean(dirCandidates && dirCandidates.length > 0);

  return (
    <div
      className="modal-backdrop engine-hub-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="engine-hub-modal" role="dialog" aria-modal="true">
        <header className="engine-hub-header">
          <div className="engine-hub-title-icon">
            <Cpu size={17} />
          </div>
          <div className="engine-hub-header-copy">
            <h2>{t("llama.hubTitle")}</h2>
          </div>
          <div className="engine-hub-header-actions">
            <button
              type="button"
              className="engine-hub-icon-button"
              aria-label={t("ariaClose")}
              title={t("ariaClose")}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="engine-hub-body">
          <aside className="engine-hub-card engine-hub-sidebar">
            <div className="engine-hub-card-head engine-hub-side-head">
              <div className="engine-hub-head-icon">
                <GitBranch size={15} />
              </div>
              <div className="engine-hub-head-copy">
                <h3>{t("llama.localBranches")}</h3>
              </div>
              <span className="engine-hub-count">{engines.length}</span>
            </div>

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
                      className={cn("engine-hub-branch-item", isCurSelected && "selected")}
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
                      <span
                        className={cn(
                          "engine-hub-tag backend",
                          (item.backend || "cuda").toLowerCase(),
                        )}
                      >
                        {formatEngineBackend(
                          item.backend,
                          item.id === selectedEngine?.id && probeStatus?.cudaVersion
                            ? probeStatus.cudaVersion
                            : item.cudaVersion,
                        )}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            <div className="engine-hub-sidebar-footer">
              <button type="button" className="engine-hub-add-btn" onClick={onOpenAddModal}>
                <Plus size={13} />
                <span>{t("llama.addBranch")}</span>
              </button>
            </div>
          </aside>

          <main className="engine-hub-main">
            {selectedEngine ? (
              <>
                <section className="engine-hub-card engine-hub-detail">
                  <div className="engine-hub-card-head engine-hub-detail-head">
                    <div className="engine-hub-engine-tile">
                      <Cpu size={16} />
                    </div>
                    <div className="engine-hub-identity">
                      <div className="engine-hub-identity-row">
                        <h3 title={selectedEngine.name}>{selectedEngine.name}</h3>
                        <span className={cn("engine-hub-status-pill", isActive ? "active" : "standby")}>
                          {isActive && <Check size={11} />}
                          <span>{isActive ? t("llama.activeBadge") : t("llama.standbyBadge")}</span>
                        </span>
                      </div>
                    </div>
                    <div className="engine-hub-detail-actions">
                      {!isActive && (
                        <button
                          type="button"
                          className="engine-hub-action-btn"
                          onClick={() => onSelectActiveEngine(selectedEngine)}
                        >
                          <Check size={12} />
                          <span>{t("llama.setActive")}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="engine-hub-action-btn"
                        onClick={() => void revealInFolder(selectedEngine.path)}
                      >
                        <FolderOpen size={13} />
                        <span>{t("llama.openFolder")}</span>
                      </button>
                      {engines.length > 1 && (
                        <button
                          type="button"
                          className="engine-hub-icon-button danger"
                          aria-label={t("llama.deleteBranch")}
                          title={t("llama.deleteBranch")}
                          onClick={() => setDeletingEngine(selectedEngine)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="engine-hub-rows">
                    <div className="engine-hub-row">
                      <label className="engine-hub-label" htmlFor="engine-hub-name">
                        {t("llama.branchName")}
                      </label>
                      <div className="engine-hub-control">
                        <input
                          id="engine-hub-name"
                          type="text"
                          className="engine-hub-input"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          placeholder={t("llama.branchNamePlaceholder")}
                        />
                      </div>
                    </div>

                    <div className="engine-hub-row">
                      <label className="engine-hub-label" htmlFor="engine-hub-path">
                        {t("llama.branchPath")}
                      </label>
                      <div className="engine-hub-control path">
                        <input
                          id="engine-hub-path"
                          type="text"
                          className="engine-hub-input monospace"
                          value={draftPath}
                          onChange={(e) => {
                            setDraftPath(e.target.value);
                            setDirCandidates(null);
                          }}
                          placeholder={t("llama.branchPathPlaceholder")}
                        />
                        <button
                          type="button"
                          className="engine-hub-action-btn engine-hub-browse-btn"
                          onClick={() => void handlePickDir()}
                          title={t("llama.pickDirTitle")}
                        >
                          <FolderOpen size={12} />
                          <span>{t("llama.pickDir")}</span>
                        </button>
                        <button
                          type="button"
                          className="engine-hub-action-btn engine-hub-browse-btn"
                          onClick={() => void handlePickFile()}
                        >
                          <FileCode size={12} />
                          <span>{t("llama.pickFile")}</span>
                        </button>
                      </div>
                    </div>

                    {hasDirCandidates && (
                      <div className="engine-hub-row">
                        <span className="engine-hub-label">{t("llama.candidateLabel")}</span>
                        <div className="engine-hub-control">
                          <div className="engine-hub-candidate-chips">
                            {dirCandidates!.map((candidate) => (
                              <button
                                key={candidate.path}
                                type="button"
                                className={cn(
                                  "engine-hub-candidate-chip",
                                  draftPath === candidate.path && "selected",
                                )}
                                title={candidate.path}
                                onClick={() => handleSelectCandidate(candidate)}
                              >
                                <FileCode size={12} />
                                <span>{candidate.name}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                  </div>

                  {!hasDirCandidates && (
                    <section className="engine-hub-meta">
                      <div className="engine-hub-card-head engine-hub-meta-head">
                        <div className="engine-hub-head-icon small">
                          <Wrench size={13} />
                        </div>
                        <div className="engine-hub-head-copy">
                          <h3>{t("llama.buildInfo")}</h3>
                        </div>
                        <span className="engine-hub-meta-note">
                          {probing ? <Loader2 size={12} className="spin" /> : t("llama.autoDetected")}
                        </span>
                      </div>
                      <div className="engine-hub-rows">
                        <div className="engine-hub-row">
                          <span className="engine-hub-label">{t("llama.engineType")}</span>
                          <div className="engine-hub-control">
                            <span className="engine-hub-type-badge">
                              {getEngineTypeDisplay(
                                probeStatus?.engineType || selectedEngine.engineType,
                                draftPath || selectedEngine.path,
                              ).label.toUpperCase()}
                            </span>
                          </div>
                        </div>
                        <div className="engine-hub-row">
                          <span className="engine-hub-label">{t("llama.branchVersion")}</span>
                          <div className="engine-hub-control">
                            <span className="engine-hub-meta-value">
                              {probeStatus?.localVersion || selectedEngine.version || "--"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </section>
                  )}

                  <div className="engine-hub-save-row">
                    {saveSuccess ? (
                      <span className="engine-hub-saved-hint">
                        <Check size={13} />
                        <span>{t("saved")}</span>
                      </span>
                    ) : isModified ? (
                      <span className="engine-hub-dirty-hint">
                        <span>{t("llama.unsavedChanges")}</span>
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="engine-hub-save-btn"
                      disabled={!isModified || !draftPath.trim()}
                      onClick={handleSave}
                    >
                      <Save size={13} />
                      <span>{t("save")}</span>
                    </button>
                  </div>
                </section>
              </>
            ) : (
              <div className="engine-hub-no-selection">
                <span>{t("llama.noBranchSelected")}</span>
              </div>
            )}
          </main>
        </div>
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
