// C1 回归:ServerManager.starting 成功启动后必须复位,允许再次启动
// 用法: node tests/smoke/server-manager.test.js
//
// 覆盖行为(不只读私有字段):
//   1. 启动中 status.starting 为 true
//   2. 成功启动后 status.starting 复位、server up
//   3. stop() 后进程退出,status 不再处于 starting
//   4. 第二次 ensure() 能真正重新 spawn 并再次 up
//   5. 子进程异常退出后 starting 不保持,可再次 start
//
// 使用本地假 launcher(node HTTP server),不依赖真实 dsh。
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.join(__dirname, "..", "..");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));
const out = path.join(os.tmpdir(), "server-manager-test-" + process.pid + ".cjs");
buildSync({
  entryPoints: [path.join(repo, "src/dsh/serverManager.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
});
const { ServerManager } = require(out);

let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? "OK  " : "FAIL") + " " + name + (extra ? "  [" + extra + "]" : ""));
  if (!ok) fail++;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

/** 找一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
    srv.on("error", reject);
  });
}

/** 写一个可被 ServerManager 调用的假 dsh 启动器:--version 成功;web 起 HTTP 服务。 */
function writeFakeDsh(dir, port) {
  const serverJs = path.join(dir, "fake-server.js");
  fs.writeFileSync(
    serverJs,
    `
const http = require("http");
const port = ${port};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html>ok</html>");
});
server.listen(port, "127.0.0.1", () => {
  process.send && process.send("ready");
});
// 保持存活;设置了 DSH_FAKE_EXIT_MS 时到点自行崩溃(模拟异常退出,不调用 stop)
setInterval(() => {}, 1000);
if (process.env.DSH_FAKE_EXIT_MS) {
  setTimeout(() => process.exit(1), Number(process.env.DSH_FAKE_EXIT_MS));
}
`,
  );
  // Windows: .cmd 包一层 node;POSIX: sh 脚本
  let launcher;
  if (process.platform === "win32") {
    launcher = path.join(dir, "fake-dsh.cmd");
    fs.writeFileSync(
      launcher,
      `@echo off\r\nif "%1"=="--version" (\r\n  echo 0.0.1\r\n  exit /b 0\r\n)\r\nif "%1"=="web" (\r\n  node "${serverJs}"\r\n  exit /b %ERRORLEVEL%\r\n)\r\nexit /b 1\r\n`,
    );
  } else {
    launcher = path.join(dir, "fake-dsh");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.0.1; exit 0; fi\nif [ "$1" = "web" ]; then exec node "${serverJs}"; fi\nexit 1\n`,
    );
    fs.chmodSync(launcher, 0o755);
  }
  return launcher;
}

async function isListening(url, timeoutMs = 800) {
  try {
    const res = await fetch(url + "/", {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sm-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const launcher = writeFakeDsh(tmp, port);
  const logs = [];
  const statuses = [];

  const mgr = new ServerManager(
    {
      url,
      command: launcher,
      autoStart: true,
      timeoutSec: 8,
      cwd: () => tmp,
      onLog: (m) => logs.push(m),
    },
    (s) => statuses.push({ ...s, t: Date.now() }),
  );

  let pollStarting;
  try {
    // ---------- 1) 第一次 ensure:应真正 spawn 并 up ----------
    const startingSeen = [];
    pollStarting = setInterval(() => {
      if (mgr.status.starting) startingSeen.push(true);
    }, 50);
    const first = await mgr.ensure();
    clearInterval(pollStarting);

    check("第一次 ensure 成功", first.up === true, JSON.stringify(first));
    check("启动过程中出现 starting=true", startingSeen.length > 0 || statuses.some((s) => s.starting));
    check("成功后 status.starting === false", mgr.status.starting === false, "starting=" + mgr.status.starting);
    check("成功后 status.up === true", mgr.status.up === true);
    check("成功后 status.startedByUs === true", mgr.status.startedByUs === true);
    check("HTTP 实际可达", (await isListening(url)) === true);

    const spawnCountAfterFirst = logs.filter((l) => l.includes("已启动子进程")).length;
    check("第一次启动有 spawn 日志", spawnCountAfterFirst === 1, "count=" + spawnCountAfterFirst);

    // ---------- 2) stop:进程树退出 ----------
    const stopped = await mgr.stop();
    check("stop 成功", stopped.ok === true, JSON.stringify(stopped));
    // 等端口真正关掉(子进程树可能略慢)
    const down = await waitFor(() => isListening(url).then((up) => !up), 5000);
    check("stop 后 HTTP 已下线", down === true);
    check("stop 后 status.starting === false", mgr.status.starting === false, "starting=" + mgr.status.starting);

    // ---------- 3) 第二次 ensure:必须重新进入 start() 并成功 ----------
    // 若 C1 存在:ensure 会误判 this.starting==true,只等待不 spawn,最终 timeout 失败
    const second = await mgr.ensure();
    check("第二次 ensure 成功(允许重新启动)", second.up === true, JSON.stringify(second));
    check("第二次后 status.starting === false", mgr.status.starting === false, "starting=" + mgr.status.starting);
    check("第二次后 HTTP 再次可达", (await isListening(url)) === true);

    const spawnCountAfterSecond = logs.filter((l) => l.includes("已启动子进程")).length;
    check("第二次启动再次 spawn(共 2 次)", spawnCountAfterSecond === 2, "count=" + spawnCountAfterSecond);

    // ---------- 4) 子进程自行崩溃(全程不调用 stop)后,starting 不得卡死 ----------
    // 先干净停掉第二个实例,再让下一个子进程 1.5s 后自行退出:
    // 只有这条路径会走到 exit 回调,与 stop() 内部的复位无关。
    await mgr.stop();
    await waitFor(() => isListening(url).then((up) => !up), 5000);
    process.env.DSH_FAKE_EXIT_MS = "1500";
    let third;
    try {
      third = await mgr.ensure();
    } finally {
      delete process.env.DSH_FAKE_EXIT_MS;
    }
    check("第三次 ensure 成功(崩溃前的实例已起来)", third.up === true, JSON.stringify(third));
    const spawnCountAfterThird = logs.filter((l) => l.includes("已启动子进程")).length;
    check("第三次启动再次 spawn(共 3 次)", spawnCountAfterThird === 3, "count=" + spawnCountAfterThird);

    // 等它自己死掉(不调用 stop):这才是 exit 回调路径
    const crashed = await waitFor(() => isListening(url).then((up) => !up), 8000);
    check("子进程已自行退出(未调用 stop)", crashed === true);
    check("崩溃后 status.up === false", mgr.status.up === false, JSON.stringify(mgr.status));
    check("崩溃后 status.starting === false", mgr.status.starting === false, "starting=" + mgr.status.starting);
    check("崩溃后 status.startedByUs === false", mgr.status.startedByUs === false, JSON.stringify(mgr.status));

    // 崩溃之后必须还能再拉起来
    const fourth = await mgr.ensure();
    check("异常退出后第四次 ensure 成功", fourth.up === true, JSON.stringify(fourth));
    const spawnCountAfterFourth = logs.filter((l) => l.includes("已启动子进程")).length;
    check("第四次也重新 spawn(共 4 次)", spawnCountAfterFourth === 4, "count=" + spawnCountAfterFourth);
  } finally {
    // 收尾放在 finally:任何断言抛错都要杀掉 detached 子进程并清理临时文件,
    // 否则假服务器会活过本次测试、占住端口并污染后续运行。
    if (pollStarting) clearInterval(pollStarting);
    delete process.env.DSH_FAKE_EXIT_MS;
    try {
      await mgr.stop();
    } catch {}
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    try {
      fs.unlinkSync(out);
    } catch {}
  }

  console.log("\n结果:", fail === 0 ? "全部通过" : fail + " 项失败");
  if (fail > 0) {
    console.log("--- logs ---");
    for (const l of logs) console.log(" ", l);
    console.log("--- last statuses ---");
    for (const s of statuses.slice(-8)) console.log(" ", JSON.stringify(s));
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
