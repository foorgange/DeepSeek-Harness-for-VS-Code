// C2 regression: rollback's git clean must preserve .dsh/rollback records
// while still removing other untracked files created after the checkpoint.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { performRollback } from "../lib/rollback.js";
import { RECORD_DIR } from "../lib/types.js";

const GIT_BIN = "git";

function git(cwd, args) {
  return execFileSync(GIT_BIN, ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-rb-c2-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "app.js"), "console.log('v1');\n");
  git(dir, ["add", "app.js"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

/** Build a checkpoint the same way checkpointTurn does (exclude .dsh/rollback from the tree). */
function makeCheckpoint(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["reset", "--quiet", "--", RECORD_DIR]);
  const tree = git(dir, ["write-tree"]);
  const parent = git(dir, ["rev-parse", "HEAD"]);
  return git(dir, [
    "-c", "commit.gpgsign=false",
    "commit-tree", tree,
    "-p", parent,
    "-m", message,
  ]);
}

test("rollback preserves .dsh/rollback records and still cleans other untracked files", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Multi-session records: C2 wiped every file under .dsh/rollback
  mkdirSync(join(dir, RECORD_DIR), { recursive: true });
  writeFileSync(
    join(dir, RECORD_DIR, "sessionB.json"),
    JSON.stringify({ version: 2, sessionId: "sessionB", checkpoints: [], rolls: [] }),
  );

  // Agent file that exists at checkpoint time (stays after rollback)
  writeFileSync(join(dir, "helper.js"), "agent work\n");
  const cp = makeCheckpoint(dir, "dsh-checkpoint sessionA turn 1");
  assert.match(cp, /^[0-9a-f]{40}$/);

  // Untracked noise created after the checkpoint (must be cleaned by rollback)
  writeFileSync(join(dir, "noise-after.txt"), "should be cleaned\n");
  mkdirSync(join(dir, "noise-dir"), { recursive: true });
  writeFileSync(join(dir, "noise-dir", "x.txt"), "y\n");

  const parent = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(dir, RECORD_DIR, "sessionA.json"),
    JSON.stringify({
      version: 2,
      sessionId: "sessionA",
      cwd: dir,
      checkpoints: [
        {
          turn: 1,
          commit: cp,
          parent,
          time: Date.now(),
          untracked: ["helper.js"],
          truncated: false,
        },
      ],
      rolls: [],
    }),
  );

  const opts = {
    gitBin: GIT_BIN,
    refPrefix: "refs/dsh",
    commitPrefix: "dsh-checkpoint",
  };
  const result = await performRollback(GIT_BIN, dir, "sessionA", "1", opts);
  assert.equal(result.kind, "success", result.text);

  // C2 core: records for all sessions survive
  assert.ok(existsSync(join(dir, RECORD_DIR, "sessionA.json")), "sessionA.json preserved");
  assert.ok(existsSync(join(dir, RECORD_DIR, "sessionB.json")), "sessionB.json preserved");
  assert.equal(
    JSON.parse(readFileSync(join(dir, RECORD_DIR, "sessionB.json"), "utf8")).sessionId,
    "sessionB",
  );

  // Existing rollback behavior: post-checkpoint untracked files are removed
  assert.equal(existsSync(join(dir, "noise-after.txt")), false, "noise-after.txt cleaned");
  assert.equal(existsSync(join(dir, "noise-dir")), false, "noise-dir cleaned");

  // Checkpoint content stays available
  assert.ok(existsSync(join(dir, "app.js")), "tracked baseline preserved");
  assert.ok(existsSync(join(dir, "helper.js")), "checkpoint-time agent file preserved");
});
