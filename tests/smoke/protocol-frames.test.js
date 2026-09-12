// 翻译层测试 —— 用**录制的真实帧**驱动 frames.ts / events.ts。
// 用法: node tests/smoke/protocol-frames.test.js
//
// 为什么这一层最值:整个移植里唯一没法靠编译器兜住的地方就是这里。`sessionStore` /
// `ui.ts` 里的判别字面量有几十处,而帧类型改名是 `import type` —— **编译期零报错、
// 运行时才炸**,表现还只是「界面莫名少东西」。所以这层必须用服务端真正发过的字节去压。
//
// 夹具来自 tools/record-mux.ts(录制,不是手写)。手写的夹具只会把「我以为服务端会发
// 什么」固化下来 —— 这个移植已经栽过一次:`dsh-client-connection/lib/client.js` 那份
// 「参照实现」其实是夹具,它的 control baseline 里带着 `approvals: []`/`questions: []`
// 两个根本不存在字段,照它写就会把审批初始化建在一个永远不来的字段上。
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

const frames = bundle("src/dsh/protocol/modern/frames.ts", "frames-test");
const eventsMod = bundle("src/dsh/protocol/modern/events.ts", "events-test");

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
/** 断言不抛异常 —— wire 上的东西全是 unknown,任何一处没防住就是崩整个面板。 */
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
  // 取最新的那份 —— 重录一次不该还要改测试。
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, files[files.length - 1]), "utf8"));
}

const fixture = loadFixture();
const streamOf = (endpoint) => fixture?.streams?.find((s) => s.endpoint === endpoint);
/** 展开 repeat 折叠后的帧序列(录制端把连续重复帧折叠了,见 tools/record-mux.ts)。 */
const itemsOf = (endpoint) => {
  const out = [];
  for (const item of streamOf(endpoint)?.items ?? []) {
    for (let i = 0; i < (item.repeat ?? 1); i++) out.push(item.value);
  }
  return out;
};

// ---------- 1. 录制夹具里的真实帧 ----------
console.log("=== 1. 真实帧(fixture 驱动)===");
if (fixture === undefined) {
  skipped("全部 fixture 用例", "没有 tests/fixtures/mux-*.json —— 先跑 tools/record-mux.ts");
} else {
  console.log(`     夹具录制于 ${fixture.recordedAt}(authority=${fixture.authority})`);

  // --- $events:ready ---
  const ready = itemsOf("$events").find((v) => v?.type === "ready");
  check("$events 开局帧是 ready", ready !== undefined);
  check("ready 带 clientId", typeof ready?.clientId === "string" && ready.clientId.length > 0);
  check("ready 带 host.home", typeof ready?.host?.home === "string");

  // --- session/control baseline ---
  const controlBaseline = itemsOf("session/control").find((v) => v?.type === "baseline");
  check("session/control 开局帧是 baseline", controlBaseline !== undefined);
  const cv = controlBaseline?.value ?? {};
  // 这条断言是防回归的:**夹具里那份假的 baseline 有这两个字段,真服务端没有**。
  check("baseline 只有 queues/jobs/projections 三个键", Object.keys(cv).sort().join(",") === "jobs,projections,queues", `实得 ${Object.keys(cv)}`);
  check(
    "baseline **没有** approvals/questions 字段(参照实现那份夹具是假的)",
    !("approvals" in cv) && !("questions" in cv),
  );

  const projected = frames.projectControl({ type: "baseline", value: cv }, () => "rpc");
  const expectCount =
    Object.keys(cv.queues ?? {}).length + Object.keys(cv.jobs ?? {}).length +
    Object.values(cv.projections ?? {}).reduce((n, b) => n + Object.keys(b?.values ?? {}).length, 0);
  check(
    `baseline 扇出成 ${expectCount} 帧(队列/任务按会话、投影按键)`,
    projected.length === expectCount,
    `实得 ${projected.length}`,
  );
  check("扇出的帧全部走 mux", projected.every((p) => p.channel === "mux"));
  check(
    "空队列也照发(否则界面会永远留着上一次的队列)",
    projected.some((p) => p.frame.type === "session/queue" && Array.isArray(p.frame.items)),
  );
  check("jobs 帧形状正确", projected.some((p) => p.frame.type === "session/jobs" && Array.isArray(p.frame.jobs)));

  // 扩展真正读的 7 个投影键 —— 名字或载荷变了就是「胶囊不更新」这类静默故障。
  const projectionKeys = new Set(projected.filter((p) => p.frame.type === "session/projection").map((p) => p.frame.key));
  for (const key of ["title", "goal", "contextPressure", "permissions", "sessionStats", "tokenUsage", "todos"]) {
    check(`投影键 ${key} 在真实 baseline 里`, projectionKeys.has(key), `实得 ${[...projectionKeys].join(",")}`);
  }
  const perms = projected.find((p) => p.frame.type === "session/projection" && p.frame.key === "permissions");
  check("permissions 载荷是 {options, currentValue}", Array.isArray(perms?.frame.value?.options) && typeof perms?.frame.value?.currentValue === "string");

  // --- workspace/follow baseline ---
  const wsBaseline = itemsOf("workspace/follow").find((v) => v?.type === "baseline");
  check("workspace/follow 开局帧是 baseline", wsBaseline !== undefined);
  const wp = frames.projectWorkspaceBaseline(wsBaseline.value);
  check(`工作区行数 ${wp.items.length} 与服务端一致`, wp.items.length === (wsBaseline.value.items ?? []).length);
  check("归档集合非空(本机确有归档会话)", wp.archivedSessionIds.length > 0, `实得 ${wp.archivedSessionIds.length}`);
  check(
    "每行都有 workspaceId/path/title/sessionIds",
    wp.items.every((w) => typeof w.workspaceId === "string" && typeof w.path === "string" && typeof w.title === "string" && Array.isArray(w.sessionIds)),
  );
  // 归一化不能丢字段:侧边栏读的就是原始行。
  const rawFirst = wsBaseline.value.items[0];
  const normFirst = wp.items[0];
  check(
    "归一化不丢原字段(createdAt/updatedAt 原样保留)",
    normFirst.createdAt === rawFirst.createdAt && normFirst.updatedAt === rawFirst.updatedAt,
  );
  check("归一化不新增字段", Object.keys(normFirst).sort().join(",") === Object.keys({ ...rawFirst, ...normFirst }).sort().join(","));

  // --- $events emit:真实流量 ---
  const emits = itemsOf("$events").filter((v) => v?.type === "emit");
  check(`$events 里录到 ${emits.length} 条 emit`, emits.length > 0);
  const realEvents = [...new Set(emits.map((e) => e.event))];
  console.log(`     真实 emit 事件: ${realEvents.join(", ")}`);
  // 录到的真实事件里,凡是白名单外的都必须被安静忽略(前向兼容的关键)。
  // 逐条打印会刷 200 行同样的 OK,所以聚合成一条:任何一条抛异常都要看得见。
  const emitFailures = [];
  for (const e of emits) {
    try {
      frames.projectEmit(e.event, e.args, () => "rpc");
    } catch (error) {
      emitFailures.push(`${e.event}: ${error && error.message}`);
    }
  }
  check(`全部 ${emits.length} 条真实 emit 都不抛异常`, emitFailures.length === 0, emitFailures.slice(0, 3).join("; "));

  // --- $events waterfall:用**录制到的**那条真审批驱动翻译层 ---
  const realWaterfall = itemsOf("$events").find((v) => v?.type === "waterfall");
  if (realWaterfall === undefined) {
    skipped("真实 approval waterfall", "录制窗口内没触发审批 —— 用 `record-mux.ts --trigger` 重录");
  } else {
    console.log(`     真实 waterfall: ${realWaterfall.event}（toolName=${realWaterfall.request?.toolName}）`);
    const projectedReal = frames.projectWaterfall(
      realWaterfall.event,
      realWaterfall.eventId,
      realWaterfall.agentId,
      realWaterfall.request,
      () => "unused",
    );
    check(`录制的 ${realWaterfall.event} 能翻译出帧`, projectedReal !== undefined);
    check("翻译出的帧类型与事件对应", projectedReal?.frame.type === "approval/requested");
    // eventId 双用:store 按 approvalId 索引、把 envelope 的 rpcId 另存起来,
    // 两者同值才能原样答回去。用真帧钉住,而不是用我手写的样例。
    check("真实帧的 approvalId == rpcId == eventId", projectedReal?.frame.approvalId === realWaterfall.eventId && projectedReal?.rpcId === realWaterfall.eventId);
    check("真实帧的 sessionId 取的是 agentId", projectedReal?.frame.sessionId === realWaterfall.agentId);
    check("真实帧带上了 toolName", projectedReal?.frame.toolName === realWaterfall.request?.toolName);
    // 网关会剥掉 agent/signal(projectRemoteEventRequest),别把它们当字段用。
    check("真实 request 里没有 agent/signal 残留到帧上", !("agent" in (projectedReal?.frame ?? {})) && !("signal" in (projectedReal?.frame ?? {})));
  }

  // --- $events emit 的会话生命周期:同样用录制到的真帧 ---
  const realAdded = emits.find((e) => e.event === "api-session/added");
  if (realAdded === undefined) {
    skipped("真实 api-session/added", "录制窗口内没有会话创建");
  } else {
    const addedFrame = frames.projectEmit("api-session/added", realAdded.args, () => "rpc");
    check("录制的 api-session/added ⇒ host/session-added", addedFrame?.frame.type === "host/session-added");
    check(
      "session-added 的 sessionId 与载荷一致",
      addedFrame?.frame.sessionId === realAdded.args?.[0]?.sessionId,
      `帧 ${addedFrame?.frame.sessionId} vs 载荷 ${realAdded.args?.[0]?.sessionId}`,
    );
  }
  const realStatus = emits.find((e) => e.event === "api-session/status");
  if (realStatus !== undefined) {
    const statusFrame = frames.projectEmit("api-session/status", realStatus.args, () => "rpc");
    check("录制的 api-session/status ⇒ host/session-status", statusFrame?.frame.type === "host/session-status");
    check("status 的 running 是布尔", typeof statusFrame?.frame.running === "boolean");
  }

  // --- session/control 的**增量**(baseline 之外):队列与投影的实时更新 ---
  const controlItems = itemsOf("session/control").filter((v) => v?.type !== "baseline");
  if (controlItems.length === 0) {
    skipped("session/control 增量", "录制窗口内没有队列/投影变化");
  } else {
    const kinds = [...new Set(controlItems.map((i) => i.type))];
    console.log(`     session/control 增量: ${controlItems.length} 条 [${kinds.join(", ")}]`);
    // 每条增量都要能翻成**恰好一帧**(扇出只发生在 baseline),而且类型/sessionId 都对。
    // 逐条打印会刷一百多行,所以聚合成三条断言,失败时把前几条不匹配的列出来。
    const wrongCount = [];
    const wrongType = [];
    const wrongSession = [];
    for (const item of controlItems) {
      const out = frames.projectControl(item, () => "rpc");
      if (out.length !== 1 || out[0]?.channel !== "mux") wrongCount.push(`${item.type}→${out.length}`);
      else if (out[0].frame.type !== "session/" + item.type) wrongType.push(`${item.type}→${out[0].frame.type}`);
      else if (out[0].frame.sessionId !== item.sessionId) wrongSession.push(item.type);
    }
    check(`全部 ${controlItems.length} 条增量都翻成恰好 1 帧(扇出只在 baseline)`, wrongCount.length === 0, wrongCount.slice(0, 3).join(", "));
    check("全部增量的帧类型与 item 类型对应", wrongType.length === 0, wrongType.slice(0, 3).join(", "));
    check("全部增量的 sessionId 原样透传", wrongSession.length === 0, wrongSession.slice(0, 3).join(", "));
    const projItem = controlItems.find((i) => i.type === "projection");
    if (projItem !== undefined) {
      const out = frames.projectControl(projItem, () => "rpc");
      check("projection 增量带 seq(界面靠它丢弃乱序的旧值)", Number.isInteger(out[0]?.frame.seq));
      check("projection 增量带 key", typeof out[0]?.frame.key === "string");
    }
  }

  // --- workspace/follow 的**增量**(录制时归档了一个会话,所以真有一条)---
  const wsItems = itemsOf("workspace/follow").filter((v) => v?.type !== "baseline");
  if (wsItems.length === 0) {
    skipped("workspace/follow 增量", "录制窗口内没有工作区变化");
  } else {
    for (const item of wsItems) {
      const out = frames.projectWorkspaceIncrement(item, () => "rpc");
      check(`workspace 增量 ${item.type} 有对应帧`, out !== undefined);
      if (item.type === "archived") {
        // 归档是「归档」这个动作唯一能让界面变化的路径 —— 没有 workspace/* 事件。
        check("归档增量 ⇒ host/archived-sessions-changed", out?.frame.type === "host/archived-sessions-changed");
        check(
          "归档集合与载荷一致",
          JSON.stringify(out?.frame.archivedSessionIds) === JSON.stringify(item.archivedSessionIds),
        );
      }
    }
  }

  // --- session/follow snapshot(S5 的输入形状)---
  const snapshot = itemsOf("session/follow").find((v) => v?.type === "snapshot");
  if (snapshot === undefined) {
    skipped("session/follow snapshot", "夹具里没有(录制时无会话可跟随)");
  } else {
    check("snapshot 带整数 cursor(历史分页的 throughSeq 来源)", Number.isInteger(snapshot.cursor));
    // throughSeq: -1 会返回空页 —— 白屏转录且无报错,所以这里显式钉住。
    check("snapshot.cursor 不是 -1", snapshot.cursor !== -1, `cursor=${snapshot.cursor}`);
    check("snapshot.records 是数组", Array.isArray(snapshot.records));
    check("snapshot 带 projections.values(要回放进 store)", typeof snapshot.projections?.values === "object");
    check(
      "snapshot 里每条 record 都带 event",
      (snapshot.records ?? []).every((r) => r && typeof r === "object" && "event" in r),
    );
  }
}

// ---------- 2. waterfall(审批 / 提问)—— 真机还没录到,用契约里的最小样例 ----------
console.log("\n=== 2. waterfall 合成 ===");
const EVENT_ID = "evt-1111";
const AGENT_ID = "session-abc";

const approval = frames.projectWaterfall(
  "approval/request",
  EVENT_ID,
  AGENT_ID,
  { agent: AGENT_ID, toolName: "bash", callId: "call-1", reason: "写工作区外", signal: "<stripped>" },
  () => "unused",
);
check("approval/request 产出 mux 帧", approval?.channel === "mux");
check("审批帧类型是 approval/requested", approval?.frame.type === "approval/requested");
// eventId 双用:store 按 approvalId 索引、另存 envelope 的 rpcId,两者同值才能原样答回去。
check("approvalId == rpcId == eventId", approval?.frame.approvalId === EVENT_ID && approval?.rpcId === EVENT_ID);
check("sessionId 取的是 agentId", approval?.frame.sessionId === AGENT_ID);
check("toolName / callId / reason 透传", approval?.frame.toolName === "bash" && approval?.frame.callId === "call-1" && approval?.frame.reason === "写工作区外");
check("agent/signal 没被带进帧(projectRemoteEventRequest 会剥掉)", !("agent" in approval.frame) && !("signal" in approval.frame));

const noTool = frames.projectWaterfall("approval/request", EVENT_ID, AGENT_ID, { agent: AGENT_ID }, () => "unused");
check("审批缺 toolName ⇒ 不产帧(宁可少发也不发半成品)", noTool === undefined);

const question = frames.projectWaterfall(
  "user-questions/request",
  EVENT_ID,
  AGENT_ID,
  { questions: [{ id: "q1", question: "选哪个?", header: "选择", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
  () => "unused",
);
check("user-questions/request 产出 mux 帧", question?.channel === "mux");
check("提问帧类型是 question/requested", question?.frame.type === "question/requested");
// 提问帧本体不带 id —— store 拿 envelope 的 rpcId 当 questionRpcId,所以 eventId 必须放 rpcId。
check("提问的 rpcId == eventId(帧本体没有 id 可用)", question?.rpcId === EVENT_ID);
check("questions 原样透传", question?.frame.questions?.[0]?.id === "q1" && question?.frame.questions?.[0]?.options?.length === 2);

check("未知 waterfall 事件 ⇒ 忽略(前向兼容)", frames.projectWaterfall("some/future-event", EVENT_ID, AGENT_ID, {}, () => "unused") === undefined);
check("questions 不是数组 ⇒ 不产帧", frames.projectWaterfall("user-questions/request", EVENT_ID, AGENT_ID, { questions: "nope" }, () => "unused") === undefined);
noThrow("request 为 null 不抛异常", () => frames.projectWaterfall("approval/request", EVENT_ID, AGENT_ID, null, () => "rpc"));

// ---------- 3. emit → 主机帧 ----------
console.log("\n=== 3. emit 合成 ===");
const added = frames.projectEmit("api-session/added", [{ sessionId: "s1", blank: false, cwd: "C:/x", origin: "subagent", parentSessionId: "p1" }], () => "r1");
check("api-session/added ⇒ host/session-added", added?.frame.type === "host/session-added" && added.frame.sessionId === "s1");
check("added 透传 cwd/origin/parentSessionId", added?.frame.cwd === "C:/x" && added?.frame.origin === "subagent" && added?.frame.parentSessionId === "p1");
// agentPreset 搬进了投影 —— 从 projection 里补,补不上就不留空键。
const addedPreset = frames.projectEmit("api-session/added", [{ sessionId: "s1", projections: { values: { agentPreset: "standard" } } }], () => "r1");
check("added 从 projecting.values.agentPreset 补预设", addedPreset?.frame.agentPreset === "standard");
const addedNoPreset = frames.projectEmit("api-session/added", [{ sessionId: "s1" }], () => "r1");
check("补不到预设时不留空键", !("agentPreset" in (addedNoPreset?.frame ?? {})));

check("api-session/removed ⇒ host/session-removed", frames.projectEmit("api-session/removed", ["s1"], () => "r").frame.sessionId === "s1");
check("api-session/status ⇒ host/session-status", frames.projectEmit("api-session/status", ["s1", true], () => "r").frame.running === true);
check("status 第二参不是布尔 ⇒ 不产帧", frames.projectEmit("api-session/status", ["s1", "yes"], () => "r") === undefined);
check("api-session/error ⇒ host/agent-error", frames.projectEmit("api-session/error", ["s1", "炸了"], () => "r").frame.message === "炸了");
check("error 缺 message ⇒ 兜底文案而不是 undefined", frames.projectEmit("api-session/error", ["s1"], () => "r").frame.message === "agent failed");
// activity 刻意不映射:它只是「列表排序该变了」,legacy 也没有对应帧。
check("api-session/activity 刻意不映射", frames.projectEmit("api-session/activity", ["s1"], () => "r") === undefined);
check("commands/change 不映射(它是纯噪声,真机每秒能来十几条)", frames.projectEmit("commands/change", [[]], () => "r") === undefined);

// ---------- 4. workspace 增量 ----------
console.log("\n=== 4. workspace 增量 ===");
const inc = (item) => frames.projectWorkspaceIncrement(item, () => "r");
check("upsert ⇒ host/workspace-changed", inc({ type: "upsert", workspace: { workspaceId: "w1", title: "t" } })?.frame.type === "host/workspace-changed");
check("upsert 缺 workspaceId ⇒ 不产帧", inc({ type: "upsert", workspace: { title: "t" } }) === undefined);
check("remove ⇒ host/workspace-removed", inc({ type: "remove", workspaceId: "w1" })?.frame.workspaceId === "w1");
check("order ⇒ host/workspace-order-changed", inc({ type: "order", workspaceIds: ["a", "b"] })?.frame.workspaceIds.join(",") === "a,b");
// 归档是「归档」这个动作唯一能让界面变化的路径(它不走 $events,没有 workspace/* 事件)。
check("archived ⇒ host/archived-sessions-changed", inc({ type: "archived", archivedSessionIds: ["s1", "s2"] })?.frame.archivedSessionIds.length === 2);
check("order 载荷不是字符串数组 ⇒ 空数组而不是崩", inc({ type: "order", workspaceIds: [1, 2] })?.frame.workspaceIds.length === 0);

// ---------- 5. 防御性:wire 上全是 unknown ----------
console.log("\n=== 5. 防御性 ===");
const junk = [null, undefined, 0, "", [], {}, { type: "baseline" }, { type: "upsert" }, { type: "projection" }];
for (const j of junk) {
  noThrow(`projectControl(${JSON.stringify(j)}) 不抛异常`, () => frames.projectControl(j, () => "r"));
  noThrow(`projectWorkspaceIncrement(${JSON.stringify(j)}) 不抛异常`, () => frames.projectWorkspaceIncrement(j, () => "r"));
  noThrow(`toWorkspaceRow(${JSON.stringify(j)}) 不抛异常`, () => frames.toWorkspaceRow(j));
}
check("toWorkspaceRow(null) ⇒ undefined", frames.toWorkspaceRow(null) === undefined);
check("toWorkspaceRow 无 workspaceId ⇒ undefined", frames.toWorkspaceRow({ path: "x" }) === undefined);
noThrow("projectWorkspaceBaseline(undefined) 不抛异常", () => frames.projectWorkspaceBaseline(undefined));
check("projectWorkspaceBaseline(undefined) ⇒ 空集", frames.projectWorkspaceBaseline(undefined).items.length === 0);

// ---------- 6. events.ts:跨代去重与结算(纯逻辑,用假 mux 驱动)----------
console.log("\n=== 6. $events 会话层(假 mux)===");

class FakeMux {
  constructor() {
    this.opens = [];
  }
  open(endpoint, args, handlers) {
    const rec = { endpoint, args, handlers, cancelled: false };
    this.opens.push(rec);
    return { streamId: "s" + this.opens.length, endpoint, cancel: () => { rec.cancelled = true; } };
  }
  last() {
    return this.opens[this.opens.length - 1];
  }
}

function makeSink() {
  let n = 0;
  return {
    muxFrames: [],
    hostFrames: [],
    sends: [],
    onMux(e) { this.muxFrames.push(e); },
    onHost(e) { this.hostFrames.push(e); },
    async send(clientId, eventId, outcome) { this.sends.push({ clientId, eventId, outcome }); },
    newRpcId: () => "rpc-" + ++n,
  };
}

async function main() {
  const fakeMux = new FakeMux();
  const sink = makeSink();
  const events = new eventsMod.RemoteEvents(fakeMux, sink);
  events.start();

  check("start() 打开 $events 且 args 为 {}", fakeMux.last().endpoint === "$events" && Object.keys(fakeMux.last().args).length === 0);
  // 没有 clientId 就答不了 —— 答什么都会被网关拒,所以要**抛**而不是静默失败。
  let threw = false;
  try {
    await events.answerApproval("e1", "allowed-once");
  } catch {
    threw = true;
  }
  check("没有 clientId 时回答会抛(而不是静默丢)", threw);
  check("没有 clientId == currentClientId 是 undefined", events.currentClientId === undefined);

  const gen1 = fakeMux.last();
  gen1.handlers.onItem({ type: "ready", clientId: "client-1", host: { home: "C:/u" } });
  check("ready 后拿到 clientId", events.currentClientId === "client-1");

  gen1.handlers.onItem({ type: "waterfall", event: "approval/request", eventId: "e1", agentId: "s1", request: { toolName: "bash" } });
  check("waterfall ⇒ 一张审批卡", sink.muxFrames.length === 1 && sink.muxFrames[0].frame.type === "approval/requested");
  check("卡片 rpcId == eventId", sink.muxFrames[0].rpcId === "e1");
  check("pending 记下了 e1", events.pendingEventIds.join(",") === "e1");

  gen1.handlers.onItem({ type: "waterfall", event: "approval/request", eventId: "e1", agentId: "s1", request: { toolName: "bash" } });
  check("同代重复投递被去重", sink.muxFrames.length === 1);

  // 流被结束:RemoteMux 会把这种流从登记表里摘掉(重连不会再补发),所以必须自己重开。
  gen1.handlers.onEnd();
  await new Promise((r) => setTimeout(r, 1200));
  const gen2 = fakeMux.last();
  check("流被结束后自己重开了(否则审批功能会静默死掉)", gen2 !== gen1 && gen2.endpoint === "$events");

  gen2.handlers.onItem({ type: "ready", clientId: "client-2", host: { home: "C:/u" } });
  check("重连后 clientId 换代", events.currentClientId === "client-2");

  // 服务端会把未结算的 waterfall 用**同一个 eventId** 重投一遍。
  gen2.handlers.onItem({ type: "waterfall", event: "approval/request", eventId: "e1", agentId: "s1", request: { toolName: "bash" } });
  check("**跨代重复 eventId 被去重**(否则两张卡,点哪张都是另一个已不存在)", sink.muxFrames.length === 1);

  const framesBeforeAnswer = sink.muxFrames.length;
  await events.answerApproval("e1", "allowed-once");
  check("回答用的是**当前代** clientId(缓存上一代的会被拒)", sink.sends[0]?.clientId === "client-2", `实得 ${sink.sends[0]?.clientId}`);
  check("回答载荷是 result/allowed-once", sink.sends[0]?.outcome?.kind === "result" && sink.sends[0]?.outcome?.value === "allowed-once");

  // 关键回归(真机上复现过):回答成功后必须**当场**撤卡。
  // 网关在结算前就把回答者摘出了投递集合(receiveRemoteEventResult 的第一件事),
  // 所以我答的那条**我自己收不到 cancel** —— 只等 cancel 的话卡片永不消失。
  const resolved = sink.muxFrames.filter((f) => f.frame.type === "approval/resolved").pop();
  check("回答成功后当场发 approval/resolved(不是等 cancel)", sink.muxFrames.length > framesBeforeAnswer && resolved !== undefined);
  check("终局是我发的 allowed-once", resolved?.frame.outcome === "allowed-once", `实得 ${resolved?.frame.outcome}`);
  check("结算帧的 rpcId == eventId", resolved?.rpcId === "e1");
  check("结算后 pending 清空(重投的那份不会变成第二张卡)", events.pendingEventIds.length === 0);

  // 服务端不会给我推「我答的」那条的 cancel;万一推了也必须是无害的 no-op。
  const afterAnswer = sink.muxFrames.length;
  gen2.handlers.onItem({ type: "cancel", eventId: "e1" });
  check("已结算的 eventId 再收 cancel 是 no-op(不二次撤卡)", sink.muxFrames.length === afterAnswer);

  // 没答过的:报 cancelled(fail-closed),不能假装成功。
  gen2.handlers.onItem({ type: "waterfall", event: "approval/request", eventId: "e2", agentId: "s1", request: { toolName: "write" } });
  gen2.handlers.onItem({ type: "cancel", eventId: "e2" });
  const resolved2 = sink.muxFrames.filter((f) => f.frame.type === "approval/resolved").pop();
  check("别处结算(我没答过)⇒ 报 cancelled", resolved2?.frame.outcome === "cancelled", `实得 ${resolved2?.frame.outcome}`);

  // 发送失败:必须**什么都不改** —— 卡片留着让用户重试,记录留着让重投被去重。
  const workingSend = sink.send.bind(sink);
  sink.send = async () => {
    throw new Error("网络断了");
  };
  gen2.handlers.onItem({ type: "waterfall", event: "approval/request", eventId: "e3", agentId: "s1", request: { toolName: "bash" } });
  const beforeFail = sink.muxFrames.length;
  let sendThrew = false;
  try {
    await events.answerApproval("e3", "allowed-once");
  } catch {
    sendThrew = true;
  }
  check("发送失败会抛(上层要能提示用户,而不是静默)", sendThrew);
  check("发送失败**不撤卡**(不能假装答成功)", sink.muxFrames.length === beforeFail);
  check("发送失败后 pending 保留(重投会被去重,卡片不变两张)", events.pendingEventIds.includes("e3"));
  sink.send = workingSend;

  // 提问走同一套,但终局取值不同。
  gen2.handlers.onItem({ type: "waterfall", event: "user-questions/request", eventId: "q1", agentId: "s1", request: { questions: [{ id: "x", question: "?" }] } });
  const qCard = sink.muxFrames.find((f) => f.frame.type === "question/requested");
  check("提问 waterfall ⇒ question/requested", qCard !== undefined && qCard.rpcId === "q1");
  const qBefore = sink.muxFrames.length;
  await events.answerQuestion("q1", { answers: [{ id: "x", selected: ["A"] }] });
  const qSend = sink.sends.find((s) => s.eventId === "q1");
  check("提问应答形状是 {answers:[{id,selected}]}", qSend?.outcome?.value?.answers?.[0]?.selected?.[0] === "A");
  const qResolved = sink.muxFrames.filter((f) => f.frame.type === "question/resolved").pop();
  check("回答提问成功后当场发 question/resolved", sink.muxFrames.length > qBefore && qResolved !== undefined);
  check("终局是 answered", qResolved?.frame.outcome === "answered");
  check("提问结算帧的 questionRpcId == eventId", qResolved?.frame.questionRpcId === "q1");

  // 真机噪声:commands/change 每秒能来十几条,一条都不该变成帧。
  const before = sink.muxFrames.length + sink.hostFrames.length;
  gen2.handlers.onItem({ type: "future-thing", payload: 1 });
  gen2.handlers.onItem({ type: "emit", event: "some/unknown", args: [] });
  gen2.handlers.onItem({ type: "emit", event: "commands/change", args: [[]] });
  check("陌生 item / 未知 emit 不产帧", sink.muxFrames.length + sink.hostFrames.length === before);

  events.stop();
  check("stop() 会取消底层流", gen2.cancelled === true);
  check("stop() 清空 pending", events.pendingEventIds.length === 0);

  console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}${skip ? `(跳过 ${skip} 项)` : ""}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("测试崩溃:", error);
  process.exit(1);
});
