import { FolderOpen, Save, SlidersHorizontal, X, Zap } from "lucide-react";
import { useI18n } from "../i18n";
import { useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { pickFiles } from "../tauri";
import type { ModelAsset, Profile } from "../types";
import { fileName, cn } from "../utils";

const CACHE_TYPES = ["f32", "f16", "q8_0", "q4_0"];
const LOAD_MODES = ["mmap", "mlock", "ragged", "row", "direct"];
const REASONING_MODES = ["auto", "on", "off"];
const REASONING_EFFORTS = ["auto", "low", "medium", "high", "xhigh"];


type ToggleFieldProps = {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  icon?: ReactNode;
};

function ToggleField({ label, hint, checked, onChange, icon }: ToggleFieldProps) {
  return (
    <button type="button" className={cn("toggle-row", checked && "enabled")} aria-pressed={checked} title={hint} onClick={() => onChange(!checked)}>
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

export default function ProfileEditor({ model, profile, defaultProfileId, onClose, onSave }: { model?: ModelAsset; profile: Profile; defaultProfileId?: string; onClose: () => void; onSave: (profile: Profile, isDefault: boolean) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(profile);
  const [isDefault, setIsDefault] = useState(profile.id === defaultProfileId);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [mtpDraftError, setMtpDraftError] = useState<string | null>(null);
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
          <div>
            <div className="editor-icon"><SlidersHorizontal size={19} /></div>
            <div><span>RUNTIME PROFILE</span><h2>{t("editorTitle")}{model ? ` · ${fileName(model.path)}` : ""}</h2></div>
          </div>
          <button className="ghost-icon" onClick={onClose}><X size={19} /></button>
        </header>
        <div className="editor-body">
          <div className="form-section">
            <div className="form-section-title"><span>01</span><div><h3>{t("ed.s1Title")}</h3><p>{t("ed.s1Desc")}</p></div></div>
            <div className="form-grid three">
              <Field label={t("f.name")}><input value={draft.name} onChange={(e) => update("name", e.target.value)} /></Field>
              <Field label={t("f.host")} hint="--host"><input value={draft.host} onChange={(e) => update("host", e.target.value)} /></Field>
              <Field label={t("f.port")} hint="--port"><input type="number" value={draft.port} onChange={number("port")} /></Field>
              <Field label={t("f.description")} wide><input value={draft.description} onChange={(e) => update("description", e.target.value)} /></Field>
              <Field label={t("f.defaultConfig")} wide><ToggleField label={t("f.defaultToggle")} checked={isDefault} onChange={setIsDefault} /></Field>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>02</span><div><h3>{t("ed.s2Title")}</h3><p>{t("ed.s2Desc")}</p></div></div>
            <div className="form-grid three">
              <Field label={t("f.gpuLayers")} hint="-ngl"><input type="number" min="0" value={draft.gpuLayers} onChange={number("gpuLayers")} /></Field>
              <Field label={t("f.contextLength")} hint="-c"><input type="number" min="512" step="512" value={draft.contextSize} onChange={number("contextSize")} /></Field>
              <Field label={t("f.cpuThreads")} hint="-t"><input type="number" min="1" value={draft.threads} onChange={number("threads")} /></Field>
              <Field label={t("f.parallelSlots")} hint="-np"><input type="number" min="1" value={draft.parallel} onChange={number("parallel")} /></Field>
              <Field label="Batch Size" hint="-b"><input type="number" min="32" step="32" value={draft.batchSize} onChange={number("batchSize")} /></Field>
              <Field label="Ubatch Size" hint="-ub"><input type="number" min="32" step="32" value={draft.ubatchSize} onChange={number("ubatchSize")} /></Field>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>03</span><div><h3>{t("ed.s3Title")}</h3><p>{t("ed.s3Desc")}</p></div></div>
            <div className="form-grid compact">
              <ToggleField label={t("f.faToggle")} hint="-fa on" icon={<Zap size={14} />} checked={draft.flashAttention} onChange={(next) => update("flashAttention", next)} />
              <ToggleField label={t("f.jinjaToggle")} hint="--jinja" checked={draft.jinja} onChange={(next) => update("jinja", next)} />
              <Field label={t("f.ncmoe")} hint="-ncmoe"><input type="number" min="0" step="1" value={draft.ncmoeLayers} onChange={number("ncmoeLayers")} /></Field>
              <Field label={t("f.loadMode")} hint="--load-mode"><select value={draft.loadMode} onChange={select("loadMode")}>{LOAD_MODES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
              <Field label={t("f.kvCacheK")} hint="--cache-type-k"><select value={draft.cacheTypeK} onChange={select("cacheTypeK")}>{CACHE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
              <Field label={t("f.kvCacheV")} hint="--cache-type-v"><select value={draft.cacheTypeV} onChange={select("cacheTypeV")}>{CACHE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>04</span><div><h3>{t("ed.s4Title")}</h3><p>{t("ed.s4Desc")}</p></div></div>
            <div className="form-grid two">
              <Field label={t("f.reasoningMode")} hint="--reasoning"><select value={draft.reasoning} onChange={select("reasoning")}>{REASONING_MODES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
              <Field label={t("f.reasoningEffort")} hint="--reasoning-effort"><select value={draft.reasoningEffort} onChange={select("reasoningEffort")}>{REASONING_EFFORTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>05</span><div><h3>{t("ed.s5Title")}</h3><p>{t("ed.s5Desc")}</p></div></div>
            <div className="form-grid four">
              <Field label="Temperature"><input type="number" min="0" max="2" step="0.05" value={draft.temperature} onChange={number("temperature")} /></Field>
              <Field label="Top-P"><input type="number" min="0" max="1" step="0.01" value={draft.topP} onChange={number("topP")} /></Field>
              <Field label="Min-P"><input type="number" min="0" max="1" step="0.01" value={draft.minP} onChange={number("minP")} /></Field>
              <Field label="Repeat Penalty"><input type="number" min="0" step="0.01" value={draft.repeatPenalty} onChange={number("repeatPenalty")} /></Field>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>06</span><div><h3>{t("ed.s6Title")}</h3><p>{t("ed.s6Desc")}</p></div></div>
            <div className="form-grid">
              <Field label={t("f.visionModel")} hint="--mmproj">
                <PickerGroup value={draft.mmprojPath ?? ""} placeholder={t("mmproj.placeholder")} browseLabel={t("browse")} replaceLabel={t("filePicker.replace")} clearLabel={t("filePicker.clear")} onPick={attachMmproj} onClear={() => { update("mmprojPath", undefined); setVisionError(null); }} />
                {visionError && <p className="import-error">{visionError}</p>}
              </Field>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>07</span><div><h3>{t("ed.s8Title")}</h3><p>{t("ed.s8Desc")}</p></div></div>
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
          </div>
          <div className="form-section">
            <div className="form-section-title"><span>08</span><div><h3>{t("ed.s7Title")}</h3><p>{t("ed.s7Desc")}</p></div></div>
            <Field label="Extra Arguments" hint={t("f.extraHint")}><textarea value={draft.extraArgs} onChange={(e) => update("extraArgs", e.target.value)} placeholder="--no-warmup --cont-batching" /></Field>
          </div>
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose}>{t("cancel")}</button>
          <button className="primary-button" onClick={() => onSave({ ...draft, mtpDraftPath: draft.mtpDraftPath?.trim() || undefined }, isDefault)}><Save size={16} />{t("saveProfile")}</button>
        </footer>
      </section>
    </div>
  );
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <div className={cn("field", wide && "wide")}><span>{label}{hint && <em>{hint}</em>}</span>{children}</div>;
}
