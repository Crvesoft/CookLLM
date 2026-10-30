import { DEFAULT_NINFER_PROFILES, DEFAULT_PROFILES, uid } from "./data";
import type { Translate } from "./hooks/types";
import { applyNinferEstimate, estimateNinferTiers, type NinferEngineKind } from "./ninferEstimator";
import { applyEstimate, canEstimate, estimateTiers, type EstimateTier, type GgufCapacity } from "./profileEstimator";
import type { LlamaEngine, Profile } from "./types";
import type { MessageKey } from "./i18n";

const tierKey = (tier: EstimateTier, field: "name" | "desc"): MessageKey => `autoProfile.tier.${tier}.${field}` as MessageKey;

/** 旧配置里引擎可能没有 engineType，按名称 / 路径兜底识别 */
export function engineKindOf(engine?: LlamaEngine): NinferEngineKind | null {
  if (!engine) return null;
  if (engine.engineType === "ninfer" || engine.engineType === "ninfer_kvmem") return engine.engineType;
  const probe = `${engine.name ?? ""} ${engine.path ?? ""}`.toLowerCase();
  if (probe.includes("kvmem")) return "ninfer_kvmem";
  if (probe.includes("ninfer")) return "ninfer";
  return null;
}

/** nvfp4 KV 需要 Blackwell 及以上；读不到计算能力时按 RTX 50 系名称兜底，其余退回 rk4v4 */
export function nvfp4SupportedOf(hardware: { computeCapMajor?: number | null; gpuName?: string | null }): boolean {
  if (hardware.computeCapMajor != null) return hardware.computeCapMajor >= 10;
  return /rtx\s*50\d\d/i.test(hardware.gpuName ?? "");
}

/** NINFER 引擎选择：两个都装了优先 KVMem（256K 上下文），只装其一就用对应的 */
export function pickNinferEngine(engines: LlamaEngine[]): { kind: NinferEngineKind; engine: LlamaEngine } | null {
  const kvmem = engines.find((engine) => engineKindOf(engine) === "ninfer_kvmem");
  if (kvmem) return { kind: "ninfer_kvmem", engine: kvmem };
  const standard = engines.find((engine) => engineKindOf(engine) === "ninfer");
  if (standard) return { kind: "ninfer", engine: standard };
  return null;
}

export interface AutoProfileOutcome {
  profiles: Profile[];
  /** 默认预设指向均衡档；生成方写入模型资产时沿用 */
  defaultProfileId: string;
}

/** 模型入库时的智能预设生成：GGUF 与 NINFER 共用，估算不出来时由调用方退回默认预设 */
export function buildAutoProfiles(
  capacity: GgufCapacity | null,
  hardware: { vramMb: number; cpuThreads: number; systemRamMb?: number; nvfp4Supported?: boolean },
  t: Translate,
  options: { isNinfer: boolean; engines?: LlamaEngine[] },
): AutoProfileOutcome | null {
  if (!capacity || hardware.vramMb <= 0) return null;
  if (options.isNinfer) {
    const picked = pickNinferEngine(options.engines ?? []);
    if (!picked) return null;
    const tiers = estimateNinferTiers(capacity, { ...hardware }, picked.kind);
    if (!tiers.length) return null;
    const profiles = tiers.map((estimate) => applyNinferEstimate(
      DEFAULT_NINFER_PROFILES[0],
      estimate,
      uid("profile"),
      `${t("autoProfile.namePrefix")}${t(tierKey(estimate.tier, "name"))}`,
      t(tierKey(estimate.tier, "desc")),
      picked.engine.id,
    ));
    const preferred = profiles[tiers.findIndex((estimate) => estimate.tier === "balanced")] ?? profiles[0];
    return { profiles, defaultProfileId: preferred.id };
  }
  if (!canEstimate(capacity)) return null;
  const tiers = estimateTiers(capacity, hardware);
  if (!tiers.length) return null;
  const profiles = tiers.map((estimate) => applyEstimate(
    DEFAULT_PROFILES[0],
    estimate,
    uid("profile"),
    `${t("autoProfile.namePrefix")}${t(tierKey(estimate.tier, "name"))}`,
    t(tierKey(estimate.tier, "desc")),
  ));
  const preferred = profiles[tiers.findIndex((estimate) => estimate.tier === "balanced")] ?? profiles[0];
  return { profiles, defaultProfileId: preferred.id };
}
