/**
 * 智能推荐显存估算回归测试：三档策略、KV 精度降级、分层卸载与线程夹取。
 * 运行：npm run test:estimator
 */
import { canEstimate, estimateThreads, estimateTiers, applyEstimate, type GgufCapacity } from "../src/profileEstimator";
import type { Profile } from "../src/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];
declare const process: { exit(code: number): void };

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}: 期望 ${e} 实际 ${a}`);
  }
}

function checkTrue(name: string, condition: boolean): void {
  check(name, condition, true);
}

const GB = 1024 * 1024 * 1024;
/** 27B Q4_K_M 量级：64 层、8 个 KV 头、head_dim 128、32K 原生上下文 */
const largeModel: GgufCapacity = {
  blockCount: 64,
  attentionLayerCount: 64,
  headCountKv: 8,
  headDim: 128,
  contextLength: 32768,
  weightsBytes: 16.5 * GB,
};
/** 8B 量级：32 层、4GB 权重 */
const smallModel: GgufCapacity = {
  blockCount: 32,
  attentionLayerCount: 32,
  headCountKv: 8,
  headDim: 128,
  contextLength: 32768,
  weightsBytes: 4 * GB,
};
/** 9B Q3_K_M 量级：32 层、4.3GB 权重、128K 原生上下文（用户实测机型） */
const mediumModel: GgufCapacity = {
  blockCount: 32,
  attentionLayerCount: 32,
  headCountKv: 8,
  headDim: 128,
  contextLength: 131072,
  weightsBytes: 4.3 * GB,
};
/** Qwen3.5 混合架构：32 层里每 4 层一层全注意力（8 层带 KV）、256 维头、原生 256K */
const hybridModel: GgufCapacity = {
  blockCount: 32,
  attentionLayerCount: 8,
  headCountKv: 4,
  headDim: 256,
  contextLength: 262144,
  weightsBytes: 4.3 * GB,
};

{
  const tiers = estimateTiers(largeModel, { vramMb: 24576, cpuThreads: 16 });
  check("三档数量", tiers.length, 3);
  const [fast, balanced, quality] = tiers;
  check("快速上下文按显存升到上限", fast.contextSize, 32768);
  check("快速 KV 精度", [fast.cacheTypeK, fast.cacheTypeV], ["q4_0", "q4_0"]);
  check("均衡上下文档位", balanced.contextSize, 32768);
  check("均衡 KV 精度", balanced.cacheTypeK, "q8_0");
  check("质量上下文截断到模型原生", quality.contextSize, 32768);
  check("质量档在 24G 内选可全量卸载的最高精度", quality.cacheTypeK, "q8_0");
  checkTrue("大显存全部卸载", fast.fullyOffloaded && balanced.fullyOffloaded && quality.fullyOffloaded);
  check("全量卸载含输出层", [fast.gpuLayers, fast.layerSlots], [65, 65]);
  checkTrue("质量档显存未超预算", quality.totalMb <= quality.budgetMb);
  check("线程数取一半", fast.threads, 8);
}

{
  const tiers = estimateTiers(largeModel, { vramMb: 32768, cpuThreads: 16 });
  check("显存充裕时质量档用 f16", tiers[2].cacheTypeK, "f16");
  checkTrue("显存充裕时全量卸载", tiers[2].fullyOffloaded);
}

{
  const tiers = estimateTiers(mediumModel, { vramMb: 16384, cpuThreads: 16 });
  const [fast, balanced, quality] = tiers;
  check("快速档最低 16K 起按显存上调", fast.contextSize, 32768);
  check("均衡档 32K 起按显存上调", balanced.contextSize, 65536);
  check("质量档用满 128K 原生上下文", quality.contextSize, 131072);
  check("128K 下 KV 降级 q8_0", quality.cacheTypeK, "q8_0");
  checkTrue("三档全部全量卸载", tiers.every((tier) => tier.fullyOffloaded));
}

{
  const tiers = estimateTiers(largeModel, { vramMb: 8192, cpuThreads: 16 });
  checkTrue("小显存全部为分层卸载", tiers.every((tier) => !tier.fullyOffloaded && tier.gpuLayers > 0));
  checkTrue("分层数不超过总层数", tiers.every((tier) => tier.gpuLayers < tier.blockCount));
  check("装不满时快速档保留 16K 底线", tiers[0].contextSize, 16384);
  check("小显存预算为桌面保留 1GB", tiers[0].budgetMb, 8192 - 1024);
  check("质量档装不下也不降到 q4_0", tiers[2].cacheTypeK, "q8_0");
  checkTrue("占用不超过预算", tiers.every((tier) => tier.totalMb <= tier.budgetMb));
}

{
  const tiers = estimateTiers(smallModel, { vramMb: 8192, cpuThreads: 16 });
  const quality = tiers[2];
  checkTrue("f16 装不下时降级 q8_0", quality.cacheTypeK === "q8_0" || quality.cacheTypeK === "q4_0");
  checkTrue("降级后仍可全量卸载或至少能跑", quality.gpuLayers > 0);
}

{
  const tiers = estimateTiers(hybridModel, { vramMb: 16384, cpuThreads: 16 });
  const quality = tiers[2];
  check("混合架构上下文截到 128K", quality.contextSize, 131072);
  check("混合架构 16G 用 f16 KV", quality.cacheTypeK, "f16");
  check("混合架构只按 8 层算 KV", quality.kvMb, 4096);
  check("混合架构总占用 9G 内", quality.totalMb, 9081);
  checkTrue("混合架构可全量卸载", tiers.every((tier) => tier.fullyOffloaded));
}

{
  const tiers = estimateTiers(hybridModel, { vramMb: 8192, cpuThreads: 16 });
  const quality = tiers[2];
  check("8G 下混合架构质量档 KV 降级 q8_0", quality.cacheTypeK, "q8_0");
  check("8G 下混合架构 KV 约 2.1G", quality.kvMb, 2176);
  check("8G 下混合架构总占用约 7G", quality.totalMb, 7161);
  checkTrue("8G 下混合架构质量档可全量卸载", quality.fullyOffloaded);
}

{
  const tiers = estimateTiers(mediumModel, { vramMb: 16384, cpuThreads: 16 });
  const applied = applyEstimate({ flashAttention: false } as Profile, tiers[2], "id", "命名", "描述");
  check("生成预设强制开启 FA", applied.flashAttention, true);
  check("生成预设写入质量档上下文", applied.contextSize, 131072);
}

{
  check("线程夹取下限", estimateThreads(4), 4);
  check("线程未知回退", estimateThreads(0), 8);
  check("线程夹取上限", estimateThreads(64), 16);
}

{
  checkTrue("元数据缺失不可估算", !canEstimate({ ...smallModel, weightsBytes: 0 }));
  check("不可估算时返回空", estimateTiers({ ...smallModel, blockCount: 0 }, { vramMb: 8192, cpuThreads: 8 }), []);
}

if (fail > 0) {
  console.error(`\n✗ ${fail} 项失败 / ${pass + fail} 项：`);
  failures.forEach((line) => console.error("  - " + line));
  process.exit(1);
} else {
  console.log(`✓ 智能推荐估算全部通过（${pass} 项）`);
}
