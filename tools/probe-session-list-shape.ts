/**
 * 一次性形状探针:`session/list` 到底给了哪些投影键、多少个会话真有 agentPreset。
 * (S2 阶段用来定位「agentPreset 回填没生效」是回填写错还是服务端根本没给。)
 */

import { randomUUID } from "node:crypto";
import { authHeaders, resolveAuth } from "../src/dsh/protocol/auth";

const LIVE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

function ipc(method: string) {
  const m = method.split("/");
  return m.length === 3 ? `${m[0]}/${m[1]}` : method;
}

async function main() {
  const auth = await resolveAuth(LIVE, {});
  if (!auth) throw new Error("无凭据");
  const res = await fetch(`${LIVE}/api/${ipc("session/list")}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "session/list", payload: { args: { _request: {} } } }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json();
  const items: any[] = body?.result?.value?.items ?? [];
  console.log(`HTTP ${res.status} · ${items.length} 个会话`);

  const keyCount = new Map<string, number>();
  let topLevelAgentPreset = 0;
  let projAgentPreset = 0;
  for (const it of items) {
    for (const k of Object.keys(it.projections?.values ?? {})) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    if (typeof it.agentPreset === "string") topLevelAgentPreset += 1;
    if (typeof it.projections?.values?.["agentPreset"] === "string") projAgentPreset += 1;
  }
  console.log(`顶层 agentPreset 非空: ${topLevelAgentPreset}`);
  console.log(`投影 agentPreset 非空: ${projAgentPreset}`);
  console.log("投影键分布:");
  for (const [k, n] of [...keyCount].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  console.log("\n前 3 项原样:");
  console.log(JSON.stringify(items.slice(0, 3), null, 2).slice(0, 4000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
