/**
 * 掉落系统：权重表抽取 + 保底池。
 */
import { config } from '../core/config';
import { randInt } from '../core/rng';

export interface RolledLoot {
  templateId: string;
  count: number;
  plus: number;
}

interface DropEntry {
  item: string;
  weight: number;
  min: number;
  max: number;
}

type DropTables = Record<string, DropEntry[]>;

/** 按权重从掉落表抽取；无表返回 null。 */
export function rollTable(tableId: string, rng: () => number): RolledLoot | null {
  const entries = (config.drops.tables as unknown as DropTables)[tableId];
  if (!entries || entries.length === 0) return null;
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let r = rng() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r <= 0) {
      return { templateId: e.item, count: randInt(rng, e.min, e.max), plus: 0 };
    }
  }
  return null;
}
