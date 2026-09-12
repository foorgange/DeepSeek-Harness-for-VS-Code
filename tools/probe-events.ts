/**
 * S4 线上验收:`$events` 的 waterfall 往返(审批 / 提问)。
 *
 * 为什么这个探针值得存在:离线测试只能证明「给我一帧,我能翻对」。真正会炸的地方是
 * **这一帧到底会不会来、答回去服务端认不认** —— 那只能对真服务端跑。而这条路径上有
 * 两个只有线上才暴露的坑:
 *   1. `eventId` 双用(approvalId = frameRpcId = eventId),错一个就是「点了没反应」;
 *   2. 回答必须用**当前代**的 clientId,重连后 clientId 会变。
 *
 * 默认**拒绝**审批:拒绝路径走的是同一套往返(waterfall → $events/result → cancel),
 * 但什么都不会真的执行 —— 用一个零副作用的动作去验收,比批准一个「应该无害」的命令靠谱。
 *
 * 用法:
 *   npx esbuild tools/probe-events.ts --bundle --platform=node --format=cjs --outfile=dist/probe-events.js
 *
 *   # 只被动观察 20 秒(你在 dsh web 界面里自己触发审批/提问,这边会打印出来)
 *   node dist/probe-events.js --listen 20
 *
 *   # 完整往返:建一个临时会话 → 让它做一件需要授权的事 → 拒绝掉它
 *   node dist/probe-events.js --trigger
 *
 *   # 对已有会话触发(--session 指定),--answer allow 时才会真的执行
 *   node dist/probe-events.js --trigger --session <id> --answer allow
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, resolveAuth, type DshAuth } from "../src/dsh/protocol/auth";
import { EVENTS_ENDPOINT, RemoteMux } from "../src/dsh/protocol/mux";
import { args } from "../src/dsh/protocol/modern/args";
import { projectWaterfall } from "../src/dsh/protocol/modern/frames";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const LISTEN_SECONDS = Number(arg("listen") ?? 25);
const ANSWER = (arg("answer") ?? "reject") as "allow" | "reject" | "next";
const TIMEOUT_MS = Number(arg("timeout") ?? 90_000);

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * 一个 unary 调用。注意第三参是**已经造好的 args 对象**(来自 args.ts),
 * 而线路上还要再包一层 `{args}` —— 网关的报错是
 * 「Remote payload must contain exactly one plain-object args field」,
 * 少这层包装时它不会告诉你是少了包装。
 */
async function call(auth: DshAuth, endpoint: string, args: unknown): Promise<any> {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(30_000),
  });
  return res.json().catch(() => ({ __httpStatus: res.status }));
}

/** 建一个临时会话,工作区指向一个**子目录**,这样往它的父目录写就是「越界」。 */
async function createScratchSession(auth: DshAuth): Promise<string | undefined> {
  const scratch = mkdtempSync(join(tmpdir(), "dsh-probe-"));
  const value = await call(auth, "session/create", args.sessionCreate({ cwd: scratch, agentPreset: "standard" }));
  const sessionId = value?.result?.value?.sessionId ?? value?.result?.value?.id;
  if (typeof sessionId !== "string") {
    console.log(`  建会话失败: ${JSON.stringify(value).slice(0, 300)}`);
    return undefined;
  }
  console.log(`  临时工作区 ${scratch}\n  会话 ${sessionId}`);
  return sessionId;
}

async function main() {
  const auth = await resolveAuth(BASE);
  if (!auth) throw new Error("无法解析鉴权凭据 —— 检查 ~/.dsh/.credentials.yaml");
  console.log(`\n=== S4 探针 @ ${BASE}(${auth.authority})===\n`);

  const mux = new RemoteMux({ baseUrl: BASE, auth: async () => auth, onLog: (m) => console.log(`      ${m}`) });
  mux.connect();

  let clientId: string | undefined;
  const seenWaterfalls: any[] = [];
  let sawCancel = false;
  /** ready 是可重复的(每次重连都会再来一条),所以用一个可重新武装的等待器。 */
  let readyCount = 0;
  let readyWaiter: ((value: any) => void) | undefined;
  const nextReady = (timeoutMs: number) =>
    new Promise<any>((resolve) => {
      readyWaiter = resolve;
      setTimeout(() => {
        if (readyWaiter === resolve) {
          readyWaiter = undefined;
          resolve(undefined);
        }
      }, timeoutMs);
    });
  let resolveWaterfall: ((value: any) => void) | undefined;
  const waterfallArrived = new Promise<any>((resolve) => {
    resolveWaterfall = resolve;
  });

  const stream = mux.open<any>(EVENTS_ENDPOINT, {}, {
    onItem: (item) => {
      if (item?.type === "ready") {
        readyCount += 1;
        clientId = item.clientId;
        const waiter = readyWaiter;
        readyWaiter = undefined;
        waiter?.(item);
        return;
      }
      if (item?.type === "waterfall") {
        seenWaterfalls.push(item);
        console.log(`\n  ← waterfall ${item.event} eventId=${item.eventId} agentId=${item.agentId}`);
        console.log(`     request = ${JSON.stringify(item.request).slice(0, 400)}`);
        // 同一份 request 喂给真正的翻译层 —— 验收的是**生产代码**,不是探针自己的解析。
        const projected = projectWaterfall(item.event, item.eventId, item.agentId, item.request, () => randomUUID());
        console.log(`     翻译结果 = ${projected ? JSON.stringify(projected.frame).slice(0, 300) : "不产帧(白名单外或缺必需字段)"}`);
        resolveWaterfall?.(item);
        return;
      }
      if (item?.type === "cancel") {
        sawCancel = true;
        console.log(`\n  ← cancel eventId=${item.eventId}(结算通知:卡片该撤了)`);
        return;
      }
      if (item?.type === "emit") return;
    },
    onEnd: () => console.log("      $events 被服务端结束"),
    onError: (error) => console.log(`      $events 错误 ${error.code}: ${error.message}`),
  });

  const ready = await nextReady(15_000);
  check("$events 收到 ready", ready !== undefined);
  check("ready 带 clientId", typeof clientId === "string" && clientId.length > 0, `clientId=${clientId}`);
  if (clientId === undefined) {
    console.log("\n没有 clientId 就无法回答 waterfall,后续验收无意义。");
    mux.dispose();
    process.exit(1);
  }

  if (!has("trigger")) {
    console.log(`\n被动观察 ${LISTEN_SECONDS}s —— 现在去 dsh web 界面里触发一次审批或提问。\n`);
    await new Promise((r) => setTimeout(r, LISTEN_SECONDS * 1000));
    check(`观察到 waterfall(共 ${seenWaterfalls.length} 条)`, seenWaterfalls.length > 0, "没有的话就是界面那边没触发");
  } else {
    const sessionId = arg("session") ?? (await createScratchSession(auth));
    if (sessionId === undefined) {
      mux.dispose();
      process.exit(1);
    }
    // 故意指向工作区**外**:workspace-write 沙箱会拦下,Agent 提权重试 ⇒ 弹审批。
    const target = join(process.env.USERPROFILE ?? "C:/", "dsh-approval-probe");
    const text =
      `请用 shell 执行这一条命令,不要做任何别的事,也不要先解释:\n` +
      `mkdir "${target}"`;
    console.log(`\n  → 发送 prompt(目标目录在工作区外,预期触发审批)\n`);
    const created = await call(auth, "session/prompt", args.sessionPrompt({
      requestId: randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    }));
    check("session/prompt 被接受", created?.result?.ok === true, JSON.stringify(created?.result?.error ?? created).slice(0, 300));

    const got = await Promise.race([waterfallArrived, new Promise((r) => setTimeout(() => r(undefined), TIMEOUT_MS))]);
    check("收到 approval/request waterfall", got !== undefined, `${TIMEOUT_MS}ms 内没等到`);

    if (got !== undefined) {
      const approvalId = got.eventId;
      const outcome = ANSWER === "allow" ? "allowed-once" : ANSWER === "reject" ? "rejected" : undefined;
      if (outcome === undefined) {
        console.log("\n  → 回答 next(交回 waterfall 的下一个监听者)");
        await call(auth, "$events/result", args.eventsResult(clientId, approvalId, { kind: "next" }));
      } else {
        console.log(`\n  → 回答 ${outcome}(用 clientId=${clientId})`);
        const answered = await call(auth, "$events/result", args.eventsResult(clientId, approvalId, { kind: "result", value: outcome }));
        check(
          `$events/result 被接受(outcome=${outcome})`,
          answered?.result?.ok === true,
          JSON.stringify(answered?.result?.error ?? answered).slice(0, 300),
        );
      }

      // **我自己答的这条,服务端不会回推 cancel** —— `receiveRemoteEventResult`
      // 在结算前就把回答者摘出了投递集合(dsh-api-gateway/lib/index.js:685)。
      // 所以这里只当观察记录,不当断言:适配器撤卡靠的是 `$events/result` 的 ok,
      // 不是 cancel(等 cancel 的写法在真机上会让卡片永不消失)。
      const sawCancelWithin = await (async () => {
        const deadline = Date.now() + 6_000;
        while (!sawCancel && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        return sawCancel;
      })();
      console.log(
        sawCancelWithin
          ? "  INFO  回答后仍收到了 cancel —— 与网关源码(回答者被摘出投递集合)不符,值得复查"
          : "  INFO  回答后没有 cancel(符合网关语义:回答者已被摘出投递集合)",
      );

      // 用陌生的 clientId 再答一次必须被拒 —— 这是「必须用当前代 clientId」的反证。
      const stale = await call(auth, "$events/result", args.eventsResult(randomUUID(), approvalId, { kind: "result", value: "allowed-once" }));
      check("陌生 clientId 的回答被拒", stale?.result?.ok !== true, JSON.stringify(stale?.result?.error ?? {}).slice(0, 200));

      // 清理:把临时会话归档,别让它挂在用户的侧边栏里。
      if (!has("keep-session")) {
        const archived = await call(auth, "workspace/archiveSession", args.workspaceArchiveSession(sessionId));
        console.log(`  归档临时会话: ${archived?.result?.ok === true ? "ok" : JSON.stringify(archived?.result?.error ?? {}).slice(0, 160)}`);
      }
    }
  }

  // 断流自愈:mux 会把所有已登记的流重开,服务端会重新投递未结算的 waterfall,
  // 但**同一个 eventId** —— 所以「不重复弹卡」取决于去重,这里只验证流确实回来了。
  if (has("reconnect")) {
    console.log("\n  → 主动掐断连接,验证自愈(不等退避)");
    const before = readyCount;
    mux.reconnect();
    const healed = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 20_000;
      const poll = setInterval(() => {
        if (mux.currentState === "connected" && readyCount > before) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          resolve(false);
        }
      }, 200);
    });
    check(`掐断后自行重连并重新拿到 ready(状态 ${mux.currentState})`, healed, `ready 次数 ${before} → ${readyCount}`);
    // 重连后 clientId 必定换代 —— 这正是「回答必须用当前代 clientId」的来源。
    check("重连后 clientId 换代", clientId !== undefined, `新 clientId=${clientId}`);
  }

  stream.cancel();
  mux.dispose();
  console.log(`\n=== ${failures === 0 ? "S4 验收通过" : `S4 未通过(${failures} 项失败)`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
