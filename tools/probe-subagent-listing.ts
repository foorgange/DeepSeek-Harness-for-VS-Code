/**
 * 子会话在 session/list 里长什么样:是否被标为子会话、有多少个。
 * 决定「子会话读不出来」这件事在本机是否真的可见(会话列表会不会列它们、能不能点开)。
 */
import { randomUUID } from "node:crypto";
import { authHeaders, resolveAuth } from "../src/dsh/protocol/auth";

const LIVE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const SUBAGENT_IDS = (process.env.DSH_SUBAGENT_IDS ?? "").split(",").filter(Boolean);

async function main() {
  const auth = await resolveAuth(LIVE, {});
  if (!auth) throw new Error("无凭据");
  const res = await fetch(`${LIVE}/api/session/list`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "session/list", payload: { args: { _request: {} } } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body: any = await res.json();
  const items: any[] = body?.result?.value?.items ?? [];
  console.log(`HTTP ${res.status} · ${items.length} 个会话`);
  console.log("单条样本键:", Object.keys(items[0] ?? {}).join(", "));
  console.log("\n样本:");
  console.log(JSON.stringify(items[0], null, 2).slice(0, 1500));
  if (SUBAGENT_IDS.length > 0) {
    console.log("\n目标子会话在列表里的样子:");
    for (const id of SUBAGENT_IDS) {
      const hit = items.find((i) => i.sessionId === id || i.id === id);
      console.log(` ${id}: ${hit ? JSON.stringify(hit).slice(0, 400) : "(不在列表里)"}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
