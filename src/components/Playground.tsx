import { Bot, Globe, MessageSquareText, RotateCcw, Send, User } from "lucide-react";
import { useState } from "react";
import type { ChatMessage, ServerStatus } from "../types";
import { cn } from "../utils";

export default function Playground({ status, baseUrl, modelName, messages, setMessages, onOpenWebUi }: { status: ServerStatus; baseUrl: string; modelName?: string; messages: ChatMessage[]; setMessages: (next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void; onOpenWebUi: () => void }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const prompt = input.trim();
    if (!prompt || !status.running) return;
    const next = [...messages, { role: "user" as const, content: prompt }];
    setMessages(next); setInput(""); setSending(true);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelName || "local-model", messages: next.map(({ role, content }) => ({ role, content })), stream: false }) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = await response.json();
      setMessages((current) => [...current, { role: "assistant", content: data.choices?.[0]?.message?.content || "服务返回了空响应。" }]);
    } catch (error) { setMessages((current) => [...current, { role: "assistant", content: `请求失败：${String(error)}` }]); }
    finally { setSending(false); }
  };
  return <><section className="page-heading"><div><div className="eyebrow"><MessageSquareText size={14} />CHAT SESSION</div><h1>会话</h1><p>直接向当前模型发送消息，对话会自动保留。</p></div><div className="page-heading-actions"><div className={cn("connection-chip", status.running && "connected")}><i />{status.running ? "已连接" : "等待服务"}</div><button className="webui-button" disabled={!status.running} onClick={onOpenWebUi}><Globe size={15} />Web UI</button></div></section><section className="playground-layout"><div className="chat-panel"><div className="chat-header"><div><Bot size={18} /><span>{modelName || "Local model"}</span></div><button onClick={() => setMessages([])}><RotateCcw size={15} />清空对话</button></div><div className="messages">{messages.length ? messages.map((message, index) => <div className={cn("message", message.role)} key={index}><div className="message-avatar">{message.role === "assistant" ? <Bot size={16} /> : <User size={16} />}</div><div><span>{message.role === "assistant" ? "模型" : "你"}</span><p>{message.content}</p></div></div>) : <div className="messages-empty"><MessageSquareText size={30} /><p>发送第一条消息开始测试</p></div>}{sending && <div className="message assistant"><div className="message-avatar"><Bot size={16} /></div><div><span>模型</span><div className="typing"><i /><i /><i /></div></div></div>}</div><div className="composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={status.running ? "输入消息，Enter 发送…" : "请先在模型仓库启动一个服务"} disabled={!status.running} /><button disabled={!status.running || !input.trim() || sending} onClick={() => void send()}><Send size={17} /></button></div></div><aside className="request-panel"><h3>请求信息</h3><div className="request-item"><span>Base URL</span><code>{baseUrl}</code></div><div className="request-item"><span>Endpoint</span><code>{baseUrl}/chat/completions</code></div><div className="request-item"><span>Method</span><strong>POST</strong></div><div className="request-item"><span>Model</span><strong>{modelName || "—"}</strong></div><div className="request-item"><span>Status</span><strong className={status.running ? "ok" : ""}>{status.running ? "200 Ready" : "Offline"}</strong></div><div className="json-preview"><div>{`{`}</div><div>&nbsp;&nbsp;<b>"stream"</b>: <em>false</em>,</div><div>&nbsp;&nbsp;<b>"messages"</b>: [...]</div><div>{`}`}</div></div></aside></section></>;
}