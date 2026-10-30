import type { Profile } from "./types";

/** 三档目标：快速 / 均衡 / 质量 */
export type EstimateTier = "fast" | "balanced" | "quality";

export interface GgufCapacity {
  blockCount: number;
  /** 真正缓存 KV 的层数；混合架构（SSM + 全注意力）下小于 blockCount，0 表示未知 */
  attentionLayerCount: number;
  headCountKv: number;
  headDim: number;
  contextLength: number;
  weightsBytes: number;
}

export interface EstimatorHardware {
  /** 可用显存（MiB），0 表示未知 */
  vramMb: number;
  /** 逻辑 CPU 线程数，0 表示未知 */
  cpuThreads: number;
  /** 系统内存（MiB），KVMem 用它决定 Host KV 配额，0/缺省表示未知 */
  systemRamMb?: number;
  /** 显卡是否支持 nvfp4 KV（Blackwell 及以上）；未知视为不支持，退回 rk4v4 */
  nvfp4Supported?: boolean;
}

export interface TierEstimate {
  tier: EstimateTier;
  contextSize: number;
  cacheTypeK: string;
  cacheTypeV: string;
  batchSize: number;
  ubatchSize: number;
  gpuLayers: number;
  blockCount: number;
  /** llama.cpp 的层槽位总数（输出层也占一层，-ngl 等于该值才算全量卸载） */
  layerSlots: number;
  threads: number;
  weightsMb: number;
  kvMb: number;
  computeMb: number;
  /** 预计占用显存（MiB） */
  totalMb: number;
  /** 按目标余量折算的显存预算（MiB） */
  budgetMb: number;
  /** 模型全部层都卸载到显存 */
  fullyOffloaded: boolean;
}

const MIB = 1024 * 1024;
/** 每元素字节数：f16 = 2B，q8_0 = 1.0625B，q4_0 = 0.5625B */
const KV_ELEMENT_BYTES: Record<string, number> = { f16: 2, q8_0: 1.0625, q4_0: 0.5625 };
/** llama.cpp 最低可用上下文 */
const MIN_CONTEXT = 4096;
/** 质量档上下文上限（长上下文收益递减，再高只是吃显存） */
const MAX_QUALITY_CONTEXT = 131072;
/** 为 Windows 桌面 / WebView2 常驻显存兜底，避免小卡溢出触发共享显存回退 */
const SYSTEM_RESERVE_MB = 1024;

interface TierSpec {
  tier: EstimateTier;
  cacheType: string;
  batchSize: number;
  ubatchSize: number;
  /** 允许占用的显存比例（为驱动 / 碎片留余量） */
  fillRatio: number;
}

/** 各档上下文的最低值与上限：显存允许时按 2× 逐级上调 */
const TIER_CONTEXT: Record<Exclude<EstimateTier, "quality">, { base: number; cap: number }> = {
  fast: { base: 16384, cap: 32768 },
  balanced: { base: 32768, cap: 65536 },
};

function contextLimit(capacity: GgufCapacity): number {
  if (capacity.contextLength <= 0) return 32768;
  return Math.min(capacity.contextLength, MAX_QUALITY_CONTEXT);
}

/** 从最低上下文按 2× 爬到模型上限，含起点与上限本身 */
function contextLadder(base: number, cap: number, limit: number): number[] {
  const top = Math.max(Math.min(cap, limit), MIN_CONTEXT);
  const start = Math.min(Math.max(base, MIN_CONTEXT), top);
  const steps: number[] = [];
  for (let ctx = start; ctx < top; ctx *= 2) steps.push(ctx);
  steps.push(top);
  return steps;
}

/** 质量档从模型原生上下文开始，装不下时逐级减半 */
function qualityLadder(limit: number): number[] {
  const floor = Math.max(Math.min(16384, limit), MIN_CONTEXT);
  const steps: number[] = [];
  for (let ctx = Math.max(limit, MIN_CONTEXT); ctx > floor; ctx = Math.max(Math.floor(ctx / 2), floor)) {
    steps.push(ctx);
    if (ctx === floor) break;
  }
  if (!steps.includes(floor)) steps.push(floor);
  return steps;
}

function tierSpecs(capacity: GgufCapacity): { spec: TierSpec; contexts: number[] }[] {
  const limit = contextLimit(capacity);
  return [
    { spec: { tier: "fast", cacheType: "q4_0", batchSize: 2048, ubatchSize: 512, fillRatio: 0.88 }, contexts: contextLadder(TIER_CONTEXT.fast.base, TIER_CONTEXT.fast.cap, limit) },
    { spec: { tier: "balanced", cacheType: "q8_0", batchSize: 1024, ubatchSize: 256, fillRatio: 0.93 }, contexts: contextLadder(TIER_CONTEXT.balanced.base, TIER_CONTEXT.balanced.cap, limit) },
    { spec: { tier: "quality", cacheType: "f16", batchSize: 512, ubatchSize: 128, fillRatio: 0.97 }, contexts: qualityLadder(limit) },
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function estimateThreads(cpuThreads: number): number {
  if (cpuThreads <= 0) return 8;
  return clamp(Math.round(cpuThreads / 2), 4, 16);
}

function solve(
  spec: TierSpec,
  capacity: GgufCapacity,
  hardware: EstimatorHardware,
  contextSize: number,
  cacheType: string,
): TierEstimate {
  const blockCount = Math.max(capacity.blockCount, 0);
  // llama.cpp 的 -ngl 把输出层也算一层，等于 blockCount + 1 才是全量卸载
  const layerSlots = blockCount + 1;
  const weightsMb = capacity.weightsBytes / MIB;
  // 计算缓冲随权重规模线性增长（图 / 临时张量），另加固定驱动与上下文开销
  const computeMb = 384 + weightsMb * 0.045;
  const elementBytes = KV_ELEMENT_BYTES[cacheType] ?? 2;
  const kvBytesPerLayer = 2 * capacity.headCountKv * capacity.headDim * elementBytes * contextSize;
  // 混合架构里只有部分层带 KV，按比例摊到每个 block 层，分层卸载时也能按平均占用估算
  const attentionLayers = capacity.attentionLayerCount > 0
    ? clamp(capacity.attentionLayerCount, 1, blockCount)
    : blockCount;
  const kvPerLayerMb = blockCount > 0 ? (kvBytesPerLayer / MIB) * (attentionLayers / blockCount) : 0;
  // 权重按层槽位均摊（embedding / 输出层偏大，仅作估算）
  const weightsPerLayerMb = weightsMb > 0 ? weightsMb / layerSlots : 0;
  // 百分比余量随显存放大，小卡上再叠加固定保留量，避免只剩几百 MB 给桌面
  const budgetMb = hardware.vramMb > 0
    ? Math.max(0, Math.min(hardware.vramMb * spec.fillRatio, hardware.vramMb - SYSTEM_RESERVE_MB))
    : 0;

  let gpuLayers = layerSlots;
  if (hardware.vramMb > 0) {
    const perLayerMb = weightsPerLayerMb + kvPerLayerMb;
    const affordable = perLayerMb > 0 ? Math.floor((budgetMb - computeMb) / perLayerMb) : layerSlots;
    if (affordable >= blockCount) {
      // 输出层没有 KV，逐层摊算会把它算贵；这里用真实总量单独判断能否全量卸载
      const fullTotalMb = computeMb + weightsPerLayerMb * layerSlots + kvPerLayerMb * blockCount;
      gpuLayers = fullTotalMb <= budgetMb ? layerSlots : blockCount;
    } else {
      gpuLayers = clamp(affordable, 0, layerSlots);
    }
  }

  // 输出层没有 KV 缓存
  const kvMb = kvPerLayerMb * Math.min(gpuLayers, blockCount);
  const totalMb = computeMb + weightsPerLayerMb * gpuLayers + kvMb;
  return {
    tier: spec.tier,
    contextSize,
    cacheTypeK: cacheType,
    cacheTypeV: cacheType,
    batchSize: spec.batchSize,
    ubatchSize: spec.ubatchSize,
    gpuLayers,
    blockCount,
    layerSlots,
    threads: estimateThreads(hardware.cpuThreads),
    weightsMb: Math.round(weightsMb),
    kvMb: Math.round(kvMb),
    computeMb: Math.round(computeMb),
    totalMb: Math.round(totalMb),
    budgetMb: Math.round(budgetMb),
    fullyOffloaded: gpuLayers >= layerSlots,
  };
}

/** 全量卸载优先，其次卸载层数，最后上下文更大者优先 */
function pickBest(attempts: TierEstimate[]): TierEstimate {
  return attempts.reduce((best, attempt) => {
    if (attempt.fullyOffloaded !== best.fullyOffloaded) return attempt.fullyOffloaded ? attempt : best;
    if (attempt.gpuLayers !== best.gpuLayers) return attempt.gpuLayers > best.gpuLayers ? attempt : best;
    return attempt.contextSize > best.contextSize ? attempt : best;
  });
}

/** 快速 / 均衡档：若显存允许，取阶梯中最大的可全量卸载上下文 */
function solveLadder(spec: TierSpec, contexts: number[], capacity: GgufCapacity, hardware: EstimatorHardware): TierEstimate {
  const attempts = contexts.map((contextSize) => solve(spec, capacity, hardware, contextSize, spec.cacheType));
  const full = attempts.filter((attempt) => attempt.fullyOffloaded);
  return full.length ? full[full.length - 1] : pickBest(attempts);
}

/**
 * 质量档：上下文优先（从模型原生长度逐级减半），同级再依次尝试 f16 → q8_0。
 * 不降到 q4_0——避免出现质量档 KV 精度反而不如均衡档的倒挂。
 */
function solveQuality(spec: TierSpec, contexts: number[], capacity: GgufCapacity, hardware: EstimatorHardware): TierEstimate {
  const attempts: TierEstimate[] = [];
  for (const contextSize of contexts) {
    for (const cacheType of ["f16", "q8_0"]) {
      const attempt = solve(spec, capacity, hardware, contextSize, cacheType);
      if (attempt.fullyOffloaded) return attempt;
      attempts.push(attempt);
    }
  }
  return pickBest(attempts);
}

/** 判断元数据是否足够做显存估算（缺权重体积或 KV 结构时无法算）。 */
export function canEstimate(capacity: GgufCapacity): boolean {
  return capacity.weightsBytes > 0 && capacity.blockCount > 0 && capacity.headCountKv > 0 && capacity.headDim > 0;
}

/** 按模型容量与本机硬件生成三档估算；元数据不足时返回空数组。 */
export function estimateTiers(capacity: GgufCapacity, hardware: EstimatorHardware): TierEstimate[] {
  if (!canEstimate(capacity)) return [];
  return tierSpecs(capacity).map(({ spec, contexts }) =>
    spec.tier === "quality" ? solveQuality(spec, contexts, capacity, hardware) : solveLadder(spec, contexts, capacity, hardware),
  );
}

/** 把估算结果落到预设字段上（其余字段沿用基准预设，保留引擎 / 多模态等设置）。 */
export function applyEstimate(base: Profile, estimate: TierEstimate, id: string, name: string, description: string): Profile {
  return {
    ...base,
    id,
    name,
    description,
    gpuLayers: estimate.gpuLayers,
    contextSize: estimate.contextSize,
    threads: estimate.threads,
    batchSize: estimate.batchSize,
    ubatchSize: estimate.ubatchSize,
    cacheTypeK: estimate.cacheTypeK,
    cacheTypeV: estimate.cacheTypeV,
    // 量化 KV 与长上下文都依赖 FA，生成预设强制开启，不受基准预设影响
    flashAttention: true,
  };
}
