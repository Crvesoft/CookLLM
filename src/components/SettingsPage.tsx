import type { UpdateCheckResult } from "../tauri";
import type { AppConfig, LlamaEngine, LlamaLogPayload } from "../types";
import AboutCard from "./settings/AboutCard";
import EngineCard from "./settings/EngineCard";
import HfTokenCard from "./settings/HfTokenCard";
import NetworkCard from "./settings/NetworkCard";
import PerformanceCard from "./settings/PerformanceCard";
import PreferencesCard from "./settings/PreferencesCard";
import ShortcutsCard from "./settings/ShortcutsCard";
import SidebarNavCard from "./settings/SidebarNavCard";

interface Props {
  visible: boolean;
  config: AppConfig;
  activeEngine?: LlamaEngine;
  appUpdate: UpdateCheckResult | null;
  checkingUpdate: boolean;
  onCheckUpdate: (openWhenAvailable?: boolean) => Promise<UpdateCheckResult>;
  onPersist: (config: AppConfig, message?: string) => Promise<void>;
  onLog: (line: string, stream?: LlamaLogPayload["stream"]) => void;
  onOpenEngineHub?: () => void;
  onExportBackup: () => Promise<void>;
  onImportBackup: () => Promise<void>;
}

export default function SettingsPage({ visible, config, activeEngine, appUpdate, checkingUpdate, onCheckUpdate, onPersist, onLog, onOpenEngineHub, onExportBackup, onImportBackup }: Props) {
  return (
    <div hidden={!visible}>
      <section className="settings-stack">
        <PreferencesCard config={config} onPersist={onPersist} onLog={onLog} onExportBackup={onExportBackup} onImportBackup={onImportBackup} />
        <EngineCard config={config} activeEngine={activeEngine} onPersist={onPersist} onLog={onLog} onOpenEngineHub={onOpenEngineHub} />
        <SidebarNavCard config={config} onPersist={onPersist} />
        <PerformanceCard config={config} onPersist={onPersist} />
        <ShortcutsCard config={config} onPersist={onPersist} />
        <NetworkCard config={config} onPersist={onPersist} />
        <HfTokenCard config={config} onPersist={onPersist} />
        <AboutCard config={config} appUpdate={appUpdate} checkingUpdate={checkingUpdate} onCheckUpdate={onCheckUpdate} onPersist={onPersist} onLog={onLog} />
      </section>
    </div>
  );
}
