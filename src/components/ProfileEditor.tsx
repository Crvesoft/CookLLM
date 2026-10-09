import { Cpu, FolderOpen, HelpCircle, Info, Save, SlidersHorizontal, Star, X, Zap } from "lucide-react";
import { useI18n } from "../i18n";
import { useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { pickFiles } from "../tauri";
import type { LlamaEngine, ModelAsset, Profile } from "../types";
import { fileName, cn, detectEngineType } from "../utils";

const CACHE_TYPES = ["f32", "f16", "q8_0", "q4_0"];
const LOAD_MODES = ["mmap", "mlock", "ragged", "row", "direct"];
const REASONING_MODES = ["off", "auto", "on"];
const REASONING_EFFORTS = ["auto", "low", "medium", "high", "xhigh"];

const NINFER_KV_DTYPES = ["rk8v4", "int8", "bf16", "nvfp4", "k8v4"];
const NINFER_CUDA_POLICIES = ["mixed", "strict", "default"];
const NINFER_REASONING_EFFORTS = ["high", "xhigh", "medium", "low", "minimal", "none"];


type ToggleFieldProps = {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  icon?: ReactNode;
  disabled?: boolean;
};

function ToggleField({ label, hint, checked, onChange, icon, disabled }: ToggleFieldProps) {
  return (
    <button
      type="button"
      className={cn("toggle-row", checked && "enabled", disabled && "disabled")}
      aria-pressed={checked}
      title={hint}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span>{icon}{label}</span><i><b /></i>
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
  const [draft, setDraft] = useState(profile);
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
  const mtpMode: "none" | "mtp" | "draft" = draft.mtp ? "mtp" : draft.mtpDraftPath !== undefined && draft.mtpDraftPath !== null ? "draft" : "none";

  const changeSpecMode = (next: "none" | "mtp" | "draft") => {
    setMtpDraftError(null);
    if (next === "none") {
      update("mtp", false);
      update("mtpDraftPath", undefined);
    } else if (next === "mtp") {
      update("mtp", true);
      update("mtpDraftPath", undefined);
    } else {
      update("mtp", false);
      if (draft.mtpDraftPath == null) update("mtpDraftPath", "");
    }
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
              <Field label={t("f.name")} colSpan={2}>
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
              <Field label={t("f.description")} colSpan={3}>
                <input value={draft.description} onChange={(e) => update("description", e.target.value)} />
              </Field>
              <Field
                label={isNinfer ? (t("ed.runtimeEngineLabel") || "推理引擎") : t("llama.presetEngineLabel")}
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
              <div className="form-grid three">
                <Field label={t("f.contextLength")} hint="--max-context">
                  <input type="number" min="512" step="512" value={draft.contextSize} onChange={number("contextSize")} />
                </Field>
                <Field label={t("f.parallelSlots")} hint="--parallel">
                  <input type="number" min="1" max="8" value={draft.parallel} onChange={number("parallel")} />
                </Field>
                <Field label={t("f.prefillChunk")} hint="--prefill-chunk">
                  <input type="number" min="128" step="128" value={draft.prefillChunk ?? 512} onChange={number("prefillChunk")} />
                </Field>
                <Field label={t("f.deviceIndex")} hint="--device">
                  <input type="number" min="0" step="1" value={draft.deviceIndex ?? 0} onChange={number("deviceIndex")} />
                </Field>
                {!isNinferKvmem ? (
                  <Field label={t("f.cudaMemoryPolicy")} hint="--cuda-memory-policy">
                    <select value={draft.cudaMemoryPolicy || "mixed"} onChange={select("cudaMemoryPolicy")}>
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
                <div
                  className={cn("fast-kernel-strip", (draft.fastPrefillKernel ?? true) && "enabled")}
                  onClick={() => update("fastPrefillKernel", !(draft.fastPrefillKernel ?? true))}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      update("fastPrefillKernel", !(draft.fastPrefillKernel ?? true));
                    }
                  }}
                  title="--fast-prefill-kernel"
                >
                  <div className="fast-kernel-strip-left">
                    <span className="fast-kernel-strip-title">{t("f.fastPrefillKernel")}</span>
                    <code className="fast-kernel-strip-hint">--fast-prefill-kernel</code>
                  </div>
                  <button
                    type="button"
                    className={cn("toggle-switch-btn", (draft.fastPrefillKernel ?? true) && "active")}
                    onClick={(e) => {
                      e.stopPropagation();
                      update("fastPrefillKernel", !(draft.fastPrefillKernel ?? true));
                    }}
                    title="--fast-prefill-kernel"
                    aria-label={t("f.fastPrefillKernel")}
                  >
                    <b />
                  </button>
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
              <div className="form-grid profile-kv-grid">
                <Field label={t("f.kvDtype")} hint="--kv-dtype" colSpan={2}>
                  <select value={draft.kvDtype || "rk8v4"} onChange={select("kvDtype")}>
                    {NINFER_KV_DTYPES.map((v) => <option key={v} value={v}>{v.toUpperCase()}</option>)}
                  </select>
                </Field>
                {isNinferKvmem ? (
                  <>
                    <Field label={t("f.kvmemBudget")} hint="--kvmem-budget" colSpan={2}>
                      <input type="number" min="1024" step="1024" value={draft.kvmemBudget ?? 16384} onChange={number("kvmemBudget")} />
                    </Field>
                    <Field label={t("f.kvmemGenReserve")} hint="--kvmem-gen-reserve" colSpan={2}>
                      <input type="number" min="512" step="512" value={draft.kvmemGenReserve ?? 4096} onChange={number("kvmemGenReserve")} />
                    </Field>
                    <Field label={t("f.kvmemHostMib")} hint="--kvmem-host-mib" colSpan={3}>
                      <input type="number" min="1024" step="1024" value={draft.kvmemHostMib ?? 16384} onChange={number("kvmemHostMib")} />
                    </Field>
                    <Field label={t("f.kvmemSessions")} hint="--kvmem-sessions" colSpan={3}>
                      <input type="number" min="1" max="16" step="1" value={draft.kvmemSessions ?? 4} onChange={number("kvmemSessions")} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label={t("f.hostCacheMib")} hint="--host-cache-mib" colSpan={2}>
                      <input type="number" min="0" step="512" value={draft.hostCacheMib ?? 8192} onChange={number("hostCacheMib")} />
                    </Field>
                    <Field label={t("f.kvCapacity")} hint="--kv-capacity" colSpan={2}>
                      <input type="number" min="1024" step="1024" value={draft.kvCapacity ?? 32768} onChange={number("kvCapacity")} />
                    </Field>
                  </>
                )}
              </div>
            ) : (
              <div className="form-grid compact">
                <ToggleField label={t("f.faToggle")} hint="-fa on" icon={<Zap size={14} />} checked={draft.flashAttention} onChange={(next) => update("flashAttention", next)} />
                <ToggleField label={t("f.jinjaToggle")} hint="--jinja" checked={draft.jinja} onChange={(next) => update("jinja", next)} />
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
              <div className="form-grid two">
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
            <div className="form-grid four">
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
          {!isNinfer && (
            <div className="form-section">
              <div className="form-section-title">
                <span>06</span>
                <div>
                  <h3>{t("ed.s6Title")}</h3>
                  <p>{t("ed.s6Desc")}</p>
                </div>
              </div>
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
                    <ToggleField
                      label={t("f.noMmprojOffload")}
                      hint={t("f.noMmprojOffloadHint")}
                      icon={<Cpu size={14} />}
                      checked={Boolean(draft.noMmprojOffload)}
                      onChange={(next) => update("noMmprojOffload", next)}
                      disabled={!draft.mmprojPath?.trim()}
                    />
                  </div>
                  {visionError && <p className="import-error">{visionError}</p>}
                </Field>
              </div>
            </div>
          )}
          <div className="form-section">
            <div className="form-section-title">
              <span>{isNinfer ? "06" : "07"}</span>
              <div>
                <h3>{t("ed.s8Title")}</h3>
                <p>{isNinfer ? t("ed.s8DescNinfer") : t("ed.s8Desc")}</p>
              </div>
            </div>
            {isNinfer ? (
              <div className="form-grid two">
                <ToggleField
                  label={t("f.specMtp")}
                  hint="--spec mtp"
                  icon={<Zap size={14} />}
                  checked={draft.specMtp ?? true}
                  onChange={(next) => update("specMtp", next)}
                />
                <ToggleField
                  label={t("f.adaptiveMtp")}
                  hint="--adaptive-mtp"
                  checked={draft.adaptiveMtp ?? true}
                  onChange={(next) => update("adaptiveMtp", next)}
                  disabled={!(draft.specMtp ?? true)}
                />
                <Field label={t("f.draftTokens")} hint="--draft-tokens">
                  <input
                    type="number"
                    min="1"
                    max="8"
                    step="1"
                    disabled={!(draft.specMtp ?? true)}
                    value={draft.draftTokens ?? 2}
                    onChange={number("draftTokens")}
                  />
                </Field>
                <Field label={t("f.ngramDraftTokens")} hint="--ngram-draft-tokens">
                  <input
                    type="number"
                    min="0"
                    max="8"
                    step="1"
                    value={draft.ngramDraftTokens ?? 0}
                    onChange={number("ngramDraftTokens")}
                  />
                </Field>
              </div>
            ) : (
              <div className="form-grid">
                {mtpMode === "none" && (
                  <Field label={t("f.specMode")} hint="--spec-type">
                    <select value={mtpMode} onChange={(e) => changeSpecMode(e.target.value as "none" | "mtp" | "draft")}>
                      <option value="none">{t("spec.off")}</option>
                      <option value="mtp">{t("spec.builtin")}</option>
                      <option value="draft">{t("spec.external")}</option>
                    </select>
                  </Field>
                )}
                {mtpMode !== "none" && (
                  <>
                    <div className="form-grid two spec-two">
                      <Field label={t("f.specMode")} hint="--spec-type">
                        <select value={mtpMode} onChange={(e) => changeSpecMode(e.target.value as "none" | "mtp" | "draft")}>
                          <option value="none">{t("spec.off")}</option>
                          <option value="mtp">{t("spec.builtin")}</option>
                          <option value="draft">{t("spec.external")}</option>
                        </select>
                      </Field>
                      <Field label={t("f.specDraftNMax")} hint="--spec-draft-n-max">
                        <input type="number" min="1" step="1" value={draft.specDraftNMax} onChange={number("specDraftNMax")} />
                      </Field>
                    </div>
                    {mtpMode === "draft" && (
                      <Field label={t("f.draftModelPath")} hint="-md">
                        <PickerGroup value={draft.mtpDraftPath ?? ""} placeholder={t("filePicker.externalPlaceholder")} browseLabel={t("browse")} replaceLabel={t("filePicker.replace")} clearLabel={t("filePicker.clear")} onPick={attachMtpDraft} onClear={() => { update("mtpDraftPath", undefined); setMtpDraftError(null); }} />
                      </Field>
                    )}
                  </>
                )}
                {mtpDraftError && <p className="import-error">{mtpDraftError}</p>}
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>{isNinfer ? "07" : "08"}</span><div><h3>{t("ed.s7Title")}</h3><p>{t("ed.s7Desc")}</p></div></div>
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
                        kvDtype: draft.kvDtype || "rk8v4",
                        prefillChunk: draft.prefillChunk ?? 512,
                        fastPrefillKernel: draft.fastPrefillKernel ?? true,
                        cudaMemoryPolicy: draft.cudaMemoryPolicy || "mixed",
                        deviceIndex: draft.deviceIndex ?? 0,
                        deviceProfile: "auto",
                        specMtp: draft.specMtp ?? true,
                        draftTokens: draft.draftTokens ?? 2,
                        adaptiveMtp: draft.adaptiveMtp ?? true,
                        ngramDraftTokens: draft.ngramDraftTokens ?? 0,
                        defaultMaxTokens: Math.max(0, Math.trunc(draft.defaultMaxTokens ?? 0)),
                        topK: typeof draft.topK === "number" && draft.topK > 0 ? Math.min(20, Math.trunc(draft.topK)) : undefined,
                        seed: typeof draft.seed === "number" && draft.seed >= 0 ? Math.trunc(draft.seed) : undefined,
                        cudaGraphAllowanceMib: typeof draft.cudaGraphAllowanceMib === "number" && draft.cudaGraphAllowanceMib >= 0 ? Math.trunc(draft.cudaGraphAllowanceMib) : undefined,
                        ...(isNinferKvmem
                          ? {
                              kvmemBudget: draft.kvmemBudget ?? 16384,
                              kvmemGenReserve: draft.kvmemGenReserve ?? 4096,
                              kvmemHostMib: draft.kvmemHostMib ?? 16384,
                              kvmemSessions: draft.kvmemSessions ?? 4,
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
