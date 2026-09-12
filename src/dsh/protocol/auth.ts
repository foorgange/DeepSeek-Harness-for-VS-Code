/**
 * dsh 0.1.5 浏览器会话鉴权。
 *
 * 0.1.5 对 /api 下所有路由(含 /api/remote.mux 的 WebSocket 升级)统一挂了门禁:
 *   requestRejection() → 403(Host 不可信) / 401(未通过鉴权)
 * 0.1.1 时代这段代码根本不存在,所以「返回 401」本身就是「服务端是 0.1.5」的判据。
 *
 * 过门禁需同时满足(dsh-client-connection/lib/index.js:201-215、:431-441):
 *   1. Host 头是 loopback(localhost / [::1] / 127.x.x.x)或 trustedHosts 条目;
 *   2. 携带绑定 authority 的 HMAC 签名 Cookie。
 * Node 客户端不要发 Origin —— isTrustedApiRequest 在 origin 缺失时直接放行,
 * 一旦发送就必须与 Host 完全一致;也绝不能发 sec-fetch-site: cross-site。
 *
 * Cookie 形态(与 dsh-client-connection/lib/index.js:280-320 逐字段对齐):
 *   dsh-auth-<b64url(sha256(authority))>=v1.<b64url(payload)>.<b64url(hmacSha256(secret, body))>
 * 其中 authority = new URL(`http://${hostHeader}`).host(注意是对 Host 头做一次
 * WHATWG 归一化:主机名小写、默认端口剥离),payload 为
 *   { version: 1, authority, issuedAt, expiresAt }
 * secret 是 32 字节原始密钥(不是 base64 文本),参与 HMAC 的是解码后的字节。
 * base64url 编码一律去填充(dsh 的 encodeBase64Url 用 /=+$/ 剥掉)。
 */

import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { dshHome } from "../rollbackInstall";

/** Cookie 名前缀,与 dsh 常量 COOKIE_PREFIX 一致。 */
const COOKIE_PREFIX = "dsh-auth-";
/** Cookie 载荷版本,与 dsh 常量 COOKIE_PAYLOAD_VERSION 一致。 */
const COOKIE_PAYLOAD_VERSION = 1;
/** 密钥字节数,与 dsh 常量 SECRET_BYTES 一致。 */
const SECRET_BYTES = 32;
/** 凭据文件里浏览器会话记录的键,与 dsh 常量 AUTH_RECORD_KEY 一致。 */
const AUTH_RECORD_KEY = "client-connection/browser-session";

/**
 * 签名有效期。dsh 侧校验 `expiresAt - issuedAt <= cookieMaxAgeDays * 86400000`,
 * 而 cookieMaxAgeDays 最小可配为 1 天 —— 所以窗口取「略小于 1 天」对任何配置都成立。
 * 同时把 issuedAt 回拨 5 分钟容忍本机与服务的时钟偏差(校验含 `issuedAt <= now`)。
 * 过期后无需特殊处理:收到 401 重新派生一次即可,成本是一次 HMAC。
 */
const CLOCK_SKEW_MS = 5 * 60_000;
const WINDOW_MS = 24 * 60 * 60_000 - 2 * CLOCK_SKEW_MS;

export type AuthSource = "token" | "secret" | "none";

export interface DshAuth {
  /** 当前 authority(即 Host 头取值),Cookie 与它绑定,端口变化必须重新派生。 */
  authority: string;
  /** 完整 Cookie 对(`name=value`),请求与 WebSocket 握手都用它。 */
  cookie: string;
  /** Cookie 来源,用于日志与排障。 */
  via: AuthSource;
}

/** base64url 编码(去填充),与 dsh 的 encodeBase64Url 行为一致。 */
function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** base64url 解码;非法输入返回 undefined(并对往返结果做一次校验)。 */
function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

/**
 * 把 baseUrl 归一化成 dsh 眼中的 authority。
 * 就是 requestAuthority 的等价物:对 Host 头做一次 `new URL("http://" + host).host`。
 */
export function authorityOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  return new URL(`http://${url.host}`).host;
}

/** Cookie 名:authority 的 sha256 的 base64url。 */
export function cookieNameFor(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}

/** 由 32 字节密钥为一个 authority 现签一个 Cookie 对。 */
export function signCookie(secret: Buffer, authority: string, now = Date.now()): string {
  if (secret.byteLength !== SECRET_BYTES) {
    throw new Error(`dsh browser-session secret must be ${SECRET_BYTES} bytes, got ${secret.byteLength}`);
  }
  const issuedAt = now - CLOCK_SKEW_MS;
  const payload = { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt: issuedAt + WINDOW_MS };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${cookieNameFor(authority)}=v1.${body}.${encodeBase64Url(signature)}`;
}

/**
 * 读取 `<dshHome>/.credentials.yaml` 里的浏览器会话签名密钥。
 * 这是 dsh 自己持久化的记录(client-connection/browser-session),与谁启动服务无关,
 * 因此「服务端由用户在终端里手动启动」时也能用。
 */
export function readBrowserSessionSecret(): Buffer | undefined {
  try {
    const file = join(dshHome(), ".credentials.yaml");
    if (!existsSync(file)) return undefined;
    const doc = yaml.load(readFileSync(file, "utf8")) as
      | { records?: Record<string, { kind?: string; payload?: { version?: number; secret?: string } }> }
      | undefined;
    const record = doc?.records?.[AUTH_RECORD_KEY];
    if (record?.kind !== "grant") return undefined;
    const raw = record.payload?.secret;
    if (typeof raw !== "string") return undefined;
    const decoded = decodeBase64Url(raw);
    return decoded?.byteLength === SECRET_BYTES ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 走一次启动令牌兑换:GET /?token=<T> → 303 + Set-Cookie。
 * 令牌只在根路径被接受(它是一次性的换 Cookie 凭据,不是 bearer token,
 * 放进 Authorization 头或 /api 请求一律无效),所以这里必须**不跟随 303**,
 * 直接从响应里取 set-cookie。
 */
export async function exchangeLaunchToken(baseUrl: string, token: string, timeoutMs = 5000): Promise<string | undefined> {
  const authority = authorityOf(baseUrl);
  try {
    const url = new URL("/", baseUrl);
    url.searchParams.set("token", token);
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html", host: authority },
    });
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return undefined;
    const pair = setCookie.split(";")[0]?.trim();
    return pair && pair.startsWith(COOKIE_PREFIX) ? pair : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析出可用于 0.1.5 的鉴权凭据。
 * 优先用外部传入的令牌(只有本扩展启动服务端时才拿得到),
 * 否则本地派生 —— 后者不依赖谁启动了服务,是更通用的一条。
 *
 * `allowCredentialFile` 控制第三条路径(读 `<DSH_HOME>/.credentials.yaml`)。它默认开启,
 * 因为「服务端由用户在终端里自己启动」时这是**唯一**能过 0.1.5 门禁的路径 ——
 * 关掉它,那部分用户在 0.1.5 上会完全用不了。读取范围限于
 * `client-connection/browser-session` 这一条记录的 secret,只用于给本机地址签 Cookie,
 * 不会出现在任何网络请求里(除发给同一个 loopback 服务端本身);用户可在设置里关闭。
 */
export async function resolveAuth(
  baseUrl: string,
  opts: { launchToken?: string; manualCookie?: string; allowCredentialFile?: boolean } = {},
): Promise<DshAuth | undefined> {
  const authority = authorityOf(baseUrl);

  // 用户在设置里手填的 Cookie(排障兜底)最优先。
  const manual = opts.manualCookie?.trim();
  if (manual) return { authority, cookie: manual, via: "token" };

  if (opts.launchToken) {
    const cookie = await exchangeLaunchToken(baseUrl, opts.launchToken);
    if (cookie) return { authority, cookie, via: "token" };
  }

  if (opts.allowCredentialFile === false) return undefined;

  const secret = readBrowserSessionSecret();
  if (secret) return { authority, cookie: signCookie(secret, authority), via: "secret" };

  return undefined;
}

/**
 * 请求头:Host + Cookie,不带 Origin。
 * isTrustedApiRequest 在 origin 缺失时直接返回 true;带上就必须与 Host 完全一致,
 * 所以最省事的正确做法是根本不发。
 */
export function authHeaders(auth: DshAuth): Record<string, string> {
  return { host: auth.authority, cookie: auth.cookie };
}
