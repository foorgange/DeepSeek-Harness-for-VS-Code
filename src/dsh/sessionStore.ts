import type {
  AskUserQuestionItem,
  HostFrame,
  JobView,
  MuxFrame,
  QueueItem,
  SessionEvent,
  SessionSummary,
  ToolEventView,
} from "./types";

export interface StoredSession {
  sessionId: string;
  title?: string;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  parentSessionId?: string;
  origin?: "subagent";
  updatedAt: number;
}

export interface PendingApproval {
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  frameRpcId: string;
}

export interface PendingQuestion {
  sessionId: string;
  frameRpcId: string;
  questions: AskUserQuestionItem[];
}

export interface StoredEvent {
  event: SessionEvent;
  view?: ToolEventView;
}

type Listener = (...args: any[]) => void;

/**
 * 会话与事件的进程内存储:消费 mux/host 帧,向 UI/参与者分发增量。
 * 事件按 seq 去重;历史通过 session.history 回填。
 */
/** 投影值相等判断(JSON 序列化比较;投影值均为小对象/数组,开销可忽略)。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export class SessionStore {
  readonly sessions = new Map<string, StoredSession>();
  /** sessionId → seq → event */
  readonly events = new Map<string, Map<number, StoredEvent>>();
  readonly maxSeq = new Map<string, number>();
  readonly pendingApprovals = new Map<string, PendingApproval>(); // key: approvalId
  readonly pendingQuestions = new Map<string, PendingQuestion>(); // key: frameRpcId
  readonly queues = new Map<string, QueueItem[]>();
  readonly jobs = new Map<string, JobView[]>();
  /** 会话的目标状态(session.list / session/projection 帧的 goal 投影) */
  readonly goals = new Map<string, unknown>();
  /** 上下文压力(contextPressure 投影) */
  readonly context = new Map<string, { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }>();
  /** 权限预设(permissions 投影) */
  readonly permissions = new Map<string, { options: { value: string; name: string; description?: string }[]; currentValue: string }>();
  /** 会话统计(sessionStats / tokenUsage 投影) */
  readonly stats = new Map<string, { sessionStats?: unknown; tokenUsage?: unknown }>();
  /** 待办事项(todos 投影,每回合重置) */
  readonly todos = new Map<string, { content: string; status: "pending" | "in_progress" | "completed" }[] | null>();
  /** 每个会话是否还有更早的历史可加载(session.history 分页) */
  readonly historyHasMore = new Map<string, boolean>();
  /** 最近活跃会话(用于面板默认选择) */
  currentSessionId: string | undefined;
  lastTurnBySession = new Map<string, number>();
  /**
   * 归档会话集合 —— 归档在 dsh 里**不删除会话、也不从 `session.list` 里剔除**
   * (0.1.5 连删除 API 都没有),它只是服务端 registry 上的一个集合。官方 Web UI
   * 自己拿这个集合去减列表,所以这里也必须自己减,否则「归档」在插件里**毫无效果**:
   * 会话照旧挂在侧边栏,而且永远清不掉。
   *
   * 这是**双协议共有的缺陷**,不是 0.1.5 移植带来的:legacy 的 `workspace.list`
   * 一直回 `archivedSessionIds`,而 `host/archived-sessions-changed` 帧两个协议都在发
   * —— 只是 `handleHostFrame` 把它和另外三个 workspace 帧一起整条忽略了。
   */
  readonly archivedSessionIds = new Set<string>();

  private listeners = new Map<string, Set<Listener>>();
  private historyLoading = new Set<string>();

  // ---------- 事件订阅 ----------

  on(name: "sessionEvent", fn: (sessionId: string, stored: StoredEvent) => void): () => void;
  on(name: "sessionsChanged", fn: (sessions: StoredSession[]) => void): () => void;
  on(name: "approval", fn: (approval: PendingApproval) => void): () => void;
  on(name: "approvalResolved", fn: (approvalId: string, outcome: string) => void): () => void;
  on(name: "question", fn: (question: PendingQuestion) => void): () => void;
  on(name: "questionResolved", fn: (frameRpcId: string) => void): () => void;
  on(name: "queue", fn: (sessionId: string, items: QueueItem[]) => void): () => void;
  on(name: "running", fn: (sessionId: string, running: boolean) => void): () => void;
  on(name: "turnEnd", fn: (sessionId: string, turn: number) => void): () => void;
  on(name: "agentError", fn: (sessionId: string, message: string) => void): () => void;
  on(name: "goal", fn: (sessionId: string, value: unknown) => void): () => void;
  on(name: "context", fn: (sessionId: string, value: unknown) => void): () => void;
  on(name: "permissions", fn: (sessionId: string, value: unknown) => void): () => void;
  on(name: "stats", fn: (sessionId: string, value: unknown) => void): () => void;
  on(name: "todos", fn: (sessionId: string, value: unknown) => void): () => void;
  on(name: "currentChanged", fn: (sessionId: string | undefined) => void): () => void;
  on(name: string, fn: Listener): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  private emit(name: string, ...args: any[]) {
    for (const fn of this.listeners.get(name) ?? []) {
      try {
        fn(...args);
      } catch (error) {
        console.error(`[dsh] listener for "${name}" threw:`, error);
      }
    }
  }

  /** 通知会话列表已变化(供外部刷新调用)。 */
  /** session.list 刷新写入统计后通知订阅者(触发 webview 实时渲染)。 */
  /** 记录会话统计并通知(值未变不推送,避免 5s 轮询全量重建统计行)。 */
  emitStats(sessionId: string, value: unknown) {
    if (sameValue(this.stats.get(sessionId), value)) return;
    this.stats.set(sessionId, value as { sessionStats?: unknown; tokenUsage?: unknown });
    this.emit("stats", sessionId, value);
  }

  notifySessionsChanged() {
    this.emit("sessionsChanged", this.listSessions());
  }

  // ---------- 帧消费 ----------

  handleMuxFrame(frame: MuxFrame) {
    switch (frame.type) {
      case "session/event":
        this.addEvent(frame.sessionId, frame.event, frame.view);
        break;
      case "session/subscribed":
        if (!this.maxSeq.has(frame.sessionId)) this.maxSeq.set(frame.sessionId, frame.lastSeq);
        break;
      // 注:approval/question 四类帧由 handleMuxEnvelope 统一处理(需要 frameRpcId),这里不再重复
      case "session/queue":
        this.queues.set(frame.sessionId, frame.items);
        this.emit("queue", frame.sessionId, frame.items);
        break;
      case "session/jobs":
        this.jobs.set(frame.sessionId, frame.jobs);
        break;
      case "session/projection":
        this.applyProjection(frame.sessionId, frame.key, frame.value);
        break;
      case "stream/error":
        console.error("[dsh] mux stream error:", frame.error);
        break;
    }
  }

  /** 携带 rpcId 的帧入口(approval/question 需要 frameRpcId 来回应)。 */
  handleMuxEnvelope(env: { rpcId: string; frame: MuxFrame }) {
    const { rpcId, frame } = env;
    if (frame.type === "approval/requested") {
      this.pendingApprovals.set(frame.approvalId, { ...frame, frameRpcId: rpcId });
      this.emit("approval", this.pendingApprovals.get(frame.approvalId));
    } else if (frame.type === "approval/resolved") {
      this.pendingApprovals.delete(frame.approvalId);
      this.emit("approvalResolved", frame.approvalId, frame.outcome);
    } else if (frame.type === "question/requested") {
      this.pendingQuestions.set(rpcId, { sessionId: frame.sessionId, frameRpcId: rpcId, questions: frame.questions });
      this.emit("question", this.pendingQuestions.get(rpcId));
    } else if (frame.type === "question/resolved") {
      this.pendingQuestions.delete(frame.questionRpcId);
      this.emit("questionResolved", frame.questionRpcId);
    } else {
      this.handleMuxFrame(frame);
    }
  }

  handleHostFrame(frame: HostFrame) {
    switch (frame.type) {
      case "host/session-added": {
        const existing = this.sessions.get(frame.sessionId);
        if (!existing) {
          this.sessions.set(frame.sessionId, {
            sessionId: frame.sessionId,
            running: false,
            blank: frame.blank,
            cwd: frame.cwd,
            agentPreset: frame.agentPreset,
            parentSessionId: frame.parentSessionId,
            origin: frame.origin,
            updatedAt: Date.now(),
          });
          this.emit("sessionsChanged", this.listSessions());
        }
        break;
      }
      case "host/session-removed":
        this.sessions.delete(frame.sessionId);
        this.emit("sessionsChanged", this.listSessions());
        break;
      case "host/session-status": {
        const s = this.sessions.get(frame.sessionId);
        if (s) {
          s.running = frame.running;
          this.emit("running", frame.sessionId, frame.running);
        }
        break;
      }
      case "host/agent-error": {
        const s = this.sessions.get(frame.sessionId);
        if (s) s.running = false;
        this.emit("agentError", frame.sessionId, frame.message);
        // 同步 running 状态,避免界面一直停在"运行中"
        this.emit("running", frame.sessionId, false);
        break;
      }
      case "host/remote-event":
      case "host/workspace-changed":
      case "host/workspace-removed":
      case "host/workspace-order-changed":
        break;
      case "host/archived-sessions-changed":
        this.setArchivedSessions(frame.archivedSessionIds);
        break;
      case "stream/error":
        console.error("[dsh] host stream error:", frame.error);
        break;
    }
  }

  // ---------- 事件存储 ----------

  private addEvent(sessionId: string, event: SessionEvent, view?: ToolEventView) {
    let bySeq = this.events.get(sessionId);
    if (!bySeq) this.events.set(sessionId, (bySeq = new Map()));
    const prevMax = this.maxSeq.get(sessionId) ?? -1;
    if (bySeq.has(event.seq)) return;
    bySeq.set(event.seq, { event, view });
    if (event.seq > prevMax) this.maxSeq.set(sessionId, event.seq);

    const stored: StoredEvent = { event, view };
    this.emit("sessionEvent", sessionId, stored);

    const s = this.sessions.get(sessionId);
    if (s) s.updatedAt = event.time;

    switch (event.type) {
      case "turn/start":
        if (s) {
          s.running = true;
          this.emit("running", sessionId, true);
        }
        break;
      case "turn/end":
        if (s) {
          s.running = false;
          this.emit("running", sessionId, false);
        }
        this.lastTurnBySession.set(sessionId, event.data?.turn ?? 0);
        this.emit("turnEnd", sessionId, event.data?.turn ?? 0);
        break;
      case "user/message":
        if (!s?.blank && !this.currentSessionId) this.currentSessionId = sessionId;
        break;
    }
  }

  private applyProjection(sessionId: string, key: string, value: unknown) {
    const s = this.sessions.get(sessionId);
    if (key === "title" && typeof value === "string" && value) {
      if (s) {
        s.title = value;
        this.emit("sessionsChanged", this.listSessions());
      }
      return;
    }
    if (key === "goal") {
      this.applyGoal(sessionId, value);
      return;
    }
    if (key === "contextPressure") {
      this.applyContext(sessionId, value);
      return;
    }
    if (key === "permissions") {
      this.applyPermissions(sessionId, value);
      return;
    }
    if (key === "sessionStats" || key === "tokenUsage") {
      // 空投影(null/undefined)不覆盖已有统计(回合开始时的重置帧不应清空界面)
      if (value == null) return;
      const current = { ...(this.stats.get(sessionId) ?? {}) };
      current[key === "sessionStats" ? "sessionStats" : "tokenUsage"] = value;
      this.emitStats(sessionId, current);
      return;
    }
    if (key === "todos") {
      this.applyTodos(sessionId, value);
    }
  }

  /** 记录会话的 goal 投影并通知(值未变不推送,避免 5s 轮询全量重建 DOM)。 */
  applyGoal(sessionId: string, value: unknown) {
    if (sameValue(this.goals.get(sessionId), value)) return;
    this.goals.set(sessionId, value);
    this.emit("goal", sessionId, value);
  }

  /** 记录会话的 contextPressure 投影并通知。 */
  applyContext(sessionId: string, value: unknown) {
    if (sameValue(this.context.get(sessionId), value)) return;
    this.context.set(sessionId, value as { pressureTokens?: number; projectedTokens?: number; contextWindow?: number });
    this.emit("context", sessionId, value);
  }

  /** 记录会话的 permissions 投影并通知。 */
  applyPermissions(sessionId: string, value: unknown) {
    if (sameValue(this.permissions.get(sessionId), value)) return;
    this.permissions.set(sessionId, value as { options: { value: string; name: string }[]; currentValue: string });
    this.emit("permissions", sessionId, value);
  }

  /** 记录会话的 todos 投影并通知(轮询刷新路径,与 mux 帧路径一致地推送)。 */
  applyTodos(sessionId: string, value: unknown) {
    if (sameValue(this.todos.get(sessionId), value)) return;
    this.todos.set(sessionId, value as { content: string; status: "pending" | "in_progress" | "completed" }[] | null);
    this.emit("todos", sessionId, value);
  }

  // ---------- 查询 ----------

  /**
   * 替换归档集合。服务端给的每次都是**完整集合**(不是增量),所以这里整体替换。
   *
   * 值没变就不通知:重连时 `workspace/follow` / `workspace.list` 会重发一份一模一样的
   * baseline,每次都通知会让侧边栏无谓重绘一遍。
   */
  setArchivedSessions(ids: readonly string[]) {
    const next = new Set(ids);
    if (next.size === this.archivedSessionIds.size && [...next].every((id) => this.archivedSessionIds.has(id))) {
      return;
    }
    this.archivedSessionIds.clear();
    for (const id of next) this.archivedSessionIds.add(id);
    this.emit("sessionsChanged", this.listSessions());
  }

  /**
   * 会话列表,**已排除归档会话**。
   *
   * 归档会话仍然留在 `sessions` 里(正在看的那条要继续渲染、事件要继续进 store),
   * 只是不再出现在列表里 —— 这正是官方 Web UI 的做法。
   */
  listSessions(): StoredSession[] {
    return [...this.sessions.values()]
      .filter((s) => !this.archivedSessionIds.has(s.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  eventsFor(sessionId: string): StoredEvent[] {
    const bySeq = this.events.get(sessionId);
    if (!bySeq) return [];
    return [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq);
  }

  /** 合并历史事件(仅填充缺口)。 */
  mergeHistory(sessionId: string, stored: StoredEvent[]) {
    let bySeq = this.events.get(sessionId);
    if (!bySeq) this.events.set(sessionId, (bySeq = new Map()));
    let max = this.maxSeq.get(sessionId) ?? -1;
    let added = 0;
    for (const item of stored) {
      if (bySeq.has(item.event.seq)) continue;
      bySeq.set(item.event.seq, item);
      if (item.event.seq > max) max = item.event.seq;
      added++;
    }
    this.maxSeq.set(sessionId, max);
    return added;
  }

  /**
   * 获取下一个回填起点(最老的已知 seq;未知则 undefined)。
   *
   * **必须取整**,而且用的是 `ceil` 而不是 `floor`。modern 的 `seq` 可能是**小数**
   * —— 流式增量不是持久事件,它的 seq 是按「持久游标 + 小数部分」铸造出来的
   * (见 protocol/modern/assistant.ts),好插在同一条消息的持久事件之间。
   * 而 `session/page` 的 `beforeSeq` 只接受非负安全整数:
   *
   *     if (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))
   *       throw new RemoteError("gateway/bad-request", "beforeSeq must be a non-negative safe integer")
   *     —— dsh-api-session-controller/lib/index.js:1567
   *
   * 传小数是**硬报错**,表现是「加载更早」整块失灵(还不带任何提示)。
   *
   * 为什么是 `ceil`:最老的事件若是 `7.5`(一条流式增量),它下面那条整数事件 `7`
   * 未必在我们手里(快照窗口是按「消息」切的,可能正好裁在它前面),而 `beforeSeq`
   * 是**排他上界** —— `ceil(7.5) = 8` 会把 `7` 一起取回来,`floor(7.5) = 7` 则会
   * 漏掉它。最老的事件是整数时两者相等。
   *
   * `+ 0` 是为了把 `Math.ceil(-0.4)` 产生的 `-0` 归一成 `+0`:校验器用
   * `Object.is(x, -0)` 专门拒 `-0`,而 `-0` 在别处和 `0` 完全等价,是个只在这里
   * 才会现形的坑。
   */
  historyBeforeSeq(sessionId: string): number | undefined {
    const bySeq = this.events.get(sessionId);
    if (!bySeq || bySeq.size === 0) return undefined;
    return Math.ceil(Math.min(...bySeq.keys())) + 0;
  }

  isHistoryLoading(sessionId: string): boolean {
    return this.historyLoading.has(sessionId);
  }

  setHistoryLoading(sessionId: string, loading: boolean) {
    if (loading) this.historyLoading.add(sessionId);
    else this.historyLoading.delete(sessionId);
  }

  selectSession(sessionId: string | undefined) {
    this.currentSessionId = sessionId;
    this.emit("currentChanged", sessionId);
  }

  clear() {
    this.sessions.clear();
    this.events.clear();
    this.maxSeq.clear();
    this.pendingApprovals.clear();
    this.pendingQuestions.clear();
    this.queues.clear();
    this.jobs.clear();
    this.goals.clear();
    this.context.clear();
    this.permissions.clear();
    this.stats.clear();
    this.todos.clear();
    this.historyHasMore.clear();
    this.currentSessionId = undefined;
  }
}
