/**
 * 日志-分析 NInfer 指标回归测试套件（重建版）
 *
 * 覆盖 m00563 修复链：
 *   A. parseNinferDurationMs —— ms / s / "1m 51.9s" 复合格式（>60s 决定性实验实测）
 *   B. NInfer done 行片段解析 —— TTFT/total/queue 关键字切片 + 纯 prefill = TTFT − queue
 *   C. InferenceTracker.processLine —— 复合时长不再走墙钟回填、queueMs 落位、cancelled 无指标
 *   D. InferenceTracker.applyNinferRequestLog —— JSONL 权威合并/去重/旧实例过滤
 *   E. computeSessionStats.totalPromptTokens —— 累计输入统计
 *   F. llama.cpp 旧语义回归 —— prompt eval / eval time 行不受 ninfer 改动影响
 *
 * 运行：npm run test:inference（tsc --target es2022 编译到 .test-dist 后 node 执行）
 */
import {
  parseNinferDurationMs,
  parseInferenceLogFragments,
  InferenceTracker,
  RealtimeThroughputSampler,
  extractLlamaSlotSample,
  computeSessionStats,
  type LogTimingFragment,
} from "../src/utils";

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

function frag(line: string, type: LogTimingFragment["type"]): LogTimingFragment | undefined {
  return parseInferenceLogFragments(line).find((f) => f.type === type);
}

/* ============ A. parseNinferDurationMs ============ */
check("A1 亚秒 ms", parseNinferDurationMs("65.5 ms"), 66);
check("A2 整数 ms", parseNinferDurationMs("389 ms"), 389);
check("A3 秒格式", parseNinferDurationMs("2.1s"), 2100);
check("A4 复合分秒", parseNinferDurationMs("1m 51.9s"), 111900);
check("A5 复合分秒(大值)", parseNinferDurationMs("11m 6.14s"), 666140);
check("A6 复合排队值", parseNinferDurationMs("1m 49.7s"), 109700);
check("A7 复合时分秒", parseNinferDurationMs("1h 2m 3s"), 3723000);
check("A8 纯分钟", parseNinferDurationMs("1m"), 60000);
check("A9 垃圾输入", parseNinferDurationMs("abc"), undefined);
check("A10 空串", parseNinferDurationMs(""), undefined);
check("A11 零值", parseNinferDurationMs("0 ms"), undefined);
check("A12 带前后杂质的切片", parseNinferDurationMs(" 1m 51.9s "), 111900);

/* ============ B. NInfer done 行片段解析 ============ */
// 实测（探测引擎 req#1，短请求，无 queue 段）
const lineShort = "req#1 done | openai-chat | output limit | prompt 57 | output 40 | cache 0 (0.0%) | TTFT 99.7 ms | total 859 ms | prefill 576.6 tok/s | decode 51.4 tok/s";
check("B1 短请求 prompt", frag(lineShort, "cache")?.totalPromptTokens, 57);
check("B2 短请求 cache 比", frag(lineShort, "cache")?.cacheHitRatio, 0);
check("B3 短请求 ttft", frag(lineShort, "ttft")?.timeMs, 100);
check("B4 短请求 total", frag(lineShort, "total")?.timeMs, 859);
check("B5 短请求无 queue 段", frag(lineShort, "queue"), undefined);
check("B6 短请求 decode 耗时 = total − ttft", frag(lineShort, "decode")?.timeMs, 759);
check("B7 短请求 decode 速率", frag(lineShort, "decode")?.speed, 51.4);
check("B8 短请求 prefill(纯计算) = ttft", frag(lineShort, "prefill")?.timeMs, 100);

// 实测（探测引擎 req#3，被排队请求：TTFT 含 queue）
const lineQueued = "req#3 done | openai-chat | output limit | prompt 53 | output 10 | cache 0 (0.0%) | TTFT 1m 49.8s | total 1m 50.0s | queue 1m 49.7s | prefill 595.1 tok/s | decode 55.4 tok/s";
check("B9 排队请求 ttft 复合格式", frag(lineQueued, "ttft")?.timeMs, 109800);
check("B10 排队请求 queue", frag(lineQueued, "queue")?.timeMs, 109700);
check("B11 排队请求 total 复合格式", frag(lineQueued, "total")?.timeMs, 110000);
check("B12 排队请求 prefill = TTFT − queue", frag(lineQueued, "prefill")?.timeMs, 100);
check("B13 排队请求 decode = total − ttft", frag(lineQueued, "decode")?.timeMs, 200);
check("B14 排队请求 taskId", frag(lineQueued, "queue")?.taskId, "3");

// 实测（kvmem 引擎，cache 段带 response replay 变体 + mtp 段被忽略）
const lineKvmem = "req#4 done | openai-chat | stop token | prompt 68 | output 256 | cache 48 (71.3%, response replay) | TTFT 65.5 ms | total 2.1s | queue 28.4 ms | prefill 937.3 tok/s | decode 123.2 tok/s | mtp accepted 176/287 (61.3%)";
check("B15 kvmem cache 比(变体)", frag(lineKvmem, "cache")?.cacheHitRatio, 71.3);
check("B16 kvmem cachedTokens", frag(lineKvmem, "cache")?.cachedTokens, 48);
check("B17 kvmem queue 毫秒", frag(lineKvmem, "queue")?.timeMs, 28);
check("B18 kvmem total 秒格式", frag(lineKvmem, "total")?.timeMs, 2100);
check("B19 kvmem 无 mtp 幽灵片段", parseInferenceLogFragments(lineKvmem).some((f) => f.type === "generic_speed"), false);
check("B20 kvmem mtp 接受数", frag(lineKvmem, "mtp")?.mtpAcceptedTokens, 176);
check("B21 kvmem mtp 草稿数", frag(lineKvmem, "mtp")?.mtpDraftTokens, 287);
check("B22 kvmem mtp 接受率", frag(lineKvmem, "mtp")?.mtpAcceptRatio, 61.3);

// cancelled 终止行：无任何指标片段
const lineCancelled = "req#9 cancelled during transport | openai-chat | HTTP 499 | client disconnected";
{
  const frags = parseInferenceLogFragments(lineCancelled);
  check("B23 cancelled 仅 task_end", frags.map((f) => f.type).join(","), "task_end");
}

/* ============ C. InferenceTracker.processLine ============ */
// 复合时长 done 行不应触发墙钟回填
{
  const tracker = new InferenceTracker();
  tracker.processLine("req#5 started | openai-chat non-stream | 1 message | max output 256 | thinking low | preserve thinking");
  const res = tracker.processLine(lineQueued.replace(/req#3/g, "req#5"));
  check("C1 复合时长行立即结算", res.isTurnFinished, true);
  const round = tracker.getHistory()[0];
  check("C2 total 精确(非墙钟)", round.totalTimeMs, 110000);
  check("C3 ttft 精确", round.ttftMs, 109800);
  check("C4 queueMs 落位", round.queueMs, 109700);
  check("C5 prefillTimeMs = 纯计算", round.prefillTimeMs, 100);
  check("C6 decodeTimeMs", round.decodeTimeMs, 200);
  check("C7 promptTokens", round.promptTokens, 53);
  check("C8 decodeTokens", round.decodeTokens, 10);
}

// 短请求无 queue 段：queueMs 为空
{
  const tracker = new InferenceTracker();
  tracker.processLine("req#1 started | openai-chat non-stream | 1 message | max output 40");
  tracker.processLine(lineShort);
  const round = tracker.getHistory()[0];
  check("C9 短请求 queueMs 空", round.queueMs, null);
  check("C10 短请求 total", round.totalTimeMs, 859);
}

// NInfer done 行尾的 mtp 段归属到本轮，且不额外产生轮次
{
  const tracker = new InferenceTracker();
  tracker.processLine("req#4 started | openai-chat non-stream | 1 message | max output 256");
  const res = tracker.processLine(lineKvmem);
  const round = tracker.getHistory()[0];
  check("C11 mtp done 行立即结算", res.isTurnFinished, true);
  check("C12 mtp 接受数落位", round.mtpAcceptedTokens, 176);
  check("C13 mtp 草稿数落位", round.mtpDraftTokens, 287);
  check("C14 mtp 接受率落位", round.mtpAcceptRatio, 61.3);
  check("C15 mtp 不产生重复轮次", tracker.getHistory().length, 1);
}

/* ============ D. applyNinferRequestLog ============ */
{
  const tracker = new InferenceTracker();
  tracker.reset();
  const since = Date.now();

  // server_start 锁定实例
  tracker.applyNinferRequestLog([{ event: "server_start", server_instance_id: "serve-A", timestamp_unix_ms: since }]);

  // request_done（模拟 req#2 长请求全精度记录）
  const done2 = {
    event: "request_done",
    server_instance_id: "serve-A",
    timestamp_unix_ms: since + 1000,
    request: { request_id: 2, stream: false },
    result: {
      prompt_tokens: 112, completion_tokens: 6000, computed_prefill_tokens: 112,
      prefix_cache_hit_tokens: 0, model_thinking_tokens: 512, finish_reason: "output_limit",
    },
    timings_seconds: { ttft: 0.389, decode: 111.5, prefill: 0.328, total: 111.9 },
    engine_timing: { queue_wait_seconds: 0.0515 },
  };
  const r1 = tracker.applyNinferRequestLog([done2]);
  check("D1 JSONL 补录为完成轮次", r1.updated, true);
  check("D2 补录轮次 total", tracker.getHistory()[0].totalTimeMs, 111900);
  check("D3 补录轮次 ttft", tracker.getHistory()[0].ttftMs, 389);
  check("D4 补录轮次 queue", tracker.getHistory()[0].queueMs, 52);
  check("D5 补录轮次思考 tokens", tracker.getHistory()[0].thinkingTokens, 512);
  check("D6 补录轮次 instanceId", tracker.getHistory()[0].instanceId, "serve-A");

  // stderr 先建的轮次被 JSONL 权威覆盖（不重复追加）
  {
    const t2 = new InferenceTracker();
    t2.reset();
    t2.applyNinferRequestLog([{ event: "server_start", server_instance_id: "serve-B", timestamp_unix_ms: since }]);
    t2.processLine("req#7 started | openai-chat non-stream | 1 message | max output 10");
    t2.processLine("req#7 done | openai-chat | output limit | prompt 53 | output 10 | cache 0 (0.0%) | TTFT 1m 49.8s | total 1m 50.0s | queue 1m 49.7s | prefill 595.1 tok/s | decode 55.4 tok/s");
    const before = t2.getHistory().length;
    t2.applyNinferRequestLog([{
      event: "request_done", server_instance_id: "serve-B", timestamp_unix_ms: since + 500,
      request: { request_id: 7 },
      result: { prompt_tokens: 53, completion_tokens: 10, computed_prefill_tokens: 53, prefix_cache_hit_tokens: 3, model_thinking_tokens: 0 },
      timings_seconds: { ttft: 109.846, decode: 0.162, prefill: 0.089, total: 110.009 },
      engine_timing: { queue_wait_seconds: 109.747 },
    }]);
    const h = t2.getHistory();
    check("D7 权威合并不重复追加", h.length, before);
    check("D8 覆盖后 total 全精度", h[0].totalTimeMs, 110009);
    check("D9 覆盖后 cache 命中", h[0].cachedTokens, 3);
    check("D10 覆盖后 queue 全精度", h[0].queueMs, 109747);
  }

  // 旧实例残留（轮转重读 / 引擎重启前记录）被忽略
  {
    const t3 = new InferenceTracker();
    t3.reset();
    const lenBefore = t3.getHistory().length;
    const r3 = t3.applyNinferRequestLog([{
      event: "request_done", server_instance_id: "serve-OLD", timestamp_unix_ms: since - 60000,
      request: { request_id: 1 },
      result: { prompt_tokens: 10, completion_tokens: 5, prefix_cache_hit_tokens: 0 },
      timings_seconds: { ttft: 0.1, total: 1 },
    }]);
    check("D11 旧实例记录跳过", r3.updated, false);
    check("D12 历史未污染", t3.getHistory().length, lenBefore);
  }

  // throughput / request_start 记录不消费
  {
    const t4 = new InferenceTracker();
    t4.reset();
    const r4 = t4.applyNinferRequestLog([
      { event: "throughput", server_instance_id: "serve-C", timestamp_unix_ms: since, tokens: { committed_decode: 10 } },
      { event: "request_start", server_instance_id: "serve-C", timestamp_unix_ms: since, request: { request_id: 9 } },
    ]);
    check("D13 throughput/start 忽略", r4.updated, false);
  }

  // 轮询兜底开的轮次（无 taskId）被 JSONL done 收编归档，不产生重复轮次
  {
    const t5 = new InferenceTracker();
    t5.reset();
    t5.updateFromNinfer({
      stats: { requests: { running: 1 }, counters: { committed_decode_tokens: 10, computed_prefill_tokens: 20 } },
      slots: [],
    });
    const r5 = t5.applyNinferRequestLog([{
      event: "request_done", server_instance_id: "serve-D", timestamp_unix_ms: Date.now(),
      request: { request_id: 3 },
      result: { prompt_tokens: 20, completion_tokens: 10, computed_prefill_tokens: 20, prefix_cache_hit_tokens: 0, model_thinking_tokens: 0 },
      timings_seconds: { ttft: 0.05, decode: 1.0, prefill: 0.05, total: 1.05 },
      engine_timing: { queue_wait_seconds: 0.01 },
    }]);
    check("D14 无 taskId 活跃轮被 JSONL 收编", r5.updated, true);
    check("D15 不产生重复轮次", t5.getHistory().length, 1);
    check("D16 活跃轮已归档清空", t5.hasActiveTurn(), false);
    check("D17 收编后 total 权威", t5.getHistory()[0].totalTimeMs, 1050);
  }

  // speculative.backend === "mtp" 时按请求写入接受率；backend none 不产生 MTP 数据
  {
    const t6 = new InferenceTracker();
    t6.reset();
    const now = Date.now();
    t6.applyNinferRequestLog([{ event: "server_start", server_instance_id: "serve-MTP", timestamp_unix_ms: now }]);
    t6.applyNinferRequestLog([{
      event: "request_done", server_instance_id: "serve-MTP", timestamp_unix_ms: now + 100,
      request: { request_id: 11 },
      result: { prompt_tokens: 68, completion_tokens: 256, computed_prefill_tokens: 20, prefix_cache_hit_tokens: 48 },
      timings_seconds: { ttft: 0.0655, total: 2.1 },
      speculative: { backend: "mtp", accepted_tokens: 176, drafted_tokens: 287, rounds: 57 },
    }]);
    const mtpRound = t6.getHistory()[0];
    check("D18 JSONL mtp 接受数", mtpRound.mtpAcceptedTokens, 176);
    check("D19 JSONL mtp 草稿数", mtpRound.mtpDraftTokens, 287);
    check("D20 JSONL mtp 接受率", mtpRound.mtpAcceptRatio, 61.3);

    const t7 = new InferenceTracker();
    t7.reset();
    const nowNone = Date.now();
    t7.applyNinferRequestLog([{ event: "server_start", server_instance_id: "serve-NO", timestamp_unix_ms: nowNone }]);
    t7.applyNinferRequestLog([{
      event: "request_done", server_instance_id: "serve-NO", timestamp_unix_ms: nowNone + 100,
      request: { request_id: 12 },
      result: { prompt_tokens: 68, completion_tokens: 256, prefix_cache_hit_tokens: 0 },
      timings_seconds: { ttft: 0.0655, total: 2.1 },
      speculative: { backend: "none", accepted_tokens: 0, drafted_tokens: 0, rounds: 0 },
    }]);
    check("D21 backend none 不写接受率", t7.getHistory()[0].mtpAcceptRatio, null);
    check("D22 backend none 不写草稿数", t7.getHistory()[0].mtpDraftTokens, null);
  }
}

/* ============ E. computeSessionStats.totalPromptTokens ============ */
{
  const stats = computeSessionStats([
    { id: "a", timestamp: 1, promptTokens: 60, decodeTokens: 256, decodeTps: 100 },
    { id: "b", timestamp: 2, promptTokens: 94, decodeTokens: 100, decodeTps: 90 },
    { id: "c", timestamp: 3, promptTokens: 121, decodeTokens: 50, decodeTps: 80 },
  ]);
  check("E1 累计输入", stats.totalPromptTokens, 275);
  check("E2 累计产出", stats.totalTokens, 406);
  check("E3 轮次数", stats.turns, 3);
}

/* ============ F. llama.cpp 旧语义回归 ============ */
{
  const line = "prompt eval time =     65.23 ms /    60 tokens ( 920.51 tokens per second)";
  const f = frag(line, "prefill");
  check("F1 llama.cpp prefill tokens", f?.tokens, 60);
  check("F2 llama.cpp prefill 耗时", f?.timeMs, 65.23);
  const line2 = "eval time =        4189.17 ms /   256 runs   (   61.11 tokens per second)";
  const f2 = frag(line2, "decode");
  check("F3 llama.cpp decode tokens", f2?.tokens, 256);
  // 速率由 tokens/耗时 现算（与括号内标注值一致）
  check("F4 llama.cpp decode 速率(±0.01)", Math.abs((f2?.speed ?? 0) - 61.11) < 0.01, true);
  const line3 = "total time =       4254.40 ms";
  check("F5 llama.cpp total", frag(line3, "total")?.timeMs, 4254.4);
}

/* ============ G. 每秒实时吞吐采样器 ============ */
{
  // NInfer 计数器差分：首帧建基线，之后按 Δtokens / Δt 出速率
  const t = new RealtimeThroughputSampler();
  check("G1 首帧基线", t.sample({ now: 1000, active: true, decodeTokens: 100, prefillTokens: 0 }).decodeTps, 0);
  const g2 = t.sample({ now: 2000, active: true, decodeTokens: 170, prefillTokens: 0 });
  check("G2 1s Decode 差分", g2.decodeTps, 70);
  const g3 = t.sample({ now: 3000, active: true, decodeTokens: 240, prefillTokens: 500 });
  check("G3 1s Prefill 差分", g3.prefillTps, 500);
  const g4 = t.sample({ now: 4000, active: false, decodeTokens: 240, prefillTokens: 500 });
  check("G4 空闲归零", [g4.decodeTps, g4.prefillTps], [0, 0]);

  // llama.cpp 任务切换：新任务首帧不继承旧任务速率，后续差分正常
  const l = new RealtimeThroughputSampler();
  l.sample({ now: 1000, active: true, decodeTokens: 0, prefillTokens: 0, taskKey: "1" });
  l.sample({ now: 2000, active: true, decodeTokens: 50, prefillTokens: 491, taskKey: "1", prefillRateHint: 851 });
  const g5 = l.sample({ now: 3000, active: true, decodeTokens: 10, prefillTokens: 20, taskKey: "2", prefillRateHint: 851 });
  check("G5 任务切换重置", [g5.decodeTps, g5.prefillTps], [0, 851]);
  const g6 = l.sample({ now: 4000, active: true, decodeTokens: 45, prefillTokens: 20, taskKey: "2" });
  check("G6 新任务 1s 差分", g6.decodeTps, 35);

  // 计数器回退与超长间隔：只重设基线，不上报负速率或跨空闲混算
  const r = new RealtimeThroughputSampler();
  r.sample({ now: 1000, active: true, decodeTokens: 500, prefillTokens: 0 });
  const g7 = r.sample({ now: 2000, active: true, decodeTokens: 100, prefillTokens: 0 });
  check("G7 计数器回退归零", g7.decodeTps, 0);
  const g8 = r.sample({ now: 6000, active: true, decodeTokens: 200, prefillTokens: 0 });
  check("G8 长间隔重置", g8.decodeTps, 0);

  // 两个采样点之间完成的短请求：空闲采样点补发尾部差量，不能整段丢弃
  const shortReq = new RealtimeThroughputSampler();
  shortReq.sample({ now: 1000, active: false, decodeTokens: 0, prefillTokens: 0 });
  const g9 = shortReq.sample({ now: 2000, active: false, decodeTokens: 101, prefillTokens: 60 });
  check("G9 空闲 tick 补发尾部速率", [g9.decodeTps, g9.prefillTps], [101, 60]);
  const g10 = shortReq.sample({ now: 3000, active: false, decodeTokens: 101, prefillTokens: 60 });
  check("G10 补发后回到零", [g10.decodeTps, g10.prefillTps], [0, 0]);

  // 空闲采样点计数器回退（引擎重启）或间隔过长时不补发
  const g11 = shortReq.sample({ now: 4000, active: false, decodeTokens: 10, prefillTokens: 5 });
  check("G11 空闲计数器回退归零", [g11.decodeTps, g11.prefillTps], [0, 0]);
  const g12 = shortReq.sample({ now: 12000, active: false, decodeTokens: 90, prefillTokens: 60 });
  check("G12 空闲长间隔不补发", [g12.decodeTps, g12.prefillTps], [0, 0]);

  // llama.cpp 空闲时 taskKey 变为 null 且计数缺失：不得把任务尾差算成速率
  const llamaIdle = new RealtimeThroughputSampler();
  llamaIdle.sample({ now: 1000, active: true, decodeTokens: 500, prefillTokens: 4330, taskKey: "7" });
  const g13 = llamaIdle.sample({ now: 2000, active: false, decodeTokens: null, prefillTokens: null, taskKey: null });
  check("G13 llama 空闲缺失计数不补发", [g13.decodeTps, g13.prefillTps], [0, 0]);
}

/* ============ H. llama.cpp /slots 实时计数提取（b11877 新语义） ============ */
{
  // b11877：n_prompt_tokens 是上下文总长（生成时持续增长），n_prompt_tokens_processed 才是本轮实际计算的提示词
  const duringPrefill = extractLlamaSlotSample([{
    id: 0, id_task: 7, is_processing: true,
    n_prompt_tokens: 4670, n_prompt_tokens_processed: 2256,
    next_token: [{ n_decoded: 0 }],
  }]);
  check("H1 Prefill 取 processed 而非上下文总长", duringPrefill.prefillTokens, 2256);
  check("H2 进行中小任务 Decode 计数", duringPrefill.decodeTokens, 0);

  const duringDecode = extractLlamaSlotSample([{
    id: 0, id_task: 7, is_processing: true,
    n_prompt_tokens: 5190, n_prompt_tokens_processed: 4330,
    next_token: [{ n_decoded: 520 }],
  }]);
  check("H3 生成阶段 Prefill 计数不再随上下文增长", duringDecode.prefillTokens, 4330);
  check("H4 生成阶段 Decode 计数", duringDecode.decodeTokens, 520);

  // 同一轮继续生成：上下文总长 +70，processed 保持不变 → Prefill 差分为 0
  const s = new RealtimeThroughputSampler();
  s.sample({ now: 1000, ...duringDecode });
  const h5 = s.sample({ now: 2000, ...extractLlamaSlotSample([{
    id: 0, id_task: 7, is_processing: true,
    n_prompt_tokens: 5260, n_prompt_tokens_processed: 4330,
    next_token: [{ n_decoded: 590 }],
  }]) });
  check("H5 生成阶段 Prefill 速率为 0", h5.prefillTps, 0);
  check("H6 生成阶段 Decode 速率正常", h5.decodeTps, 70);

  // 旧版 llama.cpp：仅提供 timings 时仍可回退
  const legacy = extractLlamaSlotSample([{
    id: 0, id_task: 9, is_processing: true,
    timings: { prompt_n: 491, predicted_n: 40, prompt_per_second: 851 },
  }]);
  check("H7 旧版 timings 回退", [legacy.decodeTokens, legacy.prefillTokens, legacy.prefillRateHint], [40, 491, 851]);

  // 空闲槽位不参与计数
  const idle = extractLlamaSlotSample([{ id: 0, is_processing: false, n_prompt_tokens: 5190, n_prompt_tokens_processed: 4330 }]);
  check("H8 空闲槽位归零", [idle.active, idle.decodeTokens, idle.prefillTokens], [false, null, null]);
}

/* ============ I. llama.cpp MTP 草稿接受率 ============ */
{
  const release = "slot release_slot_: id 0 | task 7 | draft acceptance = 0.61500 (  176 accepted /  287 generated), mean len =  2.09";
  const f = frag(release, "mtp");
  check("I1 llama.cpp 接受数", f?.mtpAcceptedTokens, 176);
  check("I2 llama.cpp 草稿数", f?.mtpDraftTokens, 287);
  check("I3 llama.cpp 接受率百分化", f?.mtpAcceptRatio, 61.5);

  // 未开启 MTP 时接受率行没有计数（0/0），不能生成 0% 数据点
  const zeroRelease = "slot release_slot_: id 0 | task 8 | draft acceptance = 0.00000 (    0 accepted /    0 generated), mean len =  0.00";
  check("I4 0/0 不产生 mtp 片段", parseInferenceLogFragments(zeroRelease).some((x) => x.type === "mtp"), false);

  // release 行晚于本轮归档：按 taskId 回填已有轮次，不新开轮次、不弹幽灵
  const tracker = new InferenceTracker();
  tracker.processLine("slot print_timing: id 0 | task 7 | n_gen = 40, tg = 61.1 t/s, tg_3s = 60.0 t/s");
  tracker.processLine("total time =       4254.40 ms");
  const before = tracker.getHistory().length;
  const res = tracker.processLine(release);
  const h = tracker.getHistory();
  check("I5 迟到接受率回填不新增轮次", h.length, before);
  check("I6 回填轮次接受率", h[0].mtpAcceptRatio, 61.5);
  check("I7 回填后无活跃轮次", tracker.hasActiveTurn(), false);
  check("I8 latest 指向回填轮次", res.latest?.mtpAcceptRatio, 61.5);
  check("I9 回填不改动完成态", res.isTurnFinished, false);
}

/* ============ 汇总 ============ */
console.log(`\n通过 ${pass} / ${pass + fail} 项断言`);
if (fail > 0) {
  console.error("\n失败项：");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
} else {
  console.log("全部通过 ✓");
  process.exit(0);
}
