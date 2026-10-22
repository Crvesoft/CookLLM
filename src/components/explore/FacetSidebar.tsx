import { ChevronLeft, SlidersHorizontal } from "lucide-react";
import { useI18n } from "../../i18n";
import { cn } from "../../utils";
import {
  FAMILIES,
  PARAM_LAST_INDEX,
  PARAM_SLIDER_LABELS,
  QUANTS,
  TASKS,
  type FamilyKey,
  type TaskKey,
} from "./modelUtils";

/* ---------------- 左侧刻面筛选侧边栏 ---------------- */

interface FacetSidebarProps {
  mobileOpen: boolean;
  collapsed: boolean;
  family: FamilyKey;
  quantBits: number[];
  tasks: TaskKey[];
  paramMin: number;
  paramMax: number;
  onSelectFamily: (key: FamilyKey) => void;
  onToggleQuant: (bits: number) => void;
  onSelectAllQuant: () => void;
  onToggleTask: (key: TaskKey) => void;
  onParamMin: (value: number) => void;
  onParamMax: (value: number) => void;
  onResetParams: () => void;
  onResetAll: () => void;
  onToggleCollapsed: () => void;
}

export default function FacetSidebar({ mobileOpen, collapsed, family, quantBits, tasks, paramMin, paramMax, onSelectFamily, onToggleQuant, onSelectAllQuant, onToggleTask, onParamMin, onParamMax, onResetParams, onResetAll, onToggleCollapsed }: FacetSidebarProps) {
  const { t } = useI18n();
  const lockRange = `${PARAM_SLIDER_LABELS[paramMin]} ~ ${PARAM_SLIDER_LABELS[paramMax]}`;
  const pctLeft = (paramMin / PARAM_LAST_INDEX) * 100;
  const pctWidth = ((paramMax - paramMin) / PARAM_LAST_INDEX) * 100;

  return (
    <aside className={cn("facet-sidebar", mobileOpen && "facet-mobile-open", collapsed && "facet-sidebar-collapsed")}>
      <div className="facet-sidebar-head">
        <strong className="facet-sidebar-title"><SlidersHorizontal size={14} />{t("explore.facetSidebar")}</strong>
        <div className="facet-sidebar-actions">
          <button className="facet-collapse-btn" onClick={onToggleCollapsed} title={collapsed ? t("explore.facetExpand") : t("explore.facetCollapse")} aria-label={collapsed ? t("explore.facetExpand") : t("explore.facetCollapse")}>
            <ChevronLeft size={16} className={cn("facet-collapse-icon", collapsed && "rotated")} />
          </button>
          <button className="facet-reset-all" onClick={onResetAll}>{t("explore.facetReset")}</button>
        </div>
      </div>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetFamily")}</strong>
        </div>
        <div className="facet-chips">
          {FAMILIES.map((item) => (
            <button key={item.key} className={cn("facet-chip", family === item.key && "active")} onClick={() => onSelectFamily(item.key)}>
              {item.label.startsWith("explore.") ? t(item.label as import("../../i18n").MessageKey) : item.label}
            </button>
          ))}
        </div>
      </section>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetParams")}</strong>
          <button className="facet-reset" onClick={onResetParams}>{t("explore.facetReset")}</button>
        </div>
        <div className="facet-range-wrap">
          <div className="facet-range-stack">
            <div className="facet-range-track"><span style={{ left: pctLeft + "%", width: Math.max(pctWidth, 0) + "%" }} /></div>
            <span className="facet-range-thumb-label" style={{ left: `calc(6px + ${pctLeft}% - ${pctLeft * 0.12}px)` }}>{PARAM_SLIDER_LABELS[paramMin]}</span>
            <span className="facet-range-thumb-label" style={{ left: `calc(6px + ${(pctLeft + pctWidth)}% - ${(pctLeft + pctWidth) * 0.12}px)` }}>{PARAM_SLIDER_LABELS[paramMax]}</span>
            <input type="range" className="facet-range facet-range-min" min={0} max={PARAM_LAST_INDEX} step={1} value={paramMin} onChange={(event) => onParamMin(Number(event.target.value))} />
            <input type="range" className="facet-range facet-range-max" min={0} max={PARAM_LAST_INDEX} step={1} value={paramMax} onChange={(event) => onParamMax(Number(event.target.value))} />
          </div>
          <div className="facet-range-scale">
            {PARAM_SLIDER_LABELS.map((label) => <span key={label}>{label}</span>)}
          </div>
          {(paramMin > 0 || paramMax < PARAM_LAST_INDEX) && (
            <div className="facet-lock-line">{t("explore.facetParamsLocked", { range: lockRange })}</div>
          )}
        </div>
      </section>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetQuant")}</strong>
        </div>
        <div className="facet-chips facet-chips-quant">
          <button className={cn("facet-chip", quantBits.length === 0 && "active")} onClick={onSelectAllQuant}>{t("explore.quantAll")}</button>
          {QUANTS.map((item) => (
            <button key={item.key} className={cn("facet-chip", item.cls, quantBits.includes(item.bits[0]) && "active")} onClick={() => onToggleQuant(item.bits[0])} title={t(item.label as import("../../i18n").MessageKey)}>
              {t(item.label as import("../../i18n").MessageKey)}
            </button>
          ))}
        </div>
      </section>

      <section className="facet-section">
        <div className="facet-section-title">
          <strong>{t("explore.facetTasks")}</strong>
        </div>
        <div className="facet-chips facet-chips-tasks">
          {TASKS.map((item) => (
            <button key={item.key} className={cn("facet-chip", tasks.includes(item.key) && "active")} onClick={() => onToggleTask(item.key)}>
              {t(item.label as import("../../i18n").MessageKey)}
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
