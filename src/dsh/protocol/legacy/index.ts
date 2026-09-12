import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type {
  AgentPresetListValue,
  ClientRequest,
  HostFrame,
  HostDescribeValue,
  LlmModelGroup,
  LlmProviderView,
  MuxFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionHistoryRequest,
  SessionHistoryValue,
  SessionListValue,
  SessionModelsValue,
  SessionPromptRequest,
  SessionPromptValue,
  SettingsNamespaceView,
  ApprovalAnswer,
  QuestionAnswer,
  SubagentEntry,
} from "../../types";

export class DshApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DshApiError";
  }
}

interface ServerResponse {
  type: "server-response";
  rpcId: string;
  result: { ok: true; value: any } | { ok: false; error: { code: string; message: string; details?: unknown } };
}

interface ServerRequest {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: any;
}

export interface FrameEnvelope<F> {
  rpcId: string;
  frame: F;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

/** DSH Web API 客户端:unary RPC + 双 WebSocket 事件流 + 自动重连。 */
export class DshApiClient {
  readonly baseUrl: string;
  private wsMux: WebSocket | undefined;
  private wsHost: WebSocket | undefined;
  private disposed = false;
  private reconnectTimerMux: NodeJS.Timeout | undefined;
  private reconnectTimerHost: NodeJS.Timeout | undefined;
  private retryDelayMux = 1000;
  private retryDelayHost = 1000;
  private muxOnFrame: ((env: FrameEnvelope<MuxFrame>) => void) | undefined;
  private hostOnFrame: ((env: FrameEnvelope<HostFrame>) => void) | undefined;
  private onState: ((which: "mux" | "host", state: ConnectionState) => void) | undefined;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setFrameHandlers(handlers: {
    onMuxFrame: (env: FrameEnvelope<MuxFrame>) => void;
    onHostFrame: (env: FrameEnvelope<HostFrame>) => void;
    onState?: (which: "mux" | "host", state: ConnectionState) => void;
  }) {
    this.muxOnFrame = handlers.onMuxFrame;
    this.hostOnFrame = handlers.onHostFrame;
    this.onState = handlers.onState;
    this.connectMux();
    this.connectHost();
  }

  // ---------- unary RPC ----------

  private async post<T>(method: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
    const message: ClientRequest = { type: "client-request", rpcId: randomUUID(), method, payload };
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`DSH transport failure for ${method}: HTTP ${res.status}`);
    const full = (await res.json()) as ServerResponse;
    if (full.rpcId !== message.rpcId) throw new Error(`DSH rpcId mismatch for ${method}`);
    if (!full.result.ok) {
      throw new DshApiError(full.result.error.code, full.result.error.message, full.result.error.details);
    }
    return full.result.value as T;
  }

  async ping(timeoutMs = 3000): Promise<HostDescribeValue | undefined> {
    try {
      return await this.post<HostDescribeValue>("host.describe", {}, timeoutMs);
    } catch {
      return undefined;
    }
  }

  // 工作区域
  listWorkspaces() {
    return this.post<{ items: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }[]; archivedSessionIds: string[] }>("workspace.list", {});
  }

  // 会话域
  listSessions() {
    return this.post<SessionListValue>("session.list", {});
  }
  createSession(payload: SessionCreateRequest) {
    return this.post<SessionCreateValue>("session.create", payload);
  }
  sessionHistory(payload: SessionHistoryRequest) {
    return this.post<SessionHistoryValue>("session.history", payload);
  }
  sendPrompt(payload: SessionPromptRequest) {
    return this.post<SessionPromptValue>("session.prompt", payload, 60_000);
  }
  cancelSession(sessionId: string) {
    return this.post<{ accepted: true }>("session.cancel", { sessionId });
  }
  updateQueue(sessionId: string, itemId: string, action: { kind: "edit"; content: unknown[] } | { kind: "remove" } | { kind: "steer" }) {
    return this.post<{ accepted: true }>("session.updateQueue", { sessionId, itemId, action });
  }
  /**
   * 宿主执行斜杠命令(与 Web 端同通道):/permission、/plan、/compact 等由宿主直接执行,
   * 不经 agent(经 agent 的命令会被拒绝执行,权限/命令因此不生效)。
   */
  executeCommand(sessionId: string, line: string) {
    return this.post<{ commandId: string; result: { kind: "success" | "error"; text?: string } }>("commands/execute", { args: { agentId: sessionId, line } });
  }
  renameSession(sessionId: string, title: string) {
    return this.post<{ title: string; seq: number }>("session.rename", { sessionId, title });
  }
  forkSession(sessionId: string, atSeq?: number) {
    return this.post<{ sessionId: string }>("session.fork", { sessionId, ...(atSeq === undefined ? {} : { atSeq }) });
  }
  archiveSession(sessionId: string) {
    return this.post<{ archivedSessionIds: string[] }>("workspace.archiveSession", { sessionId });
  }
  /** 采纳一个已有目录为 DSH 工作区(幂等:已存在时返回现有 workspace 且 created=false)。 */
  adoptWorkspace(path: string) {
    return this.post<{ workspace: { workspaceId: string; path: string; title: string; createdAt: string }; created: boolean }>(
      "workspace.create",
      { path },
    );
  }
  sessionModels(sessionId: string) {
    return this.post<SessionModelsValue>("session.models", { sessionId });
  }
  selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string) {
    return this.post<{ selected: unknown }>("session.selectModel", {
      sessionId,
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  listAgentPresets() {
    return this.post<AgentPresetListValue>("agentPreset.list", {});
  }
  selectAgentPreset(sessionId: string, agentPreset: string) {
    return this.post<{ agentPreset: string }>("agentPreset.select", { sessionId, agentPreset });
  }
  copyAgentPreset(id: string) {
    return this.post<{ id: string; name?: string }>("agentPreset.copy", { id });
  }
  removeAgentPreset(id: string) {
    return this.post<{ removed: true }>("agentPreset.remove", { id });
  }

  // ---------- 设置(与 Web 端共用的 settings 文档,双向同步) ----------

  settingsDescribe() {
    return this.post<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>("settings.describe", {});
  }
  settingsUpdate(ns: string, patch: Record<string, unknown>) {
    return this.post<SettingsNamespaceView>("settings.update", { ns, patch });
  }

  // ---------- LLM 模型 / 凭据 ----------

  llmProviders() {
    return this.post<{ providers: LlmProviderView[] }>("llm.providers", {});
  }
  llmModels() {
    return this.post<{ groups: LlmModelGroup[]; failures: { id: string; name: string; message: string }[] }>("llm.models", {});
  }
  credentialsDescribe(refs: string[]) {
    return this.post<{ credentials: Record<string, { configured: boolean; writable: boolean; source?: string }> }>("credentials.describe", { refs });
  }
  credentialsSet(ref: string, value: string) {
    return this.post<{}>("credentials.set", { ref, value });
  }
  credentialsUnset(ref: string) {
    return this.post<{}>("credentials.unset", { ref });
  }

  // goals
  goalEdit(sessionId: string, ref: { id: string; revision: number }, objective?: string) {
    return this.post<unknown>("goal.edit", { sessionId, ref, ...(objective !== undefined ? { objective } : {}) });
  }
  goalResume(sessionId: string, ref: { id: string; revision: number }) {
    return this.post<unknown>("goal.resume", { sessionId, ref });
  }
  goalPause(sessionId: string, ref: { id: string; revision: number }) {
    return this.post<unknown>("goal.pause", { sessionId, ref });
  }
  goalComplete(sessionId: string, ref: { id: string; revision: number }) {
    return this.post<unknown>("goal.complete", { sessionId, ref });
  }
  goalClear(sessionId: string, ref: { id: string; revision: number }) {
    return this.post<{ cleared: true }>("goal.clear", { sessionId, ref });
  }

  // skills / subagents
  listSkills(sessionId: string) {
    return this.post<{ skills: { name: string; description: string; whenToUse?: string; modelInvocable: boolean }[] }>("skill.list", { sessionId });
  }
  listSubagents(parentSessionId: string) {
    return this.post<{ entries: SubagentEntry[]; parentAvailable: boolean }>("subagent.list", { parentSessionId });
  }
  subagentHistory(parentSessionId: string, childSessionId: string, mode: "one-shot" | "continuable") {
    return this.post<{ events: { event: { type: string; seq: number; time: number; data: any }; view?: unknown }[]; hasMore: boolean }>(
      "subagent.history",
      { parentSessionId, childSessionId, mode },
    );
  }

  // ---------- /api/respond ----------

  async respond(answer: ApprovalAnswer | QuestionAnswer, frameRpcId: string): Promise<{ accepted: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-response",
        rpcId: frameRpcId,
        result: { ok: true, value: answer },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`DSH transport failure for /api/respond: HTTP ${res.status}`);
    const receipt = (await res.json()) as { accepted: boolean; reason?: string };
    if (!receipt.accepted) throw new Error(`DSH respond rejected: ${receipt.reason ?? "unknown"}`);
    return receipt;
  }

  respondApproval(sessionId: string, approvalId: string, outcome: "allowed-once" | "rejected", frameRpcId: string) {
    return this.respond({ sessionId, approvalId, outcome }, frameRpcId);
  }

  respondQuestion(sessionId: string, answer: QuestionAnswer["answer"], frameRpcId: string) {
    return this.respond({ sessionId, answer }, frameRpcId);
  }

  // ---------- WebSocket 事件流 ----------

  private wsUrl(path: string): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = path;
    return u.toString();
  }

  private connectMux() {
    if (this.disposed || this.wsMux !== undefined || !this.muxOnFrame) return;
    this.onState?.("mux", "connecting");
    const ws = new WebSocket(this.wsUrl("/api/events.mux"), { handshakeTimeout: 5000 });
    this.wsMux = ws;
    ws.on("open", () => {
      this.retryDelayMux = 1000;
      this.onState?.("mux", "connected");
    });
    ws.on("message", (data) => {
      try {
        const full = JSON.parse(data.toString()) as ServerRequest;
        if (full.type === "server-request") this.muxOnFrame?.({ rpcId: full.rpcId, frame: full.payload as MuxFrame });
      } catch {
        // 丢弃损坏帧(与官方客户端行为一致)
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.wsMux === ws) this.wsMux = undefined;
      if (this.disposed) return;
      this.onState?.("mux", "disconnected");
      const delay = this.retryDelayMux;
      this.retryDelayMux = Math.min(delay * 2, 15_000);
      this.reconnectTimerMux = setTimeout(() => this.connectMux(), delay);
    });
  }

  private connectHost() {
    if (this.disposed || this.wsHost !== undefined || !this.hostOnFrame) return;
    this.onState?.("host", "connecting");
    const ws = new WebSocket(this.wsUrl("/api/events.host"), { handshakeTimeout: 5000 });
    this.wsHost = ws;
    ws.on("open", () => {
      this.retryDelayHost = 1000;
      this.onState?.("host", "connected");
    });
    ws.on("message", (data) => {
      try {
        const full = JSON.parse(data.toString()) as ServerRequest;
        if (full.type === "server-request") this.hostOnFrame?.({ rpcId: full.rpcId, frame: full.payload as HostFrame });
      } catch {
        // 丢弃损坏帧
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.wsHost === ws) this.wsHost = undefined;
      if (this.disposed) return;
      this.onState?.("host", "disconnected");
      const delay = this.retryDelayHost;
      this.retryDelayHost = Math.min(delay * 2, 15_000);
      this.reconnectTimerHost = setTimeout(() => this.connectHost(), delay);
    });
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimerMux) clearTimeout(this.reconnectTimerMux);
    if (this.reconnectTimerHost) clearTimeout(this.reconnectTimerHost);
    try {
      this.wsMux?.removeAllListeners();
      this.wsMux?.close();
    } catch {}
    try {
      this.wsHost?.removeAllListeners();
      this.wsHost?.close();
    } catch {}
    this.wsMux = undefined;
    this.wsHost = undefined;
  }
}
