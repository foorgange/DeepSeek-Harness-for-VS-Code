/**
 * S6 的真机验收探针 —— 驱动的是扩展真正在用的类(`ModernApiClient` 的
 * `sessionModels` / `selectModel` / `listSessions`),不是另写一套等价逻辑。
 * 所以它验过的路径就是线上路径。
 *
 * 用法(先把 dsh 跑起来):
 *   npx esbuild tools/probe-models.ts --bundle --platform=node --format=cjs --outfile=dist/probe-models.js
 *   node dist/probe-models.js
 *   DSH_PROBE_EFFORT=low node dist/probe-models.js   # 换一个要验的思考深度
 *
 * 验的四件事(对应 S6 的验收点):
 *   1. **模型选择器**能列出厂商/模型,并且 `current` 说的是**这个会话**选的,不是目录默认;
 *   2. **思考深度菜单**的数据源在(`models[].reasoning.efforts`),且默认深度能应用;
 *   3. `selectModel` 之后**立刻**重读就是新值(`hub.updateCurrentModel` 就是这么读的);
 *   4. **预设标签**:`listSessions()` 现在能给出 `agentPreset`(0.1.5 的 `session/list`
 *      两个位置都可能没有,得靠控制流 baseline 的投影补)。
 *
 * 第 1、4 条各有一个**独立来源的交叉核对**:探针自己再开一条 `session/follow` 拿开局
 * 快照,直接读 snapshot 里的 `projections`(那是计划的原始来源),与缓存比。两个来源
 * 对不上就说明缓存串了会话 —— 而那正是本文件最该抓的错误。
 *
 * 写操作只碰它自己建的**临时会话**(工作目录在 tmp 下),跑完**删掉它的存储目录**。
 * `DSH_PROBE_KEEP=1` 可保留。
 *
 * 注意收尾**不归档**(与 `probe-modern-unary.ts` 不同):归档只是往服务端的
 * `archivedSessionIds` 集合里加一个 id(0.1.5 连删除 API 都没有),而本扩展的侧边栏
 * 压根不看那个集合 —— 归档在这儿等于往 registry 里扔一个永远清不掉的死 id。
 * 删目录更干净,但**服务端内存里那条会话要等重启才会消失**(实测:删完目录后
 * `session/list` 里仍然列着它,`blank=true`),所以跑完探针后重启一次 dsh 才算真清干净。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ModernApiClient } from "../src/dsh/protocol/modern";
import { RemoteMux, type MuxStream } from "../src/dsh/protocol/mux";
import { resolveAuth } from "../src/dsh/protocol/auth";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const EFFORT = process.env.DSH_PROBE_EFFORT ?? "high";

let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log((ok ? "  OK   " : "  FAIL ") + name + (ok || detail === undefined ? "" : `  → ${detail}`));
  if (!ok) fail++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 探针自清,与 `probe-modern-unary.ts` 同一套做法(0.1.5 没有删除会话的 API:
 * 归档只是加进 registry 的集合,`session/list` 照列不误,所以临时会话会永久挂在
 * 用户侧边栏里)。只删本探针自己造的那几个 id。
 *
 * 删盘不等于**眼不见**:服务端把会话留在内存里,要重启才消失(见文件头)。
 */
function removeSessionDirs(ids: readonly string[]): string[] {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const root = join(home, "sessions");
  const removed: string[] = [];
  let buckets: string[];
  try {
    buckets = readdirSync(root);
  } catch {
    return removed;
  }
  for (const bucket of buckets) {
    for (const id of ids) {
      const target = join(root, bucket, id);
      if (!existsSync(target)) continue;
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch (error) {
        console.log(`  清理失败(可手动删):${target} — ${String(error)}`);
      }
    }
  }
  return removed;
}

/** 直连开一条 `session/follow`,拿它的开局快照(交叉核对用的**独立来源**)。 */
function openSnapshot(mux: RemoteMux, sessionId: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let stream: MuxStream | undefined;
    const timer = setTimeout(() => {
      stream?.cancel();
      reject(new Error("开局帧超时"));
    }, 15_000);
    stream = mux.open<Record<string, any>>(
      "session/follow",
      { request: { address: { kind: "session", sessionId } } },
      {
        onItem: (item) => {
          if (item?.type !== "snapshot") return;
          clearTimeout(timer);
          stream?.cancel();
          resolve(item);
        },
        onEnd: () => {
          clearTimeout(timer);
          reject(new Error("流结束而没有开局帧"));
        },
        onError: (error) => {
          clearTimeout(timer);
          reject(new Error(`${error.code}: ${error.message}`));
        },
      },
    );
  });
}

/** 快照里的某个投影值。 */
function projectionOf(snapshot: Record<string, any>, key: string): unknown {
  return snapshot?.projections?.values?.[key];
}

async function main() {
  const auth = await resolveAuth(BASE);
  if (!auth) throw new Error("无法解析鉴权凭据 —— 检查 ~/.dsh/.credentials.yaml");
  console.log(`探针目标 ${BASE}(authority=${auth.authority}, 来源=${auth.via})\n`);

  const client = new ModernApiClient(BASE, {
    auth: () => resolveAuth(BASE),
    onLog: (m) => console.log(`      [log] ${m}`),
  });
  // 装帧处理器 = 起三条常驻流(含 session/control,它的 baseline 就是预设/模型选择的来源)
  client.setFrameHandlers({ onMuxFrame: () => {}, onHostFrame: () => {} });

  // 独立的 mux,只用来开交叉核对用的那条 follow。
  const mux = new RemoteMux({ baseUrl: BASE, auth: async () => auth, onLog: () => {} });
  mux.connect();

  let sessionId: string | undefined;

  try {
    // ---------- 1. 预设回填(控制流 baseline → listSessions) ----------
    console.log("=== 1. 会话列表里的预设标签 ===");
    let items: any[] = [];
    let withPreset: any[] = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const listed = await client.listSessions();
      items = listed.items ?? [];
      withPreset = items.filter((i) => typeof i.agentPreset === "string" && i.agentPreset.length > 0);
      if (withPreset.length > 0) break;
      await sleep(200);
    }
    console.log(`      会话 ${items.length} 个,其中 ${withPreset.length} 个带预设:${withPreset.slice(0, 5).map((i) => i.agentPreset).join(", ")}`);
    check("listSessions() 回填出了 agentPreset(控制流 baseline)", withPreset.length > 0, `${withPreset.length}/${items.length}`);

    // 预设名必须是服务端真有的 id —— 否则是缓存里进了脏值。
    const roster = await client.listAgentPresets();
    const ids = new Set((roster.presets ?? []).map((p: any) => p.id));
    const unknown = withPreset.filter((i) => !ids.has(i.agentPreset));
    check("回填的预设都是名册里真有的 id", unknown.length === 0, `${unknown.length} 个对不上:${unknown.slice(0, 3).map((i) => i.agentPreset).join(", ")}`);

    // 交叉核对:自己开一条 follow,直接读快照里的投影。
    const probe = withPreset[0] ?? items.find((i) => !i.blank) ?? items[0];
    if (probe === undefined) {
      console.log("      没有会话 —— 先建一个再跑。");
    } else {
      const snapshot = await openSnapshot(mux, probe.sessionId);
      const fromSnapshot = projectionOf(snapshot, "agentPreset");
      check(
        "控制流缓存与独立跟随快照给出同一个预设",
        fromSnapshot === probe.agentPreset,
        `缓存 ${JSON.stringify(probe.agentPreset)} vs 快照 ${JSON.stringify(fromSnapshot)}`,
      );

      // ---------- 2. 模型目录 + 当前选择 ----------
      console.log("\n=== 2. 模型选择器 ===");
      const models = await client.sessionModels(probe.sessionId);
      const modelCount = models.groups.reduce((n, g) => n + g.models.length, 0);
      const withReasoning = models.groups.flatMap((g) => g.models).filter((m) => (m.reasoning?.efforts?.length ?? 0) > 0);
      console.log(`      ${models.groups.length} 个厂商 / ${modelCount} 个模型;当前 ${models.current.provider} / ${models.current.model}${models.current.reasoningEffort ? ` (effort=${models.current.reasoningEffort})` : ""}`);
      check("厂商/模型列得出来", models.groups.length > 0 && modelCount > 0, `${models.groups.length} 组 / ${modelCount} 个`);
      check("current 有 provider 与 model", Boolean(models.current.provider && models.current.model), JSON.stringify(models.current));
      check("current 指的是目录里真有的模型", models.groups.some((g) => g.id === models.current.provider && g.models.some((m) => m.id === models.current.model)));
      check("routable 为真(目录里有可路由厂商)", models.routable === true);
      check("失败厂商以 failures 交代(可以为空)", Array.isArray(models.failures), `${models.failures.length} 条`);

      // 交叉核对:快照里的 modelSelection 投影(next ?? lastUsed,与服务端 view 同规则)
      const raw = projectionOf(snapshot, "modelSelection") as { lastUsed?: any; next?: any } | undefined;
      const expected = raw?.next ?? raw?.lastUsed;
      if (expected == null) {
        // 这个会话从没用过模型 —— 那就该退回目录默认值,而目录默认值正是 ping() 报的那对。
        const host = await client.ping();
        check(
          "会话没有模型投影时退回目录默认(ping 报的那对)",
          models.current.provider === host?.provider && models.current.model === host?.model,
          `${models.current.provider}/${models.current.model} vs ${host?.provider}/${host?.model}`,
        );
      } else {
        check(
          "current 与独立快照的 modelSelection 一致",
          models.current.provider === expected.provider && models.current.model === expected.model && models.current.reasoningEffort === expected.reasoningEffort,
          `${JSON.stringify(models.current)} vs ${JSON.stringify(expected)}`,
        );
      }

      // ---------- 3. 思考深度菜单的数据源 ----------
      console.log("\n=== 3. 思考深度 ===");
      const sample = withReasoning[0];
      console.log(`      带 efforts 的模型 ${withReasoning.length}/${modelCount} 个;例:${sample ? `${sample.id} → ${sample.reasoning?.efforts.map((e) => e.id).join(", ")} (默认 ${sample.reasoning?.defaultEffort ?? "无"})` : "(无)"}`);
      check("有模型带 reasoning.efforts(思考深度菜单的数据源)", withReasoning.length > 0, `${withReasoning.length} 个`);
      check(
        "efforts 的每一项都有 id 与 name",
        withReasoning.every((m) => m.reasoning!.efforts.every((e) => typeof e.id === "string" && e.id.length > 0 && typeof e.name === "string")),
      );
      check("defaultEffort(若有)在 efforts 里", withReasoning.every((m) => m.reasoning!.defaultEffort === undefined || m.reasoning!.efforts.some((e) => e.id === m.reasoning!.defaultEffort)));
    }

    // ---------- 4. 新会话:默认思考深度 + 乐观更新 ----------
    console.log("\n=== 4. 新建会话上的选择与切换 ===");
    const scratch = mkdtempSync(join(tmpdir(), "dsh-probe-models-"));
    const created = await client.createSession({ cwd: scratch, agentPreset: "standard" });
    sessionId = created?.sessionId;
    if (typeof sessionId !== "string") throw new Error(`建会话失败:${JSON.stringify(created).slice(0, 200)}`);
    console.log(`      临时会话 ${sessionId}(工作区 ${scratch})`);

    const fresh = await client.sessionModels(sessionId);
    console.log(`      新会话 current:${fresh.current.provider} / ${fresh.current.model}${fresh.current.reasoningEffort ? ` (effort=${fresh.current.reasoningEffort})` : ""}`);
    check("新会话能拿到模型目录", fresh.groups.length > 0);
    check("新会话的 current 落在目录里的真模型上", fresh.groups.some((g) => g.id === fresh.current.provider && g.models.some((m) => m.id === fresh.current.model)), JSON.stringify(fresh.current));

    // 复刻 `hub.applyDefaultReasoningEffort()` 的**逐句逻辑**(hub.ts:589-601:读 current
    // → 找同厂商同模型 → 它的 efforts 里有配置的那个深度 → selectModel)。
    // 这里没法直接调那个方法(它挂在 hub 上,hub 要 vscode),所以按原句走一遍。
    const group = fresh.groups.find((g) => g.id === fresh.current.provider);
    const model = group?.models.find((m) => m.id === fresh.current.model);
    const efforts = model?.reasoning?.efforts ?? [];
    const wanted = efforts.some((e) => e.id === EFFORT);
    console.log(`      默认思考深度 ${EFFORT}:当前模型 ${efforts.length} 个可选 → ${wanted ? "可应用" : "不适用(不是模型缺失就是该深度不在列)"}`);
    check(
      `dsh.defaultReasoningEffort 在新建会话上有落点(模型 ${fresh.current.model} 支持 ${EFFORT})`,
      wanted || efforts.length === 0,
      `efforts=${efforts.map((e) => e.id).join(",") || "(无)"}`,
    );
    if (wanted) {
      const applied = await client.selectModel(sessionId, fresh.current.provider, fresh.current.model, EFFORT);
      check("按默认深度 selectModel 成功", (applied as any)?.selected?.reasoningEffort === EFFORT, JSON.stringify(applied));
      const after = await client.sessionModels(sessionId);
      check("应用后**立刻**重读就是该深度(乐观更新生效)", after.current.reasoningEffort === EFFORT, JSON.stringify(after.current));
    }

    // 换一个**不同**的模型,验乐观写与投影一致。
    const other = fresh.groups.flatMap((g) => g.models.map((m) => ({ group: g.id, model: m.id }))).find((m) => m.model !== fresh.current.model);
    if (other === undefined) {
      console.log("      目录里只有一个模型,跳过换模型那一步");
    } else {
      await client.selectModel(sessionId, other.group, other.model);
      const now = await client.sessionModels(sessionId);
      check("切模型后立刻重读就是新模型(乐观更新)", now.current.provider === other.group && now.current.model === other.model, JSON.stringify(now.current));
      // 投影帧到达后仍应一致(乐观值让位给服务端,而服务端说的是同一件事)。
      await sleep(1500);
      const settled = await client.sessionModels(sessionId);
      check("投影帧到达后没有回退", settled.current.model === other.model, JSON.stringify(settled.current));
      const snap = await openSnapshot(mux, sessionId);
      const durable = (projectionOf(snap, "modelSelection") as any)?.next ?? (projectionOf(snap, "modelSelection") as any)?.lastUsed;
      check("服务端投影最终也承认这次切换", durable?.model === other.model, JSON.stringify(durable));
    }

    // ---------- 5. 新会话的预设标签 ----------
    console.log("\n=== 5. 新会话的预设 ===");
    // 跟随一次,让控制流把这条会话的投影也送过来(新建的会话在 baseline 之后才有投影)。
    await openSnapshot(mux, sessionId);
    let preset: string | undefined;
    for (let attempt = 0; attempt < 15; attempt++) {
      const listed = await client.listSessions();
      preset = listed.items?.find((i: any) => i.sessionId === sessionId)?.agentPreset;
      if (typeof preset === "string") break;
      await sleep(200);
    }
    check("新建会话(agentPreset=standard)在列表里带上了预设", preset === "standard", `得到 ${JSON.stringify(preset)}`);
    const own = await openSnapshot(mux, sessionId);
    check("与它自己的快照一致", projectionOf(own, "agentPreset") === "standard", JSON.stringify(projectionOf(own, "agentPreset")));
  } finally {
    mux.dispose();
    client.dispose();
    if (sessionId !== undefined && process.env.DSH_PROBE_KEEP !== "1") {
      await sleep(300);
      removeSessionDirs([sessionId]);
      console.log(`\n      已清理临时会话 ${sessionId}`);
    }
    console.log(`\n${fail === 0 ? "探针全部通过" : `失败 ${fail} 项`}`);
    // 不能紧接着 process.exit():socket 关闭还在路上,libuv 会在退出时断言失败。
    await sleep(250);
    process.exitCode = fail === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exitCode = 1;
});
