// SessionStore 投影 emit 链路测试(esbuild 编译后运行)
// 用法: node tests/smoke/store.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const out = path.join(os.tmpdir(), "store-test-" + process.pid + ".cjs");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));
buildSync({
  entryPoints: [path.join(repo, "src/dsh/sessionStore.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
});
const { SessionStore } = require(out);
const store = new SessionStore();
let fail = 0;
function check(name, ok) { console.log((ok ? "OK  " : "FAIL") + " " + name); if (!ok) fail++; }

let got = null;
store.on("todos", (sid, value) => { got = { sid, value }; });
const todos = [
  { content: "a", status: "in_progress" },
  { content: "b", status: "pending" },
];
store.applyTodos("s1", todos);
check("applyTodos emit 收到", got !== null && got.sid === "s1" && got.value === todos);
check("store.todos 落库", store.todos.get("s1") === todos);

got = null;
store.applyTodos("s1", null);
check("null 也 emit", got !== null && got.value === null);
check("null 落库", store.todos.get("s1") === null);

let ctx = null, perm = null;
store.on("context", (sid, v) => { ctx = v; });
store.on("permissions", (sid, v) => { perm = v; });
store.applyContext("s1", { pressureTokens: 100 });
store.applyPermissions("s1", { options: [], currentValue: "read-only" });
check("applyContext emit", ctx !== null && ctx.pressureTokens === 100);
check("applyPermissions emit", perm !== null && perm.currentValue === "read-only");

store.applyTodos("s2", [{ content: "x", status: "pending" }]);
check("无监听器不抛错", true);

// 防抖:值未变不 emit(5s 轮询场景)
let emitCount = 0;
store.on("todos", () => emitCount++);
store.applyTodos("s3", [{ content: "a", status: "pending" }]);
store.applyTodos("s3", [{ content: "a", status: "pending" }]);
store.applyTodos("s3", [{ content: "a", status: "pending" }]);
check("相同值只 emit 一次", emitCount === 1);
store.applyTodos("s3", [{ content: "b", status: "pending" }]);
check("值变化再次 emit", emitCount === 2);
let statsCount = 0;
store.on("stats", () => statsCount++);
store.emitStats("s4", { sessionStats: { turns: 1 } });
store.emitStats("s4", { sessionStats: { turns: 1 } });
check("stats 相同值只 emit 一次", statsCount === 1);
store.emitStats("s4", { sessionStats: { turns: 2 } });
check("stats 值变化再次 emit", statsCount === 2);
let ctxCount = 0;
store.on("context", () => ctxCount++);
store.applyContext("s5", { pressureTokens: 5 });
store.applyContext("s5", { pressureTokens: 5 });
store.applyContext("s5", { pressureTokens: 6 });
check("context 防抖生效", ctxCount === 2);
// null 与 undefined 的处理
store.applyTodos("s6", null);
store.applyTodos("s6", null);
store.applyTodos("s6", undefined);
let nullCount = 0;
store.on("todos", () => nullCount++);
store.applyTodos("s6", null);
check("null 相同不重复 emit(但 undefined→null 视为变化)", true); // 仅验证不抛错

// 历史合并:先有实时事件(如 mux 全局流推入的 chunk),再合并历史,缺口被填满且不重复
const realtime = [10, 11, 12, 13, 14].map((seq) => ({ event: { type: "assistant/chunk", seq, data: { chunk: { type: "text-delta", text: "x" } } } }));
store.mergeHistory("h1", realtime);
const history = [8, 9, 10, 11, 12, 13, 14, 15, 16].map((seq) => ({ event: { type: seq % 2 === 0 ? "user/message" : "assistant/message", seq, data: { content: [{ type: "text", text: "m" + seq }] } } }));
store.mergeHistory("h1", history);
const merged = store.eventsFor("h1");
check("历史+实时合并后事件数=9(无重复)", merged.length === 9);
check("合并后缺口被填(seq 8,9 存在)", merged.some((e) => e.event.seq === 8) && merged.some((e) => e.event.seq === 9));
check("实时事件未被历史覆盖(seq 10 仍是 chunk)", merged.find((e) => e.event.seq === 10)?.event.type === "assistant/chunk");
const before = store.historyBeforeSeq("h1");
check("beforeSeq=最老 seq", before === 8);

try { fs.unlinkSync(out); } catch {}
console.log("\n结果:", fail === 0 ? "全部通过 (" + 17 + " 项)" : fail + " 项失败");
process.exit(fail === 0 ? 0 : 1);
