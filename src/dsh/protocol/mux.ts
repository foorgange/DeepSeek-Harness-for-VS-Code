/**
 * dsh 0.1.5 的复用流传输:/api/remote.mux。
 *
 * 0.1.1 用两条固定 WebSocket(/api/events.mux、/api/events.host)承载事件;
 * 0.1.5 换成**一条** socket 承载 N 条**逻辑流**:
 *   客户端 → 服务端  { type:"open", streamId, endpoint, payload:{args} }   (恰好这 4 个键)
 *                    { type:"cancel", streamId }                          (恰好这 2 个键)
 *   服务端 → 客户端  { type:"item", streamId, value? } | { type:"end", streamId }
 *                    | { type:"error", streamId, error:{code,message,details} }
 * streamId 由客户端自造,服务端原样回带 —— 这是唯一的关联手段。
 *
 * 关键约束(stream-protocol.js:155-197 的 exactKeys 校验):
 *   - 帧的键集是**严格**的,多一个键就整帧非法、连接被以 4002 关闭;
 *   - 服务端下行只有 item/end/error 三种,所以 $events 的 emit/waterfall/cancel
 *     是作为 item 的 value 传过来的,**不是**裸帧;
 *   - 上层「事件流」与「主机流」在本协议里降级为同一条 socket 上的两个逻辑流
 *     (保留端点 $events 与 $events/result 由网关内部提供)。
 *
 * 重连:协议里**没有** resume/游标参数,所以每次重建物理连接后,所有逻辑流都要
 * 原样重开一遍,由服务端重新发一份完整开局帧。上层靠 seq 去重吸收重叠部分。
 * 关闭码 4000 = 服务端要求重连,4002 = 帧非法。
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RpcError } from "../types";
import type { DshAuth } from "./auth";

/** 保留端点:事件流。与 dsh 常量 REMOTE_EVENT_STREAM_ENDPOINT 一致。 */
export const EVENTS_ENDPOINT = "$events";
/** 保留端点:waterfall 应答(走 unary HTTP,不是流)。 */
export const EVENTS_RESULT_ENDPOINT = "$events/result";

export type MuxState = "disconnected" | "connecting" | "connected";

export interface MuxStreamHandlers<T = unknown> {
  /** 收到一条 item(值可能是任何 JSON)。 */
  onItem(value: T): void;
  /** 流正常结束。 */
  onEnd?(): void;
  /** 流级错误。收到后该流即被移除,调用方如需继续应重新 open。 */
  onError?(error: RpcError): void;
}

export interface MuxStream {
  readonly streamId: string;
  readonly endpoint: string;
  cancel(): void;
}

export interface RemoteMuxConfig {
  baseUrl: string;
  /** 每次(重)连都重新解析一次凭据 —— Cookie 有有效期,重连时可能已过期。 */
  auth: () => Promise<DshAuth | undefined>;
  onState?: (state: MuxState) => void;
  onLog?: (message: string) => void;
  /** 服务端返回 401:凭据失效或缺失,调用方应清除缓存后重试。 */
  onUnauthorized?: () => void;
}

interface StreamRecord {
  endpoint: string;
  args: unknown;
  handlers: MuxStreamHandlers<never>;
}

const MAX_RETRY_MS = 10_000;
const BASE_RETRY_MS = 500;

export class RemoteMux {
  private socket: WebSocket | undefined;
  private readonly streams = new Map<string, StreamRecord>();
  private disposed = false;
  private retryDelay = BASE_RETRY_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private state: MuxState = "disconnected";
  /**
   * 一次 `kick()` 正在进行中。
   *
   * `socket` 要等 `await auth()` 之后才赋值,所以光靠 `socket !== undefined` 挡不住
   * **并发**的 `connect()`:两个调用都能在 await 之前通过那道守卫,各建一条 socket。
   * 实测这个窗口是真的会撞上 —— 适配器装好后 `setFrameHandlers()` 与紧接着的
   * `sessionHistory()`(它会 `ensureStreams()`)本就挨着,日志里表现为
   * 「连接…」打两遍、两条 socket 各自重开全部逻辑流。后果是帧收到两份(靠 seq/eventId
   * 去重才没炸)、连接数翻倍。
   */
  private kicking = false;

  constructor(private readonly cfg: RemoteMuxConfig) {}

  get currentState(): MuxState {
    return this.state;
  }

  /** 幂等:已连、正在连、或已销毁时无操作。 */
  connect(): void {
    void this.kick();
  }

  private setState(state: MuxState) {
    if (this.state === state) return;
    this.state = state;
    this.cfg.onState?.(state);
  }

  private log(message: string) {
    this.cfg.onLog?.(`[mux] ${message}`);
  }

  /**
   * 建连。守卫是**三重**的:已销毁 / 已有 socket / 已有一次 kick 在路上。
   * 第三重见 `kicking` 的注释 —— 少了它,并发调用会开出第二条 socket。
   */
  private async kick(): Promise<void> {
    if (this.disposed || this.socket !== undefined || this.kicking) return;
    this.kicking = true;
    try {
      await this.kickInner();
    } finally {
      // 放在 finally:中途抛错也要放开,否则这条 mux 永远不再重连。
      this.kicking = false;
    }
  }

  private async kickInner(): Promise<void> {
    if (this.disposed || this.socket !== undefined) return;
    this.setState("connecting");

    let auth: DshAuth | undefined;
    try {
      auth = await this.cfg.auth();
    } catch (error) {
      this.log(`解析凭据失败: ${error instanceof Error ? error.message : String(error)}`);
      auth = undefined;
    }
    if (this.disposed) return;
    if (!auth) {
      // 服务端可能还没起来 → 稍后重试,而不是永久失败
      this.log("暂无可用的鉴权凭据,稍后重试");
      this.scheduleReconnect();
      return;
    }

    const url = muxUrl(this.cfg.baseUrl);
    this.log(`连接 ${url} (鉴权来源: ${auth.via})`);
    // 只带 Cookie:Origin 一律不发(isTrustedApiRequest 在 origin 缺失时直接放行),
    // Host 交给 ws 从 URL 自动生成 —— 与 authorityOf() 的归一化结果一致。
    const ws = new WebSocket(url, { handshakeTimeout: 5000, headers: { cookie: auth.cookie } });
    this.socket = ws;

    ws.on("open", () => {
      this.retryDelay = BASE_RETRY_MS;
      this.setState("connected");
      this.log(`已连接,重开 ${this.streams.size} 条逻辑流`);
      for (const streamId of this.streams.keys()) this.sendOpen(streamId);
    });
    ws.on("message", (data) => this.onMessage(data));
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        this.log("服务端返回 401,鉴权凭据失效");
        this.cfg.onUnauthorized?.();
      } else {
        this.log(`握手被拒: HTTP ${res.statusCode}`);
      }
    });
    ws.on("error", (error) => this.log(`socket 错误: ${error.message}`));
    ws.on("close", (code, reason) => {
      if (this.socket === ws) this.socket = undefined;
      if (this.disposed) return;
      this.setState("disconnected");
      // 4000 = 服务端要求重连;4002 = 帧非法(实现有 bug),两者都走重连但把原因记下来
      this.log(`连接关闭 code=${code}${reason?.length ? ` reason=${reason.toString()}` : ""}`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.disposed || this.retryTimer !== undefined) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.kick();
    }, delay);
  }

  private sendOpen(streamId: string) {
    const record = this.streams.get(streamId);
    if (record === undefined) return;
    this.send({ type: "open", streamId, endpoint: record.endpoint, payload: { args: record.args } });
  }

  private send(message: unknown): boolean {
    const ws = this.socket;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  private onMessage(data: WebSocket.RawData) {
    let frame: { type?: string; streamId?: string; value?: unknown; error?: RpcError };
    try {
      frame = JSON.parse(data.toString()) as typeof frame;
    } catch {
      this.log("丢弃非 JSON 帧");
      return;
    }
    const streamId = frame.streamId;
    if (typeof streamId !== "string") return;
    const record = this.streams.get(streamId);
    if (record === undefined) return; // 已取消的流的尾包
    if (frame.type === "item") {
      if (frame.value !== undefined) record.handlers.onItem(frame.value as never);
      return;
    }
    if (frame.type === "end") {
      this.streams.delete(streamId);
      record.handlers.onEnd?.();
      return;
    }
    if (frame.type === "error") {
      this.streams.delete(streamId);
      const error = frame.error ?? { code: "gateway/internal", message: "unknown stream error" };
      this.log(`流错误 ${record.endpoint}: ${error.code} ${error.message}`);
      record.handlers.onError?.(error);
      return;
    }
  }

  /**
   * 打开一条逻辑流。若 socket 尚未就绪则先登记,连接建立时会自动补发 open。
   * args 是 descriptor 的严格参数集 —— 无参端点也必须传 `{}`。
   */
  open<T = unknown>(endpoint: string, args: unknown, handlers: MuxStreamHandlers<T>): MuxStream {
    const streamId = randomUUID();
    this.streams.set(streamId, { endpoint, args, handlers: handlers as StreamRecord["handlers"] });
    this.sendOpen(streamId);
    return {
      streamId,
      endpoint,
      cancel: () => this.cancel(streamId),
    };
  }

  cancel(streamId: string): void {
    if (!this.streams.delete(streamId)) return;
    this.send({ type: "cancel", streamId });
  }

  /**
   * 主动掐断当前连接并立刻重建(不按退避等待)。
   *
   * 与「socket 自己断了」的区别只在**谁发起**:close 里那条路径会走指数退避,
   * 而用户点「重连」时不该等 30 秒。已登记的逻辑流由 `on("open")` 统一重开,
   * 所以这里只负责拆连接 —— 别在这里自己重开一遍流,会开成两份。
   */
  reconnect(): void {
    if (this.disposed) return;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryDelay = BASE_RETRY_MS;
    const ws = this.socket;
    this.socket = undefined;
    if (ws !== undefined) {
      // 摘掉 close 处理器:否则它会把「这次主动断开」当成意外掉线,又排一次重连。
      ws.removeAllListeners("close");
      try {
        ws.terminate();
      } catch {
        // 已经死了
      }
    }
    this.setState("disconnected");
    void this.kick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.streams.clear();
    try {
      this.socket?.removeAllListeners();
      this.socket?.close();
    } catch {
      // 关闭失败无碍:进程退出会回收
    }
    this.socket = undefined;
    this.setState("disconnected");
  }
}

/** 由 baseUrl 推出 mux socket 地址。路径被整体替换,不带任何查询参数。 */
function muxUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/remote.mux";
  url.search = "";
  return url.toString();
}
