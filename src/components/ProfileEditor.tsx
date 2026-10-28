import { Cpu, FolderOpen, HelpCircle, Save, SlidersHorizontal, Star, X, Zap } from "lucide-react";
import { useI18n } from "../i18n";
import { useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { pickFiles } from "../tauri";
import type { LlamaEngine, ModelAsset, Profile } from "../types";
import { fileName, cn, detectEngineType } from "../utils";

const CACHE_TYPES = ["f32", "f16", "q8_0", "q4_0"];
const LOAD_MODES = ["mmap", "mlock", "ragged", "row", "direct"];
const REASONING_MODES = ["off", "auto", "on"];
const REASONING_EFFORTS = ["auto", "low", "medium", "high", "xhigh"];

const NINFER_KV_DTYPES = [
  "bf16",
  "int8",
  "fp8",
  "rk8v4",
  "rk4v4",
  "rk4v4-e8",
  "rk2v4-e8",
  "nvfp4",
  "k8v4",
];
const NINFER_CUDA_POLICIES = ["default", "mixed", "strict"];
const NINFER_REASONING_EFFORTS = ["high", "xhigh", "medium", "low", "minimal", "none"];

type ToggleBoxProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
  icon?: ReactNode;
};

function ToggleBox({
  checked,
  onChange,
  disabled,
  activeLabel,
  inactiveLabel,
  icon,
}: ToggleBoxProps) {
  return (
    <button
      type="button"
      className={cn("toggle-row field-toggle-box", checked && "enabled", disabled && "disabled")}
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="field-toggle-label">
        {icon}
        {checked ? (activeLabel || "已开启") : (inactiveLabel || "已关闭")}
      </span>
      <i><b /></i>
    </button>
  );
}

type PickerGroupProps = {
  value?: string;
  placeholder: string;
  browseLabel: string;
  replaceLabel: string;
  clearLabel: string;
  onPick: () => Promise<void> | void;
  onClear: () => void;
  disabled?: boolean;
};

/** 固定单行文件输入组：[状态点/图标 + 文本] [📁 浏览|替换] [✕ 清除]，挂载前后高度恒定 */
function PickerGroup({ value = "", placeholder, browseLabel, replaceLabel, clearLabel, onPick, onClear, disabled }: PickerGroupProps) {
  const hasValue = Boolean(value.trim());
  const opening = useRef(false);
  const handlePick = (event?: ReactMouseEvent<HTMLElement>) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (disabled || opening.current) return;
    opening.current = true;
    Promise.resolve(onPick()).finally(() => { opening.current = false; });
  };
  return (
    <div className={cn("picker-shell", hasValue && "has-value", disabled && "disabled")} title={hasValue ? value : placeholder}>
      <div className="picker-slot" onClick={disabled ? undefined : handlePick}>
        {hasValue ? <i className="picker-ready-dot" /> : <FolderOpen className="picker-idle" size={15} />}
        <input readOnly disabled={disabled} value={hasValue ? fileName(value) : ""} placeholder={hasValue ? "" : placeholder} />
      </div>
      {!disabled && (
        <div className="picker-actions">
          <button type="button" className="picker-icon-btn" onClick={handlePick} title={hasValue ? replaceLabel : browseLabel} aria-label={hasValue ? replaceLabel : browseLabel}><FolderOpen size={15} /></button>
          {hasValue && <button type="button" className="picker-icon-btn" onClick={onClear} title={clearLabel} aria-label={clearLabel}><X size={15} /></button>}
        </div>
      )}
    </div>
  );
}

export default function ProfileEditor({
  model,
  profile,
  defaultProfileId,
  engines = [],
  activeEngineId,
  onClose,
  onSave,
}: {
  model?: ModelAsset;
  profile: Profile;
  defaultProfileId?: string;
  engines?: LlamaEngine[];
  activeEngineId?: string;
  onClose: () => void;
  onSave: (profile: Profile, isDefault: boolean) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => ({
    ...profile,
    visionResidency: profile.visionCpu ? "cpu" : profile.visionResidency,
  }));
  const [isDefault, setIsDefault] = useState(profile.id === defaultProfileId);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [mtpDraftError, setMtpDraftError] = useState<string | null>(null);

  const selectedEngine = draft.engineId ? engines.find((e) => e.id === draft.engineId) : undefined;
  const activeEngine = engines.find((e) => e.id === activeEngineId) || engines[0];
  const targetEngine = selectedEngine || activeEngine;

  const engineType = targetEngine?.engineType || detectEngineType(targetEngine?.path) || (model?.path?.toLowerCase().endsWith(".ninfer") ? "ninfer" : "llamacpp");
  const isNinfer = engineType === "ninfer" || engineType === "ninfer_kvmem" || Boolean(model?.path?.toLowerCase().endsWith(".ninfer"));
  const isNinferKvmem = engineType === "ninfer_kvmem" || (isNinfer && Boolean(targetEngine?.path?.toLowerCase().includes("kvmem")));

  const activeEngineName = activeEngine?.name;

  const update = <K extends keyof Profile>(key: K, value: Profile[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const number = (key: keyof Profile) => (event: ChangeEvent<HTMLInputElement>) => update(key, Number(event.target.value) as never);
  const select = (key: keyof Profile) => (event: ChangeEvent<HTMLSelectElement>) => update(key, event.target.value as never);
  const specMode: "none" | "mtp" | "dflash" | "draft" = draft.specType ?? (
    draft.mtp ? "mtp" : draft.mtpDraftPath !== undefined && draft.mtpDraftPath !== null ? "draft" : "none"
  );
  const ninferSpecHint =
    !(draft.specMtp ?? true) ? "--spec"
      : draft.ninferSpecType === "dflash2" ? "--spec dflash2"
        : draft.ninferSpecType === "dflash" ? "--spec dflash"
          : "--spec mtp";

  const changeSpecMode = (next: "none" | "mtp" | "dflash" | "draft") => {
    setMtpDraftError(null);
    if (next === "none") {
      setDraft((cur) => ({ ...cur, specType: "none", mtp: false, mtpDraftPath: undefined }));
    } else if (next === "mtp") {
      setDraft((cur) => ({ ...cur, specType: "mtp", mtp: true, mtpDraftPath: undefined }));
    } else if (next === "dflash") {
      setDraft((cur) => ({
        ...cur,
        specType: "dflash",
        mtp: false,
        mtpDraftPath: cur.mtpDraftPath ?? "",
        specDraftNMax: cur.specDraftNMax && cur.specDraftNMax > 0 ? cur.specDraftNMax : 4,
      }));
    } else {
      setDraft((cur) => ({
        ...cur,
        specType: "draft",
        mtp: false,
        mtpDraftPath: cur.mtpDraftPath ?? "",
        specDraftNMax: cur.specDraftNMax && cur.specDraftNMax > 0 ? cur.specDraftNMax : 3,
      }));
    }
  };

  const toggleVision = (next: boolean) => {
    setDraft((cur) => {
      const nextDraft = { ...cur, vision: next };
      if (!next) {
        nextDraft.visionCpu = false;
        if (nextDraft.visionResidency === "cpu") {
          nextDraft.visionResidency = "resident";
        }
      }
      return nextDraft;
    });
  };

  const toggleVisionCpu = (next: boolean) => {
    setDraft((cur) => {
      const nextDraft = { ...cur, visionCpu: next };
      if (next) {
        nextDraft.vision = true;
        nextDraft.visionResidency = "cpu";
        if (nextDraft.visionMaxMerged === undefined || nextDraft.visionMaxMerged === 16384) {
          nextDraft.visionMaxMerged = 256;
        }
      } else {
        if (nextDraft.visionResidency === "cpu") {
          nextDraft.visionResidency = "resident";
        }
        if (nextDraft.visionMaxMerged === 256) {
          nextDraft.visionMaxMerged = 16384;
        }
      }
      return nextDraft;
    });
  };

  const onVisionResidencyChange = (val: string) => {
    setDraft((cur) => {
      const isCpu = val === "cpu";
      const nextDraft = { ...cur, visionResidency: val };
      if (isCpu) {
        nextDraft.visionCpu = true;
        nextDraft.vision = true;
        if (nextDraft.visionMaxMerged === undefined || nextDraft.visionMaxMerged === 16384) {
          nextDraft.visionMaxMerged = 256;
        }
      } else {
        nextDraft.visionCpu = false;
        if (nextDraft.visionMaxMerged === 256) {
          nextDraft.visionMaxMerged = 16384;
        }
      }
      return nextDraft;
    });
  };


  const attachMmproj = async () => {
    setVisionError(null);
    try {
      const picked = await pickFiles(["gguf"]);
      const file = picked[0];
      if (!file) return;
      update("mmprojPath", file.path);
    } catch (error) {
      setVisionError(t("mmproj.failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const attachMtpDraft = async () => {
    try {
      const picked = await pickFiles(["gguf"]);
      const file = picked[0];
      if (!file) return;
      update("mtpDraftPath", file.path);
      setMtpDraftError(null);
    } catch (error) {
      setMtpDraftError(t("mtpDraft.failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="profile-editor">
        <header>
          <div className="profile-header-title-group">
            <div className={cn("editor-icon", isNinfer ? "ninfer" : "gguf")}>
              <SlidersHorizontal size={19} />
            </div>
            <div className="profile-header-title-text">
              <div className="profile-header-tag-line">
                <span>RUNTIME PROFILE</span>
                <span className={cn("hf-format-pill", isNinfer ? "ninfer" : "gguf")}>
                  {isNinfer ? "NINFER" : "GGUF"}
                </span>
              </div>
              <h2 title={`${t("editorTitle")}${model ? ` · ${fileName(model.path)}` : ""}`}>
                {t("editorTitle")}{model ? ` · ${fileName(model.path)}` : ""}
              </h2>
            </div>
          </div>
          <div className="profile-header-actions">
            <button
              type="button"
              className={cn("ghost-icon", "header-favorite-btn", isDefault && "active")}
              onClick={() => setIsDefault(!isDefault)}
              title={isDefault ? t("f.defaultPresetBadge") : t("f.setAsDefault")}
              aria-label={isDefault ? t("f.defaultPresetBadge") : t("f.setAsDefault")}
            >
              <Star size={17} fill={isDefault ? "currentColor" : "none"} />
            </button>
            <button className="ghost-icon" onClick={onClose} title={t("close") || "关闭"}><X size={19} /></button>
          </div>
        </header>
        <div className="editor-body">
          <div className="form-section">
            <div className="form-section-title"><span>01</span><div><h3>{t("ed.s1Title")}</h3><p>{t("ed.s1Desc")}</p></div></div>
            <div className="form-grid profile-info-grid">
              {/* 第一行：预设名称、监听地址、监听端口（各占 2 列，共 6 列，均分） */}
              <Field label={t("f.name")} hint={t("f.nameHint")} colSpan={2}>
                <input
                  value={draft.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder={t("f.name")}
                />
              </Field>
              <Field label={t("f.host")} hint="--host" colSpan={2}>
                <input value={draft.host} onChange={(e) => update("host", e.target.value)} />
              </Field>
              <Field label={t("f.port")} hint="--port" colSpan={2}>
                <input type="number" value={draft.port} onChange={number("port")} />
              </Field>

              {/* 第二行：说明与 推理引擎版本并排（各占 3 列，共 6 列，各 50%） */}
              <Field label={t("f.description")} hint={t("f.descriptionHint")} colSpan={3}>
                <input value={draft.description} onChange={(e) => update("description", e.target.value)} />
              </Field>
              <Field
                label={isNinfer ? (t("ed.runtimeEngineLabel") || "推理引擎") : t("llama.presetEngineLabel")}
                hint={t("f.engineHint")}
                colSpan={3}
              >
                <select
                  value={draft.engineId || ""}
                  onChange={(e) => update("engineId", e.target.value || undefined)}
                >
                  <optgroup label={t("llama.optgroupInherit")}>
                    <option value="">
                      {t("llama.followGlobalWithActive", { name: activeEngineName || "llama.cpp" })}
                    </option>
                  </optgroup>
                  <optgroup label={t("llama.optgroupFixed")}>
                    {engines.map((eng) => (
                      <option key={eng.id} value={eng.id}>
                        {eng.name}
                      </option>
                    ))}
                  </optgroup>
                  {draft.engineId && !engines.some((e) => e.id === draft.engineId) && (
                    <option value={draft.engineId} disabled>
                      {t("profile.engineMissing")} (ID: {draft.engineId})
                    </option>
                  )}
                </select>
              </Field>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title">
              <span>02</span>
              <div>
                <h3>{t("ed.s2Title")}</h3>
                <p>{isNinfer ? t("ed.s2DescNinfer") : t("ed.s2Desc")}</p>
              </div>
            </div>
            {isNinfer ? (
              <div className="section-grid-stack">
                <div className="form-grid four">
                  <Field label={t("f.contextLength")} hint="--max-context">
                    <input type="number" min="512" step="512" value={draft.contextSize} onChange={number("contextSize")} />
                  </Field>
                  <Field label={t("f.parallelSlots")} hint="--parallel">
                    <input type="number" min="1" max="8" value={draft.parallel} onChange={number("parallel")} />
                  </Field>
                  <Field label={t("f.prefillChunk")} hint="--prefill-chunk">
                    <input type="number" min="128" step="128" value={draft.prefillChunk ?? 512} onChange={number("prefillChunk")} />
                  </Field>
                  <Field label={t("f.fastPrefillKernel")} hint="--fast-prefill-kernel">
                    <ToggleBox
                      checked={Boolean(draft.fastPrefillKernel)}
                      onChange={(next) => update("fastPrefillKernel", next)}
                      activeLabel={t("f.toggleEnabled")}
                      inactiveLabel={t("f.toggleDisabled")}
                    />
                  </Field>
                </div>
                <div className="form-grid three">
                  <Field label={t("f.deviceIndex")} hint="--device">
                    <input type="number" min="0" step="1" value={draft.deviceIndex ?? 0} onChange={number("deviceIndex")} />
                  </Field>
                  {!isNinferKvmem ? (
                    <Field label={t("f.cudaMemoryPolicy")} hint="--cuda-memory-policy">
                      <select value={draft.cudaMemoryPolicy || "default"} onChange={select("cudaMemoryPolicy")}>
                        {NINFER_CUDA_POLICIES.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </Field>
                  ) : (
                    <Field label={t("f.cudaMemoryPolicy")} hint="KVMem 专属托管">
                      <input type="text" value="KVMem 独占托管 (自动)" disabled readOnly style={{ opacity: 0.75, cursor: "not-allowed" }} />
                    </Field>
                  )}
                  <Field label={t("f.cudaGraph")} hint="--cuda-graph-allowance-mib">
                    <input
                      type="number"
                      min="0"
                      step="8"
                      value={draft.cudaGraphAllowanceMib ?? ""}
                      placeholder="72"
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        if (val === "") { update("cudaGraphAllowanceMib", undefined); return; }
                        const num = Number(val);
                        if (Number.isFinite(num)) update("cudaGraphAllowanceMib", Math.max(0, Math.trunc(num)));
                      }}
                    />
                  </Field>
                </div>
              </div>
            ) : (
              <div className="form-grid three">
                <Field label={t("f.gpuLayers")} hint="-ngl"><input type="number" min="0" value={draft.gpuLayers} onChange={number("gpuLayers")} /></Field>
                <Field label={t("f.contextLength")} hint="-c"><input type="number" min="512" step="512" value={draft.contextSize} onChange={number("contextSize")} /></Field>
                <Field label={t("f.cpuThreads")} hint="-t"><input type="number" min="1" value={draft.threads} onChange={number("threads")} /></Field>
                <Field label={t("f.parallelSlots")} hint="-np"><input type="number" min="1" value={draft.parallel} onChange={number("parallel")} /></Field>
                <Field label="Batch Size" hint="-b"><input type="number" min="32" step="32" value={draft.batchSize} onChange={number("batchSize")} /></Field>
                <Field label="Ubatch Size" hint="-ub"><input type="number" min="32" step="32" value={draft.ubatchSize} onChange={number("ubatchSize")} /></Field>
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="form-section-title">
              <span>03</span>
              <div>
                <h3>{t("ed.s3Title")}</h3>
                <p>{isNinfer ? t("ed.s3DescNinfer") : t("ed.s3Desc")}</p>
              </div>
            </div>
            {isNinfer ? (
              <div className="form-grid three">
                <Field label={t("f.kvDtype")} hint="--kv-dtype" tooltip={t("f.kvDtypeTooltip")}>
                  {(() => {
                    const currentKv = (draft.kvDtype || "k8v4").toLowerCase();
                    const hasCustom = !NINFER_KV_DTYPES.includes(currentKv);
                    return (
                      <select value={currentKv} onChange={select("kvDtype")}>
                        {hasCustom && draft.kvDtype && (
                          <option value={draft.kvDtype}>{draft.kvDtype}</option>
                        )}
                        {NINFER_KV_DTYPES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    );
                  })()}
                </Field>
                {isNinferKvmem ? (
                  <>
                    <Field label={t("f.kvmemBudget")} hint="--kvmem-budget">
                      <input type="number" min="1024" step="1024" value={draft.kvmemBudget ?? 36864} onChange={number("kvmemBudget")} />
                    </Field>
                    <Field label={t("f.kvmemGenReserve")} hint="--kvmem-gen-reserve">
                      <input type="number" min="512" step="512" value={draft.kvmemGenReserve ?? 16384} onChange={number("kvmemGenReserve")} />
                    </Field>
                    <Field label={t("f.kvmemHostMib")} hint="--kvmem-host-mib">
                      <input type="number" min="1024" step="1024" value={draft.kvmemHostMib ?? 16384} onChange={number("kvmemHostMib")} />
                    </Field>
                    <Field label={t("f.kvmemSessions")} hint="--kvmem-sessions">
                      <input type="number" min="1" max="16" step="1" value={draft.kvmemSessions ?? 1} onChange={number("kvmemSessions")} />
                    </Field>
                    <Field label={t("f.gdnStateFp16")} hint="--gdn-state-fp16" tooltip={t("f.gdnStateFp16Tooltip")}>
                      <ToggleBox
                        checked={draft.gdnStateFp16 ?? true}
                        onChange={(next) => update("gdnStateFp16", next)}
                        activeLabel={t("f.toggleEnabled")}
                        inactiveLabel={t("f.toggleDisabled")}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label={t("f.hostCacheMib")} hint="--host-cache-mib">
                      <input type="number" min="0" step="512" value={draft.hostCacheMib ?? 8192} onChange={number("hostCacheMib")} />
                    </Field>
                    <Field label={t("f.kvCapacity")} hint="--kv-capacity">
                      <input type="number" min="1024" step="1024" value={draft.kvCapacity ?? 32768} onChange={number("kvCapacity")} />
                    </Field>
                    <Field label={t("f.deviceSnapshotSlots")} hint="--device-snapshot-slots" tooltip={t("f.deviceSnapshotSlotsTooltip")}>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={draft.deviceSnapshotSlots ?? ""}
                        placeholder="1"
                        onChange={(e) => {
                          const val = e.target.value.trim();
                          if (val === "") { update("deviceSnapshotSlots", undefined); return; }
                          const num = Number(val);
                          if (Number.isFinite(num)) update("deviceSnapshotSlots", Math.max(0, Math.trunc(num)));
                        }}
                      />
                    </Field>
                    <Field label={t("f.gdnStateFp16")} hint="--gdn-state-fp16" tooltip={t("f.gdnStateFp16Tooltip")}>
                      <ToggleBox
                        checked={draft.gdnStateFp16 ?? true}
                        onChange={(next) => update("gdnStateFp16", next)}
                        activeLabel={t("f.toggleEnabled")}
                        inactiveLabel={t("f.toggleDisabled")}
                      />
                    </Field>
                    <Field label={t("f.useAltPrefixCaching")} hint="--use-alt-prefix-caching" tooltip={t("f.useAltPrefixCachingTooltip")}>
                      <ToggleBox
                        checked={draft.useAltPrefixCaching ?? true}
                        onChange={(next) => update("useAltPrefixCaching", next)}
                        activeLabel={t("f.toggleEnabled")}
                        inactiveLabel={t("f.toggleDisabled")}
                      />
                    </Field>
                  </>
                )}
              </div>
            ) : (
              <div className="form-grid three">
                <Field label={t("f.faToggle")} hint="-fa on">
                  <ToggleBox
                    icon={<Zap size={14} />}
                    checked={draft.flashAttention}
                    onChange={(next) => update("flashAttention", next)}
                    activeLabel={t("f.toggleEnabled")}
                    inactiveLabel={t("f.toggleDisabled")}
                  />
                </Field>
                <Field label={t("f.jinjaToggle")} hint="--jinja">
                  <ToggleBox
                    checked={draft.jinja}
                    onChange={(next) => update("jinja", next)}
                    activeLabel={t("f.toggleEnabled")}
                    inactiveLabel={t("f.toggleDisabled")}
                  />
                </Field>
                <Field label={t("f.ncmoe")} hint="-ncmoe"><input type="number" min="0" step="1" value={draft.ncmoeLayers} onChange={number("ncmoeLayers")} /></Field>
                <Field label={t("f.loadMode")} hint="--load-mode"><select value={draft.loadMode} onChange={select("loadMode")}>{LOAD_MODES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
                <Field label={t("f.kvCacheK")} hint="--cache-type-k"><select value={draft.cacheTypeK} onChange={select("cacheTypeK")}>{CACHE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
                <Field label={t("f.kvCacheV")} hint="--cache-type-v"><select value={draft.cacheTypeV} onChange={select("cacheTypeV")}>{CACHE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>04</span><div><h3>{t("ed.s4Title")}</h3><p>{t("ed.s4Desc")}</p></div></div>
            {isNinfer ? (
              <div className="form-grid three">
                <Field label={t("f.reasoningEffort")} hint="--default-reasoning-effort">
                  <select value={draft.reasoningEffort || "high"} onChange={select("reasoningEffort")}>
                    {NINFER_REASONING_EFFORTS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("f.defaultMaxTokens")} hint="--default-max-tokens">
                  <input
                    type="number"
                    min="0"
                    step="512"
                    value={draft.defaultMaxTokens ?? 0}
                    onChange={number("defaultMaxTokens")}
                  />
                </Field>
                <Field label={t("f.preserveThinking")} hint="--preserve-thinking" tooltip={t("f.preserveThinkingTooltip")}>
                  <ToggleBox
                    checked={draft.preserveThinking ?? true}
                    onChange={(next) => update("preserveThinking", next)}
                    activeLabel={t("f.toggleEnabled")}
                    inactiveLabel={t("f.toggleDisabled")}
                  />
                </Field>
              </div>
            ) : (
              <div className="form-grid three">
                <Field label={t("f.reasoningMode")} hint="--reasoning">
                  <select value={draft.reasoning === "none" ? "off" : draft.reasoning || "off"} onChange={select("reasoning")}>
                    {REASONING_MODES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("f.reasoningEffort")} hint="--reasoning-effort">
                  <select
                    disabled={draft.reasoning === "off" || draft.reasoning === "none"}
                    value={draft.reasoningEffort}
                    onChange={select("reasoningEffort")}
                  >
                    {REASONING_EFFORTS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("f.reasoningBudget")} hint="--reasoning-budget">
                  <input
                    type="number"
                    min="-1"
                    step="1"
                    disabled={draft.reasoning === "off" || draft.reasoning === "none"}
                    value={draft.reasoningBudget ?? ""}
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      if (val === "" || val === "-") {
                        update("reasoningBudget", undefined);
                        return;
                      }
                      const num = Number(val);
                      if (Number.isFinite(num)) {
                        update("reasoningBudget", Math.max(-1, Math.trunc(num)));
                      }
                    }}
                    placeholder={t("f.reasoningBudgetPlaceholder")}
                  />
                </Field>
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>05</span><div><h3>{t("ed.s5Title")}</h3><p>{t("ed.s5Desc")}</p></div></div>
            <div className={cn("form-grid", isNinfer ? "profile-sampling-grid-ninfer" : "four")}>
              <Field label="Temperature" hint={isNinfer ? "--temperature" : "--temp"}>
                <input type="number" min="0" max="2" step="0.05" value={draft.temperature} onChange={number("temperature")} />
              </Field>
              <Field label="Top-P" hint="--top-p">
                <input type="number" min="0" max="1" step="0.01" value={draft.topP} onChange={number("topP")} />
              </Field>
              <Field label="Min-P" hint="--min-p">
                <input type="number" min="0" max="1" step="0.01" value={draft.minP} onChange={number("minP")} />
              </Field>
              {isNinfer ? (
                <>
                  <Field label="Top-K" hint="--top-k">
                    <input
                      type="number"
                      min="0"
                      max="20"
                      step="1"
                      value={draft.topK ?? ""}
                      placeholder="20"
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        if (val === "") { update("topK", undefined); return; }
                        const num = Number(val);
                        if (Number.isFinite(num)) update("topK", Math.min(20, Math.max(0, Math.trunc(num))));
                      }}
                    />
                  </Field>
                  <Field label="Seed" hint="--seed">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.seed ?? ""}
                      placeholder="42"
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        if (val === "" || val === "-") { update("seed", undefined); return; }
                        const num = Number(val);
                        if (Number.isFinite(num)) update("seed", Math.max(0, Math.trunc(num)));
                      }}
                    />
                  </Field>
                </>
              ) : (
                <Field label="Repeat Penalty" hint="--repeat-penalty">
                  <input type="number" min="0" step="0.01" value={draft.repeatPenalty} onChange={number("repeatPenalty")} />
                </Field>
              )}
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title">
              <span>06</span>
              <div>
                <h3>{isNinfer ? t("ed.s6TitleNinfer") : t("ed.s6Title")}</h3>
                <p>{isNinfer ? t("ed.s6DescNinfer") : t("ed.s6Desc")}</p>
              </div>
            </div>
            {isNinfer ? (
              <div className="form-grid three">
                {/* 第 1 行：启用图片与视频输入、快捷开启 CPU 视觉、视觉组件放置位置 */}
                <Field label={t("f.vision")} hint="--vision" tooltip={t("f.visionTooltip")}>
                  <ToggleBox
                    checked={Boolean(draft.vision)}
                    onChange={toggleVision}
                    activeLabel={t("f.toggleEnabled")}
                    inactiveLabel={t("f.toggleDisabled")}
                  />
                </Field>
                <Field label={t("f.visionCpu")} hint="--vision-cpu" tooltip={t("f.visionCpuTooltip")}>
                  <ToggleBox
                    checked={Boolean(draft.visionCpu || draft.visionResidency === "cpu")}
                    onChange={toggleVisionCpu}
                    activeLabel={t("f.toggleEnabled")}
                    inactiveLabel={t("f.toggleDisabled")}
                  />
                </Field>
                <Field label={t("f.visionResidency")} hint="--vision-residency" tooltip={t("f.visionResidencyTooltip")}>
                  <select
                    value={(draft.visionCpu || draft.visionResidency === "cpu") ? "cpu" : (!draft.visionResidency || draft.visionResidency === "resident") ? "resident" : draft.visionResidency}
                    onChange={(e) => onVisionResidencyChange(e.target.value)}
                  >
                    <option value="resident">{t("f.visionResidencyResident")}</option>
                    <option value="overlay">{t("f.visionResidencyOverlay")}</option>
                    <option value="cpu">{t("f.visionResidencyCpu")}</option>
                  </select>
                </Field>

                {/* 第 2 行：视觉 Token 上限、媒体缓存 MiB、活跃媒体预算 MiB */}
                <Field label={t("f.visionMaxMerged")} hint="--vision-max-merged" tooltip={t("f.visionMaxMergedTooltip")}>
                  <input
                    type="number"
                    min="64"
                    step="64"
                    value={draft.visionMaxMerged ?? ""}
                    placeholder={(draft.visionCpu || draft.visionResidency === "cpu") ? "256" : "16384"}
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      if (val === "") { update("visionMaxMerged", undefined); return; }
                      const num = Number(val);
                      if (Number.isFinite(num)) update("visionMaxMerged", Math.max(1, Math.trunc(num)));
                    }}
                  />
                </Field>
                <Field label={t("f.mediaCacheMib")} hint="--media-cache-mib" tooltip={t("f.mediaCacheMibTooltip")}>
                  <input
                    type="number"
                    min="0"
                    step="128"
                    value={draft.mediaCacheMib ?? ""}
                    placeholder="1024"
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      if (val === "") { update("mediaCacheMib", undefined); return; }
                      const num = Number(val);
                      if (Number.isFinite(num)) update("mediaCacheMib", Math.max(0, Math.trunc(num)));
                    }}
                  />
                </Field>
                <Field label={t("f.mediaLiveMib")} hint="--media-live-mib" tooltip={t("f.mediaLiveMibTooltip")}>
                  <input
                    type="number"
                    min="128"
                    step="128"
                    value={draft.mediaLiveMib ?? ""}
                    placeholder="2048"
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      if (val === "") { update("mediaLiveMib", undefined); return; }
                      const num = Number(val);
                      if (Number.isFinite(num)) update("mediaLiveMib", Math.max(1, Math.trunc(num)));
                    }}
                  />
                </Field>
              </div>
            ) : (
              <div className="form-grid">
                <Field label={t("f.visionModel")} hint="--mmproj">
                  <div className="vision-input-row">
                    <PickerGroup
                      value={draft.mmprojPath ?? ""}
                      placeholder={t("mmproj.placeholder")}
                      browseLabel={t("browse")}
                      replaceLabel={t("filePicker.replace")}
                      clearLabel={t("filePicker.clear")}
                      onPick={attachMmproj}
                      onClear={() => {
                        update("mmprojPath", undefined);
                        update("noMmprojOffload", false);
                        setVisionError(null);
                      }}
                    />
                    <ToggleBox
                      icon={<Cpu size={14} />}
                      checked={Boolean(draft.noMmprojOffload)}
                      onChange={(next) => update("noMmprojOffload", next)}
                      disabled={!draft.mmprojPath?.trim()}
                      activeLabel={t("f.noMmprojOffload")}
                      inactiveLabel={t("f.noMmprojOffload")}
                    />
                  </div>
                  {visionError && <p className="import-error">{visionError}</p>}
                </Field>
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="form-section-title">
              <span>07</span>
              <div>
                <h3>{t("ed.s8Title")}</h3>
                <p>{isNinfer ? t("ed.s8DescNinfer") : t("ed.s8Desc")}</p>
              </div>
            </div>
            {isNinfer ? (
              <div className="section-grid-stack">
                <div className="form-grid two">
                  <Field label={t("f.specMtp")} hint={ninferSpecHint}>
                    <ToggleBox
                      icon={<Zap size={14} />}
                      checked={draft.specMtp ?? true}
                      onChange={(next) => update("specMtp", next)}
                      activeLabel={t("f.toggleEnabled")}
                      inactiveLabel={t("f.toggleDisabled")}
                    />
                  </Field>
                  <Field label={t("f.ninferSpecAlgorithm")} hint="--spec">
                    <select
                      disabled={!(draft.specMtp ?? true)}
                      value={draft.ninferSpecType ?? "mtp"}
                      onChange={(e) => {
                        const next = e.target.value as "mtp" | "dflash" | "dflash2";
                        setDraft((cur) => ({
                          ...cur,
                          ninferSpecType: next,
                          // DFlash 家族不依赖 ngram 复制加速，切换过去时回到关闭态；切回 MTP 回到其默认宽度
                          ngramDraftTokens: next === "mtp" ? (cur.ngramDraftTokens || 31) : 0,
                          // 草稿步长同步回到各算法默认：DFlash 家族 5，MTP 4
                          draftTokens: next === "mtp" ? 4 : 5,
                        }));
                      }}
                    >
                      <option value="mtp">{t("ninfer.specMtp")}</option>
                      <option value="dflash2">{t("ninfer.specDflash2")}</option>
                      <option value="dflash">{t("ninfer.specDflash")}</option>
                    </select>
                  </Field>
                </div>
                {(draft.specMtp ?? true) && (
                  (draft.ninferSpecType === "dflash2" || draft.ninferSpecType === "dflash") ? (
                    <div className="form-grid two">
                      <Field label={t("f.draftTokens")} hint="--draft-tokens">
                        <input
                          type="number"
                          min="1"
                          max="15"
                          step="1"
                          value={draft.draftTokens ?? 5}
                          onChange={number("draftTokens")}
                        />
                      </Field>
                      <Field label={t("f.ngramDraftTokens")} hint="--ngram-draft-tokens">
                        <input
                          type="number"
                          min="0"
                          max="63"
                          step="1"
                          value={draft.ngramDraftTokens ?? 0}
                          onChange={number("ngramDraftTokens")}
                        />
                      </Field>
                    </div>
                  ) : (
                    <div className="form-grid three">
                      <Field label={t("f.draftTokens")} hint="--draft-tokens">
                        <input
                          type="number"
                          min="1"
                          max="15"
                          step="1"
                          value={draft.draftTokens ?? 4}
                          onChange={number("draftTokens")}
                        />
                      </Field>
                      <Field label={t("f.ngramDraftTokens")} hint="--ngram-draft-tokens">
                        <input
                          type="number"
                          min="0"
                          max="63"
                          step="1"
                          value={draft.ngramDraftTokens ?? 31}
                          onChange={number("ngramDraftTokens")}
                        />
                      </Field>
                      <Field label={t("f.adaptiveMtp")} hint="--adaptive-mtp">
                        <ToggleBox
                          checked={draft.adaptiveMtp ?? true}
                          onChange={(next) => update("adaptiveMtp", next)}
                          activeLabel={t("f.toggleEnabled")}
                          inactiveLabel={t("f.toggleDisabled")}
                        />
                      </Field>
                    </div>
                  )
                )}
              </div>
            ) : (
              <div className="form-grid">
                {specMode === "none" && (
                  <Field label={t("f.specMode")} hint="--spec-type">
                    <select value={specMode} onChange={(e) => changeSpecMode(e.target.value as "none" | "mtp" | "dflash" | "draft")}>
                      <option value="none">{t("spec.off")}</option>
                      <option value="mtp">{t("spec.builtin")}</option>
                      <option value="dflash">{t("spec.dflash")}</option>
                      <option value="draft">{t("spec.external")}</option>
                    </select>
                  </Field>
                )}
                {specMode !== "none" && (
                  <>
                    <div className="form-grid two spec-two">
                      <Field label={t("f.specMode")} hint="--spec-type">
                        <select value={specMode} onChange={(e) => changeSpecMode(e.target.value as "none" | "mtp" | "dflash" | "draft")}>
                          <option value="none">{t("spec.off")}</option>
                          <option value="mtp">{t("spec.builtin")}</option>
                          <option value="dflash">{t("spec.dflash")}</option>
                          <option value="draft">{t("spec.external")}</option>
                        </select>
                      </Field>
                      <Field
                        label={t("f.specDraftNMax")}
                        hint={specMode === "dflash" ? "--spec-draft-n-max (建议 4~8)" : "--spec-draft-n-max"}
                      >
                        <input type="number" min="1" step="1" value={draft.specDraftNMax} onChange={number("specDraftNMax")} />
                      </Field>
                    </div>
                    {(specMode === "dflash" || specMode === "draft") && (
                      <Field
                        label={specMode === "dflash" ? t("f.dflashModelPath") : t("f.draftModelPath")}
                        hint={specMode === "dflash" ? "-md (DFlash/DFlash2 GGUF)" : "-md"}
                      >
                        <PickerGroup
                          value={draft.mtpDraftPath ?? ""}
                          placeholder={specMode === "dflash" ? t("filePicker.dflashPlaceholder") : t("filePicker.externalPlaceholder")}
                          browseLabel={t("browse")}
                          replaceLabel={t("filePicker.replace")}
                          clearLabel={t("filePicker.clear")}
                          onPick={attachMtpDraft}
                          onClear={() => { update("mtpDraftPath", undefined); setMtpDraftError(null); }}
                        />
                      </Field>
                    )}
                  </>
                )}
                {mtpDraftError && <p className="import-error">{mtpDraftError}</p>}
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>08</span><div><h3>{t("ed.s7Title")}</h3><p>{t("ed.s7Desc")}</p></div></div>
            <Field label="Extra Arguments" hint={t("f.extraHint")}>
              <textarea value={draft.extraArgs} onChange={(e) => update("extraArgs", e.target.value)} placeholder="--no-warmup --cont-batching" />
              {/(?:^|\s)--reasoning-budget(?:=|\s|$)/i.test(draft.extraArgs) && (
                <p className="field-hint-warn">{t("ed.extraBudgetConflictWarn")}</p>
              )}
            </Field>
          </div>
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose}>{t("cancel")}</button>
          <button
            className="primary-button"
              onClick={() => {
                const sanitizedBudget =
                  typeof draft.reasoningBudget === "number" && Number.isFinite(draft.reasoningBudget)
                    ? Math.max(-1, Math.trunc(draft.reasoningBudget))
                    : -1;
                onSave(
                  {
                    ...draft,
                    mtpDraftPath: draft.mtpDraftPath?.trim() || undefined,
                    reasoningBudget: sanitizedBudget,
                    noMmprojOffload: Boolean(draft.noMmprojOffload),
                    ...(isNinfer
                      ? {
                        kvDtype: draft.kvDtype || "k8v4",
                        prefillChunk: draft.prefillChunk ?? 512,
                        fastPrefillKernel: Boolean(draft.fastPrefillKernel),
                        cudaMemoryPolicy: draft.cudaMemoryPolicy || "default",
                        deviceIndex: draft.deviceIndex ?? 0,
                        deviceProfile: "auto",
                        deviceProfilePath: undefined,
                        gdnStateFp16: draft.gdnStateFp16 ?? true,
                        preserveThinking: draft.preserveThinking ?? true,
                        useAltPrefixCaching: draft.useAltPrefixCaching ?? true,
                        deviceSnapshotSlots: typeof draft.deviceSnapshotSlots === "number" && draft.deviceSnapshotSlots > 0 ? Math.trunc(draft.deviceSnapshotSlots) : undefined,
                        specMtp: draft.specMtp ?? true,
                        draftTokens: draft.draftTokens ?? ((draft.ninferSpecType ?? "mtp") === "mtp" ? 4 : 5),
                        adaptiveMtp: draft.adaptiveMtp ?? true,
                        ngramDraftTokens: draft.ngramDraftTokens ?? ((draft.ninferSpecType ?? "mtp") === "mtp" ? 31 : 0),
                        defaultMaxTokens: Math.max(0, Math.trunc(draft.defaultMaxTokens ?? 0)),
                        topK: typeof draft.topK === "number" && draft.topK > 0 ? Math.min(20, Math.trunc(draft.topK)) : undefined,
                        seed: typeof draft.seed === "number" && draft.seed >= 0 ? Math.trunc(draft.seed) : undefined,
                        cudaGraphAllowanceMib: typeof draft.cudaGraphAllowanceMib === "number" && draft.cudaGraphAllowanceMib >= 0 ? Math.trunc(draft.cudaGraphAllowanceMib) : undefined,
                        vision: Boolean(draft.vision || draft.visionCpu || draft.visionResidency === "cpu"),
                        visionCpu: Boolean(draft.visionCpu || draft.visionResidency === "cpu"),
                        visionResidency: (draft.visionCpu || draft.visionResidency === "cpu") ? "cpu" : (draft.visionResidency?.trim() || undefined),
                        visionMaxMerged: typeof draft.visionMaxMerged === "number" && draft.visionMaxMerged > 0 ? Math.trunc(draft.visionMaxMerged) : undefined,
                        mediaCacheMib: typeof draft.mediaCacheMib === "number" && draft.mediaCacheMib >= 0 ? Math.trunc(draft.mediaCacheMib) : undefined,
                        mediaLiveMib: typeof draft.mediaLiveMib === "number" && draft.mediaLiveMib > 0 ? Math.trunc(draft.mediaLiveMib) : undefined,
                        mediaPreprocessThreads: typeof draft.mediaPreprocessThreads === "number" && draft.mediaPreprocessThreads >= 0 ? Math.trunc(draft.mediaPreprocessThreads) : undefined,
                        ...(isNinferKvmem
                          ? {
                            kvmemBudget: draft.kvmemBudget ?? 36864,
                            kvmemGenReserve: draft.kvmemGenReserve ?? 16384,
                            kvmemHostMib: draft.kvmemHostMib ?? 16384,
                            kvmemSessions: draft.kvmemSessions ?? 1,
                          }
                          : {
                            hostCacheMib: draft.hostCacheMib ?? 8192,
                            kvCapacity: draft.kvCapacity ?? 32768,
                          }),
                      }
                      : {}),
                  },
                  isDefault
                );
              }}
            >
              <Save size={16} />
              {t("saveProfile")}
            </button>
        </footer>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  fullHint,
  tooltip,
  subHint,
  wide,
  colSpan,
  action,
  children,
}: {
  label: string;
  hint?: string;
  fullHint?: string;
  tooltip?: string;
  subHint?: string;
  wide?: boolean;
  colSpan?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const displayHint = fullHint || hint;
  return (
    <div
      className={cn("field", wide && "wide")}
      style={colSpan ? { gridColumn: `span ${colSpan}` } : undefined}
    >
      <div className="field-header">
        <div className="field-title-line">
          <span className="field-label" title={label}>{label}</span>
          {tooltip && (
            <span
              className="field-tooltip-icon"
              title={tooltip}
              style={{
                marginLeft: 4,
                cursor: "help",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <HelpCircle size={13} />
            </span>
          )}
          {action}
        </div>
        <div className="field-hint-line">
          {displayHint ? (
            <code className="field-cli-param" title={displayHint}>{displayHint}</code>
          ) : (
            <span className="field-cli-placeholder">&nbsp;</span>
          )}
        </div>
      </div>
      {children}
      {subHint && (
        <div className="field-subhint">
          {subHint}
        </div>
      )}
    </div>
  );
}
