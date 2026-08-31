import { Check, Copy, ListChecks, MoreHorizontal, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useState } from "react";
import { usePointerReorder } from "../hooks/usePointerReorder";
import { DEFAULT_PROFILES, uid } from "../data";
import type { ModelAsset, Profile } from "../types";
import { ACCENTS, cn, modelTitle } from "../utils";
import ConfirmModal from "./ConfirmModal";

const ALL_MODELS = "all";
/** 预设卡片的全局唯一键：预设归属各自的模型，跨组操作都靠这个键定位 */
const profileKey = (ownerId: string, profileId: string) => `${ownerId}:${profileId}`;

export default function ProfilesPage({ models, onEdit, onDelete, onDuplicate, onSetDefault, onReorderProfile, onDeleteProfiles }: {
  models: ModelAsset[]; onEdit: (modelId: string, profile: Profile) => void; onDelete: (modelId: string, profileId: string) => void;
  onDuplicate: (modelId: string, profile: Profile) => void; onSetDefault: (modelId: string, profileId: string) => void;
  onReorderProfile: (modelId: string, profileIds: string[]) => void; onDeleteProfiles: (items: { modelId: string; profileId: string }[]) => Promise<void>;
}) {
  const [selectedModelId, setSelectedModelId] = useState<string>(ALL_MODELS);
  const [menuProfileId, setMenuProfileId] = useState<string | null>(null);
  /** 「全部」模式下新建预设时，选择目标模型弹窗 */
  const [pickModelOpen, setPickModelOpen] = useState(false);
  /** 批量选择模式与拖拽排序状态 */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const allMode = selectedModelId === ALL_MODELS;
  const model: ModelAsset | undefined = allMode ? undefined : models.find((item) => item.id === selectedModelId) || models[0];
  const groups = models.filter((item) => item.profiles.length > 0);
  const totalProfiles = models.reduce((sum, item) => sum + item.profiles.length, 0);
  /** 当前视图可见的预设所属模型（全部模式按组，否则单模型） */
  const visibleOwners: ModelAsset[] = allMode ? groups : model ? [model] : [];

  // 卡片排序：指针事件 + 实时重排（原生 HTML5 DnD 在 WebView2 打包版被 Tauri 文件拖放 handler 接管，无法工作）；每个模型组是独立容器，跨组落点不响应；拖动中只改本地预览，松手提交一次
  const reorder = usePointerReorder({ groups: visibleOwners.map((owner) => ({ id: owner.id, items: owner.profiles.map((profile) => profile.id) })), enabled: !selectMode, onDrop: (ownerId, ids) => onReorderProfile(ownerId, [...ids]) });

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

  const freshProfile = (): Profile => ({ ...DEFAULT_PROFILES[0], id: uid("profile"), name: "新运行预设", description: "自定义 llama.cpp 启动参数" });
  const create = () => { if (allMode) { if (models.length === 1) onEdit(models[0].id, freshProfile()); else { setMenuProfileId(null); setPickModelOpen(true); } } else if (model) onEdit(model.id, freshProfile()); };
  const profileCard = (owner: ModelAsset, profile: Profile, index: number) => { const isDefault = owner.defaultProfileId === profile.id; const key = profileKey(owner.id, profile.id); const isSelected = selectedKeys.has(key); const isDragging = reorder.dragId?.itemId === profile.id && reorder.dragId.groupId === owner.id; return <article key={key} {...reorder.cardProps(owner.id, profile.id)} className={cn("profile-card", isDefault && "default", selectMode && "selecting", isSelected && "selected", isDragging && "dragging")}
    onClick={selectMode ? () => toggleSelectedKey(key) : undefined}>
  {isDefault && <span className="corner-flag"><Star size={11} fill="currentColor" /></span>}<span className={cn("card-select-check", isSelected && "checked")} aria-hidden="true"><Check size={13} strokeWidth={2.5} /></span><div className={cn("profile-number", ACCENTS[index % ACCENTS.length])}>0{index + 1}</div><div className="profile-card-head"><div><h3>{profile.name}</h3><p>{profile.description}</p></div><div className="model-menu-wrap" onClick={(event) => event.stopPropagation()}><button className="ghost-icon" onClick={() => setMenuProfileId(menuProfileId === profile.id ? null : profile.id)}><MoreHorizontal size={18} /></button>{menuProfileId === profile.id && <div className="context-menu"><button onClick={() => { onSetDefault(owner.id, profile.id); setMenuProfileId(null); }}><Star size={14} />{isDefault ? "取消默认" : "设为默认"}</button><button className="danger" onClick={() => { onDelete(owner.id, profile.id); setMenuProfileId(null); }}><Trash2 size={14} />删除预设</button></div>}</div></div><div className="profile-stat-grid"><div><span>GPU 卸载</span><strong>{profile.gpuLayers} 层</strong></div><div><span>上下文</span><strong>{profile.contextSize.toLocaleString()}</strong></div><div><span>批大小 -b / -ub</span><strong>{profile.batchSize} / {profile.ubatchSize}</strong></div><div><span>监听地址</span><strong>{profile.host}:{profile.port}</strong></div></div><div className="profile-flags"><span className={profile.flashAttention ? "enabled" : ""}>Flash Attention</span>{profile.jinja && <span className="enabled">Jinja</span>}{profile.cacheTypeK !== "f32" && <span>Cache {profile.cacheTypeK}</span>}{profile.reasoning === "on" && profile.reasoningEffort !== "auto" && <span className="enabled">{profile.reasoningEffort}</span>}</div><div className="profile-card-actions" onClick={(event) => event.stopPropagation()}><button className="secondary-button" onClick={() => onEdit(owner.id, profile)}><Pencil size={14} />编辑预设</button><button className="secondary-button" onClick={() => onDuplicate(owner.id, profile)}><Copy size={14} />复制</button></div></article>; };
  /** 渲染某模型的预设卡：顺序跟随拖动中的实时预览；编号随当前位置走 */
  const renderProfiles = (owner: ModelAsset) => { const byId = new Map(owner.profiles.map((profile) => [profile.id, profile])); const ids = reorder.groups.find((group) => group.id === owner.id)?.items ?? []; return <>{ids.map((id, index) => { const profile = byId.get(id); return profile ? profileCard(owner, profile, index) : null; })}</>; };
  return <>
  <div className="profile-model-bar"><label>预设模型</label><select value={allMode ? ALL_MODELS : model?.id || ""} onChange={(event) => { setMenuProfileId(null); setSelectedKeys(new Set()); setSelectedModelId(event.target.value); }} disabled={!models.length}>{<option key="all" value={ALL_MODELS}>全部</option>}{models.map((item) => <option key={item.id} value={item.id}>{modelTitle(item)}</option>)}</select><button className={cn("secondary-button", selectMode && "active")} onClick={toggleSelectMode}><ListChecks size={16} />{selectMode ? "退出批量" : "批量管理"}</button><button className="primary-button" onClick={create} disabled={!models.length} title={!models.length ? "请先在「模型仓库」中添加模型" : undefined}><Plus size={17} />新建预设</button></div>
  {selectMode && selectedKeys.size > 0 && <div className="bulk-bar"><span>已选<strong>{selectedKeys.size}</strong>组预设</span><button className="text-button" onClick={selectAll}>全选</button><div className="bulk-spacer" /><button className="secondary-button compact" disabled={!selectedKeys.size} onClick={() => setSelectedKeys(new Set())}>清空</button><button className="danger-button" disabled={!selectedKeys.size} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除所选（{selectedKeys.size}）</button></div>}
  {allMode ? totalProfiles ? <div className="profile-groups">{groups.map((owner) => <section key={owner.id} className="profile-group"><div className="profile-group-head"><h3>{modelTitle(owner)}</h3><span>{owner.profiles.length} 组预设</span></div><section className="profiles-grid">{renderProfiles(owner)}</section></section>)}</div> : <div className="empty-state"><div><Plus size={26} /></div><h3>还没有任何运行预设</h3><p>{models.length ? "点击右上角「新建预设」，选择目标模型即可创建。" : "先在「模型仓库」中添加模型，再创建它的运行预设。"}</p></div> : model?.profiles.length ? <section className="profiles-grid">{renderProfiles(model)}</section> : <div className="empty-state"><div><Plus size={26} /></div><h3>该模型还没有预设</h3><p>为「{model ? modelTitle(model) : "预设模型"}」新建一个运行预设。</p><button className="secondary-button" onClick={create}><Plus size={16} />新建预设</button></div>}
  {pickModelOpen && <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && setPickModelOpen(false)}>
    <div className="confirm-modal pick-model-modal">
      <header><h2>为哪个模型新建预设？</h2><button className="ghost-icon" aria-label="关闭" onClick={() => setPickModelOpen(false)}><X size={18} /></button></header>
      <p>选择目标模型，将为其创建一组默认运行预设。</p>
      <div className="pick-model-list">{models.map((item) => (<button key={item.id} onClick={() => { setPickModelOpen(false); onEdit(item.id, freshProfile()); }}><strong>{modelTitle(item)}</strong><span>{item.quantization || item.architecture?.toUpperCase() || "GGUF"}</span></button>))}</div>
      <footer><button className="secondary-button" onClick={() => setPickModelOpen(false)}>取消</button></footer>
    </div>
  </div>}
  {confirmDelete && <ConfirmModal title="删除所选预设" description={<>将删除选中的 <strong>{selectedKeys.size}</strong> 组运行预设，所属模型保留，此操作不可撤销。</>} onConfirm={handleBulkDelete} onClose={() => setConfirmDelete(false)} />}
  </>;
}
