/**
 * S0 验收(一):真机验证 serverManager 的两处修复。
 *
 * 1. isUp() —— 0.1.5 未鉴权的 `GET /` 返回 401。修复前这条被判成「服务端已死」,
 *    ensure() 会再拉起一个 dsh 抢同一端口;修复后必须直接返回「在线」,
 *    且**不能**留下 startedByUs=true。
 * 2. 令牌截获 —— 由扩展自己拉起一个独立端口(3099)的 dsh web,
 *    验证能从那行 URL 里读出启动令牌,并用它换到可用的 Cookie。
 *
 * 用法:
 *   npx esbuild tools/probe-server-manager.ts --bundle --platform=node --format=cjs \
 *     --external:vscode --outfile=dist/probe-server-manager.js
 *   node dist/probe-server-manager.js
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ServerManager } from "../src/dsh/serverManager";
import { authHeaders, authorityOf, resolveAuth, signCookie, readBrowserSessionSecret } from "../src/dsh/protocol/auth";

const LIVE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const SPARE_PORT = 3099;
const SPARE = `http://127.0.0.1:${SPARE_PORT}`;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log(`\n=== S0 验收 · serverManager @ ${LIVE} ===\n`);

  // ---------- 一、isUp 判定 ----------
  console.log("[1] isUp():401 必须算「在线」");
  const bare = await fetch(`${LIVE}/`, { headers: { accept: "text/html" } });
  check("线上服务端对未鉴权 GET / 返回 401", bare.status === 401, `HTTP ${bare.status}`);

  const manager = new ServerManager({ url: LIVE, command: "dsh", autoStart: true, timeoutSec: 30 }, () => {});
  check("isUp() 对 401 返回 true(修复前恒为 false)", (await manager.isUp()) === true);
  check("isUp() 对无人监听的端口返回 false", (await manager.isUp()) === true && (await new ServerManager({ url: SPARE, command: "dsh", autoStart: false, timeoutSec: 5 }, () => {}).isUp(1200)) === false, "3099 当前无人监听");

  console.log("\n[2] ensure():不得再拉起第二个服务端");
  const spawned: string[] = [];
  const manager2 = new ServerManager(
    { url: LIVE, command: "dsh", autoStart: true, timeoutSec: 30, onLog: (m) => spawned.push(m) },
    () => {},
  );
  const ensured = await manager2.ensure();
  check("ensure() 返回在线", ensured.up === true, JSON.stringify(ensured));
  check("ensure() 未启动任何子进程", manager2.status.startedByUs === false && !spawned.some((l) => l.includes("已启动子进程")));

  // ---------- 二、令牌截获(独立端口,真启一个进程) ----------
  console.log(`\n[3] 令牌截获:真启一个 dsh web @ ${SPARE_PORT}`);
  const logPath = join(tmpdir(), `dsh-s0-token-${Date.now()}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const logOffset = 0;
  const fd = openSync(logPath, "a");
  const child = spawn(`dsh web --port ${SPARE_PORT} --no-open`, {
    shell: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  console.log(`      日志: ${logPath}`);

  const deadline = Date.now() + 45_000;
  let token: string | undefined;
  let becameUp = false;
  const spareManager = new ServerManager({ url: SPARE, command: "dsh", autoStart: false, timeoutSec: 5 }, () => {});
  while (Date.now() < deadline) {
    if (!becameUp) becameUp = await spareManager.isUp(800);
    if (token === undefined && existsSync(logPath)) {
      const size = statSync(logPath).size;
      if (size > logOffset) {
        const buf = Buffer.alloc(size - logOffset);
        const rfd = openSync(logPath, "r");
        try {
          readSync(rfd, buf, 0, buf.length, logOffset);
        } finally {
          closeSync(rfd);
        }
        for (const m of buf.toString("utf8").matchAll(/dsh web:\s*(\S+)/gu)) {
          let t: string | undefined;
          try {
            t = new URL(m[1]).searchParams.get("token") ?? undefined;
          } catch {
            continue;
          }
          if (t !== undefined) {
            token = t;
            break;
          }
        }
      }
    }
    if (token !== undefined && becameUp) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  check("新进程已在 3099 就绪", becameUp);
  check("从日志里截获到启动令牌", typeof token === "string" && token.length > 0, token ? `长度 ${token.length}` : "未捕获");

  try {
    if (token !== undefined) {
      const auth = await resolveAuth(SPARE, { launchToken: token });
      check("用启动令牌换到了 Cookie", auth !== undefined && auth.via === "token", auth ? `via=${auth.via} authority=${auth.authority}` : "无");

      const res = await fetch(`${SPARE}/api/session/modelCatalog`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? authHeaders(auth) : {}) },
        body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "session/modelCatalog", payload: { args: {} } }),
        signal: AbortSignal.timeout(10_000),
      });
      const body: any = await res.json().catch(() => undefined);
      check("用该 Cookie 调通了受保护的 API", body?.result?.ok === true, `HTTP ${res.status} ${body?.result?.ok ? "" : JSON.stringify(body?.result?.error)}`);
    }

    // ---------- 三、对照:凭据派生路径(服务端非本扩展启动时唯一可用的一条) ----------
    console.log("\n[4] 对照:本地派生签名 Cookie");
    check("authorityOf(localhost) 与 authorityOf(127.0.0.1) 得到不同 authority", authorityOf("http://localhost:3080") !== authorityOf("http://127.0.0.1:3080"), `${authorityOf("http://localhost:3080")} vs ${authorityOf("http://127.0.0.1:3080")}`);
    const secret = readBrowserSessionSecret();
    check("读到了浏览器会话密钥(32 字节)", secret?.byteLength === 32, secret ? `${secret.byteLength} 字节` : "未读到");
    if (secret !== undefined) {
      const derived = await resolveAuth(LIVE);
      const res = await fetch(`${LIVE}/api/session/list`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(derived ? authHeaders(derived) : {}) },
        body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "session/list", payload: { args: { _request: {} } } }),
        signal: AbortSignal.timeout(10_000),
      });
      const body: any = await res.json().catch(() => undefined);
      check("派生 Cookie 调通了 session/list", body?.result?.ok === true, `via=${derived?.via} HTTP ${res.status}`);
      // 错误的 authority 必须失败 —— 这是「静默 401」的守门断言
      const wrong = signCookie(secret, authorityOf("http://localhost:3080"));
      const bad = await fetch(`${LIVE}/api/session/list`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:3080", cookie: wrong },
        body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "session/list", payload: { args: { _request: {} } } }),
        signal: AbortSignal.timeout(10_000),
      });
      check("authority 不匹配的 Cookie 被拒(401)", bad.status === 401, `HTTP ${bad.status}`);
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`\n=== ${failures === 0 ? "S0(一) 通过" : `S0(一) 未通过(${failures} 项失败)`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
