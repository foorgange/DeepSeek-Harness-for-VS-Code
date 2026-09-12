// 形状表测试 —— 全案最易错处的防线。
// 用法: node tests/smoke/protocol-args.test.js
//
// 为什么值得单独测:0.1.5 的 gateway 对 args 做严格 exact-match,错了只报
// `gateway/arguments-invalid`,**不告诉你是哪个键错了**。所以这里把每个端点的
// 顶层键集钉死 —— 一旦实现和预期表不一致,或者实现里多塞了一个键,这里就红。
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));
const out = path.join(os.tmpdir(), "protocol-args-test-" + process.pid + ".cjs");
buildSync({
  entryPoints: [path.join(repo, "src/dsh/protocol/modern/args.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
});
const { args, ENDPOINTS, EXPECTED_KEYS } = require(out);

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "OK  " : "FAIL") + " " + name + (ok || !detail ? "" : "  → " + detail));
  if (!ok) fail++;
}
const keysOf = (o) => Object.keys(o).sort().join(",");
const expectKeys = (name, produced, expected) => {
  check(name, keysOf(produced) === [...expected].sort().join(","), `期望 [${expected}] 实得 [${keysOf(produced)}]`);
};

console.log("=== 形状表 · 顶层键集 ===");

// ---------- 会话域 ----------
// wire 名带下划线:写成 `request` 会 gateway/arguments-invalid
expectKeys("session/list 用的是 _request(带下划线)", args.sessionList(), ["_request"]);
expectKeys("session/create", args.sessionCreate({ cwd: "C:/x" }), ["request"]);
expectKeys("session/rename", args.sessionRename("s", "t"), ["request"]);
expectKeys("session/fork 不带 atSeq", args.sessionFork("s"), ["request"]);
expectKeys("session/fork 带 atSeq", args.sessionFork("s", 5), ["request"]);
check("session/fork 的 atSeq 传进去了", args.sessionFork("s", 5).request.atSeq === 5);
check("session/fork 不给 atSeq 时不留空键", !("atSeq" in args.sessionFork("s").request));
expectKeys("session/cancel", args.sessionCancel("s"), ["request"]);
expectKeys("session/selectModel 不带 effort", args.sessionSelectModel("s", "p", "m"), ["request"]);
check(
  "session/selectModel 不给 effort 时不留空键",
  !("reasoningEffort" in args.sessionSelectModel("s", "p", "m").request),
);
check("session/selectModel 给 effort 时带上", args.sessionSelectModel("s", "p", "m", "high").request.reasoningEffort === "high");
expectKeys("session/updateQueue", args.sessionUpdateQueue("s", "i", { kind: "remove" }), ["request"]);
expectKeys("session/prompt", args.sessionPrompt({ requestId: "r", sessionId: "s", mode: "queue", content: [] }), ["request"]);
expectKeys("session/page", args.sessionPage({ address: { kind: "session", sessionId: "s" }, throughSeq: 0 }), ["request"]);
expectKeys("session/follow", args.sessionFollow({ address: { kind: "session", sessionId: "s" } }), ["request"]);
// 零参端点也必须显式传 {} —— 省略 payload 会被拒
expectKeys("session/modelCatalog 是零参(但仍要发 {})", args.sessionModelCatalog(), []);

// ---------- 工作区 ----------
expectKeys("workspace/create", args.workspaceCreate("C:/x"), ["request"]);
expectKeys("workspace/archiveSession", args.workspaceArchiveSession("s"), ["request"]);

// ---------- 命令 / 技能 / 子代理 ----------
// 这条是移植清单点名的真 bug:漏了 submittedAttachments 会让 /checkpoints 直接死
expectKeys("commands/execute 三个键全必需", args.commandsExecute("a", "/checkpoints"), [
  "agentId",
  "line",
  "submittedAttachments",
]);
check(
  "commands/execute 默认补 submittedAttachments: []",
  Array.isArray(args.commandsExecute("a", "/x").submittedAttachments) &&
    args.commandsExecute("a", "/x").submittedAttachments.length === 0,
);
expectKeys("skills/list 包在 request 里", args.skillsList("s"), ["request"]);
check("skills/list 的 request 只有 sessionId", keysOf(args.skillsList("s").request) === "sessionId");
expectKeys("subagents/list 是裸参数(不包 request)", args.subagentsList("p"), ["parentSessionId"]);

// ---------- Agent 预设 ----------
expectKeys("agentPresets/list 零参", args.agentPresetsList(), []);
expectKeys("agentPresets/select 用 agentId 而不是 sessionId", args.agentPresetsSelect("s", "p"), [
  "agentId",
  "agentPreset",
]);
// 线上签名是 (from, id, name?) —— 与 legacy 的 (id) 不同,这里钉死顺序
expectKeys("agentPresets/copy 用 from/id", args.agentPresetsCopy("a", "b"), ["from", "id"]);
check("agentPresets/copy 的 from 是第一个参数", args.agentPresetsCopy("a", "b").from === "a");
check("agentPresets/copy 不给 name 时不留空键", !("name" in args.agentPresetsCopy("a", "b")));
check("agentPresets/copy 给了 name 就带上", args.agentPresetsCopy("a", "b", "n").name === "n");
expectKeys("agentPresets/deletePreset 只收 id", args.agentPresetsDelete("p"), ["id"]);

// ---------- 设置 ----------
expectKeys("settings/describe 零参", args.settingsDescribe(), []);
// expectedRevision 没有 optional 标记,必须显式出现(undefined = 无条件写入)
expectKeys("settings/update 三个键都要有", args.settingsUpdate("ns", {}), ["ns", "patch", "expectedRevision"]);
check(
  "settings/update 的 expectedRevision 是 undefined(无条件写入,与 legacy 语义一致)",
  "expectedRevision" in args.settingsUpdate("ns", {}) && args.settingsUpdate("ns", {}).expectedRevision === undefined,
);

// ---------- LLM ----------
expectKeys("llm/listConfigurableProviders 零参", args.llmListConfiguredProviders(), []);

// ---------- 凭据 ----------
expectKeys("credentials/describe", args.credentialsDescribe(["a"]), ["refs"]);
expectKeys("credentials/set", args.credentialsSet("r", "v"), ["ref", "value"]);
expectKeys("credentials/unset", args.credentialsUnset("r"), ["ref"]);

// ---------- 目标 ----------
expectKeys("goals/get 只收 agentId", args.goalGet("a"), ["agentId"]);
expectKeys("goals/create", args.goalCreate("a", "obj"), ["agentId", "request"]);
expectKeys("goals/edit 带 request", args.goalEdit("a", { id: "g", revision: 1 }, "obj"), ["agentId", "ref", "request"]);
expectKeys("goals/resume", args.goalResume("a", { id: "g", revision: 1 }), ["agentId", "ref"]);
expectKeys("goals/pause", args.goalPause("a", { id: "g", revision: 1 }), ["agentId", "ref"]);
expectKeys("goals/complete", args.goalComplete("a", { id: "g", revision: 1 }), ["agentId", "ref"]);
expectKeys("goals/clear", args.goalClear("a", { id: "g", revision: 1 }), ["agentId", "ref"]);

// ---------- waterfall 应答 ----------
expectKeys("$events/result", args.eventsResult("c", "e", "allowed-once"), ["clientId", "eventId", "outcome"]);

// ---------- 表自身的一致性 ----------
console.log("\n=== 表自身的一致性 ===");
const endpointNames = Object.values(ENDPOINTS);
check("ENDPOINTS 无重复 endpoint 名", new Set(endpointNames).size === endpointNames.length);
for (const [ep, expected] of Object.entries(EXPECTED_KEYS)) {
  check(`EXPECTED_KEYS 覆盖的 ${ep} 在 ENDPOINTS 里存在`, endpointNames.includes(ep));
}
const missing = endpointNames.filter((e) => !(e in EXPECTED_KEYS));
check("每个 ENDPOINTS 都在 EXPECTED_KEYS 里有期望", missing.length === 0, `缺: ${missing.join(", ")}`);

// 交叉校验:用 EXPECTED_KEYS 反过来检查实现 —— 这才是这张表的意义
console.log("\n=== 实现 × 期望 交叉校验 ===");
const CASES = [
  ["session/list", () => args.sessionList()],
  ["session/create", () => args.sessionCreate({})],
  ["session/rename", () => args.sessionRename("s", "t")],
  ["session/fork", () => args.sessionFork("s")],
  ["session/cancel", () => args.sessionCancel("s")],
  ["session/selectModel", () => args.sessionSelectModel("s", "p", "m")],
  ["session/updateQueue", () => args.sessionUpdateQueue("s", "i", { kind: "remove" })],
  ["session/prompt", () => args.sessionPrompt({ requestId: "r", sessionId: "s", mode: "queue", content: [] })],
  ["session/page", () => args.sessionPage({ address: { kind: "session", sessionId: "s" }, throughSeq: 0 })],
  ["session/follow", () => args.sessionFollow({ address: { kind: "session", sessionId: "s" } })],
  ["session/modelCatalog", () => args.sessionModelCatalog()],
  ["workspace/create", () => args.workspaceCreate("C:/x")],
  ["workspace/archiveSession", () => args.workspaceArchiveSession("s")],
  ["commands/execute", () => args.commandsExecute("a", "/x")],
  ["skills/list", () => args.skillsList("s")],
  ["subagents/list", () => args.subagentsList("p")],
  ["agentPresets/list", () => args.agentPresetsList()],
  ["agentPresets/select", () => args.agentPresetsSelect("s", "p")],
  ["agentPresets/copy", () => args.agentPresetsCopy("a", "b")],
  ["agentPresets/deletePreset", () => args.agentPresetsDelete("p")],
  ["settings/describe", () => args.settingsDescribe()],
  ["settings/update", () => args.settingsUpdate("ns", {})],
  ["llm/listConfigurableProviders", () => args.llmListConfiguredProviders()],
  ["credentials/describe", () => args.credentialsDescribe([])],
  ["credentials/set", () => args.credentialsSet("r", "v")],
  ["credentials/unset", () => args.credentialsUnset("r")],
  ["goals/get", () => args.goalGet("a")],
  ["goals/create", () => args.goalCreate("a", "o")],
  ["goals/edit", () => args.goalEdit("a", { id: "g", revision: 1 })],
  ["goals/resume", () => args.goalResume("a", { id: "g", revision: 1 })],
  ["goals/pause", () => args.goalPause("a", { id: "g", revision: 1 })],
  ["goals/complete", () => args.goalComplete("a", { id: "g", revision: 1 })],
  ["goals/clear", () => args.goalClear("a", { id: "g", revision: 1 })],
  ["$events/result", () => args.eventsResult("c", "e", "allowed-once")],
];
check("交叉校验用例数与 ENDPOINTS 一致", CASES.length === endpointNames.length, `${CASES.length} vs ${endpointNames.length}`);
for (const [ep, produce] of CASES) {
  expectKeys(`${ep} 实现 == EXPECTED_KEYS`, produce(), EXPECTED_KEYS[ep] ?? []);
}

console.log(`\n${fail === 0 ? "全部通过" : fail + " 项失败"}\n`);
process.exit(fail === 0 ? 0 : 1);
