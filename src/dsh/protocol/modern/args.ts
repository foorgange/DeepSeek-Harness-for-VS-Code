/**
 * endpoint → args 形状表。**全案最易错处**,所以单独成文件、写成纯函数。
 *
 * 为什么值得单独一个文件:0.1.5 的 gateway 对 args 做**严格 exact-match** ——
 * 多一个键、少一个键、键名写错,都只报 `gateway/arguments-invalid`,
 * 不带任何「你以为的」字段名。换句话说,错了以后的报错**不会告诉你哪里错了**。
 * 把形状集中在这里,`tests/smoke/protocol-args.test.js` 就能钉死每个端点的键集,
 * 而不是等到线上点一下才发现。
 *
 * 三条已核实的规律:
 *   1. 参数名是 descriptor 的 `parameter.wire` 名,不是业务字段名
 *      (`session/list` 的 wire 名是 `_request`,带下划线)。
 *   2. **零参端点也必须显式传 `{args:{}}`**,不能省略 payload。
 *   3. 带 `scope:{context:"agent", wire:"agentId"}` 的端点(`skills/list`、
 *      `commands/*`、`goals/*`、`agentPresets/select`、`fileReferences/list`),
 *      线上首参就是 `agentId` —— **本扩展的 sessionId 就是 agentId**,直接传,不做映射。
 *
 * 形状来源:各包的 `lib/typert.remote-client.d.ts` 里 `TypertRemoteMap` 的签名
 * (权威),以及 `tools/api-surface.json`(dump 出来的 65 个端点的键集)。
 */

/** 会话寻址。普通会话与直接子会话是两种不同的地址,服务端会校验。 */
export type SessionAddress =
  | { kind: "session"; sessionId: string }
  | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" };

/**
 * 一个 endpoint 的 args。返回的对象**原样**作为 `payload.args` 发出,
 * 所以这里多写一个键就是线上故障。
 */
export const args = {
  // ---------- 会话域 ----------
  /** wire 名是 `_request`(带下划线),不是 `request`。 */
  sessionList: () => ({ _request: {} }),
  sessionCreate: (request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }) => ({ request }),
  sessionRename: (sessionId: string, title: string) => ({ request: { sessionId, title } }),
  sessionFork: (sessionId: string, atSeq?: number) => ({
    request: { sessionId, ...(atSeq === undefined ? {} : { atSeq }) },
  }),
  sessionCancel: (sessionId: string) => ({ request: { sessionId } }),
  sessionSelectModel: (sessionId: string, provider: string, model: string, reasoningEffort?: string) => ({
    request: { sessionId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
  }),
  sessionUpdateQueue: (sessionId: string, itemId: string, action: unknown) => ({ request: { sessionId, itemId, action } }),
  /**
   * `requestId` 由**客户端铸造**(`SessionRequestId`),会回传到
   * `SessionQueuedItem.rpcId`,正好用来退掉本地乐观回声 —— 每次提交必须新造一个。
   */
  sessionPrompt: (request: { requestId: string; sessionId: string; mode: "queue" | "steer"; content: unknown[]; clientTimeZone?: string }) => ({ request }),
  sessionPage: (request: { address: SessionAddress; throughSeq: number; beforeSeq?: number; maxMessages?: number }) => ({ request }),
  sessionFollow: (request: { address: SessionAddress; maxMessages?: number; assistantStream?: true }) => ({ request }),
  sessionModelCatalog: () => ({}),

  // ---------- 工作区 ----------
  workspaceCreate: (path: string) => ({ request: { path } }),
  workspaceArchiveSession: (sessionId: string) => ({ request: { sessionId } }),

  // ---------- 命令 / 技能 / 子代理 ----------
  /**
   * `submittedAttachments` **必需**,即使没有附件也要传 `[]`。
   * 漏了它 `/checkpoints` 之类的宿主命令会直接 `gateway/arguments-invalid`
   * —— 那是激活时就走的路径,表现是「回退检查点功能整块死掉」。
   */
  commandsExecute: (agentId: string, line: string, submittedAttachments: unknown[] = []) => ({
    agentId,
    line,
    submittedAttachments,
  }),
  skillsList: (sessionId: string) => ({ request: { sessionId } }),
  subagentsList: (parentSessionId: string) => ({ parentSessionId }),

  // ---------- Agent 预设 ----------
  agentPresetsList: () => ({}),
  agentPresetsSelect: (agentId: string, agentPreset: string) => ({ agentId, agentPreset }),
  /** 签名是 `(from, id, name?)` —— 顺序与 legacy 的 `copyAgentPreset(id)` 不同,别照抄。 */
  agentPresetsCopy: (from: string, id: string, name?: string) => ({
    from,
    id,
    ...(name === undefined ? {} : { name }),
  }),
  agentPresetsDelete: (id: string) => ({ id }),

  // ---------- 设置 ----------
  settingsDescribe: () => ({}),
  /**
   * `expectedRevision` **没有 optional 标记**,但签名是 `number | undefined`:
   * `undefined` = 无条件写入。legacy 的 `settingsUpdate(ns, patch)` 没有版本概念,
   * 所以这里显式传 `undefined`,行为与旧协议一致(不做乐观并发控制)。
   */
  settingsUpdate: (ns: string, patch: Record<string, unknown>) => ({ ns, patch, expectedRevision: undefined }),

  // ---------- LLM ----------
  /**
   * 注意用 `llm/listConfigurableProviders` 而**不是** `llm/listProviders`:
   * 后者只回 `{id, name}`,而插件要的 `LlmProviderView` 需要
   * `provider / displayName / settingsNs / settingsPath / active`,
   * 正好是 `LlmConfigurableProvider` 的字段(逐个一致)。
   */
  llmListConfiguredProviders: () => ({}),

  // ---------- 凭据 ----------
  credentialsDescribe: (refs: string[]) => ({ refs }),
  credentialsSet: (ref: string, value: string) => ({ ref, value }),
  credentialsUnset: (ref: string) => ({ ref }),

  // ---------- 目标 ----------
  goalGet: (agentId: string) => ({ agentId }),
  goalCreate: (agentId: string, objective: string, maxGoalRounds?: number) => ({
    agentId,
    request: { objective, ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }) },
  }),
  goalEdit: (agentId: string, ref: { id: string; revision: number }, objective?: string) => ({
    agentId,
    ref,
    request: { ...(objective === undefined ? {} : { objective }) },
  }),
  goalResume: (agentId: string, ref: { id: string; revision: number }) => ({ agentId, ref }),
  goalPause: (agentId: string, ref: { id: string; revision: number }) => ({ agentId, ref }),
  goalComplete: (agentId: string, ref: { id: string; revision: number }) => ({ agentId, ref }),
  goalClear: (agentId: string, ref: { id: string; revision: number }) => ({ agentId, ref }),

  // ---------- waterfall 应答(走 unary,不是流) ----------
  /**
   * 线上**没有** `approvalId`:映射关系是 `approvalId = frameRpcId = eventId`,
   * 正好套进 store 现有的「审批按 approvalId 索引、存 frameRpcId 备用」结构。
   * `clientId` 必须用**当前代**的 —— 重连后 clientId 会变,旧代的会被拒。
   *
   * `outcome` 是 `parseRemoteEventResult`(stream-protocol.js:17-53)校验的带宽联合:
   * `{kind:'result'[, value]}` | `{kind:'next'}` | `{kind:'rejected', error}`。
   * 这里不收窄类型 —— 形状由 events.ts 保证,而这张表的职责只是钉住**顶层键集**。
   */
  eventsResult: (clientId: string, eventId: string, outcome: unknown) => ({ clientId, eventId, outcome }),
} as const;

/** 所有 endpoint 名,供「实现齐全」断言用。 */
export const ENDPOINTS = {
  sessionList: "session/list",
  sessionCreate: "session/create",
  sessionRename: "session/rename",
  sessionFork: "session/fork",
  sessionCancel: "session/cancel",
  sessionSelectModel: "session/selectModel",
  sessionUpdateQueue: "session/updateQueue",
  sessionPrompt: "session/prompt",
  sessionPage: "session/page",
  sessionFollow: "session/follow",
  sessionModelCatalog: "session/modelCatalog",
  workspaceCreate: "workspace/create",
  workspaceArchiveSession: "workspace/archiveSession",
  commandsExecute: "commands/execute",
  skillsList: "skills/list",
  subagentsList: "subagents/list",
  agentPresetsList: "agentPresets/list",
  agentPresetsSelect: "agentPresets/select",
  agentPresetsCopy: "agentPresets/copy",
  agentPresetsDelete: "agentPresets/deletePreset",
  settingsDescribe: "settings/describe",
  settingsUpdate: "settings/update",
  llmListConfiguredProviders: "llm/listConfigurableProviders",
  credentialsDescribe: "credentials/describe",
  credentialsSet: "credentials/set",
  credentialsUnset: "credentials/unset",
  goalGet: "goals/get",
  goalCreate: "goals/create",
  goalEdit: "goals/edit",
  goalResume: "goals/resume",
  goalPause: "goals/pause",
  goalComplete: "goals/complete",
  goalClear: "goals/clear",
  eventsResult: "$events/result",
} as const;

/**
 * 每个 endpoint 的 args **顶层键集**,硬编码,供测试逐字比对。
 * 这张表是 `protocol-args.test.js` 的期望值 —— 它和 `args` 里的实现必须同步改,
 * 改了一处而忘了另一处,测试就会红。这正是它存在的意义。
 */
export const EXPECTED_KEYS: Record<string, readonly string[]> = {
  "session/list": ["_request"],
  "session/create": ["request"],
  "session/rename": ["request"],
  "session/fork": ["request"],
  "session/cancel": ["request"],
  "session/selectModel": ["request"],
  "session/updateQueue": ["request"],
  "session/prompt": ["request"],
  "session/page": ["request"],
  "session/follow": ["request"],
  "session/modelCatalog": [],
  "workspace/create": ["request"],
  "workspace/archiveSession": ["request"],
  "commands/execute": ["agentId", "line", "submittedAttachments"],
  "skills/list": ["request"],
  "subagents/list": ["parentSessionId"],
  "agentPresets/list": [],
  "agentPresets/select": ["agentId", "agentPreset"],
  "agentPresets/copy": ["from", "id"],
  "agentPresets/deletePreset": ["id"],
  "settings/describe": [],
  "settings/update": ["ns", "patch", "expectedRevision"],
  "llm/listConfigurableProviders": [],
  "credentials/describe": ["refs"],
  "credentials/set": ["ref", "value"],
  "credentials/unset": ["ref"],
  "goals/get": ["agentId"],
  "goals/create": ["agentId", "request"],
  "goals/edit": ["agentId", "ref", "request"],
  "goals/resume": ["agentId", "ref"],
  "goals/pause": ["agentId", "ref"],
  "goals/complete": ["agentId", "ref"],
  "goals/clear": ["agentId", "ref"],
  "$events/result": ["clientId", "eventId", "outcome"],
};
