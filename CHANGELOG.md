# Changelog / 更新日志

本文件从 0.12.5 开始记录。This file starts at 0.12.5.

---

## 0.12.5

**支持 dsh 0.1.5,同时保留对 0.1.1 的支持。**
**Works with dsh 0.1.5 while keeping support for 0.1.1.**

dsh 0.1.5 对第三方客户端做了协议级重写:所有 `/api` 路由(含 WebSocket 升级)强制
浏览器会话 Cookie、逐方法 `POST` + 双 WebSocket 换成单条 `remote.mux` 复用流、斜杠寻址、
方法表重排。0.12.4 的面板在它上面完全打不开。这一版把传输层换成**双协议适配器** ——
同一个 vsix,新旧两代 dsh 都能用。

### 新增 / Added

- **双协议自动探测**。扩展先解析鉴权、再实测服务端,自动选用真正有应答的那一代协议;
  拿不准时回落到 0.1.1 的既有行为(等于什么都没变),而不会切到一个对面不存在的传输上。
  可用 `dsh.protocol` 强制指定:`auto`(默认)/ `legacy` / `modern`。
  *Automatic protocol detection — `dsh.protocol`: `auto` / `legacy` / `modern`.*
- **`dsh.deriveAuthFromCredentials`**(默认开)。当 dsh 服务端**不是**由 VS Code 启动时
  (例如你在终端里敲 `dsh web`),0.1.5 的请求门禁只能靠本地凭据派生 Cookie 通过。
  扩展只读取 `<DSH_HOME>/.credentials.yaml` 里 `client-connection/browser-session`
  这一条记录的密钥,用于给**本机回环地址**签一个 Cookie;**除了发给同一个本地服务端,
  不发送到任何其它地方**。可在设置里关闭。
  *Opt-out-able local cookie derivation for an externally started 0.1.5 server.*
- **`dsh.authToken`**:手动指定完整的浏览器会话 Cookie,覆盖其它鉴权方式。仅供排障。
- **服务端日志**。扩展拉起的 dsh 进程,stdout/stderr 现在写入
  `<扩展日志目录>/dsh-server.log`(0.1.5 的启动令牌也正是从 stdout 抓的)。
  在此之前这些输出是被直接丢弃的,服务端起不来时没有任何线索。

### 修复 / Fixed

- **新建会话在 0.1.5 上收不到回复。** 0.1.5 没有全局事件流:一个会话的实时事件只走
  `session/follow`,而开启那条流的正是 `sessionHistory()`。新建会话漏了这一步,表现为
  「消息发出去了,界面一直转圈」,而服务端其实早就答完了。现在新建会话同样会建立跟随流。
  *New sessions now subscribe before prompting — without this, replies never arrived on 0.1.5.*
- **可能同时连上两条 `remote.mux`。** `RemoteMux.connect()` 文档写着幂等,但守卫只看了
  `socket !== undefined`,而 `socket` 要等 `await auth()` 之后才赋值 —— 两次挨着的
  `connect()` 都能穿过守卫各建一条 socket。后果是每帧收到两份、连接数翻倍。
  *`connect()` was not concurrency-safe across the `await auth()` window.*
- **误判「服务端已死」而拉起第二个 dsh 进程。** 0.1.5 的根路径未认证返回 401,旧判据
  只看 200,于是把「正在运行」当成「没运行」,再 spawn 一个去抢同一个端口。
  现在 200 / 303 / 401 / 403 都算「在跑」。
- **回退检查点整块失效。** 0.1.5 的 `commands/execute` 要求显式传 `submittedAttachments`,
  缺参会 `gateway/arguments-invalid`;而扩展在**激活时**就会调 `/checkpoints`。
- **会话列表的 Agent 预设标签。** 0.1.5 把 `SessionSummary.agentPreset` 挪进了会话投影,
  `session/list` 顶层不再有。适配器从控制流的投影基线里补回来,侧边栏标签不会整列消失。
- **模型选择器 / 思考深度菜单**在 0.1.5 上重新有数据。0.1.5 拆掉了 `session.models`,
  改为「全局目录 + 会话投影」两半,扩展按
  `当前选择 = 投影.next ?? 投影.lastUsed ?? 目录默认` 合成。

### 兼容性 / Compatibility

| | dsh 0.1.1 | dsh 0.1.5 |
|---|---|---|
| 自动探测 | ✅ | ✅ |
| 服务端由扩展启动 | ✅ | ✅ |
| 服务端由终端启动(`dsh web`) | ✅ | ✅ 需要能读 `<DSH_HOME>/.credentials.yaml`(默认允许) |

### 自动化覆盖到什么程度 / What the automated tests actually cover

`npm test` 有 12 个套件(会话存储 / 界面渲染 / 打包产物 / 插件注册表 / 回退插件升级迁移 /
设置面板 / 协议层的参数表、鉴权、mux 传输、帧合成、历史、模型合成),全部离线跑,不碰真机。
此外 `tools/` 下的探针会打**真实的 dsh**:

| | dsh 0.1.5 | dsh 0.1.1 |
|---|---|---|
| 离线套件 | ✅ | ✅(legacy 分支同样是这些套件的覆盖对象) |
| 真机探针 `tools/probe-hub-protocol.ts` | ✅ 31 项全过 | — |
| 真机端到端 `tools/test-client.ts` | ✅ 12 项断言 | ✅ 10 项断言 |

两条腿跑的是**同一份业务代码**(`src/dsh/protocol/` 下的适配器)、**同一个脚本**、
**同一组断言**,只有协议是变量 —— 这正是这层适配器存在的理由。0.1.1 那条腿是在一台
真机上跑的:`dsh 0.1.1-rc.1`,独立端口 3098,`DSH_HOME` 指向临时目录(凭证临时复制进去,
跑完整个目录删掉,不碰真实会话)。它跑通了一个真实的 LLM 回合并收到 `turn/end`。

补充证据:`src/dsh/protocol/legacy/index.ts` 与 0.12.4 出货的 `src/dsh/apiClient.ts`
**逐字节相同**,只改了 import 路径一行(`git diff --no-index` 可自行核对)。也就是说
0.1.1 那条路走的就是老用户已经在用的那份代码,不是新写的分支。

> **复现提示**:为 0.1.1 装一个独立环境时**用 pnpm,别用 npm**。
> `npm install @deepseek-ai/dsh@0.1.1-rc.1` 在实测中跑了 40 分钟仍不出结果(内存涨到 2.5 GB),
> 期间还会因缓存里过期的 packument 报 `ETARGET ... dsh-tool-subagent-report@^0.1.1-rc.2`
> ——那是 `--prefer-offline` 用了旧缓存,不是上游真缺这个版本(官方源与 npmmirror 都有)。
> 换成 `pnpm install` 同一个依赖图 **59 秒**装完。

### 升级后建议手动过一遍 / Manual check worth doing after upgrading

自动化测不到的,基本都在「GUI 真的连上并画出来」和「断线自愈」这两类。按你实际用的
dsh 版本挑一列走:

| | 服务端由扩展启动 | 服务端由终端启动(`dsh web`) |
|---|---|---|
| dsh 0.1.5 | ⬜ | ⬜ |
| dsh 0.1.1 | ⬜ | ⬜ |

每格走一遍:激活扩展 → 侧边栏列出会话 → 打开一个旧会话看到完整历史 →
发消息收到回复 → 批准一次工具 → 拒绝一次工具 → 回答一次提问 →
换模型 / 换思考深度 / 换权限 → 新建、改名、归档会话 →
**回合进行中杀掉服务端再重启,看面板能否自愈且不重复弹审批卡**。

「服务端由终端启动」那一列专门压凭据派生路径(`dsh.deriveAuthFromCredentials`)——
若它被关掉,0.1.5 上会表现为一律 401。

---

## 0.12.4 及更早 / 0.12.4 and earlier

未在此文件记录。Unrecorded.
