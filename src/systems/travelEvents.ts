/**
 * 行路异闻：行走触发两选一事件 —— 有代价、有因果延续、有冷却。
 * 参照问仙（Wenxian_game）的触发/结算管线：候选筛选 → 概率（首程必触发）
 * → 权重抽取 → 扣成本 → 结算（奖励/心境/治疗/战斗）→ 历史/标记/冷却 → 因果延续。
 */
import { config } from '../core/config';
import { bus } from '../core/eventbus';
import type { GameState } from '../game/state';
import { itemTemplate } from '../game/stats';
import type { GameRuntime } from './runtime';

export interface TravelEventOutcome {
  resultText: string;
  rewards?: { xp?: number; money?: number; items?: { item: string; count: number }[] };
  mindDelta?: number;
  healFull?: boolean;
  combat?: { count: number; power: number };
  flags?: Record<string, number>;
  nextEventId?: string;
}

export interface TravelEventChoiceDef {
  id: string;
  label: string;
  description: string;
  cost?: { money?: number; item?: string; count?: number };
  isFallback?: boolean;
  outcome: TravelEventOutcome;
}

export interface TravelEventDef {
  id: string;
  title: string;
  locationName: string;
  description: string;
  weight: number;
  cooldownDays: number;
  choices: TravelEventChoiceDef[];
}

const EVENTS = config.travelEvents.events as unknown as TravelEventDef[];

export function getTravelEventDef(id: string): TravelEventDef | undefined {
  return EVENTS.find((e) => e.id === id);
}

/** 事件抽取（纯函数，rng 可注入测试）。 */
export function pickTravelEvent(state: GameState, rng: () => number): TravelEventDef | null {
  if (state.world.pendingTravelEvent) return null;
  const candidates = EVENTS.filter((e) => (state.world.eventCooldowns[e.id] ?? 0) <= state.world.day);
  if (candidates.length === 0) return null;
  const firstJourney = state.world.travelEventHistory.length === 0;
  const chance = firstJourney ? 1 : config.travelEvents.trigger.chance;
  if (rng() >= chance) return null;
  const total = candidates.reduce((sum, e) => sum + Math.max(1, e.weight), 0);
  let cursor = rng() * total;
  for (const e of candidates) {
    cursor -= Math.max(1, e.weight);
    if (cursor < 0) return e;
  }
  return candidates[candidates.length - 1];
}

/** 选项代价文本。 */
export function choiceCostText(c: TravelEventChoiceDef): string {
  const cost = c.cost;
  if (!cost) return '';
  const parts: string[] = [];
  if (cost.money) parts.push(`灵石 ${cost.money}`);
  if (cost.item) {
    const t = itemTemplate(cost.item);
    parts.push(`${t?.name ?? cost.item}×${cost.count ?? 1}`);
  }
  return parts.join(' · ');
}

/** 玩家是否付得起代价。 */
export function canAffordChoice(rt: GameRuntime, c: TravelEventChoiceDef): boolean {
  const cost = c.cost;
  if (!cost) return true;
  if (cost.money && rt.getState().player.money < cost.money) return false;
  if (cost.item && rt.countItem(cost.item) < (cost.count ?? 1)) return false;
  return true;
}

/** 结算选项（副作用：扣成本、发奖励、写历史与冷却）。 */
export function resolveTravelEvent(rt: GameRuntime, choiceId: string): void {
  const s = rt.getState();
  const pending = s.world.pendingTravelEvent;
  if (!pending) return;
  const def = getTravelEventDef(pending.eventId);
  if (!def) {
    rt.setState((st) => ({ ...st, world: { ...st.world, pendingTravelEvent: null } }));
    rt.log('badl', '这桩行路异闻已不可追溯，你重新踏上前路。');
    return;
  }
  const choice = def.choices.find((c) => c.id === choiceId);
  if (!choice) {
    rt.log('badl', '这个抉择并不属于当前异闻。');
    return;
  }
  if (!canAffordChoice(rt, choice)) {
    rt.log('badl', `资源不足，无法选择「${choice.label}」。`);
    return;
  }

  // 扣成本
  if (choice.cost?.money) rt.addMoney(-choice.cost.money);
  if (choice.cost?.item) rt.removeItemCount(choice.cost.item, choice.cost.count ?? 1);

  // 结算
  const o = choice.outcome;
  if (o.rewards) {
    if (o.rewards.xp) rt.addXp(o.rewards.xp);
    if (o.rewards.money) rt.addMoney(o.rewards.money);
    for (const it of o.rewards.items ?? []) rt.addItem(it.item, it.count);
  }
  if (o.mindDelta) {
    rt.setState((st) => ({
      ...st,
      player: { ...st.player, mind: Math.min(100, Math.max(1, st.player.mind + (o.mindDelta ?? 0))) },
    }));
  }
  if (o.healFull) rt.healFull();
  if (o.combat) {
    rt.spawnWave(o.combat.count, o.combat.power, 'player');
    rt.log('badl', '[异闻] 你惊动了附近的妖兽！');
    rt.sfx?.('realm');
  }

  // 历史 / 标记 / 冷却 / 因果延续
  const day = s.world.day;
  const next = o.nextEventId ? { eventId: o.nextEventId } : null;
  const nextTitle = o.nextEventId ? getTravelEventDef(o.nextEventId)?.title ?? '' : '';
  rt.setState((st) => ({
    ...st,
    world: {
      ...st.world,
      pendingTravelEvent: next,
      travelEventHistory: [`${def.id}:${choice.id}@${day}`, ...st.world.travelEventHistory].slice(0, 40),
      eventFlags: { ...st.world.eventFlags, ...(o.flags ?? {}) },
      eventCooldowns: { ...st.world.eventCooldowns, [def.id]: day + def.cooldownDays },
    },
  }));
  rt.log('c', o.resultText);
  if (next) rt.log('sys', `因果未了：${nextTitle}。`);
  rt.sfx?.('ui');
  bus.emit('worldChanged', null);
}
