/**
 * 把真实 mux 帧录成 JSON 夹具 —— 第 1 层测试的**唯一**可信输入。
 *
 * 为什么必须录、不能手写:手写的夹具只能固化「我以为服务端会发什么」。这个移植里
 * 已经栽过一次 —— `dsh-client-connection/lib/client.js` 那份「参照实现」其实是
 * 夹具(FxInbox/fixtureQuestions/FIXTURE_HOME),它的 control baseline 里带着
 * `approvals: []`/`questions: []` 两个**根本不存在**的字段,照它写就会把
 * 审批卡片的初始化逻辑建在一个永远不来的字段上。录制的帧不带任何人的预期。
 *
 * 用法:
 *   npx esbuild tools/record-mux.ts --bundle --platform=node --format=cjs --outfile=dist/record.js
 *   node dist/record.js                     # 录全部三条流,各等 8 秒
 *   node dist/record.js --seconds 20        # 等久一点(想手动触发审批/提问时用)
 *   node dist/record.js --session <id>      # 额外录一条 session/follow 的 snapshot
 *   node dist/record.js --out tests/fixtures/mux-<name>.json
 *
 * 录完的帧**原样**写盘(`{stream, items:[{t, value}]}`),不做任何归一化 ——
 * 一旦在这里「顺手修一下」,夹具就不再是服务端的证词了。
 *
 * 想录到审批/提问:跑起来之后在本机 dsh 的 web 界面里让 Agent 调一个需要授权的
 * 工具(或直接问它一个问题),那两条 waterfall 就会落在 $events 里。
 *
 * 也可以让脚本自己造一条(**推荐,可复现**):
 *   node dist/record.js --trigger          # 建临时会话 → 让它往工作区外写 → 录到审批
 * 录完会**自动拒绝**那条审批并把临时会话归档 —— 拒绝走的是同一套往返但什么都不执行,
 * 所以录制本身没有任何副作用;而夹具里就多了一条**真实的** approval/request。
 * 录不到的话对应数组就是空的 —— 测试那边会跳过,不会假装覆盖了。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { authHeaders, resolveAuth, type DshAuth } from "../src/dsh/protocol/auth";
import { EVENTS_ENDPOINT, RemoteMux } from "../src/dsh/protocol/mux";
import { args } from "../src/dsh/protocol/modern/args";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const SECONDS = Number(arg("seconds") ?? 8);
const OUT = arg("out");

interface RecordedItem {
  /** 毫秒偏移(相对连接建立),只为让人读的时候有个先后感,不参与断言。 */
  t: number;
  value: unknown;
  /**
   * 该帧**连续重复**出现的次数(缺省即 1)。
   *
   * 为什么要折叠:真机上 `commands/change` 会以每秒二十几条的节奏连刷**一模一样**的
   * 空 payload,不折叠的话夹具 96% 都是同一条,既看不出重点也白占体积。折叠是**无损**的
   * —— 帧本身与它出现的次数都还在,测试按 `repeat` 展开即可(见 protocol-frames.test.js)。
   */
  repeat?: number;
}

interface RecordedStream {
  endpoint: string;
  args: unknown;
  items: RecordedItem[];
  ended?: { at: number; error?: unknown };
}

/** 同时抓一条 unary 的返回,好让夹具里有「模型目录 / 会话列表」的真实形状。 */
async function call(auth: DshAuth, endpoint: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({
      type: "client-request",
      rpcId: crypto.randomUUID(),
      method: endpoint,
      payload: { args },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json().catch(() => ({ __httpStatus: res.status }));
}

async function main() {
  const auth = await resolveAuth(BASE);
  if (!auth) throw new Error("无法解析鉴权凭据 —— 检查 ~/.dsh/.credentials.yaml");
  console.log(`录制目标 ${BASE}(authority=${auth.authority}, 来源=${auth.via}),每条流等 ${SECONDS}s\n`);

  const mux = new RemoteMux({ baseUrl: BASE, auth: async () => auth, onLog: () => {} });
  const started = Date.now();
  const streams = new Map<string, RecordedStream>();
  const record = (endpoint: string, value: unknown) => {
    const stream = streams.get(endpoint);
    if (stream === undefined) return;
    // 连续重复的帧折叠成 repeat 计数(见 RecordedItem.repeat 的说明)。
    const last = stream.items[stream.items.length - 1];
    if (last !== undefined && JSON.stringify(last.value) === JSON.stringify(value)) {
      last.repeat = (last.repeat ?? 1) + 1;
      return;
    }
    stream.items.push({ t: Date.now() - started, value });
  };
  /** 录到的 waterfall 的 eventId + 当前代 clientId —— 录完要拿它们把审批结算掉。 */
  const pendingEventIds: string[] = [];
  let eventsClientId: string | undefined;

  const endpoints: { endpoint: string; args: unknown }[] = [
    { endpoint: EVENTS_ENDPOINT, args: {} },
    { endpoint: "session/control", args: {} },
    { endpoint: "workspace/follow", args: {} },
  ];

  mux.connect();
  for (const spec of endpoints) {
    streams.set(spec.endpoint, { endpoint: spec.endpoint, args: spec.args, items: [] });
    mux.open(spec.endpoint, spec.args, {
      onItem: (value) => {
        record(spec.endpoint, value);
        if (spec.endpoint !== EVENTS_ENDPOINT) return;
        const item = value as { type?: string; clientId?: string; eventId?: string };
        if (item?.type === "ready" && typeof item.clientId === "string") eventsClientId = item.clientId;
        else if (item?.type === "waterfall" && typeof item.eventId === "string") pendingEventIds.push(item.eventId);
      },
      onEnd: () => {
        const s = streams.get(spec.endpoint);
        if (s && !s.ended) s.ended = { at: Date.now() - started };
      },
      onError: (error) => {
        const s = streams.get(spec.endpoint);
        if (s && !s.ended) s.ended = { at: Date.now() - started, error };
        console.log(`  ${spec.endpoint} 报错: ${error.code} — ${error.message}`);
      },
    });
  }

  // 会话跟随是可选的:没有会话就没得跟,不算失败。
  const sessions = (await call(auth, "session/list", { _request: {} })) as any;
  const items: any[] = sessions?.result?.value?.items ?? [];
  const sessionId = arg("session") ?? items[0]?.sessionId;
  if (typeof sessionId === "string") {
    const followArgs = { request: { address: { kind: "session", sessionId }, assistantStream: true } };
    streams.set("session/follow", { endpoint: "session/follow", args: followArgs, items: [] });
    mux.open("session/follow", followArgs, {
      onItem: (value) => record("session/follow", value),
      onEnd: () => {
        const s = streams.get("session/follow");
        if (s && !s.ended) s.ended = { at: Date.now() - started };
      },
      onError: (error) => {
        const s = streams.get("session/follow");
        if (s && !s.ended) s.ended = { at: Date.now() - started, error };
        console.log(`  session/follow 报错: ${error.code} — ${error.message}`);
      },
    });
    console.log(`跟随会话 ${sessionId}`);
  } else {
    console.log("没有会话可跟随 —— 跳过 session/follow");
  }

  // `--trigger`:自己造一条真实的审批 waterfall 落进录音里。
  // 目标是**工作区外**的目录,所以 workspace-write 沙箱会拦下、Agent 提权重试 ⇒ 弹审批。
  // 全程不批准,录完再拒绝 —— 那个目录永远不会被创建。
  let triggerSession: string | undefined;
  if (has("trigger")) {
    const scratch = mkdtempSync(join(tmpdir(), "dsh-record-"));
    const created = (await call(auth, "session/create", args.sessionCreate({ cwd: scratch, agentPreset: "standard" }))) as any;
    triggerSession = created?.result?.value?.sessionId;
    if (typeof triggerSession !== "string") {
      console.log(`  触发会话创建失败: ${JSON.stringify(created).slice(0, 200)}`);
      triggerSession = undefined;
    } else {
      const target = join(process.env.USERPROFILE ?? "C:/", "dsh-approval-probe");
      const sent = (await call(auth, "session/prompt", args.sessionPrompt({
        requestId: randomUUID(),
        sessionId: triggerSession,
        mode: "queue",
        content: [{ type: "text", text: `请用 shell 执行这一条命令,不要做任何别的事,也不要先解释:\nmkdir "${target}"` }],
      }))) as any;
      console.log(`  触发 ${triggerSession}(工作区 ${scratch})→ ${sent?.result?.ok === true ? "已投递" : JSON.stringify(sent).slice(0, 160)}`);
    }
  }

  await new Promise((r) => setTimeout(r, SECONDS * 1000));

  // 顺带把 unary 的真实形状也录进来:models.ts / listSessions 的补全逻辑要对着它写。
  const unary: Record<string, unknown> = {
    "session/list": sessions,
    "session/modelCatalog": await call(auth, "session/modelCatalog", {}),
  };

  // 收尾:把录到的审批**拒绝**掉(同一套往返、零副作用),再归档临时会话。
  // 不做这步的话 Agent 会一直卡在等授权上,而且临时会话会挂在用户的侧边栏里。
  //
  // 顺序有讲究:**先收尾、后写盘**。归档会推一条 `workspace/follow` 的 `archived`
  // 增量,提前写盘的话那条增量就丢了 —— 而它恰好是「归档集合如何流到界面」的唯一
  // 真实样本(0.1.5 里没有 workspace/* 事件)。
  if (pendingEventIds.length > 0 && eventsClientId !== undefined) {
    for (const eventId of pendingEventIds) {
      const answered = (await call(auth, "$events/result", args.eventsResult(eventsClientId, eventId, { kind: "result", value: "rejected" }))) as any;
      console.log(`  结算录到的审批 ${eventId}: ${answered?.result?.ok === true ? "ok" : JSON.stringify(answered?.result?.error ?? {}).slice(0, 140)}`);
    }
  }
  if (triggerSession !== undefined) {
    const archived = (await call(auth, "workspace/archiveSession", args.workspaceArchiveSession(triggerSession))) as any;
    console.log(`  归档触发会话 ${triggerSession}: ${archived?.result?.ok === true ? "ok" : JSON.stringify(archived?.result?.error ?? {}).slice(0, 140)}`);
    // 给归档增量一点到达时间,否则它可能还在路上就写盘了。
    await new Promise((r) => setTimeout(r, 1500));
  }

  const fixture = {
    recordedAt: new Date().toISOString(),
    base: BASE,
    authority: auth.authority,
    streams: [...streams.values()],
    unary,
  };
  const out = resolve(OUT ?? `tests/fixtures/mux-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, null, 2));
  mux.dispose();

  console.log("\n=== 录制结果 ===");
  for (const s of streams.values()) {
    const kinds = s.items.map((i) => (i.value as any)?.type ?? "?").join(", ");
    console.log(`  ${s.endpoint.padEnd(18)} ${String(s.items.length).padStart(4)} 帧  [${kinds || "空"}]`);
  }
  console.log(`\n已写入 ${out}`);
}

main().catch((error) => {
  console.error("录制失败:", error);
  process.exit(1);
});
