import { Bot, Globe, RefreshCw, Scan } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { ServerStatus } from "../types";
import { openExternal, writeClipboard } from "../tauri";

export default function Playground({
  visible,
  status,
  webUiUrl,
  modelName,
  onOpenWebUi,
  zenMode,
  onToggleZenMode,
}: {
  visible: boolean;
  status: ServerStatus;
  webUiUrl: string;
  modelName?: string;
  onOpenWebUi: () => void;
  zenMode?: boolean;
  onToggleZenMode?: () => void;
}) {
  const { t } = useI18n();
  /** 刷新内嵌 WebUI：key 变化时重建 iframe（服务重启后旧页面状态失效时用） */
  const [frameKey, setFrameKey] = useState(0);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { type?: string; text?: string; url?: string } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "cookllm:copy" && typeof data.text === "string") {
        void writeClipboard(data.text).catch(() => {});
      } else if (data.type === "cookllm:open" && typeof data.url === "string") {
        void openExternal(data.url);
      } else if (data.type === "cookllm:zen-toggle") {
        onToggleZenMode?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onToggleZenMode]);

  return (
    <div className="playground-pane" hidden={!visible}>
      {/* 高度相对面板容器（而非视口）：填满 Dock 下全部剩余高度，Dock 展开时随 flex 布局自动缩小 */}
      <section className="playground-layout">
        <div className="chat-panel">
          <div className="chat-header">
            <div><Bot size={18} /><span>{modelName || "Local model"}</span></div>
            <div className="playground-actions">
              <button
                type="button"
                className="chat-action-btn"
                title={status.running ? t("refreshWebUi") : t("waitingService")}
                aria-label={t("refreshWebUi")}
                disabled={!status.running}
                onClick={() => setFrameKey((key) => key + 1)}
              >
                <RefreshCw size={15} />
              </button>
              {onToggleZenMode && (
                <button
                  type="button"
                  className="chat-action-btn"
                  onClick={onToggleZenMode}
                  title={t("zen.enter")}
                  aria-label={t("zen.enter")}
                >
                  <Scan size={15} />
                </button>
              )}
              <button
                type="button"
                className="chat-action-btn"
                disabled={!status.running}
                onClick={onOpenWebUi}
                title={t("openInBrowser")}
                aria-label={t("openInBrowser")}
              >
                <Globe size={15} />
              </button>
            </div>
          </div>
          {status.running
            ? (
              <div className="native-frame-wrap">
                <iframe ref={frameRef} key={`${webUiUrl}:${frameKey}`} src={webUiUrl} title="llama.cpp Web UI" allow="clipboard-read; clipboard-write" />
              </div>
            )
            : <div className="messages-empty"><Globe size={30} /><p>{t("pgNotRunning")}</p></div>}
        </div>
      </section>
    </div>
  );
}
