/**
 * 本机补丁:dsh 0.1.5 读不了 0.1.1 写的会话 —— 这是 dsh 自身的缺陷,不是本扩展的。
 * 这个脚本只修**你自己机器上**的 dsh 安装,和 vsix 交付物无关。
 *
 * 修的是四处「迁移/读取清单过严」,前三处都在 dsh-session-format-v0-to-v1/lib/index.js,
 * 第四处在 dsh-subagent/lib/index.js:
 *
 *   [v0-to-v1] 1. `"permission/preset": disposition(["preset"])`
 *      0.1.1 写的载荷多一个 `origin` 成员,清单只认 `preset`,于是整条事件被判非法。
 *      → 把 `origin` 加进 optional(保留成员原文,不丢字段)。
 *
 *   [v0-to-v1] 2. `if (event.type === "subagent/descriptor" && data["version"] !== 3) { … if (version === 0) throw … }`
 *      0.1.1 写的 descriptor 是 `version: 2`,0.1.5 的 v0 世代据此直接拒收。
 *      同一段代码的 v1 世代分支本来就 `return`(放行任意版本、跳过成员校验),
 *      → 让 v0 世代与它一致:不认识的 descriptor 版本原样保留,不拒收。
 *
 *   [v0-to-v1] 3. `subagentDescriptorValue()` 里的 `literalValue(data["version"], [3], …)`
 *      这是 v2→v3 那一跳的语义校验,绕过了第 2 处,所以单独修。
 *      → 放宽为接受 `2` 与 `3`(实测 version 2 的载荷成员与 v3 逐个一致,只有版本号不同)。
 *
 *   [dsh-subagent] 4. `parseSubagentDescriptor()` 里的 `if (version !== 3) return void 0;`
 *      前三处让**迁移**放过了 v2 descriptor,但 `subagent` 投影仍然只认 v3:
 *      认不出 ⇒ identity 从投影里消失 ⇒ 投影值变成 `null` 哨兵 ⇒
 *      跟随子会话时报 `subagent/catalog-diagnostic: subagent descriptor is corrupt`。
 *      (误导点:真正的意思不是「损坏」,是「认不出这个版本」。)
 *      → 放宽为 `version !== 2 && version !== 3`。实测本机 11 条 v2 descriptor
 *      全是 continuable,成员 {version,mode,provider,label,agentProvider,agentModel}
 *      逐个落在 v3 的 CONTINUABLE_DESCRIPTOR_KEYS 里,后面的成员校验原样保留、全部生效。
 *      **写入侧不受影响**:新 descriptor 仍由 snapshotSubagentDescriptor() 以 version 3 落盘,
 *      SUBAGENT_DESCRIPTOR_VERSION 没动 —— 这里只放宽读取。
 *
 * 为什么必须改 dsh 而不是改会话文件:迁移发生在服务端读日志时,扩展层碰不到;
 * 而重写 118 个会话的 zstd 追加日志风险远大于改这几行(会动到分帧结构与 seq 连续性)。
 *
 * **dsh 每次更新都会覆盖这些文件。** 更新后重跑本脚本即可:
 *   node tools/patch-dsh-session-migration.mjs            # 打补丁(幂等)
 *   node tools/patch-dsh-session-migration.mjs --check    # 只看状态,不改
 *   node tools/patch-dsh-session-migration.mjs --revert   # 从备份还原
 *
 * 打完必须**重启 dsh 服务端**(迁移代码在进程启动时载入),然后跑
 *   node tools/probe-session-migration.mjs     # 离线:文件能不能被 catalog 读通
 *   node dist/probe-live-session-read.js       # 线上:重启后的服务端真读得出来吗
 * 验证:期望从 65/118 变成 118/118。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
const REVERT = argv.includes("--revert");

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const BACKUP_ROOT = join(DSH_HOME, "migration-patch-backup");

/** 所有可能被加载的 dsh 安装树(Node 会就近解析,两份都得改)。 */
const TREES = [
  { label: "program-files", root: "C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai" },
  { label: "dsh-profile", root: join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai") },
];

// ---------- 补丁表 ----------

const V0_TO_V1 = "dsh-session-format-v0-to-v1/lib/index.js";
const SUBAGENT = "dsh-subagent/lib/index.js";

/**
 * 每个文件一组改动。`verify` 是「这条改动是否已经生效」的判据 ——
 * 比 `text.includes(edit.to)` 更牢:`to` 里含自己写的注释,而注释措辞可能被改写。
 */
const PATCHES = [
  {
    file: V0_TO_V1,
    edits: [
      {
        name: "permission/preset 接受 origin 成员",
        from: `\t"permission/preset": disposition(["preset"]),`,
        to: `\t"permission/preset": disposition(["preset"], ["origin"]),`,
      },
      {
        name: "subagent/descriptor 未知版本改为放行(与 v1 世代一致)",
        from: `\tif (event.type === "subagent/descriptor" && data["version"] !== 3) {
\t\tconst descriptorVersion = sessionFormatCount(data["version"], \`\${event.type} \${event.seq} version\`);
\t\tif (version === 0) throw new SessionFormatUnsupportedMigrationError(\`\${event.type} \${event.seq} uses unsupported descriptor version \${descriptorVersion}\`);
\t\treturn;
\t}`,
        to: `\tif (event.type === "subagent/descriptor" && data["version"] !== 3) {
\t\t// [本机补丁] 原为 \`if (version === 0) throw …\`,会拒收 0.1.1 写的 version 2 descriptor。
\t\t// 同段的 v1 世代分支本就放行任意版本(不认识的载荷没法校验成员,只能原样保留),
\t\t// 这里让 v0 世代与之一致。改回原样见 tools/patch-dsh-session-migration.mjs --revert。
\t\treturn;
\t}`,
      },
      {
        name: "subagent/descriptor 语义校验接受 version 2",
        from: `\tliteralValue(data["version"], [3], \`\${label} version\`);`,
        to: `\tliteralValue(data["version"], [2, 3], \`\${label} version\`); // [本机补丁] 0.1.1 写的是 version 2,载荷成员与 v3 一致`,
      },
    ],
  },
  {
    file: SUBAGENT,
    edits: [
      {
        // 这条是三元链(后面紧跟 mode 校验),原文里 `return void 0;` 出现多次,
        // 所以 from 必须带上后一行才能真正唯一。
        name: "subagent 投影接受 version 2 descriptor",
        from: `\tif (version !== 3) return void 0;
\tconst mode = value["mode"];`,
        to: `\t// [本机补丁] 原为 \`if (version !== 3) return void 0;\`,会认不出 0.1.1 写的 version 2,
\t// 于是 subagent 投影变 null 哨兵,跟随子会话报 "subagent descriptor is corrupt"。
\t// v2 的成员与 v3 逐个一致(实测),后面的成员校验原样保留。见 tools/patch-dsh-session-migration.mjs --revert。
\tif (version !== 2 && version !== 3) return void 0;
\tconst mode = value["mode"];`,
      },
    ],
  },
];

// ---------- 工具 ----------

function md5(text) {
  return createHash("md5").update(text).digest("hex").slice(0, 8);
}

/** 备份路径。同一文件在不同安装树里各留一份,免得一份备份被两处复用。 */
function backupPath(label, file) {
  return join(BACKUP_ROOT, label, `${file.replace(/\//gu, "__")}.orig`);
}

/**
 * 老版本脚本按「一棵树一个文件」备份(index.js.orig),多文件补丁后改成按文件名区分。
 * 首次运行时把旧备份搬过去,否则 --revert 会找不到早期那棵树的原始副本。
 */
function migrateLegacyBackup(label, file) {
  // 旧命名只可能属于会话格式那个文件 —— 当时脚本只修它一个
  if (file !== V0_TO_V1) return;
  const legacy = join(BACKUP_ROOT, label, "index.js.orig");
  const current = backupPath(label, file);
  if (existsSync(legacy) && !existsSync(current)) {
    mkdirSync(join(BACKUP_ROOT, label), { recursive: true });
    copyFileSync(legacy, current);
    console.log(`  [迁移旧备份] ${legacy}\n             → ${current}`);
  }
}

function processOne(tree, patch) {
  const path = join(tree.root, patch.file);
  if (!existsSync(path)) {
    console.log(`  [跳过] ${tree.label}:找不到 ${patch.file}`);
    return { changed: 0, ok: true };
  }
  const original = readFileSync(path, "utf8");
  migrateLegacyBackup(tree.label, patch.file);
  const backup = backupPath(tree.label, patch.file);

  if (REVERT) {
    if (!existsSync(backup)) {
      console.log(`  [无法还原] ${tree.label}:没有备份(${backup})`);
      return { changed: 0, ok: false };
    }
    if (readFileSync(backup, "utf8") === original) {
      console.log(`  [已是最初状态] ${tree.label}:${patch.file}`);
      return { changed: 0, ok: true };
    }
    writeFileSync(path, readFileSync(backup, "utf8"));
    console.log(`  [已还原] ${tree.label}:${patch.file} ← ${backup}`);
    return { changed: 1, ok: true };
  }

  let text = original;
  const applied = [];
  const already = [];
  const missing = [];

  for (const edit of patch.edits) {
    if (text.includes(edit.to)) {
      already.push(edit.name);
      continue;
    }
    if (!text.includes(edit.from)) {
      missing.push(edit.name);
      continue;
    }
    text = text.replace(edit.from, edit.to);
    applied.push(edit.name);
  }

  for (const name of already) console.log(`  [已有] ${tree.label}:${name}`);
  for (const name of missing) {
    console.log(`  [找不到目标] ${tree.label}:${name}`);
    console.log(`       在 ${patch.file} 里没找到原文 —— dsh 可能已自行修复或改了写法,请人工核对`);
  }

  if (applied.length === 0) {
    console.log(`  [无需改动] ${tree.label}:${patch.file}`);
    return { changed: 0, ok: missing.length === 0 };
  }

  if (CHECK_ONLY) {
    for (const name of applied) console.log(`  [待打] ${tree.label}:${name}`);
    return { changed: applied.length, ok: true };
  }

  // 首次改动前留一份原始备份;之后不再覆盖,保证 --revert 永远能回到最初
  if (!existsSync(backup)) {
    mkdirSync(join(BACKUP_ROOT, tree.label), { recursive: true });
    writeFileSync(backup, original);
    console.log(`  [备份] ${path}\n         → ${backup}`);
  }
  writeFileSync(path, text);
  for (const name of applied) console.log(`  [已打] ${tree.label}:${name}`);
  console.log(`  [写入] ${path}  ${md5(original)} → ${md5(text)}`);
  return { changed: applied.length, ok: true };
}

// ---------- 主流程 ----------

console.log(`\n=== 本机 dsh 会话读取补丁 ${REVERT ? "(还原)" : CHECK_ONLY ? "(检查)" : "(应用)"} ===\n`);
let total = 0;
let allOk = true;
for (const tree of TREES) {
  for (const patch of PATCHES) {
    const result = processOne(tree, patch);
    total += result.changed;
    allOk &&= result.ok;
  }
}

if (REVERT) {
  console.log(`\n共还原 ${total} 个文件。重启 dsh 服务端后生效。\n`);
} else if (CHECK_ONLY) {
  console.log(total === 0 ? "\n所有安装树都已是目标状态。\n" : `\n有 ${total} 处待打补丁(去掉 --check 即可应用)。\n`);
} else {
  console.log(
    total === 0
      ? "\n无需改动。\n"
      : `\n共改动 ${total} 处。**必须重启 dsh 服务端**(迁移代码在进程启动时载入),然后跑:\n  node tools/probe-session-migration.mjs      # 离线:118/118\n  node dist/probe-live-session-read.js --all  # 线上:重启后的服务端实读\n`,
  );
}
process.exit(allOk ? 0 : 1);
