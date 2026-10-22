import { useEffect, useState } from "react";
import { hfAvatar, msAvatar } from "../../tauri";
import type { CommunitySource } from "../../types";

/* ---------------- HF 作者头像（组织 / 用户 logo） ---------------- */

/** 魔搭（ModelScope）官方矢量 Logo（湖蓝 #36CED0 + 品牌紫 #624AFF 几何括弧） */
export function ModelScopeLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ display: "block", flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M0 7.967h2.667v2.667H0zM8 10.633h2.667V13.3H8z" fill="#36CED0" />
      <path d="M0 10.633h2.667V13.3H0zM2.667 13.3h2.666v2.667H8v2.666H2.667V13.3zM2.667 5.3H8v2.667H5.333v2.666H2.667V5.3zM10.667 13.3h2.667v2.667h-2.667z" fill="#624AFF" />
      <path d="M24 7.967h-2.667v2.667H24zM16 10.633h-2.667V13.3H16z" fill="#36CED0" />
      <path d="M24 10.633h-2.667V13.3H24zM21.333 13.3h-2.666v2.667H16v2.666h5.333V13.3zM21.333 5.3H16v2.667h2.667v2.666h2.666V5.3z" fill="#624AFF" />
    </svg>
  );
}

/** 已解析的作者头像：key(source:author) -> data URI；null 表示无头像，渲染时回退社区源 Logo/徽章 */
const avatarCache = new Map<string, string | null>();
/** 同一作者的并发请求去重：避免列表里同组织多行时重复拉取 */
const avatarPending = new Map<string, Promise<string | null>>();

function loadAvatar(author: string, source: CommunitySource = "hf"): Promise<string | null> {
  const key = `${source}:${author}`;
  if (avatarCache.has(key)) return Promise.resolve(avatarCache.get(key)!);
  let pending = avatarPending.get(key);
  if (!pending) {
    const fetcher = source === "ms" ? msAvatar(author) : hfAvatar(author);
    pending = fetcher
      .then((uri) => {
        avatarCache.set(key, uri);
        return uri;
      })
      .catch(() => {
        avatarCache.set(key, null);
        return null;
      })
      .finally(() => avatarPending.delete(key));
    avatarPending.set(key, pending);
  }
  return pending;
}

/** 模型行 / 趋势卡左侧图标：优先展示作者头像，拉取失败或无头像时回退社区源 Logo / 徽章 */
function ModelAvatar({ author, source = "hf" }: { author: string; source?: CommunitySource }) {
  const key = `${source}:${author}`;
  const [uri, setUri] = useState<string | null>(avatarCache.get(key) ?? null);

  useEffect(() => {
    let alive = true;
    loadAvatar(author, source).then((resolved) => {
      if (alive) setUri(resolved);
    });
    return () => {
      alive = false;
    };
  }, [author, source]);

  if (uri) {
    return <img className="hf-model-icon hf-model-avatar" src={uri} alt="" loading="lazy" draggable={false} />;
  }

  if (source === "ms") {
    return (
      <span className="hf-model-icon ms" title="ModelScope">
        <ModelScopeLogo size={20} />
      </span>
    );
  }

  return <span className="hf-model-icon">HF</span>;
}

export default ModelAvatar;
