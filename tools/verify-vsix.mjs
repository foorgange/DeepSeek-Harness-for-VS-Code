// 发版前校验:打出来的 .vsix 里装的**确实是当前源码**构建的东西。
//
// 为什么需要它:vsix 是一次性产物,而「包里的代码不是最新」这种错没有任何症状 ——
// 安装、激活、跑测试全都正常,只有用户那边少了某个修复。`npm run package` 会先
// `npm run build`,所以仓库里的 dist/ 是现场构建的:包内产物与它逐字节相同,
// 就证明了「包 = 当前源码」。
//
// 用法: npm run package && node tools/verify-vsix.mjs [路径]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vsix = process.argv[2] ?? join(repo, "Releases", "dsh-vscode-pro-0.12.5.vsix");

if (!existsSync(vsix)) {
  console.error(`找不到 ${vsix} —— 先跑 npm run package`);
  process.exit(1);
}

// ---- 解包(.vsix 就是个 zip;Windows 上用 PowerShell,其余平台用 unzip)----
// Windows 上不能用 Expand-Archive:它按扩展名判断,.vsix 会被拒("只支持 .zip")。
// 所以走 .NET 的 ZipFile,它只看内容不看扩展名。
const tmp = mkdtempSync(join(tmpdir(), "verify-vsix-"));
try {
  if (process.platform === "win32") {
    const cmd = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${vsix.replace(/'/g, "''")}', '${tmp.replace(/'/g, "''")}')`,
    ].join(" ");
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { stdio: "pipe" });
  } else {
    execFileSync("unzip", ["-q", "-o", vsix, "-d", tmp], { stdio: "pipe" });
  }
  const root = join(tmp, "extension");
  if (!existsSync(root)) throw new Error(`包里没有 extension/ 目录 —— ${vsix} 不像是一个 vsix`);

  const read = (rel) => readFileSync(join(root, rel)).toString("utf8");
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const js = read("dist/extension.js");
  const rollback = read("resources/dsh-git-rollback/lib/rollback.js");
  const changelog = read("changelog.md");

  // esbuild 把非 ASCII 转义成**大写**十六进制的 \uXXXX(实测「握手」→ 握手),
  // 所以直接 includes 中文串是找不到的,得两种形式都试。
  const esc = (s) =>
    [...s].map((c) => (c.charCodeAt(0) > 127 ? "\\u" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") : c)).join("");
  const has = (s) => js.includes(s) || js.includes(esc(s));

  const results = [];
  const probe = (name, ok) => results.push([name, ok]);

  // ---- 1. 最强证据:包内产物 === 仓库现场构建的产物 ----
  for (const rel of ["dist/extension.js", "dist/webview/ui.js", "dist/webview/settings.js"]) {
    const packaged = join(root, rel);
    const local = join(repo, rel);
    if (!existsSync(packaged)) probe(`逐字节: 包内缺 ${rel}`, false);
    else if (!existsSync(local)) probe(`逐字节: 仓库侧缺 ${rel}(先跑 npm run build)`, false);
    else probe(`逐字节相同 ${rel} (${sha(readFileSync(packaged)).slice(0, 12)})`, sha(readFileSync(packaged)) === sha(readFileSync(local)));
  }

  // ---- 2. 各条修复是否真的在包里 ----
  // 401 收尾链的顺序即语义:拒绝 → 记账 → 状态 → 通知上层 → 掐断 → 排重连。
  // 少任何一步,这条 mux 连同它承载的全部逻辑流都会永久卡死(见 src/dsh/protocol/mux.ts)。
  probe(
    "mux 401 收尾链完整(resume→清 socket→disconnected→onUnauthorized→terminate→scheduleReconnect)",
    /unexpected-response[\s\S]{0,900}?resume\(\)[\s\S]{0,900}?socket=void 0[\s\S]{0,900}?setState\("disconnected"\)[\s\S]{0,900}?onUnauthorized[\s\S]{0,900}?terminate\(\)[\s\S]{0,900}?scheduleReconnect\(\)/.test(js),
  );
  probe("握手被拒的日志文案在包里", has("握手被拒") && has("鉴权凭据未被接受"));
  probe("401 与 403 都判为鉴权被拒(不是只看 401)", /401\|\|[^|]{1,12}403/.test(js));
  probe("令牌有界等待 waitForToken", js.includes("waitForToken"));
  // 「鉴权可刷新」压缩后标识符会被重命名,所以改探一条**只属于新代码**的日志文案
  probe("鉴权按需重解析(新代码独有的日志文案)", has("解析鉴权凭据抛错"));
  probe("服务端管理里 starting 存在", js.includes("starting"));
  probe("PR3 闭包守卫(迟到的旧回调不改写新状态)", /this\.child!==/.test(js));
  probe("PR4 回退 clean 排除 .dsh/rollback", rollback.includes("--exclude=.dsh/rollback"));

  // ---- 3. 元数据 ----
  const pkg = JSON.parse(read("package.json"));
  const version = pkg.version;
  probe(`版本是 ${version}`, /^\d+\.\d+\.\d+$/.test(version));
  probe("vsix 文件名与 package.json 版本一致", vsix.includes(version));
  probe("CHANGELOG 随包发布且非空", changelog.length > 500);

  // ---- 4. 不该被打进来的东西 ----
  const allFiles = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else allFiles.push(relative(root, p).split(sep).join("/"));
    }
  })(root);
  const leaked = allFiles.filter((f) => /^(tests|tools|src|\.dsh|\.github|node_modules)\//.test(f) || f.endsWith(".vsix"));
  probe(`没有误打包 tests/tools/src/.dsh 等(${allFiles.length} 个文件)`, leaked.length === 0);
  if (leaked.length) console.log("  泄漏的文件:", leaked.join(", "));
  probe("回退插件本体随包发布", allFiles.includes("resources/dsh-git-rollback/lib/rollback.js"));

  let miss = 0;
  for (const [name, ok] of results) {
    console.log((ok ? "OK  " : "MISS") + " " + name);
    if (!ok) miss++;
  }
  console.log(miss === 0 ? `\n全部命中 —— ${vsix}` : `\n${miss} 项未命中`);
  process.exitCode = miss === 0 ? 0 : 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
