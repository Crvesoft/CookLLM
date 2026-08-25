/**
 * 应用内品牌标记：与 src-tauri/icons/icon.svg 同一设计源
 * （应用图标含圆角容器；应用内只渲染图形本身，圆角容器由 .brand-mark / .mark 的 CSS 承担）
 * viewBox 为 icon.svg 中图形的裁剪框（260,160 起，520x680）
 */
export function LlamaMark({ size = 21, idPrefix = "lm" }: { size?: number; idPrefix?: string }) {
  const ids = { body: `${idPrefix}-body`, muzzle: `${idPrefix}-muzzle`, dock: `${idPrefix}-dock` };
  return (
    <svg width={size} height={size} viewBox="260 160 520 680" aria-hidden="true">
      <defs>
        <linearGradient id={ids.body} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#cbbcff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id={ids.muzzle} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e6dcff" />
          <stop offset="1" stopColor="#a488e8" />
        </linearGradient>
        <linearGradient id={ids.dock} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7254d1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      {/* 耳朵 */}
      <rect x="398" y="206" width="72" height="112" rx="32" fill="#8b5cf6" transform="rotate(-16 434 262)" />
      <rect x="554" y="206" width="72" height="112" rx="32" fill="#8b5cf6" transform="rotate(16 590 262)" />
      {/* 头顶发簇 */}
      <circle cx="512" cy="268" r="40" fill="#8b5cf6" />
      {/* 头 */}
      <rect x="392" y="270" width="240" height="340" rx="104" fill={`url(#${ids.body})`} />
      {/* 口鼻 */}
      <rect x="430" y="504" width="256" height="110" rx="55" fill={`url(#${ids.muzzle})`} />
      {/* 眼睛（青色）与鼻孔 */}
      <circle cx="556" cy="396" r="30" fill="#19c8d1" opacity="0.25" />
      <circle cx="556" cy="396" r="18" fill="#19c8d1" />
      <circle cx="636" cy="559" r="11" fill="#17152a" opacity="0.85" />
      {/* dock 底座：下托 + 主架 + 在线状态点 */}
      <rect x="382" y="770" width="260" height="32" rx="16" fill="#3f3374" />
      <rect x="298" y="698" width="428" height="46" rx="23" fill={`url(#${ids.dock})`} />
      <circle cx="686" cy="721" r="18" fill="#39d98a" opacity="0.35" />
      <circle cx="686" cy="721" r="9" fill="#39d98a" />
    </svg>
  );
}
