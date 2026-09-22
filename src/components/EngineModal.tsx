import { useState, useEffect, useRef } from "react";
import { Cpu, FolderOpen, FileCode, Save, X, Loader2, Check, AlertTriangle, Sparkles } from "lucide-react";
import { useI18n } from "../i18n";
import { uid } from "../data";
import { getLlamaCppStatus, pickServerDir, pickServerFile, type LlamaCppLocalStatus, type ServerCandidate } from "../tauri";
import type { LlamaEngine } from "../types";
import { cn, formatBytes } from "../utils";

interface Props {
  engine?: LlamaEngine | null;
  isDefault?: boolean;
  onSave: (engine: LlamaEngine, setAsActive: boolean) => void;
  onClose: () => void;
}

/** 从完整路径与程序名推导友好的默认分支名称 */
function inferBranchName(filePath: string, fileName?: string): string {
  if (!filePath.trim()) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const rawExe = (fileName || parts[parts.length - 1] || "").replace(/\.exe$/i, "");

  // 若为专用定制或分支编译产物（如 llama-kvmem-server / kvmem-server）
  const lower = rawExe.toLowerCase();
  if (lower && lower !== "llama-server" && lower !== "server") {
    if (lower.includes("kvmem")) return "KVMem";
    if (lower.includes("vulkan")) return "Vulkan";
    if (lower.includes("cuda")) return "CUDA";
    return rawExe.replace(/^llama[-_]?/i, "").replace(/[-_]server$/i, "") || rawExe;
  }

  // 若父级目录是通用的 bin / build / Release 等编译目录，回溯到其上级目录
  if (parts.length >= 2) {
    let parent = parts[parts.length - 2];
    const parentLower = parent.toLowerCase();
    if ((parentLower === "bin" || parentLower === "build" || parentLower === "release" || parentLower === "debug") && parts.length >= 3) {
      parent = parts[parts.length - 3];
    }
    if (parent && !parent.includes(":")) return parent;
  }
  const last = parts[parts.length - 1] || "";
  return last.replace(/\.exe$/i, "") || "llama.cpp";
}

export default function EngineModal({ engine, isDefault = false, onSave, onClose }: Props) {
  const { t } = useI18n();
  const isEditing = Boolean(engine);

  const [name, setName] = useState(engine?.name ?? "");
  const [path, setPath] = useState(engine?.path ?? "");
  const [backend, setBackend] = useState<string>(engine?.backend ?? "cuda");
  const [version, setVersion] = useState<string>(engine?.version ?? "");
  const [setAsActive, setSetAsActive] = useState<boolean>(isDefault);

  const [detecting, setDetecting] = useState(false);
  const [candidateList, setCandidateList] = useState<ServerCandidate[] | null>(null);
  const [detectionStatus, setDetectionStatus] = useState<LlamaCppLocalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const detectTimer = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const probePath = async (targetPath: string) => {
    if (!targetPath.trim()) {
      setDetectionStatus(null);
      return;
    }
    setDetecting(true);
    setError(null);
    try {
      const status = await getLlamaCppStatus(targetPath.trim());
      setDetectionStatus(status);
      if (status) {
        if (status.localBackend) setBackend(status.localBackend);
        if (status.localVersion) setVersion(status.localVersion);
        if (status.serverPath && status.serverPath !== targetPath) {
          setPath(status.serverPath);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (engine?.path) {
      void probePath(engine.path);
    }
  }, [engine]);

  const handlePathChange = (val: string) => {
    setPath(val);
    if (!name.trim()) {
      setName(inferBranchName(val));
    }
    if (detectTimer.current) window.clearTimeout(detectTimer.current);
    detectTimer.current = window.setTimeout(() => {
      void probePath(val);
    }, 450);
  };

  const handlePickDir = async () => {
    setError(null);
    setCandidateList(null);
    try {
      const result = await pickServerDir();
      if (result.status === "selected" && result.selectedPath) {
        setPath(result.selectedPath);
        if (!name.trim() || name === "llama.cpp" || name === "默认引擎") {
          setName(inferBranchName(result.selectedPath));
        }
        void probePath(result.selectedPath);
      } else if (result.status === "multiple") {
        setCandidateList(result.candidates);
        // 若有多个候选，默认选中第一项并就近探测，同时展示候选列表供用户点选切换
        const match = result.candidates.find((c) => c.path.toLowerCase() === path.toLowerCase()) || result.candidates[0];
        if (match) {
          setPath(match.path);
          if (!name.trim() || name === "llama.cpp" || name === "默认引擎") {
            setName(inferBranchName(match.path, match.name));
          }
          void probePath(match.path);
        }
      } else if (result.status === "none") {
        const manual = await pickServerFile();
        if (manual) {
          setPath(manual);
          if (!name.trim() || name === "llama.cpp" || name === "默认引擎") {
            setName(inferBranchName(manual));
          }
          void probePath(manual);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickFile = async () => {
    setError(null);
    setCandidateList(null);
    try {
      const manual = await pickServerFile();
      if (manual) {
        setPath(manual);
        if (!name.trim() || name === "llama.cpp" || name === "默认引擎") {
          setName(inferBranchName(manual));
        }
        void probePath(manual);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectCandidate = (cand: ServerCandidate) => {
    setPath(cand.path);
    // 切换候选程序时，若当前分支名为未设置或为上一个程序的推导名，则同步更新为该分支的新推荐名称
    const inferred = inferBranchName(cand.path, cand.name);
    if (!name.trim() || name === "llama.cpp" || name === "默认引擎") {
      setName(inferred);
    }
    void probePath(cand.path);
  };

  const handleSave = () => {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      setError(t("llama.branchPathPlaceholder"));
      return;
    }
    const finalName = name.trim() || inferBranchName(trimmedPath) || "llama.cpp";
    const newEngine: LlamaEngine = {
      id: engine?.id || uid("engine"),
      name: finalName,
      path: trimmedPath,
      backend: backend || "cuda",
      version: version || undefined,
      createdAt: engine?.createdAt || Date.now(),
    };
    onSave(newEngine, setAsActive);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="confirm-modal engine-modal" style={{ maxWidth: 560 }}>
        <header>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cpu size={19} className="engine-hub-header-icon" />
            {isEditing ? t("llama.editBranch") : t("llama.addBranch")}
          </h2>
          <button className="ghost-icon" aria-label={t("ariaClose")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="confirm-modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 分支名称 */}
          <div className="engine-modal-field">
            <label>{t("llama.branchName")}</label>
            <input
              className="engine-modal-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("llama.branchNamePlaceholder")}
            />
          </div>

          {/* 路径选择 */}
          <div className="engine-modal-field">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>{t("llama.branchPath")}</label>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="secondary-button compact"
                  onClick={() => void handlePickDir()}
                  title={t("llama.pickDirTitle")}
                >
                  <FolderOpen size={13} />
                  {t("llama.pickDir")}
                </button>
                <button
                  type="button"
                  className="secondary-button compact"
                  onClick={() => void handlePickFile()}
                  title={t("llama.pickFileTitle")}
                >
                  <FileCode size={13} />
                  {t("llama.pickFile")}
                </button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="engine-modal-input"
                style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}
                value={path}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder={t("llama.branchPathPlaceholder")}
              />
              {detecting && <Loader2 size={16} className="spin" style={{ flex: "none" }} />}
            </div>
          </div>

          {/* 若检测到多候选程序，提供高对比度、信息丰富的选择列表 */}
          {candidateList && candidateList.length > 0 && (
            <div className="engine-candidate-box">
              <div className="engine-candidate-head">
                <span className="engine-candidate-title">{t("llama.candidateModalTitle")}</span>
                <button
                  type="button"
                  className="ghost-icon compact"
                  style={{ width: 22, height: 22, padding: 0 }}
                  title={t("ariaClose")}
                  onClick={() => setCandidateList(null)}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="engine-candidate-items">
                {candidateList.map((c) => {
                  const isSelected = path.trim().toLowerCase() === c.path.toLowerCase();
                  const showRelPath = Boolean(c.relPath && c.relPath.toLowerCase() !== c.name.toLowerCase());
                  return (
                    <button
                      key={c.path}
                      type="button"
                      className={cn("engine-candidate-btn", isSelected && "selected")}
                      onClick={() => handleSelectCandidate(c)}
                    >
                      <div className="engine-cand-left">
                        <FileCode size={14} className="engine-cand-icon" />
                        <span className="engine-cand-name">{c.name}</span>
                        {showRelPath && <span className="engine-cand-path">({c.relPath})</span>}
                      </div>
                      <div className="engine-cand-right">
                        {c.sizeBytes > 0 && (
                          <span className="engine-cand-size">{formatBytes(c.sizeBytes)}</span>
                        )}
                        {isSelected ? (
                          <span className="engine-cand-check">
                            <Check size={12} />
                            {t("selected")}
                          </span>
                        ) : (
                          <span className="engine-cand-select">{t("select")}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 环境探测卡片 */}
          {path.trim() && (
            <div className="engine-detection-card">
              <div className="engine-det-head">
                <Sparkles size={14} className="engine-hub-header-icon" />
                <span>{t("llama.branchAutoInfo")}</span>
                <span
                  className={cn(
                    "engine-badge",
                    detectionStatus?.serverAvailable ? "ok" : "warn"
                  )}
                  style={{ marginLeft: "auto" }}
                >
                  {detectionStatus?.serverAvailable ? (
                    <>
                      <Check size={12} />
                      {t("llama.available")}
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={12} />
                      {t("llama.missing")}
                    </>
                  )}
                </span>
              </div>
              <div className="engine-det-grid">
                <div>
                  <span className="det-label">{t("llama.branchBackend")}</span>
                  <select
                    className="engine-select"
                    style={{ height: 24, fontSize: 11 }}
                    value={backend}
                    onChange={(e) => setBackend(e.target.value)}
                  >
                    <option value="cuda">CUDA</option>
                    <option value="vulkan">Vulkan</option>
                    <option value="cpu">CPU</option>
                  </select>
                </div>
                <div>
                  <span className="det-label">{t("llama.branchVersion")}</span>
                  <input
                    className="engine-det-input"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder={t("llama.branchCustom")}
                  />
                </div>
              </div>
            </div>
          )}

          {/* 设为主引擎勾选 */}
          <label className="engine-checkbox-row">
            <input
              type="checkbox"
              checked={setAsActive}
              onChange={(e) => setSetAsActive(e.target.checked)}
            />
            <span>{t("llama.setAsActive")}</span>
          </label>

          {error && <p className="import-error">{error}</p>}
        </div>

        <footer>
          <button className="secondary-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" onClick={handleSave} disabled={!path.trim()}>
            <Save size={15} />
            {t("confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}
