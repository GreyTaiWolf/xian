/**
 * V2 秘境三波试炼状态机。
 *
 * 本模块只管理可序列化的试炼事实，不负责刷怪、计时器、奖励或 UI。
 * GameRuntime 负责生成 runId / encounterId、保存怪物实例 ID，并把死亡事件回传。
 */

export const TRIAL_WAVE_COUNT = 3;

export type TrialStatus = 'active' | 'between' | 'victory' | 'failed';

/** 一次秘境挑战的完整运行态；waveIndex 从 0 开始。 */
export interface TrialRun {
  status: TrialStatus;
  runId: string;
  floor: number;
  waveIndex: number;
  /** 当前波次的唯一标识；尚未开始首波或处于波间时为 null。 */
  encounterId: string | null;
  /** 当前波次实际生成的怪物实例 ID，只统计这里列出的怪物。 */
  trackedMonsterIds: number[];
  /** 当前波次已经确认死亡的怪物实例 ID。 */
  defeatedMonsterIds: number[];
  /** 下一波允许开始的时间；与 GameRuntime 传入的 now 使用同一时钟。 */
  nextWaveAt: number | null;
}

/** 创建尚未绑定首波怪物的新挑战；runId 必须由调用方确定性生成。 */
export function createTrialRun(runId: string, floor: number): TrialRun {
  if (runId.trim().length === 0) throw new Error('Trial runId must not be empty.');
  if (!Number.isInteger(floor) || floor < 1) throw new RangeError('Trial floor must be a positive integer.');

  return {
    status: 'active',
    runId,
    floor,
    waveIndex: 0,
    encounterId: null,
    trackedMonsterIds: [],
    defeatedMonsterIds: [],
    nextWaveAt: null,
  };
}

/**
 * 绑定当前波次实际生成的怪物。
 *
 * 首波可在创建挑战后立即开始；后续波次只有到达 nextWaveAt 后才可开始。
 * 非法、重复或过早的开始请求保持原状态，避免异步回调覆盖正在进行的波次。
 */
export function beginTrialWave(
  run: TrialRun,
  encounterId: string,
  trackedMonsterIds: readonly number[],
  now: number,
): TrialRun {
  if (run.status === 'victory' || run.status === 'failed') return run;
  if (!Number.isFinite(now) || encounterId.trim().length === 0) return run;

  const isFirstWaveReady =
    run.status === 'active' &&
    run.waveIndex === 0 &&
    run.encounterId === null &&
    run.trackedMonsterIds.length === 0;
  const isNextWaveReady =
    run.status === 'between' && run.nextWaveAt !== null && now >= run.nextWaveAt;
  if (!isFirstWaveReady && !isNextWaveReady) return run;

  const uniqueMonsterIds = [...new Set(trackedMonsterIds)];
  if (
    uniqueMonsterIds.length === 0 ||
    uniqueMonsterIds.some((id) => !Number.isSafeInteger(id) || id < 0)
  ) {
    return run;
  }

  return {
    ...run,
    status: 'active',
    encounterId,
    trackedMonsterIds: uniqueMonsterIds,
    defeatedMonsterIds: [],
    nextWaveAt: null,
  };
}

/**
 * 记录一只试炼怪物死亡。
 *
 * 只有 encounterId 与当前波次相同、且怪物 ID 被当前波次追踪时才计数；
 * 重复死亡事件为幂等空操作，大世界怪物及旧波次延迟事件不会污染进度。
 */
export function recordTrialDefeat(
  run: TrialRun,
  encounterId: string,
  monsterId: number,
): TrialRun {
  if (
    run.status !== 'active' ||
    run.encounterId !== encounterId ||
    !run.trackedMonsterIds.includes(monsterId) ||
    run.defeatedMonsterIds.includes(monsterId)
  ) {
    return run;
  }

  return {
    ...run,
    defeatedMonsterIds: [...run.defeatedMonsterIds, monsterId],
  };
}

/** 当前波次是否已经完整击败；空波次永远不能自动推进。 */
export function canAdvanceTrialWave(run: TrialRun): boolean {
  if (
    run.status !== 'active' ||
    run.encounterId === null ||
    run.trackedMonsterIds.length === 0
  ) {
    return false;
  }

  const defeated = new Set(run.defeatedMonsterIds);
  return run.trackedMonsterIds.every((monsterId) => defeated.has(monsterId));
}

/**
 * 结算已清空的当前波次。
 *
 * 前两波进入波间过场，并写入下一波的绝对开始时间；第三波清空后直接胜利。
 * nextWaveAt 由调用方计算，因而状态机不读取系统时间且可以确定性测试。
 */
export function advanceTrialWave(run: TrialRun, nextWaveAt: number): TrialRun {
  if (!canAdvanceTrialWave(run)) return run;

  if (run.waveIndex >= TRIAL_WAVE_COUNT - 1) {
    return {
      ...run,
      status: 'victory',
      nextWaveAt: null,
    };
  }

  if (!Number.isFinite(nextWaveAt)) return run;
  return {
    ...run,
    status: 'between',
    waveIndex: run.waveIndex + 1,
    encounterId: null,
    trackedMonsterIds: [],
    defeatedMonsterIds: [],
    nextWaveAt,
  };
}

/** 将仍在进行或等待下一波的挑战标记为失败；已经胜利的结果不可被迟到事件覆盖。 */
export function failTrial(run: TrialRun): TrialRun {
  if (run.status === 'victory' || run.status === 'failed') return run;
  return {
    ...run,
    status: 'failed',
    nextWaveAt: null,
  };
}

/** 统一的秘境通关判定，奖励层只应以此结果为准。 */
export function isTrialCleared(run: TrialRun): boolean {
  return run.status === 'victory';
}
