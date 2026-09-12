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
- **握手被拒后整条连接永久卡死。** WebSocket 库的实现是
  「有监听器就不 abort 握手」,于是被 401 拒绝时**既不触发 `error` 也不触发 `close`**:
  连接永远停在「正在连接」,重连逻辑因为「已经有一条连接了」而再也不启动。0.1.5 的门禁
  对未认证握手正是回 401,所以任何一次凭据失效都会静默切断审批、提问、队列、工作区、
  会话跟随流 —— 表现是**消息发出去一直转圈、审批卡永不弹**,而服务端其实早已答完。
  现在自行收尾并继续重试。
  *A rejected WebSocket handshake (401/403) used to wedge the whole connection forever.*
- **鉴权凭据只解析一次就冻住。** Cookie 是有寿命的(令牌兑换来的由服务端定,自签的约
  24 小时),而旧的实现把解析结果封成一个常量交给连接层。于是「凭据文件后到」「自签窗口
  过期」「被拒后重新兑换令牌」三件事一件都自愈不了,只能重载窗口。现在按需重解析。
  *Credentials are now re-resolved instead of being frozen at startup.*
- **服务端先开端口、后打印令牌。** `dsh web` 是 listen 之后、等整棵插件树加载完才打印那行
  带 token 的 URL,所以抓令牌常常扑空。现在在**消费端**做有界等待,而不是在启动流程里等
  —— 后者会把「刚拉起的服务端是否活着」这个判断一起推迟,把「启动即崩」也报成启动成功。
  该等待只在其它鉴权路径全部落空时才发生,0.1.1 用户不受任何影响。
- **归档过滤时灵时不灵。** 会话列表接口这次没带归档字段时被当成「归档集是空的」,于是
  侧边栏刚减掉的归档会话又被下一次刷新整体放了回来。

### 来自社区 / From the community

感谢 **Zi-Yi-Ming** 提的三个 PR,全部经**复现确认**后合入(不是照单收下 —— 每个都先
在本地把它的测试跑一遍,确认失败、确认修的是真问题):

- **服务端一死就再也拉不起来**(PR #3)。启动成功后没有复位内部状态,导致此后每次尝试
  都被误判成「已经在启动了」,只能一直等到超时、重载窗口才能恢复。同一 PR 还补上了
  子进程回调的闭包守卫(迟到的旧回调不再改写新一次启动的状态)。
  *复现:PR 自带测试对本仓库代码跑出 7 项失败。*
- **回退会删掉其它会话的检查点记录**(PR #4)。快照**故意不收录**记录目录本身,而回退
  在某个分支上会执行一次彻底清理 —— 于是回退 A 会话的一个回合,B 会话的历史检查点
  一起消失,且不可恢复。这一条是真数据丢失。
  *复现:撤掉修复后 `AssertionError: sessionB.json preserved`。*
- **冒烟测试写死了本机绝对路径**(PR #2)。`npm test` 在任何其它机器上都会
  `MODULE_NOT_FOUND`。除了 PR 覆盖的 2 个文件,本仓库另有 6 个套件有同样毛病,一并修了。

### 兼容性 / Compatibility

| | dsh 0.1.1 | dsh 0.1.5 |
|---|---|---|
| 自动探测 | ✅ | ✅ |
| 服务端由扩展启动 | ✅ | ✅ |
| 服务端由终端启动(`dsh web`) | ✅ | ✅ 需要能读 `<DSH_HOME>/.credentials.yaml`(默认允许) |

### 自动化覆盖到什么程度 / What the automated tests actually cover

`npm test` 有 13 个套件(会话存储 / 界面渲染 / 打包产物 / 插件注册表 / 回退插件升级迁移 /
设置面板 / 服务端管理 / 协议层的参数表、鉴权、mux 传输、帧合成、历史、模型合成),
外加回退插件自己的 1 个套件(`resources/dsh-git-rollback`,由 `npm test` 一并跑)。
全部离线跑,不碰真机。此外 `tools/` 下的探针会打**真实的 dsh**:

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

> **夹具没有随仓库提交**:`protocol-frames` / `protocol-history` 两个套件里那些**驱动真实
> 录制帧**的用例,数据是从真机 dump 出来的,含真实会话内容,所以只提交生成器
> `tools/record-mux.ts`。没有夹具时这些用例会跳过,并在收尾行明确打印「(跳过 N 项)」,
> 不会假装通过 —— 两个套件里不依赖夹具的那部分用例照常跑。想让它们真正跑起来,
> 对着一个真机执行 `node tools/record-mux.ts` 即可。

### 已知遗留 / Known gaps

- **`dispose()` 之后仍可能被重新拉活一次。** `hub.client` 是个非可选的 getter,
  在适配器已销毁的情况下被读到时,它会再建一个 legacy 客户端 —— 那个客户端从此无人
  `dispose`。触发条件是「窗口正在关闭、同时还有代码在取 client」,而进程随即就退出了,
  所以既没观察到实际后果,也没有一个不把 `get client()` 改成可选就能干净的修法。
  记录在此而非强行改签名。
  *A disposed adapter can be resurrected once via `hub.client`; harmless in practice, awkward to fix.*
- **`tools/sync-upstream.ps1` 里写死了本机路径**(第 13 行)。这是本地开发脚本,
  不进 vsix,也不参与 `npm test`,所以没有跟着一起改成相对路径 —— 换机器用的人需要自己改一行。

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
