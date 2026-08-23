/** 可存档游戏状态模型 —— 存档 = 此结构的 JSON 序列化。 */
import { config } from '../core/config';

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
}

export interface Settings {
  aiEnabled: boolean;
  apiKey: string;
  directorIntervalDays: number;
  musicVolume: number;
  sfxVolume: number;
}

export interface GameState {
  version: number;
  world: WorldState;
  player: PlayerState;
  inventory: (ItemInstance | null)[];
  equipment: Record<EquipSlot, ItemInstance | null>;
  drops: GroundDrop[];
  settings: Settings;
}

export const INV_SIZE = 32;
/** 世界原点即出生点（等级梯度的参照点） */
export const SPAWN_POS = { x: 0.5, y: 0.5 };

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
    version: 7,
    world: {
      seed: 882345,
      name: '沧溟界',
      day: 1,
      createdAt: Date.now(),
      visited: [],
      chronicle: [{ day: 1, text: '沧溟界初开，天道伊始。', major: false }],
      faction: { tension: 50, sectPower: 60, demonPower: 40 },
      bossDefeated: false,
    },
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
export function migrateV5toV6(d: GameState): GameState {  const withAffixes = (it: ItemInstance | null): ItemInstance | null =>
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
