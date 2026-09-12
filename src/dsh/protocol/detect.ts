import { randomUUID } from "node:crypto";
import { authHeaders, type DshAuth } from "./auth";
import type { ProtocolKind } from "./types";

/**
 * 协议探测 —— 判断对面跑的是 dsh 0.1.1(点号路由、无鉴权)还是 0.1.5(斜杠路由、强制 Cookie)。
 *
 * **顺序是硬要求:先鉴权、后探测。** 实测 0.1.5 给所有 /api 路由(含不存在的路由)都挂了门禁,
 * 不带 Cookie 一律 401 —— 那个 401 表示「没认证」,不是「协议不对」。先探测再鉴权的话,
 * 0.1.5 上每个探针都回 401,判据全被污染。
 *
 * 第二个坑:0.1.5 上 legacy 点号路由回的是 **404 not found**,而 404 也是「这条路由根本不存在」
 * 的默认答案 —— 单看 legacy 探针 404 不足以断定是 modern。所以判据是**双向正证**:
 * 先试 legacy 专有路由,只有它明确 200 才算 legacy;否则再试 modern 专有路由,200 才算 modern;
 * 两个都不是就老实报 unknown,绝不猜。
 *
 * 失败方向也要故意偏保守:拿不准时返回 `unknown` 而不是 `modern`,因为误判成 modern 会让整个
 * 扩展切到一个对面根本不存在的传输上,而误判成 unknown 只是走「连不上」的既有兜底路径。
 */

/** 探针结果:只区分「这个状态码说明了什么」,不掺业务语义。 */
export type ProbeOutcome = "ok" | "unauthorized" | "not-found" | "unreachable";

export interface ProbeResponse {
  status: number;
  /** 服务端是否回了可解析的 JSON 信封(0.1.5 的错误是 JSON,拦截层是裸文本)。 */
  json: boolean;
}

export interface DetectOptions {
  baseUrl: string;
  auth?: DshAuth;
  timeoutMs?: number;
  /** 探针实现;缺省走真网络。抽出来是为了能离线单测判定逻辑。 */
  probe?: (endpoint: string, method: string, args: unknown, timeoutMs: number) => Promise<ProbeResponse>;
}

export interface DetectResult {
  kind: ProtocolKind | "unknown";
  /** 给人看的一句话判据,直接进日志 —— 探测错了全靠它定位。 */
  reason: string;
}

/** legacy 专有:0.1.5 已删除点号寻址,这条路由在 0.1.5 上必然 404。 */
const LEGACY_PROBE = { endpoint: "host.describe", method: "host.describe", args: {} };

/**
 * modern 专有探针 —— **多候选**。0.1.1 没有斜杠路由,这几条在它上面全是 404。
 *
 * 为什么不是一条:判据是「这条路由存不存在」,只留一条就等于把整个世代判定压在
 * 一个端点名上。那个名字一旦被未来版本改名或删除(0.1.6 完全可能重排路由表),
 * 现代服务端会被判成 unknown 再回落 legacy —— 用户那边表现是面板全空、处处 404,
 * 而日志里只说「协议未知」。多留几条同世代的探针,任意一条还在就仍判得出 modern。
 *
 * 选这几条的标准不是「随便挑几条斜杠路由」,而是**本扩展离了它就没法工作**:
 * 它们的存亡本就等同于「这个服务端能不能用」。所以「探针全没了」不会漏判一个
 * 其实可用的服务端 —— 那种情况下扩展本来也跑不起来。
 *
 * 注意探针**不要求调用成功,只要求路由存在**:gateway 的业务错误(含
 * `gateway/arguments-invalid`)回的是 HTTP 200 + 错误信封,`classify` 只看状态码。
 * 所以参数形状变化不会污染判定,只有路由改名/删除才会。
 *
 * 顺序按重要性排,命中即停 —— 正常路径上仍然只有一次往返。
 */
const MODERN_PROBES = [
  { endpoint: "session/modelCatalog", method: "session/modelCatalog", args: {} },
  { endpoint: "session/list", method: "session/list", args: { _request: {} } },
  { endpoint: "settings/describe", method: "settings/describe", args: {} },
  { endpoint: "agentPresets/list", method: "agentPresets/list", args: {} },
];

function classify(res: ProbeResponse | undefined): ProbeOutcome {
  if (res === undefined) return "unreachable";
  if (res.status === 200) return "ok";
  if (res.status === 401 || res.status === 403) return "unauthorized";
  // 显式 404,以及「有响应但不是 JSON、状态码也不是 200/401」都归到 not-found:
  // 0.1.5 的路由表对不认识的路径就是 404,这里不做更细的区分。
  if (res.status === 404 || !res.json) return "not-found";
  return "not-found";
}

async function defaultProbe(baseUrl: string, auth: DshAuth | undefined, timeoutMs: number) {
  return async (endpoint: string, method: string, args: unknown, ms: number): Promise<ProbeResponse> => {
    const res = await fetch(`${baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? authHeaders(auth) : {}) },
      body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(ms || timeoutMs),
    });
    const text = await res.text();
    let json = false;
    try {
      json = typeof JSON.parse(text) === "object" && text.trim().startsWith("{");
    } catch {
      json = false;
    }
    return { status: res.status, json };
  };
}

export async function detectProtocol(options: DetectOptions): Promise<DetectResult> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const run =
    options.probe ?? (await defaultProbe(options.baseUrl.replace(/\/+$/, ""), options.auth, timeoutMs));

  let legacy: ProbeResponse | undefined;
  try {
    legacy = await run(LEGACY_PROBE.endpoint, LEGACY_PROBE.method, LEGACY_PROBE.args, timeoutMs);
  } catch {
    return { kind: "unknown", reason: `服务端不可达(${options.baseUrl})——探测不出协议,不猜` };
  }
  const legacyOutcome = classify(legacy);
  if (legacyOutcome === "ok") {
    return { kind: "legacy", reason: "host.describe 返回 200:0.1.5 已删除点号寻址,只有 0.1.1 会应答" };
  }
  if (legacyOutcome === "unreachable") {
    return { kind: "unknown", reason: `服务端不可达(${options.baseUrl})` };
  }

  // 依次试各条 modern 探针,命中任意一条即判 modern。
  const tried: string[] = [];
  for (const candidate of MODERN_PROBES) {
    let modern: ProbeResponse | undefined;
    try {
      modern = await run(candidate.endpoint, candidate.method, candidate.args, timeoutMs);
    } catch {
      return { kind: "unknown", reason: `modern 探针请求失败(${candidate.endpoint}),协议未知` };
    }
    tried.push(candidate.endpoint);
    const modernOutcome = classify(modern);

    if (modernOutcome === "ok") {
      return {
        kind: "modern",
        reason:
          legacyOutcome === "unauthorized"
            ? `${candidate.endpoint} 返回 200,且 legacy 探针被 401 拦下:鉴权指纹 + 斜杠路由,判定 0.1.5`
            : `${candidate.endpoint} 返回 200:0.1.1 没有斜杠路由,判定 0.1.5`,
      };
    }
    // 两条都被 401 拦下 ⇒ 这是「没凭据/凭据无效」,不是「协议不对」。0.1.5 的门禁
    // 盖在所有 /api 路由上(**连不存在的路由也回 401**),所以再试下一条不会有新信息。
    if (modernOutcome === "unauthorized" && legacyOutcome === "unauthorized") {
      return { kind: "unknown", reason: "两条探针都被 401 拦下:鉴权凭据无效或缺失(不是协议问题)" };
    }
  }
  return {
    kind: "unknown",
    reason: `modern 的 ${MODERN_PROBES.length} 条探针都未命中(试过 ${tried.join("、")};legacy=${legacyOutcome})——协议未知,不猜`,
  };
}
