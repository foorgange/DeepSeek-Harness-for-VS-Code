/**
 * S2 验收:协议探测 + 适配器装配 + 设置项,全部走**真实的 DshHub**,不是直接调工厂。
 *
 * 只测工厂是不够的:hub 里「什么时候装配」与「装完后旧的怎么办」才是这一阶段真正的风险
 * (装早了会把协议钉死在超时结果上;装完不释放旧的会留下两条重连定时器)。
 *
 * 场景:
 *   [1] auto 打真实线上服务端(0.1.5)→ 必须判成 modern,且**不得**拉起第二个服务端
 *   [2] 强制 modern → 能起、provider/model 有值、会话列表出得来、agentPreset 已回填
 *   [3] 强制 legacy → 判定必须听话(即便因此连不上,也不许「好心」切回 modern)
 *   [4] 关掉凭据文件读取 → 两条探针全 401 ⇒ unknown ⇒ 回落 legacy(绝不猜测 modern)
 *   [5] 手填 Cookie(dsh.authToken)→ 走通门禁
 *   [6] 未实现的 modern 方法必须显式抛 protocol/not-implemented,不许静默返回空值
 *   [7] 换端口(3099)→ authority 随端口变化,Cookie 仍须有效
 *   [8] 新建会话 → 立刻发消息 → 事件必须回到 store(压 hub.createSession 那个漏订阅的真 bug)
 *
 * 用法:
 *   npx esbuild tools/probe-hub-protocol.ts --bundle --platform=node --format=cjs \
 *     --external:vscode --outfile=dist/probe-hub-protocol.js
 *   node dist/probe-hub-protocol.js
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DshHub } from "../src/dsh/hub";
import type { ProtocolSetting } from "../src/dsh/protocol";
import { authorityOf, signCookie, readBrowserSessionSecret } from "../src/dsh/protocol/auth";

const LIVE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const SPARE_PORT = 3099;
const SPARE = `http://127.0.0.1:${SPARE_PORT}`;

/**
 * 删掉本探针造的临时会话目录(见 `probe-modern-unary.ts` 的长注释:0.1.5 没有删除会话的
 * API,不删目录它就会永久挂在用户侧边栏里)。只删传进来的 id,不碰任何既有会话。
 * 服务端**内存**里那条要等它重启才消失。
 */
function removeSessionDirs(ids: readonly string[]): void {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const root = join(home, "sessions");
  let buckets: string[];
  try {
    buckets = readdirSync(root);
  } catch {
    return;
  }
  for (const bucket of buckets) {
    for (const id of ids) {
      const target = join(root, bucket, id);
      if (!existsSync(target)) continue;
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // 删不掉无碍:服务端内存里那条本来就得靠重启清。
      }
    }
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

interface Captured {
  logs: string[];
  notices: string[];
}

function makeHub(url: string, protocol: ProtocolSetting, extra: Record<string, unknown> = {}): { hub: DshHub; cap: Captured } {
  const cap: Captured = { logs: [], notices: [] };
  const hub = new DshHub({
    url,
    command: "dsh",
    autoStart: true,
    autoStartTimeoutSec: 40,
    protocol,
    logFile: () => join(tmpdir(), `dsh-s2-hub-${Date.now()}.log`),
    onLog: (m) => cap.logs.push(m),
    onNotice: (m, kind) => cap.notices.push(`${kind}: ${m}`),
    ...extra,
  });
  return { hub, cap };
}

async function main() {
  console.log(`\n=== S2 验收 · 协议探测与装配(真实 DshHub)@ ${LIVE} ===\n`);
  mkdirSync(tmpdir(), { recursive: true });

  // ---------- [1] auto ----------
  console.log("[1] dsh.protocol=auto,打真实线上服务端");
  const a = makeHub(LIVE, "auto");
  const ready = await a.hub.ensureReady();
  check("ensureReady() 成功", ready.ok === true, JSON.stringify(ready));
  // 这一条是 S0 那个 isUp() 401 修复的端到端证明:若 isUp 仍把 401 当「已死」,
  // ensure() 会在这里拉起第二个 dsh 进程去抢 3080。
  check(
    "ensure() 判定为「本来就在线」,未启动子进程",
    a.hub.server.status.startedByUs === false && !a.cap.logs.some((l) => l.includes("已启动子进程")),
    a.hub.server.status.startedByUs ? "startedByUs=true" : "startedByUs=false",
  );
  check("探测结果 = modern", a.hub.status.protocol === "modern", `protocol=${a.hub.status.protocol}`);
  check("HubStatus.version = 0.1.5", a.hub.status.version === "0.1.5", `version=${a.hub.status.version}`);
  check("HubStatus.provider 有值", typeof a.hub.status.provider === "string" && a.hub.status.provider.length > 0, `provider=${a.hub.status.provider}`);
  check("HubStatus.model 有值", typeof a.hub.status.model === "string" && a.hub.status.model.length > 0, `model=${a.hub.status.model}`);
  const sessions = a.hub.store.listSessions();
  check("会话列表非空", sessions.length > 0, `${sessions.length} 个会话`);
  // 实测:0.1.5 的 session/list 只回**缓存**投影(基本只有 title),agentPreset 不在其中。
  // 所以这里断言「标题能出来」—— 那是侧边栏真正依赖的字段;preset 归 S6 走 session/follow。
  check(
    "会话标题已回填(session/list 的投影里唯一真正有值的键)",
    sessions.filter((s) => typeof s.title === "string" && s.title.length > 0).length > 0,
    `${sessions.filter((s) => typeof s.title === "string" && s.title.length > 0).length}/${sessions.length} 个有标题 · 例:${
      sessions.find((s) => s.title)?.title ?? "-"
    }`,
  );
  check("选定了一个当前会话", typeof a.hub.store.currentSessionId === "string", `currentSessionId=${a.hub.store.currentSessionId}`);
  check("探测过程有日志", a.cap.logs.some((l) => l.includes("探测结果")), a.cap.logs.find((l) => l.includes("探测结果")) ?? "(无)");

  // ---------- [2] 强制 modern ----------
  console.log("\n[2] dsh.protocol=modern(强制)");
  const b = makeHub(LIVE, "modern");
  const probed = await b.hub.probe();
  check("probe() 返回 true", probed === true);
  check("protocol = modern", b.hub.status.protocol === "modern", `protocol=${b.hub.status.protocol}`);
  check("强制时跳过探测(设置被无条件遵守)", b.cap.logs.some((l) => l.includes("跳过探测")), b.cap.logs.find((l) => l.includes("跳过探测")) ?? "(无)");

  // ---------- [3] 强制 legacy ----------
  console.log("\n[3] dsh.protocol=legacy(强制,对一台 0.1.5 服务端)");
  const c = makeHub(LIVE, "legacy");
  await c.hub.probe();
  check("protocol = legacy(设置必须被无条件遵守)", c.hub.status.protocol === "legacy", `protocol=${c.hub.status.protocol}`);
  check("日志注明跳过探测", c.cap.logs.some((l) => l.includes("跳过探测")), c.cap.logs.find((l) => l.includes("跳过探测")) ?? "(无)");
  check("serverUp = false(0.1.5 上没有点号路由,连不上是预期结果)", c.hub.status.serverUp === false, `serverUp=${c.hub.status.serverUp}`);

  // ---------- [4] 关掉凭据文件读取 ----------
  console.log("\n[4] deriveAuthFromCredentials=false(无令牌、无手填 Cookie)");
  const d = makeHub(LIVE, "auto", { deriveAuthFromCredentials: false });
  await d.hub.probe();
  check("日志确认没有拿到凭据", d.cap.logs.some((l) => l.includes("鉴权凭据:无")), d.cap.logs.find((l) => l.includes("鉴权凭据")) ?? "(无)");
  check("全 401 ⇒ unknown ⇒ 回落 legacy,绝不猜测 modern", d.hub.status.protocol === "legacy", `protocol=${d.hub.status.protocol}`);

  // ---------- [5] 手填 Cookie(dsh.authToken) ----------
  console.log("\n[5] dsh.authToken(手填完整 Cookie)");
  const secret = readBrowserSessionSecret();
  if (secret === undefined) {
    check("读到浏览器会话密钥", false, "未读到 —— 跳过 [5]/[7] 的凭据部分");
  } else {
    const manual = signCookie(secret, authorityOf(LIVE));
    const e = makeHub(LIVE, "auto", { manualCookie: manual, deriveAuthFromCredentials: false });
    await e.hub.probe();
    check("手填 Cookie 走通门禁 ⇒ modern", e.hub.status.protocol === "modern", `protocol=${e.hub.status.protocol} serverUp=${e.hub.status.serverUp}`);
  }

  // ---------- [7] 换端口:authority 必须随端口变 ----------
  console.log(`\n[7] 独立端口 ${SPARE_PORT}:authority 随端口变化,Cookie 必须重签`);
  const spareLog = join(tmpdir(), `dsh-s2-spare-${Date.now()}.log`);
  const fd = openSync(spareLog, "a");
  const spare = spawn(`dsh web --port ${SPARE_PORT} --no-open`, { shell: true, stdio: ["ignore", fd, fd], windowsHide: true });
  closeSync(fd);
  let sparePid = spare.pid;
  // shell:true 下 child.pid 是 cmd.exe —— 必须整棵树杀,否则 node 那个孙进程会留在 3099 上
  const killSpare = async () => {
    if (sparePid === undefined) return;
    try {
      spawn("taskkill", ["/pid", String(sparePid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* 忽略 */
    }
    sparePid = undefined;
    await new Promise((r) => setTimeout(r, 700));
  };

  try {
    const check7 = makeHub(SPARE, "auto", {});
    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = await check7.hub.server.isUp(800);
      if (!up) await new Promise((r) => setTimeout(r, 400));
    }
    check("独立服务端已在 3099 就绪", up);
    if (up) {
      check("两个端口的 authority 不同", authorityOf(LIVE) !== authorityOf(SPARE), `${authorityOf(LIVE)} vs ${authorityOf(SPARE)}`);
      const r = await check7.hub.probe();
      check("probe() 对 3099 也判成 modern", check7.hub.status.protocol === "modern", `protocol=${check7.hub.status.protocol} up=${r}`);
      // 「端口应答了」和「会话索引建好了」是两件事:`isUp()` 只看前者(收到 401 就算在跑),
      // 而一台刚起的 0.1.5 要扫完会话目录才填得上 `session/list`。原来这里紧挨着断言,
      // 实测是**会翻车的**:机器忙的时候(同时跑着 npm install)索引慢半拍,读到的就是 0 个 ——
      // 那一刻没有任何东西坏掉,纯粹是问早了。改成有界轮询,断言本身不放宽。
      let spareCount = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        await check7.hub.refreshSessions().catch(() => {});
        spareCount = check7.hub.store.listSessions().length;
        if (spareCount > 0) break;
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      check("3099 上也能列出会话(凭据是同一份)", spareCount > 0, `${spareCount} 个`);
    }
  } finally {
    await killSpare();
  }

  // ---------- [6] modern 的方法面已全部落地 ----------
  // 这一节在 S2 时断言的是「未实现的方法必须显式抛 protocol/not-implemented」。
  // S3(unary 全量)与 S6(模型/预设合成)落地后,抛错桩已经删掉,这些方法**都该有真实
  // 实现** —— 断言反过来才对。留着旧断言就是拿一个早已过期的预期去要求一个更完整的实现。
  console.log("\n[6] modern 的方法面:全部有真实实现,没有 not-implemented 桩");
  const f = makeHub(LIVE, "modern");
  await f.hub.probe();
  const anySession = f.hub.store.listSessions()[0]?.sessionId ?? "";
  for (const [name, call] of [
    ["listSkills", () => f.hub.client.listSkills(anySession)],
    ["listAgentPresets", () => f.hub.client.listAgentPresets()],
    ["settingsDescribe", () => f.hub.client.settingsDescribe()],
  ] as const) {
    let result: unknown;
    let code = "(未抛错)";
    try {
      result = await call();
    } catch (error) {
      code = (error as { code?: string }).code ?? String(error);
    }
    check(`${name}() 有真实实现(不抛 not-implemented)`, code === "(未抛错)" && result !== undefined, `code=${code}`);
  }
  const roster = await f.hub.client.listAgentPresets();
  check("listAgentPresets() 回的是真名册", (roster.presets ?? []).length > 0, `${(roster.presets ?? []).length} 个预设`);
  check("没有出现「静默返回假数据」的告警", f.cap.notices.filter((n) => n.startsWith("error")).length === 0, f.cap.notices.join(" | ") || "(无通知)");

  // ---------- [8] 新建会话 → 立刻发消息 → 事件必须回到 store ----------
  // 这一条压的是一个**实测踩到过的真 bug**:`hub.createSession()` 原本只 `selectSession()`
  // 而不 `ensureHistory()`,于是新会话从没建立过 `session/follow` 流 —— 0.1.5 没有全局事件流,
  // 结果就是「消息发出去了,界面一直转圈」。0.1.1 上不会犯这个病(它有全局 events.mux),
  // 所以这条只在 modern 上真正有区分度。
  console.log("\n[8] 新建会话 → 立刻发消息:事件必须回到 store(0.1.5 的跟随流)");
  const g = makeHub(LIVE, "modern");
  await g.hub.ensureReady();
  const scratch = mkdtempSync(join(tmpdir(), "dsh-s2-hub-new-"));
  const fresh = await g.hub.createSession(scratch, "standard");
  check("createSession 返回 session- 开头的 id", fresh.startsWith("session-"), fresh);
  check("新会话已被选中", g.hub.store.currentSessionId === fresh, `${g.hub.store.currentSessionId}`);

  await g.hub.send(fresh, "请只回复两个字母:OK");
  let got: string[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    got = g.hub.store
      .eventsFor(fresh)
      .map((s) => s.event.type)
      .filter((t) => t === "assistant/message" || t === "turn/end" || t === "assistant/chunk");
    if (got.includes("turn/end")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check("新会话发消息后事件回到了 store", got.length > 0, `事件类型=${[...new Set(got)].join(",") || "(无)"}`);
  check("回合正常收尾(turn/end)", got.includes("turn/end"), `事件类型=${[...new Set(got)].join(",") || "(无)"}`);

  try { await g.hub.client.cancelSession(fresh); } catch {}
  g.hub.dispose();
  if (process.env.DSH_PROBE_KEEP !== "1") removeSessionDirs([fresh]);

  console.log(`\n=== ${failures === 0 ? "S2 通过" : `S2 未通过(${failures} 项失败)`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
