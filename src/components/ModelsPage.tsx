import { Box, Check, ChevronDown, ChevronRight, Cpu, Database, FileBox, Gauge, HardDrive, Layers3, ListChecks, MemoryStick, MoreHorizontal, PenLine, Pencil, Play, Plus, Search, SlidersHorizontal, Square, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePointerReorder, type CardHandlers } from "../hooks/usePointerReorder";
import type { AppConfig, ModelAsset, Profile, ServerStatus } from "../types";
import { cn, fileName, formatBytes, modelTitle } from "../utils";
import ConfirmModal from "./ConfirmModal";

interface Props {
  config: AppConfig; models: ModelAsset[]; status: ServerStatus; selectedProfiles: Record<string, string>; busy: boolean; query: string; onQuery: (value: string) => void;
  onAddModel: () => void; onSelectProfile: (modelId: string, profileId: string) => void; onStart: (model: ModelAsset) => void; onStop: () => void;
  onEditProfile: (model: ModelAsset, profile: Profile) => void; onRenameModel: (modelId: string, displayName: string) => void;
  onSetDefaultModel: (modelId: string) => void; onReorderModel: (orderedIds: string[]) => void; onDeleteMultipleModels: (ids: string[]) => Promise<void>;
  onOpenProfiles: () => void; menuModelId: string | null; onMenuModel: (id: string | null) => void; onRemoveModel: (id: string) => void;
}

export default function ModelsPage(props: Props) {
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
    <div className="library-bar"><div className="library-stats"><span title="本地 GGUF 资产"><Database size={14} /><strong>{props.config.models.length}</strong>个模型</span><span title="磁盘占用 · 已索引文件"><HardDrive size={14} />磁盘占用<strong>{formatBytes(totalBytes)}</strong></span><span title="运行预设方案"><SlidersHorizontal size={14} /><strong>{profileCount}</strong>组预设</span></div><div className="library-actions"><button className={cn("secondary-button", selectMode && "active")} onClick={toggleSelectMode}><ListChecks size={16} />{selectMode ? "退出批量" : "批量管理"}</button><button className="primary-button" onClick={props.onAddModel}><Plus size={17} />添加模型</button></div></div>
    <div className="section-title-row"><div><h2>模型资产</h2><span>{props.models.length} 个结果</span></div><div className="library-tools"><label className="search-box" title="Ctrl+K 快速聚焦"><Search size={15} /><input ref={searchRef} value={props.query} onChange={(e) => props.onQuery(e.target.value)} placeholder="搜索模型、量化或路径…" /><kbd>Ctrl+K</kbd></label><button className="text-button" onClick={props.onOpenProfiles}>管理预设<ChevronRight size={15} /></button></div></div>
    {selectMode && selectedIds.size > 0 && <div className="bulk-bar"><span>已选<strong>{selectedIds.size}</strong>个模型</span><button className="text-button" onClick={selectAll}>全选</button><div className="bulk-spacer" /><button className="secondary-button compact" disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}>清空</button><button className="danger-button" disabled={!selectedIds.size} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除所选（{selectedIds.size}）</button></div>}
    {props.models.length ? <section className="model-grid">{modelOrder.map((id) => { const model = modelById.get(id); return model ? <ModelCard key={id} model={model} profiles={model.profiles} selectedProfileId={props.selectedProfiles[model.id]} isDefaultModel={model.id === props.config.preferredModelId} isRunning={props.status.running && props.status.modelId === model.id} busy={props.busy} menuOpen={props.menuModelId === model.id} onMenu={() => props.onMenuModel(props.menuModelId === model.id ? null : model.id)} onSelectProfile={(profileId) => props.onSelectProfile(model.id, profileId)} onStart={() => props.onStart(model)} onStop={props.onStop} onEditProfile={props.onEditProfile} onRenameModel={props.onRenameModel} onSetDefaultModel={props.onSetDefaultModel} onRemove={() => props.onRemoveModel(model.id)} selectMode={selectMode} isSelected={selectedIds.has(model.id)} isDragging={reorder.dragId?.itemId === model.id} cardHandlers={reorder.cardProps("models", id)} onToggleSelect={() => toggleSelected(model.id)} /> : null; })}</section> : <div className="empty-state">{searching ? <><div><Search size={28} /></div><h3>没有匹配的结果</h3><p>「{props.query.trim()}」未匹配到任何模型，试试更换关键词或清空搜索。</p><div className="empty-actions"><button className="secondary-button" onClick={() => props.onQuery("")}>清空搜索</button></div></> : <><div><Box size={28} /></div><h3>没有找到模型</h3><p>点击 添加模型，拖入 GGUF 文件或整个文件夹。</p><div className="empty-actions"><button className="secondary-button" onClick={props.onAddModel}><Plus size={16} />添加模型</button></div></>}</div>}
    {confirmDelete && <ConfirmModal title="移出所选模型" description={<>将把选中的 <strong>{selectedIds.size}</strong> 个模型及其全部预设移出仓库，此操作不可撤销。</>} onConfirm={handleBulkDelete} onClose={() => setConfirmDelete(false)} />}
  </>;
}

function ModelCard({ model, profiles, selectedProfileId, isDefaultModel, isRunning, busy, menuOpen, onMenu, onSelectProfile, onStart, onStop, onEditProfile, onRenameModel, onSetDefaultModel, onRemove, selectMode, isSelected, isDragging, cardHandlers, onToggleSelect }: {
  model: ModelAsset; profiles: Profile[]; selectedProfileId?: string; isDefaultModel: boolean; isRunning: boolean; busy: boolean; menuOpen: boolean;
  onMenu: () => void; onSelectProfile: (id: string) => void; onStart: () => void; onStop: () => void; onEditProfile: (model: ModelAsset, profile: Profile) => void;
  onRenameModel: (modelId: string, displayName: string) => void; onSetDefaultModel: (modelId: string) => void; onRemove: () => void;
  selectMode: boolean; isSelected: boolean; isDragging: boolean; cardHandlers: CardHandlers;
  onToggleSelect: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const selected = profiles.find((profile) => profile.id === selectedProfileId) || profiles[0];
  const commitRename = () => { onRenameModel(model.id, draftName); setRenaming(false); };
  return <article {...cardHandlers} className={cn("model-card", isDefaultModel && "default", isRunning && "running", selectMode && "selecting", isSelected && "selected", isDragging && "dragging")}
    onClick={selectMode ? onToggleSelect : undefined}>
    {isDefaultModel && <span className="corner-flag"><Star size={11} fill="currentColor" /></span>}
    <span className={cn("card-select-check", isSelected && "checked")} aria-hidden="true"><Check size={13} strokeWidth={2.5} /></span>
    <div className="model-card-top"><div className={cn("model-symbol", model.accent)}><FileBox size={26} /><span>GGUF</span></div><div className="model-title"><div>{renaming ? <input className="model-rename-input" autoFocus value={draftName} placeholder={modelTitle(model)} onChange={(e) => setDraftName(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setRenaming(false); } }} /> : <h3>{modelTitle(model)}</h3>}{isRunning && <span className="live-badge"><i />LIVE</span>}</div><p title={model.path}>{fileName(model.path)}</p></div><div className="model-menu-wrap" onClick={(event) => event.stopPropagation()}><button className="ghost-icon" onClick={onMenu}><MoreHorizontal size={18} /></button>{menuOpen && <div className="context-menu"><button onClick={() => { onSetDefaultModel(model.id); onMenu(); }}><Star size={14} />{isDefaultModel ? "取消默认" : "设为默认"}</button><button onClick={() => { setDraftName(modelTitle(model)); setRenaming(true); onMenu(); }}><PenLine size={14} />重命名模型</button><button onClick={() => selected && onEditProfile(model, selected)}><Pencil size={14} />编辑当前预设</button><button className="danger" onClick={onRemove}><Trash2 size={14} />移出模型仓库</button></div>}</div></div>
    <div className="model-tags"><span>{model.parameters}</span><span>{model.quantization}</span><span>{model.architecture}</span></div>
    <div className="model-specs"><div><HardDrive size={15} /><span>文件大小</span><strong>{formatBytes(model.sizeBytes)}</strong></div><div><Layers3 size={15} /><span>可用预设</span><strong>{profiles.length} 组</strong></div></div>
    <div className="profile-preview"><div className="profile-preview-head"><span>启动预设</span><button disabled={!selected} onClick={() => selected && onEditProfile(model, selected)}>编辑参数</button></div>{selected ? <div className="profile-pills"><span><MemoryStick size={13} />{selected.gpuLayers} GPU 层</span><span><Gauge size={13} />{(selected.contextSize / 1024).toFixed(0)}K 上下文</span><span><Cpu size={13} />{selected.threads} 线程</span></div> : <p className="no-profile">尚未绑定运行预设</p>}</div>
    <div className="launch-row" onClick={(event) => event.stopPropagation()}><div className="launch-split"><button className={cn("launch-button", isRunning && "active")} disabled={busy || !selected} onClick={() => (isRunning ? onStop() : onStart())}>{isRunning ? <><Square size={15} fill="currentColor" />关闭服务</> : <><Play size={15} fill="currentColor" />启动服务</>}</button><label className="profile-select" title="启动预设"><select value={selected?.id || ""} onChange={(event) => onSelectProfile(event.target.value)} disabled={!profiles.length}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select><ChevronDown size={15} /></label></div></div>
  </article>;
}
