/**
 * provider → credential ref 的翻译。**纯函数**,可离线单测。
 *
 * 为什么需要这一层:
 *   0.1.1 的 `credentials.describe` 以 **provider id** 寻址,插件全案都是这么调的
 *   (`settingsPanel.ts` 传 `p.provider`、`settings.ts` 也以 `p.provider` 取结果)。
 *   0.1.5 改成以 **POSIX 标识符形状的引用名**(环境变量名)寻址,并且**整批校验**:
 *   `credentialRefSchema = /^[A-Za-z_][A-Za-z0-9_]*$/` —— 一个不合法的名字会让
 *   整个 describe 报 `gateway/bad-request`,而不是只跳过那一条。
 *   于是 `deepseek-official`(带连字符)在 0.1.5 上必然全批被拒。
 *
 * 规则与官方设置页逐字一致(`dsh-client-ui-settings-models/lib/client.js:920`):
 *
 *   ref = profile.apiKeyEnv ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}_API_KEY`
 *
 * `apiKeyEnv` 从哪来:`llm/listConfigurableProviders` 给出每个 provider 的
 * `settingsNs` + `settingsPath`,`settings/describe` 给出各命名空间的值,
 * 顺着 path 取到那个 profile 对象即可。两者插件本来就在拿,所以这一层不需要新端点。
 *
 * 实测(本机 43 个 provider):
 *   deepseek-official → profile 显式 `apiKeyEnv: DEEPSEEK_API_KEY`(推导会错成
 *     `DEEPSEEK_OFFICIAL_API_KEY`,所以**必须先读 profile 再推导**,不能只推导)
 *   36 个 llm-pi-ai 路由 → 无 apiKeyEnv,推导即正确
 *   agentrouter / bai / sensenova → profile 显式声明,且与推导同名
 */

/** 服务端 `credentialRefSchema` 的同一套语法。不合法就一个都别发,否则整批被拒。 */
const REF_GRAMMAR = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * 从 provider id 推导引用名。与官方 UI 的实现逐字一致 —— 这里的 `[^A-Z0-9]+`
 * 会把连字符、点、斜杠等一律折成下划线,所以**任何输入都能得到合法 ref**:
 * 这是「推导」能当兜底用的前提。
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_API_KEY`;
}

/** 这个名字能不能当 ref 发出去。 */
export function isCredentialRef(value: string): boolean {
  return REF_GRAMMAR.test(value);
}

/**
 * 顺着 profile 路径从命名空间的值里取出那个 profile 对象。
 * `settingsPath` 为空表示**整段就是 profile**(实测 `llm-deepseek` 就是这样)。
 */
export function profileAt(namespaceValue: unknown, path: readonly string[]): unknown {
  let cursor: unknown = namespaceValue;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * 单个 provider 的引用名:profile 的 `apiKeyEnv` 优先,推导兜底。
 *
 * `apiKeyEnv` 也要过语法检查 —— 它是**用户可编辑的配置**,写错一个连字符就会让
 * 整批 describe 挂掉,而不能只坏它自己。不合语法时退回推导(推导必定合法),
 * 于是最坏情况是这一个 provider 的徽标不准,而不是设置面板整块变空。
 */
export function credentialRefFor(provider: string, profile: unknown): string {
  if (profile !== null && typeof profile === "object") {
    const declared = (profile as Record<string, unknown>)["apiKeyEnv"];
    if (typeof declared === "string" && isCredentialRef(declared)) return declared;
  }
  return deriveKeyRef(provider);
}

/** `llm/listConfigurableProviders` 的最小形状(只取用得到的字段)。 */
export interface RefMapProvider {
  provider: string;
  settingsNs: string;
  settingsPath: readonly string[];
}

/** `settings/describe` 的最小形状。 */
export interface RefMapNamespace {
  ns: string;
  value: Record<string, unknown>;
}

/**
 * 一次算出 provider → ref 的全表。
 *
 * 先按命名空间归并,避免每个 provider 都去线性找一遍命名空间
 * (43 个 provider × 14 个命名空间,顺手一下的事,但没必要)。
 */
export function buildProviderRefMap(
  providers: readonly RefMapProvider[],
  namespaces: readonly RefMapNamespace[],
): Map<string, string> {
  const byNs = new Map<string, unknown>(namespaces.map((n) => [n.ns, n.value]));
  const map = new Map<string, string>();
  for (const p of providers) {
    map.set(p.provider, credentialRefFor(p.provider, profileAt(byNs.get(p.settingsNs), p.settingsPath)));
  }
  return map;
}

/**
 * 取引用名。查不到表就**当场推导**而不是抛错:
 * 拿不到表意味着 `llm/listConfigurableProviders` 或 `settings/describe` 挂了,
 * 那种情况下让设置面板整块空掉,比让个别徽标显示「未配置」糟得多。
 */
export function refOf(map: ReadonlyMap<string, string>, provider: string): string {
  return map.get(provider) ?? deriveKeyRef(provider);
}

/** 服务端 `MAX_DESCRIBE_REFS`;超过会被整批拒,所以要分批。 */
export const MAX_DESCRIBE_REFS = 64;

/** 按上限切批。 */
export function chunkRefs<T>(items: readonly T[], size = MAX_DESCRIBE_REFS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 把「以 provider id 为键的请求」翻成「以 ref 为键的请求」,再把响应翻回来。
 *
 * 注意两个方向都要翻:插件读的是 `state.credentials[p.provider]`
 * (`settings.ts` 渲染徽标),所以响应必须**重新以 provider id 为键** ——
 * 直接把服务端的 `Record<ref, …>` 抛上去,面板会静默显示成全员「未配置」。
 *
 * 同一个 ref 被多个 provider 共用是正常的(实测 `deepseek-official` 与
 * `deepseek` 都指向 `DEEPSEEK_API_KEY`),去重后只问一次,回填时各自拿到同一份答案。
 */
export interface CredentialInfoView {
  configured: boolean;
  writable: boolean;
  source?: string;
}

export function splitRefs(
  providers: readonly string[],
  map: ReadonlyMap<string, string>,
): { refs: string[]; refByProvider: Map<string, string> } {
  const refByProvider = new Map<string, string>();
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    const ref = refOf(map, provider);
    refByProvider.set(provider, ref);
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return { refs, refByProvider };
}

export function joinCredentials(
  providers: readonly string[],
  refByProvider: ReadonlyMap<string, string>,
  byRef: Readonly<Record<string, CredentialInfoView>>,
): Record<string, CredentialInfoView> {
  const out: Record<string, CredentialInfoView> = {};
  for (const provider of providers) {
    const info = byRef[refByProvider.get(provider) ?? ""];
    // 服务端对每个请求名都会回一条,拿不到只可能是那一批整个失败了 —— 报「未配置」
    out[provider] = info ?? { configured: false, writable: false };
  }
  return out;
}
