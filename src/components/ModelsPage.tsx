import { Box, Check, ChevronDown, ChevronRight, Cpu, Database, DownloadCloud, FileBox, Gauge, HardDrive, ImageIcon, Layers3, ListChecks, MemoryStick, MoreHorizontal, PenLine, Pencil, Play, Plus, Search, SlidersHorizontal, Square, Star, Timer, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { usePointerReorder, type CardHandlers } from "../hooks/usePointerReorder";
import type { ActiveDownload } from "./ExplorePage";
import type { AppConfig, ModelAsset, ModelDownloadProgress, Profile, ServerStatus } from "../types";
import { cn, fileName, formatBytes, modelTitle } from "../utils";
import ConfirmModal from "./ConfirmModal";

interface Props {
  config: AppConfig; models: ModelAsset[]; status: ServerStatus; selectedProfiles: Record<string, string>; busy: boolean; query: string; onQuery: (value: string) => void;
  onAddModel: () => void; onSelectProfile: (modelId: string, profileId: string) => void; onStart: (model: ModelAsset) => void; onStop: () => void;
  onEditProfile: (model: ModelAsset, profile: Profile) => void; onAddProfile: (model: ModelAsset) => void; onRenameModel: (modelId: string, displayName: string) => void;
  onSetDefaultModel: (modelId: string) => void; onReorderModel: (orderedIds: string[]) => void; onDeleteMultipleModels: (ids: string[]) => Promise<void>;
  onOpenProfiles: () => void; menuModelId: string | null; onMenuModel: (id: string | null) => void; onRemoveModel: (id: string) => void;
  /** 社区探索下载中任务（顶部占位卡） */
  downloads: ActiveDownload[];
  modelProgress: Record<string, ModelDownloadProgress>;
  /** 下载完成后刚导入的模型 id（卡片显示「刚刚导入」Badge） */
  justImportedIds: Set<string>;
}

export default function ModelsPage(props: Props) {
  const { t } = useI18n();
  const totalBytes = props.config.models.reduce((sum, model) => sum + model.sizeBytes, 0);
  const profileCount = props.config.models.reduce((sum, model) => sum + model.profiles.length, 0);
  /** 批量选择模式与拖拽排序状态 */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Ctrl+K 聚焦搜索框（Windows/通用快捷键，替代 macOS 的 ⌘K） */
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 卡片排序：指针事件 + 实时重排（原生 HTML5 DnD 在 WebView2 打包版被 Tauri 文件拖放 handler 接管，无法工作）；拖动中只改本地预览，松手提交一次
  const reorder = usePointerReorder({ groups: [{ id: "models", items: props.models.map((item) => item.id) }], enabled: !selectMode, onDrop: (_groupId, ids) => props.onReorderModel([...ids]) });
  /** 渲染顺序：拖动中为实时预览，空闲时即数据源顺序 */
  const modelOrder = reorder.groups[0].items;
  const modelById = new Map(props.models.map((item) => [item.id, item]));
  /** 有模型但被搜索过滤清空 → 空态文案区别于「仓库为空」 */
  const searching = props.query.trim().length > 0 && props.config.models.length > 0;

  const toggleSelectMode = () => { setSelectMode((value) => !value); setSelectedIds(new Set()); };
  const selectAll = () => setSelectedIds(new Set(props.models.map((model) => model.id)));
  const toggleSelected = (id: string) => setSelectedIds((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const handleBulkDelete = () => {
    setConfirmDelete(false);
    void props.onDeleteMultipleModels([...selectedIds]);
    setSelectedIds(new Set());
    setSelectMode(false);
  };

  return <>
    <div className="library-bar"><div className="library-stats"><span title={t("models.tooltipAssets")}><Database size={14} /><strong>{props.config.models.length}</strong>{t("models.unitModels")}</span><span title={t("tooltipDiskUsage")}><HardDrive size={14} />{t("diskUsageLabel")}<strong>{formatBytes(totalBytes)}</strong></span><span title={t("tooltipProfiles")}><SlidersHorizontal size={14} /><strong>{profileCount}</strong>{t("profiles.unit")}</span></div><div className="library-actions"><button className={cn("secondary-button", selectMode && "active")} onClick={toggleSelectMode}><ListChecks size={16} />{selectMode ? t("exitBulk") : t("bulkManage")}</button><button className="primary-button" onClick={props.onAddModel}><Plus size={17} />{t("addModel")}</button></div></div>
    <div className="section-title-row"><div><h2>{t("pageTitleModels")}</h2><span>{t("resultsCount", { count: props.models.length })}</span></div><div className="library-tools"><label className="search-box" title="Ctrl+K 快速聚焦"><Search size={15} /><input ref={searchRef} value={props.query} onChange={(e) => props.onQuery(e.target.value)} placeholder={t("searchPlaceholder")} /><kbd>Ctrl+K</kbd></label><button className="text-button" onClick={props.onOpenProfiles}>{t("manageProfiles")}<ChevronRight size={15} /></button></div></div>
    {selectMode && selectedIds.size > 0 && <div className="bulk-bar"><span>{t("bulkSelectedPrefix")}<strong>{selectedIds.size}</strong>{t("models.unitModels")}</span><button className="text-button" onClick={selectAll}>{t("selectAll")}</button><div className="bulk-spacer" /><button className="secondary-button compact" disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}>{t("clearSelection")}</button><button className="danger-button" disabled={!selectedIds.size} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />{t("deleteSelected", { count: selectedIds.size })}</button></div>}
    {props.models.length ? <section className="model-grid">{modelOrder.map((id) => {
    {props.downloads.filter((item) => item.status === "active").map((download) => {
      const key = download.repo + "::" + download.file;
      const progress = props.modelProgress[key];
      const speed = progress && progress.speedBps > 0 ? (progress.speedBps >= 1024 * 1024 ? (progress.speedBps / 1024 / 1024).toFixed(1) + " MB/s" : Math.round(progress.speedBps / 1024) + " KB/s") : "";
      const remaining = progress && progress.speedBps > 0 && progress.total > 0
        ? Math.max(0, Math.ceil((progress.total - progress.downloaded) / progress.speedBps))
        : -1;
      const remainingLabel = remaining >= 0
        ? (remaining >= 60 ? Math.floor(remaining / 60) + "m " + (remaining % 60) + "s" : remaining + "s")
        : "";
      return <div className="model-card download-placeholder" key={key}>
        <div className="model-card-top"><div className={"model-symbol vermillion"}><DownloadCloud size={24} /><span>GGUF</span></div><div className="model-title"><h3>{fileName(download.file)}</h3>{<span className="live-badge">{t("models.downloading")}</span>}</div></div>
        <div className="download-placeholder-bar"><div className="download-placeholder-inner" style={{ width: (progress?.percent ?? 0) + "%" }} /></div>
        <div className="download-placeholder-meta">
          <span>{(progress?.percent ?? 0) + "%"}</span>
          <span>{speed}</span>
          {remainingLabel && <span><Timer size={12} />{remainingLabel}</span>}
        </div>
      </div>;
    })}
 const model = modelById.get(id); return model ? <ModelCard key={id} model={model} profiles={model.profiles} selectedProfileId={props.selectedProfiles[model.id]} isDefaultModel={model.id === props.config.preferredModelId} isRunning={props.status.running && props.status.modelId === model.id} busy={props.busy} menuOpen={props.menuModelId === model.id} onMenu={() => props.onMenuModel(props.menuModelId === model.id ? null : model.id)} onSelectProfile={(profileId) => props.onSelectProfile(model.id, profileId)} onStart={() => props.onStart(model)} onStop={props.onStop} onEditProfile={props.onEditProfile} onAddProfile={props.onAddProfile} onRenameModel={props.onRenameModel} onSetDefaultModel={props.onSetDefaultModel} onRemove={() => props.onRemoveModel(model.id)} selectMode={selectMode} isSelected={selectedIds.has(model.id)} isJustImported={props.justImportedIds.has(model.id)} isDragging={reorder.dragId?.itemId === model.id} cardHandlers={reorder.cardProps("models", id)} onToggleSelect={() => toggleSelected(model.id)} /> : null; })}</section> : <div className="empty-state">{searching ? <><div><Search size={28} /></div><h3>{t("noMatchTitle")}</h3><p>{t("noMatchDesc", { query: props.query.trim() })}</p><div className="empty-actions"><button className="secondary-button" onClick={() => props.onQuery("")}>{t("clearSearch")}</button></div></> : <><div><Box size={28} /></div><h3>{t("emptyModelsTitle")}</h3><p>{t("emptyModelsDesc")}</p><div className="empty-actions"><button className="secondary-button" onClick={props.onAddModel}><Plus size={16} />{t("addModel")}</button></div></>}</div>}
    {confirmDelete && <ConfirmModal title={t("confirm.removeModelsTitle")} description={<>{t("confirm.removeModelsPre")}<strong>{selectedIds.size}</strong>{t("confirm.removeModelsMid")}</>} onConfirm={handleBulkDelete} onClose={() => setConfirmDelete(false)} />}
  </>;
}

function ModelCard({ model, profiles, selectedProfileId, isDefaultModel, isRunning, busy, menuOpen, onMenu, onSelectProfile, onStart, onStop, onEditProfile, onAddProfile, onRenameModel, onSetDefaultModel, onRemove, selectMode, isSelected, isJustImported, isDragging, cardHandlers, onToggleSelect }: {
  model: ModelAsset; profiles: Profile[]; selectedProfileId?: string; isDefaultModel: boolean; isRunning: boolean; busy: boolean; menuOpen: boolean;
  onMenu: () => void; onSelectProfile: (id: string) => void; onStart: () => void; onStop: () => void; onEditProfile: (model: ModelAsset, profile: Profile) => void; onAddProfile: (model: ModelAsset) => void;
  onRenameModel: (modelId: string, displayName: string) => void; onSetDefaultModel: (modelId: string) => void; onRemove: () => void;
  selectMode: boolean; isSelected: boolean; isJustImported: boolean; isDragging: boolean; cardHandlers: CardHandlers;
  onToggleSelect: () => void;
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const selected = profiles.find((profile) => profile.id === selectedProfileId) || profiles[0];
  const commitRename = () => { onRenameModel(model.id, draftName); setRenaming(false); };
  return <article {...cardHandlers} className={cn("model-card", isDefaultModel && "default", isRunning && "running", selectMode && "selecting", isSelected && "selected", isDragging && "dragging")}
    onClick={selectMode ? onToggleSelect : undefined}>
    {isDefaultModel && <span className="corner-flag"><Star size={11} fill="currentColor" /></span>}
    <span className={cn("card-select-check", isSelected && "checked")} aria-hidden="true"><Check size={13} strokeWidth={2.5} /></span>
    <div className="model-card-top"><div className={cn("model-symbol", model.accent)}><FileBox size={26} /><span>GGUF</span></div><div className="model-title"><div>{renaming ? <input className="model-rename-input" autoFocus value={draftName} placeholder={modelTitle(model)} onChange={(e) => setDraftName(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setRenaming(false); } }} /> : <h3>{modelTitle(model)}</h3>}{isRunning && <span className="live-badge"><i />LIVE</span>}</div><p title={model.path}>{fileName(model.path)}</p></div><div className="model-menu-wrap" onClick={(event) => event.stopPropagation()}>{isJustImported && <span className="just-imported-badge"><Check size={10} />{t("models.justImported")}</span>}<button className="ghost-icon" onClick={onMenu}><MoreHorizontal size={18} /></button>{menuOpen && <div className="context-menu"><button onClick={() => { onSetDefaultModel(model.id); onMenu(); }}><Star size={14} />{isDefaultModel ? t("card.unsetDefault") : t("card.setDefault")}</button><button onClick={() => { setDraftName(modelTitle(model)); setRenaming(true); onMenu(); }}><PenLine size={14} />{t("card.renameModel")}</button><button onClick={() => (selected ? onEditProfile(model, selected) : onAddProfile(model))}><Pencil size={14} />{selected ? t("card.editProfile") : t("newProfile")}</button><button onClick={() => { selected && onEditProfile(model, selected); onMenu(); }}><ImageIcon size={14} />{t("card.attachVision")}</button><button className="danger" onClick={onRemove}><Trash2 size={14} />{t("card.removeModel")}</button></div>}</div></div>
    <div className="model-tags"><span>{model.parameters}</span><span>{model.quantization}</span><span>{model.architecture}</span></div>
    <div className="model-specs"><div><HardDrive size={15} /><span>{t("specFileLabel")}</span><strong>{formatBytes(model.sizeBytes)}</strong></div><div><Layers3 size={15} /><span>{t("specProfilesLabel")}</span><strong>{t("cards.profilesCount", { count: profiles.length })}</strong></div></div>
    <div className="profile-preview"><div className="profile-preview-head"><span>{t("launchProfile")}</span>{selected ? <button className="profile-edit-btn" onClick={() => onEditProfile(model, selected)}>{t("editParams")}</button> : <button className="profile-edit-btn new" onClick={() => onAddProfile(model)}><Plus size={13} />{t("newProfile")}</button>}</div>{selected ? <div className="profile-pills"><span><MemoryStick size={13} />{selected.gpuLayers} {t("cards.pillLayers")}</span><span><Gauge size={13} />{(selected.contextSize / 1024).toFixed(0)}K {t("cards.pillContext")}</span><span><Cpu size={13} />{selected.threads} {t("cards.pillThreads")}</span></div> : <p className="no-profile">{t("noProfileBound")}</p>}</div>
    <div className="launch-row" onClick={(event) => event.stopPropagation()}><div className="launch-split"><button className={cn("launch-button", isRunning && "active")} disabled={busy || !selected} onClick={() => (isRunning ? onStop() : onStart())}>{isRunning ? <><Square size={15} fill="currentColor" />{t("stopService")}</> : <><Play size={15} fill="currentColor" />{t("startService")}</>}</button><label className="profile-select" title={t("launchProfile")}><select value={selected?.id || ""} onChange={(event) => onSelectProfile(event.target.value)} disabled={!profiles.length}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select><ChevronDown size={15} /></label></div></div>
  </article>;
}
