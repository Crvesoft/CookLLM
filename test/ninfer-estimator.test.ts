/**
 * ninfer / KVMem 智能推荐回归测试：KVMem 256K 上下文、Host 分页、标准 ninfer 容量与显存不足回退。
 * 运行：npm run test:ninfer
 */
import type { GgufCapacity } from "../src/profileEstimator";
import { buildAutoProfiles, pickNinferEngine } from "../src/autoProfiles";
import { applyNinferEstimate, estimateNinferTiers } from "../src/ninferEstimator";
import type { Profile } from "../src/types";
import type { Translate } from "../src/hooks/types";

const fakeT = ((key: string, vars?: Record<string, string | number>) =>
  Object.entries(vars ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), key)) as Translate;

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

/** 27B Qwen3.8 GSQ IQ3_S：64 层中 16 层全注意力、4 个 KV 头、256 维、256K 原生上下文 */
const swift: GgufCapacity = {
  blockCount: 64,
  attentionLayerCount: 16,
  headCountKv: 4,
  headDim: 256,
  contextLength: 262144,
  weightsBytes: 12_481_698_816,
};
const host = { vramMb: 16303, cpuThreads: 16, systemRamMb: 49152, nvfp4Supported: true };
const hostNoNvfp4 = { vramMb: 16303, cpuThreads: 16, systemRamMb: 49152, nvfp4Supported: false };
const base = { kvmemBudget: 36864, kvmemGenReserve: 16384, kvmemHostMib: 12288, kvCapacity: 65536, hostCacheMib: 6144 } as Profile;

{
  const tiers = estimateNinferTiers(swift, host, "ninfer_kvmem");
  check("KVMem 档位数量", tiers.length, 3);
  const [fast, balanced, quality] = tiers;
  check("KVMem 快速 64K", fast.contextSize, 65536);
  check("KVMem 快速 nvfp4", fast.kvDtype, "nvfp4");
  check("KVMem 快速生成预留 16K", fast.kvmemGenReserve, 16384);
  check("KVMem 快速历史预算 36864", fast.kvmemBudget, 36864);
  check("KVMem 均衡 128K", balanced.contextSize, 131072);
  check("KVMem 均衡 rk8v4", balanced.kvDtype, "rk8v4");
  check("KVMem 均衡生成预留 4096", balanced.kvmemGenReserve, 4096);
  check("KVMem 均衡历史预算 36864", balanced.kvmemBudget, 36864);
  check("KVMem 质量 256K", quality.contextSize, 262144);
  check("KVMem 质量 int8", quality.kvDtype, "int8");
  check("KVMem 质量生成预留 2048", quality.kvmemGenReserve, 2048);
  check("KVMem 质量历史预算 36864", quality.kvmemBudget, 36864);
  checkTrue("KVMem 质量档有 Host 分页", quality.hostKvMb > 0);
  checkTrue("KVMem 质量档 Host 配额不小于历史 KV", quality.kvmemHostMib >= quality.hostKvMb);
  checkTrue("KVMem 质量档显存不超预算", quality.totalMb <= quality.budgetMb);
  checkTrue("KVMem 质量档剩余显存给桌面", quality.budgetMb - quality.totalMb < 512);

  const applied = applyNinferEstimate(base, quality, "p1", "KVMem · 256K", "长上下文", "engine-kvmem");
  check("预设写入 256K", applied.contextSize, 262144);
  check("预设绑定 KVMem 引擎", applied.engineId, "engine-kvmem");
  check("预设写入历史预算", applied.kvmemBudget, quality.kvmemBudget);
  check("预设写入生成预留", applied.kvmemGenReserve, 2048);
  check("预设写入 Host 配额", applied.kvmemHostMib, quality.kvmemHostMib);
  check("KVMem 预设不使用 kv-capacity", applied.kvCapacity, undefined);
  check("预设写入质量档 int8", applied.kvDtype, "int8");
}

{
  const tiers = estimateNinferTiers(swift, host, "ninfer");
  check("NInfer 档位数量", tiers.length, 3);
  const [fast, balanced, quality] = tiers;
  check("NInfer 快速 64K", fast.contextSize, 65536);
  check("NInfer 快速用低精度", fast.kvDtype, "nvfp4");
  check("NInfer 均衡 rk8v4", balanced.kvDtype, "rk8v4");
  check("NInfer 均衡 64K（受显存限制）", balanced.contextSize, 65536);
  check("NInfer 质量 int8", quality.kvDtype, "int8");
  checkTrue("NInfer 质量档不超过原生上下文", quality.contextSize <= 262144);
  check("NInfer 容量等于上下文", quality.kvCapacity, quality.contextSize);
  check("NInfer 不写 Host 分页", quality.hostKvMb, 0);
  checkTrue("NInfer 质量档显存不超预算", quality.totalMb <= quality.budgetMb);

  const applied = applyNinferEstimate(base, quality, "p2", "NInfer · 51K", "全量驻留", "engine-ninfer");
  check("NInfer 预设写入容量", applied.kvCapacity, quality.contextSize);
  check("NInfer 预设保留原有 KVMem 字段", applied.kvmemBudget, 36864);
  check("NInfer 预设写入质量档精度", applied.kvDtype, "int8");
}

{
  const tiers = estimateNinferTiers(swift, hostNoNvfp4, "ninfer_kvmem");
  check("无 nvfp4 档位数量", tiers.length, 3);
  check("无 nvfp4 快速退回 rk4v4", tiers[0].kvDtype, "rk4v4");
  check("无 nvfp4 均衡仍为 rk8v4", tiers[1].kvDtype, "rk8v4");
  check("无 nvfp4 质量为 int8", tiers[2].kvDtype, "int8");
  const plain = estimateNinferTiers(swift, hostNoNvfp4, "ninfer");
  check("无 nvfp4 标准 NInfer 快速退回 rk4v4", plain[0].kvDtype, "rk4v4");
  check("无 nvfp4 标准 NInfer 均衡仍为 rk8v4", plain[1].kvDtype, "rk8v4");
  check("无 nvfp4 标准 NInfer 质量为 int8", plain[2].kvDtype, "int8");
}

{
  const tiers = estimateNinferTiers(swift, { vramMb: 32768, cpuThreads: 16, systemRamMb: 49152, nvfp4Supported: true }, "ninfer");
  const [fast, balanced, quality] = tiers;
  check("宽显存 NInfer 快速 64K nvfp4", `${fast.contextSize}/${fast.kvDtype}`, "65536/nvfp4");
  check("宽显存 NInfer 均衡 128K rk8v4", `${balanced.contextSize}/${balanced.kvDtype}`, "131072/rk8v4");
  check("宽显存 NInfer 质量 bf16 256K", `${quality.contextSize}/${quality.kvDtype}`, "262144/bf16");
}

{
  const bigVram = { vramMb: 32768, cpuThreads: 16, systemRamMb: 49152, nvfp4Supported: true };
  const tiers = estimateNinferTiers(swift, bigVram, "ninfer_kvmem");
  const quality = tiers.find((tier) => tier.tier === "quality");
  check("显存宽裕质量档用 bf16", quality?.kvDtype, "bf16");
  check("bf16 档预算保持默认", quality?.kvmemBudget, 36864);
  check("bf16 档上下文 256K", quality?.contextSize, 262144);
}

{
  const tight = estimateNinferTiers(swift, { vramMb: 15000, cpuThreads: 16, systemRamMb: 49152 }, "ninfer_kvmem");
  check("显存压力下过紧的档位被剔除", tight.length, 2);
  const tightQuality = tight.find((tier) => tier.tier === "quality");
  checkTrue("显存压力下仍保留质量档", Boolean(tightQuality));
  checkTrue("显存压力下历史预算低于 36864", (tightQuality?.kvmemBudget ?? 0) < 36864);
  check("显存压力下历史预算按 64 对齐", (tightQuality?.kvmemBudget ?? 0) % 64, 0);
  check("显存放不下权重时返回空", estimateNinferTiers(swift, { vramMb: 8192, cpuThreads: 8, systemRamMb: 32768 }, "ninfer_kvmem"), []);
  check("元数据缺失返回空", estimateNinferTiers({ ...swift, headCountKv: 0 }, host, "ninfer"), []);
}

{
  const both = [
    { id: "e-kvmem", name: "Kvmem-19-rc1", path: "E:\\AI\\kvmem\\ninfer-kvmem-server.exe", engineType: "ninfer_kvmem" },
    { id: "e-ninfer", name: "NInfer", path: "E:\\AI\\ninfer-run\\engine\\ninfer-serve.exe", engineType: "ninfer" },
  ] as never[];
  check("双引擎优先 KVMem", pickNinferEngine(both)?.engine.id, "e-kvmem");
  check("仅标准引擎用 ninfer", pickNinferEngine(both.slice(1))?.kind, "ninfer");
  check("仅 KVMem 引擎用 kvmem", pickNinferEngine(both.slice(0, 1))?.kind, "ninfer_kvmem");
  check("无引擎返回空", pickNinferEngine([]), null);

  const hw = { vramMb: 16303, cpuThreads: 16, systemRamMb: 49152, nvfp4Supported: true };
  const auto = buildAutoProfiles(swift, hw, fakeT, { isNinfer: true, engines: both as never });
  checkTrue("入库智能推荐生成三档", auto?.profiles.length === 3);
  check("入库智能推荐绑定 KVMem 引擎", auto?.profiles[0].engineId, "e-kvmem");
  check("入库智能推荐默认指向均衡档", auto?.defaultProfileId, auto?.profiles[1].id);
  checkTrue("GGUF 入库智能推荐可用", Boolean(buildAutoProfiles(swift, hw, fakeT, { isNinfer: false })));
  check("无引擎 ninfer 入库退回空（由调用方兜底）", buildAutoProfiles(swift, hw, fakeT, { isNinfer: true, engines: [] }), null);
  check("无显存入库退回空", buildAutoProfiles(swift, { ...hw, vramMb: 0 }, fakeT, { isNinfer: false }), null);
}

if (fail > 0) {
  console.error(`\n✗ ${fail} 项失败 / ${pass + fail} 项：`);
  failures.forEach((line) => console.error("  - " + line));
  process.exit(1);
} else {
  console.log(`✓ ninfer 智能推荐全部通过（${pass} 项）`);
}
