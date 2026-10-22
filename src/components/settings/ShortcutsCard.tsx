import { AppWindow, Keyboard, Pencil, Play, Repeat, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { setShortcutsRecordingMode } from "../../tauri";
import type { AppConfig, ShortcutActionKey, ShortcutsConfig } from "../../types";
import { cn, DEFAULT_SHORTCUTS, formatShortcutFromEvent, parseShortcutParts } from "../../utils";

export default function ShortcutsCard({ config, onPersist }: { config: AppConfig; onPersist: (config: AppConfig, message?: string) => Promise<void> }) {
  const { t } = useI18n();
  const [recordingKey, setRecordingKey] = useState<ShortcutActionKey | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  const shortcutsConfig: ShortcutsConfig = config.shortcuts ?? DEFAULT_SHORTCUTS;

  useEffect(() => {
    if (!recordingKey) return;
    void setShortcutsRecordingMode(true);

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape 退出录制
      if (e.key === "Escape") {
        setRecordingKey(null);
        setShortcutError(null);
        return;
      }

      // Backspace / Delete 清除当前项
      if (e.key === "Backspace" || e.key === "Delete") {
        const next = { ...shortcutsConfig, [recordingKey]: "" };
        void onPersist({ ...config, shortcuts: next }, t("toast.shortcutsSaved"));
        setRecordingKey(null);
        setShortcutError(null);
        return;
      }

      const { shortcut, isModifierOnly, keyName } = formatShortcutFromEvent(e);
      if (isModifierOnly) return;

      if (!shortcut) {
        if (keyName) {
          setShortcutError(t("st.shortcutsNeedModifier"));
        }
        return;
      }

      // 冲突检测
      const otherKeys = (["toggleWindow", "startServer", "stopServer", "switchEngine"] as const).filter(
        (k) => k !== recordingKey
      );
      const isConflict = otherKeys.some((k) => {
        const val = config.shortcuts?.[k] !== undefined ? config.shortcuts[k] : DEFAULT_SHORTCUTS[k];
        return (val || "").toLowerCase() === shortcut.toLowerCase();
      });
      if (isConflict) {
        setShortcutError(t("st.shortcutsConflict"));
        return;
      }

      // 保存
      const next = { ...shortcutsConfig, [recordingKey]: shortcut };
      void onPersist({ ...config, shortcuts: next }, t("toast.shortcutsSaved"));
      setRecordingKey(null);
      setShortcutError(null);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      void setShortcutsRecordingMode(false);
    };
  }, [recordingKey, shortcutsConfig, config, onPersist, t]);

  useEffect(() => {
    if (!recordingKey) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".shortcut-grid-card.is-recording")) {
        setRecordingKey(null);
        setShortcutError(null);
      }
    };
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handleClickOutside);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handleClickOutside);
    };
  }, [recordingKey]);

  useEffect(() => {
    if (!shortcutError) return;
    const timer = setTimeout(() => setShortcutError(null), 3000);
    return () => clearTimeout(timer);
  }, [shortcutError]);

  const handleClearShortcut = async (keyName: ShortcutActionKey, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShortcutError(null);
    if (recordingKey === keyName) setRecordingKey(null);
    const next = { ...shortcutsConfig, [keyName]: "" };
    await onPersist({ ...config, shortcuts: next }, t("toast.shortcutsSaved"));
  };

  const handleResetShortcutDefaults = async () => {
    setShortcutError(null);
    setRecordingKey(null);
    const next = { ...DEFAULT_SHORTCUTS, enabled: Boolean(config.shortcuts?.enabled) };
    await onPersist({ ...config, shortcuts: next }, t("toast.shortcutsSaved"));
  };

  const renderShortcutKeycaps = (shortcut?: string) => {
    const parts = parseShortcutParts(shortcut);
    if (parts.length === 0) {
      return <span className="keycap-empty">{t("st.shortcutsNone")}</span>;
    }
    return (
      <div className="keycaps-wrapper">
        {parts.map((part, idx) => (
          <span key={idx} className="keycap-item">
            {idx > 0 && <span className="keycap-sep">+</span>}
            <kbd className="keycap">{part}</kbd>
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="settings-card shortcuts-management-card">
      <div className="settings-card-header shortcuts-card-header">
        <div className="shortcuts-header-main">
          <div className="shortcuts-title-line">
            <div className="settings-card-icon"><Keyboard size={16} /></div>
            <h3>{t("st.shortcutsTitle")}</h3>
          </div>
        </div>
        <div className="settings-card-header-actions">
          <button
            type="button"
            className="ghost-button compact shortcuts-header-reset-btn"
            onClick={handleResetShortcutDefaults}
            title={t("st.shortcutsReset")}
          >
            <RotateCcw size={12} />
            <span>{t("st.shortcutsReset")}</span>
          </button>
          <button
            className={"switch" + (config.shortcuts?.enabled ? " on" : "")}
            onClick={() =>
              void onPersist(
                { ...config, shortcuts: { ...(config.shortcuts ?? DEFAULT_SHORTCUTS), enabled: !config.shortcuts?.enabled } },
                !config.shortcuts?.enabled ? t("toast.shortcutsSaved") : t("toast.settingsSaved")
              )
            }
            role="switch"
            aria-checked={Boolean(config.shortcuts?.enabled)}
            title={t("st.shortcutsEnable")}
          >
            <span className="switch-knob" />
          </button>
        </div>
      </div>
      <div className="shortcuts-grid-body">
        <div className="shortcuts-2x2-grid">
          {[
            {
              key: "toggleWindow" as ShortcutActionKey,
              label: t("st.shortcutsToggleWindow"),
              icon: <AppWindow size={15} />,
              color: "amber",
              value: config.shortcuts?.toggleWindow !== undefined ? config.shortcuts.toggleWindow : DEFAULT_SHORTCUTS.toggleWindow,
            },
            {
              key: "startServer" as ShortcutActionKey,
              label: t("st.shortcutsStartServer"),
              icon: <Play size={13} fill="currentColor" />,
              color: "emerald",
              value: config.shortcuts?.startServer !== undefined ? config.shortcuts.startServer : DEFAULT_SHORTCUTS.startServer,
            },
            {
              key: "stopServer" as ShortcutActionKey,
              label: t("st.shortcutsStopServer"),
              icon: <Square size={13} fill="currentColor" />,
              color: "rose",
              value: config.shortcuts?.stopServer !== undefined ? config.shortcuts.stopServer : DEFAULT_SHORTCUTS.stopServer,
            },
            {
              key: "switchEngine" as ShortcutActionKey,
              label: t("st.shortcutsSwitchEngine"),
              icon: <Repeat size={14} />,
              color: "indigo",
              value: config.shortcuts?.switchEngine !== undefined ? config.shortcuts.switchEngine : DEFAULT_SHORTCUTS.switchEngine,
            },
          ].map((item) => {
            const isRecording = recordingKey === item.key;
            const hasValue = Boolean(item.value && item.value.trim().length > 0);

            return (
              <div
                key={item.key}
                className={cn(
                  "shortcut-grid-card",
                  isRecording && "is-recording"
                )}
                onClick={() => {
                  if (isRecording) return;
                  setShortcutError(null);
                  setRecordingKey(item.key);
                }}
                title={isRecording ? "按 Esc 取消 · 按 Backspace/Delete 清空" : t("st.shortcutsClickToSet")}
              >
                <div className="shortcut-card-left">
                  <div className={cn("shortcut-icon-badge", item.color)}>
                    {item.icon}
                  </div>
                  <span className="shortcut-card-label">{item.label}</span>
                </div>
                <div className="shortcut-card-right">
                  {isRecording ? (
                    <div className={cn("shortcut-card-recording-pill", shortcutError && "has-error")}>
                      <span className="recording-dot" />
                      <span className="recording-text">
                        {shortcutError || t("st.shortcutsRecording")}
                      </span>
                      <button
                        type="button"
                        className="recording-cancel-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRecordingKey(null);
                          setShortcutError(null);
                        }}
                        title="取消 (Esc)"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ) : (
                    <div className="shortcut-card-val-group">
                      {renderShortcutKeycaps(item.value)}
                      {hasValue && (
                        <button
                          type="button"
                          className="shortcut-card-action-btn clear-btn"
                          onClick={(e) => void handleClearShortcut(item.key, e)}
                          title={t("st.shortcutsClear")}
                          aria-label={t("st.shortcutsClear")}
                        >
                          <X size={12} />
                        </button>
                      )}
                      <span className="shortcut-card-pencil" title={t("st.shortcutsClickToSet")}>
                        <Pencil size={12} />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
