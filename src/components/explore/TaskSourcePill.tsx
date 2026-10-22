import type { ActiveDownload } from "../../types";
import { openExternal } from "../../tauri";
import { openHf, openMs } from "./modelUtils";
import { ModelScopeLogo } from "./ModelAvatar";

/** 任务卡片左侧社区源徽章：ModelScope / HuggingFace，直链任务不显示 */
export function TaskSourcePill({ item }: { item: ActiveDownload }) {
  if (item.source === "ms") {
    return (
      <span className="task-source-pill ms" title="ModelScope">
        <ModelScopeLogo size={11} />
        <span>MS</span>
      </span>
    );
  }
  if (item.repo !== "direct-url") {
    return <span className="task-source-pill hf" title="HuggingFace">HF</span>;
  }
  return null;
}

/** 任务卡片"打开来源"按钮的统一跳转：优先社区源仓库，直链任务回落到原始 URL */
export function openTaskSource(item: ActiveDownload) {
  if (item.source === "ms" && item.repo !== "direct-url") {
    openMs(item.repo);
  } else if (item.repo !== "direct-url") {
    openHf(item.repo);
  } else if (item.url) {
    void openExternal(item.url);
  }
}
