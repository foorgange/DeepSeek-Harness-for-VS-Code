/**
 * 集成测试:对运行中的 DSH Web 服务器验证 API 客户端全链路,**两代协议跑同一个脚本**。
 *
 * 用法:
 *   npx esbuild tools/test-client.ts --bundle --platform=node --format=cjs --outfile=dist/test.js
 *   node dist/test.js                          # 协议:auto(与扩展的默认行为一致)
 *   DSH_PROTOCOL=legacy node dist/test.js      # 强制 0.1.1 那条路
 *   DSH_PROTOCOL=modern node dist/test.js      # 强制 0.1.5 那条路
 *   DSH_URL=http://127.0.0.1:3099 node dist/test.js
 *
 * 这是双协议回归的**第 2 层**:断言集是同一份,协议是变量。判据不是「modern 能不能跑」,
 * 而是「同一段业务代码在两代传输上跑出同一组结果」—— 适配器的全部意义就在这里。
 *
 * 协议判定与 `[protocol]` 日志走 **stderr**,stdout 只留断言结果。这样 `DSH_PROTOCOL=legacy`
 * 对 0.1.1 的输出可以与 0.12.4 时代逐行对照(断言名、顺序、结果都不变),那正是移植没有
 * 伤到老用户的证据。
 *
 * 收尾会删掉本次临时会话的存储目录(0.1.5 没有删除 API,不删就永久挂在侧边栏)。
 * 服务端**内存**里那条要等它重启才消失 —— 探针脚本也一样,见各自文件头。
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAdapter, type ProtocolSetting } from "../src/dsh/protocol";
import type { ProtocolAdapter } from "../src/dsh/protocol/types";
import type { MuxFrame } from "../src/dsh/types";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const SETTING = (process.env.DSH_PROTOCOL ?? "auto") as ProtocolSetting;

/** 删掉本脚本造的临时会话目录(只删传进来的 id,不碰任何既有会话)。 */
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
        // 删不掉不算测试失败:服务端内存里那条本来就得靠重启清。
      }
    }
  }
}

async function main() {
  // 总是走工厂:这正是扩展装配客户端时走的那条路(探测 + 鉴权 + 选择)。
  const handle = await createAdapter(BASE, { protocol: SETTING, onLog: (m) => console.error(m) });
  const client: ProtocolAdapter = handle.adapter;
  console.error(`\n=== ${BASE}  协议=${handle.kind}(DSH_PROTOCOL=${SETTING}) ===\n`);

  const results: string[] = [];
  const ok = (name: string, pass: boolean, detail = "") => {
    results.push(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  let sessionId = "";
  try {
    // 1. 探测
    const describe = await client.ping();
    ok("host.describe 探测", describe !== undefined, describe ? `version=${describe.version} model=${describe.model}` : "无响应");

    // 2. 会话列表
    const list = await client.listSessions();
    ok("session.list", Array.isArray(list.items), `${list.items.length} 个会话`);

    // 3. 新建会话
    const created = await client.createSession({ cwd: process.cwd() });
    sessionId = created.sessionId;
    ok("session.create", sessionId.startsWith("session-"), sessionId);

    // 4. 事件流:先订阅,再发消息
    const events: MuxFrame[] = [];
    let subscribed = false;
    let received = 0;
    const framePromise = new Promise<string>((resolve) => {
      client.setFrameHandlers({
        onMuxFrame: (env) => {
          events.push(env.frame);
          if (env.frame.type === "session/subscribed") subscribed = true;
          if (env.frame.type === "session/event" && env.frame.sessionId === sessionId) {
            received++;
            const ev = env.frame.event;
            if (ev.type === "turn/end") resolve("turn/end");
            if (ev.type === "assistant/message") {
              const text = (ev.data?.message?.content ?? [])
                .filter((b: any) => b?.type === "text")
                .map((b: any) => b.text)
                .join("");
              if (text) resolve(text.slice(0, 60));
            }
          }
        },
        onHostFrame: () => {},
      });
    });

    // 订阅这个会话 —— 必须在发消息**之前**。
    // 0.1.1 有一条全局 `events.mux` 推所有会话的增量,0.1.5 没有:实时事件只走
    // `session/follow`,而开那条流的正是 `sessionHistory()`(`hub.createSession`
    // 现在也走这一步,见那里的注释)。漏了它,表现是「消息发出去了,没有任何回包」——
    // 本脚本最早就是栽在这里。断言仍留在第 6 步,这里只是把流开起来。
    await client.sessionHistory({ sessionId });

    await new Promise((r) => setTimeout(r, 1500));
    ok("WebSocket mux 订阅", subscribed, `已收到 ${events.length} 个帧(含 ${events.filter((f) => f.type === "session/subscribed").length} 个订阅基线)`);

    // 5. 发送消息
    const prompt = await client.sendPrompt({ sessionId, mode: "queue", content: [{ type: "text", text: "请只回复两个字母:OK" }] });
    ok("session.prompt", prompt.accepted === true);

    // 超时要**判失败**,不能抛:`race` 里 reject 会让整个脚本崩在 main() 外,
    // 前面攒下的断言一条都印不出来 —— 那正是最需要看结果的时候。
    const outcome = await Promise.race([
      framePromise,
      new Promise<string>((resolve) => setTimeout(() => resolve("TIMEOUT"), 90_000)),
    ]);
    const eventTypes = [
      ...new Set(
        events
          .filter((f) => f.type === "session/event" && f.sessionId === sessionId)
          .map((f) => (f as any).event.type as string),
      ),
    ];
    ok("收到事件流并完成回合", outcome !== "TIMEOUT", `结果="${outcome}" 事件类型=${eventTypes.join(",")} 事件数=${received}`);

    // 6. 历史
    const history = await client.sessionHistory({ sessionId });
    ok("session.history", history.events.length > 0, `${history.events.length} 条事件`);

    // 7. 模型目录 —— 两代协议形状不同(0.1.1 直接给 session.models,0.1.5 得从
    //    session/modelCatalog + 会话投影合成),但**上层看到的必须是同一个东西**。
    //    这两条是「合成错了也不报错、只表现为菜单空白」那类 bug 的唯一防线。
    const models = await client.sessionModels(sessionId);
    const modelCount = models.groups.reduce((n, g) => n + g.models.length, 0);
    ok("session.models 列出厂商/模型", modelCount > 0, `${models.groups.length} 个厂商 / ${modelCount} 个模型`);
    ok(
      "current 落在目录里真有的模型上",
      models.groups.some((g) => g.id === models.current.provider && g.models.some((m) => m.id === models.current.model)),
      `${models.current.provider}/${models.current.model}`,
    );

    // 8. 预设名册 —— 两代都有这个端点,返回形状一致,正好当跨版本的形状哨兵。
    const presets = await client.listAgentPresets();
    const presetIds = (presets.presets ?? []).map((p: any) => p.id);
    ok("agentPreset.list 有内容", presetIds.length > 0, presetIds.slice(0, 5).join(", "));

    // 9. modern 专属:`listSessions()` 的 agentPreset 回填。
    //    0.1.5 把 `SessionSummary.agentPreset` 挪进了投影,`session/list` 顶层不再有 ——
    //    适配器得从控制流 baseline 的投影里补回来,否则侧边栏的预设标签整列消失。
    if (handle.kind === "modern") {
      const listed = await client.listSessions();
      const tagged = listed.items.filter((i: any) => typeof i.agentPreset === "string" && i.agentPreset.length > 0);
      ok("modern:listSessions 回填了 agentPreset", tagged.length > 0, `${tagged.length}/${listed.items.length} 个会话带预设`);
      const unknown = tagged.filter((i: any) => !presetIds.includes(i.agentPreset));
      ok("modern:回填的预设都是名册里真有的 id", unknown.length === 0, unknown.slice(0, 3).map((i: any) => i.agentPreset).join(", "));
    }
  } finally {
    // 10. 清理:取消(以防还在跑)并断开
    if (sessionId) {
      try {
        await client.cancelSession(sessionId);
      } catch {}
    }
    client.dispose();
    if (sessionId && process.env.DSH_TEST_KEEP !== "1") {
      await new Promise((r) => setTimeout(r, 300));
      removeSessionDirs([sessionId]);
    }
  }

  console.log("\n=== 集成测试结果 ===");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("❌")).length;
  console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("测试崩溃:", error);
  process.exit(1);
});
