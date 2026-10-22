import { Check, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { hfWhoami } from "../../tauri";
import type { AppConfig } from "../../types";
import { cn } from "../../utils";

export default function HfTokenCard({ config, onPersist }: { config: AppConfig; onPersist: (config: AppConfig, message?: string) => Promise<void> }) {
  const { t } = useI18n();
  const [hfTokenDraft, setHfTokenDraft] = useState(config.hfToken ?? "");
  const [hfShowToken, setHfShowToken] = useState(false);
  const [hfTesting, setHfTesting] = useState(false);
  const [hfTestResult, setHfTestResult] = useState<{ ok: boolean; username?: string; detail?: string } | null>(null);
  const [hfError, setHfError] = useState<string | null>(null);
  const [hfSaved, setHfSaved] = useState(false);

  useEffect(() => {
    setHfTokenDraft(config.hfToken ?? "");
  }, [config.hfToken]);

  const runHfTokenTest = async () => {
    const value = hfTokenDraft.trim();
    if (!value) {
      setHfError(t("st.hfTokenEmpty"));
      return;
    }
    setHfTesting(true); setHfTestResult(null); setHfError(null);
    try {
      const username = await hfWhoami(value);
      setHfTestResult({ ok: true, username });
      await onPersist({ ...config, hfToken: value, hfTokenUser: username }, t("st.hfTokenVerified", { user: username }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setHfTestResult({ ok: false, detail });
    } finally { setHfTesting(false); }
  };

  const saveHfToken = () => {
    const value = hfTokenDraft.trim();
    if (!value) {
      void onPersist({ ...config, hfToken: undefined, hfTokenUser: undefined }, t("st.hfTokenCleared"));
      setHfTestResult(null); setHfError(null);
      return;
    }
    void onPersist({ ...config, hfToken: value }, t("st.hfTokenSaved"));
    setHfSaved(true);
    window.setTimeout(() => setHfSaved(false), 2000);
  };

  return (
    <div className="settings-card auth-management-card">
      <div className="settings-card-header">
        <div className="settings-card-icon"><KeyRound size={16} /></div>
        <h3>{t("st.hfTokenTitle")}</h3>
        <div className="settings-card-header-actions">
          <span className={cn("auth-status-pill", (hfTestResult?.ok || (config.hfToken && !hfTestResult)) ? "ok" : (hfTestResult && !hfTestResult.ok) ? "err" : "unconfigured")}>
            {hfTestResult?.ok
              ? t("st.hfTokenBound", { user: hfTestResult.username || "…" })
              : hfTestResult && !hfTestResult.ok
                ? t("st.hfTokenInvalid")
                : config.hfToken
                  ? (config.hfTokenUser ? t("st.hfTokenBound", { user: config.hfTokenUser }) : t("st.hfTokenNotSet") === "未配置" ? "已配置" : "Configured")
                  : t("st.hfTokenNotSet")}
          </span>
        </div>
      </div>
      <div className="settings-card-body">
        <div className="auth-unified-row">
          <div className="auth-platform-side">
            <strong className="auth-platform-name">{t("st.hfTokenLabel")}</strong>
          </div>
          <div className="auth-input-wrapper">
            <input
              type={hfShowToken ? "text" : "password"}
              className="auth-token-input"
              value={hfTokenDraft}
              onChange={(e) => { setHfTokenDraft(e.target.value); setHfTestResult(null); setHfError(null); }}
              placeholder={t("st.hfTokenPlaceholder")}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="auth-token-eye"
              type="button"
              title={hfShowToken ? t("st.hfTokenHide") : t("st.hfTokenShow")}
              onClick={() => setHfShowToken((value) => !value)}
            >
              {hfShowToken ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <div className="auth-btn-group">
            <button
              type="button"
              className="secondary-button compact auth-action-btn"
              onClick={() => void runHfTokenTest()}
              disabled={hfTesting}
            >
              {hfTesting ? <Loader2 size={13} className="spin" /> : <KeyRound size={13} />}
              <span>{hfTesting ? t("st.hfTokenTesting") : t("st.hfTokenTest")}</span>
            </button>
            <button
              type="button"
              className="secondary-button compact auth-action-btn"
              onClick={saveHfToken}
              disabled={hfTesting}
            >
              {hfSaved ? <Check size={13} /> : null}
              <span>{t("st.hfTokenSave")}</span>
            </button>
          </div>
        </div>
        {hfError && <p className="hf-token-error">{hfError}</p>}
      </div>
    </div>
  );
}
