/**
 * S0 验收探针:对真实 dsh 0.1.5 打通「鉴权 → unary RPC → 复用流」全链路。
 *
 * 用法:
 *   npx esbuild tools/probe-modern.ts --bundle --platform=node --format=cjs --outfile=dist/probe.js
 *   node dist/probe.js
 * 环境变量 DSH_URL 覆盖服务地址(默认 http://127.0.0.1:3080)。
 *
 * 这个脚本是移植的「地基验收」:它绿了才说明新协议的鉴权与传输是通的,
 * 后面所有适配器代码才有意义;它红着,后面写多少都是白写。
 */

import { randomUUID } from "node:crypto";
import { authHeaders, resolveAuth, type DshAuth } from "../src/dsh/protocol/auth";
import { EVENTS_ENDPOINT, RemoteMux } from "../src/dsh/protocol/mux";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** 最小 unary 调用(真正的适配器在 S3 才写,这里够验收用)。 */
async function call(auth: DshAuth, endpoint: string, args: unknown): Promise<{ status: number; body: any }> {
  const rpcId = randomUUID();
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(10_000),
  });
  let body: any = undefined;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

function unwrap(result: { status: number; body: any }): { ok: boolean; value?: any; error?: any } {
  if (result.body?.result?.ok === true) return { ok: true, value: result.body.result.value };
  return { ok: false, error: result.body?.result?.error ?? { code: `http/${result.status}` } };
}

async function main() {
  console.log(`\n=== S0 探针 @ ${BASE} ===\n`);

  // --- 1. 未鉴权时必须 401(这既是门禁的证明,也是「服务端是 0.1.5」的判据) ---
  console.log("[1] 无凭据探测");
  const bare = await fetch(`${BASE}/api/session/modelCatalog`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "session/modelCatalog", payload: { args: {} } }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  check("无 Cookie 请求被拒(401 ⇒ 服务端为 0.1.5)", bare?.status === 401, `HTTP ${bare?.status ?? "无响应"}`);

  // --- 2. 取凭据 ---
  console.log("\n[2] 解析鉴权凭据");
  const auth = await resolveAuth(BASE);
  if (!auth) {
    console.log("  FAIL  无法解析任何鉴权凭据 —— 检查 ~/.dsh/.credentials.yaml 是否存在浏览器会话记录");
    process.exit(1);
  }
  check(`凭据已解析(authority=${auth.authority}, 来源=${auth.via})`, true);

  // --- 3. unary:modelCatalog(零参端点,args 必须显式传 {}) ---
  console.log("\n[3] unary RPC");
  const catalog = await call(auth, "session/modelCatalog", {});
  const catalogValue = unwrap(catalog);
  check("session/modelCatalog 调用成功", catalogValue.ok, catalogValue.error ? JSON.stringify(catalogValue.error) : `HTTP ${catalog.status}`);
  if (catalogValue.ok) {
    const models = catalogValue.value?.groups?.flatMap((g: any) => g.models?.map((m: any) => m.id) ?? []) ?? [];
    check("模型目录非空", models.length > 0, `default=${catalogValue.value?.default?.provider}/${catalogValue.value?.default?.model}`);
    check(
      "DeepSeek-V41-Flash 在目录中",
      models.includes("deepseek-flash"),
      `可见模型: ${models.join(", ")}`,
    );
  }

  // --- 4. unary:session/list(参数名带下划线:_request) ---
  const sessions = await call(auth, "session/list", { _request: {} });
  const sessionsValue = unwrap(sessions);
  check(
    "session/list 调用成功(args 键名为 _request)",
    sessionsValue.ok,
    sessionsValue.ok ? `共 ${sessionsValue.value?.items?.length ?? 0} 个会话` : JSON.stringify(sessionsValue.error),
  );

  // --- 5. unary:workspace/follow 的替代验证 —— workspace 命名空间可达性 ---
  const wsc = await call(auth, "workspace/create", { request: { path: process.cwd() } });
  check("workspace/create 调用成功", unwrap(wsc).ok, unwrap(wsc).ok ? "" : JSON.stringify(unwrap(wsc).error));

  // --- 6. 复用流:$events 的开局 ready 帧 ---
  console.log("\n[4] 复用流 remote.mux");
  const mux = new RemoteMux({
    baseUrl: BASE,
    auth: async () => auth,
    onLog: (m) => console.log(`      ${m}`),
  });

  const ready = await new Promise<any>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 12_000);
    mux.connect();
    mux.open(EVENTS_ENDPOINT, {}, {
      onItem: (value: any) => {
        if (value?.type === "ready") {
          clearTimeout(timer);
          resolve(value);
        }
      },
      onError: (error) => {
        clearTimeout(timer);
        resolve({ __error: error });
      },
    });
  });

  check("$events 流收到 ready 开局帧", Boolean(ready && !ready.__error), ready?.__error ? JSON.stringify(ready.__error) : "");
  if (ready && !ready.__error) {
    check("ready 帧携带 clientId 与 host.home", typeof ready.clientId === "string" && typeof ready.host?.home === "string", `home=${ready.host?.home}`);
  }

  // --- 7. 会话跟随流:snapshot 的 cursor(历史分页的 throughSeq 来源) ---
  const firstSession = sessionsValue.value?.items?.[0]?.sessionId;
  if (typeof firstSession === "string") {
    const snapshot = await new Promise<any>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 12_000);
      mux.open("session/follow", { request: { address: { kind: "session", sessionId: firstSession }, assistantStream: true } }, {
        onItem: (value: any) => {
          if (value?.type === "snapshot") {
            clearTimeout(timer);
            resolve(value);
          }
        },
        onError: (error) => {
          clearTimeout(timer);
          resolve({ __error: error });
        },
      });
    });
    check(
      "session/follow 收到 snapshot",
      Boolean(snapshot && !snapshot.__error),
      snapshot?.__error ? JSON.stringify(snapshot.__error) : `cursor=${snapshot?.cursor} records=${snapshot?.records?.length} projections=${Object.keys(snapshot?.projections?.values ?? {}).join(",")}`,
    );
  } else {
    console.log("  SKIP  session/follow(当前没有会话可跟随)");
  }

  mux.dispose();
  console.log(`\n=== ${failures === 0 ? "S0 通过" : `S0 未通过(${failures} 项失败)`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
