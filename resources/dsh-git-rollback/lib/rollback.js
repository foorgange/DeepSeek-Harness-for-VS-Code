/**
 * 回退引擎:非破坏性的 /rollback [N] 与 /redo。
 *
 * /rollback:保存点(add -A → commit-tree -p HEAD → refs/dsh/saves/<sid>)→
 *   内容级恢复(read-tree --reset -u 目标检查点,工作区+索引=检查点树)→
 *   clean -fd 删除检查点之后新建的未跟踪文件(ignored 永不触碰)→
 *   reset --quiet 还原索引到 HEAD。**HEAD 与分支历史完全不动**:
 *   git log / git branch 永远看不到任何 dsh 提交,你自己的提交原封不动留在分支上。
 * /redo:同样以内容级恢复回保存点。任何提交/文件状态都不丢失:回退前的
 *   完整状态(含未跟踪)在保存点提交树内,分支指针从未移动。
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExec, readRecord, saveRef, shortHash, untrackedList, writeRecord } from "./git.js";
import { MAX_ROLLS } from "./types.js";
/** 解析 /rollback 参数:空 = 最近一回合;数字 = 回合号;40 位十六进制 = 直接指定检查点提交。 */
export function parseTurnArg(rawInput) {
    const raw = rawInput.trim();
    if (raw === "")
        return Number.NaN; // 调用方以 NaN 表示「最近」
    if (/^[0-9a-f]{40}$/i.test(raw))
        return { sha: raw.toLowerCase() };
    if (!/^\d+$/.test(raw))
        return { error: `无效的回合号:「${raw}」` };
    const n = Number.parseInt(raw, 10);
    return Number.isSafeInteger(n) ? n : { error: `无效的回合号:「${raw}」` };
}
/**
 * 内容级恢复:把工作区+索引恢复成 commit 的树,HEAD/分支引用不动。
 * read-tree 遇未跟踪文件阻碍时先 clean -fd 再重试;最后 reset --quiet 把索引还原回 HEAD
 * (检查点树里"当时未跟踪、现已被还原"的文件重新显示为未跟踪,不污染暂存区)。
 * clean 必须排除 .dsh/rollback:检查点快照故意不收录该目录,否则回退会删掉所有会话的记录文件。
 */
async function restoreTreeContent(gitBin, cwd, commit) {
    const cleanArgs = ["clean", "-fd", "--exclude=.dsh/rollback"];
    const first = await gitExec(gitBin, cwd, ["read-tree", "--reset", "-u", commit]);
    if (!first.ok) {
        await gitExec(gitBin, cwd, cleanArgs);
        const retry = await gitExec(gitBin, cwd, ["read-tree", "--reset", "-u", commit]);
        if (!retry.ok)
            return { ok: false, reason: `read-tree: ${retry.stderr || first.stderr || "failed"}` };
    }
    const clean = await gitExec(gitBin, cwd, cleanArgs);
    const reset = await gitExec(gitBin, cwd, ["reset", "--quiet"]);
    if (!clean.ok || !reset.ok)
        return { ok: false, reason: `clean/reset: ${clean.stderr || reset.stderr || ""}`.trim() };
    return { ok: true };
}
/**
 * 保存点 + 内容级恢复(targetCommit 为目标树所在提交;HEAD/分支历史不动)。
 * 返回保存点提交与回退前的未跟踪清单(供记录与结果文案)。
 */
async function savepointAndRestore(gitBin, cwd, sid, targetCommit, opts) {
    const head = await gitExec(gitBin, cwd, ["rev-parse", "--verify", "HEAD"]);
    if (!head.ok)
        return { ok: false, reason: "仓库还没有任何提交,无法回退" };
    // 1) 保存点:当前完整状态(含未跟踪)入 refs/dsh/saves/<sid>
    const idx = await gitExec(gitBin, cwd, ["write-tree"]);
    if (!idx.ok)
        return { ok: false, reason: `保存点失败:${idx.stderr || "write-tree failed"}` };
    let saveCommit;
    try {
        const add = await gitExec(gitBin, cwd, ["add", "-A"]);
        if (!add.ok)
            return { ok: false, reason: `保存点失败:${add.stderr || "add failed"}` };
        await gitExec(gitBin, cwd, ["reset", "--quiet", "--", ".dsh/rollback"]);
        const tree = await gitExec(gitBin, cwd, ["write-tree"]);
        if (!tree.ok)
            return { ok: false, reason: `保存点失败:${tree.stderr || "write-tree failed"}` };
        const commit = await gitExec(gitBin, cwd, [
            "-c", "commit.gpgsign=false", "commit-tree", tree.stdout, "-p", head.stdout,
            "-m", `${opts.commitPrefix}-save ${sid} before rollback to ${targetCommit.slice(0, 8)}`,
        ]);
        if (!commit.ok) {
            const retry = await gitExec(gitBin, cwd, [
                "-c", "user.name=dsh-checkpoint", "-c", "user.email=dsh-checkpoint@localhost",
                "-c", "commit.gpgsign=false", "commit-tree", tree.stdout, "-p", head.stdout,
                "-m", `${opts.commitPrefix}-save ${sid} before rollback to ${targetCommit.slice(0, 8)}`,
            ]);
            if (!retry.ok)
                return { ok: false, reason: `保存点失败:${retry.stderr || commit.stderr || "commit-tree failed"}` };
            saveCommit = retry.stdout;
        }
        else {
            saveCommit = commit.stdout;
        }
    }
    finally {
        await gitExec(gitBin, cwd, ["read-tree", idx.stdout]);
    }
    await gitExec(gitBin, cwd, ["update-ref", saveRef(opts.refPrefix, sid), saveCommit]);
    const currentUntracked = await untrackedList(gitBin, cwd);
    // 2) 内容级恢复:read-tree 使索引=目标树(保护快照内未跟踪文件),
    //    clean -fd 自动精确删除目标之后新建的未跟踪文件;HEAD/分支历史不动。
    const restored = await restoreTreeContent(gitBin, cwd, targetCommit);
    if (!restored.ok)
        return { ok: false, reason: `回退失败:${restored.reason}` };
    return { ok: true, saveCommit, untracked: currentUntracked.files, truncated: currentUntracked.truncated };
}
/** 把一次回退记录追加进会话记录(保存点 /redo 依据)。 */
function recordRoll(cwd, sid, record, roll) {
    record.rolls.push(roll);
    if (record.rolls.length > MAX_ROLLS)
        record.rolls = record.rolls.slice(-MAX_ROLLS);
    record.updatedAt = Date.now();
    writeRecord(cwd, sid, record);
}
export async function performRollback(gitBin, cwd, sid, rawInput, opts) {
    const parsed = parseTurnArg(rawInput);
    if (typeof parsed === "object" && "error" in parsed)
        return { kind: "error", text: parsed.error };
    const top = await gitExec(gitBin, cwd, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || !top.stdout)
        return { kind: "error", text: "工作区不是 git 仓库,无法回退" };
    const record = readRecord(cwd, sid);
    // SHA 模式:直接恢复到指定检查点提交(分叉分隔线「还原检查点」兜底:父会话的回合结束快照)。
    // 不需要本会话的记录;保存点与 roll 记录照常写入本会话,支持 /redo。
    if (typeof parsed === "object" && "sha" in parsed) {
        const verify = await gitExec(gitBin, cwd, ["rev-parse", "--verify", `${parsed.sha}^{commit}`]);
        if (!verify.ok)
            return { kind: "error", text: `提交 ${parsed.sha.slice(0, 8)} 不存在或不可达,无法回退` };
        const res = await savepointAndRestore(gitBin, cwd, sid, parsed.sha, opts);
        if (!res.ok)
            return { kind: "error", text: res.reason };
        // 被 clean 删除的新建未跟踪文件 = 回退前的未跟踪清单 − 目标树中已有的文件
        const treeFiles = await gitExec(gitBin, cwd, ["ls-tree", "-r", "--name-only", parsed.sha]);
        const treeSet = new Set(treeFiles.ok ? treeFiles.stdout.split(/\r?\n/) : []);
        const removed = res.truncated ? -1 : (res.untracked ?? []).filter((f) => !treeSet.has(f)).length;
        if (record) {
            recordRoll(cwd, sid, record, {
                turn: -1,
                to: parsed.sha,
                redo: res.saveCommit,
                removed,
                untracked: res.untracked ?? [],
                truncated: !!res.truncated,
                time: Date.now(),
            });
        }
        const removedText = removed < 0 ? "已按目标快照清理新建的未跟踪文件" : `删除目标之后新建的未跟踪文件 ${removed} 个`;
        return {
            kind: "success",
            text: `已恢复到检查点 ${parsed.sha.slice(0, 8)}。\n` +
                `${removedText};回退前的完整状态已存入保存点 ${shortHash(res.saveCommit)}。\n` +
                `HEAD 与分支历史保持不变;/redo 可恢复。`,
        };
    }
    if (!record || record.checkpoints.length === 0) {
        return { kind: "error", text: "本会话还没有检查点(每个回合开始前自动快照)" };
    }
    const turn = Number.isNaN(parsed) ? record.checkpoints[record.checkpoints.length - 1].turn : parsed;
    const entry = record.checkpoints.find((c) => c.turn === turn);
    if (!entry)
        return { kind: "error", text: `没有回合 ${turn} 的检查点(用 /checkpoints 查看可用回合)` };
    const res = await savepointAndRestore(gitBin, cwd, sid, entry.commit, opts);
    if (!res.ok)
        return { kind: "error", text: res.reason };
    const manifest = new Set(entry.untracked ?? []);
    const removed = entry.truncated ? -1 : (res.untracked ?? []).filter((f) => !manifest.has(f)).length;
    recordRoll(cwd, sid, record, {
        turn,
        to: entry.commit,
        redo: res.saveCommit,
        removed,
        untracked: res.untracked ?? [],
        truncated: !!res.truncated,
        time: Date.now(),
    });
    const removedText = removed < 0 ? "已按检查点清理新建的未跟踪文件" : `删除回合后新建的未跟踪文件 ${removed} 个`;
    const truncNote = entry.truncated ? "\n(该检查点的未跟踪清单超限被截断,清理以索引为准,请手动确认)" : "";
    return {
        kind: "success",
        text: `已回退到回合 ${turn} 之前(检查点 ${shortHash(entry.commit)})。\n` +
            `${removedText};你的既有提交与改动已存入保存点 ${shortHash(res.saveCommit)}。\n` +
            `HEAD 与分支历史保持不变;/redo 可恢复;/checkpoints 查看全部检查点。${truncNote}`,
    };
}
export async function performRedo(gitBin, cwd, sid, opts) {
    const record = readRecord(cwd, sid);
    const roll = record && record.rolls.length > 0 ? record.rolls[record.rolls.length - 1] : undefined;
    if (!roll)
        return { kind: "error", text: "没有可重做的回退(先执行 /rollback)" };
    const verify = await gitExec(gitBin, cwd, ["rev-parse", "--verify", `${roll.redo}^{commit}`]);
    if (!verify.ok)
        return { kind: "error", text: "保存点已不可达(可能被 git gc),无法重做" };
    const currentUntracked = await untrackedList(gitBin, cwd);
    const restored = await restoreTreeContent(gitBin, cwd, roll.redo);
    if (!restored.ok)
        return { kind: "error", text: `重做失败:${restored.reason}` };
    const manifest = new Set(roll.untracked ?? []);
    const removed = roll.truncated ? -1 : currentUntracked.files.filter((f) => !manifest.has(f)).length;
    roll.redoneAt = Date.now();
    record.updatedAt = Date.now();
    writeRecord(cwd, sid, record);
    const removedText = removed < 0 ? "已按保存点清理新建的未跟踪文件" : `删除回退后新建的未跟踪文件 ${removed} 个`;
    return { kind: "success", text: `已恢复到回退前的状态(保存点 ${shortHash(roll.redo)}),${removedText};HEAD 与分支历史保持不变。` };
}
/**
 * 精确撤销 /undo [N]:只撤销该会话某个回合自身产生的文件改动
 * (反向应用 diff(回合开始检查点 → 回合结束快照)),**不触碰你自己提交的内容**。
 * 回合结束后你自己手动改动的文件若与撤销补丁冲突,会明确报错并保留补丁供手动处理。
 */
export async function performUndo(gitBin, cwd, sid, rawInput, opts) {
    const top = await gitExec(gitBin, cwd, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || !top.stdout)
        return { kind: "error", text: "工作区不是 git 仓库,无法撤销" };
    const record = readRecord(cwd, sid);
    if (!record || record.checkpoints.length === 0) {
        return { kind: "error", text: "本会话还没有检查点(每个回合开始前自动快照)" };
    }
    const raw = rawInput.trim();
    let turn;
    if (raw === "") {
        const last = [...record.checkpoints].reverse().find((c) => c.after);
        if (!last)
            return { kind: "error", text: "没有可撤销的回合(需要该回合结束后的快照;旧记录的回合无结束快照,可用 /rollback N 整体回退)" };
        turn = last.turn;
    }
    else {
        if (!/^\d+$/.test(raw))
            return { kind: "error", text: `无效的回合号:「${raw}」` };
        turn = Number.parseInt(raw, 10);
    }
    const entry = record.checkpoints.find((c) => c.turn === turn);
    if (!entry)
        return { kind: "error", text: `没有回合 ${turn} 的检查点(用 /checkpoints 查看可用回合)` };
    if (!entry.after) {
        return { kind: "error", text: `回合 ${turn} 没有结束快照(该回合无改动或记录来自旧版本),无法精确撤销;可用 /rollback ${turn} 整体回退` };
    }
    const stats = await gitExec(gitBin, cwd, ["diff", "--numstat", entry.commit, entry.after.commit, "--"]);
    // trim:false —— 补丁必须逐字节完整(git diff 以换行结尾,trim 会删掉它导致 apply 报 corrupt patch)
    const diff = await gitExec(gitBin, cwd, ["diff", "--no-color", "--binary", entry.commit, entry.after.commit, "--"], { trim: false });
    if (!diff.ok || !stats.ok)
        return { kind: "error", text: `生成回合 ${turn} 的改动失败:${diff.stderr || "git diff failed"}` };
    if (!diff.stdout.trim())
        return { kind: "success", text: `回合 ${turn} 没有可撤销的文件改动。` };
    const fileCount = stats.stdout.split(/\r?\n/).filter(Boolean).length;
    // 反向应用:先 --check 验证,避免应用中途失败留下半成品。
    // --ignore-whitespace:Windows core.autocrlf=true 时工作区是 CRLF 而补丁是 LF,
    // 默认 apply 会因行尾不匹配而失败(中文/普通文件都一样),必须忽略行尾差异。
    const check = await gitExec(gitBin, cwd, ["apply", "-R", "--check", "--binary", "--ignore-whitespace", "-"], {
        stdin: diff.stdout,
    });
    if (!check.ok) {
        const patchFile = join(tmpdir(), `dsh-undo-${sid}-${turn}.patch`);
        writeFileSync(patchFile, diff.stdout, "utf8");
        return {
            kind: "error",
            text: `撤销回合 ${turn} 的改动失败:当前工作区与该回合结束时不一致(可能你自己改过相同文件)。\n` +
                `补丁已保存到 ${patchFile},可手动执行 git apply -R ${patchFile} 处理冲突。`,
        };
    }
    const apply = await gitExec(gitBin, cwd, ["apply", "-R", "--binary", "--ignore-whitespace", "-"], { stdin: diff.stdout });
    if (!apply.ok)
        return { kind: "error", text: `撤销失败:${apply.stderr || "git apply failed"}` };
    record.undos = [...(record.undos ?? []), { turn, time: Date.now() }];
    record.updatedAt = Date.now();
    writeRecord(cwd, sid, record);
    return {
        kind: "success",
        text: `已撤销回合 ${turn} 产生的改动(共 ${fileCount} 个文件)。你自己提交的内容与 HEAD 不受影响;如需整体回退请用 /rollback ${turn}。`,
    };
}
export async function listCheckpoints(gitBin, cwd, sid, opts) {
    const top = await gitExec(gitBin, cwd, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || !top.stdout)
        return { kind: "error", text: "工作区不是 git 仓库" };
    const record = readRecord(cwd, sid);
    if (!record || record.checkpoints.length === 0) {
        return { kind: "success", text: "本会话暂无检查点。检查点会在每个回合开始前自动创建(turn/start 时快照工作区)。" };
    }
    const head = await gitExec(gitBin, cwd, ["rev-parse", "--short", "HEAD"]);
    const status = await gitExec(gitBin, cwd, ["status", "--porcelain"]);
    const dirty = status.ok && status.stdout ? status.stdout.split(/\r?\n/).length : 0;
    const lines = [];
    lines.push(`会话检查点(共 ${record.checkpoints.length} 个,工作区当前 HEAD ${head.stdout},未提交改动 ${dirty} 项):`);
    for (const c of record.checkpoints) {
        const when = new Date(c.time).toLocaleString();
        const unt = (c.untracked ?? []).length;
        lines.push(`  回合 ${c.turn} · ${shortHash(c.commit)} · ${when} · 未跟踪 ${unt}${c.truncated ? "(截断)" : ""}`);
    }
    const lastRoll = record.rolls[record.rolls.length - 1];
    if (lastRoll) {
        lines.push(`最近回退:回合 ${lastRoll.turn} → ${shortHash(lastRoll.to)};保存点 ${shortHash(lastRoll.redo)}(/redo 恢复)`);
    }
    lines.push(`用法:/rollback [N](默认最近一回合);/redo 恢复最近回退。`);
    lines.push(`清理:git update-ref -d ${opts.refPrefix}/checkpoints/${sid} 与 ${opts.refPrefix}/saves/${sid}(连同 .dsh/rollback 记录文件)`);
    return { kind: "success", text: lines.join("\n") };
}
