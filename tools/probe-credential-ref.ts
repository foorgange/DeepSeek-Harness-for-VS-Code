/**
 * 一次性探针:0.1.5 的 credential ref 到底长什么样,以及 provider → ref 怎么映射。
 *
 * 背景:`credentials/describe` 的 ref 有语法 `^[A-Za-z_][A-Za-z0-9_]*$`(POSIX 标识符),
 * 而插件一路传的是 provider id(`deepseek-official`,带连字符)⇒ `gateway/bad-request`。
 * 官方设置页的做法(`dsh-client-ui-settings-models/lib/client.js:920`)是:
 *   ref = profile.apiKeyEnv ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}_API_KEY`
 * 这个探针把这套推断对着真机验一遍,免得把「推导」写死成「事实」。
 *
 * 用法:
 *   npx esbuild tools/probe-credential-ref.ts --bundle --platform=node --format=cjs \
 *     --external:vscode --outfile=dist/probe-credential-ref.js
 *   node dist/probe-credential-ref.js
 */

import { ModernApiClient } from "../src/dsh/protocol/modern";
import { resolveAuth } from "../src/dsh/protocol/auth";

const LIVE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

/** 与官方 UI 的 deriveKeyRef 逐字一致。 */
function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** 按 settingsPath 从命名空间的值里取那个 profile 对象。 */
function profileAt(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

async function main() {
  console.log(`\n=== credential ref 探针 @ ${LIVE} ===\n`);
  const client = new ModernApiClient(LIVE, { auth: () => resolveAuth(LIVE, {}) });

  const { providers } = await client.llmProviders();
  const { namespaces } = await client.settingsDescribe();
  const nsValue = new Map(namespaces.map((n) => [n.ns as string, n.value as Record<string, unknown>]));

  console.log(`厂商 ${providers.length} 个,命名空间 ${namespaces.length} 个\n`);

  // ---------- 1. 每个 provider 推出候选 ref ----------
  const candidates = new Set<string>();
  const rows: { provider: string; settingsNs: string; path: string; apiKeyEnv?: string; derived: string; chosen: string }[] = [];

  for (const p of providers) {
    const profile = profileAt(nsValue.get(p.settingsNs), p.settingsPath) as Record<string, unknown> | undefined;
    const apiKeyEnv = typeof profile?.["apiKeyEnv"] === "string" ? (profile["apiKeyEnv"] as string) : undefined;
    const derived = deriveKeyRef(p.provider);
    const chosen = apiKeyEnv ?? derived;
    candidates.add(chosen);
    rows.push({
      provider: p.provider,
      settingsNs: p.settingsNs,
      path: p.settingsPath.join(".") || "(整段)",
      apiKeyEnv,
      derived,
      chosen,
    });
  }

  console.log("=== 各 provider 的 ref 推断(只列有 profile 或推导与 id 不同的) ===");
  for (const r of rows) {
    const interesting = r.apiKeyEnv !== undefined || r.derived.toLowerCase() !== r.provider.toLowerCase();
    if (!interesting && r.provider !== "deepseek-official") continue;
    console.log(
      `  ${r.provider.padEnd(28)} ns=${r.settingsNs.padEnd(22)} path=${r.path.padEnd(14)} apiKeyEnv=${r.apiKeyEnv ?? "(无)"}  推导=${r.derived}  ⇒ ${r.chosen}`,
    );
  }

  // ---------- 2. 真机回答:哪些 ref 真的存在 ----------
  const list = [...candidates].sort();
  console.log(`\n=== 逐个问真机(共 ${list.length} 个候选,分批 ≤64) ===`);
  const found: string[] = [];
  const rejected: string[] = [];
  for (let i = 0; i < list.length; i += 60) {
    const batch = list.slice(i, i + 60);
    try {
      const { credentials } = await client.credentialsDescribe(batch);
      for (const [ref, info] of Object.entries(credentials)) {
        if (info.configured) found.push(ref);
      }
      console.log(`  批 ${i / 60 + 1}: ${Object.keys(credentials).length} 个 ref 被接受`);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      rejected.push(...batch);
      console.log(`  批 ${i / 60 + 1}: 被拒 ${e.code}: ${e.message}`);
    }
  }

  console.log(`\n=== 已配置(configured=true)的 ref ===`);
  console.log(found.length > 0 ? found.map((r) => `  ${r}`).join("\n") : "  (一个都没有)");

  // ---------- 3. 直接测那两个语法边界 ----------
  console.log(`\n=== 语法边界 ==="`);
  for (const ref of ["deepseek-official", "DEEPSEEK_OFFICIAL_API_KEY", "DEEPSEEK_API_KEY"]) {
    try {
      const { credentials } = await client.credentialsDescribe([ref]);
      console.log(`  ${ref.padEnd(28)} 接受 ⇒ ${JSON.stringify(credentials[ref])}`);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      console.log(`  ${ref.padEnd(28)} 拒绝 ⇒ ${e.code}: ${e.message}`);
    }
  }

  client.dispose();
  console.log();
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
