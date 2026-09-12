/**
 * 本机补丁的**线上实证**:补丁改的是服务端进程里载入的迁移代码,离线体检
 * (probe-session-migration.mjs)读的是磁盘上的同一个文件 —— 两者都不能证明
 * 「重启后的服务端真的能读老会话」。
 *
 * 这里走真正的线上路径:`session/follow` 开一条流,让服务端自己去读
 * `~/.dsh/sessions/**​/session.jsonl.zstd` 并做 v0→v1→v2→v3 迁移。
 *
 * 判据:原先卡住的两类会话,现在都必须回出 records:
 *   - 含 `subagent/descriptor version: 2` 的(11 个,卡在 v2→v3 的语义校验)
 *   - 含 `permission/preset.origin` 的(42 个,卡在 v0→v1 的成员清单)
 *
 * 用法:
 *   npx esbuild tools/probe-live-session-read.ts --bundle --platform=node --format=cjs \
 *     --external:vscode --outfile=dist/probe-live-session-read.js
 *   node dist/probe-live-session-read.js [--all]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";
import { RemoteMux } from "../src/dsh/protocol/mux";
import { resolveAuth } from "../src/dsh/protocol/auth";

const LIVE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS = join(DSH_HOME, "sessions");
const ALL = process.argv.includes("--all");
const EVERY = process.argv.includes("--every");

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 只读 header + rows 的类型,不跑迁移 —— 这里要的是「磁盘上写了什么」。 */
function readLog(file: string): { header: Record<string, unknown>; rows: { type?: string; data?: Record<string, unknown> }[] } {
  const raw = readFileSync(file);
  const starts: number[] = [];
  for (let at = 0; ; ) {
    const found = raw.indexOf(MAGIC, at);
    if (found === -1) break;
    starts.push(found);
    at = found + 1;
  }
  const text = starts
    .map((start, i) => {
      try {
        return zstdDecompressSync(raw.subarray(start, starts[i + 1] ?? raw.length)).toString("utf8");
      } catch {
        return "";
      }
    })
    .join("");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return { header: JSON.parse(lines[0]), rows: lines.slice(1).map((l) => JSON.parse(l)) };
}

interface Candidate {
  bucket: string;
  id: string;
  why: string;
  rows: number;
  /** 子会话的寻址信息:服务端明确要求 kind:"subagent",用 kind:"session" 会被拒。 */
  address: { kind: "session"; sessionId: string } | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" };
}

function collect(): Candidate[] {
  // 子会话的父指针在**子会话自己的 header**里(`parentSession` + `origin:"subagent"`),
  // 不在父会话的 descriptor 里 —— descriptor 载荷只有 {version,mode,provider,label,
  // agentProvider,agentModel},没有 childSessionId。所以父从 header 取,mode 从 descriptor 取。
  const files: { bucket: string; id: string; header: Record<string, unknown>; rows: { type?: string; data?: Record<string, unknown> }[] }[] = [];

  for (const bucket of readdirSync(SESSIONS)) {
    const bucketPath = join(SESSIONS, bucket);
    let ids: string[];
    try {
      ids = readdirSync(bucketPath);
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = join(bucketPath, id, "session.jsonl.zstd");
      if (!existsSync(file)) continue;
      try {
        const { header, rows } = readLog(file);
        files.push({ bucket, id, header, rows });
      } catch {
        continue;
      }
    }
  }

  // 父会话里那张 descriptor 表不够用,但要靠它拿 mode(one-shot / continuable)。
  const modes = new Map<string, "one-shot" | "continuable">();
  for (const f of files) {
    for (const row of f.rows) {
      const child = row.data?.["childSessionId"];
      const mode = row.data?.["mode"];
      if (typeof child === "string" && (mode === "one-shot" || mode === "continuable")) modes.set(child, mode);
    }
  }

  const out: Candidate[] = [];
  for (const f of files) {
    const descriptor = f.rows.find((r) => r.type === "subagent/descriptor");
    const preset = f.rows.find((r) => r.type === "permission/preset");
    const why: string[] = [];
    if (descriptor?.data?.["version"] === 2) why.push("descriptor v2");
    if (preset !== undefined && "origin" in (preset.data ?? {})) why.push("preset.origin");
    // --every:连「不受补丁影响」的会话也一起读。只证明受过影响的能读是不够的,
    // 还得证明其余那些没被改坏 —— 这才是回归。
    if (why.length === 0) {
      if (!EVERY) continue;
      why.push("未受影响(回归对照)");
    }

    const parent = f.header["parentSession"];
    const isSubagent = f.header["origin"] === "subagent" && typeof parent === "string";
    out.push({
      bucket: f.bucket,
      id: f.id,
      why: why.join("+"),
      rows: f.rows.length,
      address: isSubagent
        ? {
            kind: "subagent",
            parentSessionId: parent,
            childSessionId: f.id,
            mode: descriptor?.data?.["mode"] === "one-shot" || descriptor?.data?.["mode"] === "continuable"
              ? (descriptor.data["mode"] as "one-shot" | "continuable")
              : (modes.get(f.id) ?? "continuable"),
          }
        : { kind: "session", sessionId: f.id },
    });
  }
  return out;
}

/** 跟随一条会话流,拿开局 snapshot 的 records 数。 */
function followOnce(mux: RemoteMux, address: Candidate["address"], timeoutMs = 20_000): Promise<{ records: number; error?: string }> {
  return new Promise((resolve) => {
    let records = 0;
    let settled = false;
    const done = (result: { records: number; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.cancel();
      resolve(result);
    };
    const timer = setTimeout(() => done({ records, error: "超时(没收到开局帧)" }), timeoutMs);
    const stream = mux.open(
      "session/follow",
      { request: { address, maxMessages: 200 } },
      {
        onItem: (value: unknown) => {
          const v = value as { type?: string; records?: unknown[]; snapshot?: { records?: unknown[] } };
          // 开局帧可能是 {records} 或 {snapshot:{records}} —— 两种都认,数出条数即可
          if (Array.isArray(v.records)) records = Math.max(records, v.records.length);
          if (Array.isArray(v.snapshot?.records)) records = Math.max(records, v.snapshot.records.length);
          if (records > 0) done({ records });
        },
        onError: (error) => done({ records, error: `${error.code}: ${error.message}` }),
        onEnd: () => done({ records, error: records === 0 ? "流结束但没有任何 records" : undefined }),
      },
    );
  });
}

async function main() {
  console.log(`\n=== 本机补丁线上实证 · session/follow 实读老会话 @ ${LIVE} ===\n`);

  const candidates = collect();
  const byWhy = new Map<string, number>();
  for (const c of candidates) byWhy.set(c.why, (byWhy.get(c.why) ?? 0) + 1);
  console.log(`磁盘上受补丁影响的老会话:${candidates.length} 个`);
  for (const [why, n] of byWhy) console.log(`  ${String(n).padStart(3)}  ${why}`);
  if (candidates.length === 0) {
    console.log("\n没有候选会话,无法实证。\n");
    process.exit(1);
  }

  const auth = await resolveAuth(LIVE, {});
  check("拿到鉴权凭据", auth !== undefined, auth ? `来源=${auth.via}` : "无");

  const mux = new RemoteMux({ baseUrl: LIVE, auth: async () => resolveAuth(LIVE, {}), onLog: (m) => console.log(`     ${m}`) });
  mux.connect();
  await new Promise((r) => setTimeout(r, 1200));

  // 采样:每类各取若干,默认最多 8 个(全量用 --all;连未受影响的也读用 --every)
  const sample = ALL || EVERY ? candidates : candidates.slice(0, 8);
  console.log(`\n逐个实读(${sample.length}/${candidates.length}${ALL || EVERY ? "" : ",加 --all 全量"}):`);

  for (const c of sample) {
    const result = await followOnce(mux, c.address);
    check(
      `读得出 ${c.bucket}/${c.id.slice(0, 8)} [${c.why}] 磁盘 ${c.rows} 行`,
      result.error === undefined && result.records > 0,
      `${c.address.kind === "subagent" ? "子会话寻址 " : ""}${result.error ?? `服务端回出 ${result.records} 条 records`}`,
    );
  }

  mux.dispose();
  console.log(`\n=== ${failures === 0 ? "线上实读通过" : `线上实读未通过(${failures} 项失败)`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("探针崩溃:", error);
  process.exit(1);
});
