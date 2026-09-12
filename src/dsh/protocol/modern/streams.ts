/**
 * 另外两条常驻逻辑流:`session/control`(队列 / 后台任务 / 投影)与
 * `workspace/follow`(工作区分组 + 归档集合)。
 *
 * 为什么两条放一个文件:它们的**骨架**是同一件事 —— 「开一条常驻流、把 item
 * 翻译成内部帧、被结束或出错后自己爬起来」。翻译规则本身在 frames.ts(纯函数、可单测),
 * 这里只剩订阅与重开,所以合并成一个文件比拆三个薄文件更省读者的事。
 *
 * 两条流都是**每代先发一份完整开局帧**(control 是 baseline、workspace 是 baseline),
 * 且协议里没有 resume 游标 —— 所以重连的正确做法就是原样重开、整体替换本地状态,
 * 而不是做增量对账。`RemoteMux` 在 socket 层已经帮我们重开所有**已登记**的流;
 * 这里额外处理的是「流被服务端**单独**结束或报错」的情形(`mux.ts` 会把这种流从
 * 登记表里摘掉,重连不会再补发) —— 不自己重开的话,队列与投影会永久停更。
 */

import type { FrameEnvelope } from "../legacy";
import type { MuxStream, MuxStreamHandlers } from "../mux";
import type { RemoteMux } from "../mux";
import type { HostFrame, MuxFrame } from "../../types";
import {
  projectControl,
  projectWorkspaceBaseline,
  projectWorkspaceIncrement,
  toWorkspaceRow,
  type ControlItem,
  type WorkspaceItem,
  type WorkspaceRow,
} from "./frames";

const MAX_REOPEN_MS = 30_000;
const BASE_REOPEN_MS = 1_000;

interface StreamSink {
  onMux(env: FrameEnvelope<MuxFrame>): void;
  onHost(env: FrameEnvelope<HostFrame>): void;
  newRpcId(): string;
  onLog?(message: string): void;
}

/** 重开退避。服务端重启期间会连续失败,别打成热循环。 */
class Reopener {
  private timer: NodeJS.Timeout | undefined;
  private delay = BASE_REOPEN_MS;
  private stopped = false;

  constructor(
    private readonly reopen: () => void,
    private readonly log: (message: string) => void,
  ) {}

  /** 收到开局帧就重置 —— 一次长故障之后的重连不该继承 30s 的延迟。 */
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

/** 把一次投影结果按 channel 派发出去。 */
function dispatch(projected: { channel: "mux" | "host"; rpcId: string; frame: MuxFrame | HostFrame }[], sink: StreamSink) {
  for (const p of projected) {
    if (p.channel === "mux") sink.onMux({ rpcId: p.rpcId, frame: p.frame as MuxFrame });
    else sink.onHost({ rpcId: p.rpcId, frame: p.frame as HostFrame });
  }
}

/**
 * `session/control` —— 宿主级实时状态。
 *
 * 开局 baseline 是**跨会话打包**的(`{queues: Record<sid, …>, jobs: …, projections: …}`),
 * 而上层的 `session/queue|jobs|projection` 是**按会话**的,所以一条 baseline 会被
 * 扇出成 N 条帧(frames.ts 的 projectControl)。
 *
 * 注意 baseline **没有** approvals/questions 字段 —— 审批与提问只走 `$events`(见 events.ts)。
 * 夹具里那份带 approvals 的 baseline 是假的,别照它写。
 */
export class SessionControl {
  private stream: MuxStream | undefined;
  private disposed = false;
  private readonly reopener: Reopener;

  constructor(
    private readonly mux: RemoteMux,
    private readonly sink: StreamSink,
  ) {
    this.reopener = new Reopener(() => this.start(), (m) => this.sink.onLog?.(`[control] ${m}`));
  }

  start(): void {
    if (this.disposed || this.stream !== undefined) return;
    const handlers: MuxStreamHandlers<ControlItem> = {
      onItem: (item) => {
        if (item?.type === "baseline") this.reopener.reset();
        dispatch(projectControl(item, () => this.sink.newRpcId()), this.sink);
      },
      onEnd: () => {
        this.stream = undefined;
        this.reopener.schedule();
      },
      onError: (error) => {
        this.stream = undefined;
        this.sink.onLog?.(`[control] 流错误 ${error.code}: ${error.message}`);
        this.reopener.schedule();
      },
    };
    // 零参流也必须显式传 `{}`(descriptor: parameters: [] + cancellation: signal)。
    this.stream = this.mux.open<ControlItem>("session/control", {}, handlers);
  }

  stop(): void {
    this.disposed = true;
    this.reopener.stop();
    this.stream?.cancel();
    this.stream = undefined;
  }
}

export interface WorkspaceSnapshot {
  items: WorkspaceRow[];
  archivedSessionIds: string[];
}

/**
 * `workspace/follow` —— 工作区分组与归档集合。
 *
 * 这条流同时承担两件事,因为 0.1.5 里**没有** `workspace.list` 这个 unary:
 *   - `listWorkspaces()` 的首屏(等开局 baseline,`whenReady()`);
 *   - workspace 变化的**实时来源** —— 四种增量与插件的四个 `host/workspace-*` 帧
 *     一一对应。这里把增量同时用于**刷新缓存**(下次调用立即可用)与**派发帧**。
 *
 * 缓存**不因流失效而清空**:拿旧数据总比让侧边栏整块空掉强,而且流重开后
 * 会立刻被新 baseline 整体替换。
 */
export class WorkspaceFollow {
  private stream: MuxStream | undefined;
  private disposed = false;
  private snapshot: WorkspaceSnapshot | undefined;
  private readonly waiters = new Set<(value: WorkspaceSnapshot) => void>();
  private readonly reopener: Reopener;

  constructor(
    private readonly mux: RemoteMux,
    private readonly sink: StreamSink,
  ) {
    this.reopener = new Reopener(() => this.start(), (m) => this.sink.onLog?.(`[workspace] ${m}`));
  }

  start(): void {
    if (this.disposed || this.stream !== undefined) return;
    const handlers: MuxStreamHandlers<WorkspaceItem> = {
      onItem: (item) => this.onItem(item),
      onEnd: () => {
        this.stream = undefined;
        this.reopener.schedule();
      },
      onError: (error) => {
        this.stream = undefined;
        this.sink.onLog?.(`[workspace] 流错误 ${error.code}: ${error.message}`);
        this.reopener.schedule();
      },
    };
    this.stream = this.mux.open<WorkspaceItem>("workspace/follow", {}, handlers);
  }

  private onItem(item: WorkspaceItem) {
    if (item?.type === "baseline") {
      this.reopener.reset();
      const value = projectWorkspaceBaseline(item.value ?? {});
      this.snapshot = value;
      // 归档集合**必须**派发出去:它是「归档」这个动作唯一能让界面产生变化的路径,
      // 而 store 侧的 `host/archived-sessions-changed` 就是它。另外三个 host/workspace-*
      // 帧目前是 store 里的空分支(侧边栏的分组来自 listWorkspaces 的返回值),
      // 照样派发是为了让词汇表完整、也让将来接上时不用改这里。
      this.sink.onHost({
        rpcId: this.sink.newRpcId(),
        frame: { type: "host/archived-sessions-changed", archivedSessionIds: value.archivedSessionIds },
      });
      for (const workspace of value.items) {
        this.sink.onHost({
          rpcId: this.sink.newRpcId(),
          frame: { type: "host/workspace-changed", workspace },
        });
      }
      for (const resolve of this.waiters) resolve(value);
      this.waiters.clear();
      return;
    }
    const projected = projectWorkspaceIncrement(item, () => this.sink.newRpcId());
    if (projected === undefined) return;
    dispatch([projected], this.sink);
    // 增量同时落进缓存:`listWorkspaces()` 下次被调用时不该还回一份旧列表。
    const current = this.snapshot;
    if (current === undefined) return;
    if (item.type === "upsert") {
      // 复用 frames.ts 的解析器而不是自己再解一遍 —— 两份解析会漂移,而且从
      // `WorkspaceView`(帧里那个方向的类型)反向强转回来 TypeScript 判为不合法。
      const row = toWorkspaceRow(item.workspace);
      if (row === undefined) return;
      const index = current.items.findIndex((w) => w.workspaceId === row.workspaceId);
      if (index >= 0) current.items[index] = row;
      else current.items.push(row);
    } else if (item.type === "remove") {
      current.items = current.items.filter((w) => w.workspaceId !== item.workspaceId);
    } else if (item.type === "order") {
      const order = projected.frame.type === "host/workspace-order-changed" ? projected.frame.workspaceIds : [];
      const rank = new Map(order.map((id, i) => [id, i]));
      current.items.sort((a, b) => (rank.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER));
    } else if (item.type === "archived") {
      current.archivedSessionIds =
        projected.frame.type === "host/archived-sessions-changed" ? projected.frame.archivedSessionIds : [];
    }
  }

  /** 已经拿到过的快照(可能来自上一代连接)。 */
  get cached(): WorkspaceSnapshot | undefined {
    return this.snapshot;
  }

  /**
   * 等开局 baseline。已经有缓存就立刻回。
   *
   * 超时是**兜底而非主要失败路径**:流出错时这里**不**立即拒绝,因为控制流会自己重开
   * (服务端重启的场景下通常 1-2 秒后就来了),等一会儿的成功率明显更高。真的一直
   * 没有 baseline 才报错 —— 两个调用点都已经 `catch {}`,会降级成「不分组」而不是崩。
   */
  whenReady(timeoutMs = 8_000): Promise<WorkspaceSnapshot> {
    if (this.snapshot !== undefined) return Promise.resolve(this.snapshot);
    return new Promise<WorkspaceSnapshot>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const onReady = (value: WorkspaceSnapshot) => {
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        this.waiters.delete(onReady);
        reject(new Error("workspace/follow 未在超时前给出 baseline"));
      }, timeoutMs);
      this.waiters.add(onReady);
    });
  }

  stop(): void {
    this.disposed = true;
    this.reopener.stop();
    this.stream?.cancel();
    this.stream = undefined;
    this.waiters.clear();
  }
}
