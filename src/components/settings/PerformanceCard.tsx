import { Activity, Check, ChevronDown, GripVertical, Plus, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DEFAULT_PERF_ORDER, PERF_ITEM_IDS, PERF_ITEM_STYLES, resolvePerfConfig, uid } from "../../data";
import { useI18n } from "../../i18n";
import { getGpuInfo, type GpuInfo } from "../../tauri";
import type { AppConfig, PerfItemId, PerfItemStyle, PerfPreset } from "../../types";
import { cn } from "../../utils";

type PerfField = "gpuMonitorEnabled" | "vramMonitorEnabled" | "monitorCpuEnabled" | "monitorMemoryEnabled";

const ITEM_FIELD: Record<PerfItemId, PerfField> = {
  gpu: "gpuMonitorEnabled",
  vram: "vramMonitorEnabled",
  cpu: "monitorCpuEnabled",
  memory: "monitorMemoryEnabled",
};

type PresetKind = "classic" | "text-chart" | "charts";

interface Preset {
  kind: PresetKind;
  label: string;
  order: PerfItemId[];
  styles: Record<PerfItemId, PerfItemStyle>;
}

interface Props {
  config: AppConfig;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
}

const MAX_SAVED_PRESETS = 8;
const MAX_PRESET_NAME = 24;

/** 性能监测卡片：两行紧凑布局，指标显隐 / 尺寸 / 排序收进默认折叠的抽屉 */
export default function PerformanceCard({ config, onPersist }: Props) {
  const { t } = useI18n();
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState<string | null>(null);
  const [dragId, setDragId] = useState<PerfItemId | null>(null);
  const [previewOrder, setPreviewOrder] = useState<PerfItemId[] | null>(null);
  const dragRef = useRef<{ id: PerfItemId; order: PerfItemId[] } | null>(null);
  useEffect(() => { void getGpuInfo().then(setGpuInfo).catch(() => undefined); }, []);

  const perf = resolvePerfConfig(config);
  const enabled = perf.enabled;
  const { items, order, styles } = perf;
  const visibleOrder = previewOrder ?? order;

  const labelOf = (id: PerfItemId) => {
    switch (id) {
      case "gpu": return t("perf.itemGpu");
      case "vram": return t("perf.itemVram");
      case "cpu": return t("perf.itemCpu");
      case "memory": return t("perf.itemMemory");
    }
  };

  const styleLabel = (style: PerfItemStyle) => {
    switch (style) {
      case "large": return t("st.perfStyleLarge");
      case "medium": return t("st.perfStyleMedium");
      case "small": return t("st.perfStyleSmall");
      case "text": return t("st.perfStyleText");
    }
  };

  const presets: Preset[] = [
    { kind: "classic", label: t("st.perfPresetClassic"), order: [...DEFAULT_PERF_ORDER], styles: { gpu: "medium", vram: "medium", cpu: "text", memory: "text" } },
    { kind: "text-chart", label: t("st.perfPresetTextChart"), order: [...DEFAULT_PERF_ORDER], styles: { gpu: "large", vram: "text", cpu: "text", memory: "text" } },
    { kind: "charts", label: t("st.perfPresetCharts"), order: [...DEFAULT_PERF_ORDER], styles: { gpu: "small", vram: "small", cpu: "small", memory: "small" } },
  ];
  const activePreset = presets.find((preset) => preset.order.every((id, index) => order[index] === id) && PERF_ITEM_IDS.every((id) => styles[id] === preset.styles[id]))?.kind;

  const device = gpuInfo === null
    ? { text: t("gpu.detectingShort"), tone: "pending", hint: t("gpu.detecting") }
    : gpuInfo.vendor === "nvidia"
      ? { text: "NVIDIA", tone: "ok", hint: t("gpu.nvidia") }
      : gpuInfo.vendor === "amd"
        ? { text: "AMD", tone: "warn", hint: t("gpu.amd") }
        : { text: t("gpu.noneShort"), tone: "warn", hint: t("gpu.none") };

  const toggleMaster = () => {
    const next = !enabled;
    void onPersist({ ...config, perfMonitorEnabled: next }, next ? t("toast.perfOn") : t("toast.perfOff"));
  };

  const toggleItem = (id: PerfItemId) => {
    const next = !items[id];
    const label = labelOf(id);
    const payload: AppConfig = { ...config, [ITEM_FIELD[id]]: next };
    // 旧配置的显存开关缺省时跟随 GPU 开关：关闭 GPU 时固化当前值，避免被连带关闭
    if (id === "gpu") payload.vramMonitorEnabled = items.vram;
    void onPersist(payload, next ? t("toast.perfItemOn", { label }) : t("toast.perfItemOff", { label }));
  };

  const toggleEnv = (key: "power" | "temp") => {
    const next = !perf.env[key];
    void onPersist({ ...config, [key === "power" ? "powerMonitorEnabled" : "gpuTempEnabled"]: next });
  };

  const applyPreset = (preset: Preset) => {
    void onPersist({ ...config, perfItemOrder: preset.order, perfItemStyles: preset.styles }, t("toast.perfPreset", { label: preset.label }));
  };

  const isSavedActive = (preset: PerfPreset) =>
    preset.order.every((id, index) => order[index] === id) && PERF_ITEM_IDS.every((id) => styles[id] === preset.styles[id]);

  const applySavedPreset = (preset: PerfPreset) => {
    void onPersist({ ...config, perfItemOrder: [...preset.order], perfItemStyles: { ...preset.styles } }, t("toast.perfPreset", { label: preset.name }));
  };

  const openPresetEditor = () => {
    const used = new Set(perf.presets.map((preset) => preset.name));
    let index = 1;
    while (used.has(t("st.perfPresetDefault", { n: index }))) index += 1;
    setPresetDraft(t("st.perfPresetDefault", { n: index }));
  };

  const savePreset = () => {
    if (presetDraft === null) return;
    const name = presetDraft.trim().slice(0, MAX_PRESET_NAME);
    if (!name) return;
    const existing = perf.presets.find((preset) => preset.name === name);
    const nextPreset: PerfPreset = { id: existing?.id ?? uid("perf-preset"), name, order: [...order], styles: { ...styles } };
    const next = existing
      ? perf.presets.map((preset) => (preset.id === existing.id ? nextPreset : preset))
      : [...perf.presets, nextPreset];
    setPresetDraft(null);
    void onPersist({ ...config, perfPresets: next }, t(existing ? "toast.perfPresetUpdated" : "toast.perfPresetSaved", { name }));
  };

  const deletePreset = (preset: PerfPreset) => {
    void onPersist({ ...config, perfPresets: perf.presets.filter((item) => item.id !== preset.id) }, t("toast.perfPresetDeleted", { name: preset.name }));
  };

  const setStyle = (id: PerfItemId, style: PerfItemStyle) => {
    if (styles[id] === style) return;
    void onPersist({ ...config, perfItemStyles: { ...styles, [id]: style } });
  };

  const startDrag = (id: PerfItemId) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id, order: [...order] };
    setDragId(id);
    setPreviewOrder([...order]);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-perf-id]");
    const overId = target?.dataset.perfId as PerfItemId | undefined;
    if (!overId || overId === drag.id) return;
    const from = drag.order.indexOf(drag.id);
    const to = drag.order.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...drag.order];
    next.splice(from, 1);
    next.splice(to, 0, drag.id);
    drag.order = next;
    setPreviewOrder(next);
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragId(null);
    setPreviewOrder(null);
    if (!drag || drag.order.every((id, index) => order[index] === id)) return;
    void onPersist({ ...config, perfItemOrder: drag.order });
  };

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-icon"><Activity size={16} /></div>
        <h3>{t("st.perfTitle")}</h3>
        <span className={cn("perf-device", `tone-${device.tone}`)} title={device.hint}>
          <i className="perf-device-dot" />
          {device.text}
        </span>
        <div className="settings-card-header-actions">
          <button className={"switch" + (enabled ? " on" : "")} onClick={toggleMaster} role="switch" aria-checked={enabled} aria-label={t("st.perfMaster")} title={t("st.perfMaster")}>
            <span className="switch-knob" />
          </button>
        </div>
      </div>
      <div className="perf-toolbar">
        <span className="perf-field-label">{t("st.perfPresets")}</span>
        <div className="perf-segmented" role="group" aria-label={t("st.perfPresets")}>
          {presets.map((preset) => (
            <button
              key={preset.kind}
              type="button"
              className={activePreset === preset.kind ? "on" : ""}
              onClick={() => applyPreset(preset)}
              disabled={!enabled}
              aria-pressed={activePreset === preset.kind}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <span className="perf-divider" aria-hidden="true" />
        <div className="perf-saved-list">
          {perf.presets.map((preset) => (
            <span key={preset.id} className={"perf-saved-chip" + (isSavedActive(preset) ? " on" : "")}>
              <button
                type="button"
                className="perf-saved-apply"
                onClick={() => applySavedPreset(preset)}
                disabled={!enabled}
                aria-pressed={isSavedActive(preset)}
                title={preset.name}
              >
                {preset.name}
              </button>
              <button
                type="button"
                className="perf-saved-delete"
                onClick={() => deletePreset(preset)}
                disabled={!enabled}
                title={t("st.perfPresetDelete", { name: preset.name })}
                aria-label={t("st.perfPresetDelete", { name: preset.name })}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {perf.presets.length === 0 && presetDraft === null && (
            <span className="perf-presets-empty">{t("st.perfPresetsEmpty")}</span>
          )}
          {presetDraft === null ? (
            <button
              type="button"
              className="perf-save-preset"
              onClick={openPresetEditor}
              disabled={!enabled || perf.presets.length >= MAX_SAVED_PRESETS}
              title={perf.presets.length >= MAX_SAVED_PRESETS ? t("st.perfPresetLimit", { n: MAX_SAVED_PRESETS }) : t("st.perfSavePreset")}
            >
              <Plus size={13} />
              {t("st.perfSavePreset")}
            </button>
          ) : (
            <span className="perf-preset-editor">
              <input
                autoFocus
                value={presetDraft}
                maxLength={MAX_PRESET_NAME}
                placeholder={t("st.perfPresetName")}
                aria-label={t("st.perfPresetName")}
                onChange={(event) => setPresetDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") savePreset();
                  if (event.key === "Escape") setPresetDraft(null);
                }}
              />
              <button type="button" className="perf-preset-confirm" onClick={savePreset} disabled={!presetDraft.trim()} title={t("st.perfSavePreset")} aria-label={t("st.perfSavePreset")}>
                <Check size={13} strokeWidth={2.6} />
              </button>
              <button type="button" className="perf-preset-cancel" onClick={() => setPresetDraft(null)} title={t("st.perfPresetCancel")} aria-label={t("st.perfPresetCancel")}>
                <X size={13} />
              </button>
            </span>
          )}
        </div>
      </div>
      <div className="perf-scope-row">
        <span className="perf-field-label">{t("st.perfScope")}</span>
        {order.map((id) => (
          <button
            key={id}
            type="button"
            className={"perf-check" + (items[id] ? " on" : "")}
            role="checkbox"
            aria-checked={items[id]}
            onClick={() => toggleItem(id)}
            disabled={!enabled}
          >
            <span className="perf-check-box" aria-hidden="true">{items[id] && <Check size={10} strokeWidth={3.5} />}</span>
            {labelOf(id)}
          </button>
        ))}
        {([
          { key: "power", label: t("perf.itemPower") },
          { key: "temp", label: t("perf.itemTemp") },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={"perf-check" + (perf.env[key] ? " on" : "")}
            role="checkbox"
            aria-checked={perf.env[key]}
            onClick={() => toggleEnv(key)}
            disabled={!enabled}
          >
            <span className="perf-check-box" aria-hidden="true">{perf.env[key] && <Check size={10} strokeWidth={3.5} />}</span>
            {label}
          </button>
        ))}
        <button
          type="button"
          className={"perf-customize" + (customOpen ? " open" : "")}
          aria-expanded={customOpen}
          onClick={() => setCustomOpen((open) => !open)}
          disabled={!enabled}
        >
          <SlidersHorizontal size={14} />
          {t("st.perfCustomize")}
          <ChevronDown size={14} className="perf-customize-chevron" />
        </button>
      </div>
      {customOpen && (
        <div className="perf-drawer">
          {visibleOrder.map((id) => (
            <div
              key={id}
              data-perf-id={id}
              className={cn("perf-metric", !items[id] && "off", dragId === id && "dragging")}
            >
              <button
                type="button"
                className="perf-grip"
                aria-label={t("st.perfDragHandle")}
                title={t("st.perfDragHandle")}
                disabled={!enabled}
                onPointerDown={startDrag(id)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <GripVertical size={14} />
              </button>
              <span className="perf-metric-title">
                <i className={cn("perf-metric-dot", `tone-${id}`)} />
                <span className="perf-metric-name">{labelOf(id)}</span>
              </span>
              <div className="perf-size" role="group" aria-label={t("st.perfStyleFor", { label: labelOf(id) })}>
                {PERF_ITEM_STYLES[id].map((style) => (
                  <button
                    key={style}
                    type="button"
                    className={styles[id] === style ? "on" : ""}
                    onClick={() => setStyle(id, style)}
                    disabled={!enabled || !items[id]}
                    aria-pressed={styles[id] === style}
                  >
                    {styleLabel(style)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="perf-drawer-hint">{t("st.perfDragHint")}</p>
        </div>
      )}
    </div>
  );
}
