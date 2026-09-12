/**
 * 协议适配器工厂 —— 双协议并存的总入口。
 *
 * 同一个 vsix 要同时服务升级到 0.1.5 的用户和还停在 0.1.1 的用户,所以这里不做
 * 「新协议优先」的假设,而是**实测后再选**:先解析鉴权(0.1.5 的门禁要求必须先有凭据,
 * 否则每个探针都回 401,判据全被污染),再按 detect.ts 的双向正证判世代。
 *
 * 兜底方向刻意保守:`auto` 判不出来时回落到 legacy。理由是 legacy 正是 0.12.4 的既有行为,
 * 回落等于「什么都没变」;而误判成 modern 会把整个扩展切到对面不存在的传输上。
 */

import { DshApiClient } from "./legacy";
import { ModernApiClient } from "./modern";
import { detectProtocol } from "./detect";
import { resolveAuth, type DshAuth } from "./auth";
import type { AdapterHandle, ProtocolKind } from "./types";

/** `dsh.protocol` 设置项的取值。 */
export type ProtocolSetting = "auto" | ProtocolKind;

export interface CreateAdapterOptions {
  /** 强制协议;`auto` 走实测。 */
  protocol?: ProtocolSetting;
  /** 由本扩展拉起的服务端打印的启动令牌(懒取值 —— 服务端可能还没起来)。 */
  launchToken?: () => string | undefined;
  /** 用户在设置里手填的 Cookie(排障兜底,优先级最高)。 */
  manualCookie?: string;
  /** 是否允许读 `<DSH_HOME>/.credentials.yaml` 派生 Cookie(缺省允许,见 auth.ts)。 */
  deriveFromCredentials?: boolean;
  onLog?: (message: string) => void;
}

export async function createAdapter(baseUrl: string, options: CreateAdapterOptions = {}): Promise<AdapterHandle> {
  const log = (message: string) => options.onLog?.(`[protocol] ${message}`);
  const setting = options.protocol ?? "auto";

  // 鉴权先行:0.1.5 上门禁先于路由,没有凭据时任何探测都只会拿到 401。
  let auth: DshAuth | undefined;
  try {
    auth = await resolveAuth(baseUrl, {
      launchToken: options.launchToken?.(),
      manualCookie: options.manualCookie,
      allowCredentialFile: options.deriveFromCredentials,
    });
  } catch (error) {
    log(`解析鉴权凭据抛错(忽略,继续探测):${error instanceof Error ? error.message : String(error)}`);
  }
  log(`鉴权凭据:${auth ? `已获取(via=${auth.via}, authority=${auth.authority})` : "无(0.1.1 不需要;0.1.5 上会 401)"}`);

  const build = (kind: ProtocolKind): AdapterHandle =>
    kind === "legacy"
      ? { kind, adapter: new DshApiClient(baseUrl) }
      : { kind, adapter: new ModernApiClient(baseUrl, { auth: async () => auth, onLog: options.onLog }) };

  if (setting !== "auto") {
    log(`dsh.protocol=${setting},跳过探测`);
    return build(setting);
  }

  const result = await detectProtocol({ baseUrl, auth });
  log(`探测结果:${result.kind} —— ${result.reason}`);
  if (result.kind === "unknown") {
    log("协议未知,回落到 legacy(与 0.12.4 行为一致,不引入新风险)");
    return build("legacy");
  }
  return build(result.kind);
}
