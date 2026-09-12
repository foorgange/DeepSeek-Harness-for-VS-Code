// RemoteMux 的建连语义测试 —— 起一个真的 ws 服务端,数它收到了几条连接。
// 用法: node tests/smoke/protocol-mux.test.js
//
// 这里压的是一个**实测撞到过的**缺陷:`connect()` 的文档写着「幂等」,但守卫只看了
// `socket !== undefined`,而 `socket` 要等 `await auth()` 之后才赋值 —— 于是两次挨着的
// `connect()` 都能穿过守卫,各建一条 socket。适配器装好后 `setFrameHandlers()` 与紧接着的
// `sessionHistory()`(它会 `ensureStreams()`)本就挨着,日志里表现为「连接…」打两遍。
//
// 为什么用真 socket 而不是桩:这一条的正确性**只体现在「服务端看到几条连接」**上,
// 桩掉 WebSocket 就变成了「我数了数自己调了几次构造函数」—— 那测不出守卫的位置对不对。
// 服务端监听 127.0.0.1:0(内核分配端口),不碰任何固定端口,也不碰真 dsh。
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
const { buildSync } = require(path.join(repo, "node_modules", "esbuild"));

function bundle(entry, name) {
  const out = path.join(os.tmpdir(), `${name}-${process.pid}.cjs`);
  buildSync({ entryPoints: [path.join(repo, entry)], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" });
  return require(out);
}

const muxMod = bundle("src/dsh/protocol/mux.ts", "mux-test");
const { WebSocketServer } = require(path.join(repo, "node_modules", "ws"));

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "OK  " : "FAIL") + " " + name + (ok || !detail ? "" : "  → " + detail));
  if (!ok) fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个只数连接与 open 帧的 ws 服务端,返回 { url, count, opens, dropAll, close }。 */
async function listen() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = [];
  const opens = [];
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (raw) => {
      // open 帧要回一条 item 才谈得上「流开起来了」;这里只做最小应答。
      const frame = JSON.parse(String(raw));
      if (frame.type === "open") {
        opens.push(frame.streamId);
        ws.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { ok: true } }));
      }
    });
    ws.on("error", () => {});
  });
  await new Promise((r) => wss.once("listening", r));
  const { port } = wss.address();
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => sockets.length,
    opens: () => opens.slice(),
    dropAll: () => { for (const s of sockets) s.terminate(); },
    close: () => new Promise((r) => { for (const s of sockets) s.terminate(); wss.close(() => r()); }),
  };
}

/** 鉴权解析**故意慢**,把 await 的窗口撑开到肉眼可见 —— 缺陷就在那个窗口里。 */
function slowAuth(store, delayMs = 60) {
  return async () => {
    store.calls += 1;
    await sleep(delayMs);
    return { authority: "127.0.0.1", cookie: "dsh-auth-x=y", via: "secret" };
  };
}

async function main() {
  // ---------- 1. 并发 connect():只许建一条 ----------
  {
    const server = await listen();
    const store = { calls: 0 };
    const mux = new muxMod.RemoteMux({ baseUrl: server.url, auth: slowAuth(store), onLog: () => {} });
    mux.connect();
    mux.connect(); // 紧接着再来一次(窗口就在这个 await 里)
    mux.connect();
    await sleep(400);
    check("并发 connect() 只解析一次凭据", store.calls === 1, `auth 调了 ${store.calls} 次`);
    check("并发 connect() 只建一条 socket", server.count() === 1, `服务端收到 ${server.count()} 条连接`);
    check("状态是 connected", mux.currentState === "connected", mux.currentState);

    // 连上之后再 connect() 仍是无操作
    mux.connect();
    await sleep(200);
    check("连上之后 connect() 无操作", server.count() === 1 && store.calls === 1, `连接 ${server.count()} 条 / auth ${store.calls} 次`);

    mux.dispose();
    check("dispose 后状态回到 disconnected", mux.currentState === "disconnected", mux.currentState);
    mux.connect();
    await sleep(200);
    check("dispose 后 connect() 无操作", server.count() === 1 && store.calls === 1, `连接 ${server.count()} 条 / auth ${store.calls} 次`);
    await server.close();
  }

  // ---------- 2. 逻辑流:开流、收 item、断线后重连并把流原样重开 ----------
  {
    const server = await listen();
    const store = { calls: 0 };
    const mux = new muxMod.RemoteMux({ baseUrl: server.url, auth: slowAuth(store, 0), onLog: () => {} });
    const items = [];
    const ends = [];
    mux.connect();
    await sleep(150);
    const stream = mux.open("session/follow", { address: { kind: "session", sessionId: "s1" } }, {
      onItem: (v) => items.push(v),
      onEnd: () => ends.push("end"),
      onError: () => {},
    });
    await sleep(200);
    check("open() 之后收到 item", items.length === 1, `${items.length} 条`);
    check("open() 返回的 streamId 非空", typeof stream.streamId === "string" && stream.streamId.length > 0);
    check("open 帧被服务端收到一次", server.opens().length === 1, `${server.opens().length} 次`);

    // 协议里没有 resume/游标,所以重连后唯一的正确做法是**把已登记的流原样重开**,
    // 由服务端重发一份完整开局帧,重叠部分交给上层按 seq 去重。
    server.dropAll();
    await sleep(1600); // 退避基准 500ms,留足重连 + 重开的时间
    check("掐断后自动重连", server.count() >= 2, `${server.count()} 条连接`);
    check("重连后把已登记的流重开(同一个 streamId)", server.opens().length === 2 && server.opens()[1] === server.opens()[0], server.opens().join(","));
    check("重连后 item 继续送到原来的回调", items.length >= 2, `${items.length} 条`);

    // 并发 connect 在**已连**状态下也不该多开
    mux.connect();
    mux.connect();
    await sleep(200);
    check("已连状态下并发 connect() 仍只有一条", server.count() === 2, `${server.count()} 条连接`);

    mux.dispose();
    mux.connect();
    await sleep(300);
    check("dispose 后 connect() 无操作", server.count() === 2, `${server.count()} 条连接`);
    await server.close();
  }

  console.log(`\n${fail === 0 ? "全部通过" : `失败 ${fail} 项`}`);
  process.exitCode = fail === 0 ? 0 : 1;
  // ws 服务端与定时器都收干净了,给 libuv 一点时间再退(否则 Windows 上会断言失败)
  await sleep(200);
}

main().catch((error) => {
  console.error("测试崩溃:", error);
  process.exitCode = 1;
});
