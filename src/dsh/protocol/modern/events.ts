/**
 * `$events` 逻辑流:审批 / 提问的 waterfall 往返 + `api-session/*` 生命周期广播。
 *
 * 这条流是 0.1.5 里**唯一**的「有人要你回答什么」的来源,也是审批卡能弹出来的前提。
 * 它的两条硬约束都不在文档里,只能从网关源码读出来(dsh-api-gateway/lib/index.js):
 *
 *  1. **每代一个新 clientId**。`openRemoteEvents` 每次开流都 `randomUUID()` 造 clientId,
 *     并且把**所有未结算的 pending waterfall 重新投递一遍**(`:598`)—— 用的是**同一个
 *     eventId**(`pending.id` 只在 `startRemoteEvent` 里铸造一次)。所以重连后:
 *       · 同一张审批卡会被再投一次 ⇒ **必须按 eventId 去重**,否则用户看到两张卡片,
 *         点哪张都是「另一个已不存在」;
 *       · 回答时必须用**当前代**的 clientId(`$events/result` 先按 clientId 找 client,
 *         再按 eventId 找 pending)—— 缓存上一代的会被 `gateway/...` 拒掉。
 *
 *  2. **`cancel` 是结算通知,不是取消操作,而且回答者自己收不到它**。
 *     `finishRemoteEvent` 对每个曾经投递过的 client 都推一条 `{type:"cancel", eventId}`,
 *     但 `receiveRemoteEventResult` **在结算之前**就把回答者从投递集合里摘掉了
 *     (`:685` 的 `removeRemoteEventDelivery`)。所以:
 *       · 我答的 → 我收不到 cancel ⇒ **必须自己结算**(凭 `$events/result` 的 ok);
 *       · 别处答的 / 上下文被释放 → 我会收到 cancel ⇒ 那时才用它撤卡。
 *     只等 cancel 的写法会让「用户点完按钮卡片不消失」—— 真机上已复现过。
 *
 * `cancel` 不带 outcome,而走到 cancel 分支就说明我还没结算过,所以一律报 `cancelled`
 * (fail-closed):宁可显示「已取消」,也不能把一个我没参与过的结算说成我的答案。
 */

import type { FrameEnvelope } from "../legacy";
import type { MuxStream } from "../mux";
import { EVENTS_ENDPOINT, type RemoteMux } from "../mux";
import type { HostFrame, MuxFrame } from "../../types";
import { projectEmit, projectWaterfall, type RemoteEventItem } from "./frames";

/** waterfall 的应答载荷,与 `parseRemoteEventResult`(stream-protocol.js:17-53)同形。 */
export type RemoteEventOutcome =
  | { kind: "result"; value?: unknown }
  | { kind: "next" }
  | { kind: "rejected"; error: { name: string; message: string; code?: string } };

/**
 * 审批的两种终局:与 legacy `/api/respond` 的 `outcome` 取值一致。
 *
 * 这是**能发出去**的取值。服务端回来、以及进帧 `approval/resolved` 的那套更宽
 * (`cancelled`/`unavailable` 不是我能答的,是「别人答了/工作流撤了」),所以下面
 * 另立 `ApprovalResolution` —— 混成一个类型就会让「答一个 cancelled」编译得过。
 */
export type ApprovalOutcome = "allowed-once" | "rejected";

/** 进 `approval/resolved` 的终局全集(与 types.ts 的 MuxFrame 声明逐字一致)。 */
export type ApprovalResolution = ApprovalOutcome | "cancelled" | "unavailable";

export interface EventsSink {
  onMux(env: FrameEnvelope<MuxFrame>): void;
  onHost(env: FrameEnvelope<HostFrame>): void;
  /** 发一条 `$events/result`。由适配器注入(它才知道 clientId 与传输细节)。 */
  send(clientId: string, eventId: string, outcome: RemoteEventOutcome): Promise<void>;
  newRpcId(): string;
  onLog?(message: string): void;
}

/**
 * 一条待办 waterfall 的本地记账。
 *
 * 只留「撤卡时要知道什么」两样:类型(决定发哪个 resolved 帧)与会话 id(帧里要带)。
 * **不记我自己发过的答案** —— 见 `answer` 的说明:答成功就当场结算并删掉这条,
 * 答失败则什么都不改,所以不存在「答过但还没结算」的中间态可记。
 */
type PendingEvent = { kind: "approval" | "question"; sessionId: string };

/** 重新开流的退避上限。服务端重启期间会连续失败,别打成热循环。 */
const MAX_REOPEN_MS = 30_000;
const BASE_REOPEN_MS = 1_000;

export class RemoteEvents {
  private stream: MuxStream | undefined;
  private clientId: string | undefined;
  private disposed = false;
  private reopenTimer: NodeJS.Timeout | undefined;
  private reopenDelay = BASE_REOPEN_MS;
  /** 未结算的 waterfall,按 eventId 索引 —— 跨代去重的唯一依据。 */
  private readonly pending = new Map<string, PendingEvent>();

  constructor(
    private readonly mux: RemoteMux,
    private readonly sink: EventsSink,
  ) {}

  /** 当前代的 clientId。回答 waterfall 必须用它,拿不到就不能答。 */
  get currentClientId(): string | undefined {
    return this.clientId;
  }

  start(): void {
    if (this.disposed || this.stream !== undefined) return;
    this.stream = this.mux.open<RemoteEventItem>(EVENTS_ENDPOINT, {}, {
      onItem: (item) => this.onItem(item),
      // 流被服务端正常结束:`mux.ts` 会把它从登记表里摘掉(重连不会再补发),
      // 所以这里必须自己重开,否则审批功能会静默死掉 —— 那是最难查的一类故障。
      onEnd: () => {
        this.stream = undefined;
        this.clientId = undefined;
        this.log("$events 流被服务端结束,稍后重开");
        this.scheduleReopen();
      },
      onError: (error) => {
        this.stream = undefined;
        this.clientId = undefined;
        // 最常见的是 gateway/service-unavailable(转发源没注册 —— 通常是服务端
        // 正在重启)。同样是重开,但记录错误码,免得用户看到一个没有解释的静默。
        this.log(`$events 流错误 ${error.code}: ${error.message}`);
        this.scheduleReopen();
      },
    });
  }

  private scheduleReopen() {
    if (this.disposed || this.reopenTimer !== undefined) return;
    const delay = this.reopenDelay;
    this.reopenDelay = Math.min(delay * 2, MAX_REOPEN_MS);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = undefined;
      this.start();
    }, delay);
  }

  private log(message: string) {
    this.sink.onLog?.(`[events] ${message}`);
  }

  private onItem(item: RemoteEventItem) {
    if (item === null || typeof item !== "object") return;
    switch (item.type) {
      case "ready": {
        this.clientId = item.clientId;
        // 能收到 ready 就说明服务端认了这条流 —— 把退避重置,别让一次长故障
        // 之后的正常重连还背负 30s 的延迟。
        this.reopenDelay = BASE_REOPEN_MS;
        this.log(`$events 就绪(clientId=${item.clientId})`);
        return;
      }
      case "waterfall": {
        this.onWaterfall(item);
        return;
      }
      case "emit": {
        if (Array.isArray(item.args)) {
          const projected = projectEmit(item.event, item.args, () => this.sink.newRpcId());
          if (projected?.channel === "host") this.sink.onHost({ rpcId: projected.rpcId, frame: projected.frame });
        }
        return;
      }
      case "cancel": {
        this.onCancel(item.eventId);
        return;
      }
      default:
        return;
    }
  }

  private onWaterfall(item: { event: string; eventId: string; agentId: string; request: unknown }) {
    // 跨代去重:重连后服务端会把未结算的 waterfall 用**同一个 eventId** 再投一次。
    // 再发一遍帧就是第二张卡片,而两张卡片背后只有一条 waterfall。
    if (this.pending.has(item.eventId)) return;
    const projected = projectWaterfall(item.event, item.eventId, item.agentId, item.request, () =>
      this.sink.newRpcId(),
    );
    if (projected === undefined || projected.channel !== "mux") return;
    const kind = item.event === "approval/request" ? "approval" : "question";
    this.pending.set(item.eventId, { kind, sessionId: item.agentId });
    this.sink.onMux({ rpcId: projected.rpcId, frame: projected.frame });
  }

  private settleApproval(eventId: string, sessionId: string, outcome: ApprovalResolution) {
    this.sink.onMux({
      rpcId: eventId,
      frame: { type: "approval/resolved", sessionId, approvalId: eventId, outcome },
    });
  }

  private settleQuestion(eventId: string, sessionId: string, outcome: "answered" | "cancelled") {
    this.sink.onMux({
      rpcId: eventId,
      frame: { type: "question/resolved", sessionId, questionRpcId: eventId, outcome },
    });
  }

  /** 按记账的类型撤卡。审批与提问的 resolved 帧字段名不同,所以必须分派。 */
  private settlePending(eventId: string, entry: PendingEvent, outcome: "cancelled") {
    if (entry.kind === "approval") this.settleApproval(eventId, entry.sessionId, outcome);
    else this.settleQuestion(eventId, entry.sessionId, outcome);
  }

  /**
   * 结算通知。
   *
   * **能走到这里,说明我还没结算过这条** —— 我自己答成功时会当场 settle 并删掉记录,
   * 而 `receiveRemoteEventResult` 又会把回答者从投递集合里摘掉,所以「我答的」那条
   * 我永远收不到 cancel。于是剩下的两种来源是:
   *   - 别的地方答了(Web 界面、另一个扩展实例);
   *   - Agent 上下文被释放(网关 `cancelRemoteEvent` 的另一个入口)。
   * 对界面来说都是同一件事:这事结束了,把卡片撤掉。报 `cancelled`(fail-closed)。
   */
  private onCancel(eventId: string) {
    const entry = this.pending.get(eventId);
    if (entry === undefined) return; // 已经结算过(或不是我们在跟的)
    this.pending.delete(eventId);
    this.settlePending(eventId, entry, "cancelled");
  }

  /**
   * 回答审批。`eventId` 就是 `approvalId`(见 frames.ts 的说明)。
   *
   * **必须先 await 发成功、再本地结算**,两件事的因果不能颠倒:
   *   - 服务端认没认,唯一的凭据是 `$events/result` 返回 `ok:true`
   *     (`dispatchRpc` 里 `receiveRemoteEventResult` 在返回 ok 之前同步跑完);
   *   - 而**不能等 cancel 来撤卡**:`receiveRemoteEventResult` 第一件事就是
   *     `removeRemoteEventDelivery(pending, client)` 把回答者自己摘出投递集合
   *     (dsh-api-gateway/lib/index.js:685),于是 `finishRemoteEvent` 的 cancel
   *     只会推给**别的** client —— 我答的这条我自己收不到。只等 cancel 的话,
   *     用户点完按钮卡片会永远留在界面上。
   *
   * 发送失败时**什么都不改**:pending 记录留着,重投的那条会被去重(卡片不变两张),
   * 用户也能再点一次。这正是「宁可让卡片多留一会儿,也不能假装答成功」。
   */
  async answerApproval(eventId: string, outcome: ApprovalOutcome): Promise<void> {
    const entry = this.pending.get(eventId);
    await this.answer(eventId, { kind: "result", value: outcome });
    if (entry === undefined || entry.kind !== "approval") return;
    this.pending.delete(eventId);
    this.settleApproval(eventId, entry.sessionId, outcome);
  }

  /** 回答提问。答案形状(`{answers:[{id,selected,custom?}]}`)与 0.1.5 契约逐字段一致。 */
  async answerQuestion(
    eventId: string,
    answer: { answers: { id: string; selected: string[]; custom?: string }[] },
  ): Promise<void> {
    const entry = this.pending.get(eventId);
    await this.answer(eventId, { kind: "result", value: answer });
    if (entry === undefined || entry.kind !== "question") return;
    this.pending.delete(eventId);
    this.settleQuestion(eventId, entry.sessionId, "answered");
  }

  /**
   * 声明「我不处理这条」——交回 waterfall 的下一个监听者。本适配器目前不用。
   *
   * `next` 只有在**投递集合已经空了**的时候才结算(`receiveRemoteEventResult` 的
   * 最后一个分支),所以它**不是**一次结算,不能因此报终局。但卡片还是得撤:
   * 我这一份已经交出去了,而且同样被摘出了投递集合,后续别处结算也不会再通知我。
   */
  async decline(eventId: string): Promise<void> {
    const entry = this.pending.get(eventId);
    await this.answer(eventId, { kind: "next" });
    if (entry === undefined) return;
    this.pending.delete(eventId);
    this.settlePending(eventId, entry, "cancelled");
  }

  private async answer(eventId: string, outcome: RemoteEventOutcome) {
    const clientId = this.clientId;
    if (clientId === undefined) {
      // 没有 clientId 意味着 `$events` 还没就绪(或刚断)。此时答什么都会被网关
      // 拒掉,不如直接报出来 —— 上层会把它变成一条用户可见的提示。
      throw new Error("$events 尚未就绪,无法回答(没有 clientId)");
    }
    await this.sink.send(clientId, eventId, outcome);
  }

  /** 测试用:当前跟踪的待办 eventId(跨代去重的断言点)。 */
  get pendingEventIds(): string[] {
    return [...this.pending.keys()];
  }

  stop(): void {
    this.disposed = true;
    if (this.reopenTimer !== undefined) clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    this.stream?.cancel();
    this.stream = undefined;
    this.clientId = undefined;
    this.pending.clear();
  }
}
