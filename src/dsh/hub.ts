import { DshApiClient, DshApiError, type FrameEnvelope } from "./protocol/legacy";
import { createAdapter, type ProtocolSetting } from "./protocol";
import type { ProtocolAdapter, ProtocolKind } from "./protocol/types";
import { ServerManager } from "./serverManager";
import { SessionStore, type StoredSession } from "./sessionStore";
import type { HostFrame, MuxFrame, PromptContentBlock } from "./types";

export interface HubStatus {
  serverUp: boolean;
  serverStartedByUs: boolean;
  serverStarting: boolean;
  muxConnected: boolean;
  hostConnected: boolean;
  version?: string;
  provider?: string;
  model?: string;
  /** 实际选用的协议世代;适配器装好前为 undefined。 */
  protocol?: ProtocolKind;
  message?: string;
}

export interface HubDeps {
  url: string;
  command: string;
  autoStart: boolean;
  autoStartTimeoutSec: number;
  /** 启动服务器时的工作目录(懒取值,通常返回 VS Code 当前打开的文件夹)。 */
  cwd?: () => string | undefined;
  /** 新建会话时自动应用的推理强度(思考深度);留空使用模型默认。 */
  defaultReasoningEffort?: string;
  onStatus?: (status: HubStatus) => void;
  onNotice?: (message: string, kind: "info" | "warning" | "error") => void;
  /** 诊断日志(启动器解析 / 服务器进程状态),由宿主输出到日志通道。 */
  onLog?: (message: string) => void;
  /** 服务端的 stdout/stderr 追加到这个文件(懒取值);缺省则丢弃输出。 */
  logFile?: () => string | undefined;
  /** 强制协议世代;`auto`(缺省)走实测。 */
  protocol?: ProtocolSetting;
  /** 用户在设置里手填的 Cookie(排障兜底,优先级最高)。 */
  manualCookie?: string;
  /** 是否允许读 `<DSH_HOME>/.credentials.yaml` 派生 Cookie(缺省允许)。 */
  deriveAuthFromCredentials?: boolean;
  /** 翻译函数(vscode.l10n.t);hub 保持对 vscode 无依赖。 */
  t?: (key: string, args?: Record<string, string | number>) => string;
}

const HISTORY_PAGE_MESSAGES = 60;

/** 中枢:服务器 + API 客户端 + 会话存储的统一入口。 */
export class DshHub {
  readonly store = new SessionStore();
  readonly server: ServerManager;

  private clientImpl: ProtocolAdapter | undefined;
  private adapterKind: ProtocolKind | undefined;
  private adapterPromise: Promise<void> | undefined;

  /**
   * 当前协议适配器。
   *
   * 适配器装好**之前**访问会即建一个 legacy 客户端 —— 那正是 0.12.4 的行为,
   * 于是任何提前调用都不会崩,0.1.1 上也一切照旧。装配完成后这里换成实测选中的那个。
   */
  get client(): ProtocolAdapter {
    if (!this.clientImpl) {
      const legacy = new DshApiClient(this.deps.url);
      legacy.setFrameHandlers(this.frameHandlers);
      this.clientImpl = legacy;
    }
    return this.clientImpl;
  }

  /** 实际选用的协议世代;装配完成前为 undefined。 */
  get protocol(): ProtocolKind | undefined {
    return this.adapterKind;
  }

  private readonly frameHandlers = {
    onMuxFrame: (env: FrameEnvelope<MuxFrame>) => this.onMux(env),
    onHostFrame: (env: FrameEnvelope<HostFrame>) => this.onHost(env),
    onState: (which: "mux" | "host", state: "disconnected" | "connecting" | "connected") => {
      if (which === "mux") this.statusState.muxConnected = state === "connected";
      else this.statusState.hostConnected = state === "connected";
      this.emitStatus();
    },
  };

  private statusState: HubStatus = {
    serverUp: false,
    serverStartedByUs: false,
    serverStarting: false,
    muxConnected: false,
    hostConnected: false,
  };

  private readyPromise: Promise<{ ok: boolean; message?: string }> | undefined;
  private hostInfoPromise: Promise<void> | undefined;
  private statusListeners = new Set<(status: HubStatus) => void>();
  /** 本扩展拉起的服务端打印的启动令牌(0.1.5);外部启动的服务端取不到,只能走凭据派生。 */
  private launchToken: string | undefined;

  constructor(private readonly deps: HubDeps) {
    this.server = new ServerManager(
      {
        url: deps.url,
        command: deps.command,
        autoStart: deps.autoStart,
        timeoutSec: deps.autoStartTimeoutSec,
        cwd: deps.cwd,
        t: deps.t,
        onLog: deps.onLog,
        logFile: deps.logFile,
        // 0.1.5 的启动令牌由本扩展自己拉起的那个进程打印;留着备用,鉴权解析时优先用它。
        onLaunchToken: (token) => {
          this.launchToken = token;
          this.emitStatus();
        },
      },
      (s) => {
        this.statusState.serverUp = s.up;
        this.statusState.serverStartedByUs = s.startedByUs;
        this.statusState.serverStarting = s.starting;
        this.statusState.message = s.message;
        this.emitStatus();
      },
    );
  }

  /**
   * 装配协议适配器:解析鉴权 → 实测世代 → 换手。
   *
   * **只在服务端已确认在线后调用** —— 对着一台没起来的服务端探测,两个探针都只会超时,
   * 判据全废,而且会把 adapterPromise 钉死在错误的结果上。
   *
   * 幂等且并发共享同一 Promise;旧的 legacy 客户端(若有)先换手再释放,
   * 免得它的重连定时器又拉起一个新的。
   */
  private installAdapter(): Promise<void> {
    if (!this.adapterPromise) {
      this.adapterPromise = this.doInstallAdapter().catch((error) => {
        // 抛错不缓存结果:服务端可能还在启动途中,下一次 probe/ensureReady 值得重试。
        // 注意 createAdapter 自身几乎不抛(它把探测失败都收敛成「回落 legacy」),
        // 所以这条路径只在真正异常时生效。
        this.adapterPromise = undefined;
        this.deps.onLog?.(`[protocol] 适配器装配失败:${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return this.adapterPromise;
  }

  private async doInstallAdapter(): Promise<void> {
    const handle = await createAdapter(this.deps.url, {
      protocol: this.deps.protocol,
      launchToken: () => this.server.token ?? this.launchToken,
      // 服务端先开端口、后打印令牌,而这个适配器只解析一次鉴权 —— 晚到的令牌必须在这里
      // 等回来,否则「抓不到令牌就退回凭据派生」等于白抓。等待是有界的,且服务端不是
      // 本扩展拉起时会立刻返回(见 ServerManager.waitForToken)。
      waitForLaunchToken: (timeoutMs) => this.server.waitForToken(timeoutMs),
      manualCookie: this.deps.manualCookie,
      deriveFromCredentials: this.deps.deriveAuthFromCredentials,
      onLog: this.deps.onLog,
    });
    const previous = this.clientImpl;
    this.clientImpl = handle.adapter;
    this.adapterKind = handle.kind;
    this.statusState.protocol = handle.kind;
    previous?.dispose();
    handle.adapter.setFrameHandlers(this.frameHandlers);
    this.emitStatus();
  }

  get status(): HubStatus {
    return { ...this.statusState };
  }

  onStatus(listener: (status: HubStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus() {
    this.deps.onStatus?.({ ...this.statusState });
    for (const listener of this.statusListeners) {
      try {
        listener({ ...this.statusState });
      } catch (error) {
        console.error("[dsh] status listener threw:", error);
      }
    }
  }

  private onMux(env: FrameEnvelope<MuxFrame>) {
    this.store.handleMuxEnvelope(env);
  }

  private onHost(env: FrameEnvelope<HostFrame>) {
    this.store.handleHostFrame(env.frame);
  }

  /** 确保服务器 + 客户端 + 初始数据就绪(可并发调用,共享同一 Promise)。 */
  ensureReady(): Promise<{ ok: boolean; message?: string }> {
    if (!this.readyPromise) {
      this.readyPromise = this.doEnsureReady().finally(() => {
        this.readyPromise = undefined;
      });
    }
    return this.readyPromise;
  }

  /** 仅探测(不自动启动):服务器在线时刷新会话并选中最近会话。 */
  async probe(): Promise<boolean> {
    // 装配协议适配器**必须在确认服务端在线之后**:对着一台没起来的服务端探测,
    // 两个探针都只会超时,判据全废,还会把结果钉死在错误的一代上。
    if (await this.server.isUp()) await this.installAdapter();
    const describe = await this.client.ping();
    if (describe === undefined) {
      this.statusState.serverUp = false;
      this.emitStatus();
      return false;
    }
    this.statusState.serverUp = true;
    this.statusState.version = describe.version;
    this.statusState.provider = describe.provider;
    this.statusState.model = describe.model;
    this.emitStatus();
    await this.refreshSessions();
    if (!this.store.currentSessionId) {
      const latest = this.store.listSessions()[0];
      if (latest) this.store.selectSession(latest.sessionId);
    }
    return true;
  }

  private async doEnsureReady(): Promise<{ ok: boolean; message?: string }> {
    const ensured = await this.server.ensure();
    if (!ensured.up) {
      this.deps.onNotice?.(ensured.message ?? this.deps.t?.("hub.serverUnavailable") ?? "DSH server unavailable", "error");
      return { ok: false, message: ensured.message };
    }
    // 服务端已就绪:此时探测才有意义(启动令牌也已从 stdout 抓到)
    await this.installAdapter();
    const describe = await this.client.ping();
    if (describe === undefined) {
      const msg = this.deps.t?.("hub.serverNoResponse", { url: this.deps.url }) ?? `DSH server at ${this.deps.url} is not responding`;
      this.deps.onNotice?.(msg, "error");
      return { ok: false, message: msg };
    }
    this.statusState.version = describe.version;
    this.statusState.provider = describe.provider;
    this.statusState.model = describe.model;
    this.emitStatus();
    await this.refreshSessions();
    // 默认选中最近会话(不自动加载历史,打开面板时再加载)
    if (!this.store.currentSessionId) {
      const latest = this.store.listSessions()[0];
      if (latest) this.store.selectSession(latest.sessionId);
    }
    return { ok: true };
  }

  /** 刷新会话列表(合并 host 帧之外的信息:标题、running、更新顺序)。 */
  async refreshSessions() {
    try {
      const { items } = await this.client.listSessions();
      let changed = false;
      for (const item of items) {
        const existing = this.store.sessions.get(item.sessionId);
        const next: StoredSession = {
          sessionId: item.sessionId,
          title: item.projections?.values?.title ?? existing?.title,
          running: item.running,
          blank: item.blank,
          cwd: item.cwd ?? existing?.cwd,
          agentPreset: item.agentPreset ?? existing?.agentPreset,
          parentSessionId: item.parentSessionId,
          origin: item.origin,
          updatedAt: item.updatedAt,
        };
        const prev = this.store.sessions.get(item.sessionId);
        if (!prev || prev.title !== next.title || prev.running !== next.running || prev.updatedAt !== next.updatedAt) {
          this.store.sessions.set(item.sessionId, next);
          changed = true;
        }
        const goal = item.projections?.values?.goal;
        if (goal !== undefined) this.store.applyGoal(item.sessionId, goal);
        const context = item.projections?.values?.contextPressure;
        if (context !== undefined) this.store.applyContext(item.sessionId, context);
        const permissions = item.projections?.values?.permissions;
        if (permissions !== undefined) this.store.applyPermissions(item.sessionId, permissions);
        const todos = item.projections?.values?.todos;
        if (todos !== undefined) this.store.applyTodos(item.sessionId, todos);
        const sessionStats = item.projections?.values?.sessionStats;
        const tokenUsage = item.projections?.values?.tokenUsage;
        if (sessionStats != null || tokenUsage != null) {
          const current = { ...(this.store.stats.get(item.sessionId) ?? {}) };
          if (sessionStats !== undefined) current.sessionStats = sessionStats;
          if (tokenUsage !== undefined) current.tokenUsage = tokenUsage;
          this.store.emitStats(item.sessionId, current);
        }
      }
      if (changed) {
        // 通知会话列表变化(通过伪造帧路径之外,直接派发)
        this.notifySessionsChanged();
      }
      return items;
    } catch (error) {
      console.error("[dsh] refreshSessions failed:", error);
      return [];
    }
  }

  private notifySessionsChanged() {
    this.store.notifySessionsChanged();
  }

  /** 已回填过历史的会话(实时流事件进 store 后,不再用 events 数量误判"已有历史")。 */
  private readonly historyLoaded = new Set<string>();

  /** 打开会话并回填历史。 */
  async openSession(sessionId: string) {
    this.store.selectSession(sessionId);
    await this.ensureHistory(sessionId);
  }

  /**
   * 回填会话历史:每个会话首次打开时拉一次(sessionHistory 与实时流事件按 seq 合并,只填缺口)。
   * 不能用 eventsFor().length 判断——mux 全局流会把其它入口(如 Web 端)会话的实时 chunk
   * 事件写进 store,若因此跳过加载,聊天区只剩过滤后的零星事件(表现为"看不到历史")。
   */
  async ensureHistory(sessionId: string) {
    if (this.historyLoaded.has(sessionId)) return;
    this.historyLoaded.add(sessionId);
    try {
      const { events, hasMore } = await this.client.sessionHistory({ sessionId, maxMessages: HISTORY_PAGE_MESSAGES });
      this.store.mergeHistory(sessionId, events.map((e) => ({ event: e.event, view: e.view })));
      this.store.historyHasMore.set(sessionId, hasMore);
    } catch (error) {
      // 失败允许下次重试
      this.historyLoaded.delete(sessionId);
      console.error("[dsh] history load failed:", error);
    }
  }

  /** 向前翻页加载更早的历史。 */
  async loadMoreHistory(sessionId: string): Promise<{ hasMore: boolean }> {
    if (this.store.isHistoryLoading(sessionId)) return { hasMore: true };
    const beforeSeq = this.store.historyBeforeSeq(sessionId);
    if (beforeSeq === undefined) {
      await this.ensureHistory(sessionId);
      return { hasMore: this.store.historyHasMore.get(sessionId) ?? false };
    }
    this.store.setHistoryLoading(sessionId, true);
    try {
      const { events, hasMore } = await this.client.sessionHistory({ sessionId, beforeSeq, maxMessages: HISTORY_PAGE_MESSAGES });
      this.store.mergeHistory(sessionId, events.map((e) => ({ event: e.event, view: e.view })));
      this.store.historyHasMore.set(sessionId, hasMore);
      return { hasMore };
    } catch (error) {
      console.error("[dsh] history page failed:", error);
      return { hasMore: true };
    } finally {
      this.store.setHistoryLoading(sessionId, false);
    }
  }

  /** 工作区列表(侧边栏按工作区分组会话)。 */
  /**
   * 工作区列表。顺带把归档集合灌进 store —— 两个协议的这次调用都带 `archivedSessionIds`
   * (0.1.1 的 `workspace.list`、0.1.5 的 `workspace/follow` baseline),而侧边栏得靠它
   * 把归档会话减掉,否则「归档」这个动作在插件里完全没有效果(见 SessionStore.archivedSessionIds)。
   */
  async listWorkspaces() {
    const value = await this.client.listWorkspaces();
    // 只在**真的带了这个字段**时才写。原来的 `?? []` 把「这次没带」当成「归档集是空的」,
    // 于是侧边栏刚把归档会话减掉,下一次 pushWorkspaces() 又整体放回来 —— 表现为归档过滤
    // 忽灵忽不灵。本文件其它可选投影都是 `if (x !== undefined)` 的写法,这里对齐。
    if (value.archivedSessionIds !== undefined) this.store.setArchivedSessions(value.archivedSessionIds);
    return value;
  }

  /**
   * 在当前 VS Code 文件夹下创建会话:先采纳该目录为工作区(幂等,
   * 以前打开过则进入已有分组,从未打开过则自动建立新分组),再以工作区创建会话。
   * 用 workspaceId 创建(而非 cwd)会让会话自动挂入工作区并继承工作区路径,
   * Web 端的工作区里即可看到该对话(双向同步)。
   */
  async createSessionForFolder(cwd?: string, agentPreset?: string): Promise<string> {
    if (cwd) {
      const workspaceId = await this.adoptWorkspace(cwd);
      if (workspaceId) {
        try {
          const { sessionId } = await this.client.createSession({ workspaceId, ...(agentPreset ? { agentPreset } : {}) });
          await this.refreshSessions();
          this.store.selectSession(sessionId);
          await this.ensureHistory(sessionId);
          return sessionId;
        } catch {
          // 工作区创建失败时回退到 cwd 方式
        }
      }
    }
    return this.createSession(cwd, agentPreset);
  }

  async createSession(cwd?: string, agentPreset?: string): Promise<string> {
    const { sessionId } = await this.client.createSession({ ...(cwd ? { cwd } : {}), ...(agentPreset ? { agentPreset } : {}) });
    await this.refreshSessions();
    this.store.selectSession(sessionId);
    // 新会话也必须过一次 ensureHistory,原因见 ensureHistory 的注释:**0.1.5 没有全局
    // 事件流**,这个会话的实时事件只走 `session/follow`,而开那条流的正是
    // `client.sessionHistory()`。少了这一步,新建会话发出去的消息收不到任何回包 ——
    // 界面上表现为「发出去了,一直转圈」,而服务端其实早就答完了。
    // (0.1.1 有全局 events.mux,不会犯这个病;多打一次空历史的 RPC 无害且幂等。)
    await this.ensureHistory(sessionId);
    return sessionId;
  }

  /** 把目录采纳为 DSH 工作区(先确保服务器就绪;幂等,重复调用返回已存在的工作区)。返回 workspaceId。 */
  async adoptWorkspace(path: string): Promise<string | undefined> {
    if (!path) return undefined;
    const ready = await this.ensureReady();
    if (!ready.ok) return undefined;
    try {
      const { workspace } = await this.client.adoptWorkspace(path);
      return workspace.workspaceId;
    } catch (error) {
      this.deps.onLog?.(`[workspace] 采纳工作区失败 ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * 历史会话无法补挂工作区:服务端只在 session.create/fork 带 workspaceId 时 attach 会话,
   * 没有公开的补挂 RPC(workspace.insertSessionBefore 要求会话已 account,对旧会话报
   * workspace-move-invalid)。旧会话在 Web 端左侧显示于「未分组」——这是官方设计限制。
   * 新会话由 createSessionForFolder 用 workspaceId 创建,自动挂入工作区。
   */
  async attachSessionToWorkspace(_sessionId: string) {
    // 保留空实现:调用方(打开会话时)语义为「确认归属」,实际挂入仅发生在创建时
  }

  async send(sessionId: string, text: string, mode: "queue" | "steer" = "queue") {
    return this.sendContent(sessionId, [{ type: "text", text }], mode);
  }

  /** 发送多块内容(文本 + 图片,与 Web 端同协议;图片为 base64 data)。 */
  async sendContent(sessionId: string, content: PromptContentBlock[], mode: "queue" | "steer" = "queue") {
    try {
      await this.client.sendPrompt({ sessionId, mode, content });
    } catch (error) {
      const message = error instanceof DshApiError ? `${error.code}: ${error.message}` : String(error);
      this.deps.onNotice?.(this.deps.t?.("hub.sendFailed", { message }) ?? `Send failed: ${message}`, "error");
      throw error;
    }
  }

  async cancel(sessionId: string) {
    try {
      await this.client.cancelSession(sessionId);
    } catch (error) {
      console.error("[dsh] cancel failed:", error);
    }
  }

  /** 宿主执行斜杠命令(/permission、/plan、/compact 等),与 Web 端同通道,不经 agent。 */
  async runCommand(sessionId: string, line: string): Promise<string | undefined> {
    const { result } = await this.client.executeCommand(sessionId, line);
    if (result.kind === "error") {
      this.deps.onNotice?.(this.deps.t?.("hub.commandFailed", { line, message: result.text ?? "" }) ?? `Command failed: ${line}`, "error");
      throw new Error(result.text ?? `command failed: ${line}`);
    }
    return result.text;
  }

  async respondApproval(sessionId: string, approvalId: string, outcome: "allowed-once" | "rejected") {
    const pending = this.store.pendingApprovals.get(approvalId);
    if (!pending) {
      this.deps.onNotice?.(this.deps.t?.("hub.approvalGone") ?? "The approval is no longer pending", "warning");
      return;
    }
    try {
      await this.client.respondApproval(sessionId, approvalId, outcome, pending.frameRpcId);
      this.store.pendingApprovals.delete(approvalId);
    } catch (error) {
      this.deps.onNotice?.(this.deps.t?.("hub.approvalFailed", { error: String(error) }) ?? `Respond to approval failed: ${String(error)}`, "error");
    }
  }

  async respondQuestion(sessionId: string, frameRpcId: string, answers: { id: string; selected: string[]; custom?: string }[]) {
    const pending = this.store.pendingQuestions.get(frameRpcId);
    if (!pending) {
      this.deps.onNotice?.(this.deps.t?.("hub.questionGone") ?? "The question is no longer pending", "warning");
      return;
    }
    try {
      await this.client.respondQuestion(sessionId, { answers }, frameRpcId);
      this.store.pendingQuestions.delete(frameRpcId);
    } catch (error) {
      this.deps.onNotice?.(this.deps.t?.("hub.questionFailed", { error: String(error) }) ?? `Answer question failed: ${String(error)}`, "error");
    }
  }

  // ---------- 模型 / 预设 / 思考深度 ----------

  getSessionModels(sessionId: string) {
    return this.client.sessionModels(sessionId);
  }

  /** 读取会话当前模型并同步到状态栏(host.describe 只提供默认模型)。 */
  async updateCurrentModel(sessionId: string) {
    try {
      const models = await this.client.sessionModels(sessionId);
      this.statusState.model = models.current.model;
      this.statusState.provider = models.current.provider;
      this.emitStatus();
    } catch {
      // 忽略:状态栏保持原值
    }
  }

  selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string) {
    return this.client.selectModel(sessionId, provider, model, reasoningEffort);
  }

  listPresets() {
    return this.client.listAgentPresets();
  }

  async selectPreset(sessionId: string, agentPreset: string) {
    const result = await this.client.selectAgentPreset(sessionId, agentPreset);
    await this.refreshSessions();
    return result;
  }

  // ---------- 会话管理:重命名 / 分叉 / 归档 ----------

  renameSession(sessionId: string, title: string) {
    return this.client.renameSession(sessionId, title);
  }

  async forkSession(sessionId: string, atSeq?: number): Promise<string> {
    const { sessionId: forked } = await this.client.forkSession(sessionId, atSeq);
    await this.refreshSessions();
    return forked;
  }

  async archiveSession(sessionId: string) {
    const result = await this.client.archiveSession(sessionId);
    await this.refreshSessions();
    return result;
  }

  // ---------- goal ----------

  async completeGoal(sessionId: string, ref: { id: string; revision: number }) {
    const result = await this.client.goalComplete(sessionId, ref);
    await this.refreshSessions();
    return result;
  }

  async editGoal(sessionId: string, ref: { id: string; revision: number }, objective?: string) {
    const result = await this.client.goalEdit(sessionId, ref, objective);
    await this.refreshSessions();
    return result;
  }

  async resumeGoal(sessionId: string, ref: { id: string; revision: number }) {
    const result = await this.client.goalResume(sessionId, ref);
    await this.refreshSessions();
    return result;
  }

  async pauseGoal(sessionId: string, ref: { id: string; revision: number }) {
    const result = await this.client.goalPause(sessionId, ref);
    await this.refreshSessions();
    return result;
  }

  async clearGoal(sessionId: string, ref: { id: string; revision: number }) {
    const result = await this.client.goalClear(sessionId, ref);
    await this.refreshSessions();
    return result;
  }

  // ---------- 技能 / 子代理 ----------

  getSkills(sessionId: string) {
    return this.client.listSkills(sessionId);
  }

  listSubagents(sessionId: string) {
    return this.client.listSubagents(sessionId);
  }

  subagentHistory(sessionId: string, childSessionId: string, mode: "one-shot" | "continuable") {
    return this.client.subagentHistory(sessionId, childSessionId, mode);
  }

  /** 新建会话后,若配置了默认思考深度且当前模型支持,则自动应用。 */
  async applyDefaultReasoningEffort(sessionId: string): Promise<void> {
    const configured = this.deps.defaultReasoningEffort?.trim();
    if (!configured) return;
    try {
      const models = await this.client.sessionModels(sessionId);
      const group = models.groups.find((g) => g.id === models.current.provider);
      const model = group?.models.find((m) => m.id === models.current.model);
      if (model?.reasoning?.efforts.some((e) => e.id === configured)) {
        await this.client.selectModel(sessionId, models.current.provider, models.current.model, configured);
      }
    } catch (error) {
      console.error("[dsh] applyDefaultReasoningEffort failed:", error);
    }
  }

  /** 等待会话空闲下来(以 turn/end 或非运行态为准),用于参与者。 */
  waitIdle(sessionId: string, token?: { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): { dispose(): void } }): Promise<void> {
    return new Promise((resolve) => {
      const dispose: (() => void)[] = [];
      const finish = () => {
        for (const d of dispose) d();
        resolve();
      };
      dispose.push(
        this.store.on("turnEnd", (sid: string) => {
          if (sid === sessionId) finish();
        }),
        this.store.on("agentError", (sid: string) => {
          if (sid === sessionId) finish();
        }),
      );
      if (token) {
        const disposable = token.onCancellationRequested(() => finish());
        dispose.push(() => disposable.dispose());
      }
      // 兜底:若会话本就不在运行(例如 prompt 被拒绝或只是排队指令),延迟确认后返回
      const current = this.store.sessions.get(sessionId);
      if (current && !current.running) {
        setTimeout(() => {
          const s = this.store.sessions.get(sessionId);
          if (s && !s.running) finish();
        }, 1500);
      }
    });
  }

  dispose() {
    // 用可选链:从未访问过 client 时不该为了释放而现造一个 legacy 客户端。
    this.clientImpl?.dispose();
    this.clientImpl = undefined;
  }
}
