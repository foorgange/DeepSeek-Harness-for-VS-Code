// 历史与流式测试 —— 用**录制的真实 snapshot** 驱动 history.ts / assistant.ts,再合流进真 SessionStore。
// 用法: node tests/smoke/protocol-history.test.js
//
// 这一层压的是 S5 那两块最难靠编译器兜住的逻辑:
//   · `assistant.ts` 给流式增量**铸造 seq** —— 插错位置的表现是「文字跑到用户消息前面」,
//     而撞上持久 seq 更糟:store 会把后到的持久事件当重复**丢掉**(内容凭空消失);
//   · `history.ts` 的 `throughSeq` 记账 —— 用 -1 顶替的表现是「打开老会话一片空白,还不报错」。
//
// 所以断言分两类:一类是**不变量**(单调、不撞号、区间严格),一类是**合流后的真实顺序**
// (把铸造出来的帧喂进真 store,看它排在哪)。
const fs = require("fs");
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));

function bundle(entry, name) {
  const out = path.join(os.tmpdir(), `${name}-${process.pid}.cjs`);
  buildSync({
    entryPoints: [path.join(repo, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "silent",
  });
  return require(out);
}

const assistantMod = bundle("src/dsh/protocol/modern/assistant.ts", "assistant-test");
const historyMod = bundle("src/dsh/protocol/modern/history.ts", "history-test");
const storeMod = bundle("src/dsh/sessionStore.ts", "store-history-test");

let fail = 0;
let skip = 0;
function check(name, ok, detail) {
  console.log((ok ? "OK  " : "FAIL") + " " + name + (ok || !detail ? "" : "  → " + detail));
  if (!ok) fail++;
}
function skipped(name, why) {
  console.log("SKIP " + name + "  → " + why);
  skip++;
}
function noThrow(name, fn) {
  try {
    fn();
    check(name, true);
  } catch (error) {
    check(name, false, String(error && error.message));
  }
}

// ---------- 夹具 ----------
const fixtureDir = path.join(repo, "tests", "fixtures");
function loadFixture() {
  if (!fs.existsSync(fixtureDir)) return undefined;
  const files = fs
    .readdirSync(fixtureDir)
    .filter((f) => f.startsWith("mux-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) return undefined;
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, files[files.length - 1]), "utf8"));
}

const fixture = loadFixture();
const itemsOf = (endpoint) => {
  const stream = fixture?.streams?.find((s) => s.endpoint === endpoint);
  const out = [];
  for (const item of stream?.items ?? []) {
    for (let i = 0; i < (item.repeat ?? 1); i++) out.push(item.value);
  }
  return out;
};
const realSnapshot = itemsOf("session/follow").find((v) => v?.type === "snapshot");

// ---------- 测试替身 ----------
class FakeMux {
  constructor() {
    this.opens = [];
  }
  open(endpoint, args, handlers) {
    const rec = { endpoint, args, handlers, cancelled: false };
    this.opens.push(rec);
    return { streamId: "s" + this.opens.length, endpoint, cancel: () => (rec.cancelled = true) };
  }
  last() {
    return this.opens[this.opens.length - 1];
  }
}

function makeSink(onMuxExtra) {
  let n = 0;
  return {
    muxFrames: [],
    hostFrames: [],
    logs: [],
    onMux(e) {
      this.muxFrames.push(e);
      if (onMuxExtra) onMuxExtra(e);
    },
    onHost(e) {
      this.hostFrames.push(e);
    },
    onLog(m) {
      this.logs.push(m);
    },
    newRpcId: () => "rpc-" + ++n,
    /** 便捷过滤 */
    types() {
      return this.muxFrames.map((f) => f.frame.type);
    },
  };
}

/** 一个能手动投帧的会话流(把 SessionFollows 与 FakeMux 接起来)。 */
function wire(mux, sink, calls) {
  const assistant = new assistantMod.AssistantStreams(sink);
  const follows = new historyMod.SessionFollows(mux, sink, assistant, async (request) => {
    calls.push(request);
    return calls.reply ?? { records: [], hasMore: false };
  });
  return { assistant, follows };
}

// ---------- 1. assistant.ts:小数 seq 铸造(纯逻辑) ----------
console.log("=== 1. 小数 seq 铸造 ===");
{
  const sink = makeSink();
  const assistant = new assistantMod.AssistantStreams(sink);
  const chunks = () => sink.muxFrames.filter((f) => f.frame.type === "session/event").map((f) => f.frame.event);

  // 基线:已有 5 条持久事件。
  assistant.noteDurable("s1", 5);
  assistant.accept("s1", { type: "start", attemptId: "a1", turn: 3, step: 2, revision: 1, startedAfterSeq: 5 });
  for (let i = 0; i < 4; i++) {
    assistant.accept("s1", { type: "chunk", attemptId: "a1", revision: 2 + i, index: 0, time: 1000 + i, chunk: { type: "text-delta", index: 0, text: "t" + i } });
  }
  const minted = chunks();
  check(`4 条增量 ⇒ 4 条事件`, minted.length === 4, `实得 ${minted.length}`);
  check("增量事件类型是 assistant/chunk", minted.every((e) => e.type === "assistant/chunk"));
  // 核心不变量:严格落在 (base, base+1) 开区间 —— 这才保证永远撞不上整数持久 seq。
  check(
    "全部 seq 严格落在 (5, 6) 开区间",
    minted.every((e) => e.seq > 5 && e.seq < 6),
    minted.map((e) => e.seq).join(", "),
  );
  check("seq 严格单调递增", minted.every((e, i) => i === 0 || e.seq > minted[i - 1].seq), minted.map((e) => e.seq).join(", "));
  check("没有整数 seq(撞号会让持久内容被 store 丢掉)", minted.every((e) => !Number.isInteger(e.seq)));
  // chunk 帧**不带 turn/step**,只有 start 带 —— 所以必须按 attemptId 记住。
  check("turn/step 从 start 帧补上(不是 0/0)", minted.every((e) => e.data.turn === 3 && e.data.step === 2), `实得 ${minted[0]?.data.turn}/${minted[0]?.data.step}`);
  check("chunk 载荷原样透传", minted[0].data.chunk.text === "t0" && minted[0].data.chunk.type === "text-delta");
  check("index 透传", minted.every((e) => e.data.index === 0));
  check("time 透传", minted[0].time === 1000);

  // 持久事件前进 ⇒ base 前移,新值仍严格大于旧基准下的一切。
  assistant.accept("s1", { type: "end", attemptId: "a1", revision: 9, outcome: { kind: "committed", eventType: "assistant/message", seq: 6 } });
  check("end(committed) 不产帧", chunks().length === 4);
  assistant.accept("s1", { type: "start", attemptId: "a2", turn: 3, step: 3, revision: 10, startedAfterSeq: 6 });
  assistant.accept("s1", { type: "chunk", attemptId: "a2", revision: 11, index: 1, chunk: { type: "text-delta", index: 1, text: "x" } });
  const next = chunks()[4];
  check("committed 后新增量排在持久事件之后", next.seq > 6 && next.seq < 7, `实得 ${next.seq}`);
  check("递增跨持久事件也成立(新值 > 上一代的最大值)", next.seq > minted[3].seq);

  // 乱序/重放的旧持久事件**不能**把基准拉回去。
  const beforeReplay = next.seq;
  assistant.noteDurable("s1", 3);
  assistant.accept("s1", { type: "chunk", attemptId: "a2", revision: 12, index: 1, chunk: { type: "text-delta", index: 1, text: "y" } });
  check("旧持久事件不回退基准", chunks()[5].seq > beforeReplay, `${chunks()[5].seq} vs ${beforeReplay}`);

  // 空会话:游标是 -1(cursorBeforeNext(0) === -1),不钳的话第一个增量会是负数。
  const sink2 = makeSink();
  const a2 = new assistantMod.AssistantStreams(sink2);
  a2.baseline("empty", { revision: 440 });
  a2.accept("empty", { type: "start", attemptId: "b1", turn: 1, step: 0, revision: 441, startedAfterSeq: -1 });
  a2.accept("empty", { type: "chunk", attemptId: "b1", revision: 442, index: 0, chunk: { type: "text-delta", index: 0, text: "hi" } });
  const emptyEvents = sink2.muxFrames.map((f) => f.frame.event);
  check("空会话(游标 -1)第一个增量 seq 是 0.5 而不是 -0.5", emptyEvents[0]?.seq === 0.5, `实得 ${emptyEvents[0]?.seq}`);
  check("空会话的 seq 也不是负数", emptyEvents[0]?.seq > 0);
  // 真录制的基线里 revision=440,续接点必须采信它,否则第一条真帧会被当成断层刷日志。
  a2.accept("empty", { type: "chunk", attemptId: "b1", revision: 441, index: 0, chunk: { type: "text-delta", index: 0, text: "!" } });

  // 重连:开局帧的 activeAttempt 是**唯一**能拿到那次尝试 turn/step 的地方。
  const sink3 = makeSink();
  const a3 = new assistantMod.AssistantStreams(sink3);
  a3.baseline("mid", { revision: 100, activeAttempt: { attemptId: "c1", turn: 7, step: 1, startedAfterSeq: 20 } });
  a3.accept("mid", { type: "chunk", attemptId: "c1", revision: 101, index: 2, chunk: { type: "text-delta", index: 2, text: "断线前就在跑" } });
  const mid = sink3.muxFrames[0]?.frame.event;
  check("重连时用 activeAttempt 补 turn/step", mid?.data.turn === 7 && mid?.data.step === 1, `实得 ${mid?.data.turn}/${mid?.data.step}`);
  check("重连时用 activeAttempt.startedAfterSeq 定基准", mid.seq > 20 && mid.seq < 21, `实得 ${mid.seq}`);
}

// ---------- 2. assistant.ts:对抗用例 ----------
console.log("\n=== 2. 增量流的对抗用例 ===");
{
  const sink = makeSink();
  const a = new assistantMod.AssistantStreams(sink);
  const count = () => sink.muxFrames.length;
  a.noteDurable("s1", 10);
  a.accept("s1", { type: "start", attemptId: "a1", turn: 1, step: 1, revision: 1, startedAfterSeq: 10 });

  // 认不出 attemptId(丢了 start 帧)⇒ 整条丢掉。
  // 拿 0/0 顶替的话,ui.ts 会把块键记成 `0:0:0`,而持久消息的键是 `1:1:0` —— 对不上 ⇒ 同一段文字渲染两遍。
  const beforeOrphan = count();
  a.accept("s1", { type: "chunk", attemptId: "gone", revision: 2, index: 0, chunk: { type: "text-delta", index: 0, text: "孤儿" } });
  a.accept("s1", { type: "chunk", revision: 3, index: 0, chunk: { type: "text-delta", index: 0, text: "没 id" } });
  check("认不出 attemptId 的增量不产帧", count() === beforeOrphan);
  check("丢弃有日志(不是静默)", sink.logs.some((m) => m.includes("attemptId")));

  // end 对不上任何尝试:无害 no-op。
  noThrow("end 帧的 attemptId 不存在不抛异常", () => a.accept("s1", { type: "end", attemptId: "ghost", revision: 4, outcome: { kind: "committed", seq: 12 } }));
  noThrow("end 没有 outcome 不抛异常", () => a.accept("s1", { type: "end", attemptId: "a1", revision: 5 }));
  // abandoned 不是落盘 → 基准不动(下一代的 base 仍是 10)。
  a.accept("s1", { type: "end", attemptId: "a1", revision: 6, outcome: { kind: "abandoned" } });
  check("end(abandoned) 不产帧", count() === beforeOrphan);

  // revision 断层(丢帧):只记日志,不能抛 —— 抛出去会一路穿到 socket 的 onmessage,把「少几帧 token」升级成「整条流挂掉」。
  a.accept("s1", { type: "start", attemptId: "a9", turn: 2, step: 0, revision: 50, startedAfterSeq: 11 });
  a.accept("s1", { type: "chunk", attemptId: "a9", revision: 60, index: 0, chunk: { type: "text-delta", index: 0, text: "断层" } });
  check("revision 断层不抛异常且照常产帧", count() === beforeOrphan + 1);
  check("断层有日志", sink.logs.some((m) => m.includes("断层")));

  // 载荷缺失:block-start 是让 ui.ts 新建块的信号,拿空对象顶替会渲染出一个空块。
  a.accept("s1", { type: "start", attemptId: "a10", turn: 2, step: 1, revision: 61, startedAfterSeq: 11 });
  const beforeNoPayload = count();
  a.accept("s1", { type: "chunk", attemptId: "a10", revision: 62, index: 0 });
  a.accept("s1", { type: "chunk", attemptId: "a10", revision: 63, index: 0, chunk: null });
  a.accept("s1", { type: "chunk", attemptId: "a10", revision: 64, index: 0, chunk: [] });
  check("chunk 载荷缺失/不是对象 ⇒ 不产帧", count() === beforeNoPayload);

  // wire 上全是 unknown。
  const junk = [null, undefined, 0, "", [], {}, { type: "unknown" }, { type: "chunk" }, { type: "start" }, { type: "end" }];
  for (const j of junk) {
    noThrow(`accept(${JSON.stringify(j)}) 不抛异常`, () => a.accept("s1", j));
    noThrow(`baseline(${JSON.stringify(j)}) 不抛异常`, () => a.baseline("s1", j));
  }
  noThrow("noteDurable(NaN) 不抛异常", () => a.noteDurable("s1", NaN));
  noThrow("noteDurable(undefined) 不抛异常", () => a.noteDurable("s1", undefined));
  check("noteDurable(NaN) 不动基准", (() => {
    const before = count();
    a.noteDurable("s1", NaN);
    a.accept("s1", { type: "chunk", attemptId: "a10", revision: 65, index: 0, chunk: { type: "text-delta", index: 0, text: "z" } });
    const seq = sink.muxFrames[count() - 1].frame.event.seq;
    // 基准此刻是 12(上面那条端不上尝试的 committed 帧把它推上去的),NaN 不该动它。
    return count() === before + 1 && Math.floor(seq) === 12;
  })());
}

// ---------- 3. history.ts:真实 snapshot 驱动 ----------
async function main() {
console.log("\n=== 3. 跟随流的开局帧(录制数据)===");
if (realSnapshot === undefined) {
  skipped("真实 snapshot 用例", "夹具里没有 session/follow —— 先跑 tools/record-mux.ts");
} else {
  const calls = [];
  const mux = new FakeMux();
  const muxFrames = [];
  const sink = makeSink((e) => muxFrames.push(e));
  const { follows } = wire(mux, sink, calls);
  const pending = follows.follow({ kind: "session", sessionId: "s1" });
  check("follow() 打开的是 session/follow", mux.last().endpoint === "session/follow");
  check(
    "流参数是 {request:{address, assistantStream:true}}(流式增量必须 opt-in)",
    JSON.stringify(mux.last().args) === JSON.stringify({ request: { address: { kind: "session", sessionId: "s1" }, assistantStream: true } }),
    JSON.stringify(mux.last().args),
  );

  mux.last().handlers.onItem(realSnapshot);
  const result = await pending;

  check("游标原样取自开局帧", result.cursor === realSnapshot.cursor, `${result.cursor} vs ${realSnapshot.cursor}`);
  check("游标是整数(它要当 session/page 的 throughSeq)", Number.isInteger(result.cursor));
  check("hasMore 取自开局帧", result.hasMore === realSnapshot.hasMore);
  const realRecords = (realSnapshot.records ?? []).filter((r) => r?.event && typeof r.event.seq === "number");
  check(`快照带回 ${realRecords.length} 条事件`, result.events.length === realRecords.length, `实得 ${result.events.length}`);

  // **逐字段同形 ⇒ 零翻译**:事件对象必须是同一个引用,不是重建的副本。
  // 一旦这里出现「翻译」,以后协议一改字段就会静默丢内容。
  check("事件原样透传(同一个引用,零翻译)", result.events[0].event === realRecords[0].event);

  const sessionEvents = muxFrames.filter((f) => f.frame.type === "session/event");
  check(`快照里每条 record 都派发成 session/event 帧(${sessionEvents.length} 条)`, sessionEvents.length === realRecords.length);
  check("派发帧的 sessionId 取自地址", sessionEvents.every((f) => f.frame.sessionId === "s1"));
  check("派发帧带 rpcId(审批/提问靠它答回去,事件也要有)", sessionEvents.every((f) => typeof f.rpcId === "string" && f.rpcId.length > 0));

  // legacy 的 session/subscribed 语义:让 store 的 maxSeq 追上真实尾巴。
  const subscribed = muxFrames.find((f) => f.frame.type === "session/subscribed");
  check("发 session/subscribed 让 store 的 maxSeq 对齐", subscribed !== undefined && subscribed.frame.lastSeq === realSnapshot.cursor, `实得 ${subscribed?.frame.lastSeq}`);

  // 投影回放:不回放的话,打开新会话后权限胶囊/上下文压力/待办会停在上一个会话的值上。
  const projections = muxFrames.filter((f) => f.frame.type === "session/projection");
  const realValues = Object.keys(realSnapshot.projections?.values ?? {});
  check(`投影逐键回放(${projections.length} 帧 / ${realValues.length} 键)`, projections.length === realValues.length);
  check("投影帧都带 key 与 seq", projections.every((f) => typeof f.frame.key === "string" && Number.isInteger(f.frame.seq)));
  check("投影 seq 用 projections.asOfSeq", projections.every((f) => f.frame.seq === realSnapshot.projections.asOfSeq));
  const projKeys = new Set(projections.map((f) => f.frame.key));
  for (const key of ["title", "goal", "contextPressure", "permissions", "sessionStats", "tokenUsage", "todos"]) {
    check(`扩展读的投影键 ${key} 在回放里`, projKeys.has(key), `实得 ${[...projKeys].join(",")}`);
  }

  // 幂等:第二次 follow 不能重开流(重开会再要一份完整快照,而调用方可能只是要翻页)。
  const opensBefore = mux.opens.length;
  const again = await follows.follow({ kind: "session", sessionId: "s1" });
  check("follow 幂等(不重开流)", mux.opens.length === opensBefore);
  check("第二次 follow 仍给出游标与已缓存的事件", again.cursor === result.cursor && again.events.length === result.events.length);
  check("cursorOf 能查到游标", follows.cursorOf("s1") === result.cursor);
  check("cursorOf 对没跟过的会话给 undefined", follows.cursorOf("never") === undefined);
  check("followedSessionIds 列出了它", follows.followedSessionIds.includes("session:s1"));

  // 之后的实时增量:走的是**同一条流**。
  const durableSeq = result.cursor + 1;
  mux.last().handlers.onItem({ type: "event", event: { type: "assistant/message", seq: durableSeq, time: 1, data: {} } });
  const live = muxFrames.filter((f) => f.frame.type === "session/event").pop();
  check("开局帧之后的事件照常派发", live?.frame.event.seq === durableSeq);
  // 持久事件是小数基准的来源 —— 必须先于增量派发更新(见 assistant.ts 的 noteDurable)。
  mux.last().handlers.onItem({ type: "assistant-stream", frame: { type: "start", attemptId: "z1", turn: 1, step: 0, revision: 1, startedAfterSeq: durableSeq } });
  mux.last().handlers.onItem({ type: "assistant-stream", frame: { type: "chunk", attemptId: "z1", revision: 2, index: 0, time: 5, chunk: { type: "text-delta", index: 0, text: "活" } } });
  const liveChunk = muxFrames.filter((f) => f.frame.type === "session/event").pop()?.frame.event;
  check("流式增量经同一条流进来并铸出 seq", liveChunk?.type === "assistant/chunk" && liveChunk.seq > durableSeq && liveChunk.seq < durableSeq + 1, `实得 ${liveChunk?.seq}`);

  // 快照的 records 里万一有缺 seq 的项:store 的 Map<seq,…> 会收到 undefined 键,比丢一条事件难查得多。
  const mux2 = new FakeMux();
  const sink2 = makeSink();
  const w2 = wire(mux2, sink2, []);
  const p2 = w2.follows.follow({ kind: "session", sessionId: "s2" });
  mux2.last().handlers.onItem({
    type: "snapshot",
    cursor: 3,
    hasMore: false,
    projections: undefined,
    records: [{ event: { type: "turn/start", seq: 1, time: 1, data: {} } }, { event: { type: "turn/end", time: 2 } }, { nope: 1 }, null, "x", { event: { type: "x", seq: "3", time: 3 } }],
  });
  const r2 = await p2;
  check("缺 seq/非法 seq 的 record 被丢掉", r2.events.length === 1 && r2.events[0].event.seq === 1, `实得 ${r2.events.length}`);
  check("非法 record 不派发帧", sink2.muxFrames.filter((f) => f.frame.type === "session/event").length === 1);
  check("projections 缺失 ⇒ 只发 subscribed 不发投影帧", sink2.muxFrames.filter((f) => f.frame.type === "session/projection").length === 0);
  check("projections 缺失时 subscribed 用 cursor", sink2.muxFrames.find((f) => f.frame.type === "session/subscribed")?.frame.lastSeq === 3);

  follows.stop();
  check("stop() 取消底层流", mux.last().cancelled === true);
  check("stop() 清空登记", follows.followedSessionIds.length === 0);
}

// ---------- 4. history.ts:翻页与 -1 陷阱 ----------
console.log("\n=== 4. 翻页 ===");
{
  const calls = [];
  const mux = new FakeMux();
  const sink = makeSink();
  const { follows } = wire(mux, sink, calls);

  // 有更早的历史:翻页必须把开局帧的游标当 throughSeq 传下去。
  const pending = follows.follow({ kind: "session", sessionId: "s1" });
  mux.last().handlers.onItem({ type: "snapshot", cursor: 90, hasMore: true, records: [], projections: {} });
  const snap = await pending;
  const address = { kind: "session", sessionId: "s1" };
  calls.reply = { records: [{ event: { type: "user/message", seq: 80, time: 1, data: {} } }], hasMore: true };
  const page = await follows.readPage(address, snap.cursor, 85, 20);
  check("翻页用开局帧的游标当 throughSeq", calls[0]?.throughSeq === 90, `实得 ${calls[0]?.throughSeq}`);
  check("翻页透传 beforeSeq(排他上界)", calls[0]?.beforeSeq === 85);
  check("翻页透传 maxMessages", calls[0]?.maxMessages === 20);
  check("翻页的地址是会话地址", calls[0]?.address?.kind === "session" && calls[0]?.address?.sessionId === "s1");
  check("翻页回 {events, hasMore}", page.events.length === 1 && page.hasMore === true);

  // 空会话:游标 -1 是**合法**值,也正是「用它当 throughSeq ⇒ 恒空页」那个坑的形状。
  // 这里不替服务端做判断(-1 恰好是对的),但要钉住它**没有**被换成别的值。
  const mux2 = new FakeMux();
  const sink2 = makeSink();
  const calls2 = [];
  const w2 = wire(mux2, sink2, calls2);
  const p2 = w2.follows.follow({ kind: "session", sessionId: "blank" });
  mux2.last().handlers.onItem({ type: "snapshot", cursor: -1, hasMore: false, records: [], projections: { asOfSeq: -1, values: {} } });
  const r2 = await p2;
  check("空会话的游标是 -1(合法值,不是 undefined)", r2.cursor === -1);
  check("空会话的 hasMore 是 false", r2.hasMore === false);
  calls2.reply = { records: [], hasMore: false };
  const blankPage = await w2.follows.readPage({ kind: "session", sessionId: "blank" }, r2.cursor, 0, 20);
  check("空会话用 -1 当 throughSeq 发出去(服务端把它当空页,这是对的)", calls2[0]?.throughSeq === -1);
  check("空会话翻页回空页", blankPage.events.length === 0 && blankPage.hasMore === false);
  check("空会话的 subscribed 用 -1(legacy 语义)", sink2.muxFrames.find((f) => f.frame.type === "session/subscribed")?.frame.lastSeq === -1);

  // 游标缺失:保持上一次的值 —— 用 undefined 去发请求会被 validatePageRequest 拒掉,
  // 而错误信息只说「必须是整数」,看不出是哪儿空的。
  const mux3 = new FakeMux();
  const calls3 = [];
  const w3 = wire(mux3, makeSink(), calls3);
  const p3 = w3.follows.follow({ kind: "session", sessionId: "s3" });
  mux3.last().handlers.onItem({ type: "snapshot", cursor: 12, hasMore: true, records: [], projections: {} });
  const r3 = await p3;
  mux3.last().handlers.onItem({ type: "snapshot", cursor: undefined, hasMore: true, records: [], projections: {} });
  calls3.reply = { records: [], hasMore: false };
  await w3.follows.readPage({ kind: "session", sessionId: "s3" }, r3.cursor, 5, 10);
  check("游标缺失时沿用上一次的值(不传 undefined)", calls3[0]?.throughSeq === 12, `实得 ${calls3[0]?.throughSeq}`);
  check("第二次 follow 也就知道了缺失的游标不回退", w3.follows.cursorOf("s3") === 12);

  // 可选参数缺省:不发这个键,让服务端自己的 `?? DEFAULT_MAX_MESSAGES` 兜底。
  // (显式传 undefined 虽然也能过校验,但那是巧合 —— 校验器挡的是「不是正整数」。)
  const mux4 = new FakeMux();
  const calls4 = [];
  const w4 = wire(mux4, makeSink(), calls4);
  calls4.reply = { records: [], hasMore: false };
  await w4.follows.readPage({ kind: "session", sessionId: "s4" }, 5, undefined, undefined);
  check("maxMessages 为 undefined 时不发这个键", !("maxMessages" in (calls4[0] ?? {})), JSON.stringify(calls4[0]));
  check("beforeSeq 为 undefined 时不发这个键", !("beforeSeq" in (calls4[0] ?? {})));
  check("throughSeq 一定发(它是必需的)", calls4[0].throughSeq === 5);

  // 服务端回的信封缺字段:不能崩,也不能把 hasMore 猜成 true(会翻出无限循环)。
  const mux5 = new FakeMux();
  const calls5 = [];
  const w5 = wire(mux5, makeSink(), calls5);
  calls5.reply = {};
  const weird = await w5.follows.readPage({ kind: "session", sessionId: "s5" }, 5, 1, undefined);
  check("服务端回空信封 ⇒ 空页 + hasMore=false", weird.events.length === 0 && weird.hasMore === false);
  calls5.reply = { records: [{ event: { type: "x", seq: 1, time: 1, data: {} } }, null, 3], hasMore: "yes" };
  const weird2 = await w5.follows.readPage({ kind: "session", sessionId: "s5" }, 5, 1, undefined);
  check("非数组 records 逐项过滤", weird2.events.length === 1);
  check("hasMore 非布尔 ⇒ false(不能猜 true)", weird2.hasMore === false);

  // 流断了要自己重开 —— 不重开的话那个会话的实时增量永久停了,而用户看不出任何异常
  // (`ensureHistory` 的 historyLoaded 守卫也不会再触发一次订阅)。
  const mux6 = new FakeMux();
  const w6 = wire(mux6, makeSink(), []);
  const stuck = w6.follows.follow({ kind: "session", sessionId: "s1" }); // 一直不给开局帧
  mux6.last().handlers.onError({ code: "gateway/unavailable", message: "服务端没了" });
  await new Promise((r) => setTimeout(r, 1300));
  check("流断开后自己重开了(否则该会话的实时增量永久静默)", mux6.opens.length === 2, `opens=${mux6.opens.length}`);
  check("重开的是同一条 session/follow", mux6.last().endpoint === "session/follow");
  check("重开时仍然请求流式增量", mux6.last().args?.request?.assistantStream === true);

  // stop() 必须唤醒等着开局帧的调用方 —— 否则用户关面板时那个 await 要挂满 15 秒。
  w6.follows.stop();
  const raced = await Promise.race([stuck.then(() => "awake"), new Promise((r) => setTimeout(() => r("timeout"), 800))]);
  check("stop() 唤醒等着开局帧的调用方(不挂到超时)", raced === "awake", `实得 ${raced}`);
  check("stop() 取消了活着的流(断开的那条已被 RemoteMux 摘掉,不必再 cancel)", mux6.opens[1].cancelled === true);
  check("stop() 清空登记", w6.follows.followedSessionIds.length === 0);
}

// ---------- 5. history.ts:一次性读取(子会话历史) ----------
console.log("\n=== 5. 子会话一次性读取 ===");
{
  const mux = new FakeMux();
  const sink = makeSink();
  const { follows } = wire(mux, sink, []);
  const address = { kind: "subagent", parentSessionId: "p1", childSessionId: "c1", mode: "one-shot" };
  const pending = follows.snapshotOnce(address, 30);
  check("snapshotOnce 打开 session/follow", mux.last().endpoint === "session/follow");
  check(
    "子会话地址按 kind:subagent 寻址(不是拍平成 sessionId)",
    JSON.stringify(mux.last().args) === JSON.stringify({ request: { address, maxMessages: 30 } }),
    JSON.stringify(mux.last().args),
  );
  mux.last().handlers.onItem({ type: "snapshot", cursor: 4, hasMore: false, records: [{ event: { type: "user/message", seq: 4, time: 1, data: {} } }], projections: {} });
  const hist = await pending;
  check("拿到最后一页", hist.events.length === 1 && hist.events[0].event.seq === 4);
  check("拿完就关流(一次性)", mux.last().cancelled === true);
  // legacy 的 subagent.history 也不进主 store —— 子会话事件混进主 store 会串到别的会话视图上。
  check("**不派发任何帧**(子会话事件不进主 store)", sink.muxFrames.length === 0, `实得 ${sink.muxFrames.length}`);

  const mux2 = new FakeMux();
  const { follows: f2 } = wire(mux2, makeSink(), []);
  const pending2 = f2.snapshotOnce({ kind: "session", sessionId: "s" });
  check("maxMessages 缺省时不发这个键", !("maxMessages" in mux2.last().args.request), JSON.stringify(mux2.last().args.request));
  mux2.last().handlers.onItem({ type: "snapshot", cursor: 0, hasMore: false, records: [], projections: {} });
  await pending2;

  // 流在给出开局帧之前就结束/报错:必须 reject,不能挂住。
  const mux3 = new FakeMux();
  const { follows: f3 } = wire(mux3, makeSink(), []);
  const pending3 = f3.snapshotOnce({ kind: "session", sessionId: "s" }).then(() => "resolved").catch(() => "rejected");
  mux3.last().handlers.onError({ code: "gateway/unavailable", message: "x" });
  check("开局帧之前报错 ⇒ reject(不挂住调用方)", (await pending3) === "rejected");

  const mux4 = new FakeMux();
  const { follows: f4 } = wire(mux4, makeSink(), []);
  const pending4 = f4.snapshotOnce({ kind: "session", sessionId: "s" }).then(() => "resolved").catch(() => "rejected");
  mux4.last().handlers.onEnd();
  check("开局帧之前结束 ⇒ reject", (await pending4) === "rejected");
}

// ---------- 6. 与真 store 合流(整数 seq 才是真陷阱) ----------
console.log("\n=== 6. 合流:铸造的 seq 必须插对位置 ===");
{
  const store = new storeMod.SessionStore();
  const mux = new FakeMux();
  // sink 直接喂真 store —— 这一节要看的正是「帧进 store 之后排在哪」。
  const sink = makeSink((e) => store.handleMuxEnvelope(e));
  const calls = [];
  const { follows } = wire(mux, sink, calls);
  // 会话行要先存在:`applyProjection` 的 title 分支会往**已有**的行上写
  // (`hub.refreshSessions` 靠 session/list 建行,早期靠 host/session-added)。没有行 = title 被静默丢掉。
  store.handleHostFrame({ type: "host/session-added", sessionId: "s1", blank: false });

  const pending = follows.follow({ kind: "session", sessionId: "s1" });
  mux.last().handlers.onItem({
    type: "snapshot",
    cursor: 4,
    hasMore: true,
    projections: { asOfSeq: 4, values: { title: "测试会话", permissions: { options: [], currentValue: "default" } } },
    records: [
      { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } } },
      { event: { type: "user/message", seq: 2, time: 2, data: { turn: 1 } } },
      { event: { type: "step/start", seq: 3, time: 3, data: { turn: 1, step: 0 } } },
      { event: { type: "assistant/attempt", seq: 4, time: 4, data: { turn: 1, step: 0 } } },
    ],
  });
  await pending;

  const stream = mux.last();
  stream.handlers.onItem({ type: "assistant-stream", frame: { type: "start", attemptId: "a1", turn: 1, step: 0, revision: 1, startedAfterSeq: 4 } });
  for (let i = 0; i < 3; i++) {
    stream.handlers.onItem({ type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", revision: 2 + i, index: 0, time: 10 + i, chunk: { type: "text-delta", index: 0, text: "字" + i } } });
  }
  // 落盘:持久消息 seq=5 紧随其后。
  stream.handlers.onItem({ type: "assistant-stream", frame: { type: "end", attemptId: "a1", revision: 9, outcome: { kind: "committed", eventType: "assistant/message", seq: 5 } } });
  stream.handlers.onItem({ type: "event", event: { type: "assistant/message", seq: 5, time: 20, data: { turn: 1, step: 0, message: { content: [{ type: "text", text: "字0字1字2" }] } } } });
  stream.handlers.onItem({ type: "event", event: { type: "turn/end", seq: 6, time: 21, data: { turn: 1 } } });

  const stored = store.eventsFor("s1");
  const seqs = stored.map((s) => s.event.seq);
  check(`store 收到 ${stored.length} 条事件`, stored.length === 9, `实得 ${stored.length}: ${seqs.join(", ")}`);
  check("eventsFor 的排序严格递增(含小数)", seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(", "));
  // **最关键的一条**:持久事件 seq=5 必须还在。撞号的话 store.addEvent 会把它当重复丢掉
  // —— 表现是「模型回复整段消失」,而且只在那一次撞号上出现。
  check("持久 assistant/message(seq=5)没被铸造的 seq 挤掉", store.events.has("s1") && stored.some((s) => s.event.type === "assistant/message" && s.event.seq === 5));
  const chunkSeqs = stored.filter((s) => s.event.type === "assistant/chunk").map((s) => s.event.seq);
  check(`3 条流式增量都进了 store`, chunkSeqs.length === 3, `实得 ${chunkSeqs.length}`);
  check("增量的 seq 全部落在 (4, 5) —— 排在 user/message 之后、持久回复之前", chunkSeqs.every((s) => s > 4 && s < 5), chunkSeqs.join(", "));
  const types = stored.map((s) => s.event.type);
  check("顺序:… assistant/attempt → 增量 → assistant/message → turn/end", types.join(",") === "turn/start,user/message,step/start,assistant/attempt,assistant/chunk,assistant/chunk,assistant/chunk,assistant/message,turn/end", types.join(","));
  check("maxSeq 停在最后的持久 seq 上", store.maxSeq.get("s1") === 6, `实得 ${store.maxSeq.get("s1")}`);
  // 投影回放进了 store:不回放的话权限胶囊会停在上一个会话的值上。
  check("投影进了 store(title)", store.sessions.get("s1")?.title === "测试会话");
  check("投影进了 store(permissions)", store.permissions.get("s1")?.currentValue === "default");
  // 存活的增量不能被 historyBeforeSeq 当成整数发出去。
  check("historyBeforeSeq 取到最老的 seq", store.historyBeforeSeq("s1") === 1, `实得 ${store.historyBeforeSeq("s1")}`);

  // 重连:服务端重发一份快照,store 按 seq 去重 —— 一条都不该重复。
  const before = store.eventsFor("s1").length;
  store.mergeHistory("s1", store.eventsFor("s1"));
  check("重发快照被 seq 去重吸收", store.eventsFor("s1").length === before);

  // ---- historyBeforeSeq 的取整:这是「加载更早」整块失灵的那条路 ----
  const s2 = new storeMod.SessionStore();
  s2.sessions.set("x", { sessionId: "x", running: false, blank: false, updatedAt: 0 });
  check("没有事件时给 undefined(不猜 0)", s2.historyBeforeSeq("x") === undefined);
  // 最老的事件是小数 7.5 ⇒ 必须 ceil 成 8:beforeSeq 是**排他**上界,floor 成 7 会把整数事件 7 漏掉。
  s2.handleMuxFrame({ type: "session/event", sessionId: "x", event: { type: "assistant/chunk", seq: 7.5, time: 1, data: {} } });
  s2.handleMuxFrame({ type: "session/event", sessionId: "x", event: { type: "user/message", seq: 20, time: 2, data: {} } });
  const before2 = s2.historyBeforeSeq("x");
  check("小数 seq 取 ceil(7.5 → 8,排他上界才不会漏掉整数 7)", before2 === 8, `实得 ${before2}`);
  check("取整后是安全整数(校验器只收整数)", Number.isSafeInteger(before2) && before2 >= 0);
  // 最老的是整数时 ceil 不动它。
  const s3 = new storeMod.SessionStore();
  s3.handleMuxFrame({ type: "session/event", sessionId: "y", event: { type: "user/message", seq: 3, time: 1, data: {} } });
  check("整数 seq 原样返回", s3.historyBeforeSeq("y") === 3);
  // -0 陷阱:Math.ceil(-0.4) === -0,而校验器专门用 Object.is(x, -0) 拒它。
  const s4 = new storeMod.SessionStore();
  s4.handleMuxFrame({ type: "session/event", sessionId: "z", event: { type: "assistant/chunk", seq: -0.4, time: 1, data: {} } });
  const negZero = s4.historyBeforeSeq("z");
  check("-0 被归一成 +0(校验器用 Object.is(x,-0) 专门拒 -0)", !Object.is(negZero, -0), `实得 ${negZero}`);
  check("-0 归一后仍是数值", negZero === 0);

  // 空会话的增量(seq 0.5)⇒ 翻页游标 1,而不是 0.5 或 -0。
  const s5 = new storeMod.SessionStore();
  s5.handleMuxFrame({ type: "session/event", sessionId: "e", event: { type: "assistant/chunk", seq: 0.5, time: 1, data: {} } });
  check("空会话第一条增量 ⇒ beforeSeq 1", s5.historyBeforeSeq("e") === 1, `实得 ${s5.historyBeforeSeq("e")}`);
}

  console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}${skip ? `(跳过 ${skip} 项)` : ""}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("测试崩溃:", error);
  process.exit(1);
});
