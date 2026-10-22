import { ChevronDown, Download, FolderOpen, Languages, Moon, SlidersHorizontal, Sun, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { getGpuInfo, getModelsDir, openConfigDir, pickModelsDir, type GpuInfo } from "../../tauri";
import type { AppConfig, DiskUsage, LlamaLogPayload } from "../../types";
import { formatBytes } from "../../utils";

interface Props {
  config: AppConfig;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
  onLog: (line: string, stream?: LlamaLogPayload["stream"]) => void;
  onExportBackup: () => Promise<void>;
  onImportBackup: () => Promise<void>;
}

export default function PreferencesCard({ config, onPersist, onLog, onExportBackup, onImportBackup }: Props) {
  const { t } = useI18n();
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [modelsDisk, setModelsDisk] = useState<DiskUsage | null>(null);
  const [backupMenuOpen, setBackupMenuOpen] = useState(false);

  useEffect(() => { void getGpuInfo().then(setGpuInfo).catch(() => undefined); }, []);
  useEffect(() => {
    if (!backupMenuOpen) return;
    const close = () => setBackupMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [backupMenuOpen]);
  useEffect(() => { void getModelsDir().then(setModelsDisk).catch(() => undefined); }, [config.modelsDir]);

  const chooseModelsDir = async () => {
    try {
      const picked = await pickModelsDir();
      if (!picked) return;
      await onPersist({ ...config, modelsDir: picked }, t("toast.dirChanged"));
      const usage = await getModelsDir();
      setModelsDisk(usage);
    } catch (error) {
      onLog(error instanceof Error ? error.message : String(error), "stderr");
    }
  };

  const gpuOn = config.gpuMonitorEnabled !== false;
  const trayOn = config.minimizeToTrayOnClose !== false;

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-icon"><SlidersHorizontal size={16} /></div>
        <h3>{t("st.preferencesTitle")}</h3>
      </div>
      <div className="settings-list">
        <div className="settings-row">
          <span className="settings-row-label">{t("st.themeTitle")}</span>
          <span className="settings-row-desc">{t("st.themeDesc")}</span>
          <div className="settings-control">
            <div className="mini-seg settings-mini-seg">
              <button className={config.theme === "light" ? "active" : ""} onClick={() => void onPersist({ ...config, theme: "light" }, t("toast.lightTheme"))}><Sun size={13} />{t("lightLabel")}</button>
              <button className={config.theme !== "light" ? "active" : ""} onClick={() => void onPersist({ ...config, theme: "dark" }, t("toast.darkTheme"))}><Moon size={13} />{t("darkLabel")}</button>
            </div>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t("st.langTitle")}</span>
          <span className="settings-row-desc">{t("st.langDesc")}</span>
          <div className="settings-control">
            <div className="mini-seg settings-mini-seg">
              <button className={config.language === "en" ? "" : "active"} onClick={() => void onPersist({ ...config, language: "zh" }, t("toast.languageSet", { label: "简体中文" }))}><Languages size={13} />中文</button>
              <button className={config.language === "en" ? "active" : ""} onClick={() => void onPersist({ ...config, language: "en" }, t("toast.languageSet", { label: "English" }))}><Languages size={13} />EN</button>
            </div>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t("st.storageTitle")}</span>
          <span className="settings-row-desc">{t("st.storageDesc")}</span>
          <div className="settings-control">
            <div className="backup-menu" onClick={(event) => event.stopPropagation()}>
              <button className="secondary-button compact" onClick={() => setBackupMenuOpen((open) => !open)}><FolderOpen size={14} />{t("st.manageBackup")}<ChevronDown size={13} /></button>
              {backupMenuOpen && <div className="context-menu backup-menu-list">
                <button onClick={() => { setBackupMenuOpen(false); void onExportBackup(); }}><Download size={14} />{t("st.exportBackup")}</button>
                <button onClick={() => { setBackupMenuOpen(false); void onImportBackup(); }}><Upload size={14} />{t("st.importBackup")}</button>
                <button onClick={() => { setBackupMenuOpen(false); void openConfigDir().catch(() => undefined); }}><FolderOpen size={14} />{t("st.openConfigDir")}</button>
              </div>}
            </div>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t("st.modelsDirTitle")}</span>
          <span className="settings-row-desc">{modelsDisk ? t("st.modelsDirDesc", { free: formatBytes(modelsDisk.freeBytes) }) : t("st.modelsDirDesc", { free: "--" })}</span>
          <div className="settings-control">
            <button className="secondary-button compact" onClick={() => void chooseModelsDir()}><FolderOpen size={14} />{t("st.changeDir")}</button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t("st.gpuTitle")}</span>
          <span className="settings-row-desc">{gpuInfo === null ? t("gpu.detecting") : gpuInfo.vendor === "nvidia" ? t("gpu.nvidia") : gpuInfo.vendor === "amd" ? t("gpu.amd") : t("gpu.none")}</span>
          <div className="settings-control">
            <button className={"switch" + (gpuOn ? " on" : "")} onClick={() => void onPersist({ ...config, gpuMonitorEnabled: !gpuOn }, gpuOn ? t("toast.gpuOff") : t("toast.gpuOn"))} role="switch" aria-checked={gpuOn}>
              <span className="switch-knob" />
            </button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t("st.trayTitle")}</span>
          <span className="settings-row-desc">{t("st.trayDesc")}</span>
          <div className="settings-control">
            <button className={"switch" + (trayOn ? " on" : "")} onClick={() => void onPersist({ ...config, minimizeToTrayOnClose: !trayOn }, trayOn ? t("toast.trayOff") : t("toast.trayOn"))} role="switch" aria-checked={trayOn}>
              <span className="switch-knob" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
