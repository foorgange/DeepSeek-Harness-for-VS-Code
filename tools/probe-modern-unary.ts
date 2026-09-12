/**
 * S3 验收:modern 适配器的 unary 全量,对真实 dsh 0.1.5 逐个调用。
 *
 * 为什么必须打真机:`protocol-args.test.js` 只证明「发出去的键集与我的预期表一致」——
 * 如果我的预期表本身就从错的地方抄来的,它照样全绿。只有服务端能回答
 * 「这张表对不对」,而它回答的方式是 `gateway/arguments-invalid`。
 *
 * 用例分两档:
 *   **只读** —— 随便打,不改任何状态。
 *   **写**   —— 建一条**临时会话**做沙盒,收尾归档**并删除存储目录**。绝不碰既有真实会话。
 *   归档不够:0.1.5 没有删除 API,而本扩展的侧边栏不看归档集合,只归档的话临时会话
 *   会永久挂在你眼前(见 removeSessionDirs 的说明)。`DSH_PROBE_KEEP=1` 可保留。
 *
 * 用法:
 *   npx esbuild tools/probe-modern-unary.ts --bundle --platform=node --format=cjs \
 *     --external:vscode --outfile=dist/probe-modern-unary.js
 *   node dist/probe-modern-unary.js
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModernApiClient } from "../src/dsh/protocol/modern";
import { resolveAuth } from "../src/dsh/protocol/auth";

const LIVE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

/**
 * 探针自清。
 *
 * 0.1.5 **没有删除会话的 API**:`workspace/archiveSession` 只是把会话加进
 * registry 的归档集合(返回值的 `archivedSessionIds` 是**全局归档集合**,不是
 * 「本次归档了什么」),而 `session/list` 照列不误 —— 官方 Web UI 靠
 * `workspace/follow` 的 baseline 自己减掉,本扩展的侧边栏则完全不看归档集合
 * (`sessionStore.ts:229` 把 `host/archived-sessions-changed` 整条忽略)。
 * 于是探针造的临时会话会**永久挂在用户侧边栏里**,清不掉。
 *
 * 所以这里按 sessionId 找到存储目录删掉 —— 只删本次自己造的 id,不碰别人的。
 * 排查流式/历史问题时想留着会话,设 `DSH_PROBE_KEEP=1`。
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
  // 会话按 cwd 分桶存放,桶名的编码规则(drive 小写、空格转 ~0020 等)没必要复刻
  // —— 直接在所有桶里找这几个 id,既简单又不会因为编码规则变化而失效。
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

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** 跑一个调用,把成功值或错误码带回来。 */
async function attempt<T>(label: string, call: () => Promise<T>): Promise<{ ok: boolean; value?: T; code?: string; message?: string }> {
  try {
    const value = await call();
    return { ok: true, value };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code ?? "(无 code)", message: e.message ?? String(error) };
  }
}

async function main() {
  console.log(`\n=== S3 验收 · modern unary 全量 @ ${LIVE} ===\n`);

  const client = new ModernApiClient(LIVE, { auth: () => resolveAuth(LIVE, {}), onLog: (m) => console.log(`     ${m}`) });

  // ---------- 1. 只读端点 ----------
  console.log("[1] 只读端点");

  const catalog = await attempt("session/modelCatalog", () => client.llmModels());
  check("llmModels() 成功(session/modelCatalog)", catalog.ok, catalog.ok ? `${catalog.value?.groups?.length ?? 0} 组` : `${catalog.code}: ${catalog.message}`);
  const models = catalog.value?.groups?.flatMap((g) => g.models.map((m) => m.id)) ?? [];
  check("模型目录非空且有 deepseek-flash", models.includes("deepseek-flash"), `共 ${models.length} 个模型`);

  const providers = await attempt("llm/listConfigurableProviders", () => client.llmProviders());
  check("llmProviders() 成功", providers.ok, providers.ok ? `${providers.value?.providers.length ?? 0} 个厂商` : `${providers.code}: ${providers.message}`);
  const first = providers.value?.providers[0];
  check(
    "LlmProviderView 字段齐全(provider/displayName/settingsNs/settingsPath/active)",
    first !== undefined &&
      typeof first.provider === "string" &&
      typeof first.displayName === "string" &&
      typeof first.settingsNs === "string" &&
      Array.isArray(first.settingsPath) &&
      first.active === true,
    first ? JSON.stringify(first) : "(无)",
  );

  const presets = await attempt("agentPresets/list", () => client.listAgentPresets());
  check("listAgentPresets() 成功", presets.ok, presets.ok ? `${presets.value?.presets.length ?? 0} 个预设 authorable=${presets.value?.authorable}` : `${presets.code}: ${presets.message}`);
  check(
    "预设带是默认标记(isDefault)",
    (presets.value?.presets ?? []).some((p) => p.isDefault === true),
    (presets.value?.presets ?? []).map((p) => `${p.id}${p.isDefault ? "*" : ""}`).join(", ") || "(空)",
  );

  const described = await attempt("settings/describe", () => client.settingsDescribe());
  check("settingsDescribe() 成功", described.ok, described.ok ? `${described.value?.namespaces.length ?? 0} 个命名空间` : `${described.code}: ${described.message}`);
  const ns = described.value?.namespaces.find((n) => n.ns === "agent-default-model");
  check("settings/describe 含 agent-default-model 且值里有 provider", typeof ns?.value?.["provider"] === "string", ns ? `value=${JSON.stringify(ns.value).slice(0, 120)}` : "(无该命名空间)");
  check("命名空间视图带 revision(number)", typeof ns?.revision === "number", `revision=${ns?.revision}`);

  const sessions = await attempt("session/list", () => client.listSessions());
  check("listSessions() 成功", sessions.ok, sessions.ok ? `${sessions.value?.items.length ?? 0} 个会话` : `${sessions.code}: ${sessions.message}`);

  const workspaces = await attempt("workspace/create(采纳当前目录,幂等)", () => client.adoptWorkspace(process.cwd()));
  check("adoptWorkspace() 成功", workspaces.ok, workspaces.ok ? `workspaceId=${workspaces.value?.workspace.workspaceId} created=${workspaces.value?.created}` : `${workspaces.code}: ${workspaces.message}`);

  // 凭据:插件以 **provider id** 寻址,0.1.5 以 **ref** 寻址 —— 适配器要翻译两个方向。
  // 故意挑一个带连字符的(`deepseek-official`,0.1.1 时代就是这么传来的):它正是
  // 因为没有翻译而被 `gateway/bad-request` 整批拒掉的那个。
  const providerIds = ["deepseek-official", "agentrouter", "openai"];
  const creds = await attempt("credentials/describe", () => client.credentialsDescribe(providerIds));
  check("credentialsDescribe() 成功", creds.ok, creds.ok ? JSON.stringify(creds.value?.credentials) : `${creds.code}: ${creds.message}`);
  const credKeys = Object.keys(creds.value?.credentials ?? {}).sort();
  check(
    "响应以 provider id 为键回填(而不是服务端的 ref)",
    credKeys.join(",") === [...providerIds].sort().join(","),
    `期望 [${[...providerIds].sort()}] 实得 [${credKeys}]`,
  );
  check(
    "deepseek-official 认出来了(证明 apiKeyEnv 映射生效,而不是推导成 DEEPSEEK_OFFICIAL_API_KEY)",
    creds.value?.credentials?.["deepseek-official"]?.configured === true,
    JSON.stringify(creds.value?.credentials?.["deepseek-official"]),
  );

  // ---------- 2. 建临时会话做沙盒 ----------
  console.log("\n[2] 写端点(临时会话沙盒)");
  // 必须**显式**指定预设:本机 `~/.dsh/settings.yaml` 的 `agent-presets.default` 是
  // 用户自建的 `router-spec`,它的 persona 段还是 0.1.1 的 `text:`,而 0.1.5 的
  // dsh-persona 要求 `prefix:` —— 于是「不指定预设」会报 agent-preset/invalid。
  // 那是本机配置问题,不是适配器的问题,所以这里挑一个能挂载的预设把沙盒建起来。
  const usablePreset =
    presets.value?.presets.find((p) => p.id === "standard")?.id ?? presets.value?.presets.find((p) => p.isDefault !== true)?.id;
  const created = await attempt("session/create", () =>
    client.createSession({ cwd: process.cwd(), ...(usablePreset === undefined ? {} : { agentPreset: usablePreset }) }),
  );
  check("createSession() 成功", created.ok, created.ok ? `sessionId=${created.value?.sessionId} preset=${usablePreset}` : `${created.code}: ${created.message}`);
  const sid = created.value?.sessionId;

  if (typeof sid !== "string") {
    console.log("\n  临时会话建不出来,写端点全部跳过 —— 这本身就是失败。\n");
    console.log(`=== S3 未通过(${failures + 1} 项失败) ===\n`);
    process.exit(1);
  }

  /** 本次沙盒造出来的会话 id,收尾时要删干净(见 removeSessionDirs)。 */
  const createdIds: string[] = [];

  try {
    createdIds.push(sid);
    // 这条是移植清单点名的第一个真 bug:漏 submittedAttachments 会直接 gateway/arguments-invalid
    const checkpoints = await attempt("commands/execute(/checkpoints)", () => client.executeCommand(sid, "/checkpoints"));
    check(
      "executeCommand() 成功(证明 submittedAttachments:[] 已补上)",
      checkpoints.ok,
      checkpoints.ok ? JSON.stringify(checkpoints.value?.result) : `${checkpoints.code}: ${checkpoints.message}`,
    );
    check(
      "不是「宿主没有这条命令」的合成结果",
      checkpoints.ok && !String(checkpoints.value?.commandId).startsWith("unhandled:"),
      `commandId=${checkpoints.value?.commandId}`,
    );

    const renamed = await attempt("session/rename", () => client.renameSession(sid, "S3 验收临时会话"));
    check("renameSession() 成功且回 title/seq", renamed.ok && typeof renamed.value?.seq === "number", renamed.ok ? `seq=${renamed.value?.seq}` : `${renamed.code}: ${renamed.message}`);

    const selected = await attempt("session/selectModel", () => client.selectModel(sid, "deepseek-official", "deepseek-flash", "high"));
    check("selectModel() 成功", selected.ok, selected.ok ? JSON.stringify(selected.value?.selected) : `${selected.code}: ${selected.message}`);

    const presetSel = await attempt("agentPresets/select", () => client.selectAgentPreset(sid, usablePreset ?? "standard"));
    check("selectAgentPreset() 成功", presetSel.ok, presetSel.ok ? `agentPreset=${presetSel.value?.agentPreset}` : `${presetSel.code}: ${presetSel.message}`);

    const promptResult = await attempt("session/prompt", () =>
      client.sendPrompt({ sessionId: sid, mode: "queue", content: [{ type: "text", text: "reply with the single word: pong" }] }),
    );
    check(
      "sendPrompt() 被接受(证明 requestId 已铸造且形状正确)",
      promptResult.ok && promptResult.value?.accepted === true,
      promptResult.ok ? JSON.stringify(promptResult.value) : `${promptResult.code}: ${promptResult.message}`,
    );

    const listed = await attempt("subagents/list", () => client.listSubagents(sid));
    check("listSubagents() 成功", listed.ok, listed.ok ? `${listed.value?.entries.length ?? 0} 个子代理 parentAvailable=${listed.value?.parentAvailable}` : `${listed.code}: ${listed.message}`);

    const skills = await attempt("skills/list", () => client.listSkills(sid));
    check("listSkills() 成功", skills.ok, skills.ok ? `${skills.value?.skills.length ?? 0} 个技能` : `${skills.code}: ${skills.message}`);

    const goal = await attempt("goals/get", () => client.goalEdit(sid, { id: "nonexistent", revision: 0 }));
    // 目标不存在是正常业务错,关键是**不是** arguments-invalid
    check(
      "goalEdit() 的形状被接受(报业务错而非 arguments-invalid)",
      !goal.ok && goal.code !== "gateway/arguments-invalid",
      `${goal.code}: ${goal.message}`,
    );

    const settingsWrite = await attempt("settings/update", () =>
      client.settingsUpdate("agent-default-model", { provider: (ns?.value?.["provider"] as string) ?? "deepseek-official" }),
    );
    check(
      "settingsUpdate() 成功(证明 expectedRevision:undefined 被接受)",
      settingsWrite.ok,
      settingsWrite.ok ? `revision=${settingsWrite.value?.revision}` : `${settingsWrite.code}: ${settingsWrite.message}`,
    );

    // 取消(沙盒里那条 prompt 可能已经跑完了,取消失败也算正常 —— 只看形状)
    const cancelled = await attempt("session/cancel", () => client.cancelSession(sid));
    check(
      "cancelSession() 的形状被接受",
      cancelled.ok || cancelled.code !== "gateway/arguments-invalid",
      `${cancelled.code ?? "ok"}: ${cancelled.message ?? "accepted"}`,
    );

    const forked = await attempt("session/fork", () => client.forkSession(sid));
    check("forkSession() 成功", forked.ok, forked.ok ? `新 sessionId=${forked.value?.sessionId}` : `${forked.code}: ${forked.message}`);
    if (forked.ok && typeof forked.value?.sessionId === "string") {
      createdIds.push(forked.value.sessionId);
      const archivedFork = await attempt("workspace/archiveSession(归档分叉)", () => client.archiveSession(forked.value!.sessionId));
      // 注意返回值是**全局归档集合**(服务端 doc:`@returns the complete resulting archive set`),
      // 不是「本次归档了什么」,所以只断言分叉在里面,别把整个集合打出来当结果看。
      check(
        "归档分叉会话成功",
        archivedFork.ok && (archivedFork.value?.archivedSessionIds ?? []).includes(forked.value!.sessionId),
        archivedFork.ok ? "已进入归档集合" : `${archivedFork.code}: ${archivedFork.message}`,
      );
    }
  } finally {
    // 沙盒收尾:先归档,再删存储目录。
    // 归档是**协议层面的正确收尾**(证明这条路径可用);删目录是**本机的必要收尾**
    // —— 0.1.5 没有删除 API,而侧边栏不看归档集合,不删就永久挂在那儿。
    const archived = await attempt("workspace/archiveSession(归档临时会话)", () => client.archiveSession(sid));
    check("临时会话已归档", archived.ok, archived.ok ? "已进入归档集合" : `${archived.code}: ${archived.message}`);

    if (process.env.DSH_PROBE_KEEP === "1") {
      console.log(`\n  DSH_PROBE_KEEP=1,保留临时会话:${createdIds.join(", ")}`);
    } else {
      const removed = removeSessionDirs(createdIds);
      // 删目录**不足以**让它从 `session/list` 消失:被 prompt 激活过的会话已经进了
      // 服务端内存 registry,`list()` 对它在 `summaryFor(live)` 那条分支上取内存快照,
      // 根本不看磁盘。0.1.5 也没有「释放会话」的方法,所以只能如实报出「重启才消失」。
      let lingering = 0;
      try {
        const after = await client.listSessions();
        lingering = after.items.filter((item) => createdIds.includes(item.sessionId)).length;
      } catch {
        // 查不动就不报数,别让收尾步骤把整个探针拖红
      }
      console.log(
        lingering === 0
          ? `\n  已删除 ${removed.length} 个临时会话的存储目录,列表也干净了`
          : `\n  已删除 ${removed.length} 个存储目录;服务端内存里还留着 ${lingering} 个,重启 dsh 后消失(0.1.5 无删除/释放会话的 API)`,
      );
    }
    client.dispose();
  }

  console.log(`\n=== ${failures === 0 ? "S3 通过" : `S3 未通过(${failures} 项失败)`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
