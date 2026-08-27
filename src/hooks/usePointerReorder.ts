import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

/** 按下后移动超过该距离才开始拖动（px）；未超阈值视为普通点击 */
const DRAG_THRESHOLD = 6;
/** 拖起时的轻微放大，制造"拿起卡片"的观感（transform-origin 取左上角，贴指针公式可直接从视觉 rect 反推布局位置） */
const LIFT_SCALE = 1.03;
/** 松手后拖动卡片滑回插槽的时长（与兄弟卡片的滑动节奏一致） */
const SETTLE_MS = 200;
/** 换位冷却（ms）：刚换过位的卡片在 FLIP 动画期间视觉上仍压在指针旧位置，elementFromPoint 会反复命中它造成来回闪烁；覆盖一次换位动画时长即可 */
const REORDER_COOLDOWN_MS = 300;

export interface ReorderGroupDef<TC extends string> { readonly id: TC; readonly items: readonly string[] }

interface Options<TC extends string> {
  /** 当前可见的容器及其卡片顺序（即数据源的渲染顺序） */
  groups: ReadonlyArray<ReorderGroupDef<TC>>;
  /** 是否允许排序（如批量选择模式下禁用），默认 true */
  enabled?: boolean;
  /** 松手时提交该容器的最终预览顺序（消费方负责持久化；拖动过程只改本地渲染，不触发写盘） */
  onDrop?: (groupId: TC, finalItems: readonly string[]) => void;
}

/** 每张可排序卡片需要挂上的属性（展开到 <article> 上即可） */
export interface CardHandlers {
  "data-reorder-card": string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
}

/** 一次按压会话（按下到释放）；激活拖动后记录抓取点偏移与当前内联位移 */
interface PressSession<TC extends string> {
  groupId: TC; itemId: string; el: HTMLElement;
  x0: number; y0: number;   // 按下的指针坐标（点击阈值判定）
  gx: number; gy: number;   // 抓取点在卡片内的偏移（本地坐标，用于激活后贴合指针）
  tx: number; ty: number;   // 当前已写入的内联位移（从视觉 rect 反推布局位置用）
  active: boolean;          // 是否已越过阈值进入拖动
}

/**
 * 基于指针事件的卡片排序，带实时重排（替代原生 HTML5 draggable）。
 *
 * 为什么不用 HTML5 DnD：Tauri 内置的文件拖放 handler 在 Windows WebView2 上会对
 * webview 子窗口调用 OLE RegisterDragDrop，接管窗口内所有拖拽会话——只认文件数据，
 * 内部元素拖拽因此被直接取消（打包版无法拖动卡片；浏览器/dev 无此拦截所以正常）。
 * 指针事件不经过 OLE 会话，与 Tauri 的文件拖放可共存。
 *
 * 交互模型：激活后拖动卡片贴合指针并带抬升阴影；其余卡片实时让位——指针悬到同一
 * 容器的某张兄弟卡上时立即换位（React 重渲染），每次换位跑一遍 FLIP，兄弟卡片
 * 平滑滑到新插槽而不是瞬移。松手时拖动卡片带过渡滑回插槽（预览顺序即最终位置），
 * 随后经 onDrop 提交一次持久化。跨容器落点不响应（预设页"全部"视图的分组边界）。
 */
export function usePointerReorder<TC extends string>({ groups, enabled = true, onDrop }: Options<TC>) {
  /** 拖动期间各容器的预览顺序；空闲时为 null（= 跟随 groups） */
  const [orders, setOrders] = useState<Record<string, string[]> | null>(null);
  const [dragId, setDragId] = useState<{ groupId: TC; itemId: string } | null>(null);

  /** 按住但尚未释放的一次按压会话（同一时刻至多一个） */
  const pressRef = useRef<PressSession<TC> | null>(null);
  /** 换位渲染前一刻捕获的视觉 rect 快照，供本轮渲染后的 FLIP pass 消费 */
  const flipSnapshotRef = useRef<Map<string, { left: number; top: number }> | null>(null);
  /** 换位冷却："groupId:itemId" → 到期时间戳（FLIP 动画期间防止 elementFromPoint 反复命中刚换过位的卡片） */
  const cooldownRef = useRef<Map<string, number>>(new Map());

  // 全局监听只挂一次；回调一律走 ref 取最新值，避免闭包过期
  const groupsRef = useRef(groups); groupsRef.current = groups;
  const ordersRef = useRef(orders); ordersRef.current = orders;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const onDropRef = useRef(onDrop); onDropRef.current = onDrop;

  useEffect(() => {
    /** 命中检测：指针位置下的卡片及其容器；data-reorder-card 仅由本 hook 的 cardProps 写入 */
    const hitTest = (x: number, y: number): { groupId: TC; itemId: string } | null => {
      const el = document.elementFromPoint(x, y);
      const cardEl = el?.closest?.("[data-reorder-card]");
      if (!cardEl) return null;
      const itemId = (cardEl as HTMLElement).getAttribute("data-reorder-card");
      if (!itemId) return null;
      for (const group of groupsRef.current) {
        if (group.items.includes(itemId)) return { groupId: group.id, itemId };
      }
      return null;
    };

    /** 拖动激活：记录抓取点偏移与未变形 rect；此后每帧直接改 transform 让卡片贴住指针 */
    const activate = (press: PressSession<TC>) => {
      cooldownRef.current.clear(); // 新的按压会话，丢弃上次残留的冷却
      const base = press.el.getBoundingClientRect();
      press.gx = press.x0 - base.left;
      press.gy = press.y0 - base.top;
      press.tx = 0;
      press.ty = 0;
      press.active = true;
      // 拖动中的卡片不再参与命中检测（elementFromPoint 会跳过 pointer-events:none）
      press.el.style.pointerEvents = "none";
      // 贴指针期间每帧写 transform，禁用样式表过渡以免跟手出现橡皮筋式滞后；左上角缩放使位移公式不受 scale 干扰
      press.el.style.transition = "none";
      press.el.style.transformOrigin = "top left";
      document.body.classList.add("reordering");
      document.body.style.cursor = "grabbing";
      setDragId({ groupId: press.groupId, itemId: press.itemId });
    };

    const onMove = (event: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      const x = event.clientX;
      const y = event.clientY;
      if (!press.active) {
        if (Math.hypot(x - press.x0, y - press.y0) < DRAG_THRESHOLD) return;
        activate(press);
      }
      // 贴指针：从视觉 rect 反推当前布局位置（渲染左边缘 = 布局左 + tx，左上角原点），再求让抓取点落在指针上的新位移。直接改 DOM，不经过 React 渲染
      const visual = press.el.getBoundingClientRect();
      press.tx = x - (visual.left - press.tx) - LIFT_SCALE * press.gx;
      press.ty = y - (visual.top - press.ty) - LIFT_SCALE * press.gy;
      press.el.style.transform = `translate(${press.tx}px, ${press.ty}px) scale(${LIFT_SCALE})`;

      // 实时重排：指针悬到同容器兄弟卡上时立即换位——拖动卡落到该卡插槽，其余卡片顺移。
      const hit = hitTest(x, y);
      if (!hit || hit.groupId !== press.groupId || hit.itemId === press.itemId) return;
      // 换位冷却：刚换过位的卡片在 FLIP 动画期间视觉上仍压在指针旧位置，elementFromPoint 会反复命中它、触发来回换位（闪烁）；冷却期内忽略对它的再次命中。拖动跨越其他新卡片不受影响
      const cdKey = `${press.groupId}:${hit.itemId}`;
      const now = performance.now();
      const cdUntil = cooldownRef.current.get(cdKey);
      if (cdUntil !== undefined) {
        if (now < cdUntil) return;
        cooldownRef.current.delete(cdKey);
      }
      const order = ordersRef.current?.[press.groupId] ?? groupsRef.current.find((group) => group.id === press.groupId)?.items;
      if (!order) return;
      const from = order.indexOf(press.itemId);
      const to = order.indexOf(hit.itemId);
      if (from < 0 || to < 0 || from === to) return;
      // 换位渲染前捕获容器内卡片的视觉 rect（FLIP pass 用它把兄弟卡片从旧位置平滑滑到新插槽）
      const snapshot = new Map<string, { left: number; top: number }>();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-reorder-card]"))) {
        if (el === press.el) continue;
        const id = el.getAttribute("data-reorder-card");
        if (!id || !order.includes(id)) continue;
        const rect = el.getBoundingClientRect();
        snapshot.set(id, { left: rect.left, top: rect.top });
      }
      flipSnapshotRef.current = snapshot;
      const next = [...(order as string[])];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setOrders((previous) => ({ ...(previous ?? {}), [press.groupId]: next }));
      cooldownRef.current.set(cdKey, now + REORDER_COOLDOWN_MS);
    };

    /** 释放 / 取消：结束会话；预览顺序即所见位置，滑回后提交一次 */
    const finish = () => {
      const press = pressRef.current;
      if (!press) return;
      pressRef.current = null;
      cooldownRef.current.clear(); // 会话结束，冷却不再有意义
      document.body.classList.remove("reordering");
      document.body.style.cursor = "";
      if (press.active) {
        const el = press.el;
        // 归位：带过渡从当前 transform 滑到布局插槽（= 最终预览位置）；与状态复位、onDrop 同一帧提交，无中间帧闪烁
        el.style.transition = `transform ${SETTLE_MS}ms ease`;
        el.style.transform = "";
        el.style.pointerEvents = "";
        window.setTimeout(() => { if (el.isConnected) { el.style.transition = ""; el.style.transformOrigin = ""; } }, SETTLE_MS + 50);
        const finalItems = ordersRef.current?.[press.groupId];
        if (finalItems && finalItems.includes(press.itemId)) onDropRef.current?.(press.groupId, finalItems);
      }
      setOrders(null);
      setDragId(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    // 窗口失焦（鼠标在窗口外松开）也结束会话：按当前预览顺序提交，所见即所得
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      // 卸载时兜底还原全局状态（拖动中途切页不会残留 grabbing / reordering）
      document.body.style.cursor = "";
      document.body.classList.remove("reordering");
    };
  }, []);

  /** FLIP pass：换位渲染后把兄弟卡片从旧视觉位置平滑滑到新插槽。React 提交后、绘制前同步执行，无可见跳变 */
  useLayoutEffect(() => {
    const snapshot = flipSnapshotRef.current;
    if (!snapshot || !snapshot.size) return;
    flipSnapshotRef.current = null;
    // 阶段一：测量换位后的新布局位置（必须先于本轮任何样式写入完成，避免被进行中的过渡污染）
    const byId = new Map<string, HTMLElement>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-reorder-card]"))) {
      const id = el.getAttribute("data-reorder-card");
      if (!id || !snapshot.has(id)) continue;
      if (!byId.has(id)) byId.set(id, el);
    }
    const afters = new Map<string, DOMRect>();
    for (const [id, el] of byId) afters.set(id, el.getBoundingClientRect());
    // 阶段二：写入反向位移（transition:none → 先无动画地落回旧视觉位置）
    let touched = false;
    for (const [id, before] of snapshot) {
      const after = afters.get(id);
      if (!after || !byId.has(id)) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx === 0 && dy === 0) continue;
      byId.get(id)!.style.transition = "none";
      byId.get(id)!.style.transform = `translate(${dx}px, ${dy}px)`;
      touched = true;
    }
    if (!touched) return;
    // 强制样式刷新：卡片先无动画地落回旧视觉位置
    void document.body.offsetHeight;
    // 释放：清掉内联位移，由样式表过渡（.model-card/.profile-card 均为 .18s ease）把卡片滑向新插槽
    for (const [id, el] of byId) {
      el.style.transition = "";
      el.style.transform = "";
    }
  }, [orders]);

  /** 每张卡片挂上的属性：命中检测标记 + 按压处理 */
  const cardProps = (groupId: TC, itemId: string): CardHandlers => ({
    "data-reorder-card": itemId,
    onPointerDown: (event) => {
      if (!enabledRef.current || event.button !== 0) return;
      // 交互控件（按钮/下拉/输入框等）上不启动拖拽，保留其原生点击行为
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, input, select, label, a")) return;
      if (pressRef.current) return; // 同一时刻只允许一个按压会话
      pressRef.current = { groupId, itemId, el: event.currentTarget, x0: event.clientX, y0: event.clientY, gx: 0, gy: 0, tx: 0, ty: 0, active: false };
    },
    onMouseDown: (event) => {
      // 在卡片表面按压时阻止原生文本选择/OLE 拖拽会话开始（与 HTML5 draggable 的取舍一致）；交互控件上不加限制，焦点与选择行为保持原样
      if (!enabledRef.current || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, input, select, label, a")) return;
      event.preventDefault();
    },
  });

  /** 实时顺序镜像：拖动中返回预览顺序；空闲时跟随 groups */
  const liveGroups = groups.map((group) => ({ id: group.id, items: orders?.[group.id] ?? group.items }));

  return { groups: liveGroups, dragId, cardProps };
}
