import type { Profile } from "./types";
import { estimateThreads, type EstimateTier, type EstimatorHardware, type GgufCapacity } from "./profileEstimator";

export type NinferEngineKind = "ninfer" | "ninfer_kvmem";

/** 每元素字节数：4bit 类量化按块缩放折算平均值 */
const KV_ELEMENT_BYTES: Record<string, number> = {
  bf16: 2,
  int8: 1,
  fp8: 1,
  nvfp4: 0.5625,
  rk4v4: 0.5625,
  "rk4v4-e8": 0.5625,
  "rk2v4-e8": 0.4375,
  rk8v4: 0.78125,
  k8v4: 0.78125,
};

const MIB = 1024 * 1024;
const MIN_CONTEXT = 4096;
/** KVMem 历史 KV 预算下限，低于该值引擎没有可选的会话历史 */
const MIN_HISTORY_TOKENS = 4096;
/** KVMem 默认 GPU 历史预算：显存压力大时按可用显存下调 */
const KVMEM_BUDGET = 36864;
/** 为 Windows 桌面 / WebView2 兜底，避免显存被吃满后回退共享内存 */
const SYSTEM_RESERVE_MB = 1024;
/** KVMem 的 Host 缓存在 KV 之外还要放状态快照 */
const HOST_STATE_MB = 2048;

export interface NinferTierEstimate {
  tier: EstimateTier;
  engine: NinferEngineKind;
  contextSize: number;
  kvDtype: string;
  threads: number;
  weightsMb: number;
  overheadMb: number;
  /** 显存里的 KV（KVMem 为历史预算 + 生成预留） */
  kvMb: number;
  /** KVMem 分页到 Host 内存的历史 KV */
  hostKvMb: number;
  /** 写入预设的 Host 内存配额 */
  hostMib: number;
  totalMb: number;
  budgetMb: number;
  nativeContext: number;
  /** 标准 ninfer：--kv-capacity */
  kvCapacity: number;
  /** KVMem：--kvmem-budget / --kvmem-gen-reserve / --kvmem-host-mib */
  kvmemBudget: number;
  kvmemGenReserve: number;
  kvmemHostMib: number;
}

interface TierSpec {
  tier: EstimateTier;
  /** 目标上下文（0 表示原生上限） */
  context: number;
  /** KV 精度候选，从高到低逐个尝试；bf16 只在显存宽裕时才会被选用 */
  dtypeCandidates: string[];
}

/** 标准 ninfer 三档与 KVMem 一致按精度区分：快速低精度，均衡 rk8v4，质量优先 bf16、不够退 int8 */
function ninferSpecs(lowDtype: string): TierSpec[] {
  return [
    { tier: "fast", context: 65536, dtypeCandidates: [lowDtype] },
    { tier: "balanced", context: 131072, dtypeCandidates: ["rk8v4", lowDtype] },
    { tier: "quality", context: 0, dtypeCandidates: ["bf16", "int8", "rk8v4", lowDtype] },
  ];
}

interface KvmemTierSpec {
  tier: EstimateTier;
  /** 目标上下文（0 表示原生上限） */
  context: number;
  /** KV 精度候选，从高到低逐个尝试；bf16 仅在预算不被挤压时才会被选用 */
  dtypeCandidates: string[];
  /** 生成预留：单轮生成与思考的 Token 上限 */
  genReserve: number;
}

/** KVMem 三档按精度区分：快速用最低精度换吞吐，均衡 rk8v4，质量优先 bf16、显存不够退 int8 */
function kvmemSpecs(lowDtype: string): KvmemTierSpec[] {
  return [
    { tier: "fast", context: 65536, dtypeCandidates: [lowDtype], genReserve: 16384 },
    { tier: "balanced", context: 131072, dtypeCandidates: ["rk8v4", lowDtype], genReserve: 4096 },
    { tier: "quality", context: 0, dtypeCandidates: ["bf16", "int8", "rk8v4", lowDtype], genReserve: 2048 },
  ];
}

/** 最低一档 KV 精度：支持 nvfp4 的显卡（Blackwell 及以上）用 nvfp4，其余退回 rk4v4 */
function lowKvDtype(hardware: EstimatorHardware): string {
  return hardware.nvfp4Supported ? "nvfp4" : "rk4v4";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function alignTokens(tokens: number, step = 256): number {
  return Math.max(0, Math.floor(tokens / step) * step);
}

function roundUpMib(mib: number, step = 1024): number {
  return Math.ceil(mib / step) * step;
}

function kvBytesPerToken(capacity: GgufCapacity, kvDtype: string): number {
  const layers = capacity.attentionLayerCount > 0
    ? clamp(capacity.attentionLayerCount, 1, Math.max(capacity.blockCount, 1))
    : capacity.blockCount;
  const elementBytes = KV_ELEMENT_BYTES[kvDtype] ?? 2;
  return 2 * capacity.headCountKv * capacity.headDim * layers * elementBytes;
}

export function canEstimateNinfer(capacity: GgufCapacity): boolean {
  return capacity.weightsBytes > 0 && capacity.blockCount > 0 && capacity.headCountKv > 0 && capacity.headDim > 0;
}

function solveNinfer(
  spec: TierSpec,
  capacity: GgufCapacity,
  hardware: EstimatorHardware,
): NinferTierEstimate | null {
  const nativeContext = capacity.contextLength > 0 ? capacity.contextLength : 131072;
  const weightsMb = capacity.weightsBytes / MIB;
  // CUDA 上下文 / 计算图 / GDN 状态 / 碎片，随权重规模轻微增长
  const overheadMb = 1536 + weightsMb * 0.02;
  const budgetMb = Math.max(0, Math.min(hardware.vramMb * 0.97, hardware.vramMb - SYSTEM_RESERVE_MB));
  const availableMb = budgetMb - weightsMb - overheadMb;
  if (availableMb <= 0) return null;

  const target = spec.context > 0 ? Math.min(spec.context, nativeContext) : nativeContext;
  for (const kvDtype of spec.dtypeCandidates) {
    const perTokenMb = kvBytesPerToken(capacity, kvDtype) / MIB;
    if (perTokenMb <= 0) continue;
    const capacityTokens = alignTokens(Math.min(availableMb / perTokenMb, nativeContext));
    if (capacityTokens < MIN_CONTEXT) continue;
    // bf16 只在显存宽裕（至少放得下默认历史预算级别的上下文）时使用，否则落到下一档精度
    if (kvDtype === "bf16" && capacityTokens < KVMEM_BUDGET) continue;
    const contextSize = clamp(Math.min(target, capacityTokens), MIN_CONTEXT, nativeContext);
    const kvMb = contextSize * perTokenMb;
    return {
      tier: spec.tier,
      engine: "ninfer",
      kvDtype,
      threads: estimateThreads(hardware.cpuThreads),
      weightsMb: Math.round(weightsMb),
      overheadMb: Math.round(overheadMb),
      budgetMb: Math.round(budgetMb),
      nativeContext,
      contextSize,
      kvCapacity: contextSize,
      kvMb: Math.round(kvMb),
      hostKvMb: 0,
      hostMib: 0,
      totalMb: Math.round(weightsMb + overheadMb + kvMb),
      kvmemBudget: 0,
      kvmemGenReserve: 0,
      kvmemHostMib: 0,
    };
  }
  return null;
}

function solveKvmem(
  spec: KvmemTierSpec,
  capacity: GgufCapacity,
  hardware: EstimatorHardware,
): NinferTierEstimate | null {
  const nativeContext = capacity.contextLength > 0 ? capacity.contextLength : 131072;
  const weightsMb = capacity.weightsBytes / MIB;
  const overheadMb = 1536 + weightsMb * 0.02;
  const budgetMb = Math.max(0, Math.min(hardware.vramMb * 0.97, hardware.vramMb - SYSTEM_RESERVE_MB));
  const availableMb = budgetMb - weightsMb - overheadMb;
  if (availableMb <= 0) return null;

  const reserve = spec.genReserve;
  const targetContext = alignTokens(Math.min(spec.context > 0 ? spec.context : nativeContext, nativeContext));
  if (targetContext < MIN_CONTEXT + reserve) return null;

  const ramMb = hardware.systemRamMb ?? 0;
  const hostBudgetMb = Math.max(1024, ramMb > 0 ? ramMb * 0.45 - HOST_STATE_MB : 8192);

  for (const kvDtype of spec.dtypeCandidates) {
    const perTokenMb = kvBytesPerToken(capacity, kvDtype) / MIB;
    if (perTokenMb <= 0) continue;
    // 历史预算默认 36864，显存放不下时按 (可用显存 - 生成预留) 向下收缩
    const ceiling = alignTokens(availableMb / perTokenMb - reserve, 64);
    // bf16 只在显存宽裕（预算还能保持默认值不被挤压）时使用，否则落到下一档精度
    if (kvDtype === "bf16" && ceiling < KVMEM_BUDGET) continue;
    const historyBudget = Math.min(KVMEM_BUDGET, ceiling, targetContext - reserve);
    if (historyBudget < MIN_HISTORY_TOKENS) continue;

    // Host 侧只放历史 KV；内存不够时缩短上下文，保证生成的预设能起来
    let contextSize = targetContext;
    let hostTokens = Math.max(0, contextSize - historyBudget - reserve);
    if (hostTokens * perTokenMb > hostBudgetMb) {
      hostTokens = alignTokens(hostBudgetMb / perTokenMb);
      contextSize = alignTokens(historyBudget + reserve + hostTokens);
    }

    const hostKvMb = hostTokens * perTokenMb;
    const hostMib = roundUpMib(hostKvMb + HOST_STATE_MB);
    const kvMb = (historyBudget + reserve) * perTokenMb;
    return {
      tier: spec.tier,
      engine: "ninfer_kvmem",
      kvDtype,
      threads: estimateThreads(hardware.cpuThreads),
      weightsMb: Math.round(weightsMb),
      overheadMb: Math.round(overheadMb),
      budgetMb: Math.round(budgetMb),
      nativeContext,
      contextSize,
      kvCapacity: 0,
      kvMb: Math.round(kvMb),
      hostKvMb: Math.round(hostKvMb),
      hostMib,
      totalMb: Math.round(weightsMb + overheadMb + kvMb),
      kvmemBudget: historyBudget,
      kvmemGenReserve: reserve,
      kvmemHostMib: hostMib,
    };
  }
  return null;
}

/** 按模型容量、本机硬件与所选引擎生成三档估算；权重都放不下时返回空数组。 */
export function estimateNinferTiers(
  capacity: GgufCapacity,
  hardware: EstimatorHardware,
  engine: NinferEngineKind,
): NinferTierEstimate[] {
  if (!canEstimateNinfer(capacity)) return [];
  const lowDtype = lowKvDtype(hardware);
  if (engine === "ninfer_kvmem") {
    return kvmemSpecs(lowDtype)
      .map((spec) => solveKvmem(spec, capacity, hardware))
      .filter((item): item is NinferTierEstimate => Boolean(item));
  }
  return ninferSpecs(lowDtype)
    .map((spec) => solveNinfer(spec, capacity, hardware))
    .filter((item): item is NinferTierEstimate => Boolean(item));
}

/** 把估算结果写进 ninfer 预设；保留基准预设的投机采样 / 设备标定等设置。 */
export function applyNinferEstimate(
  base: Profile,
  estimate: NinferTierEstimate,
  id: string,
  name: string,
  description: string,
  engineId?: string,
): Profile {
  const kvmem = estimate.engine === "ninfer_kvmem";
  return {
    ...base,
    id,
    name,
    description,
    engineId,
    contextSize: estimate.contextSize,
    threads: estimate.threads,
    parallel: 1,
    gpuLayers: 99,
    kvDtype: estimate.kvDtype,
    cacheTypeK: estimate.kvDtype,
    cacheTypeV: estimate.kvDtype,
    kvCapacity: kvmem ? undefined : estimate.contextSize,
    kvmemBudget: kvmem ? estimate.kvmemBudget : base.kvmemBudget,
    kvmemGenReserve: kvmem ? estimate.kvmemGenReserve : base.kvmemGenReserve,
    kvmemHostMib: kvmem ? estimate.kvmemHostMib : base.kvmemHostMib,
    kvmemSessions: kvmem ? 1 : base.kvmemSessions,
    prefillChunk: 256,
    flashAttention: true,
    gdnStateFp16: true,
  };
}
