import { Copy, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { DEFAULT_PROFILES, uid } from "../data";
import type { ModelAsset, Profile } from "../types";
import { ACCENTS, cn } from "../utils";

export default function ProfilesPage({ models, onEdit, onDelete, onDuplicate }: { models: ModelAsset[]; onEdit: (modelId: string, profile: Profile) => void; onDelete: (modelId: string, profileId: string) => void; onDuplicate: (modelId: string, profile: Profile) => void }) {
  const [selectedModelId, setSelectedModelId] = useState<string>(models[0]?.id || "");
  const model = models.find((item) => item.id === selectedModelId) || models[0];
  const profiles = model?.profiles || [];
  const create = () => { if (model) onEdit(model.id, { ...DEFAULT_PROFILES[0], id: uid("profile"), name: "新运行预设", description: "自定义 llama.cpp 启动参数" }); };
  return <><section className="page-heading">
    <div><div className="eyebrow"><SlidersHorizontal size={14} />RUNTIME PROFILES</div><h1>运行预设</h1><p>预设按模型独立管理——编辑某一模型的预设不会影响其他模型。</p></div>
    <button className="primary-button" onClick={create} disabled={!model}><Plus size={17} />新建预设</button>
  </section>
  <div className="profile-model-bar"><label>当前模型</label><select value={model?.id || ""} onChange={(event) => setSelectedModelId(event.target.value)} disabled={!models.length}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
  {profiles.length ? <section className="profiles-grid">{profiles.map((profile, index) => <article className="profile-card" key={profile.id}><div className={cn("profile-number", ACCENTS[index % ACCENTS.length])}>0{index + 1}</div><div className="profile-card-head"><div><h3>{profile.name}</h3><p>{profile.description}</p></div><button className="ghost-icon" onClick={() => model && onEdit(model.id, profile)}><Pencil size={16} /></button></div><div className="profile-stat-grid"><div><span>GPU 卸载</span><strong>{profile.gpuLayers} 层</strong></div><div><span>上下文</span><strong>{profile.contextSize.toLocaleString()}</strong></div><div><span>批大小 -b / -ub</span><strong>{profile.batchSize} / {profile.ubatchSize}</strong></div><div><span>监听地址</span><strong>{profile.host}:{profile.port}</strong></div></div><div className="profile-flags"><span className={profile.flashAttention ? "enabled" : ""}>Flash Attention</span>{profile.jinja && <span className="enabled">Jinja</span>}{profile.cacheTypeK !== "f32" && <span>Cache {profile.cacheTypeK}</span>}{profile.reasoning === "on" && profile.reasoningEffort !== "auto" && <span className="enabled">{profile.reasoningEffort}</span>}</div><div className="profile-card-actions"><button className="secondary-button" onClick={() => model && onEdit(model.id, profile)}><Pencil size={14} />编辑预设</button><button className="secondary-button" onClick={() => model && onDuplicate(model.id, profile)}><Copy size={14} />复制</button><button className="danger-icon" onClick={() => model && onDelete(model.id, profile.id)}><Trash2 size={15} /></button></div></article>)}</section> : <div className="empty-state"><div><Plus size={26} /></div><h3>该模型还没有预设</h3><p>为「{model?.name || "当前模型"}」新建一个运行预设。</p><button className="secondary-button" onClick={create}><Plus size={16} />新建预设</button></div>}
  </>;
}