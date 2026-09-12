// dsh-git-rollback 安装器的**升级迁移**冒烟测试。
// 用法: node tests/smoke/rollback-manifest.test.js
//
// 为什么单拎出来测:`ensureRollbackPluginInstalled` 在扩展每次激活时都会跑,而它写的
// `profiles/web/package.json` 里那条 `file:` 依赖**是首次安装时写死的绝对路径**。扩展升级后
// (0.12.4 → 0.12.5)那个目录会被 VS Code 删掉,依赖就指向一个不存在的路径 —— profile 里
// 任何 pnpm / `dsh plugin` 操作都会报 ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND。
// 迁移逻辑(syncManifestDependency)此前没有任何测试,而它正好压在**所有升级用户**的必经之路上。
const fs = require("fs");
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));
const out = path.join(os.tmpdir(), "rollback-manifest-" + process.pid + ".cjs");
buildSync({
  entryPoints: [path.join(repo, "src/dsh/rollbackInstall.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
});

// 独立 DSH_HOME:测试不碰用户真实 profile
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rb-home-"));
process.env.DSH_HOME = home;
const profileDir = path.join(home, "profiles", "web");
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "# 头部注释\n[]\n");

// 假的「扩展内置插件目录」,版本 0.1.7 与当前出货一致
const bundledDir = path.join(home, "fake-bundled");
fs.mkdirSync(path.join(bundledDir, "lib"), { recursive: true });
fs.writeFileSync(path.join(bundledDir, "package.json"), JSON.stringify({ name: "dsh-git-rollback", version: "0.1.7" }, null, 2));
fs.writeFileSync(path.join(bundledDir, "lib", "index.js"), "module.exports = {};\n");

const { ensureRollbackPluginInstalled } = require(out);

let fail = 0;
function check(name, ok, detail) {
  if (!ok) fail += 1;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const manifestFile = path.join(profileDir, "package.json");
const readDep = () => JSON.parse(fs.readFileSync(manifestFile, "utf8")).dependencies?.["dsh-git-rollback"];
const writeManifest = (dependencies) =>
  fs.writeFileSync(manifestFile, JSON.stringify({ name: "web-profile", dependencies }, null, 2) + "\n");

(async () => {
  console.log("\n=== 1. 升级场景:文件已最新,但依赖指向已被删除的 0.12.4 目录 ===");
  const stale = "file:c:/Users/dev/.vscode/extensions/foorgange.dsh-vscode-pro-0.12.4/resources/dsh-git-rollback";
  writeManifest({ "dsh-git-rollback": stale, "some-other-dep": "^1.0.0" });
  // 造出「插件文件已经是最新版」的状态,逼安装器走快路径 —— 迁移必须在这条路上也发生
  const targetDir = path.join(profileDir, "node_modules", "dsh-git-rollback");
  fs.mkdirSync(path.join(targetDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, ".dsh-version"), "0.1.7");
  fs.writeFileSync(path.join(targetDir, "package.json"), JSON.stringify({ name: "dsh-git-rollback", version: "0.1.7" }));

  const r1 = await ensureRollbackPluginInstalled(bundledDir);
  check("安装器报 installed", r1.installed === true, JSON.stringify(r1));
  check("快路径上也报告了写入(changed=true)", r1.changed === true, `changed=${r1.changed}`);
  const dep1 = readDep();
  check("陈旧路径已迁移到当前 bundledDir", dep1 === `file:${bundledDir.replace(/\\/g, "/")}`, dep1);
  check("不再指向 0.12.4", !String(dep1).includes("0.12.4"), dep1);
  check("迁移后的路径真的存在", fs.existsSync(String(dep1).replace(/^file:/, "")), String(dep1));
  check(
    "同 manifest 里的其它依赖没被碰",
    JSON.parse(fs.readFileSync(manifestFile, "utf8")).dependencies["some-other-dep"] === "^1.0.0",
  );

  console.log("\n=== 2. 幂等:再跑一次不应重复写 ===");
  const r2 = await ensureRollbackPluginInstalled(bundledDir);
  check("第二次 changed=false", r2.changed === false, `changed=${r2.changed}`);
  check("依赖保持正确", readDep() === `file:${bundledDir.replace(/\\/g, "/")}`, readDep());

  console.log("\n=== 3. 尊重用户手动 pin 的非 file: 版本 ===");
  writeManifest({ "dsh-git-rollback": "^0.1.5" });
  await ensureRollbackPluginInstalled(bundledDir);
  check("registry 版本号原样保留(不被覆盖)", readDep() === "^0.1.5", readDep());

  console.log("\n=== 4. 依赖缺失时补上 ===");
  writeManifest({});
  await ensureRollbackPluginInstalled(bundledDir);
  check("缺失则新增为 file: 指向 bundledDir", readDep() === `file:${bundledDir.replace(/\\/g, "/")}`, readDep());

  console.log("\n=== 5. 全新安装路径:文件未就位 ===");
  writeManifest({});
  fs.rmSync(targetDir, { recursive: true, force: true });
  const r5 = await ensureRollbackPluginInstalled(bundledDir);
  check("全新安装 installed=true changed=true", r5.installed === true && r5.changed === true, JSON.stringify(r5));
  check("插件文件已复制", fs.existsSync(path.join(targetDir, "lib", "index.js")));
  check("版本标记写的是 0.1.7", fs.readFileSync(path.join(targetDir, ".dsh-version"), "utf8").trim() === "0.1.7");
  check("依赖指向 bundledDir", readDep() === `file:${bundledDir.replace(/\\/g, "/")}`, readDep());
  check("cordis.patch.yml 追加了装载行", fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8").includes("dsh-git-rollback"));

  console.log("\n=== 6. profile 尚未初始化时不乱写 ===");
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rb-empty-"));
  process.env.DSH_HOME = home2;
  const r6 = await ensureRollbackPluginInstalled(bundledDir);
  check("profile-missing 时不动手", r6.installed === false && r6.reason === "profile-missing", JSON.stringify(r6));
  check("没有凭空造出 profile 目录", !fs.existsSync(path.join(home2, "profiles", "web", "package.json")));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(home2, { recursive: true, force: true });
  fs.rmSync(out, { force: true });

  console.log(`\n${fail === 0 ? "全部通过" : `有 ${fail} 项失败`}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error("测试崩溃:", error);
  process.exit(1);
});
