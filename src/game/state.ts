/** 可存档游戏状态模型 —— 存档 = 此结构的 JSON 序列化。 */
import { config } from '../core/config';
import { createSimulationAtWorldDay, synchronizeSimulationToWorldDay } from '../simulation/integration';
import { createInitialWorldSimulation } from '../simulation/state';
import type { WorldSimulationState } from '../simulation/types';

export type EquipSlot = 'weapon' | 'head' | 'body' | 'hands' | 'feet' | 'trinket1' | 'trinket2';

/** 装备随机词条（品级决定数量，境界决定缩放）。 */
export interface ItemAffix {
  stat: string;
  value: number;
}

export interface ItemInstance {
  uid: number;
  templateId: string;
  /** 堆叠数量（装备恒为 1） */
  count: number;
  /** 强化等级（装备） */
  plus: number;
  /** 随机词条（装备） */
  affixes: ItemAffix[];
}

export interface GroundDrop {
  uid: number;
  templateId: string;
  count: number;
  plus: number;
  affixes: ItemAffix[];
  x: number;
  y: number;
}

/** 秘境进度与待领取奖励；奖励候选入档，避免背包满或刷新页面后丢失。 */
export interface RealmProgress {
  highestCleared: number;
  totalClears: number;
  readyDay: number;
  pendingRewards: ItemInstance[];
}

export interface PlayerBase {
  hpMax: number;
  mpMax: number;
  atk: number;
  def: number;
  spd: number;
  crit: number;
  luck: number;
}

export interface QuestState {
  id: string;
  progress: number;
  claimed: boolean;
}

export interface PlayerState {
  name: string;
  level: number;
  xp: number;
  hp: number;
  mp: number;
  money: number;
  kills: number;
  /** 掉落保底计数（达到阈值触发保底掉落） */
  pity: number;
  pos: { x: number; y: number };
  base: PlayerBase;
  /** 宗门（null = 散修） */
  sectId: string | null;
  contribution: number;
  quests: QuestState[];
  /** 飞升（转世）次数：每次基础属性 +15% */
  ascension: number;
  /** 心境 0~100：影响突破成功率，死亡/失败下降 */
  mind: number;
  /** 悟性 0~100：影响突破成功率 */
  insight: number;
  /** 已达成成就 id 列表 */
  achievements: string[];
  /** 新手引导是否完成 */
  tutorialDone: boolean;
  /** 主线阶段索引（见 config/quests.json mainStages） */
  mainQuestStage: number;
}

export interface ChronicleEntry {
  day: number;
  text: string;
  major: boolean;
}

export interface FactionState {
  /** 正魔紧张度 0~100 */
  tension: number;
  /** 青云剑宗势力 0~100 */
  sectPower: number;
  /** 血煞魔教势力 0~100 */
  demonPower: number;
}

export interface WorldState {
  seed: number;
  name: string;
  day: number;
  createdAt: number;
  /** 已访问的 chunk 列表（地图图集展示） */
  visited: string[];
  /** 天道编年史（M2 起由 AI 书写，降级时由模板填充） */
  chronicle: ChronicleEntry[];
  /** 势力态势（天道导演的决策对象） */
  faction: FactionState;
  /** 世界首领是否已被斩杀（首杀唯一奖励） */
  bossDefeated: boolean;
  /** 待处理的行路异闻（null = 无） */
  pendingTravelEvent: { eventId: string } | null;
  /** 异闻历史：`事件id:选项id@世界日`，上限 40 */
  travelEventHistory: string[];
  /** 剧情分支标记 */
  eventFlags: Record<string, number>;
  /** 异闻冷却：事件id → 可再次触发的最早世界日 */
  eventCooldowns: Record<string, number>;
  /** 是否已进入过秘境（主线判定） */
  realmEntered: boolean;
  /** V2 三波秘境的持久进度。 */
  realmProgress: RealmProgress;
}

export interface Settings {
  aiEnabled: boolean;
  apiKey: string;
  directorIntervalDays: number;
  musicVolume: number;
  sfxVolume: number;
  /** 自动在合法时机施展已解锁技能。 */
  autoSkills: boolean;
  /** 战斗表现速度；结算顺序不变。 */
  combatSpeed: 1 | 2;
}

export interface GameState {
  version: number;
  world: WorldState;
  simulation: WorldSimulationState;
  player: PlayerState;
  inventory: (ItemInstance | null)[];
  equipment: Record<EquipSlot, ItemInstance | null>;
  drops: GroundDrop[];
  settings: Settings;
}

export const INV_SIZE = 32;
/** 世界原点即出生点（等级梯度的参照点） */
export const SPAWN_POS = { x: 0.5, y: 0.5 };
export const DEFAULT_WORLD_SEED = 882345;

let uidCounter = Date.now() % 900000;
export function nextUid(): number {
  uidCounter += 1;
  return uidCounter;
}

export function emptyInventory(): (ItemInstance | null)[] {
  return Array.from({ length: INV_SIZE }, () => null);
}

export function emptyEquipment(): Record<EquipSlot, ItemInstance | null> {
  return { weapon: null, head: null, body: null, hands: null, feet: null, trinket1: null, trinket2: null };
}

function starterInventory(): (ItemInstance | null)[] {
  const inv = emptyInventory();
  inv[0] = { uid: nextUid(), templateId: 'wood_sword', count: 1, plus: 0, affixes: [] };
  inv[1] = { uid: nextUid(), templateId: 'cloth_robe', count: 1, plus: 0, affixes: [] };
  inv[2] = { uid: nextUid(), templateId: 'hp_pill', count: 5, plus: 0, affixes: [] };
  inv[3] = { uid: nextUid(), templateId: 'portal_fu', count: 2, plus: 0, affixes: [] };
  return inv;
}

export function initialQuests(): QuestState[] {
  return config.quests.quests.map((q) => ({ id: q.id, progress: 0, claimed: false }));
}

export function defaultState(): GameState {
  return {
    version: 10,
    world: {
      seed: DEFAULT_WORLD_SEED,
      name: '沧溟界',
      day: 1,
      createdAt: Date.now(),
      visited: [],
      chronicle: [{ day: 1, text: '沧溟界初开，天道伊始。', major: false }],
      faction: { tension: 50, sectPower: 60, demonPower: 40 },
      bossDefeated: false,
      pendingTravelEvent: null,
      travelEventHistory: [],
      eventFlags: {},
      eventCooldowns: {},
      realmEntered: false,
      realmProgress: { highestCleared: 0, totalClears: 0, readyDay: 1, pendingRewards: [] },
    },
    simulation: createInitialWorldSimulation(DEFAULT_WORLD_SEED),
    player: {
      name: '林道玄',
      level: 1,
      xp: 0,
      hp: 100,
      mp: 50,
      money: 100,
      kills: 0,
      pity: 0,
      pos: { ...SPAWN_POS },
      base: { hpMax: 100, mpMax: 50, atk: 10, def: 4, spd: 6, crit: 5, luck: 5 },
      sectId: null,
      contribution: 0,
      quests: initialQuests(),
      ascension: 0,
      mind: 60,
      insight: 30,
      achievements: [],
      tutorialDone: false,
      mainQuestStage: 0,
    },
    inventory: starterInventory(),
    equipment: emptyEquipment(),
    drops: [],
    settings: {
      aiEnabled: true,
      apiKey: '',
      directorIntervalDays: 1,
      musicVolume: 70,
      sfxVolume: 85,
      autoSkills: true,
      combatSpeed: 1,
    },
  };
}

/** v1 → v2 迁移：老存档补全 M0 字段（保留名字/灵石）。 */
export function migrateV1toV2(d: {
  world?: { seed?: number; name?: string; day?: number; createdAt?: number };
  player?: { name?: string; money?: number };
  settings?: Partial<Settings>;
}): GameState {
  const base = defaultState();
  return {
    ...base,
    version: 2,
    world: {
      ...base.world,
      seed: d.world?.seed ?? base.world.seed,
      name: d.world?.name ?? base.world.name,
      day: d.world?.day ?? base.world.day,
      createdAt: d.world?.createdAt ?? base.world.createdAt,
    },
    player: {
      ...base.player,
      name: d.player?.name ?? base.player.name,
      money: d.player?.money ?? base.player.money,
    },
    settings: { ...base.settings, ...(d.settings ?? {}) },
  };
}

/** v2 → v3 迁移：世界改为无限 chunk（位置重置到原点，清空旧地图掉落）。 */
export function migrateV2toV3(d: GameState): GameState {
  return {
    ...d,
    version: 3,
    world: { ...d.world, visited: [] },
    player: {
      ...d.player,
      pos: { ...SPAWN_POS },
      hp: d.player.base.hpMax,
      mp: d.player.base.mpMax,
    },
    drops: [],
  };
}

/** v3 → v4 迁移：补编年史与势力态势。 */
export function migrateV3toV4(d: GameState): GameState {
  return {
    ...d,
    version: 4,
    world: {
      ...d.world,
      chronicle: d.world.chronicle ?? [{ day: d.world.day, text: '沧溟界初开，天道伊始。', major: false }],
      faction: d.world.faction ?? { tension: 50, sectPower: 60, demonPower: 40 },
    },
  };
}

/** v4 → v5 迁移：补宗门/贡献/任务/转世。 */
export function migrateV4toV5(d: GameState): GameState {
  return {
    ...d,
    version: 5,
    player: {
      ...d.player,
      sectId: d.player.sectId ?? null,
      contribution: d.player.contribution ?? 0,
      quests: d.player.quests ?? initialQuests(),
      ascension: d.player.ascension ?? 0,
    },
  };
}

/** v5 → v6 迁移：物品实例补词条字段；玩家补心境/悟性。 */
export function migrateV5toV6(d: GameState): GameState {
  const withAffixes = (it: ItemInstance | null): ItemInstance | null =>
    it ? { ...it, affixes: it.affixes ?? [] } : null;
  return {
    ...d,
    version: 6,
    player: {
      ...d.player,
      mind: d.player.mind ?? 60,
      insight: d.player.insight ?? 30,
    },
    inventory: d.inventory.map(withAffixes),
    equipment: {
      weapon: withAffixes(d.equipment.weapon),
      head: withAffixes(d.equipment.head),
      body: withAffixes(d.equipment.body),
      hands: withAffixes(d.equipment.hands),
      feet: withAffixes(d.equipment.feet),
      trinket1: withAffixes(d.equipment.trinket1),
      trinket2: withAffixes(d.equipment.trinket2),
    },
    drops: d.drops.map((g) => ({ ...g, affixes: g.affixes ?? [] })),
  };
}

/** v6 → v7 迁移：补成就/新手引导/首领首杀标记。 */
export function migrateV6toV7(d: GameState): GameState {
  return {
    ...d,
    version: 7,
    world: { ...d.world, bossDefeated: d.world.bossDefeated ?? false },
    player: {
      ...d.player,
      achievements: d.player.achievements ?? [],
      tutorialDone: d.player.tutorialDone ?? false,
    },
  };
}

/** v7 → v8 迁移：补行路异闻状态与主线阶段。 */
export function migrateV7toV8(d: GameState): GameState {
  return {
    ...d,
    version: 8,
    world: {
      ...d.world,
      pendingTravelEvent: d.world.pendingTravelEvent ?? null,
      travelEventHistory: d.world.travelEventHistory ?? [],
      eventFlags: d.world.eventFlags ?? {},
      eventCooldowns: d.world.eventCooldowns ?? {},
      realmEntered: d.world.realmEntered ?? false,
    },
    player: { ...d.player, mainQuestStage: d.player.mainQuestStage ?? 0 },
  };
}

/** v8 → v9 迁移：建立与旧世界日、世界种子同步的动态世界状态。 */
export function migrateV8toV9(d: GameState): GameState {
  const legacy = d as GameState & { simulation?: unknown };
  return {
    ...d,
    version: 9,
    simulation: synchronizeSimulationToWorldDay(legacy.simulation, d.world.seed, d.world.day),
  };
}

/** v9 读档归一：修复缺失、损坏、种子不符或时钟失步的模拟状态。 */
export function normalizeV9State(d: GameState): GameState {
  return {
    ...d,
    version: 9,
    simulation: synchronizeSimulationToWorldDay(d.simulation, d.world.seed, d.world.day),
  };
}

function finiteInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePendingRealmRewards(value: unknown): ItemInstance[] {
  if (!Array.isArray(value)) return [];

  const templates = new Map(config.items.items.map((item) => [item.id, item]));
  const affixStats = new Set(config.affixes.pools.map((affix) => affix.stat));
  const maxCandidates = Math.max(1, ...config.trials.floors.map((floor) => floor.pickCount));
  const seenUids = new Set<number>();
  const rewards: ItemInstance[] = [];

  for (const raw of value) {
    if (rewards.length >= maxCandidates) break;
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.templateId !== 'string') continue;
    const template = templates.get(candidate.templateId);
    if (!template) continue;

    let uid =
      typeof candidate.uid === 'number' && Number.isSafeInteger(candidate.uid) && candidate.uid > 0
        ? candidate.uid
        : nextUid();
    while (seenUids.has(uid)) uid = nextUid();
    seenUids.add(uid);

    const equipment = template.type === 'weapon' || template.type === 'armor';
    const affixes: ItemAffix[] = [];
    if (equipment && Array.isArray(candidate.affixes)) {
      for (const rawAffix of candidate.affixes.slice(0, 8)) {
        if (!rawAffix || typeof rawAffix !== 'object') continue;
        const affix = rawAffix as Record<string, unknown>;
        if (
          typeof affix.stat !== 'string' ||
          !affixStats.has(affix.stat) ||
          typeof affix.value !== 'number' ||
          !Number.isFinite(affix.value) ||
          affix.value <= 0
        ) {
          continue;
        }
        affixes.push({ stat: affix.stat, value: Math.min(1_000_000, affix.value) });
      }
    }

    rewards.push({
      uid,
      templateId: template.id,
      count: finiteInteger(candidate.count, 1, 1, template.stack),
      plus: equipment ? finiteInteger(candidate.plus, 0, 0, 5) : 0,
      affixes,
    });
  }
  return rewards;
}

/** v9 → v10：补齐三波秘境进度、自动技能与战斗速度。 */
export function migrateV9toV10(d: GameState): GameState {
  const normalized = normalizeV9State(d);
  const legacyWorld = normalized.world as WorldState & { realmProgress?: unknown };
  const realmProgress =
    legacyWorld.realmProgress && typeof legacyWorld.realmProgress === 'object'
      ? (legacyWorld.realmProgress as unknown as Record<string, unknown>)
      : {};
  const legacySettings = normalized.settings as Settings & {
    autoSkills?: unknown;
    combatSpeed?: unknown;
  };
  return {
    ...normalized,
    version: 10,
    world: {
      ...normalized.world,
      realmProgress: {
        highestCleared: finiteInteger(
          realmProgress.highestCleared,
          0,
          0,
          config.trials.floors.length,
        ),
        totalClears: finiteInteger(realmProgress.totalClears, 0, 0, Number.MAX_SAFE_INTEGER),
        readyDay: finiteInteger(realmProgress.readyDay, 1, 1, Number.MAX_SAFE_INTEGER),
        pendingRewards: normalizePendingRealmRewards(realmProgress.pendingRewards),
      },
    },
    settings: {
      ...normalized.settings,
      autoSkills: typeof legacySettings.autoSkills === 'boolean' ? legacySettings.autoSkills : true,
      combatSpeed: legacySettings.combatSpeed === 2 ? 2 : 1,
    },
  };
}

/** v10 读档归一：修复新增字段并继续保持动态世界时钟一致。 */
export function normalizeV10State(d: GameState): GameState {
  const migrated = migrateV9toV10({ ...d, version: 9 });
  return {
    ...migrated,
    version: 10,
    simulation: synchronizeSimulationToWorldDay(migrated.simulation, migrated.world.seed, migrated.world.day),
  };
}

/** 新建世界时同时建立对应种子的动态模拟。 */
export function createWorldSimulation(seed: number, worldDay = 1): WorldSimulationState {
  return createSimulationAtWorldDay(seed, worldDay);
}
