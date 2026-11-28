import {
  Boxes,
  Check,
  ChevronDown,
  FlaskConical,
  Globe,
  GripVertical,
  Lock,
  MessageSquareText,
  PanelLeft,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DEFAULT_SIDEBAR_NAV_ORDER, HIDEABLE_SIDEBAR_PAGES, resolveSidebarNav } from "../../data";
import { useI18n } from "../../i18n";
import type { AppConfig, Page } from "../../types";
import { cn } from "../../utils";

interface Props {
  config: AppConfig;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
}

const CORE_SIDEBAR_PAGES = new Set<Page>(["models", "profiles", "settings"]);

/** 侧边栏导航管理卡：默认仅显示紧凑勾选栏，展开后支持按住手柄拖动全量菜单顺序（含设置） */
export default function SidebarNavCard({ config, onPersist }: Props) {
  const { t } = useI18n();
  const [sortOpen, setSortOpen] = useState(false);
  const [dragId, setDragId] = useState<Page | null>(null);
  const [previewOrder, setPreviewOrder] = useState<Page[] | null>(null);
  const dragRef = useRef<{ id: Page; order: Page[] } | null>(null);

  const sidebarNav = resolveSidebarNav(config);
  const visibleOrder = previewOrder ?? sidebarNav.order;
  const visibleCount = sidebarNav.visiblePages.length;
  const totalCount = sidebarNav.order.length;

  const isDefaultOrder = sidebarNav.order.every((id, idx) => id === DEFAULT_SIDEBAR_NAV_ORDER[idx]);
  const isDefaultVisibility =
    !sidebarNav.hidden.has("explore") &&
    !sidebarNav.hidden.has("playground") &&
    !sidebarNav.hidden.has("logs") &&
    config.labEnabled !== false;
  const isMenuCustomized = !isDefaultOrder || !isDefaultVisibility;

  const navMeta: Record<Page, { label: string; icon: LucideIcon }> = {
    models: { label: t("nav.models"), icon: Boxes },
    profiles: { label: t("nav.profiles"), icon: SlidersHorizontal },
    explore: { label: t("nav.explore"), icon: Globe },
    playground: { label: t("nav.playground"), icon: MessageSquareText },
    logs: { label: t("nav.logs"), icon: SquareTerminal },
    lab: { label: t("nav.lab"), icon: FlaskConical },
    settings: { label: t("nav.settings"), icon: Settings },
  };

  const toggleSidebarItem = (id: Page) => {
    if (CORE_SIDEBAR_PAGES.has(id)) return;
    if (id === "lab") {
      const next = !config.labEnabled;
      void onPersist({ ...config, labEnabled: next }, next ? t("toast.labOn") : t("toast.labOff"));
      return;
    }
    const label = navMeta[id].label;
    const currentlyVisible = !sidebarNav.hidden.has(id);
    const nextHidden = new Set(sidebarNav.hidden);
    nextHidden.delete("lab");
    if (currentlyVisible) {
      nextHidden.add(id);
    } else {
      nextHidden.delete(id);
    }
    const serialized = Array.from(nextHidden);
    void onPersist(
      { ...config, sidebarHiddenPages: serialized.length ? serialized : undefined },
      currentlyVisible ? t("toast.sidebarMenuHidden", { label }) : t("toast.sidebarMenuShown", { label }),
    );
  };

  const resetSidebarMenu = () => {
    void onPersist(
      {
        ...config,
        sidebarNavOrder: undefined,
        sidebarHiddenPages: undefined,
        labEnabled: true,
      },
      t("toast.sidebarMenuReset"),
    );
  };

  const startDrag = (id: Page) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id, order: [...sidebarNav.order] };
    setDragId(id);
    setPreviewOrder([...sidebarNav.order]);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-nav-id]");
    const overId = target?.dataset.navId as Page | undefined;
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
    if (!drag || drag.order.every((id, index) => sidebarNav.order[index] === id)) return;
    const sameAsDefault = drag.order.every((id, idx) => id === DEFAULT_SIDEBAR_NAV_ORDER[idx]);
    void onPersist({
      ...config,
      sidebarNavOrder: sameAsDefault ? undefined : drag.order,
    });
  };

  const hideableOrder = sidebarNav.order.filter((id) => HIDEABLE_SIDEBAR_PAGES.includes(id));

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-icon"><PanelLeft size={16} /></div>
        <h3>{t("st.sidebarMenuTitle")}</h3>
        <span className="nav-menu-count-pill">
          {t("st.sidebarMenuCount", { visible: visibleCount, total: totalCount })}
        </span>
        <div className="settings-card-header-actions">
          <button
            type="button"
            className="secondary-button compact nav-reset-btn"
            disabled={!isMenuCustomized}
            onClick={resetSidebarMenu}
          >
            <RotateCcw size={12} />
            {t("st.sidebarMenuReset")}
          </button>
        </div>
      </div>

      <div className="perf-scope-row nav-scope-row">
        <span className="perf-field-label">{t("st.sidebarMenuScope")}</span>
        {hideableOrder.map((id) => {
          const checked = !sidebarNav.hidden.has(id);
          const isLab = id === "lab";
          return (
            <button
              key={id}
              type="button"
              className={"perf-check" + (checked ? " on" : "")}
              role="checkbox"
              aria-checked={checked}
              title={isLab ? t("st.sidebarMenuLabNote") : undefined}
              onClick={() => toggleSidebarItem(id)}
            >
              <span className="perf-check-box" aria-hidden="true">
                {checked && <Check size={10} strokeWidth={3.5} />}
              </span>
              <span>{navMeta[id].label}</span>
              {isLab && <em className="nav-lab-pill">{t("st.sidebarMenuLabPill")}</em>}
            </button>
          );
        })}
        <button
          type="button"
          className={"perf-customize" + (sortOpen ? " open" : "")}
          aria-expanded={sortOpen}
          onClick={() => setSortOpen((open) => !open)}
        >
          <SlidersHorizontal size={14} />
          {t("st.sidebarMenuReorder")}
          <ChevronDown size={14} className="perf-customize-chevron" />
        </button>
      </div>

      {sortOpen && (
        <div className="perf-drawer">
          {visibleOrder.map((id) => {
            const meta = navMeta[id];
            const Icon = meta.icon;
            const isCore = CORE_SIDEBAR_PAGES.has(id);
            const isLab = id === "lab";
            const visible = !sidebarNav.hidden.has(id);
            return (
              <div
                key={id}
                data-nav-id={id}
                className={cn("nav-menu-row", !visible && "off", dragId === id && "dragging")}
              >
                <button
                  type="button"
                  className="perf-grip"
                  aria-label={t("st.perfDragHandle")}
                  title={t("st.perfDragHandle")}
                  onPointerDown={startDrag(id)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  <GripVertical size={14} />
                </button>
                <div className="nav-menu-item-info">
                  <Icon size={14} className="nav-menu-item-icon" />
                  <span className="nav-menu-item-label">{meta.label}</span>
                  {isLab && <span className="nav-menu-tag lab">{t("st.sidebarMenuLabPill")}</span>}
                </div>
                <div className="nav-menu-item-action">
                  {isCore ? (
                    <span className="nav-menu-locked">
                      <Lock size={11} />
                      {t("st.sidebarMenuAlwaysShown")}
                    </span>
                  ) : !visible ? (
                    <span className="nav-menu-hidden-state">{t("st.sidebarMenuHiddenState")}</span>
                  ) : null}
                </div>
              </div>
            );
          })}
          <p className="perf-drawer-hint">{t("st.sidebarMenuDragHint")}</p>
        </div>
      )}
    </div>
  );
}
