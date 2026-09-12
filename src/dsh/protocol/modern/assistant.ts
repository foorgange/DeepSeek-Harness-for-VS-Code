/**
 * `assistant-stream`(进程内流式增量)→ 插件 `assistant/chunk` 事件的**铸造器**。
 *
 * 为什么需要「铸造 seq」这件事:0.1.5 里流式增量**不再是持久事件**(`assistant/chunk`
 * 只活在两个格式迁移包里),它走的是 opt-in 的 `assistant-stream` 帧,而那个帧**没有 seq**
 * —— 它不属于日志,只是「这个模型调用正在吐 token」的即时播报。
 *
 * 但插件的整条链路都是按 seq 索引的:`sessionStore` 用 `Map<seq, event>` 去重、
 * `eventsFor()` 按 seq 排序、`ui.ts` 用 `ev.seq` 做节点 key。所以这里必须给每个增量
 * **造一个单调的 seq**,而且要让它**插在正确的两条持久事件之间** —— 否则流式文本会跑到
 * 用户消息前面去,或者和后面到达的 `assistant/message` 撞号(撞号更糟:store 会把
 * 后到的那条当重复丢掉,也就是**持久内容凭空消失**)。
 *
 * 方案:`seq = base + 1 - 1/(frac+1)`,其中 `base` 是「已见过的最大持久 seq」(钳到 ≥ 0)。
 *   · 值域严格落在 `(base, base+1)` 开区间 ⇒ 永远不会等于任何持久 seq(它们是整数);
 *   · `frac` 递增 ⇒ 序列 0.5, 0.667, 0.75, … 严格单调,且随 `frac` 收敛到 1;
 *   · 持久事件到达时 `base` 前进、`frac` 归零,新值 `base+0.5` 仍严格大于
 *     `(base-1)+1⁻` ⇒ 跨持久事件也单调。
 *
 * `base` 要钳到 ≥ 0:空会话的游标是 `-1`(`cursorBeforeNext(0) === -1`,见
 * dsh-api-session-controller/lib/index.js:1545),不钳的话第一个增量会是 `-0.5`
 * —— 负 seq 在日志语义里毫无意义,而且会让 `historyBeforeSeq` 吐出一个负数。
 *
 * 另外记两条**协议事实**(都读自 dsh-api-session-controller/lib/index.js:1406-1500):
 *   1. `start` 帧带 `startedAfterSeq` = 「这次尝试开始时的持久游标」(`seq-1`)。
 *      它比我们自己数的游标权威,所以也喂给 `noteDurable`。
 *   2. `chunk` 帧**不带 turn/step**,那两样只在 `start` 上。所以必须按 `attemptId`
 *      记住它们,否则 `ui.ts` 的 `beginAssistantBlock(turn, step, index, …)` 会拿到
 *      0/0,块会被归到错误的回合里。
 */

import type { FrameEnvelope } from "../legacy";
import type { MuxFrame, SessionEvent } from "../../types";

export interface AssistantSink {
  onMux(env: FrameEnvelope<MuxFrame>): void;
  newRpcId(): string;
  onLog?(message: string): void;
}

/** `start` 帧里那两样我们得替 `chunk` 记住的东西。 */
interface Attempt {
  turn: number;
  step: number;
}

interface SessionState {
  /** assistantStream 的版本号。开局帧给初值,之后每条帧必须 +1(协议自带的自检)。 */
  revision: number;
  /** 已见过的最大持久 seq(钳到 ≥ 0)。小数 seq 的整数部分。 */
  base: number;
  /** 自 `base` 确定以来铸出的小数个数。 */
  frac: number;
  /** attemptId → turn/step。`start` 写入,`end` 删除。 */
  attempts: Map<string, Attempt>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function asStringId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class AssistantStreams {
  private readonly state = new Map<string, SessionState>();
  private readonly live = new Set<string>();

  constructor(private readonly sink: AssistantSink) {}

  private stateFor(sessionId: string): SessionState {
    let s = this.state.get(sessionId);
    if (s === undefined) {
      s = { revision: 0, base: 0, frac: 0, attempts: new Map() };
      this.state.set(sessionId, s);
    }
    return s;
  }

  /**
   * follow 开局帧的 `assistantStream` 基线。
   *
   * `revision` 是**续接点**:重连后服务端从新的一代继续编号,而我们要的只是
   * 「别再信任上一条流留下的 revision」。`activeAttempt`(如果有)说明开流时
   * 正有一次尝试在跑 —— 它的 `startedAfterSeq` 同样要喂进游标。
   */
  baseline(sessionId: string, assistantStream: unknown): void {
    const rec = asRecord(assistantStream);
    if (rec === undefined) return;
    const s = this.stateFor(sessionId);
    const revision = asInt(rec["revision"]);
    if (revision !== undefined) s.revision = revision;
    const active = asRecord(rec["activeAttempt"]);
    if (active !== undefined) {
      s.attempts.clear();
      const attemptId = asStringId(active["attemptId"]);
      const turn = asInt(active["turn"]) ?? 0;
      const step = asInt(active["step"]) ?? 0;
      if (attemptId !== undefined) s.attempts.set(attemptId, { turn, step });
      // 重连时这次尝试还没结束 —— 后面的 chunk 仍然会带同一个 attemptId,
      // 而它的 turn/step 只有基线这里能拿到。
      this.noteDurable(sessionId, asInt(active["startedAfterSeq"]) ?? -1);
    }
  }

  /**
   * 一条 `assistant-stream` 帧。
   *
   * 版本号断层**只记日志、不抛错**:抛出去会一路穿到 socket 的 onmessage,把一次
   * 「少了几帧 token」升级成「整条流挂掉」。而少掉的那些 token 本来就补不回来
   * (它们不是持久数据),真正的兜底是紧随其后的持久 `assistant/message` —— 它带
   * 完整内容,`ui.ts` 会因为 `streamedBlockKeys` 里已有该键而跳过重复追加。
   */
  accept(sessionId: string, frame: unknown): void {
    const rec = asRecord(frame);
    if (rec === undefined) return;
    const type = rec["type"];
    const s = this.stateFor(sessionId);
    const revision = asInt(rec["revision"]);
    if (revision !== undefined) {
      if (revision !== s.revision + 1 && this.live.has(sessionId)) {
        this.sink.onLog?.(`[assistant] ${sessionId} 流式版本断层 ${s.revision} → ${revision}(丢掉的 token 无法找回,等持久事件兜底)`);
      }
      s.revision = revision;
    }

    if (type === "start") {
      const attemptId = asStringId(rec["attemptId"]);
      const turn = asInt(rec["turn"]) ?? 0;
      const step = asInt(rec["step"]) ?? 0;
      if (attemptId !== undefined) s.attempts.set(attemptId, { turn, step });
      // startedAfterSeq 是「这次尝试开始时的持久游标」,权威。
      this.noteDurable(sessionId, asInt(rec["startedAfterSeq"]) ?? -1);
      this.live.add(sessionId);
      return;
    }

    if (type === "chunk") {
      const attemptId = asStringId(rec["attemptId"]);
      const attempt = attemptId === undefined ? undefined : s.attempts.get(attemptId);
      const index = asInt(rec["index"]);
      const chunk = asRecord(rec["chunk"]);
      // 没有 chunk 载荷就没有可渲染的东西 —— 尤其 `block-start`(它才是让 ui.ts
      // 新建块的信号)不能拿一个空对象去顶替,那会渲染出一个空文本块。
      if (chunk === undefined) return;
      // **认不出 attemptId 就整条丢掉**,不能拿 0/0 顶替。
      // `ui.ts:1150` 把 `${turn}:${step}:${index}` 记进 `streamedBlockKeys`,而紧随其后的
      // 持久 `assistant/message` 靠同一个键跳过重复追加(`ui.ts:1436`)—— 键对不上,
      // 同一段文字就会**渲染两遍**(一遍在错误的回合里)。丢掉的 token 不是损失:
      // 它们本来就不是持久数据,持久消息带完整内容。
      if (attempt === undefined) {
        this.sink.onLog?.(`[assistant] ${sessionId} 丢弃认不出 attemptId=${attemptId ?? "(缺失)"} 的增量(等持久事件兜底)`);
        return;
      }
      const event: SessionEvent = {
        type: "assistant/chunk",
        seq: this.mintSeq(s),
        time: asInt(rec["time"]) ?? Date.now(),
        data: {
          turn: attempt.turn,
          step: attempt.step,
          ...(index === undefined ? {} : { index }),
          chunk,
        },
      };
      this.sink.onMux({
        rpcId: this.sink.newRpcId(),
        frame: { type: "session/event", sessionId, event },
      });
      return;
    }

    if (type === "end") {
      const outcome = asRecord(rec["outcome"]);
      const attemptId = asStringId(rec["attemptId"]);
      if (attemptId !== undefined) s.attempts.delete(attemptId);
      if (outcome?.["kind"] === "committed") {
        // 已落盘:把游标推到那条持久事件上,后续增量就排到它后面。
        this.noteDurable(sessionId, asInt(outcome["seq"]) ?? -1);
      }
      this.live.delete(sessionId);
      return;
    }
  }

  /**
   * 持久事件到达 —— 维护小数 seq 的基准。
   *
   * `base` 只在**前进**时更新(乱序/重放的旧事件不该把基准拉回去),前进时
   * `frac` 归零:新的 `base+0.5` 必定大于旧基准下的任何值(`(base-1)+1⁻ < base`)。
   */
  noteDurable(sessionId: string, seq: number): void {
    if (!Number.isFinite(seq)) return;
    const s = this.stateFor(sessionId);
    const next = Math.max(seq, 0);
    if (next > s.base) {
      s.base = next;
      s.frac = 0;
    }
  }

  private mintSeq(s: SessionState): number {
    s.frac += 1;
    return s.base + 1 - 1 / (s.frac + 1);
  }
}
