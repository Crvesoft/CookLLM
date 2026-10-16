import { useState, useEffect, useMemo } from "react";
import { X, Check, AlertTriangle, FolderOpen, HardDrive, Layers3, Settings, Tag, Cpu, RefreshCw, Upload, ArrowRight } from "lucide-react";
import { useI18n } from "../i18n";
import type { AppConfig, ModelAsset } from "../types";
import { applyPathRemap, mergeImportedConfig, type MergeImportOptions } from "../data";
import { cn } from "../utils";
import type { ConfigBackupEnvelope } from "../tauri";

interface Props {
  envelope: ConfigBackupEnvelope;
  currentConfig: AppConfig;
  onConfirm: (merged: AppConfig, summaryToast: string) => Promise<void>;
  onClose: () => void;
  checkPathsExist: (paths: string[]) => Promise<string[]>;
  onPickFolder: () => Promise<string | null>;
}

/** 智能推导模型路径的公共父目录前缀 */
function detectCommonPrefix(paths: string[]): string {
  if (!paths.length) return "";
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));
  const dirs = normalized.map((p) => {
    const idx = p.lastIndexOf("/");
    return idx > 0 ? p.slice(0, idx) : "";
  }).filter(Boolean);
  if (!dirs.length) return "";
  let prefix = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (!dirs[i].toLowerCase().startsWith(prefix.toLowerCase()) && prefix.length > 0) {
      const idx = prefix.lastIndexOf("/");
      prefix = idx > 0 ? prefix.slice(0, idx) : "";
    }
  }
  if (!prefix) return "";
  return paths[0].includes("\\") ? prefix.replace(/\//g, "\\") : prefix;
}

export default function BackupImportModal({
  envelope,
  currentConfig,
  onConfirm,
  onClose,
  checkPathsExist,
  onPickFolder,
}: Props) {
  const { t } = useI18n();
  const incoming = envelope.config;

  const [mode, setMode] = useState<"merge" | "overwrite">("merge");
  const [updateExistingProfiles, setUpdateExistingProfiles] = useState(true);
  const [importAppSettings, setImportAppSettings] = useState(true);
  const [missingStrategy, setMissingStrategy] = useState<"keep" | "skip">("keep");

  // 路径重映射状态
  const rawModelPaths = useMemo(() => (incoming.models || []).map((m) => m.path).filter(Boolean), [incoming.models]);
  const defaultDetectedPrefix = useMemo(() => detectCommonPrefix(rawModelPaths), [rawModelPaths]);

  const [enableRemap, setEnableRemap] = useState(false);
  const [fromPrefix, setFromPrefix] = useState(defaultDetectedPrefix);
  const [toPrefix, setToPrefix] = useState("");

  const [checkingPaths, setCheckingPaths] = useState(false);
  const [presentPaths, setPresentPaths] = useState<Set<string>>(new Set());

  // 当前有效 remap 配置
  const activeRemap = useMemo(() => {
    if (!enableRemap || !fromPrefix.trim() || !toPrefix.trim()) return undefined;
    return { from: fromPrefix.trim(), to: toPrefix.trim() };
  }, [enableRemap, fromPrefix, toPrefix]);

  // 计算重映射后的模型路径集合并执行存在性检查
  useEffect(() => {
    let active = true;
    const testPaths = async () => {
      setCheckingPaths(true);
      const candidates = (incoming.models || []).map((m) => applyPathRemap(m.path, activeRemap)).filter(Boolean);
      try {
        const found = await checkPathsExist(candidates);
        if (active) {
          setPresentPaths(new Set(found.map((p) => p.toLowerCase())));
        }
      } catch {
        if (active) setPresentPaths(new Set());
      } finally {
        if (active) setCheckingPaths(false);
      }
    };
    void testPaths();
    return () => { active = false; };
  }, [incoming.models, activeRemap, checkPathsExist]);

  const missingSet = useMemo(() => {
    const set = new Set<string>();
    for (const m of incoming.models || []) {
      const p = applyPathRemap(m.path, activeRemap);
      if (p && !presentPaths.has(p.toLowerCase())) {
        set.add(p.toLowerCase());
      }
    }
    return set;
  }, [incoming.models, activeRemap, presentPaths]);

  const totalModels = incoming.models?.length || 0;
  const missingCount = missingSet.size;
  const presentCount = totalModels - missingCount;
  const totalProfiles = (incoming.models || []).reduce((sum, m) => sum + (m.profiles?.length || 0), 0);
  const totalEngines = incoming.engines?.length || 0;
  const totalTags = incoming.customTags?.length || 0;

  // 格式化时间戳
  const exportedDateStr = useMemo(() => {
    if (!envelope.exportedAt) return t("bi.unknownDate");
    try {
      const date = new Date(envelope.exportedAt);
      return date.toLocaleString();
    } catch {
      return t("bi.unknownDate");
    }
  }, [envelope.exportedAt, t]);

  const handlePickTargetFolder = async () => {
    const picked = await onPickFolder();
    if (picked) {
      setToPrefix(picked);
      setEnableRemap(true);
    }
  };

  const handleExecuteImport = async () => {
    const options: MergeImportOptions = {
      mode,
      updateExistingProfiles,
      importAppSettings,
      missingPathStrategy: missingStrategy,
      pathRemap: activeRemap,
    };
    const result = mergeImportedConfig(currentConfig, incoming, missingSet, options);
    let summary = "";
    if (mode === "overwrite") {
      summary = t("toast.backupOverwritten", {
        models: result.addedModels,
        engines: result.addedEngines,
      });
    } else {
      summary = t("toast.backupImportedFull", {
        added: result.addedModels,
        updated: result.updatedModels,
        skipped: result.skippedModels,
        engines: result.addedEngines,
      });
    }
    await onConfirm(result.config, summary);
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="confirm-modal backup-import-modal">
        <header>
          <div className="backup-modal-title">
            <Upload size={18} className="backup-modal-icon" />
            <div>
              <h2>{t("bi.title")}</h2>
              <p className="backup-modal-subtitle">
                {t("bi.exportedAt")}: {exportedDateStr} · {t("bi.formatVer")}: v{envelope.version || 1}
              </p>
            </div>
          </div>
          <button className="ghost-icon" aria-label={t("ariaClose")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="confirm-modal-body backup-import-body">
          {/* 备份资产概览 */}
          <div className="backup-stats-strip">
            <div className="backup-stat-chip">
              <HardDrive size={15} />
              <span>{t("bi.modelsCount", { count: totalModels })}</span>
            </div>
            <div className="backup-stat-chip">
              <Layers3 size={15} />
              <span>{t("bi.profilesCount", { count: totalProfiles })}</span>
            </div>
            {totalEngines > 0 && (
              <div className="backup-stat-chip">
                <Cpu size={15} />
                <span>{t("bi.enginesCount", { count: totalEngines })}</span>
              </div>
            )}
            {totalTags > 0 && (
              <div className="backup-stat-chip">
                <Tag size={15} />
                <span>{t("bi.tagsCount", { count: totalTags })}</span>
              </div>
            )}
          </div>

          {/* 物理路径状态检查 */}
          <div className={cn("backup-path-health", missingCount > 0 ? "warning" : "ok")}>
            <div className="backup-path-health-header">
              {missingCount > 0 ? (
                <>
                  <AlertTriangle size={16} className="backup-health-icon warning" />
                  <strong>{t("bi.pathMissingTitle", { count: missingCount, total: totalModels })}</strong>
                </>
              ) : (
                <>
                  <Check size={16} className="backup-health-icon ok" />
                  <strong>{t("bi.pathAllReady", { total: totalModels })}</strong>
                </>
              )}
              {checkingPaths && <RefreshCw size={13} className="spin" />}
            </div>
            <p className="backup-path-health-desc">
              {missingCount > 0
                ? t("bi.pathMissingDesc")
                : t("bi.pathAllReadyDesc")}
            </p>

            {/* 跨机/换盘重定位快捷工具 */}
            {missingCount > 0 && (
              <div className="backup-remap-box">
                <div className="backup-remap-toggle-row">
                  <label className="checkbox-row compact">
                    <input
                      type="checkbox"
                      checked={enableRemap}
                      onChange={(e) => setEnableRemap(e.target.checked)}
                    />
                    <span>{t("bi.enableRemap")}</span>
                  </label>
                  <span className="backup-remap-hint">{t("bi.remapHint")}</span>
                </div>

                {enableRemap && (
                  <div className="backup-remap-inputs">
                    <div className="backup-remap-field">
                      <span className="field-label-small">{t("bi.remapFrom")}</span>
                      <input
                        type="text"
                        className="text-input"
                        value={fromPrefix}
                        placeholder={defaultDetectedPrefix || "D:\\Models"}
                        onChange={(e) => setFromPrefix(e.target.value)}
                      />
                    </div>
                    <ArrowRight size={16} className="remap-arrow" />
                    <div className="backup-remap-field">
                      <span className="field-label-small">{t("bi.remapTo")}</span>
                      <div className="input-with-button">
                        <input
                          type="text"
                          className="text-input"
                          value={toPrefix}
                          placeholder={t("bi.selectNewFolderPlaceholder")}
                          onChange={(e) => setToPrefix(e.target.value)}
                        />
                        <button
                          type="button"
                          className="secondary-button compact"
                          onClick={() => void handlePickTargetFolder()}
                        >
                          <FolderOpen size={13} />
                          {t("browse")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 模式选择 */}
          <div className="backup-mode-section">
            <span className="backup-section-label">{t("bi.modeTitle")}</span>
            <div className="backup-mode-cards">
              <label className={cn("backup-mode-card", mode === "merge" && "active")}>
                <div className="mode-card-header">
                  <input
                    type="radio"
                    name="importMode"
                    value="merge"
                    checked={mode === "merge"}
                    onChange={() => setMode("merge")}
                  />
                  <strong>{t("bi.modeMergeTitle")}</strong>
                  <span className="recommended-badge">{t("bi.recommended")}</span>
                </div>
                <p>{t("bi.modeMergeDesc")}</p>
                {mode === "merge" && (
                  <div className="backup-sub-options">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={updateExistingProfiles}
                        onChange={(e) => setUpdateExistingProfiles(e.target.checked)}
                      />
                      <span>{t("bi.optUpdateProfiles")}</span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={importAppSettings}
                        onChange={(e) => setImportAppSettings(e.target.checked)}
                      />
                      <span>{t("bi.optImportSettings")}</span>
                    </label>
                  </div>
                )}
              </label>

              <label className={cn("backup-mode-card", mode === "overwrite" && "active")}>
                <div className="mode-card-header">
                  <input
                    type="radio"
                    name="importMode"
                    value="overwrite"
                    checked={mode === "overwrite"}
                    onChange={() => setMode("overwrite")}
                  />
                  <strong>{t("bi.modeOverwriteTitle")}</strong>
                </div>
                <p>{t("bi.modeOverwriteDesc")}</p>
              </label>
            </div>
          </div>

          {/* 针对未找到文件的模型处理策略 */}
          {missingCount > 0 && (
            <div className="backup-strategy-row">
              <span className="field-label-small">{t("bi.missingStrategyLabel")}</span>
              <div className="backup-strategy-radios">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="missingStrategy"
                    value="keep"
                    checked={missingStrategy === "keep"}
                    onChange={() => setMissingStrategy("keep")}
                  />
                  <span>{t("bi.missingStrategyKeep")}</span>
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="missingStrategy"
                    value="skip"
                    checked={missingStrategy === "skip"}
                    onChange={() => setMissingStrategy("skip")}
                  />
                  <span>{t("bi.missingStrategySkip")}</span>
                </label>
              </div>
            </div>
          )}
        </div>

        <footer>
          <button className="secondary-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" onClick={() => void handleExecuteImport()}>
            <Check size={15} />
            {t("bi.confirmImport")}
          </button>
        </footer>
      </div>
    </div>
  );
}
