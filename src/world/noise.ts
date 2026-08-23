/**
 * 程序化地形噪声：value noise + fbm —— M1 无限世界生成管线的基础。
 * 纯确定性：同 seed 同坐标永远同值。
 */
import { hash2 } from '../core/rng';

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 二维 value noise → [0,1)。 */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const v00 = hash2(ix, iy, seed);
  const v10 = hash2(ix + 1, iy, seed);
  const v01 = hash2(ix, iy + 1, seed);
  const v11 = hash2(ix + 1, iy + 1, seed);
  const sx = smooth(fx);
  const sy = smooth(fy);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

/** 分形叠加（fractal Brownian motion）→ [0,1)。 */
export function fbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  gain = 0.5,
  lacunarity = 2,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
