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
  /**
   * 令牌还没落盘时的有界等待(可选;由 `ServerManager.waitForToken` 提供)。
   *
   * 服务端是**先开端口、后打印令牌**的(见 serverManager.ts 里 waitForToken 的说明),
   * 而适配器是一次性解析鉴权的,所以等待必须发生在这里 —— 放到 start() 里会把
   * 「刚拉起的服务端是否活着」这个判断一起推迟掉。服务端不是本扩展拉起的时候,
   * 这个回调会立刻返回 undefined,不加任何延迟。
   */
  waitForLaunchToken?: (timeoutMs: number) => Promise<string | undefined>;
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
  //
  // 凭据不能只解析一次就冻住。mux 的配置契约写明「每次(重)连都重新解析一次凭据」
  // (mux.ts:53),而且 Cookie 是有寿命的:令牌兑换来的由服务端定(实测默认 30 天、
  // 最小 1 天),凭据派生的是我们自签的 ≈24 小时窗口。原来这里把结果封进
  // `async () => auth` 交给适配器,于是「凭据文件后到」「窗口过期」「401 后重新兑换」
  // 三件事一件都自愈不了,只能重载窗口。
  let auth: DshAuth | undefined;
  let authInFlight: Promise<DshAuth | undefined> | undefined;

  /** `useLaunchToken=false` 用于「已有凭据、只想重签一次名」—— 省掉一次令牌兑换的网络往返。 */
  const resolveNow = async (useLaunchToken: boolean): Promise<DshAuth | undefined> => {
    try {
      return await resolveAuth(baseUrl, {
        launchToken: useLaunchToken ? options.launchToken?.() : undefined,
        manualCookie: options.manualCookie,
        allowCredentialFile: options.deriveFromCredentials,
        // 只在「前面几条路全落空」时才会真的被调用(见 auth.ts::resolveAuth 的说明)
        waitForLaunchToken: useLaunchToken ? options.waitForLaunchToken : undefined,
      });
    } catch (error) {
      log(`解析鉴权凭据抛错(忽略):${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const provideAuth = async (): Promise<DshAuth | undefined> => {
    // 手填 Cookie 是常量;令牌兑换来的 Cookie 由服务端定寿命 —— 两者都复用到底,
    // 直到服务端明确拒绝(onAuthRejected 会清掉缓存,下次重新兑换)。
    // 凭据派生的那条不一样:重签只是一次本地 HMAC,所以每次重连都重算,
    // 「凭据文件后到」和「自签窗口过期」就都能自愈。
    if (auth !== undefined && auth.via !== "secret") return auth;
    authInFlight ??= resolveNow(auth === undefined)
      .then((next) => {
        // 刷新失败时保留手上这条可用凭据,不要用 undefined 把它顶掉
        if (next !== undefined) auth = next;
        return auth;
      })
      .finally(() => {
        authInFlight = undefined;
      });
    return authInFlight;
  };

  await provideAuth();
  log(`鉴权凭据:${auth ? `已获取(via=${auth.via}, authority=${auth.authority})` : "无(0.1.1 不需要;0.1.5 上会 401)"}`);

  const build = (kind: ProtocolKind): AdapterHandle =>
    kind === "legacy"
      ? { kind, adapter: new DshApiClient(baseUrl) }
      : {
          kind,
          adapter: new ModernApiClient(baseUrl, {
            auth: provideAuth,
            onAuthRejected: () => {
              auth = undefined;
            },
            onLog: options.onLog,
          }),
        };

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
