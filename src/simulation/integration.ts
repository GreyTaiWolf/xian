import { createInitialWorldSimulation } from './state';
import { advanceWorldHours, type SimulationAdvanceResult } from './tick';
import type { WorldEventRecord, WorldSimulationState } from './types';
import { cloneSimulationState } from './utils';

export const SIMULATION_HOURS_PER_WORLD_DAY = 24;
const ADVANCE_CHUNK_DAYS = 365;
const MAX_ADVANCE_DAYS = 100_000;
const EMITTED_EVENT_LIMIT = 240;

/** 将模拟时钟映射到旧玩法使用的世界日编号。 */
export function simulationWorldDay(state: WorldSimulationState): number {
  return Math.floor(state.clock.totalHours / SIMULATION_HOURS_PER_WORLD_DAY) + 1;
}

function assertWorldDays(days: number, field = 'days'): void {
  if (!Number.isInteger(days) || days < 0 || days > MAX_ADVANCE_DAYS) {
    throw new Error(`${field} 必须是 0 到 ${MAX_ADVANCE_DAYS} 之间的整数`);
  }
}

/**
 * 按“游戏世界日”推进模拟。内部按年分块，避免一次调用超过底层小时推进上限。
 * 输入状态保持不变，新增事件只保留最近 240 条供调用方消费。
 */
export function advanceSimulationWorldDays(
  input: WorldSimulationState,
  days: number,
): SimulationAdvanceResult {
  assertWorldDays(days);
  let state = cloneSimulationState(input);
  const emittedEvents: WorldEventRecord[] = [];
  let remaining = days;
  while (remaining > 0) {
    const chunkDays = Math.min(ADVANCE_CHUNK_DAYS, remaining);
    const result = advanceWorldHours(state, chunkDays * SIMULATION_HOURS_PER_WORLD_DAY);
    state = result.state;
    emittedEvents.push(...result.emittedEvents);
    if (emittedEvents.length > EMITTED_EVENT_LIMIT) {
      emittedEvents.splice(0, emittedEvents.length - EMITTED_EVENT_LIMIT);
    }
    remaining -= chunkDays;
  }
  return { state, emittedEvents };
}

/** 创建并确定性快进到指定旧世界日，用于新档与 v8 存档迁移。 */
export function createSimulationAtWorldDay(seed: number, worldDay: number): WorldSimulationState {
  if (!Number.isInteger(worldDay) || worldDay < 1 || worldDay > MAX_ADVANCE_DAYS + 1) {
    throw new Error(`worldDay 必须是 1 到 ${MAX_ADVANCE_DAYS + 1} 之间的整数`);
  }
  const initial = createInitialWorldSimulation(seed);
  return worldDay === 1 ? initial : advanceSimulationWorldDays(initial, worldDay - 1).state;
}

function isUsableSimulation(value: unknown): value is WorldSimulationState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorldSimulationState>;
  return (
    candidate.schemaVersion === 1 &&
    Number.isInteger(candidate.seed) &&
    !!candidate.clock &&
    Number.isInteger(candidate.clock.totalHours) &&
    candidate.clock.totalHours >= 0 &&
    !!candidate.regions &&
    !!candidate.settlements &&
    !!candidate.factions &&
    !!candidate.species &&
    Array.isArray(candidate.eventLog)
  );
}

/**
 * 读档安全归一：缺失、损坏、种子不符或时间超前时重建；落后时只向前推进。
 * 世界模拟不允许倒放，以免已发生事件和市场状态出现反因果。
 */
export function synchronizeSimulationToWorldDay(
  input: unknown,
  seed: number,
  worldDay: number,
): WorldSimulationState {
  if (!Number.isInteger(worldDay) || worldDay < 1) throw new Error('worldDay 必须是正整数');
  if (!isUsableSimulation(input) || input.seed !== (seed >>> 0)) {
    return createSimulationAtWorldDay(seed, worldDay);
  }
  const currentDay = simulationWorldDay(input);
  if (currentDay > worldDay) return createSimulationAtWorldDay(seed, worldDay);
  if (currentDay < worldDay) return advanceSimulationWorldDays(input, worldDay - currentDay).state;
  return cloneSimulationState(input);
}
