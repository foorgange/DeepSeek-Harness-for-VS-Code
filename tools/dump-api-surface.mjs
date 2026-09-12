/**
 * 从 dsh 的 descriptor 表里抽出 modern 协议的**完整方法面**:每个 endpoint 的在线上参名。
 *
 * 这些名字来自 `typert.host.js`(由 dsh 构建期生成的调用描述表),是服务端严格执行的
 * exact-match 参数集 —— 比任何文档都可靠。args.ts 的表就照这个生成,不要手抄。
 *
 *   node tools/dump-api-surface.mjs            # 打印表格
 *   node tools/dump-api-surface.mjs --json     # 输出 JSON(用于生成 args.ts)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv.includes("--dsh-root")
  ? process.argv[process.argv.indexOf("--dsh-root") + 1]
  : "C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

/** 只看这几个 package:它们承载扩展用得上的那部分方法面。 */
const WANTED = [
  "dsh-api-session-controller",
  "dsh-api-settings-controller",
  "dsh-api-workspace-controller",
  "dsh-api-workspace-files",
  "dsh-api-remotes",
  "dsh-commands",
  "dsh-goal",
  "dsh-agent-presets",
  "dsh-llm",
  "dsh-subagent",
];

function files() {
  const out = [];
  for (const pkg of WANTED) {
    const lib = join(ROOT, pkg, "lib");
    if (!existsSync(lib)) continue;
    for (const f of readdirSync(lib)) {
      if (f.endsWith(".host.js") || f === "client.js") out.push(join(lib, f));
    }
  }
  return out;
}

/**
 * 一个 descriptor 块长这样(顺序固定,由生成器保证):
 *   id: '...#namespace/method', service: '...', namespace: 'ns', method: 'm',
 *   invocation: { kind: 'direct' },
 *   scope: { context: 'agent', wire: 'agentId' },     // 可选:上下文作用域,也是线上顶层参数
 *   parameters: [ { name: 'x', wire: 'y', source: 'json', ... }, ... ],
 */
function extract(text) {
  const found = new Map();
  const blocks = text.split(/(?=\bid: '@deepseek-ai\/)/);
  for (const block of blocks) {
    const idMatch = block.match(/^id: '@deepseek-ai\/[^#]+#([a-zA-Z]+\/[a-zA-Z]+)'/);
    if (!idMatch) continue;
    const endpoint = idMatch[1];

    // 只取到 result: 之前的部分,避免把返回结构里的 wire 也算成参数
    const cut = block.indexOf("result: {");
    const head = cut === -1 ? block : block.slice(0, cut);

    const scopeWire = head.match(/scope: \{\s*context: '[^']*',\s*wire: '([^']+)'/);
    const paramsPart = head.slice(head.indexOf("parameters: ["));
    const wires = [];
    // 每个参数对象以 `name:` 开头;`wire:` 紧跟其后,`optional: true` 是可选标记
    const paramRe = /\{\s*name: '([^']+)',\s*wire: '([^']+)',([\s\S]*?)(?=\n\s*\},|\n\s*\],)/g;
    for (const m of paramsPart.matchAll(paramRe)) {
      const [, name, wire, rest] = m;
      const source = rest.match(/source: '([^']+)'/)?.[1] ?? "json";
      const optional = /optional: true/.test(rest);
      wires.push({ name, wire, source, optional });
    }

    const keys = [];
    if (scopeWire) keys.push({ wire: scopeWire[1], from: "scope", optional: false });
    for (const w of wires) keys.push({ wire: w.wire, from: w.source, optional: w.optional });

    // scope 的 wire 和首个参数的 wire 常常同名(agentId):线上只有一个键,去重
    const seen = new Set();
    const unique = keys.filter((k) => (seen.has(k.wire) ? false : (seen.add(k.wire), true)));

    // 同一个 endpoint 可能在多个文件里重复出现,取参数最全的那份
    const prev = found.get(endpoint);
    if (!prev || unique.length > prev.keys.length) found.set(endpoint, { endpoint, keys: unique, file: "" });
  }
  return found;
}

const table = new Map();
for (const f of files()) {
  for (const [endpoint, entry] of extract(readFileSync(f, "utf8"))) {
    const prev = table.get(endpoint);
    if (!prev || entry.keys.length > prev.keys.length) table.set(endpoint, { ...entry, file: f.replace(ROOT + "/", "") });
  }
}

const sorted = [...table.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(sorted, null, 2));
} else {
  console.log(`共 ${sorted.length} 个 endpoint\n`);
  for (const { endpoint, keys } of sorted) {
    const rendered = keys.map((k) => (k.optional ? `${k.wire}?` : k.wire)).join(", ");
    console.log(`  ${endpoint.padEnd(34)} { ${rendered} }`);
  }
}
