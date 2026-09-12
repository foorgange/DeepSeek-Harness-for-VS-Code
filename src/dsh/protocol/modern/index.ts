/**
 * modern 适配器 —— dsh 0.1.5 的斜杠寻址 + 强制 Cookie 鉴权,向下翻译成 `DshApiClient` 的公开面。
 *
 * 设计前提(见 protocol/types.ts):modern 客户端必须是 legacy 客户端的**结构化替身**,
 * 这样 hub.ts 与整个 sessionStore/ui 层一行都不用改。翻译集中在**传输与参数形状**上;
 * 事件词汇表的翻译在 frames.ts(S4)。
 *
 * 方法面已**全量落地**(S2 传输/探测、S3 unary、S4 流、S5 历史与流式、S6 模型与预设):
 * `ProtocolAdapter` 是从 `DshApiClient` 映射出来的类型,而这个类被赋给那个类型却不报错
 * —— 也就是说这里已经没有「还没实现的方法」这种东西了。搬运期间用过的
 * `todo()` 抛错桩随之删除:留着它就只是一段没有调用点的死代码。
 */

import { randomUUID } from "node:crypto";
import { DshApiError, type FrameEnvelope } from "../legacy";
import type { DshAuth } from "../auth";
import { authHeaders } from "../auth";
import { RemoteMux } from "../mux";
import { args, ENDPOINTS } from "./args";
import {
  buildProviderRefMap,
  chunkRefs,
  joinCredentials,
  refOf,
  splitRefs,
  type CredentialInfoView,
} from "./credentials";
import { RemoteEvents } from "./events";
import { AssistantStreams } from "./assistant";
import { SessionFollows } from "./history";
import { SessionProjections, synthesizeModels, toSelection, type ModelCatalogValue } from "./models";
import { SessionControl, WorkspaceFollow, type WorkspaceSnapshot } from "./streams";
import type {
  AgentPresetListValue,
  ApprovalAnswer,
  HostDescribeValue,
  HostFrame,
  LlmModelGroup,
  LlmProviderView,
  MuxFrame,
  QuestionAnswer,
  SessionCreateRequest,
  SessionCreateValue,
  SessionHistoryRequest,
  SessionHistoryValue,
  SessionListValue,
  SessionModelsValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionSummary,
  SettingsNamespaceView,
  SubagentEntry,
} from "../../types";

export interface ModernClientOptions {
  /** 每次请求前取鉴权;返回 undefined 表示暂时拿不到(会以无凭据发出,由 401 兜底)。 */
  auth: () => Promise<DshAuth | undefined>;
  /**
   * 服务端明确拒绝了当前凭据(握手 401/403)。上层据此作废缓存、下次重新解析 ——
   * 少了它,一次过期就是永久 401,只能重载窗口。
   */
  onAuthRejected?: () => void;
  /** 诊断日志。 */
  onLog?: (message: string) => void;
}

/**
 * 模型目录的缓存寿命。目录只随设置变(而设置改动会主动作废缓存),所以这个数字
 * 只是为了兜住「别的地方悄悄改了配置」这一种情形,不是权威失效点。
 */
const CATALOG_TTL_MS = 10_000;

interface ServerEnvelope {
  type: string;
  rpcId?: string;
  result?: { ok: true; value: any } | { ok: false; error: { code: string; message: string; details?: unknown } };
}

export class ModernApiClient {
  readonly baseUrl: string;
  private disposed = false;
  /** 会话投影的旁路缓存(模型选择 + 预设),由 sink 喂养,见 models.ts。 */
  private readonly projections = new SessionProjections();

  constructor(
    baseUrl: string,
    private readonly opts: ModernClientOptions,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ---------- 传输 ----------

  /**
   * unary 调用:`POST /api/<ns>/<method>`,body 是信封 + `payload.args`。
   * 参数名必须是 descriptor 里的 `wire` 名(见 tools/api-surface.json),
   * 且服务端**严格 exact-match** —— 多一个键少一个键都是 gateway/arguments-invalid。
   * 零参方法也必须显式传 `{args:{}}`。
   */
  private async post<T>(endpoint: string, args: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.disposed) throw new DshApiError("transport/disposed", "modern 客户端已释放");
    const auth = await this.opts.auth();
    const rpcId = randomUUID();
    const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? authHeaders(auth) : {}),
      },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // 401/403 是门禁,不是业务错误 —— 单独报出来,免得被当成「方法不存在」误导排查
      if (res.status === 401 || res.status === 403) {
        throw new DshApiError(`auth/${res.status}`, `鉴权被拒(${endpoint}):HTTP ${res.status},Cookie 缺失或 authority 不匹配`);
      }
      throw new DshApiError(`transport/${res.status}`, `DSH transport failure for ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    let full: ServerEnvelope;
    try {
      full = JSON.parse(text) as ServerEnvelope;
    } catch {
      throw new DshApiError("transport/malformed", `${endpoint} 返回了非 JSON 响应:${text.slice(0, 200)}`);
    }
    if (full.result === undefined) throw new DshApiError("transport/malformed", `${endpoint} 响应缺少 result 字段`);
    if (!full.result.ok) {
      throw new DshApiError(full.result.error.code, full.result.error.message, full.result.error.details);
    }
    return full.result.value as T;
  }

  /** unary 调用 + 形状表取参,省得每个方法都写一遍 `${this.baseUrl}/api/...`。 */
  private call<T>(op: keyof typeof ENDPOINTS, wireArgs: unknown, timeoutMs?: number): Promise<T> {
    return this.post<T>(ENDPOINTS[op], wireArgs, timeoutMs);
  }

  // ---------- 探测:主机信息与会话列表 ----------

  /**
   * 0.1.5 没有 host.describe(整条点号路由已废),用它合成一个。
   * hub 只读 version/provider/model,其余字段给保守默认值。
   */
  async ping(timeoutMs = 3000): Promise<HostDescribeValue | undefined> {
    try {
      const catalog = await this.modelCatalog(timeoutMs);
      return {
        version: "0.1.5",
        cwd: "",
        provider: catalog.default?.provider,
        model: catalog.default?.model,
        attachedSessions: 0,
        canOpenPath: false,
      };
    } catch {
      return undefined;
    }
  }

  /** 目录缓存与去重(见 `modelCatalog()`)。 */
  private catalog: { value: ModelCatalogValue; at: number } | undefined;
  private catalogInFlight: Promise<ModelCatalogValue> | undefined;

  /**
   * `session/modelCatalog`,带 TTL 缓存与在途去重。
   *
   * 为什么要缓存:它是**全局**目录(与会话无关),而 `sessionModels()` 每次被问都要它
   * —— `hub.getSessionModels` / `updateCurrentModel` / `applyDefaultReasoningEffort`
   * 三条路都会问,界面上打开一次模型菜单又是一次。目录变化只可能来自设置(用户改
   * provider/模型表),所以 `settingsUpdate()` 会主动作废它,TTL 只是兜底。
   *
   * 在途去重是因为菜单打开时会有两次几乎同时的调用(读 current + 列 groups),
   * 不合并就是两趟一模一样的往返。
   */
  private modelCatalog(timeoutMs?: number): Promise<ModelCatalogValue> {
    const now = Date.now();
    if (this.catalog !== undefined && now - this.catalog.at < CATALOG_TTL_MS) {
      return Promise.resolve(this.catalog.value);
    }
    if (this.catalogInFlight !== undefined) return this.catalogInFlight;
    const pending = this.call<ModelCatalogValue>("sessionModelCatalog", args.sessionModelCatalog(), timeoutMs)
      .then((value) => {
        this.catalog = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.catalogInFlight = undefined;
      });
    this.catalogInFlight = pending;
    return pending;
  }

  /**
   * 会话列表。
   *
   * `agentPreset` 在 0.1.5 的 `session/list` 里**两个位置都可能没有**:顶层没有,
   * `SessionSummary.projections` 只是**缓存快照**(`projectionsFor()`:内存里没有的
   * 会话走 `cachedSnapshot` / `cachedPredecessorTitle`,所以 118 个会话里只有 `title`
   * 出现,有的还是 null)。但 `session/control` 的开局 baseline 带**全部会话的全部
   * 投影**,里面就有 `agentPreset`(实测 5/5)—— 那份数据由 sink 喂进
   * `this.projections`(见 models.ts)。所以三级取值:顶层 → list 的投影 → 控制流缓存。
   *
   * 三级都拿不到就不写,侧边栏的预设标签降级为空。会话刚开始、控制流还没把它的投影
   * 送过来时就是这种情形,而下一次 `refreshSessions()`(5s 轮询)就有了。
   *
   * `title` 是 `session/list` 真正会给的东西,hub.refreshSessions() 正是靠它渲染侧边栏。
   */
  async listSessions(): Promise<SessionListValue> {
    const value = await this.post<{ items: SessionSummary[] }>("session/list", { _request: {} });
    const items = (value.items ?? []).map((item) => {
      const fromList = item.projections?.values?.["agentPreset"];
      const preset = item.agentPreset ?? (typeof fromList === "string" ? fromList : this.projections.agentPresetOf(item.sessionId));
      return typeof preset === "string" ? { ...item, agentPreset: preset } : item;
    });
    return { ...value, items };
  }

  // ---------- 常驻事件流 ----------

  private muxOnFrame: ((env: FrameEnvelope<MuxFrame>) => void) | undefined;
  private hostOnFrame: ((env: FrameEnvelope<HostFrame>) => void) | undefined;
  private onState: ((which: "mux" | "host", state: "disconnected" | "connecting" | "connected") => void) | undefined;
  private mux: RemoteMux | undefined;
  private events: RemoteEvents | undefined;
  private control: SessionControl | undefined;
  private workspaces: WorkspaceFollow | undefined;
  private assistantStreams: AssistantStreams | undefined;
  private follows: SessionFollows | undefined;

  setFrameHandlers(handlers: {
    onMuxFrame: (env: FrameEnvelope<MuxFrame>) => void;
    onHostFrame: (env: FrameEnvelope<HostFrame>) => void;
    onState?: (which: "mux" | "host", state: "disconnected" | "connecting" | "connected") => void;
  }) {
    this.muxOnFrame = handlers.onMuxFrame;
    this.hostOnFrame = handlers.onHostFrame;
    this.onState = handlers.onState;
    this.ensureStreams();
  }

  /**
   * 起 transport 与三条常驻逻辑流,幂等。
   *
   * 为什么现在才连(而不是构造时就连):`setFrameHandlers` 之前没有帧的去处,
   * 连上去只会收到无法解释的载荷。`hub.ts` 在 `createAdapter` 之后立刻调它,
   * 所以实际时序上没有空窗。
   *
   * 三条流的分工(全部在 `remote.mux` 这一条 socket 上,由 `RemoteMux` 统一重开):
   *   `$events`          审批 / 提问的 waterfall + 会话生命周期广播
   *   `session/control`  队列 / 后台任务 / 投影
   *   `workspace/follow` 工作区分组 + **归档集合**
   *
   * `onState` 把 mux 的连接状态以 `"mux"` 报给上层 —— legacy 用 `"mux"`/`"host"` 两条流,
   * 这里把三条都归到 `"mux"` 这一个状态上(0.1.5 物理上确实只有一条 socket)。
   */
  private ensureStreams(): void {
    if (this.disposed || this.muxOnFrame === undefined) return;
    if (this.mux === undefined) {
      const sink = {
        // 旁路嗅一下再转发:`models.ts` 的缓存要的是「这个会话选了哪个模型/哪个预设」,
        // 而这两个键散在控制流的 baseline 与会话快照里。嗅探不消费帧,只记值。
        onMux: (env: FrameEnvelope<MuxFrame>) => {
          this.projections.note(env.frame);
          this.muxOnFrame?.(env);
        },
        onHost: (env: FrameEnvelope<HostFrame>) => {
          this.projections.note(env.frame);
          this.hostOnFrame?.(env);
        },
        newRpcId: () => randomUUID(),
        onLog: (message: string) => this.opts.onLog?.(message),
      };
      // 全部逻辑流共用一个上游状态:`mux.ts` 已经负责「断了就重连 + 重开所有已登记流」,
      // 所以这里不做任何额外的重连逻辑,只把状态透出去。
      this.mux = new RemoteMux({
        baseUrl: this.baseUrl,
        auth: this.opts.auth,
        onState: (state) => this.onState?.("mux", state === "disconnected" ? "disconnected" : state),
        onLog: (message) => this.opts.onLog?.(message),
        onUnauthorized: () => {
          this.opts.onLog?.("[protocol] remote.mux 鉴权被拒(401/403),作废当前凭据,重连时重新解析");
          // 不作废的话,重连会拿着同一个过期 Cookie 一直撞 401 —— 修好重连却仍然自愈不了。
          this.opts.onAuthRejected?.();
        },
      });
      this.events = new RemoteEvents(this.mux, {
        ...sink,
        // `$events/result` 是 **unary HTTP**(不是流),所以应答要绕回 post()。
        send: (clientId, eventId, outcome) =>
          this.call<void>("eventsResult", args.eventsResult(clientId, eventId, outcome)).then(() => undefined),
      });
      this.control = new SessionControl(this.mux, sink);
      this.workspaces = new WorkspaceFollow(this.mux, sink);
      // 流式增量的 seq 是**铸造**的(0.1.5 不再把 `assistant/chunk` 当持久事件),
      // 铸造规则见 assistant.ts —— 它和会话跟随流共享「持久游标」这一个状态,所以
      // 两个对象必须配同一份 sink 与同一条流。
      this.assistantStreams = new AssistantStreams(sink);
      this.follows = new SessionFollows(this.mux, sink, this.assistantStreams, (request) =>
        this.call<{ records?: unknown; hasMore?: unknown }>("sessionPage", args.sessionPage(request)),
      );
    }
    this.mux.connect();
    this.events?.start();
    this.control?.start();
    // 提前把 workspace/follow 打开:它的 baseline 同时喂养侧边栏与归档集合,
    // 而 `listWorkspaces()` 是「按需调用」的 —— 提前开流意味着第一次调用几乎总能
    // 命中缓存,而不是干等一次往返。
    this.workspaces?.start();
  }

  // ---------- unary 方法 ----------

  /**
   * 工作区列表。
   *
   * 0.1.5 **没有** `workspace.list`,工作区是 `workspace/follow` 流的开局 baseline
   * (`{items, archivedSessionIds}` —— 与 legacy 的返回值**逐字段同形**,所以这里不需要
   * 任何形状翻译)。这是本适配器里唯一一处「不能同步返回」的点:调用方要的是一个
   * Promise,而 baseline 要等 socket 连上才来。
   *
   * 流在 `setFrameHandlers` 里就已经提前打开,所以正常情况下这里命中缓存、立即返回;
   * 只有在极早期调用才会真的等一次往返。超时上限见 `WorkspaceFollow.whenReady`。
   */
  listWorkspaces(): Promise<WorkspaceSnapshot> {
    // 未起流就现起(理论上不会走到:`ensureStreams` 在 hub 装好帧处理器的同时就被调用)
    this.ensureStreams();
    const follow = this.workspaces;
    if (follow === undefined) {
      // 连帧处理器都没装 —— 上层拿不到任何帧,这时给出明确错误比静默空列表好
      return Promise.reject(new DshApiError("protocol/not-ready", "modern 适配器尚未接到帧处理器(setFrameHandlers)"));
    }
    return follow.whenReady();
  }

  createSession(payload: SessionCreateRequest): Promise<SessionCreateValue> {
    return this.call<SessionCreateValue>("sessionCreate", args.sessionCreate(payload));
  }

  /**
   * 会话历史。
   *
   * 0.1.5 **没有** `session.history` 这个 unary。首屏是 `session/follow` 的开局快照
   * (`{cursor, records, hasMore, projections}`),`records.map(r => r.event)` 正好是
   * 这里要的 `events`(而且 `SessionWireEvent` 与插件的 `SessionEvent` 逐字段同形,
   * 不需要翻译)。两个分支:
   *
   *   · 不带 `beforeSeq` → 开局快照,顺便**把跟随流留开**。这一点是有意的:
   *     0.1.1 有一条全局 `events.mux` 推所有会话的增量,0.1.5 没有,所以「这个会话
   *     的实时事件」只能靠这条流。`hub.ensureHistory` 每个会话只跑一次,如果这里
   *     不顺手把流留下,那个会话的实时更新就永远不会来。
   *   · 带 `beforeSeq` → `session/page` 向后翻页,`throughSeq` 用开局帧的游标。
   *     游标**可能是 -1**(空会话),那时空页恰好是对的;真正要防的是拿 -1 去顶替
   *     真实游标 —— 那会让每一页都是空的且不报错。
   */
  async sessionHistory(payload: SessionHistoryRequest): Promise<SessionHistoryValue> {
    const follows = this.requireFollows("sessionHistory");
    if (payload.beforeSeq !== undefined) {
      // 翻页:`throughSeq` 必须是开局帧给的那个游标。它有可能是 `-1`(空会话),
      // 而 `paginate` 里 `end = min(throughSeq + 1, beforeSeq ?? …)` —— 拿 -1 顶替
      // 真实游标就会恒等于空页且 `hasMore:false`,表现是「打开老会话一片空白还不报错」。
      const { cursor } = await follows.follow({ kind: "session", sessionId: payload.sessionId });
      const page = await follows.readPage(
        { kind: "session", sessionId: payload.sessionId },
        cursor,
        payload.beforeSeq,
        payload.maxMessages,
      );
      return { events: page.events, hasMore: page.hasMore };
    }
    const snapshot = await follows.follow({ kind: "session", sessionId: payload.sessionId });
    return { events: snapshot.events, hasMore: snapshot.hasMore };
  }

  private requireFollows(method: string): SessionFollows {
    this.ensureStreams();
    const follows = this.follows;
    if (follows === undefined) {
      throw new DshApiError("protocol/not-ready", `modern 适配器尚未接到帧处理器,无法 ${method}()`);
    }
    return follows;
  }

  sendPrompt(payload: SessionPromptRequest): Promise<SessionPromptValue> {
    // requestId 由客户端铸造,会回传到 SessionQueuedItem.rpcId —— 用来退掉本地乐观回声
    const requestId = randomUUID();
    return this.call<SessionPromptValue>("sessionPrompt", args.sessionPrompt({ ...payload, requestId }), 60_000);
  }

  cancelSession(sessionId: string): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>("sessionCancel", args.sessionCancel(sessionId));
  }

  updateQueue(
    sessionId: string,
    itemId: string,
    action: { kind: "edit"; content: unknown[] } | { kind: "remove" } | { kind: "steer" },
  ): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>("sessionUpdateQueue", args.sessionUpdateQueue(sessionId, itemId, action));
  }

  /**
   * 宿主执行斜杠命令。
   *
   * `submittedAttachments` **必须显式传 `[]`** —— descriptor 里它是必需参数。
   * 这是移植清单里点名的第二个真 bug:`extension.ts` 在激活时就调 `/checkpoints`,
   * 漏了这个键会直接 `gateway/arguments-invalid`,表现为「回退检查点整块死掉」。
   *
   * 线上签名 `execute → CommandExecution | undefined`,`undefined` 表示
   * 「宿主不认这条命令」;legacy 的类型没有 undefined,所以这里合成一个
   * `kind:"error"` 的结果 —— 与 legacy 的失败语义一致,且**不抛错**,
   * 免得把「命令不存在」升级成「服务端坏了」。
   */
  async executeCommand(
    sessionId: string,
    line: string,
  ): Promise<{ commandId: string; result: { kind: "success" | "error"; text?: string } }> {
    const execution = await this.call<
      { commandId: string; result: { kind: "success" | "error"; text?: string } } | undefined
    >("commandsExecute", args.commandsExecute(sessionId, line));
    if (execution === undefined) {
      return { commandId: `unhandled:${line}`, result: { kind: "error", text: `宿主没有这条命令:${line}` } };
    }
    return execution;
  }

  renameSession(sessionId: string, title: string): Promise<{ title: string; seq: number }> {
    return this.call<{ title: string; seq: number }>("sessionRename", args.sessionRename(sessionId, title));
  }

  forkSession(sessionId: string, atSeq?: number): Promise<{ sessionId: string }> {
    return this.call<{ sessionId: string }>("sessionFork", args.sessionFork(sessionId, atSeq));
  }

  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.call<{ archivedSessionIds: string[] }>(
      "workspaceArchiveSession",
      args.workspaceArchiveSession(sessionId),
    );
  }

  /** 采纳一个已有目录为 DSH 工作区(幂等:已存在时返回现有 workspace 且 created=false)。 */
  adoptWorkspace(path: string): Promise<{ workspace: { workspaceId: string; path: string; title: string; createdAt: string }; created: boolean }> {
    return this.call<{ workspace: { workspaceId: string; path: string; title: string; createdAt: string }; created: boolean }>(
      "workspaceCreate",
      args.workspaceCreate(path),
    );
  }

  /**
   * 模型目录 + 「这个会话选中了哪个」的合成(S6,规则见 models.ts)。
   *
   * 与会话相关的那一半来自投影缓存,而缓存是 `session/control` 的 baseline 喂的 ——
   * 所以**不必先打开那个会话**;真的一次都没收到过(极早期的新会话)就退回目录默认值,
   * 那正是服务端会给新会话用的值。
   */
  async sessionModels(sessionId: string): Promise<SessionModelsValue> {
    const catalog = await this.modelCatalog();
    return synthesizeModels(catalog, this.projections.selectionOf(sessionId));
  }

  /**
   * 切换会话的模型。
   *
   * 回值保持 legacy 的 `{selected}`(线上就是 `SessionSelectModelValue`)。
   * 回来后**立刻**把选择落进投影缓存:`hub.updateCurrentModel()` 紧接着就会重读
   * `current`,而服务端的投影帧还在路上 —— 不乐观写一次,状态栏就要等下一帧才变。
   */
  async selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<{ selected: unknown }> {
    const value = await this.call<{ selected: unknown }>(
      "sessionSelectModel",
      args.sessionSelectModel(sessionId, provider, model, reasoningEffort),
    );
    const selected =
      toSelection(value?.selected) ?? toSelection({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
    if (selected !== undefined) this.projections.markSelected(sessionId, selected);
    return value;
  }

  /**
   * Agent 预设名册。
   *
   * 0.1.5 的 `AgentPresetRoster` 是 `{presets, authorable}`,**没有 `hasDocument`**
   * —— 那个字段是 legacy 的 settings 文档概念,0.1.5 里不存在对应信息源。
   * 这里合成 `false`(与 legacy 在「没有文档」时的取值一致),并在注释里记明它是合成的。
   * 实测本仓库只有 `types.ts` 声明它,无消费点,所以合成不会影响任何界面。
   */
  async listAgentPresets(): Promise<AgentPresetListValue> {
    const roster = await this.call<{ presets: AgentPresetListValue["presets"]; authorable: boolean }>(
      "agentPresetsList",
      args.agentPresetsList(),
    );
    return { presets: roster.presets ?? [], authorable: roster.authorable === true, hasDocument: false };
  }

  async selectAgentPreset(sessionId: string, agentPreset: string): Promise<{ agentPreset: string }> {
    const value = await this.call<string>("agentPresetsSelect", args.agentPresetsSelect(sessionId, agentPreset));
    // 线上回的是被选中的 id 字符串,legacy 回 {agentPreset}
    return { agentPreset: typeof value === "string" ? value : agentPreset };
  }

  /**
   * 复制预设。线上签名是 `(from, id, name?)` —— **与 legacy 的 `(id)` 不同**。
   * legacy 的 `copyAgentPreset(id)` 语义是「以 id 为模板造一个新预设」,
   * 所以这里 `from = id`,新 id 也取 `id`(服务端对重名有自己的规则,会回错误码)。
   * 回值线上是 `void`,legacy 要 `{id, name?}`,照传入值合成。
   */
  async copyAgentPreset(id: string): Promise<{ id: string; name?: string }> {
    await this.call<void>("agentPresetsCopy", args.agentPresetsCopy(id, id));
    return { id };
  }

  async removeAgentPreset(id: string): Promise<{ removed: true }> {
    await this.call<void>("agentPresetsDelete", args.agentPresetsDelete(id));
    return { removed: true };
  }

  settingsDescribe(): Promise<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }> {
    return this.call<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>(
      "settingsDescribe",
      args.settingsDescribe(),
    );
  }

  settingsUpdate(ns: string, patch: Record<string, unknown>): Promise<SettingsNamespaceView> {
    // 写过设置,某个 provider profile 的 apiKeyEnv 可能就变了(尤其 llm-pi-ai 那段
    // 是用户可编辑的 provider 表)—— 把 ref 表丢掉重建,免得拿旧映射去问凭据。
    this.refMap = undefined;
    // 模型目录同样随设置变(默认模型、provider 表、思考深度都在设置里),一起作废。
    this.catalog = undefined;
    return this.call<SettingsNamespaceView>("settingsUpdate", args.settingsUpdate(ns, patch));
  }

  /**
   * LLM 厂商列表。
   *
   * 用 `llm/listConfigurableProviders` 而**不是** `llm/listProviders`:
   * 后者只回 `{id, name}`(连 `active` 都没有),而 `LlmConfigurableProvider`
   * 的字段 `provider/displayName/settingsNs/settingsPath/declared`
   * 与插件要的 `LlmProviderView` 逐个一致。
   *
   * `active` 是 0.1.5 完全没有的概念(能配置的都可路由),所以统一给 `true`
   * —— `false` 的语义是「这条路由没启用」,而这里每一条都是能用的。
   */
  async llmProviders(): Promise<{ providers: LlmProviderView[] }> {
    const list = await this.call<
      { provider: string; displayName: string; settingsNs: string; settingsPath: readonly string[]; declared?: boolean }[]
    >("llmListConfiguredProviders", args.llmListConfiguredProviders());
    return {
      providers: (list ?? []).map((p) => ({
        provider: p.provider,
        displayName: p.displayName,
        settingsNs: p.settingsNs,
        settingsPath: [...(p.settingsPath ?? [])],
        active: true,
        ...(p.declared === undefined ? {} : { declared: p.declared }),
      })),
    };
  }

  /**
   * 模型分组。
   *
   * 0.1.5 把「有哪些模型」和「怎么发现模型」拆成了两件事:
   * `llm/discoverModels` 是**去问某个端点要模型列表**(要 settingsNs/baseURL/apiKey),
   * 不是列目录。真正的目录在 `session/modelCatalog`,而且它**本来就返回
   * `groups/failures`**(与这里要的形状逐个一致)—— 0.1.1 的 `llm.models` 只是它的别名。
   */
  async llmModels(): Promise<{ groups: LlmModelGroup[]; failures: { id: string; name: string; message: string }[] }> {
    const catalog = await this.call<Pick<ModelCatalogValue, "groups" | "failures">>(
      "sessionModelCatalog",
      args.sessionModelCatalog(),
    );
    return { groups: catalog.groups ?? [], failures: catalog.failures ?? [] };
  }

  private refMap: Map<string, string> | undefined;

  /**
   * provider → credential ref 的映射表,惰性构建 + 缓存。
   *
   * 构造失败**不抛错**:退化成「全表为空」,此时 `refOf()` 会退回纯推导。
   * 那样最坏是个别 provider 的徽标不准,而不是设置面板整块空掉 —— 拿不到表通常
   * 意味着 `llm/listConfigurableProviders` 或 `settings/describe` 也挂了,
   * 那种时刻更需要面板还能显示点什么。
   */
  private async providerRefMap(): Promise<Map<string, string>> {
    if (this.refMap !== undefined) return this.refMap;
    const map = new Map<string, string>();
    try {
      const [{ providers }, { namespaces }] = await Promise.all([this.llmProviders(), this.settingsDescribe()]);
      for (const [provider, ref] of buildProviderRefMap(providers, namespaces)) map.set(provider, ref);
    } catch (error) {
      this.opts.onLog?.(`[protocol] provider→credential ref 表构建失败,退回纯推导:${String(error)}`);
    }
    this.refMap = map;
    return map;
  }

  /**
   * 凭据状态。
   *
   * 两次翻译,缺一不可(见 `./credentials.ts`):进来的 provider id 要翻成
   * 0.1.5 认的 ref,回去的记录还要**再翻回 provider id** —— `settings.ts` 是按
   * `state.credentials[p.provider]` 渲染徽标的,直接把服务端的 `Record<ref, …>`
   * 抛上去,面板会静默显示成全员「未配置」。
   *
   * 分批是因为服务端 `MAX_DESCRIBE_REFS = 64` 且**整批校验**:超限或有一个名字
   * 不合语法,整批报 `gateway/bad-request`。本机 43 个 provider 够用,
   * 但别的用户装多了就会踩到,所以这里按 64 切。
   */
  async credentialsDescribe(providers: string[]): Promise<{ credentials: Record<string, CredentialInfoView> }> {
    const { refs, refByProvider } = splitRefs(providers, await this.providerRefMap());
    const byRef: Record<string, CredentialInfoView> = {};
    for (const batch of chunkRefs(refs)) {
      const part = await this.call<Record<string, CredentialInfoView>>(
        "credentialsDescribe",
        args.credentialsDescribe(batch),
      );
      Object.assign(byRef, part ?? {});
    }
    return { credentials: joinCredentials(providers, refByProvider, byRef) };
  }

  /** 写入也要翻译:0.1.5 的 ref 才是落盘键,provider id 写进去只会被语法拒掉。 */
  async credentialsSet(provider: string, value: string): Promise<{}> {
    await this.call<void>("credentialsSet", args.credentialsSet(refOf(await this.providerRefMap(), provider), value));
    return {};
  }

  async credentialsUnset(provider: string): Promise<{}> {
    await this.call<void>("credentialsUnset", args.credentialsUnset(refOf(await this.providerRefMap(), provider)));
    return {};
  }

  goalEdit(sessionId: string, ref: { id: string; revision: number }, objective?: string): Promise<unknown> {
    return this.call<unknown>("goalEdit", args.goalEdit(sessionId, ref, objective));
  }

  goalResume(sessionId: string, ref: { id: string; revision: number }): Promise<unknown> {
    return this.call<unknown>("goalResume", args.goalResume(sessionId, ref));
  }

  goalPause(sessionId: string, ref: { id: string; revision: number }): Promise<unknown> {
    return this.call<unknown>("goalPause", args.goalPause(sessionId, ref));
  }

  goalComplete(sessionId: string, ref: { id: string; revision: number }): Promise<unknown> {
    return this.call<unknown>("goalComplete", args.goalComplete(sessionId, ref));
  }

  /** 线上回 `GoalRef`,legacy 回 `{cleared:true}` —— 合成后者。 */
  async goalClear(sessionId: string, ref: { id: string; revision: number }): Promise<{ cleared: true }> {
    await this.call<unknown>("goalClear", args.goalClear(sessionId, ref));
    return { cleared: true };
  }

  listSkills(sessionId: string): Promise<{ skills: { name: string; description: string; whenToUse?: string; modelInvocable: boolean }[] }> {
    return this.call<{ skills: { name: string; description: string; whenToUse?: string; modelInvocable: boolean }[] }>(
      "skillsList",
      args.skillsList(sessionId),
    );
  }

  /** `SubagentListEntry` 与插件的 `SubagentEntry` 逐个字段一致,原样透传。 */
  listSubagents(parentSessionId: string): Promise<{ entries: SubagentEntry[]; parentAvailable: boolean }> {
    return this.call<{ entries: SubagentEntry[]; parentAvailable: boolean }>(
      "subagentsList",
      args.subagentsList(parentSessionId),
    );
  }

  /**
   * 子会话历史。
   *
   * 0.1.5 的 descriptor 表里**没有** `subagent/history`(只有
   * `subagents/list|prompt|interruptByParent`),子会话的日志要按**子会话地址**
   * 走 `session/follow`:`{kind:"subagent", parentSessionId, childSessionId, mode}`。
   *
   * 语义要对齐 legacy 的 `subagent.history` —— 那是个 unary,**拿一次就完**。
   * 所以这里读一次开局快照就关流,而且**不往主 store 派发任何帧**:子会话的事件
   * 不该混进主会话的转录里(legacy 也不混)。调用方(channel.ts 的 subagentPreview)
   * 只从返回值里捞最后一条 `assistant/message` 的文本。
   */
  subagentHistory(
    parentSessionId: string,
    childSessionId: string,
    mode: "one-shot" | "continuable",
  ): Promise<{ events: { event: { type: string; seq: number; time: number; data: any }; view?: unknown }[]; hasMore: boolean }> {
    return this.requireFollows("subagentHistory").snapshotOnce({
      kind: "subagent",
      parentSessionId,
      childSessionId,
      mode,
    });
  }
  // ---------- waterfall 应答(审批/提问) ----------

  /**
   * 审批应答。
   *
   * `frameRpcId` 在 modern 上就是 **eventId**(见 frames.ts 的说明):服务端按
   * `(clientId, eventId)` 定位那条未结算的 waterfall,少一个都不行,而且 clientId
   * 必须是**当前代**的 —— 每次重连都会换一个新的,缓存上一代的会被
   * `gateway/…` 直接拒掉(旧 client 已经从 `remoteEventClients` 里摘掉了)。
   *
   * 答完由 events.ts 负责撤卡片 —— 它先 await `$events/result` 拿到 `ok`,再发
   * `approval/resolved`。**不能等 `$events` 回推 cancel 来撤**:网关在结算前就把
   * 回答者从投递集合里摘掉了(`receiveRemoteEventResult`),我答的那条我自己收不到
   * cancel,只等它的话卡片会一直留在界面上(真机已复现)。发送失败则什么都不改,
   * 卡片留着让用户重试。
   */
  async respondApproval(
    _sessionId: string,
    _approvalId: string,
    outcome: "allowed-once" | "rejected",
    frameRpcId: string,
  ): Promise<{ accepted: boolean }> {
    const events = this.requireEvents("respondApproval");
    await events.answerApproval(frameRpcId, outcome);
    return { accepted: true };
  }

  /** 提问应答。答案形状与 0.1.5 的 `AskUserQuestionAnswer` 逐字段一致,不需要翻译。 */
  async respondQuestion(
    _sessionId: string,
    answer: QuestionAnswer["answer"],
    frameRpcId: string,
  ): Promise<{ accepted: boolean }> {
    const events = this.requireEvents("respondQuestion");
    await events.answerQuestion(frameRpcId, answer);
    return { accepted: true };
  }

  private requireEvents(method: string): RemoteEvents {
    this.ensureStreams();
    const events = this.events;
    if (events === undefined) {
      throw new DshApiError("protocol/not-ready", `modern 适配器尚未接到帧处理器,无法 ${method}()`);
    }
    return events;
  }

  respond(answer: ApprovalAnswer | QuestionAnswer, frameRpcId: string): Promise<{ accepted: boolean }> {
    // legacy 把两种应答合成一个入口(`POST /api/respond` 看载荷自己分派);
    // modern 是两个语义完全不同的载荷,所以这里替 legacy 的调用方分一次。
    return "approvalId" in answer
      ? this.respondApproval(answer.sessionId, answer.approvalId, answer.outcome, frameRpcId)
      : this.respondQuestion(answer.sessionId, answer.answer, frameRpcId);
  }

  dispose() {
    this.disposed = true;
    // 顺序要紧:先停逻辑流再停 transport —— 停流时要发 `cancel` 帧,那条帧得走
    // 还活着的 socket 出去(否则服务端会一直留着这几条 stream 直到连接超时)。
    // 会话跟随流排在最前:它们数量最多(每个打开过的会话一条)。
    this.follows?.stop();
    this.events?.stop();
    this.control?.stop();
    this.workspaces?.stop();
    this.follows = undefined;
    this.assistantStreams = undefined;
    this.events = undefined;
    this.control = undefined;
    this.workspaces = undefined;
    this.mux?.dispose();
    this.mux = undefined;
    this.muxOnFrame = undefined;
    this.hostOnFrame = undefined;
    this.onState = undefined;
  }
}
