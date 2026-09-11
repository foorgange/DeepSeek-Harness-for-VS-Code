// pluginRegistry 读写 cordis.patch.yml 的冒泡测试(bundle 层 + 注入器 registry + profile patch 合成)
// 用法: node tests/smoke/plugin-registry.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const out = path.join(os.tmpdir(), "registry-test-" + process.pid + ".cjs");
const { buildSync } = require(path.join(repo, "node_modules/esbuild"));
buildSync({
  entryPoints: [path.join(repo, "src/dsh/pluginRegistry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
});

// 独立 DSH_HOME:测试不碰用户真实 profile
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
process.env.DSH_HOME = home;
const profileDir = path.join(home, "profiles", "web");
fs.mkdirSync(profileDir, { recursive: true });
const patchFile = path.join(profileDir, "cordis.patch.yml");
const PATCH = `# 头部注释
- insert:
    - id: mcp-codebase-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codebase-memory
        transport: stdio
        command: C:/tmp/mcp.exe
- insert:
    - id: mcp-figma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: figma
        transport: streamable-http
        url: https://mcp.figma.com/mcp
- id: mcp-figma
  disabled: true
- insert:
    - id: git-rollback
      name: dsh-git-rollback
      config:
        enabled: true
        gitBin: git
`;
fs.writeFileSync(patchFile, PATCH);

// bundle 层:模拟 @dsh-external/dsh-super-injector
const bundleDir = path.join(profileDir, "node_modules", "@dsh-external", "dsh-super-injector");
fs.mkdirSync(bundleDir, { recursive: true });
const bundlePatch = `- insert:
    - id: dsh-super-injector
      name: '@dsh-external/dsh-super-injector'
      config: {}
`;
fs.writeFileSync(path.join(bundleDir, "cordis.patch.yml"), bundlePatch);
fs.writeFileSync(path.join(bundleDir, "package.json"), JSON.stringify({
  name: "@dsh-external/dsh-super-injector",
  dsh: { bundle: { patch: "./cordis.patch.yml" } }
}));

// profile package.json 声明 bundles
fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
  name: "dsh-profile-web",
  dsh: { profile: { bundles: ["@dsh-external/dsh-super-injector"] } }
}));

// 注入器 registry(模拟运行时注入)
const injDir = path.join(home, "super-injector");
fs.mkdirSync(injDir, { recursive: true });
fs.writeFileSync(path.join(injDir, "registry.json"), JSON.stringify([
  { name: "dsh-routing-suite", dir: "C:/fake", injectedAt: 123 },
  { name: "mode-boost", dir: "C:/fake/mode-boost", injectedAt: 456 },
]));

const { readRegistry, togglePlugin } = require(out);
let fail = 0;
function check(name, ok) { console.log((ok ? "OK  " : "FAIL") + " " + name); if (!ok) fail++; }

// 1) 合成读取:profile patch + bundle + injected
let r = readRegistry();
check("解析无错误", !r.parseError && r.exists);
check("共 6 个条目(3 profile + 1 bundle + 2 injected)", r.plugins.length === 6);
const mcp = r.plugins.find((p) => p.id === "mcp-codebase-memory");
const figma = r.plugins.find((p) => p.id === "mcp-figma");
const rollback = r.plugins.find((p) => p.id === "git-rollback");
const injector = r.plugins.find((p) => p.id === "dsh-super-injector");
const routing = r.plugins.find((p) => p.id === "dsh-routing-suite");
const boost = r.plugins.find((p) => p.id === "mode-boost");
check("MCP 识别(mcp-codebase-memory)", mcp && mcp.kind === "mcp" && mcp.serverName === "codebase-memory");
check("disabled 覆盖生效(mcp-figma 禁用)", figma && figma.enabled === false && figma.disabledOverride === true);
check("bundle 条目(dsh-super-injector)", injector && injector.source === "bundle" && injector.enabled === true);
check("注入条目(dsh-routing-suite)", routing && routing.source === "injected" && routing.enabled === true);
check("注入条目(mode-boost)", boost && boost.source === "injected" && boost.enabled === true);

// 2) 禁用 bundle 行(通过 profile patch 覆盖)
let toggled = togglePlugin("dsh-super-injector", false);
check("禁用 bundle 行成功", toggled.ok);
const afterDisable = readRegistry();
check("禁用后 bundle 行 enabled=false", afterDisable.plugins.find((p) => p.id === "dsh-super-injector")?.enabled === false);
const text1 = fs.readFileSync(patchFile, "utf8");
check("profile patch 含 disabled 覆盖(而非 bundle 自身)", text1.includes("dsh-super-injector") && text1.includes("disabled: true"));

// 3) 重新启用
toggled = togglePlugin("dsh-super-injector", true);
check("启用成功", toggled.ok);
const afterEnable = readRegistry();
check("启用后 bundle 行 enabled=true", afterEnable.plugins.find((p) => p.id === "dsh-super-injector")?.enabled === true);
const yaml2 = require("js-yaml");
const ops2 = yaml2.load(fs.readFileSync(patchFile, "utf8"));
const disableOps = ops2.filter((op) => op && typeof op === "object" && op.insert === undefined);
check("bundle 行覆盖条目已移除", !disableOps.some((op) => op.id === "dsh-super-injector"));
check("mcp-figma 覆盖条目仍在", disableOps.some((op) => op.id === "mcp-figma" && op.disabled === true));

// 4) 不存在的插件
toggled = togglePlugin("no-such-plugin", false);
check("未知插件返回错误", !toggled.ok && toggled.error);

// 5) 损坏 YAML
fs.writeFileSync(patchFile, "- insert: [broken\n  : : :");
r = readRegistry();
check("损坏 YAML 报告 parseError", r.parseError !== undefined);

// 6) 空注入器 registry
fs.writeFileSync(path.join(injDir, "registry.json"), "[]");
r = readRegistry();
check("空 registry 无注入条目", !r.plugins.some((p) => p.source === "injected"));

// 7) 无 bundles 无 inject 的纯 profile 模式(降级兼容)
fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ name: "dsh-profile-web" }));
fs.writeFileSync(patchFile, `- insert:\n    - id: solo\n      name: solo-plugin\n      config: {}\n`);
r = readRegistry();
check("纯 profile 模式正常工作", r.plugins.length === 1 && r.plugins[0].id === "solo");

try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
try { fs.unlinkSync(out); } catch {}
console.log("\n结果:", fail === 0 ? "全部通过 (" + 20 + " 项)" : fail + " 项失败");
process.exit(fail === 0 ? 0 : 1);