import { AlertTriangle, Check, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_NINFER_PROFILES, DEFAULT_PROFILES, uid } from "../data";
import { engineKindOf, nvfp4SupportedOf } from "../autoProfiles";
import { useI18n, type MessageKey } from "../i18n";
import { applyNinferEstimate, estimateNinferTiers, type NinferEngineKind } from "../ninferEstimator";
import { applyEstimate, canEstimate, estimateTiers, type EstimateTier, type GgufCapacity } from "../profileEstimator";
import { getHardwareInfo, inspectGguf, type HardwareInfo } from "../tauri";
import type { LlamaEngine, ModelAsset, Profile } from "../types";
import { cn, modelTitle } from "../utils";

const TIER_ORDER: EstimateTier[] = ["fast", "balanced", "quality"];
const MIB = 1024 * 1024;
const NINFER_ENGINES: { kind: NinferEngineKind; label: string }[] = [
  { kind: "ninfer", label: "NInfer" },
  { kind: "ninfer_kvmem", label: "KVMem" },
];

const tierKey = (tier: EstimateTier, field: "name" | "desc"): MessageKey => `autoProfile.tier.${tier}.${field}` as MessageKey;

/** 以 GB 展示显存（保留一位小数） */
const gb = (mib: number) => (mib / 1024).toFixed(1);

const isNinferModel = (model: ModelAsset) =>
  Boolean(model.path?.toLowerCase().endsWith(".ninfer") || model.metadataSource === "ninfer");

export default function AutoProfileModal({
  model,
  baseProfile,
  engines = [],
  hasDefaultProfile,
  onClose,
  onGenerate,
}: {
  model: ModelAsset;
  baseProfile?: Profile;
  engines?: LlamaEngine[];
  hasDefaultProfile: boolean;
  onClose: () => void;
  onGenerate: (profiles: Profile[], defaultProfileId?: string) => void;
}) {
  const { t } = useI18n();
  const isNinfer = isNinferModel(model);
  const [meta, setMeta] = useState<GgufCapacity | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [vramInput, setVramInput] = useState("");
  const [selected, setSelected] = useState<Set<EstimateTier>>(() => new Set(TIER_ORDER));
  const [engineKind, setEngineKind] = useState<NinferEngineKind>(() => {
    const baseType = engineKindOf(engines.find((engine) => engine.id === baseProfile?.engineId));
    if (baseType) return baseType;
    return engines.some((engine) => engineKindOf(engine) === "ninfer_kvmem") ? "ninfer_kvmem" : "ninfer";
  });

  const engineFor = (kind: NinferEngineKind) => engines.find((engine) => engineKindOf(engine) === kind);
  const activeEngine = engineFor(engineKind);
  const engineReady = !isNinfer || Boolean(activeEngine);

  useEffect(() => {
    let alive = true;
    Promise.all([inspectGguf(model.path).catch(() => null), getHardwareInfo().catch(() => null)]).then(([nextMeta, nextHardware]) => {
      if (!alive) return;
      if (nextMeta) {
        setMeta({
          blockCount: nextMeta.blockCount,
          attentionLayerCount: nextMeta.attentionLayerCount,
          headCountKv: nextMeta.headCountKv,
          headDim: nextMeta.headDim,
          contextLength: nextMeta.contextLength,
          weightsBytes: nextMeta.weightsBytes,
        });
      }
      setHardware(nextHardware);
      const totalMb = nextHardware?.vramTotalMb ?? 0;
      if (totalMb > 0) setVramInput((totalMb / 1024).toFixed(0));
      setLoading(false);
    });
    return () => { alive = false; };
  }, [model.path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vramMb = Math.max(0, Number.parseFloat(vramInput) || 0) * 1024;
  const capacityReady = Boolean(meta && canEstimate(meta));
  const cpuThreads = hardware?.cpuThreads ?? 0;
  const systemRamMb = hardware?.systemRamMb ?? 0;
  const nvfp4Supported = nvfp4SupportedOf(hardware ?? {});
  const ninferDtype = nvfp4Supported ? "nvfp4" : "rk4v4";

  const estimates = useMemo(
    () => (capacityReady && meta && vramMb > 0 && !isNinfer ? estimateTiers(meta, { vramMb, cpuThreads }) : []),
    [capacityReady, meta, vramMb, cpuThreads, isNinfer],
  );
  const ninferEstimates = useMemo(
    () => (capacityReady && meta && vramMb > 0 && isNinfer && engineReady
      ? estimateNinferTiers(meta, { vramMb, cpuThreads, systemRamMb, nvfp4Supported }, engineKind)
      : []),
    [capacityReady, meta, vramMb, cpuThreads, systemRamMb, nvfp4Supported, isNinfer, engineReady, engineKind],
  );
  const chosenCount = (isNinfer ? ninferEstimates : estimates).filter((estimate) => selected.has(estimate.tier)).length;

  const toggleTier = (tier: EstimateTier) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  };

  const generate = () => {
    if (isNinfer) {
      const chosen = ninferEstimates.filter((estimate) => selected.has(estimate.tier));
      if (!chosen.length || !activeEngine) return;
      /** 以模型已有的首套预设为模板，保留推理 / 设备标定等设置 */
      const base = baseProfile ?? DEFAULT_NINFER_PROFILES[0];
      const pairs = chosen.map((estimate) => ({
        tier: estimate.tier,
        profile: applyNinferEstimate(
          base,
          estimate,
          uid("profile"),
          `${t("autoProfile.namePrefix")}${t(tierKey(estimate.tier, "name"))}`,
          t(tierKey(estimate.tier, "desc")),
          activeEngine.id,
        ),
      }));
      const preferred = pairs.find((pair) => pair.tier === "balanced")?.profile ?? pairs[0].profile;
      onGenerate(pairs.map((pair) => pair.profile), hasDefaultProfile ? undefined : preferred.id);
      return;
    }
    const chosen = estimates.filter((estimate) => selected.has(estimate.tier));
    if (!chosen.length) return;
    /** 以模型已有的首套预设为模板，保留引擎 / 端口 / 多模态等设置 */
    const base = baseProfile ?? DEFAULT_PROFILES[0];
    const pairs = chosen.map((estimate) => ({
      tier: estimate.tier,
      profile: applyEstimate(
        base,
        estimate,
        uid("profile"),
        `${t("autoProfile.namePrefix")}${t(tierKey(estimate.tier, "name"))}`,
        t(tierKey(estimate.tier, "desc")),
      ),
    }));
    const preferred = pairs.find((pair) => pair.tier === "balanced")?.profile ?? pairs[0].profile;
    onGenerate(pairs.map((pair) => pair.profile), hasDefaultProfile ? undefined : preferred.id);
  };

  const weightsGb = meta ? gb(meta.weightsBytes / MIB) : null;
  const kvLayers = meta ? (meta.attentionLayerCount > 0 ? Math.min(meta.attentionLayerCount, meta.blockCount) : meta.blockCount) : 0;
  const kvPerTokenKib = meta ? (2 * meta.headCountKv * meta.headDim * kvLayers * 2) / 1024 : 0;
  const ninferDtypeText = (ninferEstimates.length
    ? [...new Set(ninferEstimates.map((estimate) => estimate.kvDtype))]
    : [ninferDtype, "rk8v4", "int8"]).join(" / ");
  const gpuName = hardware?.gpuName?.trim() || (hardware?.vendor === "nvidia" ? "NVIDIA GPU" : hardware?.vendor === "amd" ? "AMD GPU" : "");
  const vramGbText = vramMb > 0 ? gb(vramMb) : "—";
  const ramGbText = hardware?.systemRamMb ? String(Math.round(hardware.systemRamMb / 1024)) : "—";
  const threadText = cpuThreads > 0 ? String(cpuThreads) : "—";
  const activeLabel = NINFER_ENGINES.find((item) => item.kind === engineKind)?.label ?? "";
  const hasEstimates = isNinfer ? ninferEstimates.length > 0 : estimates.length > 0;
  /** 加载中的骨架沿用真实档位卡的字段布局（标题 / 说明 / 显存 / 规格行），高度一致才不会在估算返回时跳变 */
  const skeletonSpecKeys = isNinfer
    ? engineKind === "ninfer_kvmem"
      ? ["specContext", "specKv", "specKvBudget", "specHost"]
      : ["specContext", "specKv", "specKvCapacity", "specThreads"]
    : ["specContext", "specKv", "specLayers", "specBatch"];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="auto-modal">
        <header>
          <div className="auto-icon-tile"><Sparkles size={19} /></div>
          <div className="auto-head-text">
            <div className="auto-head-tagline">
              <span>{t("autoProfile.tag")}</span>
              <span className={cn("hf-format-pill", isNinfer ? "ninfer" : "gguf")}>{isNinfer ? "NINFER" : "GGUF"}</span>
            </div>
            <h2 title={modelTitle(model)}>{t("autoProfile.heading", { model: modelTitle(model) })}</h2>
          </div>
          <div className="auto-head-spacer" />
          <button className="ghost-icon" aria-label={t("ariaClose")} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="auto-body">
          <div className="auto-basis">
            <div>
              <div className="auto-cap">{t("autoProfile.modelCap")}</div>
              <div className="auto-main-line">{modelTitle(model)}</div>
              {meta && capacityReady ? (
                <>
                  <div className="auto-sub-line">
                    {t("autoProfile.modelMeta", {
                      params: model.parameters || "—",
                      quant: model.quantization || "—",
                      layers: meta.blockCount,
                      size: weightsGb ?? "—",
                    })}
                  </div>
                  <div className="auto-sub-line">
                    {isNinfer
                      ? t("autoProfile.kvPerTokenTiers", { dtypes: ninferDtypeText })
                      : t("autoProfile.kvPerToken", { kv: kvPerTokenKib.toFixed(0) })}
                  </div>
                </>
              ) : (
                <>
                  <div className="auto-sub-line">—</div>
                  <div className="auto-sub-line">—</div>
                </>
              )}
            </div>
            <div className="auto-hw">
              <div className="auto-cap">{t("autoProfile.hardwareCap")}</div>
              <div className="auto-main-line">
                {gpuName ? t("autoProfile.hardwareLine", { gpu: gpuName, vram: vramGbText }) : t("autoProfile.hardwareUnknown")}
              </div>
              <div className="auto-sub-line auto-vram-row">
                <span>{t("autoProfile.vramLabel")}</span>
                <input
                  type="number"
                  min={1}
                  max={512}
                  step={1}
                  value={vramInput}
                  onChange={(event) => setVramInput(event.target.value)}
                  aria-label={t("autoProfile.vramLabel")}
                />
                <em>GB</em>
              </div>
              <div className="auto-sub-line">{t("autoProfile.hardwareFoot", { ram: ramGbText, threads: threadText })}</div>
            </div>
          </div>

          {/* 引擎选择与硬件无关，先渲染出来，估算返回时不再顶高弹窗 */}
          {isNinfer && (
            <div className="auto-engine">
              <span className="auto-cap">{t("autoProfile.engine")}</span>
              <div className="auto-engine-tabs" role="tablist">
                {NINFER_ENGINES.map((option) => {
                  const engine = engineFor(option.kind);
                  return (
                    <button
                      key={option.kind}
                      type="button"
                      role="tab"
                      aria-selected={engineKind === option.kind}
                      className={cn("auto-engine-tab", engineKind === option.kind && "active", !engine && "disabled")}
                      disabled={!engine}
                      title={engine ? engine.name : t("autoProfile.engineMissing", { engine: option.label })}
                      onClick={() => setEngineKind(option.kind)}
                    >
                      <strong>{option.label}</strong>
                      <small>{engine ? engine.name : t("autoProfile.engineNotInstalled")}</small>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isNinfer && !engineReady && (
            <div className="auto-hint warn"><AlertTriangle size={14} />{t("autoProfile.engineMissing", { engine: activeLabel })}</div>
          )}

          {loading ? (
            <>
              <div className="auto-section-line">
                <strong>{t("autoProfile.section")}</strong>
              </div>
              <div className="auto-tiers" aria-hidden="true">
                {TIER_ORDER.map((tier, index) => (
                  <div key={tier} className="auto-tier skeleton">
                    <div className="auto-tier-top">
                      <span className="auto-tier-num">{String(index + 1).padStart(2, "0")}</span>
                      <h4>{t(tierKey(tier, "name"))}</h4>
                    </div>
                    <p className="auto-tier-desc">{t(tierKey(tier, "desc"))}</p>
                    <div className="auto-vram-head">
                      <span>{t("autoProfile.vramEstimate")}</span>
                      <span className="auto-skel-line" />
                    </div>
                    <div className="auto-bar"><i style={{ width: "0%" }} /></div>
                    {skeletonSpecKeys.map((key) => (
                      <div className="auto-spec" key={key}>
                        <span>{t(`autoProfile.${key}` as MessageKey)}</span>
                        <span className="auto-skel-line short" />
                      </div>
                    ))}
                    <div className="auto-tier-foot"><span className="auto-skel-line" /></div>
                  </div>
                ))}
              </div>
            </>
          ) : !capacityReady ? (
            <div className="auto-hint warn"><AlertTriangle size={14} />{t("autoProfile.unavailable")}</div>
          ) : vramMb <= 0 ? (
            <div className="auto-hint warn"><AlertTriangle size={14} />{t("autoProfile.noVram")}</div>
          ) : (
            <>
              {hasEstimates ? (
                <>
                  <div className="auto-section-line">
                    <strong>{t("autoProfile.section")}</strong>
                    <em>{t("autoProfile.sectionHint", { selected: chosenCount, total: TIER_ORDER.length })}</em>
                  </div>
                  <div className="auto-tiers">
                    {isNinfer
                      ? ninferEstimates.map((estimate, index) => {
                        const on = selected.has(estimate.tier);
                        const ratio = Math.min(100, Math.round((estimate.totalMb / vramMb) * 100));
                        const remainingMb = vramMb - estimate.totalMb;
                        return (
                          <button type="button" key={estimate.tier} className={cn("auto-tier", on && "on")} onClick={() => toggleTier(estimate.tier)} aria-pressed={on}>
                            <div className="auto-tier-top">
                              <span className="auto-tier-num">{String(index + 1).padStart(2, "0")}</span>
                              <h4>{t(tierKey(estimate.tier, "name"))}</h4>
                              <span className="auto-tier-check">{on && <Check size={11} strokeWidth={3} />}</span>
                            </div>
                            <p className="auto-tier-desc">{t(tierKey(estimate.tier, "desc"))}</p>
                            <div className="auto-vram-head">
                              <span>{t("autoProfile.vramEstimate")}</span>
                              <b>{`${gb(estimate.totalMb)} / ${gb(vramMb)} GB`}</b>
                            </div>
                            <div className="auto-bar"><i style={{ width: `${ratio}%` }} /></div>
                            <div className="auto-spec"><span>{t("autoProfile.specContext")}</span><b>{estimate.contextSize.toLocaleString()}</b></div>
                            <div className="auto-spec"><span>{t("autoProfile.specKv")}</span><b>{estimate.kvDtype}</b></div>
                            {estimate.engine === "ninfer_kvmem" ? (
                              <>
                                <div className="auto-spec">
                                  <span>{t("autoProfile.specKvBudget")}</span>
                                  <b>{`${estimate.kvmemBudget.toLocaleString()} + ${estimate.kvmemGenReserve.toLocaleString()}`}</b>
                                </div>
                                <div className="auto-spec">
                                  <span>{t("autoProfile.specHost")}</span>
                                  <b>{`${gb(estimate.hostKvMb)} / ${gb(estimate.kvmemHostMib)} GB`}</b>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="auto-spec"><span>{t("autoProfile.specKvCapacity")}</span><b>{estimate.kvCapacity.toLocaleString()}</b></div>
                                <div className="auto-spec"><span>{t("autoProfile.specThreads")}</span><b>{estimate.threads}</b></div>
                              </>
                            )}
                            <div className={cn("auto-tier-foot", remainingMb <= 1024 && "tight")}>
                              {remainingMb <= 1024
                                ? t("autoProfile.tight", { size: gb(remainingMb) })
                                : t("autoProfile.remaining", { size: gb(remainingMb) })}
                            </div>
                          </button>
                        );
                      })
                      : estimates.map((estimate, index) => {
                        const on = selected.has(estimate.tier);
                        const ratio = Math.min(100, Math.round((estimate.totalMb / vramMb) * 100));
                        const remainingGb = (vramMb - estimate.totalMb) / 1024;
                        return (
                          <button type="button" key={estimate.tier} className={cn("auto-tier", on && "on")} onClick={() => toggleTier(estimate.tier)} aria-pressed={on}>
                            <div className="auto-tier-top">
                              <span className="auto-tier-num">{String(index + 1).padStart(2, "0")}</span>
                              <h4>{t(tierKey(estimate.tier, "name"))}</h4>
                              <span className="auto-tier-check">{on && <Check size={11} strokeWidth={3} />}</span>
                            </div>
                            <p className="auto-tier-desc">{t(tierKey(estimate.tier, "desc"))}</p>
                            <div className="auto-vram-head">
                              <span>{t("autoProfile.vramEstimate")}</span>
                              <b>{`${gb(estimate.totalMb)} / ${gb(vramMb)} GB`}</b>
                            </div>
                            <div className="auto-bar"><i style={{ width: `${ratio}%` }} /></div>
                            <div className="auto-spec"><span>{t("autoProfile.specContext")}</span><b>{estimate.contextSize.toLocaleString()}</b></div>
                            <div className="auto-spec"><span>{t("autoProfile.specKv")}</span><b>{estimate.cacheTypeK}</b></div>
                            <div className="auto-spec"><span>{t("autoProfile.specLayers")}</span><b>{`${estimate.gpuLayers} / ${estimate.layerSlots}`}</b></div>
                            <div className="auto-spec"><span>{t("autoProfile.specBatch")}</span><b>{`${estimate.batchSize} / ${estimate.ubatchSize}`}</b></div>
                            <div className={cn("auto-tier-foot", !estimate.fullyOffloaded && "tight")}>
                              {!estimate.fullyOffloaded
                                ? estimate.gpuLayers > 0
                                  ? t("autoProfile.partial", { loaded: estimate.gpuLayers, total: estimate.layerSlots })
                                  : t("autoProfile.none")
                                : remainingGb <= 1
                                  ? t("autoProfile.tight", { size: gb(vramMb - estimate.totalMb) })
                                  : t("autoProfile.remaining", { size: gb(vramMb - estimate.totalMb) })}
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </>
              ) : isNinfer && engineReady ? (
                <div className="auto-hint warn"><AlertTriangle size={14} />{t("autoProfile.tooTight")}</div>
              ) : null}
            </>
          )}
        </div>

        <footer>
          <div className="auto-foot-note">{isNinfer ? t("autoProfile.footerNoteNinfer") : t("autoProfile.footerNote")}</div>
          <button className="secondary-button" onClick={onClose}>{t("cancel")}</button>
          <button className="primary-button" onClick={generate} disabled={!chosenCount || (isNinfer && !engineReady)}>
            <Sparkles size={15} />{t("autoProfile.generate", { count: chosenCount })}
          </button>
        </footer>
      </section>
    </div>
  );
}
