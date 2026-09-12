import type { DshApiClient } from "./legacy";

/** dsh 服务端的协议世代。 */
export type ProtocolKind = "legacy" | "modern";

/**
 * 协议适配器 —— 两代 dsh 协议对上层暴露的**同一个**接口。
 *
 * 这里刻意从 legacy 客户端的类型**映射**出接口,而不是手抄一份方法表:dsh 0.1.5 的移植思路是
 * 「把新协议向下翻译成旧协议已有的内部词汇」(`MuxFrame` / `HostFrame`),所以 modern
 * 适配器必须是 `DshApiClient` 的**结构化替身** —— 它得能被 `hub.ts` 原样使用。
 * 这样一来接口永远不会和实现漂移:legacy 客户端加了方法,适配器契约自动跟上。
 *
 * 必须是映射类型而不是直接 `= DshApiClient`:那个类带 private 字段,而 TypeScript 里
 * 带私有成员的类型是**名义化**的 —— 别的类无论实现得多完整都不可赋值。映射一遍会把
 * 私有成员滤掉(`keyof` 本就不含私有成员),只留下公开面,才是真正的结构契约。
 *
 * `protocol` 判别式没有挂在对象上,而是和适配器一起由工厂返回(见 `AdapterHandle`),
 * 目的是让 `legacy/index.ts` 保持**逐字节原样搬运** —— 那是双协议回归的安全网,
 * 不该为了一个诊断字段动它。
 */
export type ProtocolAdapter = { [K in keyof DshApiClient]: DshApiClient[K] };

/** 工厂的返回值:适配器本体 + 它实际是哪一个世代(用于日志与状态栏展示)。 */
export interface AdapterHandle {
  readonly kind: ProtocolKind;
  readonly adapter: ProtocolAdapter;
}
