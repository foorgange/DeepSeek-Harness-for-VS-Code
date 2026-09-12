/**
 * S2 侦察:0.1.5 对「legacy 探针」到底回什么状态码 —— 这是 detect.ts 的判据来源。
 *
 * 探测顺序必须是**先鉴权、后探测**:0.1.5 上所有 /api 路由都挂了门禁,
 * 不带 Cookie 一律 401,那个 401 是「没认证」不是「协议不对」,拿它当判据会误判。
 *
 * 用法:
 *   npx esbuild tools/probe-detect.ts --bundle --platform=node --format=cjs --outfile=dist/probe-detect.js
 *   node dist/probe-detect.js
 */

import { randomUUID } from "node:crypto";
import { authHeaders, resolveAuth, type DshAuth } from "../src/dsh/protocol/auth";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

interface Probe {
  label: string;
  path: string;
  method: string;
  payload: unknown;
}

const PROBES: Probe[] = [
  { label: "legacy 点号路由 host.describe", path: "host.describe", method: "host.describe", payload: {} },
  { label: "legacy 点号路由 session.list", path: "session.list", method: "session.list", payload: {} },
  { label: "legacy 点号路由 session.models", path: "session.models", method: "session.models", payload: { sessionId: "x" } },
  { label: "modern 斜杠路由 session/modelCatalog", path: "session/modelCatalog", method: "session/modelCatalog", payload: { args: {} } },
  { label: "modern 斜杠路由 session/list", path: "session/list", method: "session/list", payload: { args: { _request: {} } } },
  { label: "不存在的路由 ns/nope", path: "zzz/nope", method: "zzz/nope", payload: { args: {} } },
];

async function probe(auth: DshAuth | undefined, p: Probe) {
  const url = `${BASE}/api/${p.path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? authHeaders(auth) : {}) },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: p.method, payload: p.payload }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let summary = text.slice(0, 150);
  try {
    const body = JSON.parse(text);
    if (body?.result?.ok === true) {
      const v = body.result.value;
      const keys = v && typeof v === "object" ? Object.keys(v).slice(0, 6).join(",") : typeof v;
      summary = `ok · value={${keys}}`;
    } else if (body?.result?.error) {
      summary = `err · ${body.result.error.code}: ${String(body.result.error.message).slice(0, 90)}`;
    }
  } catch {
    /* 非 JSON(可能是 HTML 错误页) */
  }
  return { status: res.status, summary };
}

async function main() {
  const auth = await resolveAuth(BASE);
  console.log(`目标 ${BASE} · 鉴权路径 ${auth?.via ?? "无"}\n`);

  for (const [label, a] of [
    ["不带 Cookie", undefined],
    ["带 Cookie", auth],
  ] as [string, DshAuth | undefined][]) {
    console.log(`--- ${label} ---`);
    for (const p of PROBES) {
      let r: { status: number; summary: string };
      try {
        r = await probe(a, p);
      } catch (error) {
        r = { status: 0, summary: `抛错 ${error instanceof Error ? error.message : String(error)}` };
      }
      console.log(`  ${String(r.status).padStart(3)}  ${p.label.padEnd(38)} ${r.summary}`);
    }
    console.log();
  }
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
