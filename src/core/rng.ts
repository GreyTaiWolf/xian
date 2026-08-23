/**
 * 可播种随机数系统 —— 一切随机必须经由它，保证世界可复现。
 * 铁律：AI 不产生随机数；随机只来自 seed 派生的流。
 */

export type Rng = () => number;

/** mulberry32：小巧、稳定、跨平台一致。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二维整数哈希 → [0,1)，用于确定性地形等（M1 主力）。 */
export function hash2(x: number, y: number, seed: number): number {
  let h =
    (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 由主种子派生独立随机流（不同系统互不干扰）。 */
export function createStream(seed: number, salt: number): Rng {
  return mulberry32((seed ^ Math.imul(salt | 0, 0x9e3779b9)) >>> 0);
}

/** [min, max] 闭区间整数。 */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
