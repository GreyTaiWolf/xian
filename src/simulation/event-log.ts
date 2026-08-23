import type { EventPayload, WorldEventRecord, WorldEventType, WorldSimulationState } from './types';

export interface AppendWorldEventInput {
  type: WorldEventType;
  severity: number;
  title: string;
  summary: string;
  sourceSystem: WorldEventRecord['sourceSystem'];
  causeEventIds?: string[];
  actorIds?: string[];
  targetIds?: string[];
  factIds?: string[];
  payload?: EventPayload;
}

const EVENT_LOG_LIMIT = 240;

/** 统一写入世界历史，保证事件编号、时间与因果引用可审计。 */
export function appendWorldEvent(state: WorldSimulationState, input: AppendWorldEventInput): WorldEventRecord {
  const sequence = state.nextEventSequence;
  const event: WorldEventRecord = {
    id: `evt-${sequence.toString().padStart(6, '0')}`,
    sequence,
    atHour: state.clock.totalHours,
    day: Math.floor(state.clock.totalHours / 24) + 1,
    type: input.type,
    severity: Math.min(5, Math.max(1, Math.round(input.severity))),
    title: input.title.slice(0, 80),
    summary: input.summary.slice(0, 320),
    sourceSystem: input.sourceSystem,
    causeEventIds: [...(input.causeEventIds ?? [])],
    actorIds: [...(input.actorIds ?? [])],
    targetIds: [...(input.targetIds ?? [])],
    factIds: [...(input.factIds ?? [])],
    payload: { ...(input.payload ?? {}) },
  };
  state.nextEventSequence += 1;
  state.eventLog.push(event);
  if (state.eventLog.length > EVENT_LOG_LIMIT) {
    state.eventLog.splice(0, state.eventLog.length - EVENT_LOG_LIMIT);
  }
  return event;
}

export function hasActiveCooldown(state: WorldSimulationState, key: string): boolean {
  return (state.eventCooldownUntilHour[key] ?? 0) > state.clock.totalHours;
}

export function setEventCooldown(state: WorldSimulationState, key: string, durationHours: number): void {
  state.eventCooldownUntilHour[key] = state.clock.totalHours + Math.max(1, Math.round(durationHours));
}
