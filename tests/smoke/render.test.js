// webview 渲染冒烟测试:jsdom 加载 dist/webview/ui.js,注入消息,验证 DOM
// 用法: node tests/smoke/render.test.js [dist路径]
const fs = require("fs");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const distDir = process.argv[2] || path.join(repo, "dist");
const jsdomPath = path.join(repo, "node_modules", "jsdom");
const uiJs = fs.readFileSync(path.join(distDir, "webview", "ui.js"), "utf8");

const { JSDOM } = require(jsdomPath);
const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="app"></div></body></html>`, {
  url: "http://localhost/chat",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

let posted = [];
window.acquireVsCodeApi = () => ({
  postMessage: (m) => posted.push(m),
  getState: () => null,
  setState: () => {},
});
window.location.reload = () => {};

window.eval(uiJs);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function dispatch(kind, payload) {
  window.dispatchEvent(new window.MessageEvent("message", { data: { kind, ...payload } }));
}

async function main() {
  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); };

  dispatch("init", { mode: "tab", locked: true, lang: "zh-cn", status: { connected: true }, sessions: [], current: "s1", events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
  await wait(50);

  // todo 面板:1 完成 + 1 进行中 + 2 待处理
  dispatch("todos", { sessionId: "s1", value: [
    { content: "完成的任务", status: "completed" },
    { content: "进行中的任务", status: "in_progress" },
    { content: "待处理任务A", status: "pending" },
    { content: "待处理任务B", status: "pending" },
  ] });
  await wait(50);

  const panel = document.querySelector(".todo-panel");
  check("todo 面板可见", !!panel && !panel.hidden);
  const summaryText = panel ? panel.querySelector(".todo-panel-summary").textContent : "";
  check("摘要含任务标题", summaryText.includes("任务"));
  check("摘要 1 已完成", summaryText.includes("1 已完成"));
  check("摘要 1 进行中", summaryText.includes("1 进行中"));
  check("摘要 2 待处理", summaryText.includes("2 待处理"));
  const rows = document.querySelectorAll(".todo-row");
  check("todo 行数=4", rows.length === 4);
  check("完成行 done 类", !!document.querySelector(".todo-row.done"));
  check("进行中行 active 类", !!document.querySelector(".todo-row.active"));
  check("待处理行 pending 类 x2", document.querySelectorAll(".todo-row.pending").length === 2);
  check("完成行有 svg 图标", !!document.querySelector(".todo-row.done .todo-status svg"));
  check("有 chevron 图标", !!document.querySelector(".todo-panel-chevron svg"));

  dispatch("todos", { sessionId: "s1", value: [] });
  await wait(50);
  check("空列表隐藏面板", panel.hidden === true);
  dispatch("todos", { sessionId: "s1", value: null });
  await wait(50);
  check("null 隐藏面板", panel.hidden === true);

  dispatch("todos", { sessionId: "s1", value: [
    { content: "a", status: "completed" },
    { content: "b", status: "completed" },
  ] });
  await wait(50);
  const s2 = document.querySelector(".todo-panel-summary").textContent;
  check("全完成摘要只显示已完成段", s2.includes("2 已完成") && !s2.includes("进行中") && !s2.includes("待处理"));

  // init 带 queue 恢复排队消息
  dispatch("init", { mode: "tab", locked: true, lang: "zh-cn", status: { connected: true }, sessions: [], current: "s1", events: [], approvals: [], questions: [], running: true, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [
    { id: "q1", placement: "queued", message: { id: "m1", content: [{ type: "text", text: "排队消息一" }] } },
    { id: "q2", placement: "queued", message: { id: "m2", content: [{ type: "text", text: "排队消息二" }] } },
    { id: "q3", placement: "steering", message: { id: "m3", content: [{ type: "text", text: "转正中的不渲染" }] } },
  ] });
  await wait(50);
  const qRows = document.querySelectorAll(".msg-queued");
  check("init 恢复排队消息=2", qRows.length === 2);
  check("排队消息有插话按钮 x2", document.querySelectorAll(".btn-queued-steer").length === 2);
  check("steering 项不渲染", !Array.from(document.querySelectorAll(".msg-queued")).some((n) => n.textContent.includes("转正中")));

  dispatch("queue", { sessionId: "s1", items: [{ id: "q2", placement: "queued", message: { id: "m2", content: [{ type: "text", text: "排队消息二" }] } }] });
  await wait(50);
  check("差集清理后剩 1 条", document.querySelectorAll(".msg-queued").length === 1);
  check("剩余为 q2", document.querySelector(".msg-queued")?.textContent.includes("排队消息二") ?? false);

  posted = [];
  document.querySelector(".btn-queued-steer")?.click();
  await wait(10);
  const action = posted.find((p) => p.kind === "queueAction");
  check("插话按钮发 queueAction(steer)", !!action && action.itemId === "q2" && action.action?.kind === "steer");

  // 列表模式:聊天渲染类消息被忽略,会话类消息正常处理
  dispatch("init", { mode: "list", locked: false, lang: "zh-cn", status: { connected: true }, sessions: [{ sessionId: "s1", title: "会话A" }], current: "s1", events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
  await wait(50);
  check("列表模式渲染会话列表", !!document.querySelector(".list-view"));
  dispatch("todos", { sessionId: "s1", value: [{ content: "x", status: "pending" }] });
  dispatch("queue", { sessionId: "s1", items: [{ id: "qx", placement: "queued", message: { id: "mx", content: [{ type: "text", text: "q" }] } }] });
  await wait(50);
  check("列表模式忽略 todo 消息", !document.querySelector(".todo-panel") || document.querySelector(".todo-panel").hidden === true);
  check("列表模式忽略 queue 消息", document.querySelectorAll(".msg-queued").length === 0);
  dispatch("sessions", { sessions: [{ sessionId: "s1", title: "会话A" }, { sessionId: "s2", title: "会话B" }] });
  await wait(50);
  check("列表模式处理 sessions 消息", (document.querySelectorAll(".list-item").length ?? 0) > 0);

  // 流式渲染:chunk 节流 + streaming 光标类生命周期
  dispatch("init", { mode: "chat", locked: true, lang: "zh-cn", status: { connected: true }, sessions: [], current: "s1", events: [], approvals: [], questions: [], running: true, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
  await wait(50);
  dispatch("delta", { sessionId: "s1", events: [
    { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } } },
    { event: { type: "assistant/chunk", seq: 2, time: 2, data: { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } } } },
    { event: { type: "assistant/chunk", seq: 3, time: 3, data: { turn: 1, step: 0, chunk: { type: "text-delta", text: "你好" } } } },
    { event: { type: "assistant/chunk", seq: 4, time: 4, data: { turn: 1, step: 0, chunk: { type: "text-delta", text: "世界" } } } },
  ] });
  await wait(200); // 等待节流渲染
  check("流式文本渲染(你好世界)", (document.querySelector(".msg-assistant")?.textContent ?? "").includes("你好世界"));
  check("流式期间有 streaming 类", document.querySelectorAll(".streaming").length >= 1);
  dispatch("delta", { sessionId: "s1", events: [
    { event: { type: "assistant/message", seq: 5, time: 5, data: { turn: 1, step: 0, message: { content: [{ type: "text", text: "你好世界" }] } } } },
  ] });
  await wait(100);
  check("assistant/message 后 streaming 类移除", document.querySelectorAll(".streaming").length === 0);
  check("最终文本完整", (document.querySelector(".msg-assistant")?.textContent ?? "").includes("你好世界"));

  // 权限切换:点击胶囊 → 弹出菜单选项 → permission 消息 → 乐观更新 → 投影校准
  const PERMS = { options: [{ value: "read-only", name: "read-only" }, { value: "workspace-write", name: "workspace-write" }, { value: "danger-full-access", name: "danger-full-access" }], currentValue: "read-only" };
  dispatch("init", { mode: "chat", locked: true, lang: "zh-cn", status: { connected: true }, sessions: [], current: "s1", events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: PERMS, stats: undefined, todos: [], hasMore: false, queue: [] });
  await wait(80);
  let permPop = null;
  for (const p of document.querySelectorAll(".tool-pop")) {
    if ((p.getAttribute("title") ?? "").includes("权限")) { permPop = p; break; }
  }
  check("权限选择器存在", !!permPop);
  if (permPop) {
    check("权限初始显示只读", (permPop.querySelector(".tool-pop-value")?.textContent ?? "").includes("只读"));
    permPop.querySelector(".tool-pop-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(20);
    check("权限菜单展开", !permPop.querySelector(".tool-pop-menu").hidden);
    const items = [...permPop.querySelectorAll(".tool-pop-item")];
    const target = items.find((i) => i.textContent.includes("工作区可写"));
    check("菜单含工作区可写项", !!target);
    target?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(30);
    const permMsg = posted.find((p) => p.kind === "permission");
    check("权限点击发出 permission 消息", !!permMsg && permMsg.preset === "workspace-write");
    check("权限乐观更新显示新值", (permPop.querySelector(".tool-pop-value")?.textContent ?? "").includes("工作区可写"));
    dispatch("permissions", { sessionId: "s1", value: { ...PERMS, currentValue: "workspace-write" } });
    await wait(50);
    check("权限投影校准后保持新值", (permPop.querySelector(".tool-pop-value")?.textContent ?? "").includes("工作区可写"));
  }

  // 预设:已开始会话(blank=false)预设固定——胶囊标注当前模式,菜单只读展示当前一项
  dispatch("init", { mode: "chat", locked: true, lang: "zh-cn", status: { connected: true }, sessions: [{ sessionId: "s1", title: "旧会话", running: false, blank: false, agentPreset: "router-standard", cwd: "/x", updatedAt: 1 }], current: "s1", events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
  dispatch("presets", { value: { presets: [
    { id: "standard", isDefault: false, name: "标准模式" },
    { id: "router-standard", isDefault: true, name: "Router Standard (experimental)" },
  ], authorable: true, hasDocument: false } });
  await wait(50);
  let presetPop = null;
  for (const p of document.querySelectorAll(".tool-pop")) {
    if ((p.getAttribute("title") ?? "").includes("预设")) { presetPop = p; break; }
  }
  check("旧会话预设胶囊显示当前模式", !!presetPop && (presetPop.querySelector(".tool-pop-value")?.textContent ?? "").includes("Router Standard"));
  if (presetPop) {
    presetPop.querySelector(".tool-pop-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(20);
    const items = [...presetPop.querySelectorAll(".tool-pop-item")];
    check("旧会话预设菜单只含当前模式", items.length === 1 && items[0].textContent.includes("Router Standard"));
    check("旧会话预设菜单标注固定", items[0].textContent.includes("固定") || items[0].textContent.includes("fixed"));
  }

  // 回合检查点分隔线 + 回退确认卡片
  dispatch("init", { mode: "chat", locked: true, lang: "zh-cn", status: { connected: true }, sessions: [], current: "s1", events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
  await wait(50);
  dispatch("rollbackCheckpointsData", { requestId: "init", sessionId: "s1", head: "abc", dirty: 0, checkpoints: [{ turn: 1, time: 1, commit: "c1", files: [], addedTotal: 0, deletedTotal: 0, truncated: false, hasAfter: true }] });
  await wait(50);
  dispatch("delta", { sessionId: "s1", events: [
    { event: { type: "turn/start", seq: 10, time: 10, data: { turn: 1 } } },
    { event: { type: "assistant/chunk", seq: 11, time: 11, data: { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } } } },
    { event: { type: "assistant/chunk", seq: 12, time: 12, data: { turn: 1, step: 0, chunk: { type: "text-delta", text: "回复" } } } },
  ] });
  await wait(150);
  check("渲染回合分隔线", document.querySelectorAll(".rb-divider").length >= 1);
  check("分隔线带还原按钮", document.querySelectorAll(".rb-divider-btn").length >= 1);
  posted = [];
  document.querySelector(".rb-divider-btn")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(30);
  const rp = posted.find((p) => p.kind === "rollbackPreview");
  check("点击还原发 rollbackPreview", !!rp && rp.turn === 1);
  check("确认卡片出现(加载中)", !!document.querySelector(".rb-review-card"));
  dispatch("rollbackPreviewData", { requestId: rp?.requestId, sessionId: "s1", preview: { turn: 1, time: 1, commit: "c1", files: [{ path: "src/a.ts", added: 3, deleted: 1 }], addedTotal: 3, deletedTotal: 1, removedUntracked: [], untrackedUnknown: false, truncated: false } });
  await wait(50);
  check("预览显示文件行", !!document.querySelector(".rb-file-row"));
  check("预览有确认按钮", !!document.querySelector(".rb-confirm"));
  posted = [];
  document.querySelector(".rb-confirm")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(30);
  const cmd = posted.find((p) => p.kind === "command");
  check("确认回退发 /rollback 命令", !!cmd && cmd.line === "/rollback 1");

  // 语言切换回归:列表模式切语言后列表必须保留(不得 reload / 清空)
  dispatch("init", { mode: "list", locked: false, lang: "zh-cn", status: { connected: true }, sessions: [{ sessionId: "s1", title: "中文标题会话", running: false, blank: false, cwd: "C:/ws", updatedAt: 1 }], current: "s1", events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
  await wait(50);
  check("列表模式渲染", !!document.querySelector(".list-view"));
  check("列表项存在", document.querySelectorAll(".list-item").length === 1);
  dispatch("lang", { lang: "en" });
  await wait(30);
  check("切英文后列表仍在", !!document.querySelector(".list-view"));
  check("切英文后列表项仍在(用户内容不翻译)", document.querySelectorAll(".list-item").length === 1);
  check("切英文后标题翻译", document.querySelector(".list-title")?.textContent === "Conversations");
  dispatch("lang", { lang: "zh-cn" });
  await wait(30);
  check("切回中文列表仍在", !!document.querySelector(".list-view") && document.querySelectorAll(".list-item").length === 1);

  // 列表模式初始闪现回归:data-dsh-mode="list" 的 HTML 初始只渲染占位,不渲染聊天界面
  {
    const dom2 = new JSDOM(`<!DOCTYPE html><html><body data-dsh-mode="list"><div id="app"></div></body></html>`, {
      url: "http://localhost/chat",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    const { window: w2 } = dom2;
    const { document: d2 } = w2;
    w2.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => null, setState: () => {} });
    w2.eval(uiJs);
    check("列表模式初始渲染占位(无聊天界面)", !!d2.querySelector(".list-flash") && !d2.querySelector(".composer"));
    const dispatch2 = (kind, payload) => w2.dispatchEvent(new w2.MessageEvent("message", { data: { kind, ...payload } }));
    dispatch2("init", { mode: "list", locked: false, lang: "zh-cn", status: { connected: true }, sessions: [], current: null, events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
    await wait(50);
    check("init 后列表视图替换占位", !!d2.querySelector(".list-view") && !d2.querySelector(".list-flash"));
  }

  // 模型 / 思考深度 / 预设三个胶囊 —— 喂的是 modern 适配器**真合成出来的**值
  // (`synthesizeModels`)与 `listSessions` 回填进来的 `agentPreset`。
  //
  // 这一节压的是 S6 验收点的「界面那一半」:适配器形状对了,菜单就得真的列得出来。
  // 用真的合成函数而不是手写一个字面量,是因为漂移正是要防的东西 —— 哪天
  // `synthesizeModels` 少给了一个字段,这里就红,而不是等用户打开菜单才发现是空的。
  {
    const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));
    const os = require("os");
    const out = path.join(os.tmpdir(), `models-render-${process.pid}.cjs`);
    buildSync({ entryPoints: [path.join(repo, "src/dsh/protocol/modern/models.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" });
    const { synthesizeModels } = require(out);

    dispatch("init", { mode: "chat", locked: true, lang: "zh-cn", status: { connected: true }, sessions: [{ sessionId: "s1", title: "会话A", agentPreset: "standard" }], current: "s1", events: [], approvals: [], questions: [], running: false, goal: undefined, context: undefined, permissions: undefined, stats: undefined, todos: [], hasMore: false, queue: [] });
    dispatch("presets", { value: { presets: [{ id: "standard", name: "标准", isDefault: true }, { id: "minimal", name: "极简", isDefault: false }], authorable: true } });
    await wait(50);

    // 目录:两个厂商(才有多组标题那一路)、当前选中 deepseek-flash/high。
    const catalog = {
      default: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
      routableProviders: ["deepseek-official", "sense-nova"],
      groups: [
        { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "Flash", reasoning: { efforts: [{ id: "off", name: "关闭" }, { id: "low", name: "低" }, { id: "high", name: "高" }], defaultEffort: "high" } }, { id: "deepseek-pro", name: "Pro" }] },
        { id: "sense-nova", name: "SenseNova", models: [{ id: "sensenova-1", name: "SN1" }] },
      ],
      failures: [{ id: "broken", name: "Broken", message: "连不上" }],
    };
    dispatch("models", { sessionId: "s1", value: synthesizeModels(catalog, undefined) });
    await wait(50);

    const capsule = (title) => document.querySelector(`.tool-pop[title="${title}"]`);
    const valueOf = (title) => capsule(title)?.querySelector(".tool-pop-value")?.textContent ?? "(找不到该胶囊)";
    const itemsOf = (title) => Array.from(capsule(title)?.querySelectorAll(".tool-pop-item") ?? []);

    const model = capsule("模型");
    check("找得到模型胶囊", !!model);
    check("模型胶囊显示当前模型的 display name(不是 id、不是 —)", valueOf("模型") === "Flash", valueOf("模型"));
    check("模型胶囊不禁用(目录非空)", model?.classList.contains("disabled") !== true);
    const modelItems = itemsOf("模型");
    check("模型菜单列出全部 3 个模型", modelItems.length === 3, modelItems.map((n) => n.textContent).join(" | "));
    check("模型菜单的分组标题有两个厂商", Array.from(capsule("模型")?.querySelectorAll(".tool-pop-group") ?? []).length === 2);
    check("当前模型那项带 active", modelItems.filter((n) => n.classList.contains("active")).length === 1 && (modelItems.find((n) => n.classList.contains("active"))?.textContent ?? "").includes("Flash"), modelItems.map((n) => `${n.textContent}${n.classList.contains("active") ? "*" : ""}`).join(" | "));

    const thinking = capsule("思考深度(推理强度)");
    check("找得到思考深度胶囊", !!thinking);
    check("思考深度胶囊显示当前深度的名字(不是 id)", valueOf("思考深度(推理强度)") === "高", valueOf("思考深度(推理强度)"));
    const thinkItems = itemsOf("思考深度(推理强度)");
    check("思考深度菜单 = 3 个 efforts + 1 个「默认」", thinkItems.length === 4, thinkItems.map((n) => n.textContent).join(" | "));
    check("当前深度那项带 active", (thinkItems.find((n) => n.classList.contains("active"))?.textContent ?? "").includes("高"), thinkItems.map((n) => `${n.textContent}${n.classList.contains("active") ? "*" : ""}`).join(" | "));

    const preset = capsule("Agent 预设");
    check("找得到预设胶囊", !!preset);
    check("预设胶囊显示 listSessions 回填的 agentPreset 的名字", valueOf("Agent 预设") === "标准", valueOf("Agent 预设"));
    check("预设胶囊不置灰(会话有预设)", preset?.querySelector(".tool-pop-value")?.classList.contains("muted") !== true);

    // 没有 current 时(比如会话从没选过模型)三个胶囊都该是「—」而不是崩掉
    dispatch("models", { sessionId: "s1", value: synthesizeModels({ default: undefined, routableProviders: [], groups: [], failures: [] }, undefined) });
    await wait(50);
    check("目录为空时模型胶囊显示占位并禁用", capsule("模型")?.classList.contains("disabled") === true);
    check("空目录下思考深度菜单只剩「默认」", itemsOf("思考深度(推理强度)").length === 1, itemsOf("思考深度(推理强度)").map((n) => n.textContent).join(" | "));
  }

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " " + name);
    if (!ok) fail++;
  }
  console.log("\n结果:", fail === 0 ? "全部通过 (" + checks.length + " 项)" : fail + " 项失败");
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
