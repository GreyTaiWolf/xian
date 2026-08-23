/**
 * 存档系统：localStorage + 版本号 + 迁移函数 + 导出/导入 JSON。
 */
import type { GameState } from '../game/state';
import {
  migrateV1toV2,
  migrateV2toV3,
  migrateV3toV4,
  migrateV4toV5,
  migrateV5toV6,
  migrateV6toV7,
  migrateV7toV8,
  migrateV8toV9,
  normalizeV9State,
} from '../game/state';

export const SAVE_KEY = 'cangming-save';
export const SAVE_VERSION = 9;

interface Envelope {
  version: number;
  savedAt: number;
  data: unknown;
}

/** 存档迁移表：旧版本号 → 迁移函数（升级存档时按序执行）。 */
const migrations: Record<number, (data: unknown) => unknown> = {
  1: (d) => migrateV1toV2(d as Parameters<typeof migrateV1toV2>[0]),
  2: (d) => migrateV2toV3(d as GameState),
  3: (d) => migrateV3toV4(d as GameState),
  4: (d) => migrateV4toV5(d as GameState),
  5: (d) => migrateV5toV6(d as GameState),
  6: (d) => migrateV6toV7(d as GameState),
  7: (d) => migrateV7toV8(d as GameState),
  8: (d) => migrateV8toV9(d as GameState),
};

/** 上次存档时间戳（离线快进用）。 */
export function lastSavedAt(): number | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope;
    return Number.isFinite(env.savedAt) && env.savedAt >= 0 ? env.savedAt : null;
  } catch {
    return null;
  }
}

function migrateToCurrent(version: number, data: unknown): GameState | null {
  if (!Number.isInteger(version) || version < 1 || version > SAVE_VERSION || !data) return null;
  let currentVersion = version;
  let currentData = data;
  while (currentVersion < SAVE_VERSION) {
    const migrate = migrations[currentVersion];
    if (!migrate) return null;
    currentData = migrate(currentData);
    currentVersion += 1;
  }
  return normalizeV9State(currentData as GameState);
}

export function saveToLocal(state: GameState): void {
  const env: Envelope = { version: SAVE_VERSION, savedAt: Date.now(), data: state };
  localStorage.setItem(SAVE_KEY, JSON.stringify(env));
}

export function loadFromLocal(): GameState | null {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as Envelope;
    return migrateToCurrent(env.version, env.data);
  } catch {
    return null;
  }
}

export function clearSave(): void {
  localStorage.removeItem(SAVE_KEY);
}

export function exportSave(state: GameState): void {
  const blob = new Blob(
    [JSON.stringify({ version: SAVE_VERSION, savedAt: Date.now(), data: state }, null, 2)],
    { type: 'application/json' },
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cangming-save.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function importSave(file: File): Promise<GameState | null> {
  try {
    const env = JSON.parse(await file.text()) as Envelope;
    return migrateToCurrent(env.version, env.data);
  } catch {
    return null;
  }
}
