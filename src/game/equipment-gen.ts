/**
 * 词条生成器：按品级词条数区间 + 词条池权重 + 境界缩放系数生成随机词条。
 * 对应 docs/balance.md §词条。
 */
import { config } from '../core/config';
import { randInt } from '../core/rng';
import type { ItemAffix } from './state';
import { gradeDef } from './stats';

export function generateAffixes(gradeId: string, srcTier: number, rng: () => number): ItemAffix[] {
  const g = gradeDef(gradeId);
  if (!g) return [];
  const count = randInt(rng, g.affixCount[0], g.affixCount[1]);
  if (count <= 0) return [];
  const pool = config.affixes.pools;
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  const scale = Math.pow(config.affixes.valueScalePerTier, Math.max(0, srcTier));
  const out: ItemAffix[] = [];
  for (let i = 0; i < count; i++) {
    let r = rng() * total;
    let picked = pool[0];
    for (const p of pool) {
      r -= p.weight;
      if (r <= 0) {
        picked = p;
        break;
      }
    }
    const raw = (picked.min + rng() * (picked.max - picked.min)) * g.affixCoeff * scale;
    const value = picked.stat === 'spd' ? Math.round(raw * 10) / 10 : Math.round(raw);
    if (value > 0) out.push({ stat: picked.stat, value });
  }
  return out;
}
