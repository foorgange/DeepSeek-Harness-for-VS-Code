/**
 * 每个会话一条 `session/follow` —— 0.1.5 的**历史与实时事件的唯一来源**。
 *
 * 为什么必须常驻:0.1.1 有一条全局的 `events.mux` socket,服务端把**所有**会话的
 * `session/event` 推给每个客户端(hub.ts 的注释里专门记过这个副作用:mux 全局流会把
 * Web 端会话的实时事件也写进 store)。0.1.5 没有等价物 —— 那条 socket 不存在了,
 * 每个会话要自己 `session/follow` 才拿得到它的增量。所以:
 *
 *   · **首屏历史** = 开流时那条 snapshot(`{cursor, records, hasMore, projections}`);
 *   · **实时增量** = 同一条流后续的 `event` 项;
 *   · **向后翻页** = `session/page`,而它要的 `throughSeq` 就是 snapshot 的 `cursor`。
 *
 * 三件事都由同一条流决定,所以它们必须在一个文件里 —— `cursor` 是它们的共同状态。
 *
 * ## 三个反直觉点(错了只表现为「界面少东西」或「点加载更早没反应」)
 *
 * 1. **`throughSeq` 不能用 `-1` 顶替,但空会话的 `cursor` 本来就是 `-1`。**
 *    `paginate` 里 `end = min(throughSeq + 1, beforeSeq)`(dsh-api-session-controller/
 *    lib/index.js:1602)—— 传 `-1` 就恒等于 `min(0, …) = 0` ⇒ **永远空页、且
 *    `hasMore:false`**,表现是「打开老会话一片空白,还不报错」。所以必须用开局帧
 *    给的那个游标,它可能是 `-1`(空会话),那时空页恰好是对的。
 *
 * 2. **`beforeSeq` 只接受非负安全整数。** 校验器逐字是
 *    `if (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))
 *    throw "gateway/bad-request"`(同上 :1567)。而 modern 的 seq **可能是小数**
 *    (流式增量是铸造的,见 assistant.ts)—— 于是 `sessionStore.historyBeforeSeq()`
 *    必须取整。那是**另一处**改动,但它和这条是同一个因果链,改一处忘一处就复现不了。
 *
 * 3. **快照里的持久事件要照常派发成 `session/event` 帧。**
 *    看着像多余(历史本来就走 `mergeHistory`),但**重连**时它就是唯一能补回断线期间
 *    那些事件的东西:重连后服务端重发一份新快照,而 `hub.ensureHistory` 的
 *    `historyLoaded` 守卫让合并**只跑一次**,不会再来一遍。store 的 `addEvent` 按 seq
 *    去重,所以重复派发是无害的(且去重发生在任何副作用之前)。
 *
 * 转义:`projections` 要回放进 store,否则打开会话后权限胶囊/上下文压力/待办会停在上个
 * 会话的值上。这里按 `{asOfSeq, values}` 展开成 `session/projection` 帧,规则与
 * frames.ts 的 `projectControl` 基线扇出**逐条一致**(同一个 `asOfSeq` 当 seq、
 * 每个键一发),只是拿不到那个函数 —— 它吃的是 control item 的形状。
 */

import type { FrameEnvelope } from "../legacy";
import type { MuxStream, MuxStreamHandlers } from "../mux";
import type { RemoteMux } from "../mux";
import type { HostFrame, MuxFrame, SessionEvent } from "../../types";
import type { SessionAddress } from "./args";
import type { AssistantStreams } from "./assistant";

const MAX_REOPEN_MS = 30_000;
const BASE_REOPEN_MS = 1_000;
/** 等开流快照的默认上限。服务端重启期间会连着失败,给足重试时间。 */
const READY_TIMEOUT_MS = 15_000;

export interface FollowSink {
  onMux(env: FrameEnvelope<MuxFrame>): void;
  onHost(env: FrameEnvelope<HostFrame>): void;
  newRpcId(): string;
  onLog?(message: string): void;
}

/** `session/follow` 一条 item 的 value。 */
export type FollowItem =
  | {
      type: "snapshot";
      cursor?: unknown;
      records?: unknown;
      hasMore?: unknown;
      projections?: unknown;
      assistantStream?: unknown;
    }
  | { type: "event"; event: unknown }
  | { type: "assistant-stream"; frame: unknown };

/**
 * `session/follow` / `session/page` 的地址。子会话靠 `kind:"subagent"` 寻址。
 *
 * 直接复用 `args.ts` 的那份 —— 再定义一遍就会有两个会各自漂移的同形类型,
 * 而它们的差别要到线上被服务端拒掉才暴露。
 */
export type FollowAddress = SessionAddress;

export interface HistoryPage {
  events: { event: SessionEvent }[];
  hasMore: boolean;
}

/** `session/page` 的入参(`SessionPageRequest`,wire 名是 `request`)。 */
export interface PageRequest {
  address: FollowAddress;
  throughSeq: number;
  beforeSeq?: number;
  maxMessages?: number;
}

/** 一次 `follow()` 的结果:开局帧的游标、还有没有更早的、以及这一页事件。 */
export interface FollowResult extends HistoryPage {
  /** `session/page` 的 `throughSeq`。**可能是 -1**(空会话),那是合法且正确的值。 */
  cursor: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * 一条 `records` 项 → 插件的 `SessionEvent`。
 *
 * 0.1.5 的 `SessionWireEvent` 与插件的 `SessionEvent` **逐字段同形**
 * (`{type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp?}`),所以这里
 * 只做**守卫**不做翻译:缺 `seq`/`time` 的项会让 store 的 `Map<seq, …>` 收到
 * `undefined` 键,那是比丢一条事件难查得多的故障。
 */
function toRecord(value: unknown): { event: SessionEvent } | undefined {
  const rec = asRecord(value);
  if (rec === undefined) return undefined;
  const event = asRecord(rec["event"]);
  if (event === undefined) return undefined;
  const type = event["type"];
  const seq = event["seq"];
  if (typeof type !== "string" || typeof seq !== "number" || !Number.isFinite(seq)) return undefined;
  return { event: event as unknown as SessionEvent };
}

interface Entry {
  readonly address: FollowAddress;
  readonly key: string;
  stream: MuxStream | undefined;
  reopener: Reopener;
  /** 开局帧给的持久游标 —— `session/page` 的 `throughSeq`。**可能是 `-1`**(空会话)。 */
  cursor: number;
  /** 开局帧的 `hasMore`。已知为 false 时不必再往服务端问一次(也顺带避开 -1 的坑)。 */
  hasMore: boolean;
  /** 已经拿到过开局帧(用来让 `whenReady` 立刻返回)。 */
  opened: boolean;
  /** 上一次开局帧的事件(每次重连都被新快照整体替换)。 */
  snapshotEvents: { event: SessionEvent }[];
  readonly waiters: Set<(value: void) => void>;
  disposed: boolean;
  /** 这是个一次性读取(子会话预览),拿到快照就关流。 */
  readonly oneShot: boolean;
}

/** 重开退避。与 streams.ts 那份同构 —— 抄一遍胜过把两个文件的骨架拧在一起。 */
class Reopener {
  private timer: NodeJS.Timeout | undefined;
  private delay = BASE_REOPEN_MS;
  private stopped = false;

  constructor(
    private readonly reopen: () => void,
    private readonly log: (message: string) => void,
  ) {}

  reset() {
    this.delay = BASE_REOPEN_MS;
  }

  schedule() {
    if (this.stopped || this.timer !== undefined) return;
    const delay = this.delay;
    this.delay = Math.min(delay * 2, MAX_REOPEN_MS);
    this.log(`流已断开,${delay}ms 后重开`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reopen();
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * 会话跟随流的管理者。
 *
 * **流不会被主动关闭**(除 `dispose`)。这不是疏忽:插件没有「关掉这个会话」的动作,
 * 而一旦关流,那个会话的实时增量就永久停了 —— 用户切走再切回来时 `ensureHistory`
 * 因为 `historyLoaded` 守卫不会重跑,`sessionHistory` 也不会被再调一次,于是会表现成
 * 「再打开时新消息不出现」,复现步骤还要求先切走再切回。宁可留着:一条空闲的
 * `session/follow` 不产生任何流量,而用户在一次 VS Code 会话里真正打开的会话是个位数。
 */
export class SessionFollows {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly mux: RemoteMux,
    private readonly sink: FollowSink,
    private readonly assistant: AssistantStreams,
    /** `session/page` 的一元调用(HTTP)。由适配器注入 —— 它才知道鉴权与 baseUrl。 */
    private readonly callPage: (request: PageRequest) => Promise<{ records?: unknown; hasMore?: unknown }>,
  ) {}

  private keyOf(address: FollowAddress): string {
    return address.kind === "session"
      ? `session:${address.sessionId}`
      : `subagent:${address.parentSessionId}:${address.childSessionId}:${address.mode}`;
  }

  private log(message: string) {
    this.sink.onLog?.(`[follow] ${message}`);
  }

  /** 已经开着的跟随流(调试/探针用)。 */
  get followedSessionIds(): string[] {
    return [...this.entries.values()].filter((e) => !e.oneShot).map((e) => e.key);
  }

  /**
   * 确保有一条到 `address` 的跟随流,并等它的**开局帧**。
   *
   * 幂等:已经开过就直接返回(不重开、不重发快照 —— 重开会让服务端再发一份完整快照,
   * 而调用方可能只是要翻页)。
   */
  async follow(address: FollowAddress, oneShot = false): Promise<FollowResult> {
    const key = this.keyOf(address);
    let entry = this.entries.get(key);
    if (entry === undefined || entry.disposed) {
      entry = {
        address,
        key,
        stream: undefined,
        cursor: -1,
        hasMore: false,
        opened: false,
        snapshotEvents: [],
        waiters: new Set(),
        disposed: false,
        oneShot,
        reopener: undefined as unknown as Reopener,
      };
      entry.reopener = new Reopener(() => this.open(entry!), (m) => this.log(`${key} ${m}`));
      this.entries.set(key, entry);
      this.open(entry);
    }
    await this.whenReady(entry);
    return { cursor: entry.cursor, hasMore: entry.hasMore, events: entry.snapshotEvents };
  }

  private open(entry: Entry): void {
    if (entry.disposed || entry.stream !== undefined) return;
    const handlers: MuxStreamHandlers<FollowItem> = {
      onItem: (item) => this.onItem(entry, item),
      onEnd: () => {
        entry.stream = undefined;
        if (entry.disposed || entry.oneShot) return;
        entry.reopener.schedule();
      },
      onError: (error) => {
        entry.stream = undefined;
        if (entry.disposed) return;
        this.log(`${entry.key} 流错误 ${error.code}: ${error.message}`);
        // 一次性读取(子会话预览)没有重开的必要,由调用方自己决定重试。
        if (!entry.oneShot) entry.reopener.schedule();
      },
    };
    entry.stream = this.mux.open<FollowItem>("session/follow", { request: { address: entry.address, assistantStream: true } }, handlers);
  }

  private onItem(entry: Entry, item: FollowItem): void {
    if (item === null || typeof item !== "object") return;
    if (item.type === "snapshot") {
      this.onSnapshot(entry, item);
      return;
    }
    if (item.type === "event") {
      const record = toRecord(item);
      if (record === undefined) return;
      // 持久事件是小数 seq 的基准,必须先于派发更新(见 assistant.ts 的 noteDurable)。
      this.assistant.noteDurable(sessionIdOf(entry.address), record.event.seq);
      this.sink.onMux({
        rpcId: this.sink.newRpcId(),
        frame: { type: "session/event", sessionId: sessionIdOf(entry.address), event: record.event },
      });
      return;
    }
    if (item.type === "assistant-stream") {
      this.assistant.accept(sessionIdOf(entry.address), item.frame);
    }
  }

  private onSnapshot(entry: Entry, item: { cursor?: unknown; records?: unknown; hasMore?: unknown; projections?: unknown; assistantStream?: unknown }): void {
    entry.reopener.reset();
    const sessionId = sessionIdOf(entry.address);
    const cursor = asInt(item.cursor);
    // 游标缺失就保持上一次的值:宁可用旧游标翻页(最坏是多取一页),也不能用 undefined
    // 去发请求 —— 那会被 `validatePageRequest` 拒掉,而错误信息只说「必须是整数」。
    if (cursor !== undefined) entry.cursor = cursor;
    entry.hasMore = item.hasMore === true;
    entry.opened = true;

    // assistantStream 的基线要在事件之前喂 —— 它带着「开流时正跑着的那次尝试」的
    // turn/step,后面那些 chunk 帧自己不带。
    if (entry.address.kind === "session") this.assistant.baseline(sessionId, item.assistantStream);

    // 订阅点:让 store 的 maxSeq 追上真实尾巴(legacy 的 session/subscribed 就是这个语义)。
    this.sink.onMux({
      rpcId: this.sink.newRpcId(),
      frame: { type: "session/subscribed", sessionId, lastSeq: cursor ?? -1 },
    });

    // 投影回放。复用 projectControl 的**扇出路径**不现实(它吃的是 control item),
    // 但形状是同一个 {asOfSeq, values},所以这里按同一规则展开成 session/projection 帧。
    const projections = asRecord(item.projections);
    const asOfSeq = asInt(projections?.["asOfSeq"]) ?? cursor ?? 0;
    for (const [key, value] of Object.entries(asRecord(projections?.["values"]) ?? {})) {
      this.sink.onMux({
        rpcId: this.sink.newRpcId(),
        frame: { type: "session/projection", sessionId, key, value, seq: asOfSeq },
      });
    }

    // 快照的历史事件照常派发 —— 重连时这是补回断线期间增量的唯一途径(见文件头第 3 点)。
    const page: { event: SessionEvent }[] = [];
    if (Array.isArray(item.records)) {
      for (const raw of item.records) {
        const record = toRecord(raw);
        if (record === undefined) continue;
        page.push(record);
        entry.cursor = Math.max(entry.cursor, record.event.seq);
        this.assistant.noteDurable(sessionId, record.event.seq);
        this.sink.onMux({
          rpcId: this.sink.newRpcId(),
          frame: { type: "session/event", sessionId, event: record.event },
        });
      }
    }
    // 缓存给 `sessionHistory()` 回给 hub(`mergeHistory` 那条路径)。整体替换而不是追加:
    // 重连后这是一份新窗口,追加会让旧窗口里已经被服务端裁掉的事件永远留着。
    entry.snapshotEvents = page;

    for (const resolve of entry.waiters) resolve();
    entry.waiters.clear();
    if (entry.oneShot) this.close(entry);
  }

  private whenReady(entry: Entry, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (entry.opened) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        entry.waiters.delete(onReady);
        reject(new Error(`session/follow 未在超时前给出开局帧(${entry.key})`));
      }, timeoutMs);
      entry.waiters.add(onReady);
    });
  }

  /**
   * 一次 `session/page`。
   *
   * 走注入进来的 unary(它才是 HTTP),不碰 mux —— `session/page` 是**一元调用**,
   * 不是流(`typert.remote-client.d.ts:25` 签的是 `Promise<RemoteResult<SessionPage>>`)。
   * 独立于常驻流也意味着任何地址都能翻页,包括子会话。
   *
   * 回的是**正经信封** `{records, hasMore}`:经 `post()` 拆掉了 `result.value` 外层。
   *
   * `throughSeq` 用开局帧的游标(**可能是 -1**,空会话时那正好是对的)。
   * `beforeSeq` 是排他上界,由调用方给出(必须是整数,见 sessionStore.historyBeforeSeq)。
   */
  async readPage(
    address: FollowAddress,
    throughSeq: number,
    beforeSeq: number | undefined,
    maxMessages: number | undefined,
  ): Promise<HistoryPage> {
    // `maxMessages` 缺省就不发这个键 —— 服务端自己的 `?? DEFAULT_MAX_MESSAGES` 会兜底,
    // 而显式传 `undefined` 虽然也能过校验(`!== void 0` 那一支),但那是**巧合**:
    // 校验器挡的是「不是正整数」,`undefined` 恰好走的是「没传」那一支。
    const page = await this.callPage({
      address,
      throughSeq,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      ...(maxMessages === undefined ? {} : { maxMessages }),
    });
    const records = Array.isArray(page?.records) ? page.records : [];
    const events: { event: SessionEvent }[] = [];
    for (const raw of records) {
      const record = toRecord(raw);
      if (record !== undefined) events.push(record);
    }
    return { events, hasMore: page?.hasMore === true };
  }

  /** 关掉某条跟随流(子会话预览这类一次性读取用)。 */
  close(entry: Entry): void {
    entry.disposed = true;
    entry.reopener.stop();
    entry.stream?.cancel();
    entry.stream = undefined;
    for (const resolve of entry.waiters) resolve();
    entry.waiters.clear();
    this.entries.delete(entry.key);
  }

  /**
   * 一次性读取某个地址的**最后一页**历史,读完即关流。
   *
   * 子会话预览用它:legacy 的 `subagent.history` 是个 unary,拿一次就完;这里用
   * `session/follow` 的开局快照实现同样语义(0.1.5 没有 subagent/history)。
   * **不派发任何帧** —— 子会话的事件不该进主 store(legacy 也不进)。
   */
  async snapshotOnce(address: FollowAddress, maxMessages?: number): Promise<HistoryPage> {
    const key = this.keyOf(address);
    const item = await new Promise<unknown>((resolve, reject) => {
      let stream: MuxStream | undefined;
      const timer = setTimeout(() => {
        stream?.cancel();
        reject(new Error(`session/follow 未在超时前给出开局帧(${key})`));
      }, READY_TIMEOUT_MS);
      stream = this.mux.open<FollowItem>(
        "session/follow",
        { request: { address, ...(maxMessages === undefined ? {} : { maxMessages }) } },
        {
          onItem: (value) => {
            if (value?.type !== "snapshot") return;
            clearTimeout(timer);
            stream?.cancel();
            resolve(value);
          },
          onEnd: () => {
            clearTimeout(timer);
            reject(new Error(`session/follow 在没有开局帧的情况下结束(${key})`));
          },
          onError: (error) => {
            clearTimeout(timer);
            reject(new Error(`${error.code}: ${error.message}`));
          },
        },
      );
    });
    const rec = asRecord(item);
    const records = Array.isArray(rec?.["records"]) ? rec["records"] : [];
    const events: { event: SessionEvent }[] = [];
    for (const raw of records) {
      const record = toRecord(raw);
      if (record !== undefined) events.push(record);
    }
    return { events, hasMore: rec?.["hasMore"] === true };
  }

  /** 拿某条已开跟随流的游标(没有就返回 undefined)。 */
  cursorOf(sessionId: string): number | undefined {
    return this.entries.get(`session:${sessionId}`)?.cursor;
  }

  stop(): void {
    for (const entry of [...this.entries.values()]) this.close(entry);
    this.entries.clear();
  }
}

/** 地址 → 事件该记在哪个会话上。子会话的事件仍然归属**子**会话 id。 */
function sessionIdOf(address: FollowAddress): string {
  return address.kind === "session" ? address.sessionId : address.childSessionId;
}
