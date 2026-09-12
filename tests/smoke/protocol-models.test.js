// 模型/预设合成测试 —— 用**录制的真实控制流 baseline** 驱动 models.ts,再把 ModernApiClient
// 的 modelCatalog / sessionModels / selectModel / listSessions 用桩 fetch 跑一遍。
// 用法: node tests/smoke/protocol-models.test.js
//
// 这一层压的是 S6 的两处「错了不报错,只表现为界面少东西」的逻辑:
//   · `current` 的三级回退 —— 拿不到会话投影时要退回目录默认值,而不是编一个空串;
//   · `selectModel` 之后的**乐观更新** —— `hub.updateCurrentModel()` 紧接着就重读,
//     少了这一步的表现是「切了模型,状态栏过一会儿才变」。
//
// 夹具是真的(`tests/fixtures/mux-s4.json` 的 session/control 流),所以断言里的
// 「18 个键里有 agentPreset 与 modelSelection」「5 个会话里 4 个 next 非空」这些话
// 都是可核对的实测事实,不是我以为的形状。
//
// 一处**刻意的越界**:喂缓存走的是 `client.projections.note(...)`(TS 的 private 在
// 运行时就是个普通字段)。走 `setFrameHandlers` 才能用上真接缝,但那会 `ensureStreams()`
// 去连真 socket —— 冒烟测试不该依赖、更不该去碰本机正在跑的服务端。所以:
// 接线由 `tools/probe-models.ts`(真机)兜,这里只兜逻辑。
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

const modelsMod = bundle("src/dsh/protocol/modern/models.ts", "models-test");
const framesMod = bundle("src/dsh/protocol/modern/frames.ts", "frames-models-test");
const clientMod = bundle("src/dsh/protocol/modern/index.ts", "client-models-test");

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
const show = (v) => JSON.stringify(v);

// ---------- 夹具 ----------
const fixturePath = path.join(repo, "tests", "fixtures", "mux-s4.json");
const fixture = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : undefined;

/** 控制流的原始 items,`repeat` 展开。 */
function controlItems() {
  const stream = fixture?.streams?.find((s) => s.endpoint === "session/control");
  const out = [];
  for (const item of stream?.items ?? []) {
    for (let i = 0; i < (item.repeat ?? 1); i++) out.push(item.value);
  }
  return out;
}

/** 把录制帧喂给缓存 —— 走的是**真管线**:原始 item → projectControl → MuxFrame → note。 */
function feedRecorded(projections) {
  let n = 0;
  for (const item of controlItems()) {
    for (const projected of framesMod.projectControl(item, () => "rpc-" + ++n)) {
      if (projected.channel === "mux") projections.note(projected.frame);
    }
  }
  return n;
}

// ---------- 1. toSelection:认不出就是 undefined,绝不编 ----------
console.log("== 1. toSelection 的守卫 ==");
{
  const t = modelsMod.toSelection;
  check("完整选择原样通过", show(t({ provider: "p", model: "m", reasoningEffort: "high" })) === '{"provider":"p","model":"m","reasoningEffort":"high"}');
  check("没有思考深度就不带那个键", !("reasoningEffort" in t({ provider: "p", model: "m" })), show(t({ provider: "p", model: "m" })));
  check("思考深度是空串也当没有", !("reasoningEffort" in t({ provider: "p", model: "m", reasoningEffort: "" })));
  check("思考深度不是字符串也不带", !("reasoningEffort" in t({ provider: "p", model: "m", reasoningEffort: 3 })));
  check("空 provider 拒掉", t({ provider: "", model: "m" }) === undefined);
  check("空 model 拒掉", t({ provider: "p", model: "" }) === undefined);
  check("缺 model 拒掉", t({ provider: "p" }) === undefined);
  check("null 拒掉", t(null) === undefined);
  check("数组拒掉(它也是 object)", t([]) === undefined);
  check("字符串拒掉", t("p/m") === undefined);
  check("undefined 拒掉", t(undefined) === undefined);
}

// ---------- 2. synthesizeModels:三级回退与透传 ----------
console.log("\n== 2. 合成 SessionModelsValue ==");
{
  const catalog = {
    default: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
    routableProviders: ["deepseek-official"],
    groups: [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          { id: "deepseek-flash", name: "Flash", reasoning: { efforts: [{ id: "low", name: "low" }, { id: "high", name: "high" }], defaultEffort: "high" } },
        ],
      },
    ],
    failures: [{ id: "x", name: "X", message: "boom" }],
  };
  const s = modelsMod.synthesizeModels;

  const chosen = s(catalog, { provider: "other", model: "m2" });
  check("有会话选择时用它(不理会目录默认)", chosen.current.provider === "other" && chosen.current.model === "m2", show(chosen.current));
  const dflt = s(catalog, undefined);
  check("没有会话选择时退回目录默认", dflt.current.provider === "deepseek-official" && dflt.current.model === "deepseek-flash", show(dflt.current));
  check("默认的思考深度也带出来", dflt.current.reasoningEffort === "high", show(dflt.current));
  check("groups 原样透传(同一个引用,不克隆)", dflt.groups === catalog.groups);
  check("failures 原样透传", dflt.failures === catalog.failures);
  check("思考深度菜单的数据源在(models[].reasoning.efforts)", dflt.groups[0].models[0].reasoning.efforts.length === 2);
  check("routable = 有可路由厂商", dflt.routable === true);

  const empty = s({ default: undefined, routableProviders: [], groups: undefined, failures: null }, undefined);
  check("目录残缺也不抛错,current 给空壳", empty.current.provider === "" && empty.current.model === "", show(empty.current));
  check("groups 不是数组 → 空数组(不是 undefined)", Array.isArray(empty.groups) && empty.groups.length === 0);
  check("failures 不是数组 → 空数组", Array.isArray(empty.failures) && empty.failures.length === 0);
  check("没有可路由厂商 → routable=false", empty.routable === false);
  check("整个目录都没有也不抛错", (() => { try { s(undefined, undefined); return true; } catch { return false; } })());

  const noRoute = s({ default: { provider: "p", model: "m" }, routableProviders: undefined, groups: [], failures: [] }, undefined);
  check("routableProviders 缺失 → false(而不是抛错)", noRoute.routable === false);
}

// ---------- 3. 缓存:拿录制的真 baseline 喂 ----------
console.log("\n== 3. SessionProjections(真控制流 baseline)==");
const cached = new modelsMod.SessionProjections();
if (fixture === undefined) {
  skipped("录制帧驱动的缓存断言", "没有 tests/fixtures/mux-s4.json");
} else {
  const frames = feedRecorded(cached);
  check("projectControl 产出了帧", frames > 0, `${frames} 帧`);

  const baseline = controlItems().find((i) => i?.type === "baseline")?.value;
  const sources = Object.entries(baseline?.projections ?? {});
  check("baseline 带了全部会话的投影(夹具事实)", sources.length >= 5, `${sources.length} 个会话`);

  let presetsOk = 0;
  let selectionsOk = 0;
  let nextNonNull = 0;
  let mismatch = undefined;
  for (const [sessionId, snapshot] of sources) {
    const values = snapshot?.values ?? {};
    const gotPreset = cached.agentPresetOf(sessionId);
    if (gotPreset === values.agentPreset) presetsOk++;
    else mismatch = mismatch ?? `agentPreset ${sessionId}: ${show(gotPreset)} vs ${show(values.agentPreset)}`;

    const expected = values.modelSelection?.next ?? values.modelSelection?.lastUsed;
    const got = cached.selectionOf(sessionId);
    if (expected === undefined || expected === null) {
      if (got === undefined) selectionsOk++;
      else mismatch = mismatch ?? `modelSelection ${sessionId} 该是 undefined,却是 ${show(got)}`;
    } else {
      if (got?.provider === expected.provider && got?.model === expected.model && got?.reasoningEffort === expected.reasoningEffort) selectionsOk++;
      else mismatch = mismatch ?? `modelSelection ${sessionId}: ${show(got)} vs ${show(expected)}`;
    }
    if (values.modelSelection?.next != null) nextNonNull++;
  }
  check("每个会话的 agentPreset 都记下了", presetsOk === sources.length, `${presetsOk}/${sources.length} ${mismatch ?? ""}`);
  check("每个会话的模型选择都记下了(next ?? lastUsed)", selectionsOk === sources.length, `${selectionsOk}/${sources.length} ${mismatch ?? ""}`);
  // 这一条是给上面两条**防呆**用的:如果夹具里根本没有非空的选择,那两条就是空转。
  check("夹具里确实有非空的模型选择(否则上一条是空转)", nextNonNull > 0, `${nextNonNull}/${sources.length}`);
  check("缓存规模 = 有预设的会话数", cached.size === sources.length, `${cached.size} vs ${sources.length}`);

  const [firstId, firstSnapshot] = sources[0];
  const withEffort = cached.selectionOf(firstId);
  const expectedEffort = (firstSnapshot.values.modelSelection?.next ?? firstSnapshot.values.modelSelection?.lastUsed)?.reasoningEffort;
  check("reasoningEffort 跟着选择一起记下", withEffort?.reasoningEffort === expectedEffort, `${show(withEffort)} vs ${show(expectedEffort)}`);

  check("与模型无关的投影键不进缓存(title 不产生条目)", cached.agentPresetOf("(从没见过的会话)") === undefined);
}

// ---------- 4. 缓存的更新语义 ----------
console.log("\n== 4. 缓存的更新与乐观写 ==");
{
  const p = new modelsMod.SessionProjections();
  const proj = (key, value) => ({ type: "session/projection", sessionId: "s1", key, value, seq: 5 });

  p.note(proj("modelSelection", { lastUsed: { provider: "a", model: "m1" }, next: { provider: "a", model: "m1" } }));
  check("next 非空时取 next", p.selectionOf("s1")?.model === "m1", show(p.selectionOf("s1")));
  p.note(proj("modelSelection", { lastUsed: { provider: "a", model: "m0" }, next: null }));
  check("next 为空时回落到 lastUsed", p.selectionOf("s1")?.model === "m0", show(p.selectionOf("s1")));
  p.note(proj("modelSelection", { lastUsed: null, next: null }));
  check("两样都空 → 忘掉这个会话的选择(交给目录默认)", p.selectionOf("s1") === undefined, show(p.selectionOf("s1")));

  p.note(proj("modelSelection", { lastUsed: null, next: { provider: "a", model: "m2" } }));
  p.markSelected("s1", { provider: "b", model: "m3" });
  check("乐观值立刻可见", p.selectionOf("s1")?.model === "m3", show(p.selectionOf("s1")));
  p.note(proj("modelSelection", { lastUsed: null, next: { provider: "b", model: "m3", reasoningEffort: "low" } }));
  check("投影帧一到就让位(而不是永远压着)", p.selectionOf("s1")?.reasoningEffort === "low", show(p.selectionOf("s1")));

  p.note(proj("agentPreset", "standard"));
  check("预设记下了", p.agentPresetOf("s1") === "standard");
  p.note(proj("agentPreset", ""));
  check("空预设不覆盖已有值", p.agentPresetOf("s1") === "standard", show(p.agentPresetOf("s1")));
  p.note({ type: "host/session-removed", sessionId: "s1" });
  check("会话被删 → 键一起扔掉", p.agentPresetOf("s1") === undefined && p.selectionOf("s1") === undefined);

  // 对抗输入:不抛错,也不写脏值
  const junk = [
    undefined, null, 0, "x", [], {},
    { type: "session/projection" },
    { type: "session/projection", sessionId: "", key: "modelSelection", value: 1 },
    { type: "session/projection", sessionId: "s2", key: "modelSelection" },
    { type: "session/projection", sessionId: "s2", key: "modelSelection", value: "high" },
    { type: "session/projection", sessionId: "s2", key: "agentPreset", value: 42 },
    { type: "session/projection", sessionId: "s2", key: "todos", value: [{ content: "x" }] },
    { type: "host/session-removed" },
    { type: "session/event", sessionId: "s2", event: {} },
  ];
  let threw = undefined;
  for (const j of junk) {
    try { p.note(j); } catch (error) { threw = threw ?? `${show(j)} → ${String(error && error.message)}`; }
  }
  check("14 个畸形输入都不抛错", threw === undefined, threw);
  check("畸形输入没写进任何值", p.selectionOf("s2") === undefined && p.agentPresetOf("s2") === undefined);
}

// ---------- 5. 客户端:目录缓存 / 合成 / 乐观更新 / 预设回填 ----------
console.log("\n== 5. ModernApiClient 的接线(桩 fetch)==");
const realFetch = globalThis.fetch;
{
  const CATALOG = {
    default: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
    routableProviders: ["deepseek-official", "other"],
    groups: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "Flash" }] }],
    failures: [],
  };
  let calls = [];
  let catalogHits = 0;
  globalThis.fetch = async (url, options) => {
    const endpoint = String(url).replace(/^.*\/api\//, "");
    calls.push(endpoint);
    let value;
    if (endpoint === "session/modelCatalog") {
      catalogHits++;
      value = CATALOG;
    } else if (endpoint === "session/list") {
      value = {
        items: [
          // 顶层就带 preset 的(将来的 dsh 可能这么发)
          { sessionId: "s1", updatedAt: 1, running: false, blank: false, agentPreset: "from-list" },
          // 只有 list 的缓存投影里有
          { sessionId: "s2", updatedAt: 2, running: false, blank: false, projections: { asOfSeq: 3, values: { agentPreset: "from-projection" } } },
          // 两处都没有 → 只能靠控制流缓存(下面喂)
          { sessionId: "s3", updatedAt: 3, running: false, blank: false },
          // 哪儿都没有 → 不写这个键
          { sessionId: "s4", updatedAt: 4, running: false, blank: false },
        ],
      };
    } else if (endpoint === "session/selectModel") {
      const sent = JSON.parse(options.body).payload.args;
      value = { selected: { provider: sent.request.provider, model: sent.request.model, reasoningEffort: sent.request.reasoningEffort } };
    } else {
      throw new Error("桩 fetch 没准备这个端点: " + endpoint);
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ type: "server-response", rpcId: "r", result: { ok: true, value } }),
    };
  };

  const client = new clientMod.ModernApiClient("http://127.0.0.1:1", { auth: async () => undefined, onLog: () => {} });
  // 直接喂缓存(见文件头「刻意的越界」):s3 与 s5 的预设只有控制流知道。
  client.projections.note({ type: "session/projection", sessionId: "s3", key: "agentPreset", value: "from-control", seq: 9 });
  client.projections.note({ type: "session/projection", sessionId: "s5", key: "agentPreset", value: "from-control", seq: 9 });
  client.projections.note({ type: "session/projection", sessionId: "s5", key: "modelSelection", value: { lastUsed: null, next: { provider: "other", model: "m7" } }, seq: 9 });

  (async () => {
    // --- 合成 ---
    const s5 = await client.sessionModels("s5");
    check("sessionModels 用会话投影(不是目录默认)", s5.current.provider === "other" && s5.current.model === "m7", show(s5.current));
    const s4 = await client.sessionModels("s4");
    check("没有投影的会话退回目录默认", s4.current.provider === "deepseek-official" && s4.current.model === "deepseek-flash", show(s4.current));
    check("groups 来自目录", s4.groups.length === 1 && s4.groups[0].id === "deepseek-official");
    check("routable 来自目录", s4.routable === true);
    check("两次 sessionModels 只打了一次目录(在途去重 + TTL)", catalogHits === 1, `catalogHits=${catalogHits} calls=${calls.join(",")}`);

    // --- 乐观更新 ---
    const selected = await client.selectModel("s5", "deepseek-official", "deepseek-flash", "low");
    check("selectModel 回 {selected}(legacy 形状)", selected?.selected?.model === "deepseek-flash", show(selected));
    // hub.updateCurrentModel() 紧接着就会问这一句 —— 这是乐观更新存在的**唯一**理由。
    const after = await client.sessionModels("s5");
    check("切完模型立刻重读就是新值", after.current.model === "deepseek-flash" && after.current.reasoningEffort === "low", show(after.current));
    check("目录还是缓存的那份(没多打)", catalogHits === 1, `catalogHits=${catalogHits}`);

    // 投影帧到了 → 让位给服务端
    client.projections.note({ type: "session/projection", sessionId: "s5", key: "modelSelection", value: { lastUsed: null, next: { provider: "deepseek-official", model: "deepseek-flash" } }, seq: 20 });
    const settled = await client.sessionModels("s5");
    check("投影帧到达后以服务端为准(乐观值不粘住)", settled.current.reasoningEffort === undefined, show(settled.current));

    // --- 预设回填 ---
    const list = await client.listSessions();
    const byId = new Map(list.items.map((i) => [i.sessionId, i.agentPreset]));
    check("顶层带的 preset 原样保留", byId.get("s1") === "from-list", show(byId.get("s1")));
    check("list 的缓存投影优先于控制流缓存", byId.get("s2") === "from-projection", show(byId.get("s2")));
    check("两处都没有时用控制流缓存回填", byId.get("s3") === "from-control", show(byId.get("s3")));
    check("哪儿都没有就不写这个键(不是空串)", byId.get("s4") === undefined && !("agentPreset" in list.items[3]), show(list.items[3]));

    // --- 设置改动作废目录缓存 ---
    globalThis.fetch = async (url) => {
      const endpoint = String(url).replace(/^.*\/api\//, "");
      calls.push(endpoint);
      if (endpoint === "session/modelCatalog") {
        catalogHits++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ type: "server-response", rpcId: "r", result: { ok: true, value: CATALOG } }) };
      }
      if (endpoint === "settings/update") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ type: "server-response", rpcId: "r", result: { ok: true, value: { ns: "agent-default-model", revision: 2 } } }) };
      }
      throw new Error("桩 fetch 没准备这个端点: " + endpoint);
    };
    await client.settingsUpdate("agent-default-model", { model: "x" });
    await client.sessionModels("s4");
    check("settingsUpdate 之后目录重新拉一次", catalogHits === 2, `catalogHits=${catalogHits}`);

    // --- 错误路径:目录挂了要抛(而不是合成一个空目录) ---
    // 用一个**新客户端**:上面那台已经把目录缓存住了,拿它测会命中 TTL 缓存,
    // 测出来的是「缓存还能用」而不是「拿不到目录时会怎样」。
    const fresh = new clientMod.ModernApiClient("http://127.0.0.1:1", { auth: async () => undefined, onLog: () => {} });
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    let threw = undefined;
    try { await fresh.sessionModels("s4"); } catch (error) { threw = String(error && error.message); }
    check("目录取不到时 sessionModels 抛错(不静默给空目录)", typeof threw === "string" && threw.length > 0, show(threw));
    // 失败不缓存:服务端回来之后下一次就该成功(否则一次网络抖动会把模型菜单钉死)。
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ type: "server-response", rpcId: "r", result: { ok: true, value: CATALOG } }) });
    const recovered = await fresh.sessionModels("s4");
    check("一次失败不会被缓存住(下一次就好)", recovered.current.model === "deepseek-flash", show(recovered.current));

    globalThis.fetch = realFetch;
    console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}${skip > 0 ? `(跳过 ${skip})` : ""}`);
    process.exitCode = fail === 0 ? 0 : 1;
  })().catch((error) => {
    globalThis.fetch = realFetch;
    console.error("测试崩溃:", error);
    process.exitCode = 1;
  });
}
