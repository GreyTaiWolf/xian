/**
 * 确定性单通道战斗时间线。
 *
 * 本模块只负责行动排队、阶段推进与事件顺序，不结算伤害，也不读取渲染状态。
 * 伤害、死亡和目标合法性由同步 hooks 处理，因此命中造成的死亡可以立即取消后续行动。
 */

export type CombatActorKind = 'player' | 'monster';

export interface CombatActorRef {
  readonly kind: CombatActorKind;
  readonly id: string | number;
}

export type CombatActionKind = 'basic' | 'skill' | 'enemy';

export type CombatPhase = 'windup' | 'travel' | 'impact' | 'recover';

/** 各阶段时长，单位均为毫秒；入队时会归一为至少 1ms 的有限值。 */
export type CombatActionTimings = Readonly<Record<CombatPhase, number>>;

export interface CombatActionIntent {
  readonly actor: CombatActorRef;
  readonly target: CombatActorRef;
  readonly kind: CombatActionKind;
  readonly timings: CombatActionTimings;
  /** 越大越优先。 */
  readonly priority?: number;
  /** 时间线上的最早可开始时刻；省略时使用当前时刻。 */
  readonly readyAt?: number;
  /** 同优先级、同 readyAt 时，速度越大越优先。 */
  readonly speed?: number;
  /** 供表现层选择技能与特效，不参与时间线规则。 */
  readonly cue?: string;
}

export type CombatActionStatus = 'queued' | 'active' | 'completed' | 'cancelled';

/**
 * 对外暴露的行动始终是只读快照；修改快照不会影响时间线内部状态。
 */
export interface CombatAction {
  readonly actionId: number;
  readonly requestSeq: number;
  readonly actor: CombatActorRef;
  readonly target: CombatActorRef;
  readonly actorKey: string;
  readonly targetKey: string;
  readonly kind: CombatActionKind;
  readonly timings: CombatActionTimings;
  readonly priority: number;
  readonly readyAt: number;
  readonly speed: number;
  readonly cue?: string;
  readonly status: CombatActionStatus;
  readonly phase: CombatPhase | null;
  readonly phaseElapsedMs: number;
  readonly phaseProgress: number;
  readonly startedAt: number | null;
  readonly impactEmitted: boolean;
}

interface CombatTimelineEventBase {
  readonly eventSeq: number;
  readonly atMs: number;
  readonly action: CombatAction;
}

export interface CombatStartedEvent extends CombatTimelineEventBase {
  readonly type: 'started';
}

export interface CombatPhaseEvent extends CombatTimelineEventBase {
  readonly type: 'phase';
  readonly phase: CombatPhase;
}

export interface CombatImpactEvent extends CombatTimelineEventBase {
  readonly type: 'impact';
  readonly phase: 'impact';
}

export interface CombatCompletedEvent extends CombatTimelineEventBase {
  readonly type: 'completed';
}

export interface CombatCancelledEvent extends CombatTimelineEventBase {
  readonly type: 'cancelled';
  readonly reason: string;
}

export type CombatTimelineEvent =
  | CombatStartedEvent
  | CombatPhaseEvent
  | CombatImpactEvent
  | CombatCompletedEvent
  | CombatCancelledEvent;

type WithoutEventMeta<T> = T extends CombatTimelineEvent
  ? Omit<T, 'eventSeq' | 'atMs'>
  : never;

type CombatTimelineEventInput = WithoutEventMeta<CombatTimelineEvent>;

export interface CombatTimelineHooks {
  /** 行动真正占用通道前的最后一道合法性检查。 */
  readonly canStart?: (action: CombatAction) => boolean;
  /** 同步事件出口；impact 回调可结算死亡并立即取消死者行动。 */
  readonly onEvent?: (event: CombatTimelineEvent) => void;
}

export interface CombatTimelineSnapshot {
  readonly nowMs: number;
  readonly active: CombatAction | null;
  readonly queued: readonly CombatAction[];
  readonly phaseProgress: number;
  readonly nextActionId: number;
  readonly nextRequestSeq: number;
  readonly nextEventSeq: number;
}

interface InternalCombatAction {
  readonly actionId: number;
  readonly requestSeq: number;
  readonly actor: CombatActorRef;
  readonly target: CombatActorRef;
  readonly actorKey: string;
  readonly targetKey: string;
  readonly kind: CombatActionKind;
  readonly timings: CombatActionTimings;
  readonly priority: number;
  readonly readyAt: number;
  readonly speed: number;
  readonly cue?: string;
  /** onEvent 内新建的行动从下一次 advance 才可启动，避免零时间重入循环。 */
  readonly eligibleAfterAdvance: number;
  phase: CombatPhase | null;
  phaseElapsedMs: number;
  startedAt: number | null;
  impactEmitted: boolean;
}

interface DispatchContext {
  readonly hooks: CombatTimelineHooks;
  readonly events: CombatTimelineEvent[];
}

const PHASES: readonly CombatPhase[] = ['windup', 'travel', 'impact', 'recover'];
const MIN_TIME_MS = 1;
const MAX_DURATION_MS = 86_400_000;
const MAX_CLOCK_MS = Number.MAX_SAFE_INTEGER / 4;
const MAX_CAN_START_MUTATIONS = 1024;

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDuration(value: number): number {
  return clamp(finiteNumber(value, MIN_TIME_MS), MIN_TIME_MS, MAX_DURATION_MS);
}

function normalizeTimePoint(value: number | undefined, fallback: number): number {
  return clamp(finiteNumber(value, fallback), MIN_TIME_MS, MAX_CLOCK_MS);
}

function normalizeDelta(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function cloneActor(actor: CombatActorRef): CombatActorRef {
  return Object.freeze({ kind: actor.kind, id: actor.id });
}

/** number 与 string ID 必须分开，避免怪物 1 与怪物 "1" 冲突。 */
export function combatActorKey(actor: CombatActorRef): string {
  return `${actor.kind}:${typeof actor.id}:${String(actor.id)}`;
}

function normalizeTimings(timings: CombatActionTimings): CombatActionTimings {
  return Object.freeze({
    windup: normalizeDuration(timings.windup),
    travel: normalizeDuration(timings.travel),
    impact: normalizeDuration(timings.impact),
    recover: normalizeDuration(timings.recover),
  });
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareActions(a: InternalCombatAction, b: InternalCombatAction): number {
  return (
    b.priority - a.priority ||
    a.readyAt - b.readyAt ||
    b.speed - a.speed ||
    compareKeys(a.actorKey, b.actorKey) ||
    a.requestSeq - b.requestSeq
  );
}

function phaseDuration(action: InternalCombatAction): number {
  return action.phase === null ? MIN_TIME_MS : action.timings[action.phase];
}

function safeClockAdd(nowMs: number, deltaMs: number): number {
  return Math.min(MAX_CLOCK_MS, nowMs + deltaMs);
}

/**
 * 同一时刻只有一个 active 行动。队列顺序固定为：
 * priority 降序 → readyAt 升序 → speed 降序 → actorKey → requestSeq。
 */
export class CombatTimeline {
  private nowValue: number;
  private activeValue: InternalCombatAction | null = null;
  private readonly queue: InternalCombatAction[] = [];
  private readonly actorSlots = new Map<string, number>();
  private actionSeq = 1;
  private requestSeq = 1;
  private eventSeq = 1;
  private advanceSeq = 0;
  private queueRevision = 0;
  private canStartMutations = 0;
  private eventCallbackDepth = 0;
  private dispatchContext: DispatchContext | null = null;
  private advancing = false;
  private clearing = false;

  constructor(startAtMs = MIN_TIME_MS) {
    this.nowValue = normalizeTimePoint(startAtMs, MIN_TIME_MS);
  }

  get nowMs(): number {
    return this.nowValue;
  }

  get active(): CombatAction | null {
    return this.activeValue ? this.actionSnapshot(this.activeValue, 'active') : null;
  }

  get queued(): readonly CombatAction[] {
    return Object.freeze(this.queue.map((action) => this.actionSnapshot(action, 'queued')));
  }

  get phaseProgress(): number {
    if (!this.activeValue) return 0;
    return clamp(this.activeValue.phaseElapsedMs / phaseDuration(this.activeValue), 0, 1);
  }

  get snapshot(): CombatTimelineSnapshot {
    return Object.freeze({
      nowMs: this.nowValue,
      active: this.active,
      queued: this.queued,
      phaseProgress: this.phaseProgress,
      nextActionId: this.actionSeq,
      nextRequestSeq: this.requestSeq,
      nextEventSeq: this.eventSeq,
    });
  }

  getSnapshot(): CombatTimelineSnapshot {
    return this.snapshot;
  }

  /**
   * 入队成功返回归一化后的只读行动；同一 actor 已 active / pending 时返回 null。
   * onEvent 内入队仍会成功，但最早从下一次 advance 开始，避免同步事件制造零时间死循环。
   */
  enqueue(intent: CombatActionIntent): CombatAction | null {
    if (this.clearing) return null;

    // 先完整读取并归一化外部对象。即使恶意 getter 重入 enqueue，最终槽位检查仍是原子的。
    const actor = cloneActor(intent.actor);
    const target = cloneActor(intent.target);
    const actorKey = combatActorKey(actor);
    const targetKey = combatActorKey(target);
    const kind = intent.kind;
    const timings = normalizeTimings(intent.timings);
    const priority = finiteNumber(intent.priority, 0);
    const readyAt = normalizeTimePoint(intent.readyAt, this.nowValue);
    const speed = Math.max(0, finiteNumber(intent.speed, 0));
    const cue = intent.cue;
    if (this.actorSlots.has(actorKey)) return null;

    const actionId = this.takeActionId();
    const requestSeq = this.takeRequestSeq();
    const action: InternalCombatAction = {
      actionId,
      requestSeq,
      actor,
      target,
      actorKey,
      targetKey,
      kind,
      timings,
      priority,
      readyAt,
      speed,
      cue,
      eligibleAfterAdvance: this.eventCallbackDepth > 0 ? this.advanceSeq + 1 : this.advanceSeq,
      phase: null,
      phaseElapsedMs: 0,
      startedAt: null,
      impactEmitted: false,
    };

    this.actorSlots.set(actorKey, actionId);
    this.queue.push(action);
    this.queue.sort(compareActions);
    this.queueRevision += 1;
    return this.actionSnapshot(action, 'queued');
  }

  hasActor(actor: CombatActorRef): boolean {
    return this.actorSlots.has(combatActorKey(actor));
  }

  /** 取消指定 actor 的 active 或 pending 行动。 */
  cancelByActor(
    actor: CombatActorRef,
    reason = 'actor-cancelled',
    hooks?: CombatTimelineHooks,
  ): boolean {
    const actionId = this.actorSlots.get(combatActorKey(actor));
    return actionId === undefined ? false : this.cancelAction(actionId, reason, hooks);
  }

  /** 取消指定行动；取消事件会同步发往当前 advance hooks 或显式传入的 hooks。 */
  cancelAction(actionId: number, reason = 'cancelled', hooks?: CombatTimelineHooks): boolean {
    if (this.activeValue?.actionId === actionId) {
      const action = this.activeValue;
      this.activeValue = null;
      this.releaseActor(action);
      this.queueRevision += 1;
      this.emitCancelled(action, reason, hooks);
      return true;
    }

    const index = this.queue.findIndex((action) => action.actionId === actionId);
    if (index < 0) return false;
    const [action] = this.queue.splice(index, 1);
    if (!action) return false;
    this.releaseActor(action);
    this.queueRevision += 1;
    this.emitCancelled(action, reason, hooks);
    return true;
  }

  /** 清空 active 与 queued；返回实际取消的行动数。 */
  clear(reason = 'cleared', hooks?: CombatTimelineHooks): number {
    if (this.clearing) return 0;
    const actions = [...(this.activeValue ? [this.activeValue] : []), ...this.queue];
    // 先原子摘除全部行动，再发事件；任何 cancelled 回调都观察不到半清理队列。
    this.activeValue = null;
    this.queue.length = 0;
    for (const action of actions) this.releaseActor(action);
    if (actions.length > 0) this.queueRevision += 1;

    let firstError: unknown;
    let hookThrew = false;
    this.clearing = true;
    try {
      for (const action of actions) {
        try {
          this.emitCancelled(action, reason, hooks);
        } catch (error) {
          // clear 是原子清场：单个表现回调失败也要继续释放其余 actor 槽位。
          if (!hookThrew) {
            firstError = error;
            hookThrew = true;
          }
        }
      }
    } finally {
      this.clearing = false;
    }
    if (hookThrew) throw firstError;
    return actions.length;
  }

  /**
   * 推进任意非负时长。一次调用可以跨越多个阶段和多个行动，所有边界事件都会按顺序返回。
   * 负数、NaN 与 Infinity 视为 0ms；嵌套 advance 会被拒绝以保护事件顺序。
   */
  advance(dtMs: number, hooks: CombatTimelineHooks = {}): readonly CombatTimelineEvent[] {
    if (this.clearing) {
      throw new Error('CombatTimeline.clear 的同步回调内不能推进时间线。');
    }
    if (this.advancing) {
      throw new Error('CombatTimeline.advance 不支持在事件回调内嵌套调用。');
    }

    const events: CombatTimelineEvent[] = [];
    const previousContext = this.dispatchContext;
    this.dispatchContext = { hooks, events };
    this.advancing = true;
    this.advanceSeq += 1;
    this.canStartMutations = 0;

    try {
      let remainingMs = normalizeDelta(dtMs);

      while (true) {
        if (!this.activeValue) {
          const changed = this.tryStartReadyAction(hooks);
          if (this.activeValue) continue;
          if (changed) continue;

          const nextReadyAt = this.nextReadyAt();
          if (nextReadyAt === null) {
            this.advanceClock(remainingMs);
            remainingMs = 0;
            break;
          }
          if (remainingMs <= 0) break;

          const untilReady = Math.max(0, nextReadyAt - this.nowValue);
          if (untilReady > remainingMs) {
            this.advanceClock(remainingMs);
            remainingMs = 0;
            break;
          }

          this.advanceClock(untilReady);
          remainingMs -= untilReady;
          continue;
        }

        const action = this.activeValue;
        const duration = phaseDuration(action);
        const untilBoundary = Math.max(0, duration - action.phaseElapsedMs);

        if (remainingMs < untilBoundary) {
          action.phaseElapsedMs += remainingMs;
          this.advanceClock(remainingMs);
          remainingMs = 0;
          break;
        }

        action.phaseElapsedMs = duration;
        this.advanceClock(untilBoundary);
        remainingMs -= untilBoundary;
        this.finishPhase(action, hooks);
      }
    } finally {
      this.advancing = false;
      this.dispatchContext = previousContext;
    }

    return Object.freeze(events.slice());
  }

  private tryStartReadyAction(hooks: CombatTimelineHooks): boolean {
    const action = this.queue.find((candidate) => this.isReady(candidate));
    if (!action) return false;

    const revisionBeforeHook = this.queueRevision;
    const canStart = hooks.canStart?.(this.actionSnapshot(action, 'queued')) ?? true;
    if (this.queueRevision !== revisionBeforeHook) {
      this.canStartMutations += 1;
      if (this.canStartMutations > MAX_CAN_START_MUTATIONS) {
        throw new Error('CombatTimeline.canStart 回调连续重排过多，已中止本次推进。');
      }
    }
    const indexAfterHook = this.queue.findIndex((candidate) => candidate.actionId === action.actionId);
    if (indexAfterHook < 0) return true;

    if (!canStart) {
      this.queue.splice(indexAfterHook, 1);
      this.releaseActor(action);
      this.queueRevision += 1;
      this.emitCancelled(action, 'cannot-start', hooks);
      return true;
    }

    // canStart 是同步钩子，期间可能有更高优先级行动入队；开始前必须重新尊重完整排序。
    const firstReadyAfterHook = this.queue.find((candidate) => this.isReady(candidate));
    if (firstReadyAfterHook?.actionId !== action.actionId) return true;

    this.queue.splice(indexAfterHook, 1);
    this.queueRevision += 1;
    action.phase = 'windup';
    action.phaseElapsedMs = 0;
    action.startedAt = this.nowValue;
    this.activeValue = action;
    let startedError: unknown;
    let startedThrew = false;
    try {
      this.emit({ type: 'started', action: this.actionSnapshot(action, 'active') }, hooks);
    } catch (error) {
      // started 与首个 phase 属于同一个原子边界，先补齐边界事件再向调用方抛错。
      startedError = error;
      startedThrew = true;
    }

    if (this.activeValue?.actionId === action.actionId) {
      try {
        this.emit(
          {
            type: 'phase',
            phase: 'windup',
            action: this.actionSnapshot(action, 'active'),
          },
          hooks,
        );
      } catch (error) {
        if (!startedThrew) {
          startedError = error;
          startedThrew = true;
        }
      }
    }
    if (startedThrew) throw startedError;
    return true;
  }

  private finishPhase(action: InternalCombatAction, hooks: CombatTimelineHooks): void {
    if (this.activeValue?.actionId !== action.actionId || action.phase === null) return;
    const phaseIndex = PHASES.indexOf(action.phase);

    if (phaseIndex === PHASES.length - 1) {
      this.activeValue = null;
      this.releaseActor(action);
      this.emit({ type: 'completed', action: this.actionSnapshot(action, 'completed') }, hooks);
      return;
    }

    const nextPhase = PHASES[phaseIndex + 1];
    if (!nextPhase) return;
    action.phase = nextPhase;
    action.phaseElapsedMs = 0;
    let phaseError: unknown;
    let phaseThrew = false;
    try {
      this.emit(
        {
          type: 'phase',
          phase: nextPhase,
          action: this.actionSnapshot(action, 'active'),
        },
        hooks,
      );
    } catch (error) {
      phaseError = error;
      phaseThrew = true;
    }

    if (nextPhase === 'impact' && this.activeValue?.actionId === action.actionId && !action.impactEmitted) {
      action.impactEmitted = true;
      try {
        this.emit(
          {
            type: 'impact',
            phase: 'impact',
            action: this.actionSnapshot(action, 'active'),
          },
          hooks,
        );
      } catch (error) {
        if (!phaseThrew) {
          phaseError = error;
          phaseThrew = true;
        }
      }
    }
    if (phaseThrew) throw phaseError;
  }

  private nextReadyAt(): number | null {
    let next = Number.POSITIVE_INFINITY;
    for (const action of this.queue) {
      if (action.eligibleAfterAdvance <= this.advanceSeq) next = Math.min(next, action.readyAt);
    }
    return Number.isFinite(next) ? next : null;
  }

  private isReady(action: InternalCombatAction): boolean {
    return action.eligibleAfterAdvance <= this.advanceSeq && action.readyAt <= this.nowValue;
  }

  private advanceClock(deltaMs: number): void {
    this.nowValue = safeClockAdd(this.nowValue, deltaMs);
  }

  private releaseActor(action: InternalCombatAction): void {
    if (this.actorSlots.get(action.actorKey) === action.actionId) {
      this.actorSlots.delete(action.actorKey);
    }
  }

  private emitCancelled(
    action: InternalCombatAction,
    reason: string,
    hooks?: CombatTimelineHooks,
  ): void {
    this.emit(
      {
        type: 'cancelled',
        reason,
        action: this.actionSnapshot(action, 'cancelled'),
      },
      hooks,
    );
  }

  private emit(
    event: CombatTimelineEventInput,
    explicitHooks?: CombatTimelineHooks,
  ): void {
    const emitted = Object.freeze({
      ...event,
      eventSeq: this.takeEventSeq(),
      atMs: this.nowValue,
    }) as CombatTimelineEvent;
    this.dispatchContext?.events.push(emitted);
    const hooks = explicitHooks ?? this.dispatchContext?.hooks;
    if (hooks?.onEvent) {
      this.eventCallbackDepth += 1;
      try {
        hooks.onEvent(emitted);
      } finally {
        this.eventCallbackDepth -= 1;
      }
    }
  }

  private actionSnapshot(action: InternalCombatAction, status: CombatActionStatus): CombatAction {
    const duration = phaseDuration(action);
    return Object.freeze({
      actionId: action.actionId,
      requestSeq: action.requestSeq,
      actor: action.actor,
      target: action.target,
      actorKey: action.actorKey,
      targetKey: action.targetKey,
      kind: action.kind,
      timings: action.timings,
      priority: action.priority,
      readyAt: action.readyAt,
      speed: action.speed,
      cue: action.cue,
      status,
      phase: action.phase,
      phaseElapsedMs: action.phaseElapsedMs,
      phaseProgress: action.phase === null ? 0 : clamp(action.phaseElapsedMs / duration, 0, 1),
      startedAt: action.startedAt,
      impactEmitted: action.impactEmitted,
    });
  }

  private takeActionId(): number {
    if (!Number.isSafeInteger(this.actionSeq)) throw new RangeError('Combat actionId 已耗尽。');
    return this.actionSeq++;
  }

  private takeRequestSeq(): number {
    if (!Number.isSafeInteger(this.requestSeq)) throw new RangeError('Combat requestSeq 已耗尽。');
    return this.requestSeq++;
  }

  private takeEventSeq(): number {
    if (!Number.isSafeInteger(this.eventSeq)) throw new RangeError('Combat eventSeq 已耗尽。');
    return this.eventSeq++;
  }
}
