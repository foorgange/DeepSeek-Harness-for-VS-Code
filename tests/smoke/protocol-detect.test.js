// 协议探测的离线单测 —— 路由决策是全案第一道关。
//
// 为什么必须有:探测判错的后果是**整个扩展连到一个对面根本不存在的传输上**,而症状
// 只是「面板全空、处处 404」,看不出根因。detect.ts 里的 `probe` 注入缝隙本来就是
// 为这个留的(见 DetectOptions.probe 的注释),之前一直没有测试用它。
//
// 判据全是「状态码说明了什么」,所以这里用假 probe 把每种组合钉死,不碰真机。
// 真机实测基线(0.1.5-rc.1,2026-09-13 复核):
//   带有效 Cookie   → 点号路由 404 / 斜杠路由 200 / 不存在的路由 404
//   不带 Cookie     → **一切** 401(门禁在路由之前,连不存在的路由也回 401)
//   业务错误        → HTTP 200 + 错误信封(所以探针对参数形状变化免疫)
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));

function bundle(entry, tag) {
  const out = path.join(os.tmpdir(), `${tag}-${process.pid}.cjs`);
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

const { detectProtocol } = bundle("src/dsh/protocol/detect.ts", "protocol-detect-test");
const { ENDPOINTS } = bundle("src/dsh/protocol/modern/args.ts", "protocol-detect-args");

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "OK  " : "FAIL") + " " + name + (ok || !detail ? "" : "  → " + detail));
  if (!ok) fail++;
}

const LEGACY = "host.describe";
/** modern 候选探针 —— 顺序即 detect.ts 里的优先级。 */
const MODERN = ["session/modelCatalog", "session/list", "settings/describe", "agentPresets/list"];

/**
 * 假服务端:`table` 里没列的端点一律 404(与真机一致 —— 0.1.5 对不认识的路径就是 404)。
 * 返回的 `calls` 记录探针**按什么顺序**问了哪些端点。
 */
function fakeServer(table, opts = {}) {
  const calls = [];
  const probe = async (endpoint) => {
    calls.push(endpoint);
    if (opts.throwOn && opts.throwOn.includes(endpoint)) throw new Error("connect ECONNREFUSED");
    const status = table[endpoint] ?? 404;
    return { status, json: opts.json === undefined ? status === 200 : opts.json };
  };
  return { probe, calls };
}

/** 把 fakeServer 的结果接进 detectProtocol。 */
const detect = (server, baseUrl = "http://127.0.0.1:3080") =>
  detectProtocol({ baseUrl, probe: server.probe, timeoutMs: 50 });

(async () => {
  console.log("=== 协议探测 · 判定表 ===");

  // ---------- 1. 两个世代的 happy path ----------
  {
    const s = fakeServer({ [LEGACY]: 200 });
    const r = await detect(s);
    check("legacy 探针 200 ⇒ legacy", r.kind === "legacy", `实得 ${r.kind}: ${r.reason}`);
    check("  └ 判 legacy 时不再打 modern 探针(省一次往返)", s.calls.length === 1, `calls=${s.calls.join(",")}`);
  }
  {
    const s = fakeServer({ [LEGACY]: 404, [MODERN[0]]: 200 });
    const r = await detect(s);
    check("legacy 404 + modelCatalog 200 ⇒ modern", r.kind === "modern", `实得 ${r.kind}: ${r.reason}`);
    check("  └ 首条 modern 命中即停", s.calls.length === 2, `calls=${s.calls.join(",")}`);
  }
  {
    const s = fakeServer({ [LEGACY]: 401, [MODERN[0]]: 200 });
    const r = await detect(s);
    check("legacy 401 + modelCatalog 200 ⇒ modern(鉴权指纹)", r.kind === "modern", `实得 ${r.kind}`);
    check("  └ 判据里写明是 401 拦下的", r.reason.includes("401"), r.reason);
  }

  // ---------- 2. 本次修复的核心:单个端点改名不该把现代服务端打回 legacy ----------
  // 修复前 MODERN_PROBE 只有 session/modelCatalog 一条,它在未来版本被改名 ⇒ unknown
  // ⇒ 回落 legacy ⇒ 现代服务端拿到 legacy 客户端,全线 404。
  {
    const s = fakeServer({ [LEGACY]: 404, [MODERN[1]]: 200 }); // modelCatalog 也不在了
    const r = await detect(s);
    check("modelCatalog 被改名、session/list 还在 ⇒ 仍判 modern", r.kind === "modern", `实得 ${r.kind}: ${r.reason}`);
    check("  └ 确实试到了第二条候选", s.calls.includes(MODERN[1]), `calls=${s.calls.join(",")}`);
  }
  {
    const s = fakeServer({ [LEGACY]: 404, [MODERN[3]]: 200 }); // 只剩最后一条
    const r = await detect(s);
    check("只剩最后一条候选还在 ⇒ 仍判 modern", r.kind === "modern", `实得 ${r.kind}: ${r.reason}`);
  }

  // ---------- 3. 保守方向:拿不准一律 unknown,绝不猜 modern ----------
  {
    const s = fakeServer({ [LEGACY]: 404 });
    const r = await detect(s);
    check("legacy 404 + modern 全 404 ⇒ unknown(不猜)", r.kind === "unknown", `实得 ${r.kind}`);
    check("  └ 每条候选都试过了", s.calls.length === 1 + MODERN.length, `calls=${s.calls.join(",")}`);
    check("  └ unknown 的判据里列出了试过哪些端点(排障用)",
      MODERN.every((e) => r.reason.includes(e)), r.reason);
  }
  {
    const s = fakeServer({ [LEGACY]: 401, ...Object.fromEntries(MODERN.map((e) => [e, 401])) });
    const r = await detect(s);
    check("全 401 ⇒ unknown(是没凭据,不是协议不对)", r.kind === "unknown", `实得 ${r.kind}`);
    check("  └ 首个 modern 也 401 就短路,不再空跑剩下三条",
      s.calls.length === 2, `calls=${s.calls.join(",")}`);
  }
  {
    // 门禁只盖了一部分路由的怪状态:不该判 legacy,也不该误报凭据问题
    const s = fakeServer({ [LEGACY]: 401 });
    const r = await detect(s);
    check("legacy 401 + modern 全 404 ⇒ unknown(不判 legacy)", r.kind === "unknown", `实得 ${r.kind}`);
  }
  {
    const s = fakeServer({}, { json: false }); // 全都 404,且响应体不是 JSON
    const r = await detect(s);
    check("响应非 JSON 且非 200 ⇒ unknown", r.kind === "unknown", `实得 ${r.kind}`);
  }

  // ---------- 4. 服务端不可达 ----------
  {
    const s = fakeServer({}, { throwOn: [LEGACY] });
    const r = await detect(s);
    check("legacy 探针抛错(服务端没起)⇒ unknown", r.kind === "unknown", `实得 ${r.kind}`);
    check("  └ 判据写明是「不可达」而不是「协议未知」", r.reason.includes("不可达"), r.reason);
  }
  {
    // legacy 探针正常回 404,随后第一条 modern 探针抛错 —— 这才是「中途炸」那条路径
    const s = fakeServer({ [LEGACY]: 404 }, { throwOn: [MODERN[0]] });
    const r = await detect(s);
    check("modern 探针中途抛错 ⇒ unknown", r.kind === "unknown", `实得 ${r.kind}`);
    check("  └ 判据里点名是哪条探针炸的", r.reason.includes(MODERN[0]), r.reason);
  }

  // ---------- 5. 契约与守卫 ----------
  {
    const s = fakeServer({ [LEGACY]: 404, [MODERN[0]]: 200 });
    const r = await detect(s);
    check("返回值只有 {kind, reason}", Object.keys(r).sort().join(",") === "kind,reason", Object.keys(r).join(","));
  }
  {
    // 探针必须问真实存在的 modern 端点 —— 否则加进来的候选永远 404,等于没加。
    // 与 args.ts 的权威端点表交叉验证,防止有人拍脑袋写一个不存在的路由。
    const s = fakeServer({});
    await detect(s);
    const modernUsed = s.calls.filter((e) => e !== LEGACY);
    const bogus = modernUsed.filter((e) => !Object.values(ENDPOINTS).includes(e));
    check(`modern 候选都是 args.ts 里的真实端点(${modernUsed.length} 条)`, bogus.length === 0, `不存在的:${bogus.join(",")}`);
  }
  {
    // 守卫:本次修复的意义就是不再单点。谁把它删回一条,这条要红。
    const s = fakeServer({});
    await detect(s);
    const count = s.calls.filter((e) => e !== LEGACY).length;
    check(`modern 候选不止一条(实为 ${count} 条)—— 单端点会把世代判定压成一个名字`, count >= 3, `实得 ${count}`);
  }

  console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
