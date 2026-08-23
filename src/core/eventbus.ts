/**
 * 事件总线 —— 模块之间只通过事件通信（战斗事件 → 日志/音效/成就）。
 */

type Handler<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    const set = this.handlers.get(type) ?? new Set<Handler<never>>();
    set.add(fn as Handler<never>);
    this.handlers.set(type, set);
    return () => set.delete(fn as Handler<never>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as Handler<Events[K]>)(payload));
  }
}

export type LogCls = 'c' | 'gold' | 'sys' | 'badl' | 'lootL';

import type { HudData } from '../systems/runtime';

/** 全游戏事件表。 */
export interface GameEvents {
  /** 世界日边界 —— 天道 AI 导演的触发点（M2 接入） */
  dayBoundary: { day: number };
  /** 日志行（主界面日志面板订阅渲染） */
  log: { cls: LogCls; text: string };
  /** 新建世界完成 */
  worldCreated: { seed: number; name: string };
  /** HUD 热数据（4Hz，供角色卡等高频刷新） */
  hud: HudData;
  /** 背包内容变化（面板刷新） */
  inventoryChanged: null;
  /** 装备变化（面板刷新、属性重算显示） */
  equipmentChanged: null;
  /** 世界可见状态变化：玩家位置/地面掉落（地图面板刷新） */
  worldChanged: null;
}

export const bus = new EventBus<GameEvents>();
