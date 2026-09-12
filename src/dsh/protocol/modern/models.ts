/**
 * 模型目录与「当前选择」的合成(S6)—— 外加 per-session 预设的记录。
 *
 * 0.1.5 把 0.1.1 的 `session.models` 拆成了两半,而且**没有任何端点直接回**
 * 「这个会话现在用哪个模型」:
 *
 *   · 有哪些厂商/模型 → `session/modelCatalog`(全局,与会话无关);
 *   · 这个会话选了哪个 → 会话的 `modelSelection` **投影**。
 *
 * 所以合成规则是:
 *
 *     current = 投影.next ?? 投影.lastUsed ?? 目录.default
 *
 * 投影的 wire 形状是 `{lastUsed, next}`,其中 `next = pending ?? lastUsed`
 * (dsh-api-session-controller/lib/types/model-selection-projection.js 的 `view`)——
 * 也就是说只有「既没选过、也没跑过请求」的会话才会两个都是 null,那时退回目录默认值
 * 恰好是对的(新建会话就是这种情况,见 hub.applyDefaultReasoningEffort)。
 *
 * ## 投影从哪来(这一条**推翻**了 `listSessions` 注释里的早先结论)
 *
 * 早先实测 `session/list` 的 `agentPreset` 既不在顶层、也不在投影里(那只是**缓存快照**,
 * 只有 `title` 之类),于是记下「per-session 的 preset 只有 session/follow 的开局快照
 * 才拿得到」。**那个结论不完整**:`session/control` 的**开局 baseline 带全部会话的全部
 * 投影**(实测 5 个会话 × 18 个键,`agentPreset` 与 `modelSelection` 都在里面,
 * 记录件见 `tests/fixtures/mux-s4.json`),而那条流从 `setFrameHandlers` 起就常驻。
 * 所以模型与预设**不必先打开那个会话** —— 这个缓存由控制流喂养,`session/follow`
 * 的快照只是同一份数据的第二个来源(两个来源的帧都经过同一个 sink,所以都收得到)。
 *
 * ## 乐观更新
 *
 * `selectModel()` 之后 `hub.updateCurrentModel()` 会**立刻**重读 `current`,而对应的
 * 投影帧还在路上 —— 不先写一次就会读到旧值,表现是「切了模型,状态栏过一会儿才变」。
 * 所以 `markSelected()` 拿 RPC 的返回值先落进缓存;等**下一帧** `modelSelection`
 * 投影到达时再让位,因为那一帧必然包含这次提交(它是提交后投影才变化的),而更晚到的
 * 帧又只会更新。唯一能钻空子的是「提交前发出的基线帧恰好在提交后才到」—— 窗口是一个
 * 往返,且下一帧就自愈。
 *
 * 本文件是**纯的**:不碰 socket、不碰 fetch,所以可以拿录制帧离线单测
 * (`tests/smoke/protocol-models.test.js` 就是这么做的)。
 */

import type {
  HostFrame,
  ModelCatalogFailure,
  ModelProviderGroup,
  ModelSelection,
  MuxFrame,
  SessionModelsValue,
} from "../../types";

/** 服务端 `session/modelCatalog` 的返回值。字段名已对 0.1.5 实测。 */
export interface ModelCatalogValue {
  default: ModelSelection;
  routableProviders: string[];
  groups: ModelProviderGroup[];
  failures: ModelCatalogFailure[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 未知值 → `ModelSelection`,认不出就是 `undefined`。
 *
 * `provider`/`model` 都必须是**非空字符串**:空串能过 `typeof` 检查,但它在界面上
 * 表现为「状态栏一片空白」,比 `undefined` 更难查 —— 上层对 undefined 有明确的兜底
 * 分支(退回目录默认值),对空串没有。
 */
export function toSelection(value: unknown): ModelSelection | undefined {
  const rec = asRecord(value);
  if (rec === undefined) return undefined;
  const provider = rec["provider"];
  const model = rec["model"];
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  if (typeof model !== "string" || model.length === 0) return undefined;
  const effort = rec["reasoningEffort"];
  return {
    provider,
    model,
    ...(typeof effort === "string" && effort.length > 0 ? { reasoningEffort: effort } : {}),
  };
}

/**
 * 把目录与「这个会话选了哪个」合成 legacy 的 `SessionModelsValue`。
 *
 * `current` 三级回退:会话选择 → 目录默认 → 空壳。空壳(**不是**抛错)是有意的:
 * 目录本身已经取到了(groups 是真的),这时因为一个字段缺失而整块报错,
 * 会让模型菜单整个打不开 —— 而它本来还能列出所有厂商与模型。
 */
export function synthesizeModels(
  catalog: ModelCatalogValue | undefined,
  selection: ModelSelection | undefined,
): SessionModelsValue {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const failures = Array.isArray(catalog?.failures) ? catalog.failures : [];
  return {
    current: selection ?? toSelection(catalog?.default) ?? { provider: "", model: "" },
    // 「能不能路由」= 至少有一个可路由的厂商。legacy 里它由服务端算,这里从目录推。
    routable: Array.isArray(catalog?.routableProviders) && catalog.routableProviders.length > 0,
    groups,
    failures,
  };
}

/**
 * 会话投影的**进程内缓存**:只留本插件真正要用的两个键。
 *
 * 不把整份投影存下来(那样要处理 18 个键的失效、内存与语义都对不上),只挑
 * `modelSelection` 与 `agentPreset` —— 前者喂 `sessionModels()`,后者喂
 * `listSessions()` 的回填。其余 16 个键的去处是 `sessionStore.applyProjection`
 * (帧照常转发,缓存不拦)。
 */
export class SessionProjections {
  private readonly presets = new Map<string, string>();
  private readonly selections = new Map<string, ModelSelection>();
  /** `selectModel` 之后、投影帧到达之前的临时值(见文件头「乐观更新」)。 */
  private readonly optimistic = new Map<string, ModelSelection>();

  /**
   * 嗅一帧(`MuxFrame` 与 `HostFrame` 都收)。
   *
   * **不转发** —— 调用方负责把帧继续送下去。返回值也没有:这个类是旁路缓存,
   * 它坏了最坏是模型/预设显示回退,不该影响任何帧的投递。
   */
  note(frame: MuxFrame | HostFrame): void {
    // 闸口在**最外层**:下面每一条分支都要读 `frame.type`,而这个方法是在
    // 「转发之前」被调的 —— 它抛出去就是整条帧投递链断掉,把「模型显示不对」
    // 升级成「界面不动了」。畸形输入一律当没看见。
    if (frame === null || typeof frame !== "object") return;
    if (frame.type === "session/projection") {
      this.noteProjection(frame.sessionId, frame.key, frame.value);
      return;
    }
    // 会话被删就把它那几个键扔掉:本进程可能开着好几天,不该留着已删会话的 id。
    if (frame.type === "host/session-removed" && typeof frame.sessionId === "string") {
      this.forget(frame.sessionId);
    }
  }

  private noteProjection(sessionId: string, key: string, value: unknown): void {
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    if (key === "agentPreset") {
      if (typeof value === "string" && value.length > 0) this.presets.set(sessionId, value);
      return;
    }
    if (key !== "modelSelection") return;
    const rec = asRecord(value);
    const next = toSelection(rec?.["next"]) ?? toSelection(rec?.["lastUsed"]);
    // 服务端就这个键发话了 ⇒ 这一帧至少和我们的乐观值一样新,让位。
    this.optimistic.delete(sessionId);
    if (next === undefined) this.selections.delete(sessionId);
    else this.selections.set(sessionId, next);
  }

  /** 会话的预设 id(没记录过就是 undefined —— 界面显示成空,不是错误)。 */
  agentPresetOf(sessionId: string): string | undefined {
    return this.presets.get(sessionId);
  }

  /**
   * 会话当前选中的模型:乐观值优先,其次投影值。
   *
   * 都拿不到就返回 `undefined` —— 由 `synthesizeModels` 退回目录默认值,
   * 而不是在这里编一个:编出来的值会和「真的选了默认模型」混淆。
   */
  selectionOf(sessionId: string): ModelSelection | undefined {
    return this.optimistic.get(sessionId) ?? this.selections.get(sessionId);
  }

  /** `selectModel` 成功后立刻落库,免得投影帧到达前读到旧值。 */
  markSelected(sessionId: string, selection: ModelSelection): void {
    this.optimistic.set(sessionId, selection);
  }

  forget(sessionId: unknown): void {
    if (typeof sessionId !== "string") return;
    this.presets.delete(sessionId);
    this.selections.delete(sessionId);
    this.optimistic.delete(sessionId);
  }

  /** 已记录预设的会话数(诊断/探针用)。 */
  get size(): number {
    return this.presets.size;
  }
}
