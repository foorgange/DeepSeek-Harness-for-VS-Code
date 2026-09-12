/**
 * 会话迁移体检:用 dsh **自己的** catalog(`dsh-session-format-catalog` 导出的那个对象,
 * 也就是持久化层真正在用的那一个)把 `~/.dsh/sessions/**​/session.jsonl.zstd` 全部读一遍。
 *
 * 目的单一:回答「升级到 0.1.5 之后,我本机有多少个老会话读不出来、为什么」。
 * 因此这里不重实现任何迁移逻辑,只负责把物理日志还原成 header + rows 喂进去 ——
 * 一旦自己拼 catalog,测的就成了「我理解的迁移链」而不是「dsh 的迁移链」。
 *
 * 物理格式细节:session.jsonl.zstd 是**多帧 zstd 追加**的拼接体,Node 的
 * zstdDecompressSync 只解第一帧,所以必须按魔数切帧分别解压再拼起来。
 *
 * 用法:
 *   node tools/probe-session-migration.mjs                    # 体检全部会话
 *   node tools/probe-session-migration.mjs --verbose          # 逐条打印成功/失败
 *   node tools/probe-session-migration.mjs --only <sessionId> # 只看一个
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const VERBOSE = argv.includes("--verbose");
const ONLY = opt("--only", undefined);

const DSH_ROOT = opt("--dsh-root", "C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai");
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS = join(DSH_HOME, "sessions");

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把一个 session.jsonl.zstd 还原成 {header, rows}。 */
function readLog(file) {
  const raw = readFileSync(file);
  const starts = [];
  for (let at = 0; ; ) {
    const found = raw.indexOf(MAGIC, at);
    if (found === -1) break;
    starts.push(found);
    at = found + 1;
  }
  if (starts.length === 0) throw new Error("不是 zstd 文件(找不到魔数)");
  const text = starts
    .map((start, i) => {
      try {
        return zstdDecompressSync(raw.subarray(start, starts[i + 1] ?? raw.length)).toString("utf8");
      } catch {
        return ""; // 撕裂的尾帧:忽略,与 dsh 的 recovery 语义一致
      }
    })
    .join("");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("解压后没有任何记录");
  return { header: JSON.parse(lines[0]), rows: lines.slice(1).map((l) => JSON.parse(l)), frames: starts.length };
}

/** 收窄错误信息:去掉随会话变化的 id/uuid,好做直方图。 */
function digest(message) {
  return String(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<uuid>")
    .replace(/\b\d{2,}\b/gu, "<n>")
    .slice(0, 160);
}

async function main() {
  const { sessionFormatCatalog } = await import(`file:///${DSH_ROOT}/dsh-session-format-catalog/lib/index.js`);
  console.log(`catalog currentVersion = ${sessionFormatCatalog.currentVersion}`);
  console.log(`会话目录 = ${SESSIONS}\n`);

  if (!existsSync(SESSIONS)) {
    console.error("找不到会话目录");
    process.exit(1);
  }

  const files = [];
  for (const bucket of readdirSync(SESSIONS)) {
    const bucketPath = join(SESSIONS, bucket);
    let ids;
    try {
      ids = readdirSync(bucketPath);
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = join(bucketPath, id, "session.jsonl.zstd");
      if (existsSync(file)) files.push({ bucket, id, file });
    }
  }
  console.log(`共 ${files.length} 个会话文件\n`);

  const failures = [];
  const reasons = new Map();
  const byVersion = new Map();
  let passed = 0;

  for (const { bucket, id, file } of files) {
    if (ONLY !== undefined && !id.includes(ONLY)) continue;
    let result;
    try {
      const { header, rows, frames } = readLog(file);
      byVersion.set(header.version, (byVersion.get(header.version) ?? 0) + 1);
      const restore = sessionFormatCatalog.createRestore(header, { recovery: "strict", validation: "transformed" });
      for (const row of rows) restore.decodeRow(row);
      restore.finish();
      passed += 1;
      result = `OK   v${header.version} ${frames}帧 ${rows.length}行  ${bucket}/${id.slice(0, 20)}`;
    } catch (error) {
      const message = digest(error?.message ?? error);
      failures.push({ bucket, id, message });
      reasons.set(message, (reasons.get(message) ?? 0) + 1);
      result = `FAIL ${bucket}/${id.slice(0, 20)}  ${message}`;
    }
    if (VERBOSE) console.log(result);
  }

  const total = passed + failures.length;
  console.log(`\n结果: ${passed}/${total} 通过,${failures.length} 个读不出来`);
  console.log(`存储版本分布: ${[...byVersion].map(([v, n]) => `v${v}×${n}`).join(", ")}\n`);

  if (reasons.size > 0) {
    console.log("失败原因(按出现次数):");
    for (const [message, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}×  ${message}`);
    }
    console.log("\n受影响的会话:");
    for (const f of failures) console.log(`  ${f.bucket}/${f.id}`);
  }
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error("体检脚本崩溃:", error);
  process.exit(1);
});
