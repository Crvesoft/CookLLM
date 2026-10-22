import { AlertTriangle, Check, Loader2, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { getSystemProxy, testProxyConnection, type ProxyTestResult } from "../../tauri";
import type { AppConfig, ProxyMode } from "../../types";

export default function NetworkCard({ config, onPersist }: { config: AppConfig; onPersist: (config: AppConfig, message?: string) => Promise<void> }) {
  const { t } = useI18n();
  const network = config.network ?? { proxyMode: "system" as const, proxyUrl: "" };
  const [proxyMode, setProxyMode] = useState<ProxyMode>(network.proxyMode);
  const [proxyUrl, setProxyUrl] = useState(network.proxyUrl ?? "");
  const [netTesting, setNetTesting] = useState(false);
  const [netResult, setNetResult] = useState<ProxyTestResult | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [systemProxy, setSystemProxy] = useState<string | null>(null);
  useEffect(() => { void getSystemProxy().then(setSystemProxy).catch(() => undefined); }, []);

  const NET_MODES: Array<{ value: ProxyMode; label: string }> = [
    { value: "system", label: t("net.modeSystem") },
    { value: "manual", label: t("net.modeManual") },
    { value: "direct", label: t("net.modeDirect") },
  ];

  const persistNetwork = (mode: ProxyMode, proxy: string) => {
    void onPersist(
      { ...config, network: { proxyMode: mode, proxyUrl: proxy } },
      t("net.saved"),
    );
  };

  const runProxyTest = async () => {
    setNetTesting(true); setNetResult(null); setNetError(null);
    try {
      const result = await testProxyConnection(proxyMode, proxyUrl);
      setNetResult(result);
      if (result.ok) persistNetwork(proxyMode, proxyUrl);
    } catch (error) {
      setNetError(error instanceof Error ? error.message : String(error));
    } finally { setNetTesting(false); }
  };

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-icon"><Wifi size={16} /></div>
        <h3>{t("net.title")}</h3>
      </div>
      <div className="settings-card-body">
        <div className="net-row">
          <span className="net-mode-label">{t("net.mode")}</span>
          <select
            className="net-select"
            value={proxyMode}
            onChange={(e) => { setProxyMode(e.target.value as ProxyMode); setNetResult(null); }}
          >
            {NET_MODES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {proxyMode === "system" ? (
            <span className="net-status">{systemProxy ? t("net.systemProxy", { proxy: systemProxy }) : t("net.noSystemProxy")}</span>
          ) : proxyMode === "manual" ? (
            <input className="net-input" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder={t("net.proxyUrlPlaceholder")} />
          ) : (
            <span className="net-status">{t("net.directHint")}</span>
          )}
          <button className="secondary-button compact net-test" onClick={() => void runProxyTest()} disabled={netTesting}>
            {netTesting ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />}
            {netTesting ? t("net.testing") : t("net.test")}
          </button>
        </div>
        {netResult?.ok && <span className="net-tag ok"><Check size={13} />{t("net.testLatency", { latency: netResult.latencyMs })}</span>}
        {netResult && !netResult.ok && <span className="net-tag err"><AlertTriangle size={13} />{netResult.detail || netResult.status}</span>}
        {netError && <p className="import-error">{netError}</p>}
      </div>
    </div>
  );
}
