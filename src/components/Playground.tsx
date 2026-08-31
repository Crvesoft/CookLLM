import { Bot, Globe, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ServerStatus } from "../types";
import { openExternal, writeClipboard } from "../tauri";

export default function Playground({ visible, status, webUiUrl, modelName, onOpenWebUi }: { visible: boolean; status: ServerStatus; webUiUrl: string; modelName?: string; onOpenWebUi: () => void }) {
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
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="playground-pane" hidden={!visible}>
      {/* 高度相对面板容器（而非视口）：填满 Dock 下全部剩余高度，Dock 展开时随 flex 布局自动缩小 */}
      <section className="playground-layout">
        <div className="chat-panel">
          <div className="chat-header">
            <div><Bot size={18} /><span>{modelName || "Local model"}</span></div>
            <div className="playground-actions">
              {/* 状态与刷新合并为一个轻量标签：整块点击即刷新内嵌 WebUI；服务未运行时整体禁用 */}
              <button type="button" className={status.running ? "connection-chip connected" : "connection-chip"} title="刷新内嵌 WebUI" aria-label="刷新内嵌 WebUI" disabled={!status.running} onClick={() => setFrameKey((key) => key + 1)}><i /><span>{status.running ? "已连接" : "等待服务"}</span><em className="chip-divider" /><RefreshCw size={14} /></button>
              <button type="button" className="webui-button" disabled={!status.running} onClick={onOpenWebUi}><Globe size={15} />WebUI</button>
            </div>
          </div>
          {status.running
            ? (
              <div className="native-frame-wrap">
                <iframe ref={frameRef} key={`${webUiUrl}:${frameKey}`} src={webUiUrl} title="llama.cpp Web UI" allow="clipboard-read; clipboard-write" />
              </div>
            )
            : <div className="messages-empty"><Globe size={30} /><p>服务未运行，请先在模型仓库启动</p></div>}
        </div>
      </section>
    </div>
  );
}
