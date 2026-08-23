import { createStream, randInt } from '../core/rng';

export const MAX_OFFLINE_WORLD_DAYS = 720;

export interface OfflineCatchUpPlan {
  rawDays: number;
  appliedDays: number;
  capped: boolean;
  elapsedMs: number;
}

/** 将现实离线时长换算为世界日，并设置硬上限避免奖励膨胀和主线程长时间阻塞。 */
export function planOfflineCatchUp(
  savedAt: number,
  now: number,
  dayLengthMs: number,
  maxDays = MAX_OFFLINE_WORLD_DAYS,
): OfflineCatchUpPlan {
  if (!Number.isFinite(savedAt) || !Number.isFinite(now) || !Number.isFinite(dayLengthMs) || dayLengthMs <= 0) {
    throw new Error('离线快进时间参数非法');
  }
  if (!Number.isInteger(maxDays) || maxDays < 0) throw new Error('maxDays 必须是非负整数');
  const elapsedMs = Math.max(0, now - savedAt);
  const rawDays = Math.floor(elapsedMs / dayLengthMs);
  const appliedDays = Math.min(rawDays, maxDays);
  return { rawDays, appliedDays, capped: rawDays > appliedDays, elapsedMs };
}

/** 为离线编年史选择可复现的模板；不使用 Math.random，也不影响其他系统随机流。 */
export function pickOfflineTemplateIndices(
  seed: number,
  startWorldDay: number,
  appliedDays: number,
  templateCount: number,
  maxEntries = 3,
): number[] {
  if (templateCount <= 0 || appliedDays <= 0 || maxEntries <= 0) return [];
  const count = Math.min(Math.floor(appliedDays), Math.floor(maxEntries));
  const indices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = startWorldDay + index;
    const rng = createStream(seed, 0x0ff1ce ^ Math.imul(day, 0x9e3779b9));
    indices.push(randInt(rng, 0, templateCount - 1));
  }
  return indices;
}
