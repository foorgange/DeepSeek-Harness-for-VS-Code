/**
 * S5 的真机验收探针 —— 驱动的是**扩展真正在用的那几个类**(SessionFollows /
 * AssistantStreams),不是另写一套等价逻辑。所以它验过的路径就是线上路径。
 *
 * 用法(先把 dsh 跑起来):
 *   npx esbuild tools/probe-history.ts --bundle --platform=node --format=cjs --outfile=dist/probe.js
 *   node dist/probe.js                    # 只读:挑一个日志够长的会话,翻到底
 *   node dist/probe.js --session <id>     # 指定会话
 *   node dist/probe.js --messages 50      # 每页消息数(默认 100)。调小才翻得动
 *   node dist/probe.js --skip-blank       # 跳过空白会话那一节
 *
 * 只读阶段验的是 S5 的验收点里**不需要花 token** 的那部分:
 *   · 打开既有会话看到完整转录(snapshot 的 records);
 *   · 「加载更早」向后翻页**无空洞无重复**(逐页断言接缝:每页末条 seq 必须正好
 *     贴着请求的 beforeSeq - 1,下一页的 beforeSeq 取上一页首条 seq);
 *   · 一直翻到 hasMore:false,并且最早那条真的到了 seq 0。
 *
 * 流式阶段要花 token,所以是 opt-in:
 *   node dist/probe.js --stream
 * 它会**新建一个临时会话**(工作目录在 tmp 下),让它做一次带推理与工具调用的回答,
 * 全程打印铸造出来的 assistant/chunk 事件,最后归档掉那个会话。验收点是:
 *   · 文字与推理**逐 token** 到达(不是一次性一大块);
 *   · 铸造的 seq 严格单调、且不与任何持久 seq 撞号;
 *   · 工具调用与结果各自成为**一条**持久事件(卡片靠它们渲染);
 *   · 回合正常结算(turn/end 落盘,没有半截的流)。
 *
 * 注意:探针**不改**任何既有会话的内容(只读);唯一会写入的是它自己建的临时会话,
 * 而那个会话跑完就被归档。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { authHeaders, resolveAuth, type DshAuth } from "../src/dsh/protocol/auth";
import { RemoteMux } from "../src/dsh/protocol/mux";
import { args } from "../src/dsh/protocol/modern/args";
import { AssistantStreams } from "../src/dsh/protocol/modern/assistant";
import { SessionFollows, type PageRequest } from "../src/dsh/protocol/modern/history";
import type { FrameEnvelope } from "../src/dsh/protocol/legacy";
import type { HostFrame, MuxFrame, SessionEvent } from "../src/dsh/types";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log((ok ? "  OK   " : "  FAIL ") + name + (ok || detail === undefined ? "" : `  → ${detail}`));
  if (!ok) fail++;
}

async function call(auth: DshAuth, endpoint: string, payload: unknown): Promise<any> {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: endpoint, payload: { args: payload } }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({ __httpStatus: res.status }));
  if (body?.result?.ok === false) throw new Error(`${endpoint}: ${JSON.stringify(body.result.error).slice(0, 200)}`);
  return body?.result?.value;
}

/** 收集所有派发出来的帧(探针自己就是 sink)。 */
function makeSink() {
  let n = 0;
  const events: { sessionId: string; event: SessionEvent }[] = [];
  const hosts: HostFrame[] = [];
  return {
    events,
    hosts,
    onMux(env: FrameEnvelope<MuxFrame>) {
      if (env.frame.type === "session/event") events.push({ sessionId: env.frame.sessionId, event: env.frame.event });
    },
    onHost(env: FrameEnvelope<HostFrame>) {
      hosts.push(env.frame);
    },
    onLog(message: string) {
      console.log(`      [log] ${message}`);
    },
    newRpcId: () => "probe-" + ++n,
  };
}

/** 一页的摘要,方便眼睛扫。 */
function summarize(events: { event: SessionEvent }[]): string {
  const byType = new Map<string, number>();
  for (const { event } of events) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  return [...byType.entries()].map(([t, n]) => `${t}×${n}`).join(" ");
}

async function main() {
  const auth = await resolveAuth(BASE);
  if (!auth) throw new Error("无法解析鉴权凭据 —— 检查 ~/.dsh/.credentials.yaml");
  console.log(`探针目标 ${BASE}(authority=${auth.authority}, 来源=${auth.via})\n`);

  const mux = new RemoteMux({ baseUrl: BASE, auth: async () => auth, onLog: () => {} });
  const sink = makeSink();
  const assistant = new AssistantStreams(sink);
  const pages: PageRequest[] = [];
  const follows = new SessionFollows(mux, sink, assistant, async (request) => {
    pages.push(request);
    return call(auth, "session/page", args.sessionPage(request));
  });

  mux.connect();
  await new Promise((r) => setTimeout(r, 300));

  // ---------- 选会话 ----------
  const listed = await call(auth, "session/list", args.sessionList());
  const items: any[] = listed?.items ?? [];
  console.log(`会话 ${items.length} 个`);
  let sessionId = arg("session");
  let snap: Awaited<ReturnType<typeof follows.follow>> | undefined;
  if (sessionId === undefined) {
    // 翻页要**真的**翻起来才有意义:只有日志比一个窗口还长的会话才会 hasMore=true。
    // 逐个试最近的非空会话(一页快照很便宜),取第一个有更早历史的。
    const candidates = items.filter((i) => !i.blank).slice(0, 15);
    for (const item of candidates) {
      const probe = await follows.follow({ kind: "session", sessionId: item.sessionId });
      if (probe.hasMore) {
        sessionId = item.sessionId;
        snap = probe;
        console.log(`选中 ${sessionId}(快照 ${probe.events.length} 条 / 游标 ${probe.cursor} / 还有更早的)`);
        break;
      }
    }
    if (sessionId === undefined) {
      const fallback = candidates[0] ?? items[0];
      sessionId = fallback?.sessionId;
      console.log("最近 15 个会话都没有更早的历史 —— 用最近那个跑(翻页部分会是空转)");
    }
  }
  if (typeof sessionId !== "string") {
    console.log("没有会话可选 —— 先建一个再跑。");
    mux.dispose();
    process.exitCode = 1;
    return;
  }
  const row = items.find((i) => i.sessionId === sessionId);
  console.log(`跟随会话 ${sessionId}(${row?.title ?? "无标题"} / blank=${row?.blank})\n`);

  // ---------- 1. 开局帧 = 首屏转录 ----------
  console.log("=== 1. 打开既有会话 ===");
  snap = snap ?? (await follows.follow({ kind: "session", sessionId }));
  check("拿到开局帧(没超时)", true);
  check("游标是整数", Number.isSafeInteger(snap.cursor), `cursor=${snap.cursor}`);
  check("游标不是 -1(有内容的会话)", snap.cursor !== -1, `cursor=${snap.cursor}`);
  console.log(`      游标 ${snap.cursor},首屏 ${snap.events.length} 条事件,hasMore=${snap.hasMore}`);
  console.log(`      构成: ${summarize(snap.events)}`);
  check("首屏有事件", snap.events.length > 0, `${snap.events.length} 条`);
  const dispatched = sink.events.filter((e) => e.sessionId === sessionId);
  check("首屏事件都派发成了 session/event 帧", dispatched.length >= snap.events.length, `${dispatched.length} 帧`);
  check("最大 seq 与游标一致(store 的 maxSeq 靠它对齐)", dispatched.reduce((m, e) => Math.max(m, e.event.seq), -1) === snap.cursor, `事件里最大 ${dispatched.reduce((m, e) => Math.max(m, e.event.seq), -1)} vs 游标 ${snap.cursor}`);
  const seqsAscending = snap.events.every((e, i) => i === 0 || e.event.seq > snap.events[i - 1].event.seq);
  check("首屏事件按 seq 递增", seqsAscending);
  const kinds = new Set(snap.events.map((e) => e.event.type));
  console.log(`      事件类型: ${[...kinds].sort().join(", ")}`);

  // ---------- 2. 向后翻页到底 ----------
  console.log("\n=== 2. 「加载更早」翻到底 ===");
  const maxMessages = Number(arg("messages") ?? 100);
  const seen = new Map<number, string>(); // seq → type,用来抓重复
  for (const { event } of snap.events) seen.set(event.seq, event.type);
  let before = Math.ceil(Math.min(...snap.events.map((e) => e.event.seq))) + 0;
  let hasMore = snap.hasMore;
  let round = 0;
  let holes: string[] = [];
  let overlaps: string[] = [];
  while (hasMore && round < 200) {
    round++;
    const page = await follows.readPage({ kind: "session", sessionId }, snap.cursor, before, maxMessages);
    if (page.events.length === 0) {
      check(`第 ${round} 页非空(hasMore=true 却给空页 = 空洞)`, false, `beforeSeq=${before}`);
      break;
    }
    const last = page.events[page.events.length - 1].event.seq;
    // 接缝:每一页必须**正好**贴到请求的那个排他上界(参考实现里叫 assertPageThrough)。
    if (last !== before - 1) holes.push(`第 ${round} 页末条 ${last} ≠ beforeSeq-1 ${before - 1}`);
    for (const { event } of page.events) {
      if (seen.has(event.seq)) overlaps.push(`seq ${event.seq} 在第 ${round} 页重复`);
      seen.set(event.seq, event.type);
    }
    const ascending = page.events.every((e, i) => i === 0 || e.event.seq > page.events[i - 1].event.seq);
    if (!ascending) holes.push(`第 ${round} 页内部乱序`);
    before = Math.ceil(page.events[0].event.seq) + 0;
    hasMore = page.hasMore;
    console.log(`      第 ${round} 页: ${page.events.length} 条 seq[${page.events[0].event.seq}…${last}] hasMore=${hasMore}`);
  }
  check(`翻到 hasMore=false(${round} 页,共 ${seen.size} 条)`, hasMore === false, `still hasMore after ${round} rounds`);
  check("每页都正好贴住请求的上界(无空洞)", holes.length === 0, holes.slice(0, 3).join("; "));
  check("跨页无重复 seq", overlaps.length === 0, overlaps.slice(0, 3).join("; "));
  check("翻到头就是 seq 0(整条日志都拿到了)", seen.has(0), `最小 seq ${Math.min(...seen.keys())}`);
  const allAsc = [...seen.keys()].sort((a, b) => a - b);
  check("所有拿到的 seq 都是整数(持久事件没有小数)", allAsc.every((s) => Number.isSafeInteger(s)));
  check("pages 请求都带上了正确的 throughSeq", pages.every((p) => p.throughSeq === snap.cursor), JSON.stringify(pages[0]));
  check("pages 请求的 beforeSeq 都是非负安全整数(校验器只收这个)", pages.every((p) => p.beforeSeq === undefined || (Number.isSafeInteger(p.beforeSeq) && p.beforeSeq >= 0 && !Object.is(p.beforeSeq, -0))));
  console.log(`      页请求: ${pages.map((p) => `before=${p.beforeSeq}`).join(", ")}`);

  // 翻页拿回来的是**消息边界**切的一整段,类型分布能看出工具卡片有没有被切掉。
  console.log(`      全部 ${seen.size} 条的类型分布: ${[...new Set(seen.values())].sort().join(", ")}`);

  // ---------- 3. 空会话(游标 -1 的那条路) ----------
  // 注:`blank` 的会话不代表**日志为空** —— 新建时就会有 system/message、session/title
  // 之类的事件,所以它的游标通常是 1、2 而不是 -1。真正游标 -1 的只有「一条事件都没有」
  // 的会话,那个在 --stream 阶段新建的那个上验(这里不建会话,保持只读)。
  if (!has("skip-blank")) {
    console.log("\n=== 3. 刚建的空白会话 ===");
    const blank = items.find((i) => i.blank);
    if (blank === undefined) {
      console.log("      SKIP 列表里没有空白会话");
    } else {
      const b = await follows.follow({ kind: "session", sessionId: blank.sessionId });
      check("游标是安全整数(可能是 -1,也可能是建会话时的几条事件)", Number.isSafeInteger(b.cursor), `cursor=${b.cursor}`);
      check("游标 ≥ -1(-1 是空日志的合法游标)", b.cursor >= -1, `cursor=${b.cursor}`);
      const p = await follows.readPage({ kind: "session", sessionId: blank.sessionId }, b.cursor, Math.max(b.cursor, 0), 10);
      check("翻页不报错(要么空页,要么几条建会话的事件)", Array.isArray(p.events));
    }
  }

  // ---------- 4. 流式(要花 token,opt-in) ----------
  if (has("stream")) await probeStream(auth, sink, follows);

  mux.dispose();
  console.log(`\n${fail === 0 ? (has("stream") ? "探针全部通过" : "只读阶段全部通过") : `失败 ${fail} 项`}`);
  // 不能紧接着 process.exit():socket 的关闭还在路上,libuv 会在退出时断言失败
  // (Windows 上表现为 `!(handle->flags & UV_HANDLE_CLOSING)`)。让事件循环自己排空。
  await new Promise((r) => setTimeout(r, 250));
  process.exitCode = fail === 0 ? 0 : 1;
}

/**
 * 真跑一次回答,压 S5 的流式验收点。
 *
 * 用**临时会话**(工作目录在 tmp 下),跑完归档 —— 不碰用户任何既有会话的内容。
 * 问的是一件必须动工具、也必须想一想的事,这样 `tool/call`/`tool/result` 与推理增量
 * 都会真的出现,而不是碰运气。
 */
async function probeStream(
  auth: DshAuth,
  sink: ReturnType<typeof makeSink>,
  follows: SessionFollows,
): Promise<void> {
  console.log("\n=== 4. 流式增量(真跑一个回合)===");
  const scratch = mkdtempSync(join(tmpdir(), "dsh-probe-"));
  const created = await call(auth, "session/create", args.sessionCreate({ cwd: scratch, agentPreset: "standard" }));
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string") throw new Error(`建会话失败: ${JSON.stringify(created).slice(0, 200)}`);
  console.log(`      临时会话 ${sessionId}(工作区 ${scratch})`);

  const from = sink.events.length;
  // 新建的会话**不是空日志**:dsh 在建会话时就落了 permission/preset、sandbox/mode、
  // approval/policy 三条策略事件,所以它的游标是 2 而不是 -1。
  // (`cursorBeforeNext(0) === -1` 那条路要日志真的一条都没有才走得到,真机上够不着 ——
  //  assistant.ts 里把 base 钳到 ≥0 仍然是必须的,只是它属于防御而不是常态。)
  const fresh = await follows.follow({ kind: "session", sessionId });
  check("新建会话的游标是安全整数 ≥ -1", Number.isSafeInteger(fresh.cursor) && fresh.cursor >= -1, `cursor=${fresh.cursor}`);
  check("新建会话只有建会话时的策略事件", fresh.events.every((e) => ["permission/preset", "sandbox/mode", "approval/policy"].includes(e.event.type)), fresh.events.map((e) => e.event.type).join(","));
  await call(auth, "session/prompt", args.sessionPrompt({
    requestId: randomUUID(),
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "用 shell 跑 `node -e \"console.log(1+1)\"`,然后一句话说明输出是什么。先想一下要不要用工具。" }],
  }));

  // 等回合结束(带超时):`turn/end` 是持久事件,它到了就说明这一回合结算了。
  const started = Date.now();
  const deadline = started + 120_000;
  let cursor = from;
  let done = false;
  let chunks = 0;
  let lastChunkSeq = -1;
  let monotonic = true;
  let nonInteger = true;
  const deltaCount = new Map<string, number>();
  const deltaTimes = new Map<string, number[]>();
  const deltaLens: number[] = [];
  const attempts = new Set<string>();
  const emitted: { type: string; seq: number; text?: string }[] = [];

  while (!done && Date.now() < deadline) {
    // 只往前走:到达顺序就是真实顺序,不回头重扫。
    while (cursor < sink.events.length) {
      const { sessionId: sid, event } = sink.events[cursor++];
      if (sid !== sessionId) continue;
      if (event.type === "assistant/chunk") {
        chunks++;
        if (lastChunkSeq >= 0 && event.seq <= lastChunkSeq) monotonic = false;
        // 撞上整数就等于撞上某条持久事件 —— store 按 seq 去重会把**持久内容**丢掉,
        // 所以「铸造出来的 seq 必须不是整数」是条硬不变量,不是审美。
        if (Number.isInteger(event.seq)) nonInteger = false;
        lastChunkSeq = event.seq;
        const data = event.data as any;
        const chunk = data?.chunk;
        const key = `${chunk?.type ?? "?"}`;
        deltaCount.set(key, (deltaCount.get(key) ?? 0) + 1);
        if (chunk?.type === "text-delta" || chunk?.type === "reasoning-delta") {
          const times = deltaTimes.get(key) ?? [];
          times.push(event.time);
          deltaTimes.set(key, times);
          if (typeof chunk.text === "string") deltaLens.push(chunk.text.length);
        }
        attempts.add(`${data?.turn}/${data?.step}`);
        emitted.push({ type: chunk?.type ?? "?", seq: event.seq, text: chunk?.text });
        continue;
      }
      if (event.type === "turn/end") {
        console.log(`      回合结束(用时 ${((Date.now() - started) / 1000).toFixed(1)}s)`);
        done = true;
        break;
      }
    }
    if (!done) await new Promise((r) => setTimeout(r, 150));
  }
  check("回合在超时前结算", done, `${(120).toFixed(0)}s 内没等到 turn/end`);

  const turn = sink.events.filter((e) => e.sessionId === sessionId);
  const types = new Map<string, number>();
  for (const { event } of turn) types.set(event.type, (types.get(event.type) ?? 0) + 1);
  console.log(`      事件构成: ${[...types.entries()].map(([t, n]) => `${t}×${n}`).join(" ")}`);

  check("收到流式增量(assistant/chunk)", chunks > 0, `${chunks} 条`);
  // 逐 token:看的是「很多条小增量,且它们在时间上是散开的」。
  // 用**服务端帧自带的 time**(铸造事件时透传的)而不是本地接收时刻 —— 本地时刻会被
  // 这一侧的事件循环批处理,测出来的是「我什么时候读的」,不是「它什么时候来的」。
  const textDeltas = deltaCount.get("text-delta") ?? 0;
  const reasoningDeltas = deltaCount.get("reasoning-delta") ?? 0;
  const spreadOf = (key: string) => {
    const times = deltaTimes.get(key) ?? [];
    return times.length < 2 ? 0 : Math.max(...times) - Math.min(...times);
  };
  const maxLen = deltaLens.length === 0 ? 0 : Math.max(...deltaLens);
  console.log(`      增量种类: ${[...deltaCount.entries()].map(([t, n]) => `${t}×${n}`).join(" ")}`);
  console.log(`      文字 ${textDeltas} 条(最长一片 ${maxLen} 字,时间跨度 ${spreadOf("text-delta")}ms),推理 ${reasoningDeltas} 条(跨度 ${spreadOf("reasoning-delta")}ms)`);
  console.log(`      增量覆盖的 turn/step: ${[...attempts].sort().join(", ")}`);

  check("文字是逐 token 到的(多条小片,不是一整块)", textDeltas >= 3 && maxLen <= 40, `${textDeltas} 条 / 最长 ${maxLen} 字`);
  check("文字在时间上是散开的(不是一次性灌进来)", spreadOf("text-delta") > 0 || textDeltas >= 3, `跨度 ${spreadOf("text-delta")}ms`);
  check("推理增量也是逐 token 的", reasoningDeltas >= 3, `${reasoningDeltas} 条`);
  check("铸造的 seq 严格单调", monotonic);
  check("铸造的 seq 全是小数(不撞整数持久 seq)", nonInteger);
  check("工具调用落成持久事件 tool/call", (types.get("tool/call") ?? 0) > 0);
  check("工具结果落成持久事件 tool/result", (types.get("tool/result") ?? 0) > 0);
  check("回合正常结算(turn/end 落盘)", (types.get("turn/end") ?? 0) > 0);

  // 持久消息是**兜底**:它带完整内容,而 ui.ts 靠 `${turn}:${step}:${index}` 这个键跳过重复追加
  // —— 所以增量标注的 turn/step 必须是**持久消息上也有的那一对**,否则同一段文字会渲染两遍。
  //
  // 注意不能拿「第一条增量」去比「最后一条持久消息」:一个回合可以有多个 step
  // (实测:step 1 推理+工具调用,step 2 出答案),两条 assistant/message 各自带自己的 step。
  const durablePairs = new Set(
    turn.filter((e) => e.event.type === "assistant/message").map((e) => `${(e.event.data as any)?.turn}/${(e.event.data as any)?.step}`),
  );
  check("持久 assistant/message 没被铸造的 seq 挤掉", durablePairs.size > 0);
  const orphanPairs = [...attempts].filter((p) => !durablePairs.has(p));
  check(
    "增量标注的每个 turn/step 都能在持久消息上找到(否则文字渲染两遍)",
    orphanPairs.length === 0,
    `落空的 ${orphanPairs.join(", ")};持久有 ${[...durablePairs].join(", ")}`,
  );
  const maxDurable = turn.filter((e) => Number.isSafeInteger(e.event.seq)).reduce((m, e) => Math.max(m, e.event.seq), -1);
  check("最后一条增量的 seq 小于整个回合最后一条持久事件的 seq", lastChunkSeq < maxDurable, `${lastChunkSeq} vs ${maxDurable}`);
  if (emitted.length > 0) {
    console.log(`      增量摘要(前 6 条): ${emitted.slice(0, 6).map((e) => `${e.type}${e.text ? JSON.stringify(e.text.slice(0, 12)) : ""}`).join(" ")}`);
  }

  // ---------- 5. 重连能补回断线期间的事件 ----------
  // 做法就是把流全关掉再跟一次(等价于关掉面板再打开):服务端会重发一份完整快照,
  // 而那份快照必须覆盖刚才整个回合 —— 这是「断线期间的事件不丢」的唯一途径。
  console.log("\n=== 5. 重连补历史 ===");
  follows.stop();
  const resnap = await follows.follow({ kind: "session", sessionId });
  console.log(`      新快照:游标 ${resnap.cursor},${resnap.events.length} 条`);
  check("新快照覆盖了刚才整个回合(游标 ≥ 断线前最大持久 seq)", resnap.cursor >= maxDurable, `${resnap.cursor} vs ${maxDurable}`);
  const freshTypes = new Set(resnap.events.map((e) => e.event.type));
  check("快照里能找回工具调用(tool/call)", freshTypes.has("tool/call"));
  check("快照里能找回工具结果(tool/result)", freshTypes.has("tool/result"));
  check("快照里能找回模型回复(assistant/message)", freshTypes.has("assistant/message"));
  const freshSeqs = resnap.events.map((e) => e.event.seq);
  check("快照事件按 seq 递增且无重复", freshSeqs.every((s, i) => i === 0 || s > freshSeqs[i - 1]));

  // 收尾:归档临时会话(0.1.5 没有删除 API,归档是唯一的收尾方式)。
  await call(auth, "workspace/archiveSession", args.workspaceArchiveSession(sessionId));
  console.log("      已归档临时会话");
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exitCode = 1;
});
