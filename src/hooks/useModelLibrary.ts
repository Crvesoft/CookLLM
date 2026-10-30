import { useMemo, useState } from "react";
import { DEFAULT_NINFER_PROFILES, DEFAULT_PROFILES, uid } from "../data";
import { buildAutoProfiles, nvfp4SupportedOf } from "../autoProfiles";
import { getHardwareInfo, inspectGguf } from "../tauri";
import type { PickedFile } from "../tauri";
import type { AppConfig, ModelAsset, Profile, ServerStatus } from "../types";
import { ACCENTS, fileName, modelTitle, parseQuantization } from "../utils";
import type { PersistConfig, Translate } from "./types";

interface UseModelLibraryOptions {
  config: AppConfig;
  status: ServerStatus;
  persist: PersistConfig;
  setToast: (message: string) => void;
  t: Translate;
}

/** 模型仓库 + 预设管理：搜索/选择、导入、重命名、排序、删除、默认项与标签维护 */
export function useModelLibrary({ config, status, persist, setToast, t }: UseModelLibraryOptions) {
  const [query, setQuery] = useState("");
  const [menuModelId, setMenuModelId] = useState<string | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<Record<string, string>>({});
  const [profileEditing, setProfileEditing] = useState<{ modelId: string; profile: Profile } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? config.models.filter((model) =>
          [modelTitle(model), model.architecture, model.quantization, model.path, ...(model.tags || [])]
            .join(" ")
            .toLowerCase()
            .includes(q)
        )
      : config.models;
  }, [config.models, query]);

  const addModelFromPaths = async (paths: { path: string; sizeBytes: number }[]) => {
    if (!paths.length) return;
    const existing = new Set(config.models.map((model) => model.path));
    const fresh = paths.filter((item) => !existing.has(item.path));
    if (!fresh.length) return setToast(t("toast.alreadyInLibrary"));
    const [hardware] = await Promise.all([getHardwareInfo().catch(() => null)]);
    const vramMb = hardware?.vramTotalMb ?? 0;
    const additions: ModelAsset[] = [];
    for (const [index, item] of fresh.entries()) {
      const path = item.path;
      const isNinfer = path.toLowerCase().endsWith(".ninfer");
      const meta = await inspectGguf(path).catch(() => ({ architecture: "", parameters: "", quantization: "", blockCount: 0, attentionLayerCount: 0, headCount: 0, headCountKv: 0, headDim: 0, contextLength: 0, weightsBytes: 0 }));
      // 文件头首个张量常是 Q6_K 输出层，K-quant 文件会被标错，文件名更能代表整体量化
      const nameQuant = parseQuantization(path, "");
      // 新模型入库即用智能推荐生成三档预设；估算不出来（读不到头信息 / 无显存 / 缺引擎）退回默认的均衡配置
      const auto = buildAutoProfiles(
        meta.blockCount > 0 && meta.weightsBytes > 0
          ? {
              blockCount: meta.blockCount,
              attentionLayerCount: meta.attentionLayerCount,
              headCountKv: meta.headCountKv,
              headDim: meta.headDim,
              contextLength: meta.contextLength,
              weightsBytes: meta.weightsBytes,
            }
          : null,
        {
          vramMb,
          cpuThreads: hardware?.cpuThreads ?? 0,
          systemRamMb: hardware?.systemRamMb ?? 0,
          nvfp4Supported: nvfp4SupportedOf(hardware ?? {}),
        },
        t,
        { isNinfer, engines: config.engines },
      );
      const initialProfiles = auto?.profiles ?? [{ ...(isNinfer ? DEFAULT_NINFER_PROFILES[0] : DEFAULT_PROFILES[0]), id: uid("profile") }];
      additions.push({
        id: uid("model"),
        name: fileName(path).replace(/\.(gguf|ninfer)$/i, "").replace(/[-_]/g, " "),
        path,
        sizeBytes: item.sizeBytes,
        architecture: meta.architecture || (isNinfer ? "NINFER" : "GGUF"),
        quantization: nameQuant || meta.quantization || t("model.unknownQuant"),
        parameters: meta.parameters || path.match(/\d+(?:\.\d+)?B/i)?.[0]?.toUpperCase() || "—",
        metadataSource: meta.architecture || meta.quantization || meta.parameters ? (isNinfer ? "ninfer" : "gguf") : "filename",
        profiles: initialProfiles,
        defaultProfileId: auto?.defaultProfileId ?? initialProfiles[0].id,
        accent: ACCENTS[(config.models.length + index) % ACCENTS.length]
      });
    }
    setSelectedProfiles((previous) => { const next = { ...previous }; for (const model of additions) next[model.id] = model.profiles[0].id; return next; });
    await persist({ ...config, models: [...config.models, ...additions] }, t(additions.length === 1 ? "toast.modelAdded" : "toast.modelsAdded", { count: additions.length }));
  };

  /** 统一入口：打开导入弹窗（拖拽 / 选文件 / 选文件夹都在弹窗内完成） */
  const openImport = () => setImportOpen(true);
  const handleImportModels = async (paths: PickedFile[]) => {
    try { await addModelFromPaths(paths); }
    finally { setImportOpen(false); }
  };

  const removeModel = async (id: string) => {
    if (status.modelId === id) return setToast(t("toast.stopFirst"));
    setMenuModelId(null); await persist({ ...config, models: config.models.filter((model) => model.id !== id) }, t("toast.modelRemoved"));
  };

  /** 拖拽排序提交（最终可见顺序）：拖动中页面只改本地预览，松手后一次性写盘。搜索过滤下的稳定交织——可见模型按新顺序填入原槽位，被过滤隐藏的保持原位 */
  const reorderModels = (visibleOrder: string[]) => {
    if (!visibleOrder.length) return;
    const visible = new Set(visibleOrder);
    const byId = new Map(config.models.map((item) => [item.id, item]));
    let cursor = 0;
    const list = config.models.map((item) => (visible.has(item.id) ? byId.get(visibleOrder[cursor++]) ?? item : item));
    if (list.every((item, index) => item.id === config.models[index].id)) return; // 顺序未变 → 不写盘、不打扰
    void persist({ ...config, models: list }, t("toast.orderUpdated"));
  };

  /** 批量移出：运行中的模型不可删除，整批拦截 */
  const removeMultipleModels = async (ids: string[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const running = config.models.find((item) => status.modelId === item.id && idSet.has(item.id));
    if (running) return setToast(t("toast.runningSelectedModels"));
    await persist({ ...config, models: config.models.filter((model) => !idSet.has(model.id)) }, t("toast.modelsRemoved", { count: ids.length }));
  };

  const upsertProfile = (modelId: string, profile: Profile, message?: string) => {
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const profiles = model.profiles.some((item) => item.id === profile.id)
      ? model.profiles.map((item) => (item.id === profile.id ? profile : item))
      : [...model.profiles, profile];
    return persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles } : item)) }, message);
  };

  const saveProfile = async (modelId: string, profile: Profile, isDefault = false) => {
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const profiles = model.profiles.some((item) => item.id === profile.id)
      ? model.profiles.map((item) => (item.id === profile.id ? profile : item))
      : [...model.profiles, profile];
    const defaultProfileId = isDefault ? profile.id : (model.defaultProfileId === profile.id ? undefined : model.defaultProfileId);
    /** 编辑器里新开启「默认预设」时，同步模型仓库里的当前选择 */
    if (isDefault && model.defaultProfileId !== profile.id) setSelectedProfiles((previous) => ({ ...previous, [modelId]: profile.id }));
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles, defaultProfileId } : item)) }, t("toast.profileSaved"));
    setProfileEditing(null);
  };

  /** 智能推荐批量落地：一次写盘追加多套预设；模型尚无默认预设时以推荐档位兜底 */
  const createProfiles = async (modelId: string, profiles: Profile[], options?: { defaultProfileId?: string }) => {
    if (!profiles.length) return;
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const generated = new Set(profiles.map((profile) => profile.id));
    const requested = options?.defaultProfileId && generated.has(options.defaultProfileId) ? options.defaultProfileId : undefined;
    const defaultProfileId = model.defaultProfileId ?? requested;
    const fallbackSelection = defaultProfileId ?? profiles[0].id;
    setSelectedProfiles((previous) => (previous[modelId] ? previous : { ...previous, [modelId]: fallbackSelection }));
    await persist(
      { ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles: [...item.profiles, ...profiles], defaultProfileId } : item)) },
      t("toast.profilesGenerated", { count: profiles.length }),
    );
  };

  const deleteProfile = async (modelId: string, id: string) => {
    if (status.modelId === modelId && status.profileId === id) return setToast(t("toast.runningProfileLocked"));
    const model = config.models.find((item) => item.id === modelId);
    const profiles = model ? model.profiles.filter((item) => item.id !== id) : [];
    setSelectedProfiles((previous) => (previous[modelId] === id ? { ...previous, [modelId]: profiles[0]?.id ?? "" } : previous));
    /** 删掉的若是默认预设，清掉悬空的 defaultProfileId */
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, profiles, defaultProfileId: item.defaultProfileId === id ? undefined : item.defaultProfileId } : item)) }, t("toast.profileDeleted"));
  };

  /** 拖拽排序提交（同一模型内预设的最终顺序）：拖动中页面只改本地预览，松手后一次性写盘 */
  const reorderProfiles = (modelId: string, profileIds: string[]) => {
    if (!profileIds.length) return;
    const owner = config.models.find((item) => item.id === modelId);
    if (!owner || profileIds.length !== owner.profiles.length) return; // 数量对不上不提交，避免误删
    const byId = new Map(owner.profiles.map((profile) => [profile.id, profile]));
    const ordered = profileIds.flatMap((id) => { const profile = byId.get(id); return profile ? [profile] : []; });
    if (ordered.length !== owner.profiles.length) return; // 出现未知 id 不提交
    void persist({ ...config, models: config.models.map((item) => item.id === modelId ? { ...item, profiles: ordered } : item) }, t("toast.profilesOrderUpdated"));
  };

  /** 批量删除：运行中的预设不可删除，整批拦截；同时清掉悬空的默认预设与当前选择 */
  const deleteMultipleProfiles = async (items: { modelId: string; profileId: string }[]) => {
    if (!items.length) return;
    const running = items.find((item) => status.modelId === item.modelId && status.profileId === item.profileId);
    if (running) return setToast(t("toast.runningSelectedProfiles"));
    const byModel = new Map<string, Set<string>>();
    for (const item of items) {
      const ids = byModel.get(item.modelId) ?? new Set<string>();
      ids.add(item.profileId);
      byModel.set(item.modelId, ids);
    }
    setSelectedProfiles((previous) => {
      const next = { ...previous };
      for (const [modelId, drop] of byModel) {
        const owner = config.models.find((item) => item.id === modelId);
        if (!owner || !drop.has(previous[modelId])) continue;
        next[modelId] = owner.profiles.find((profile) => !drop.has(profile.id))?.id ?? "";
      }
      return next;
    });
    await persist({
      ...config, models: config.models.map((owner) => {
        const drop = byModel.get(owner.id);
        if (!drop || !drop.size) return owner;
        const profiles = owner.profiles.filter((profile) => !drop.has(profile.id));
        return { ...owner, profiles, defaultProfileId: owner.defaultProfileId && drop.has(owner.defaultProfileId) ? undefined : owner.defaultProfileId };
      })
    }, t("toast.profilesDeleted", { count: items.length }));
  };

  const duplicateProfile = (modelId: string, profile: Profile) =>
    upsertProfile(modelId, { ...profile, id: uid("profile"), name: profile.name + t("profile.copySuffix") }, t("toast.profileCopied"));

  const setDefaultProfile = async (modelId: string, profileId: string) => {
    const model = config.models.find((item) => item.id === modelId);
    if (!model) return;
    const makingDefault = model.defaultProfileId !== profileId;
    /** 设为默认即视为指定该预设启动，同步模型仓库里的当前选择 */
    if (makingDefault) setSelectedProfiles((previous) => ({ ...previous, [modelId]: profileId }));
    await persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, defaultProfileId: makingDefault ? profileId : undefined } : item)) }, t(makingDefault ? "toast.defaultSet" : "toast.defaultUnset"));
  };

  const renameModel = (modelId: string, displayName: string) => {
    const trimmed = displayName?.trim();
    void persist({ ...config, models: config.models.map((item) => (item.id === modelId ? { ...item, displayName: trimmed ? trimmed : undefined } : item)) }, t(trimmed ? "toast.renamed" : "toast.nameRestored"));
    setMenuModelId(null);
  };

  const updateModelTags = (modelId: string, quantization: string, tags: string[], nextPool?: string[]) => {
    const trimmedQuant = quantization?.trim();
    void persist(
      {
        ...config,
        customTags: nextPool ?? config.customTags,
        models: config.models.map((item) =>
          item.id === modelId
            ? {
                ...item,
                quantization: trimmedQuant || t("model.unknownQuant"),
                tags: tags.length ? tags : undefined,
              }
            : item
        ),
      },
      t("toast.tagsUpdated")
    );
  };

  const setDefaultModel = (modelId: string) => {
    const makingDefault = config.preferredModelId !== modelId;
    void persist({ ...config, preferredModelId: makingDefault ? modelId : undefined }, t(makingDefault ? "toast.launchModelSet" : "toast.launchModelUnset"));
  };

  return {
    query, setQuery,
    menuModelId, setMenuModelId,
    selectedProfiles, setSelectedProfiles,
    profileEditing, setProfileEditing,
    importOpen, setImportOpen, openImport, handleImportModels,
    filteredModels,
    addModelFromPaths, removeModel, reorderModels, removeMultipleModels,
    upsertProfile, saveProfile, createProfiles, deleteProfile, reorderProfiles, deleteMultipleProfiles,
    duplicateProfile, setDefaultProfile, renameModel, updateModelTags, setDefaultModel,
  };
}
