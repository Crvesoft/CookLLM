import { Bot, Globe, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ServerStatus } from "../types";
import { cn } from "../utils";

export default function Playground({ status, webUiUrl, modelName, onOpenWebUi }: { status: ServerStatus; webUiUrl: string; modelName?: string; onOpenWebUi: () => void }) {
  /** 刷新内嵌 WebUI：key 变化时重建 iframe（服务重启后旧页面状态失效时用） */
  const [frameKey, setFrameKey] = useState(0);
  return (
    <section className="playground-layout">
      <div className="chat-panel">
        <div className="chat-header">
          <div><Bot size={18} /><span>{modelName || "Local model"}</span></div>
          <div className="playground-actions">
            <div className={cn("connection-chip", status.running && "connected")}><i />{status.running ? "已连接" : "等待服务"}</div>
            <button title="刷新内嵌页面" aria-label="刷新内嵌页面" onClick={() => setFrameKey((key) => key + 1)}><RefreshCw size={15} /></button>
            <button className="webui-button" disabled={!status.running} onClick={onOpenWebUi}><Globe size={15} />浏览器打开</button>
          </div>
        </div>
        {status.running
          ? <div className="native-frame-wrap"><iframe key={`${webUiUrl}:${frameKey}`} src={webUiUrl} title="llama.cpp Web UI" /></div>
          : <div className="messages-empty"><Globe size={30} /><p>服务未运行，请先在模型仓库启动</p></div>}
      </div>
    </section>
  );
}
