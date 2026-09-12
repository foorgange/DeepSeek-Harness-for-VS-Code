/**
 * 值形状采集:把 S2/S6 要合成的几个返回值原样打出来,免得照着文档猜字段名。
 *   npx esbuild tools/probe-shapes.ts --bundle --platform=node --format=cjs --outfile=dist/probe-shapes.js
 *   node dist/probe-shapes.js
 */

import { randomUUID } from "node:crypto";
import { authHeaders, resolveAuth, type DshAuth } from "../src/dsh/protocol/auth";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

async function call(auth: DshAuth, endpoint: string, args: unknown): Promise<any> {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => undefined);
  if (body?.result?.ok === true) return body.result.value;
  throw new Error(`${endpoint} → ${JSON.stringify(body?.result?.error ?? { http: res.status })}`);
}

function show(label: string, value: unknown, depth = 3) {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(value, null, 2).split("\n").slice(0, depth === 3 ? 120 : 1000).join("\n"));
}

async function main() {
  const auth = await resolveAuth(BASE);
  if (!auth) throw new Error("无法解析鉴权凭据");

  const catalog = await call(auth, "session/modelCatalog", {});
  console.log("=== session/modelCatalog 顶层键 ===");
  console.log(Object.keys(catalog).join(", "));
  console.log("\n=== default(当前默认选择) ===");
  console.log(JSON.stringify(catalog.default, null, 2));
  console.log("\n=== routableProviders ===");
  console.log(JSON.stringify(catalog.routableProviders, null, 2)?.slice(0, 400));
  console.log("\n=== groups 形状(只取第一个 provider 与前两个模型) ===");
  const g0 = catalog.groups?.[0];
  console.log(JSON.stringify({ ...g0, models: g0?.models?.slice(0, 2) }, null, 2)?.slice(0, 3000));
  console.log("\n=== failures ===");
  console.log(JSON.stringify(catalog.failures, null, 2)?.slice(0, 500));

  const list = await call(auth, "session/list", { _request: {} });
  console.log("\n\n=== session/list 条目数 ===", list.items?.length);
  console.log("=== 第一条完整形状 ===");
  console.log(JSON.stringify(list.items?.[0], null, 2)?.slice(0, 4000));
}

main().catch((error) => {
  console.error("采集失败:", error);
  process.exit(1);
});
