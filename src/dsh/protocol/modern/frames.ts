/**
 * modern 下行帧 → 插件内部帧词汇(`MuxFrame` / `HostFrame`)的**纯翻译层**。
 *
 * 为什么单独成文件、且不碰任何 IO:这是整个移植里唯一一处「服务端发的东西」与
 * 「上层以为自己在收的东西」之间的接缝。`sessionStore.ts` / `ui.ts` / `channel.ts`
 * 里的判别字面量有几十处,而 `import type` 让帧类型改名**编译期零报错、运行时才炸**
 * —— 所以这条接缝必须能被测试用**录制的真实帧**反复压(见 tests/smoke/protocol-frames.test.js)。
 * 纯函数是它可测的前提。
 *
 * 服务端形状的权威来源(不是猜的,逐条对源码):
 *   `$events`          → dsh-api-gateway/lib/index.js:585-727(`openRemoteEvents`/`startRemoteEvent`/
 *                        `broadcastRemoteEvent`/`finishRemoteEvent`)
 *   `session/control`  → dsh-api-session-controller/lib/types/types.d.ts:509-536
 *   `workspace/follow` → dsh-api-workspace-controller/lib/types/types.d.ts:108-131
 *   waterfall 的 request 字段 → dsh-user-approval / dsh-user-questions 的 types
 *
 * 三个必须记住的**反直觉**点(写错了只会表现为「界面莫名少东西」):
 *   1. `$events` 的 `emit` 与 `waterfall` **不是** mux 的裸帧 —— mux 下行只有
 *      item/end/error,它们是 item 的 **value**。
 *   2. 审批与提问的**唯一关联 id 是 eventId**,而它同时要当 `frameRpcId` 用
 *      (`sessionStore.handleMuxEnvelope` 按 envelope 的 rpcId 索引提问、按 approvalId
 *      索引审批并另存 rpcId)。所以这里把 eventId **双用**:`approvalId = frameRpcId = eventId`。
 *   3. `SessionControlBaseline` **没有** `approvals`/`questions` 字段 —— 那两样只走
 *      `$events`。`session/control` 只管 queue/jobs/projection 三样。
 */

import type { AskUserQuestionItem, HostFrame, JobView, MuxFrame, QueueItem, SessionSummary } from "../../types";

// ---------- 服务端下行帧的 wire 形状 ----------

/**
 * `$events` 一条 item 的 value。
 *
 * `cancel` 是**结算通知**,不是「取消操作」:服务端在 `finishRemoteEvent` 里
 * 对**所有**曾经投递过的 client 都推一条,无论这条 waterfall 是被谁、以什么方式
 * 结算的(包括被我自己答掉)。所以收到 cancel 的正确语义是「这条待办结束了,
 * 把卡片撤掉」,而不是「有人取消了它」。
 */
export type RemoteEventItem =
  | { type: "ready"; clientId: string; host?: unknown }
  | { type: "waterfall"; event: string; eventId: string; agentId: string; request: unknown }
  | { type: "emit"; event: string; args: unknown[] }
  | { type: "cancel"; eventId: string };

/** `session/control` 一条 item。 */
export type ControlItem =
  | {
      type: "baseline";
      value: {
        queues?: Record<string, unknown>;
        jobs?: Record<string, unknown>;
        projections?: Record<string, unknown>;
      };
    }
  | { type: "queue"; sessionId: string; items: unknown }
  | { type: "jobs"; sessionId: string; jobs: unknown }
  | { type: "projection"; sessionId: string; key: string; value: unknown; seq: number };

/** `workspace/follow` 一条 item。 */
export type WorkspaceItem =
  | { type: "baseline"; value: { items?: unknown; archivedSessionIds?: unknown } }
  | { type: "upsert"; workspace: unknown }
  | { type: "remove"; workspaceId: string }
  | { type: "order"; workspaceIds: unknown }
  | { type: "archived"; archivedSessionIds: unknown };

/**
 * 插件侧工作区视图(与 legacy `workspace.list` 的行同形)。
 *
 * 带索引签名是为了**结构上兼容** `WorkspaceView`(`{workspaceId: string; [key: string]:
 * unknown}`)—— 否则每次把一行传给 `host/workspace-changed` 都得强转一次。
 */
export interface WorkspaceRow {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** 一条投影基线(`SessionProjectionBaseline`)。 */
export interface ProjectionBaseline {
  asOfSeq: number;
  values: Record<string, unknown>;
}

/** 翻译结果:走哪条流 + 信封 rpcId + 帧本体。 */
export type Projected =
  | { channel: "mux"; rpcId: string; frame: MuxFrame }
  | { channel: "host"; rpcId: string; frame: HostFrame };

// ---------- 防御性取值 ----------
// wire 上的 payload 全是 unknown(`request` 更是任意 JSON)。这里的原则是
// **宁可少发一帧也不发半成品**:缺字段的帧会让 ui.ts 渲染出 undefined 卡片,
// 比不渲染更难查。

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? [...(value as string[])] : undefined;
}

/** 可选字段:有才带上,不留 `undefined` 键(`exactOptionalPropertyTypes` 下也干净)。 */
function opt<K extends string, V>(key: K, value: V | undefined): Record<K, V> | {} {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

// ---------- $events ----------

/**
 * waterfall → 待办帧。
 *
 * 只认白名单里那两个 waterfall 事件(`API_REMOTE_FORWARDED_EVENTS`,见
 * dsh-api-remotes/lib/index.js:17-94):`approval/request` 与 `user-questions/request`。
 * 别的事件名一律返回 undefined —— 这是**前向兼容**的关键:0.1.5 之后再加 waterfall
 * 事件时,老插件应当安静忽略,而不是渲染一张空白卡片。
 */
export function projectWaterfall(
  event: string,
  eventId: string,
  agentId: string,
  request: unknown,
  newRpcId: () => string,
): Projected | undefined {
  const req = asRecord(request) ?? {};
  if (event === "approval/request") {
    const toolName = asString(req["toolName"]);
    if (toolName === undefined) return undefined;
    return {
      channel: "mux",
      // eventId 双用:审批场景里 store 按 approvalId 索引、把 rpcId 另存起来备用,
      // 两者同值即可原样答回去(应答要用的是 eventId,见 respondApproval)。
      rpcId: eventId,
      frame: {
        type: "approval/requested",
        sessionId: agentId,
        approvalId: eventId,
        toolName,
        ...opt("callId", asString(req["callId"])),
        ...opt("reason", asString(req["reason"])),
      },
    };
  }
  if (event === "user-questions/request") {
    if (!Array.isArray(req["questions"])) return undefined;
    return {
      channel: "mux",
      // 提问帧**不带 id**,store 直接拿 envelope 的 rpcId 当 questionRpcId 存 ——
      // 所以这里必须把 eventId 放进 rpcId,否则回答时无 id 可回。
      rpcId: eventId,
      frame: {
        type: "question/requested",
        sessionId: agentId,
        questions: req["questions"] as AskUserQuestionItem[],
      },
    };
  }
  void newRpcId;
  return undefined;
}

/**
 * `api-session/*` 广播事件 → 主机帧。
 *
 * 这五个 emit 事件是 0.1.5 里**唯一**的会话生命周期来源(legacy 那条 `events.host`
 * socket 的等价物)。注意 `api-session/added` 带的 `SessionSummary` **没有**
 * `agentPreset` 字段(它只活在缓存投影里),所以这里复用 listSessions 的做法,
 * 能从投影读到就带上。
 *
 * `api-session/activity` **刻意不映射**:它的语义是「列表排序该变了」,而 legacy
 * 也没有对应帧,上层靠会话自身的事件推进 `updatedAt`。多造一个 no-op 帧只会
 * 让人以为那条路径通了。
 */
export function projectEmit(event: string, args: unknown[], newRpcId: () => string): Projected | undefined {
  const a0 = args[0];
  if (event === "api-session/added") {
    const summary = asRecord(a0) as (SessionSummary & Record<string, unknown>) | undefined;
    const sessionId = asString(summary?.["sessionId"]);
    if (sessionId === undefined) return undefined;
    const preset = asRecord(asRecord(summary?.["projections"])?.["values"])?.["agentPreset"];
    return {
      channel: "host",
      rpcId: newRpcId(),
      frame: {
        type: "host/session-added",
        sessionId,
        blank: summary?.["blank"] === true,
        ...opt("parentSessionId", asString(summary?.["parentSessionId"])),
        ...(summary?.["origin"] === "subagent" ? { origin: "subagent" as const } : {}),
        ...opt("cwd", asString(summary?.["cwd"])),
        ...opt("agentPreset", asString(summary?.["agentPreset"]) ?? asString(preset)),
      },
    };
  }
  if (event === "api-session/removed") {
    const sessionId = asString(a0);
    if (sessionId === undefined) return undefined;
    return { channel: "host", rpcId: newRpcId(), frame: { type: "host/session-removed", sessionId } };
  }
  if (event === "api-session/status") {
    const sessionId = asString(a0);
    if (sessionId === undefined || typeof args[1] !== "boolean") return undefined;
    return {
      channel: "host",
      rpcId: newRpcId(),
      frame: { type: "host/session-status", sessionId, running: args[1] },
    };
  }
  if (event === "api-session/error") {
    const sessionId = asString(a0);
    if (sessionId === undefined) return undefined;
    return {
      channel: "host",
      rpcId: newRpcId(),
      frame: { type: "host/agent-error", sessionId, message: asString(args[1]) ?? "agent failed" },
    };
  }
  return undefined;
}

// ---------- session/control ----------

/** 队列项:补上插件类型要求、但 0.1.5 不发的 `role`/`source`。 */
function toQueueItems(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  const out: QueueItem[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const id = asString(rec?.["id"]);
    const placement = rec?.["placement"];
    if (id === undefined) continue;
    if (placement !== "queued" && placement !== "steering" && placement !== "context") continue;
    const message = asRecord(rec?.["message"]);
    out.push({
      id,
      placement,
      message: {
        id: asString(message?.["id"]) ?? id,
        // 0.1.5 的 SessionQueuedItem.message 只有 {id, content}。渲染器(ui.ts:2038-2066)
        // 只读 id/placement/content,**从不读这两个字段** —— 但类型要求它们存在,
        // 且队列里的东西在语义上确实都是用户自己提交的,所以照实填。
        role: "user",
        content: Array.isArray(message?.["content"]) ? (message?.["content"] as unknown[]) : [],
        source: { kind: "user" },
      },
    });
  }
  return out;
}

function toJobs(raw: unknown): JobView[] {
  return (Array.isArray(raw) ? raw : []) as JobView[];
}

/**
 * 一条 control item → 0 到 N 条 MuxFrame。
 *
 * baseline 要**扇出**:服务端为了省带宽把「所有会话的队列/任务/投影」打包成一条
 * baseline,而上层的 `session/queue|jobs|projection` 是**按会话**的。所以一条
 * baseline 会被拆成 `Σ(|queues[sid]| 有则一发) + Σ(jobs 同上) + Σ(每个投影键一发)`
 * 帧 —— 空数组也照发,因为「这个集合现在是空的」本身就是必须传达的状态
 * (否则界面会永远留着上一次的队列)。
 */
export function projectControl(item: ControlItem, newRpcId: () => string): Projected[] {
  // `value` 在协议里是**可选**的,而 JSON 的 null 是合法取值(`mux.ts:187` 只挡
  // undefined)。这一层是 wire 与内部的接缝,抛出去会一路穿到 socket 的 onmessage,
  // 所以在这里就断掉,不进任何分支。
  if (item === null || typeof item !== "object") return [];
  if (item.type === "baseline") {
    const out: Projected[] = [];
    const value = (item.value ?? {}) as Record<string, unknown>;
    const queues = asRecord(value["queues"]) ?? {};
    const jobs = asRecord(value["jobs"]) ?? {};
    const projections = asRecord(value["projections"]) ?? {};
    const mint = (frame: MuxFrame) => out.push({ channel: "mux", rpcId: newRpcId(), frame });
    for (const [sessionId, items] of Object.entries(queues)) {
      mint({ type: "session/queue", sessionId, items: toQueueItems(items) });
    }
    for (const [sessionId, list] of Object.entries(jobs)) {
      mint({ type: "session/jobs", sessionId, jobs: toJobs(list) });
    }
    for (const [sessionId, baseline] of Object.entries(projections)) {
      const rec = asRecord(baseline);
      const asOfSeq = typeof rec?.["asOfSeq"] === "number" ? rec["asOfSeq"] : 0;
      for (const [key, v] of Object.entries(asRecord(rec?.["values"]) ?? {})) {
        mint({ type: "session/projection", sessionId, key, value: v, seq: asOfSeq });
      }
    }
    return out;
  }
  if (item.type === "queue") {
    return [
      {
        channel: "mux",
        rpcId: newRpcId(),
        frame: { type: "session/queue", sessionId: item.sessionId, items: toQueueItems(item.items) },
      },
    ];
  }
  if (item.type === "jobs") {
    return [
      {
        channel: "mux",
        rpcId: newRpcId(),
        frame: { type: "session/jobs", sessionId: item.sessionId, jobs: toJobs(item.jobs) },
      },
    ];
  }
  if (item.type === "projection") {
    return [
      {
        channel: "mux",
        rpcId: newRpcId(),
        frame: { type: "session/projection", sessionId: item.sessionId, key: item.key, value: item.value, seq: item.seq },
      },
    ];
  }
  return [];
}

// ---------- workspace/follow ----------

/**
 * 一行工作区。**导出**给调用方复用:流层既要用它造帧、又要拿同一份结果更新缓存,
 * 各写一遍解析就会有两份漂移的可能(而且从 `WorkspaceView` 反向强转成 `WorkspaceRow`
 * 是编译期不允许的 —— 那个方向 TypeScript 判为「不够重叠」)。
 */
export function toWorkspaceRow(entry: unknown): WorkspaceRow | undefined {
  const rec = asRecord(entry);
  const workspaceId = asString(rec?.["workspaceId"]);
  if (workspaceId === undefined) return undefined;
  return {
    ...rec,
    workspaceId,
    path: asString(rec?.["path"]) ?? "",
    title: asString(rec?.["title"]) ?? "",
    sessionIds: asStringArray(rec?.["sessionIds"]) ?? [],
    createdAt: asString(rec?.["createdAt"]) ?? "",
    updatedAt: asString(rec?.["updatedAt"]) ?? "",
  };
}

/** baseline 归一成插件的工作区行 + 归档集合。 */
export function projectWorkspaceBaseline(value: {
  items?: unknown;
  archivedSessionIds?: unknown;
}): { items: WorkspaceRow[]; archivedSessionIds: string[] } {
  const items: WorkspaceRow[] = [];
  if (Array.isArray(value?.items)) {
    for (const entry of value.items) {
      const row = toWorkspaceRow(entry);
      if (row !== undefined) items.push(row);
    }
  }
  return { items, archivedSessionIds: asStringArray(value?.archivedSessionIds) ?? [] };
}

/**
 * baseline 之后的增量 → 主机帧。四种增量与插件的四个 `host/workspace-*` 帧
 * **一一对应**(这不是巧合:0.1.5 的 WorkspaceFollowIncrement 就是按这套语义设计的)。
 */
export function projectWorkspaceIncrement(item: WorkspaceItem, newRpcId: () => string): Projected | undefined {
  // 同 projectControl:null 是合法的 wire 取值,别让它在接缝上抛。
  if (item === null || typeof item !== "object") return undefined;
  if (item.type === "upsert") {
    const row = toWorkspaceRow(item.workspace);
    if (row === undefined) return undefined;
    return {
      channel: "host",
      rpcId: newRpcId(),
      // 原样透出即可 —— ui.ts 侧边栏只读 workspaceId/path/title/sessionIds。
      frame: { type: "host/workspace-changed", workspace: row },
    };
  }
  if (item.type === "remove") {
    return { channel: "host", rpcId: newRpcId(), frame: { type: "host/workspace-removed", workspaceId: item.workspaceId } };
  }
  if (item.type === "order") {
    return {
      channel: "host",
      rpcId: newRpcId(),
      frame: { type: "host/workspace-order-changed", workspaceIds: asStringArray(item.workspaceIds) ?? [] },
    };
  }
  if (item.type === "archived") {
    return {
      channel: "host",
      rpcId: newRpcId(),
      frame: { type: "host/archived-sessions-changed", archivedSessionIds: asStringArray(item.archivedSessionIds) ?? [] },
    };
  }
  return undefined;
}
