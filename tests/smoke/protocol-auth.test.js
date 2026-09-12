// 鉴权编码测试 —— 这类错误**只表现为静默 401**,没有任何别的症状。
// 用法: node tests/smoke/protocol-auth.test.js
//
// 为什么必须独立重算而不是对着实现抄一份期望值:抄一份只能固化「实现现在做了
// 什么」,实现写错了测试跟着一起错。这里按协议规格用 node:crypto **重新算一遍**,
// 两边对上才算数 —— 这才是一道真的防线。
//
// 规格(dsh-client-connection 的浏览器会话 Cookie):
//   name   = "dsh-auth-" + b64url(sha256(authority))
//   value  = "v1." + b64url(JSON.stringify({version,authority,issuedAt,expiresAt})) + "." + b64url(hmacSha256(secret, body))
//   authority = new URL("http://" + Host头).host
//
// **authority 必须按线路上实际用的 Host 算**:`127.0.0.1:3080` 与 `localhost:3080`
// 是两个不同的 authority,会得到两个不同的 Cookie 名。名字错了服务端就找不到
// Cookie,表现就是一个干净的 401。
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));
const out = path.join(os.tmpdir(), "protocol-auth-test-" + process.pid + ".cjs");
buildSync({
  entryPoints: [path.join(repo, "src/dsh/protocol/auth.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
});
const { authorityOf, cookieNameFor, signCookie, authHeaders } = require(out);

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "OK  " : "FAIL") + " " + name + (ok || !detail ? "" : "  → " + detail));
  if (!ok) fail++;
}
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("=== authority 归一化 ===");
// 三种写法必须归一到同一个 authority —— 否则同一个服务端会因为 URL 写法不同而鉴权失败。
for (const [input, expected] of [
  ["http://127.0.0.1:3080", "127.0.0.1:3080"],
  ["http://127.0.0.1:3080/", "127.0.0.1:3080"],
  ["http://127.0.0.1:3080/api/remote.mux", "127.0.0.1:3080"],
  ["http://localhost:3080", "localhost:3080"],
  ["http://localhost:3080/?token=abc", "localhost:3080"],
]) {
  check(`authorityOf("${input}") == "${expected}"`, authorityOf(input) === expected, `实得 ${authorityOf(input)}`);
}
// 这正是 plan 里点名的那条:两个 authority 必须给出**不同**的 cookie 名。
check(
  "127.0.0.1 与 localhost 的 authority 不同(用错就是静默 401)",
  authorityOf("http://127.0.0.1:3080") !== authorityOf("http://localhost:3080"),
);

console.log("\n=== Cookie 名 ===");
for (const authority of ["127.0.0.1:3080", "localhost:3080"]) {
  const expected = "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority).digest());
  const actual = cookieNameFor(authority);
  check(`cookie 名 = dsh-auth-<b64url(sha256(authority))>(${authority})`, actual === expected, `实得 ${actual}`);
  // base64url 而不是 base64:名字里出现 + / = 会让 Cookie 头解析出岔子。
  const suffix = actual.slice("dsh-auth-".length);
  check(`cookie 名是 base64url(无 + / =)(${authority})`, !/[+/=]/.test(suffix), suffix);
}

console.log("\n=== Cookie 值编码 ===");
const SECRET = Buffer.alloc(32, 7);
const AUTHORITY = "127.0.0.1:3080";
const NOW = 1_700_000_000_000;
const cookie = signCookie(SECRET, AUTHORITY, NOW);
const eq = cookie.indexOf("=");
const name = cookie.slice(0, eq);
const value = cookie.slice(eq + 1);
const parts = value.split(".");

check("cookie 名与 cookieNameFor 一致", name === cookieNameFor(AUTHORITY));
check("值恰好三段(版本 / 载荷 / 签名)", parts.length === 3, `实得 ${parts.length}`);
check("版本段是 v1", parts[0] === "v1");
check("载荷段是合法 base64url", /^[A-Za-z0-9_-]+$/.test(parts[1]));
check("签名段是合法 base64url", /^[A-Za-z0-9_-]+$/.test(parts[2]));

// --- 独立重算签名(不从实现抄)---
const expectedSig = b64url(crypto.createHmac("sha256", SECRET).update(parts[1]).digest());
check("签名 == hmacSha256(secret, 载荷段的字面文本)", parts[2] === expectedSig, `期望 ${expectedSig} 实得 ${parts[2]}`);

// --- 独立重算载荷 ---
const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
check("载荷 version = 1", payload.version === 1);
check("载荷 authority = 传入的 authority", payload.authority === AUTHORITY);
check("载荷带 issuedAt / expiresAt", Number.isFinite(payload.issuedAt) && Number.isFinite(payload.expiresAt));
// 回溯 5 分钟是为了容忍时钟偏差 —— 方向必须是「更早生效」,反了就是「还没生效」的 401。
check("issuedAt 早于当前时间(容忍时钟偏差)", payload.issuedAt < NOW, `issuedAt=${payload.issuedAt} now=${NOW}`);
check("expiresAt 晚于当前时间", payload.expiresAt > NOW);
const windowHours = (payload.expiresAt - payload.issuedAt) / 3_600_000;
check("有效期约 24h 减去两倍时钟偏差", windowHours > 23 && windowHours <= 24, `实得 ${windowHours.toFixed(3)}h`);

// --- 签名确实绑定了 authority:换 authority 而密钥不变,签名必须不同 ---
const other = signCookie(SECRET, "localhost:3080", NOW);
check(
  "cookie 名随 authority 变化",
  other.slice(0, other.indexOf("=")) !== name,
);
check("cookie 值也随 authority 变化", other.slice(other.indexOf("=") + 1) !== value);

// --- 换密钥必须换签名(否则签名形同虚设)---
const otherSecret = Buffer.alloc(32, 8);
check("换密钥 ⇒ 换签名", signCookie(otherSecret, AUTHORITY, NOW).slice(eq + 1) !== value);

console.log("\n=== 密钥长度校验 ===");
for (const len of [0, 16, 31, 33, 64]) {
  let threw = false;
  try {
    signCookie(Buffer.alloc(len, 1), AUTHORITY, NOW);
  } catch {
    threw = true;
  }
  check(`密钥 ${len} 字节 ⇒ 抛错(必须恰好 32)`, threw);
}
let ok32 = true;
try {
  signCookie(Buffer.alloc(32, 1), AUTHORITY, NOW);
} catch {
  ok32 = false;
}
check("密钥 32 字节 ⇒ 正常签发", ok32);

console.log("\n=== 请求头 ===");
const headers = authHeaders({ authority: AUTHORITY, cookie: value, via: "secret" });
// 不发 Origin:服务端在 origin 缺失时直接放行 —— 发了反而可能被判 cross-site。
check("只发 host 与 cookie 两个头", Object.keys(headers).sort().join(",") === "cookie,host", `实得 ${Object.keys(headers)}`);
check("host == authority", headers.host === AUTHORITY);
check("cookie 原样带上", headers.cookie === value);
check("绝不发 origin(服务端在 origin 缺失时直接放行)", !("origin" in headers));
check("绝不发 sec-fetch-site(带上可能被判 cross-site)", !("sec-fetch-site" in headers));

console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}`);
process.exit(fail === 0 ? 0 : 1);
