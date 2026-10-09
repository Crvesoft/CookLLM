import { AlertTriangle, Check, Copy, Cpu, Gauge, LayoutGrid, List, ListChecks, MemoryStick, MoreHorizontal, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { usePointerReorder } from "../hooks/usePointerReorder";
import { DEFAULT_PROFILES, uid } from "../data";
import type { LlamaEngine, ModelAsset, Profile } from "../types";
import { ACCENTS, cn, fileName, modelTitle } from "../utils";
import ConfirmModal from "./ConfirmModal";
import { ModelFormatBadge } from "./ModelFormatBadge";

const ALL_MODELS = "all";
/** 预设卡片的全局唯一键：预设归属各自的模型，跨组操作都靠这个键定位 */
const profileKey = (ownerId: string, profileId: string) => `${ownerId}:${profileId}`;

const isModelNinfer = (m?: ModelAsset) =>
  Boolean(m?.path?.toLowerCase().endsWith(".ninfer") || m?.metadataSource === "ninfer" || m?.architecture?.toUpperCase() === "NINFER");

export default function ProfilesPage({
  models,
  engines = [],
  activeEngineId,
  onEdit,
  onDelete,
  onDuplicate,
  onSetDefault,
  onReorderProfile,
  onDeleteProfiles,
}: {
  models: ModelAsset[];
  engines?: LlamaEngine[];
  activeEngineId?: string;
  onEdit: (modelId: string, profile: Profile) => void;
  onDelete: (modelId: string, profileId: string) => void;
  onDuplicate: (modelId: string, profile: Profile) => void;
  onSetDefault: (modelId: string, profileId: string) => void;
  onReorderProfile: (modelId: string, profileIds: string[]) => void;
  onDeleteProfiles: (items: { modelId: string; profileId: string }[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const [formatFilter, setFormatFilter] = useState<"all" | "gguf" | "ninfer">(() => {
    try {
      const saved = localStorage.getItem("cookllm_profiles_format_filter");
      if (saved === "gguf" || saved === "ninfer" || saved === "all") return saved;
    } catch { }
    return "all";
  });
  const handleFormatFilterChange = (next: "all" | "gguf" | "ninfer") => {
    setFormatFilter(next);
    try {
      localStorage.setItem("cookllm_profiles_format_filter", next);
    } catch { }
  };

  const [selectedModelId, setSelectedModelId] = useState<string>(ALL_MODELS);
  const [menuProfileId, setMenuProfileId] = useState<string | null>(null);
  /** 「全部」模式下新建预设时，选择目标模型弹窗 */
  const [pickModelOpen, setPickModelOpen] = useState(false);
  /** 批量选择模式与拖拽排序状态 */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 视图模式：卡片网格 / 紧凑列表（本地持久化） */
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    try {
      const saved = localStorage.getItem("cookllm_profiles_view_mode");
      if (saved === "list" || saved === "grid") return saved;
    } catch { }
    return "grid";
  });
  const handleViewModeChange = (mode: "grid" | "list") => {
    setViewMode(mode);
    try {
      localStorage.setItem("cookllm_profiles_view_mode", mode);
    } catch { }
  };

  const filteredModels = models.filter((item) => {
    if (formatFilter === "gguf") return !isModelNinfer(item);
    if (formatFilter === "ninfer") return isModelNinfer(item);
    return true;
  });

  const allMode = selectedModelId === ALL_MODELS;
  const model: ModelAsset | undefined = allMode ? undefined : filteredModels.find((item) => item.id === selectedModelId) || filteredModels[0];
  const groups = filteredModels.filter((item) => item.profiles.length > 0);
  const totalProfiles = filteredModels.reduce((sum, item) => sum + item.profiles.length, 0);
  /** 当前视图可见的预设所属模型（全部模式按组，否则单模型） */
  const visibleOwners: ModelAsset[] = allMode ? groups : model ? [model] : [];

  // 卡片排序：指针事件 + 实时重排（原生 HTML5 DnD 在 WebView2 打包版被 Tauri 文件拖放 handler 接管，无法工作）；每个模型组是独立容器，跨组落点不响应；拖动中只改本地预览，松手提交一次
  const reorder = usePointerReorder({ groups: visibleOwners.map((owner) => ({ id: owner.id, items: owner.profiles.map((profile) => profile.id) })), enabled: !selectMode, onDrop: (ownerId, ids) => onReorderProfile(ownerId, [...ids]) });

  useEffect(() => {
    if (!menuProfileId) return;
    const onDocClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest(".model-menu-wrap")) return;
      setMenuProfileId(null);
    };
    window.addEventListener("click", onDocClick, true);
    return () => window.removeEventListener("click", onDocClick, true);
  }, [menuProfileId]);

  const toggleSelectMode = () => { setSelectMode((value) => !value); setSelectedKeys(new Set()); };
  const selectAll = () => setSelectedKeys(new Set(visibleOwners.flatMap((owner) => owner.profiles.map((profile) => profileKey(owner.id, profile.id)))));
  const toggleSelectedKey = (key: string) => setSelectedKeys((previous) => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  /** 选中键还原为 (modelId, profileId) 对，丢弃已不存在的悬空项 */
  const toDeleteItems = () => {
    const items: { modelId: string; profileId: string }[] = [];
    for (const key of selectedKeys) {
      const [ownerId, profileId] = key.split(":");
      if (!models.some((owner) => owner.id === ownerId && owner.profiles.some((profile) => profile.id === profileId))) continue;
      items.push({ modelId: ownerId, profileId });
    }
    return items;
  };

  const handleBulkDelete = () => {
    setConfirmDelete(false);
    void onDeleteProfiles(toDeleteItems());
    setSelectedKeys(new Set());
    setSelectMode(false);
  };

  const freshProfile = (): Profile => ({ ...DEFAULT_PROFILES[0], id: uid("profile"), name: t("profile.newName"), description: t("profile.newDesc") });
  const create = () => {
    setMenuProfileId(null);
    const targetPool = filteredModels.length ? filteredModels : models;
    if (allMode) {
      if (targetPool.length === 1) onEdit(targetPool[0].id, freshProfile());
      else { setPickModelOpen(true); }
    } else if (model) {
      onEdit(model.id, freshProfile());
    }
  };

  const profileCard = (owner: ModelAsset, profile: Profile, index: number) => {
    const isDefault = owner.defaultProfileId === profile.id;
    const key = profileKey(owner.id, profile.id);
    const isSelected = selectedKeys.has(key);
    const isDragging = reorder.dragId?.itemId === profile.id && reorder.dragId.groupId === owner.id;
    const isMenuOpen = menuProfileId === profile.id;
    const isNinfer = isModelNinfer(owner);
    return (
      <article
        key={key}
        {...reorder.cardProps(owner.id, profile.id)}
        className={cn(
          "profile-card",
          isDefault && "default",
          selectMode && "selecting",
          isSelected && "selected",
          isDragging && "dragging",
          isMenuOpen && "menu-open"
        )}
        onClick={selectMode ? () => toggleSelectedKey(key) : undefined}
      >
        {isDefault && (
          <span className="corner-flag">
            <Star size={10} fill="currentColor" />
          </span>
        )}
        <span className={cn("card-select-check", isSelected && "checked")} aria-hidden="true">
          <Check size={13} strokeWidth={2.5} />
        </span>
        <div className={cn("profile-number", ACCENTS[index % ACCENTS.length])}>
          0{index + 1}
        </div>
        <div className="profile-card-head">
          <div>
            <h3>{profile.name}</h3>
            <p title={profile.description}>{profile.description}</p>
          </div>
          <div className="model-menu-wrap" onClick={(event) => event.stopPropagation()}>
            <button className="ghost-icon" onClick={() => setMenuProfileId(menuProfileId === profile.id ? null : profile.id)}>
              <MoreHorizontal size={18} />
            </button>
            {menuProfileId === profile.id && (
              <div className="context-menu">
                <button onClick={() => { onSetDefault(owner.id, profile.id); setMenuProfileId(null); }}>
                  <Star size={14} />{isDefault ? t("card.unsetDefault") : t("card.setDefault")}
                </button>
                <button className="danger" onClick={() => { onDelete(owner.id, profile.id); setMenuProfileId(null); }}>
                  <Trash2 size={14} />{t("confirmDeleteLabel")}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="profile-stat-grid">
          <div>
            <span>{isNinfer ? "KV Dtype" : t("statGpuOffload")}</span>
            <strong>{isNinfer ? (profile.kvDtype?.toUpperCase() || "RK8V4") : `${profile.gpuLayers}${t("profiles.layersSuffix")}`}</strong>
          </div>
          <div>
            <span>{t("statContext")}</span>
            <strong>{profile.contextSize.toLocaleString()}</strong>
          </div>
          <div>
            <span>{isNinfer ? "Chunk / Slots" : t("statBatch")}</span>
            <strong>{isNinfer ? `${profile.prefillChunk || 512} / ${profile.parallel}` : `${profile.batchSize} / ${profile.ubatchSize}`}</strong>
          </div>
          <div title={`${profile.host}:${profile.port}`}>
            <span>{t("statHost")}</span>
            <strong>{profile.host}:{profile.port}</strong>
          </div>
        </div>
        <div className="profile-flags">
          {profile.engineId ? (() => {
            const eng = engines.find((e) => e.id === profile.engineId);
            return eng ? (
              <span className="feature-pill engine-pill" title={`${t("llama.presetEngineLabel")}: ${eng.name} (${eng.path})`}>
                <Cpu size={10} />{eng.name}
              </span>
            ) : (
              <span className="feature-pill engine-pill warn" title={t("profile.engineMissing")}>
                <AlertTriangle size={10} />{t("profile.engineMissing")}
              </span>
            );
          })() : null}
          {!isNinfer && profile.flashAttention && <span className="feature-pill" title="Flash Attention">FA</span>}
          {!isNinfer && profile.jinja && <span className="feature-pill" title="Jinja template">Jinja</span>}
          {!isNinfer && profile.cacheTypeK !== "f32" && <span className="feature-pill" title={`KV Cache: ${profile.cacheTypeK}`}>{profile.cacheTypeK}</span>}
          {profile.reasoning === "on" && profile.reasoningEffort !== "auto" && <span className="feature-pill" title={`Reasoning: ${profile.reasoningEffort}`}>{profile.reasoningEffort}</span>}
          {profile.reasoning !== "off" && profile.reasoning !== "none" && profile.reasoning !== "force-off" && typeof profile.reasoningBudget === "number" && profile.reasoningBudget >= 0 && (
            <span className="feature-pill" title={`${t("f.reasoningBudget")}: ${profile.reasoningBudget}${profile.reasoningBudget === 0 ? ` (${t("f.reasoningBudgetZeroBadge")})` : ""}`}>Budget: {profile.reasoningBudget}</span>
          )}
          {!isNinfer && profile.mmprojPath?.trim() && (
            <span
              className="feature-pill"
              title={`${fileName(profile.mmprojPath)}${profile.noMmprojOffload ? ` (${t("f.noMmprojOffload")})` : ""}`}
            >
              {profile.noMmprojOffload ? "mmproj·RAM" : "mmproj"}
            </span>
          )}
          {profile.mtp && <span className="feature-pill" title="Speculative MTP">MTP</span>}
        </div>
        <div className="profile-card-actions" onClick={(event) => event.stopPropagation()}>
          <button className="secondary-button" onClick={() => { setMenuProfileId(null); onEdit(owner.id, profile); }}>
            <Pencil size={14} />{t("editProfileAction")}
          </button>
          <button className="secondary-button" onClick={() => { setMenuProfileId(null); onDuplicate(owner.id, profile); }}>
            <Copy size={14} />{t("duplicate")}
          </button>
        </div>
      </article>
    );
  };

  const profileRow = (owner: ModelAsset, profile: Profile, index: number) => {
    const isDefault = owner.defaultProfileId === profile.id;
    const key = profileKey(owner.id, profile.id);
    const isSelected = selectedKeys.has(key);
    const isDragging = reorder.dragId?.itemId === profile.id && reorder.dragId.groupId === owner.id;
    const isMenuOpen = menuProfileId === profile.id;
    const isNinfer = isModelNinfer(owner);
    return (
      <article
        key={key}
        {...reorder.cardProps(owner.id, profile.id)}
        className={cn(
          "profile-row",
          isDefault && "default",
          selectMode && "selecting",
          isSelected && "selected",
          isDragging && "dragging",
          isMenuOpen && "menu-open"
        )}
        onClick={selectMode ? () => toggleSelectedKey(key) : undefined}
      >
        <span className={cn("card-select-check", isSelected && "checked")} aria-hidden="true">
          <Check size={13} strokeWidth={2.5} />
        </span>
        <div className="profile-row-identity">
          <div className={cn("profile-row-num", ACCENTS[index % ACCENTS.length])}>
            {isDefault && (
              <span className="model-symbol-star" title={t("card.defaultBadge")}>
                <Star size={8} fill="currentColor" />
              </span>
            )}
            {String(index + 1).padStart(2, "0")}
          </div>
          <div className="profile-row-text">
            <div className="profile-row-name-line">
              <h3>{profile.name}</h3>
            </div>
            {profile.description && <p title={profile.description}>{profile.description}</p>}
          </div>
        </div>
        <div className="profile-row-specs">
          <div className="profile-row-stat-pills">
            <span title={isNinfer ? "KV Dtype" : t("statGpuOffload")}>
              <MemoryStick size={12} />
              <strong>{isNinfer ? (profile.kvDtype?.toUpperCase() || "RK8V4") : `${profile.gpuLayers}${t("profiles.layersSuffix")}`}</strong>
            </span>
            <span title={t("statContext")}>
              <Gauge size={12} />
              <strong>{(profile.contextSize / 1024).toFixed(0)}K</strong>
            </span>
            <span title={isNinfer ? "Chunk / Slots" : t("statBatch")}>
              <Cpu size={12} />
              <strong>{isNinfer ? `${profile.prefillChunk || 512}/${profile.parallel}` : `${profile.batchSize}/${profile.ubatchSize}`}</strong>
            </span>
            <span className="profile-host-pill" title={`${profile.host}:${profile.port}`}>
              <i className="host-dot" />
              <strong>{profile.port}</strong>
            </span>
          </div>
          <div className="profile-flags compact">
            {profile.engineId ? (() => {
              const eng = engines.find((e) => e.id === profile.engineId);
              return eng ? (
                <span className="feature-pill engine-pill" title={`${t("llama.presetEngineLabel")}: ${eng.name} (${eng.path})`}>
                  <Cpu size={10} />{eng.name}
                </span>
              ) : (
                <span className="feature-pill engine-pill warn" title={t("profile.engineMissing")}>
                  <AlertTriangle size={10} />{t("profile.engineMissing")}
                </span>
              );
            })() : null}
            {!isNinfer && profile.flashAttention && <span className="feature-pill" title="Flash Attention">FA</span>}
            {!isNinfer && profile.jinja && <span className="feature-pill" title="Jinja template">Jinja</span>}
            {!isNinfer && profile.cacheTypeK !== "f32" && <span className="feature-pill" title={`KV Cache: ${profile.cacheTypeK}`}>{profile.cacheTypeK}</span>}
            {profile.reasoning === "on" && profile.reasoningEffort !== "auto" && <span className="feature-pill" title={`Reasoning: ${profile.reasoningEffort}`}>{profile.reasoningEffort}</span>}
            {profile.reasoning !== "off" && profile.reasoning !== "none" && profile.reasoning !== "force-off" && typeof profile.reasoningBudget === "number" && profile.reasoningBudget >= 0 && (
              <span className="feature-pill" title={`${t("f.reasoningBudget")}: ${profile.reasoningBudget}${profile.reasoningBudget === 0 ? ` (${t("f.reasoningBudgetZeroBadge")})` : ""}`}>Budget: {profile.reasoningBudget}</span>
            )}
            {!isNinfer && profile.mmprojPath?.trim() && (
              <span
                className="feature-pill"
                title={`${fileName(profile.mmprojPath)}${profile.noMmprojOffload ? ` (${t("f.noMmprojOffload")})` : ""}`}
              >
                {profile.noMmprojOffload ? "mmproj·RAM" : "mmproj"}
              </span>
            )}
            {profile.mtp && <span className="feature-pill" title="Speculative MTP">MTP</span>}
          </div>
        </div>
        <div className="profile-row-actions" onClick={(event) => event.stopPropagation()}>
          <button className="secondary-button compact" onClick={() => { setMenuProfileId(null); onEdit(owner.id, profile); }}>
            <Pencil size={13} />{t("editProfileAction")}
          </button>
          <button className="secondary-button compact" onClick={() => { setMenuProfileId(null); onDuplicate(owner.id, profile); }} title={t("duplicate")}>
            <Copy size={13} />
          </button>
          <div className="model-menu-wrap">
            <button className="ghost-icon" onClick={() => setMenuProfileId(menuProfileId === profile.id ? null : profile.id)}>
              <MoreHorizontal size={18} />
            </button>
            {menuProfileId === profile.id && (
              <div className="context-menu">
                <button onClick={() => { onSetDefault(owner.id, profile.id); setMenuProfileId(null); }}>
                  <Star size={14} />{isDefault ? t("card.unsetDefault") : t("card.setDefault")}
                </button>
                <button className="danger" onClick={() => { onDelete(owner.id, profile.id); setMenuProfileId(null); }}>
                  <Trash2 size={14} />{t("confirmDeleteLabel")}
                </button>
              </div>
            )}
          </div>
        </div>
      </article>
    );
  };

  /** 渲染某模型的预设卡：顺序跟随拖动中的实时预览；编号随当前位置走 */
  const renderProfiles = (owner: ModelAsset) => {
    const byId = new Map(owner.profiles.map((profile) => [profile.id, profile]));
    const ids = reorder.groups.find((group) => group.id === owner.id)?.items ?? [];
    return (
      <>
        {ids.map((id, index) => {
          const profile = byId.get(id);
          return profile ? (viewMode === "list" ? profileRow(owner, profile, index) : profileCard(owner, profile, index)) : null;
        })}
      </>
    );
  };

  return (
    <>
      <div className="profile-model-bar">
        <div className="profile-bar-filters">
          <div className="profile-bar-filter">
            <label>{t("explore.formatFilterTitle") || "格式"}</label>
            <select
              className={cn("explore-format-select", formatFilter)}
              value={formatFilter}
              onChange={(event) => {
                setMenuProfileId(null);
                setSelectedKeys(new Set());
                handleFormatFilterChange(event.target.value as "all" | "gguf" | "ninfer");
                setSelectedModelId(ALL_MODELS);
              }}
            >
              <option value="all">{t("explore.formatAll") || "全部格式"}</option>
              <option value="gguf">GGUF</option>
              <option value="ninfer">NINFER</option>
            </select>
          </div>
          <div className="profile-bar-filter">
            <label>{t("filterLabel")}</label>
            <select
              value={allMode ? ALL_MODELS : model?.id || ""}
              onChange={(event) => {
                setMenuProfileId(null);
                setSelectedKeys(new Set());
                setSelectedModelId(event.target.value);
              }}
              disabled={!filteredModels.length}
            >
              <option key="all" value={ALL_MODELS}>
                {t("allModels")} ({filteredModels.length})
              </option>
              {filteredModels.map((item) => {
                const ninfer = isModelNinfer(item);
                return (
                  <option key={item.id} value={item.id}>
                    [{ninfer ? "NINFER" : "GGUF"}] {modelTitle(item)}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
        <div className="profile-bar-actions">
          <div className="view-mode-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={cn("view-mode-btn", viewMode === "grid" && "active")}
              title={t("viewMode.grid")}
              aria-label={t("viewMode.grid")}
              onClick={() => handleViewModeChange("grid")}
            >
              <LayoutGrid size={15} />
            </button>
            <button
              type="button"
              className={cn("view-mode-btn", viewMode === "list" && "active")}
              title={t("viewMode.list")}
              aria-label={t("viewMode.list")}
              onClick={() => handleViewModeChange("list")}
            >
              <List size={15} />
            </button>
          </div>
          <button className={cn("secondary-button", selectMode && "active")} onClick={toggleSelectMode}>
            <ListChecks size={15} />{selectMode ? t("exitBulk") : t("bulkManage")}
          </button>
          <button className="primary-button" onClick={create} disabled={!models.length} title={!models.length ? t("needModelFirst") : undefined}>
            <Plus size={16} />{t("newProfile")}
          </button>
        </div>
      </div>

      {selectMode && selectedKeys.size > 0 && (
        <div className="bulk-bar">
          <span>{t("bulkSelectedPrefix")}<strong>{selectedKeys.size}</strong>{t("profiles.unit")}</span>
          <button className="text-button" onClick={selectAll}>{t("selectAll")}</button>
          <div className="bulk-spacer" />
          <button className="secondary-button compact" disabled={!selectedKeys.size} onClick={() => setSelectedKeys(new Set())}>{t("clearSelection")}</button>
          <button className="danger-button" disabled={!selectedKeys.size} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />{t("deleteSelected", { count: selectedKeys.size })}</button>
        </div>
      )}

      {allMode ? (
        totalProfiles ? (
          <div className="profile-groups">
            {groups.map((owner) => {
              const ownerIsNinfer = isModelNinfer(owner);
              return (
                <section key={owner.id} className="profile-group">
                  <div className={cn("profile-group-head", ownerIsNinfer ? "ninfer" : "gguf")}>
                    <div className="profile-group-title-row">
                      <h3>{modelTitle(owner)}</h3>
                      <span className={cn("hf-format-pill", ownerIsNinfer ? "ninfer" : "gguf")}>
                        {ownerIsNinfer ? "NINFER" : "GGUF"}
                      </span>
                    </div>
                    <span className="profile-group-count">{owner.profiles.length} {t("profiles.unit")}</span>
                  </div>
                  <section className={viewMode === "list" ? "profiles-list" : "profiles-grid"}>
                    {renderProfiles(owner)}
                  </section>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <div><Plus size={26} /></div>
            <h3>{t("emptyAllTitle")}</h3>
            <p>{filteredModels.length ? t("emptyAllDescHasModels") : t("emptyAllDescNoModels")}</p>
          </div>
        )
      ) : model ? (
        <>
          <div className={cn("profile-group-head", isModelNinfer(model) ? "ninfer" : "gguf")}>
            <div className="profile-group-title-row">
              <h3>{modelTitle(model)}</h3>
              <span className={cn("hf-format-pill", isModelNinfer(model) ? "ninfer" : "gguf")}>
                {isModelNinfer(model) ? "NINFER" : "GGUF"}
              </span>
            </div>
            <span className="profile-group-count">{model.profiles.length} {t("profiles.unit")}</span>
          </div>
          {model.profiles.length ? (
            <section className={viewMode === "list" ? "profiles-list" : "profiles-grid"}>
              {renderProfiles(model)}
            </section>
          ) : (
            <div className="empty-state">
              <div><Plus size={26} /></div>
              <h3>{t("emptyModelTitle")}</h3>
              <p>{t("emptyModelDesc", { name: modelTitle(model) })}</p>
              <button className="secondary-button" onClick={create}>
                <Plus size={16} />{t("newProfile")}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="empty-state">
          <div><Plus size={26} /></div>
          <h3>{t("emptyAllTitle")}</h3>
          <p>{t("emptyAllDescNoModels")}</p>
        </div>
      )}

      {pickModelOpen && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && setPickModelOpen(false)}>
          <div className="confirm-modal pick-model-modal">
            <header>
              <h2>{t("pickModalTitle")}</h2>
              <button className="ghost-icon" aria-label={t("ariaClose")} onClick={() => setPickModelOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <p>{t("pickModalDesc")}</p>
            <div className="pick-model-list">
              {(filteredModels.length ? filteredModels : models).map((item) => {
                const ninfer = isModelNinfer(item);
                return (
                  <button
                    key={item.id}
                    className={cn("pick-model-item", ninfer ? "ninfer" : "gguf")}
                    onClick={() => {
                      setPickModelOpen(false);
                      onEdit(item.id, freshProfile());
                    }}
                  >
                    <div className="pick-model-item-left">
                      <ModelFormatBadge isNinfer={ninfer} compact />
                      <div className="pick-model-item-info">
                        <strong>{modelTitle(item)}</strong>
                        <small title={item.path}>{fileName(item.path)}</small>
                      </div>
                    </div>
                    <div className="pick-model-item-right">
                      <span className={cn("hf-format-pill", ninfer ? "ninfer" : "gguf")}>
                        {ninfer ? "NINFER" : "GGUF"}
                      </span>
                      <span>{item.quantization || item.architecture?.toUpperCase() || (ninfer ? "NINFER" : "GGUF")}</span>
                    </div>
                  </button>
                );
              })}
            </div>
            <footer>
              <button className="secondary-button" onClick={() => setPickModelOpen(false)}>
                {t("cancel")}
              </button>
            </footer>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title={t("confirm.deleteProfilesTitle")}
          description={<>{t("confirm.deleteProfilesPre")}<strong>{selectedKeys.size}</strong>{t("confirm.deleteProfilesMid")}</>}
          onConfirm={handleBulkDelete}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
