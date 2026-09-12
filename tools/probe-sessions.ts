/**
 * 摸底:0.1.1 写下的 v0 会话有多少能被 0.1.5 打开。
 *
 * 起因:S0 探针里 session/follow 对某个旧会话报
 *   dsh-session-format-v0-to-v1 refuses this format v0 Session:
 *   permission/preset 0 data has unexpected member "origin"
 * 这是 dsh 自身的 v0→v1 迁移问题,与扩展无关,但会决定存量会话还能不能用。
 *
 * 用法:
 *   npx esbuild tools/probe-sessions.ts --bundle --platform=node --format=cjs --outfile=dist/probe-sessions.js
 *   node dist/probe-sessions.js [--limit N]
 */

import { randomUUID } from "node:crypto";
import { authHeaders, resolveAuth, type DshAuth } from "../src/dsh/protocol/auth";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 200;

async function call(auth: DshAuth, endpoint: string, args: unknown): Promise<any> {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body: any = await res.json().catch(() => undefined);
  if (body?.result?.ok === true) return { ok: true, value: body.result.value };
  return { ok: false, error: body?.result?.error ?? { code: `http/${res.status}` } };
}

async function main() {
  const auth = await resolveAuth(BASE);
  if (!auth) throw new Error("无法解析鉴权凭据");

  const listed = await call(auth, "session/list", { _request: {} });
  if (!listed.ok) throw new Error(`session/list 失败: ${JSON.stringify(listed.error)}`);
  const items: any[] = listed.value.items ?? [];
  const sample = items.slice(0, LIMIT);
  console.log(`共 ${items.length} 个会话,抽查前 ${sample.length} 个…\n`);

  const failures = new Map<string, string[]>();
  let ok = 0;
  let processed = 0;

  // 用一条 mux 串行跟随,避免并发压垮服务端
  const { RemoteMux } = await import("../src/dsh/protocol/mux");
  const mux = new RemoteMux({ baseUrl: BASE, auth: async () => auth });
  mux.connect();
  await new Promise((r) => setTimeout(r, 800));

  for (const item of sample) {
    processed += 1;
    const result = await new Promise<any>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "timeout" }), 8000);
      mux.open("session/follow", { request: { address: { kind: "session", sessionId: item.sessionId } } }, {
        onItem: (value: any) => {
          if (value?.type === "snapshot") {
            clearTimeout(timer);
            resolve({ kind: "ok" });
          }
        },
        onError: (error) => {
          clearTimeout(timer);
          resolve({ kind: "error", error });
        },
      });
    });
    if (result.kind === "ok") {
      ok += 1;
    } else {
      // 归一化错误信息:去掉会话 id 与路径,只留原因骨架
      const raw = result.kind === "timeout" ? "超时无响应" : String(result.error?.message ?? result.error?.code ?? "未知");
      const key = raw
        .replace(/session-[0-9a-f-]{36}/g, "<sessionId>")
        .replace(/[A-Z]:\\[^\s"]+/g, "<path>")
        .slice(0, 220);
      const bucket = failures.get(key) ?? [];
      bucket.push(item.sessionId);
      failures.set(key, bucket);
    }
    if (processed % 20 === 0) console.log(`  …已查 ${processed}/${sample.length}(成功 ${ok})`);
  }

  mux.dispose();
  console.log(`\n=== 结果 ===`);
  console.log(`可打开: ${ok} / ${sample.length}`);
  console.log(`打不开: ${sample.length - ok}\n`);
  for (const [reason, ids] of [...failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`[${ids.length} 个] ${reason}`);
    console.log(`          例: ${ids.slice(0, 3).join(", ")}\n`);
  }
}

main().catch((error) => {
  console.error("摸底失败:", error);
  process.exit(1);
});
