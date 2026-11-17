import { useEffect, useState } from "react";
import { Check, Code2, Copy, Eye, EyeOff, Globe, Info, Monitor, Terminal, Wifi, X } from "lucide-react";
import { useI18n } from "../i18n";
import { getLocalIp } from "../tauri";
import type { ModelAsset, Profile } from "../types";
import { cn, copyTextToClipboard, modelTitle } from "../utils";

interface LanAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  model: ModelAsset | null;
  profile?: Profile | null;
  port: number;
  isRunning: boolean;
  onToast?: (msg: string) => void;
}

export default function LanAccessModal({
  isOpen,
  onClose,
  model,
  profile,
  port,
  isRunning,
  onToast,
}: LanAccessModalProps) {
  const { t } = useI18n();
  const [localIp, setLocalIp] = useState<string>("127.0.0.1");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [activeTab, setActiveTab] = useState<"curl" | "python">("curl");
  const [endpointMode, setEndpointMode] = useState<"local" | "lan">("local");

  const host = profile?.host?.trim() || "0.0.0.0";
  // 除回环地址外都视为已开启局域网共享；0.0.0.0 / :: 表示监听全部网卡
  const isLoopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  const isAllInterfaces = host === "0.0.0.0" || host === "::";
  const isLanEnabled = !isLoopbackHost;

  useEffect(() => {
    if (!isOpen) return;
    void getLocalIp().then((info) => {
      if (info.primaryIp) setLocalIp(info.primaryIp);
    }).catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setEndpointMode(isLanEnabled ? "lan" : "local");
  }, [isOpen, isLanEnabled]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !model) return null;

  const currentPort = port || profile?.port || 8080;
  const apiKey = profile?.apiKey?.trim();
  const modelName = modelTitle(model);
  const lanHost = isAllInterfaces || isLoopbackHost ? localIp : host;

  const localEndpoint = `http://${isLoopbackHost || isAllInterfaces ? "127.0.0.1" : host}:${currentPort}/v1`;
  const lanEndpoint = `http://${lanHost}:${currentPort}/v1`;
  const activeEndpoint = endpointMode === "lan" && isLanEnabled ? lanEndpoint : localEndpoint;

  const handleCopy = async (text: string, key: string, label: string) => {
    await copyTextToClipboard(text);
    setCopiedKey(key);
    onToast?.(t("toast.copiedText", { label }));
    window.setTimeout(() => setCopiedKey(null), 2000);
  };

  const curlSnippet = `curl ${activeEndpoint}/chat/completions \\
  -H "Content-Type: application/json" \\${apiKey ? `\n  -H "Authorization: Bearer ${apiKey}" \\` : ""}
  -d '{
    "model": "${modelName}",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`;

  const pythonSnippet = `from openai import OpenAI

client = OpenAI(
    base_url="${activeEndpoint}",
    api_key="${apiKey || "sk-no-key-required"}",
)

response = client.chat.completions.create(
    model="${modelName}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`;

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lan-access-modal">
        <header>
          <div className="lan-modal-title-wrap">
            <div className="lan-modal-icon">
              <Globe size={20} />
            </div>
            <div>
              <h2>{t("lan.modalTitle")}</h2>
              <p>{modelName} · {isRunning ? t("statusRunning") : t("statusStopped")}</p>
            </div>
          </div>
          <button className="ghost-icon" onClick={onClose} aria-label={t("close")}><X size={18} /></button>
        </header>

        <div className="lan-modal-body">
          {/* 接入地址：本机 / 局域网二选一，参数区只展示选中的地址 */}
          <section className="lan-endpoint-section">
            <div className="lan-section-head">
              <span className="lan-section-label">{t("lan.addressSection")}</span>
              <span className={cn("apikey-status-pill", isLanEnabled ? "enabled" : "public")}>
                {isLanEnabled ? t("lan.lanReady") : t("lan.localOnly")}
              </span>
            </div>
            <div className="lan-endpoint-options" role="group" aria-label={t("lan.addressSection")}>
              <button
                type="button"
                className={cn("lan-endpoint-option", endpointMode === "local" && "active")}
                aria-pressed={endpointMode === "local"}
                onClick={() => setEndpointMode("local")}
              >
                <Monitor size={13} />
                <span>{t("lan.optLocal")}</span>
                <code>127.0.0.1</code>
              </button>
              <button
                type="button"
                className={cn("lan-endpoint-option", endpointMode === "lan" && "active")}
                aria-pressed={endpointMode === "lan"}
                disabled={!isLanEnabled}
                title={isLanEnabled ? undefined : t("lan.lanBlockedHint")}
                onClick={() => setEndpointMode("lan")}
              >
                <Wifi size={13} />
                <span>{t("lan.optLan")}</span>
                <code>{isLanEnabled ? lanHost : "0.0.0.0"}</code>
              </button>
            </div>
            {!isLanEnabled && (
              <p className="lan-endpoint-hint"><Info size={12} />{t("lan.lanBlockedHint")}</p>
            )}
          </section>

          {/* 接入参数：地址 / 密钥 / 模型各一行，只出现一次 */}
          <section className="lan-params-card">
            <div className="lan-param-row">
              <span className="lan-param-label">{t("lan.clientBaseUrl")}</span>
              <code className="lan-param-value" title={activeEndpoint}>{activeEndpoint}</code>
              <button
                type="button"
                className="copy-btn"
                onClick={() => handleCopy(activeEndpoint, "url", t("lan.clientBaseUrl"))}
                title={t("copy")}
              >
                {copiedKey === "url" ? <Check size={14} className="copied" /> : <Copy size={14} />}
              </button>
            </div>
            <div className="lan-param-row">
              <span className="lan-param-label">{t("lan.clientApiKey")}</span>
              {apiKey ? (
                <>
                  <code className="lan-param-value" title={apiKey}>
                    {showApiKey ? apiKey : "•".repeat(Math.min(28, apiKey.length))}
                  </code>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={() => setShowApiKey(!showApiKey)}
                    title={showApiKey ? t("hide") : t("show")}
                  >
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={() => handleCopy(apiKey, "key", t("lan.clientApiKey"))}
                    title={t("copy")}
                  >
                    {copiedKey === "key" ? <Check size={14} className="copied" /> : <Copy size={14} />}
                  </button>
                </>
              ) : (
                <code className="lan-param-value muted">{t("lan.apiKeyUnset")}</code>
              )}
            </div>
            <div className="lan-param-row">
              <span className="lan-param-label">{t("lan.clientModelName")}</span>
              <code className="lan-param-value" title={modelName}>{modelName}</code>
              <button
                type="button"
                className="copy-btn"
                onClick={() => handleCopy(modelName, "model", t("lan.clientModelName"))}
                title={t("copy")}
              >
                {copiedKey === "model" ? <Check size={14} className="copied" /> : <Copy size={14} />}
              </button>
            </div>
          </section>

          {/* 调用示例：默认完整展示，不再额外占一个「第三方应用接入」页签 */}
          <section className="lan-examples">
            <div className="lan-section-head">
              <span className="lan-section-label">{t("lan.examplesTitle")}</span>
              <div className="guide-tabs">
                <button
                  type="button"
                  className={activeTab === "curl" ? "active" : ""}
                  onClick={() => setActiveTab("curl")}
                >
                  <Terminal size={12} />cURL
                </button>
                <button
                  type="button"
                  className={activeTab === "python" ? "active" : ""}
                  onClick={() => setActiveTab("python")}
                >
                  <Code2 size={12} />Python
                </button>
              </div>
            </div>
            <div className="code-block-wrap">
              <pre><code>{activeTab === "curl" ? curlSnippet : pythonSnippet}</code></pre>
              <button
                type="button"
                className="code-copy-btn"
                onClick={() => handleCopy(activeTab === "curl" ? curlSnippet : pythonSnippet, activeTab, activeTab === "curl" ? "cURL" : "Python")}
                title={t("copy")}
              >
                {copiedKey === activeTab ? <Check size={13} className="copied" /> : <Copy size={13} />}
              </button>
            </div>
          </section>
        </div>

        <footer>
          <button type="button" className="primary-button" onClick={onClose}>{t("close")}</button>
        </footer>
      </div>
    </div>
  );
}
