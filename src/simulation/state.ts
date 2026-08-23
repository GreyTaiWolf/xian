import { createStream, randInt } from '../core/rng';
import { appendWorldEvent } from './event-log';
import type {
  FactionState,
  ImportantCharacterState,
  RegionState,
  SettlementState,
  SpeciesPopulationState,
  WorldFact,
  WorldSimulationState,
} from './types';
import { createMarket, createNeutralRelationship } from './utils';

function createRegions(seed: number): Record<string, RegionState> {
  const rng = createStream(seed, 0x1001);
  return {
    border_plains: {
      id: 'border_plains',
      name: '青河平原',
      biome: 'temperate_plains',
      tier: 'region',
      fertility: randInt(rng, 66, 78),
      danger: randInt(rng, 22, 34),
      temperature: 16,
      rainfall: 58,
      humanPressure: 42,
      controllerFactionId: 'frontier_lordship',
      settlementIds: ['green_river_town'],
      speciesIds: ['wild_boar'],
    },
    north_forest: {
      id: 'north_forest',
      name: '北境寒林',
      biome: 'cold_forest',
      tier: 'region',
      fertility: randInt(rng, 38, 49),
      danger: randInt(rng, 58, 72),
      temperature: 3,
      rainfall: 64,
      humanPressure: 25,
      controllerFactionId: 'wanderer_guild',
      settlementIds: ['northwatch_camp'],
      speciesIds: ['snow_deer', 'frost_wolf'],
    },
    iron_hills: {
      id: 'iron_hills',
      name: '黑石丘陵',
      biome: 'rocky_hills',
      tier: 'region',
      fertility: randInt(rng, 24, 36),
      danger: randInt(rng, 38, 52),
      temperature: 11,
      rainfall: 34,
      humanPressure: 67,
      controllerFactionId: 'merchant_union',
      settlementIds: ['blackstone_city'],
      speciesIds: ['stone_lizard'],
    },
    mist_marsh: {
      id: 'mist_marsh',
      name: '迷雾沼泽',
      biome: 'marsh',
      tier: 'region',
      fertility: randInt(rng, 48, 60),
      danger: randInt(rng, 62, 78),
      temperature: 20,
      rainfall: 84,
      humanPressure: 12,
      controllerFactionId: 'wanderer_guild',
      settlementIds: [],
      speciesIds: ['spirit_moth'],
    },
  };
}

function createSettlements(seed: number): Record<string, SettlementState> {
  const rng = createStream(seed, 0x2002);
  return {
    green_river_town: {
      id: 'green_river_town',
      name: '青河镇',
      regionId: 'border_plains',
      factionId: 'frontier_lordship',
      population: randInt(rng, 1280, 1480),
      workforceRatio: 0.55,
      stability: 66,
      prosperity: 46,
      resources: { food: 15000, timber: 4200, ore: 850, medicine: 510 },
      market: createMarket({ food: 8, timber: 12, ore: 24, medicine: 38 }),
    },
    blackstone_city: {
      id: 'blackstone_city',
      name: '黑石城',
      regionId: 'iron_hills',
      factionId: 'merchant_union',
      population: randInt(rng, 4300, 4700),
      workforceRatio: 0.58,
      stability: 58,
      prosperity: 72,
      resources: { food: 26000, timber: 7600, ore: 9200, medicine: 1200 },
      market: createMarket({ food: 9, timber: 13, ore: 18, medicine: 42 }),
    },
    northwatch_camp: {
      id: 'northwatch_camp',
      name: '北望营地',
      regionId: 'north_forest',
      factionId: 'wanderer_guild',
      population: randInt(rng, 430, 560),
      workforceRatio: 0.62,
      stability: 52,
      prosperity: 31,
      resources: { food: 2600, timber: 3200, ore: 390, medicine: 260 },
      market: createMarket({ food: 11, timber: 9, ore: 28, medicine: 46 }),
    },
  };
}

function createFactions(): Record<string, FactionState> {
  return {
    frontier_lordship: {
      id: 'frontier_lordship',
      name: '边境领主府',
      kind: 'lordship',
      treasury: 148000,
      militaryPower: 72,
      influence: 68,
      tension: 54,
      goals: ['维持边境秩序', '确保粮税与军需'],
      relations: {
        merchant_union: { trust: 18, hostility: 22, trade: 66 },
        wanderer_guild: { trust: 42, hostility: 8, trade: 36 },
      },
    },
    merchant_union: {
      id: 'merchant_union',
      name: '四方商盟',
      kind: 'merchant',
      treasury: 310000,
      militaryPower: 28,
      influence: 82,
      tension: 61,
      goals: ['控制边境贸易路线', '提高粮食与矿石利润'],
      relations: {
        frontier_lordship: { trust: 18, hostility: 22, trade: 66 },
        wanderer_guild: { trust: 30, hostility: 12, trade: 54 },
      },
    },
    wanderer_guild: {
      id: 'wanderer_guild',
      name: '行者公会',
      kind: 'guild',
      treasury: 76000,
      militaryPower: 49,
      influence: 51,
      tension: 37,
      goals: ['维护北境道路', '调查怪物迁徙'],
      relations: {
        frontier_lordship: { trust: 42, hostility: 8, trade: 36 },
        merchant_union: { trust: 30, hostility: 12, trade: 54 },
      },
    },
  };
}

function createSpecies(seed: number): Record<string, SpeciesPopulationState> {
  const rng = createStream(seed, 0x3003);
  return {
    snow_deer: {
      id: 'snow_deer',
      name: '雪角鹿',
      regionId: 'north_forest',
      population: randInt(rng, 170, 210),
      carryingCapacity: 260,
      foodSupply: 56,
      aggression: 4,
      migrationPressure: 34,
      diseaseLevel: 6,
      humanHostility: 12,
      preySpeciesIds: [],
      predatorSpeciesIds: ['frost_wolf'],
    },
    frost_wolf: {
      id: 'frost_wolf',
      name: '霜牙狼',
      regionId: 'north_forest',
      population: randInt(rng, 68, 86),
      carryingCapacity: 112,
      foodSupply: 43,
      aggression: 68,
      migrationPressure: 58,
      diseaseLevel: 3,
      humanHostility: 61,
      preySpeciesIds: ['snow_deer'],
      predatorSpeciesIds: [],
    },
    wild_boar: {
      id: 'wild_boar',
      name: '棕鬃野猪',
      regionId: 'border_plains',
      population: randInt(rng, 94, 126),
      carryingCapacity: 170,
      foodSupply: 62,
      aggression: 42,
      migrationPressure: 28,
      diseaseLevel: 4,
      humanHostility: 36,
      preySpeciesIds: [],
      predatorSpeciesIds: [],
    },
    stone_lizard: {
      id: 'stone_lizard',
      name: '岩甲蜥',
      regionId: 'iron_hills',
      population: randInt(rng, 44, 66),
      carryingCapacity: 92,
      foodSupply: 51,
      aggression: 57,
      migrationPressure: 39,
      diseaseLevel: 2,
      humanHostility: 45,
      preySpeciesIds: [],
      predatorSpeciesIds: [],
    },
    spirit_moth: {
      id: 'spirit_moth',
      name: '雾灵蛾',
      regionId: 'mist_marsh',
      population: randInt(rng, 320, 410),
      carryingCapacity: 540,
      foodSupply: 74,
      aggression: 8,
      migrationPressure: 16,
      diseaseLevel: 9,
      humanHostility: 3,
      preySpeciesIds: [],
      predatorSpeciesIds: [],
    },
  };
}

function createFacts(): Record<string, WorldFact> {
  return {
    fact_north_beasts: {
      id: 'fact_north_beasts',
      text: '北境野兽最近正在向南活动。',
      visibility: 'rumor',
      regionId: 'north_forest',
      sourceEventId: null,
    },
    fact_border_harvest: {
      id: 'fact_border_harvest',
      text: '青河平原今年的收成比往年差。',
      visibility: 'public',
      regionId: 'border_plains',
      sourceEventId: null,
    },
    fact_merchant_hoarding: {
      id: 'fact_merchant_hoarding',
      text: '四方商盟的一名执事正在秘密囤积粮食。',
      visibility: 'secret',
      regionId: 'iron_hills',
      sourceEventId: null,
    },
    fact_ruins_abnormal: {
      id: 'fact_ruins_abnormal',
      text: '迷雾沼泽深处的古代遗迹出现了异常灵光。',
      visibility: 'private',
      regionId: 'mist_marsh',
      sourceEventId: null,
    },
  };
}

function createCharacters(): Record<string, ImportantCharacterState> {
  const playerRelation = createNeutralRelationship();
  return {
    npc_ranger_mei: {
      id: 'npc_ranger_mei',
      name: '梅岚',
      alive: true,
      role: '北境巡林者',
      regionId: 'north_forest',
      settlementId: 'northwatch_camp',
      factionId: 'wanderer_guild',
      personality: { courage: 74, caution: 63, compassion: 58, ambition: 24 },
      currentGoalIds: ['调查霜牙狼迁徙'],
      relationships: { player: { ...playerRelation } },
      knowledge: {
        knownFactIds: ['fact_north_beasts', 'fact_border_harvest'],
        secretFactIds: ['fact_ruins_abnormal'],
      },
      memories: [],
    },
    npc_merchant_qiao: {
      id: 'npc_merchant_qiao',
      name: '乔闻山',
      alive: true,
      role: '四方商盟执事',
      regionId: 'iron_hills',
      settlementId: 'blackstone_city',
      factionId: 'merchant_union',
      personality: { courage: 38, caution: 76, greed: 82, ambition: 71 },
      currentGoalIds: ['扩大粮食差价'],
      relationships: { player: { ...playerRelation } },
      knowledge: {
        knownFactIds: ['fact_border_harvest'],
        secretFactIds: ['fact_merchant_hoarding'],
      },
      memories: [],
    },
    npc_captain_ren: {
      id: 'npc_captain_ren',
      name: '任骁',
      alive: true,
      role: '青河镇守备队长',
      regionId: 'border_plains',
      settlementId: 'green_river_town',
      factionId: 'frontier_lordship',
      personality: { courage: 78, caution: 48, loyalty: 84, ambition: 36 },
      currentGoalIds: ['稳定青河镇治安'],
      relationships: { player: { ...playerRelation } },
      knowledge: {
        knownFactIds: ['fact_north_beasts', 'fact_border_harvest'],
        secretFactIds: [],
      },
      memories: [],
    },
  };
}

/** 建立首个边境行省模拟切片；相同种子必须产生完全相同的状态。 */
export function createInitialWorldSimulation(seed: number): WorldSimulationState {
  const state: WorldSimulationState = {
    schemaVersion: 1,
    seed: seed >>> 0,
    clock: { year: 1, season: 'spring', dayOfSeason: 1, hour: 6, totalHours: 6 },
    cadence: { lastDailyTick: 0, lastMonthlyTick: 0 },
    regions: createRegions(seed),
    settlements: createSettlements(seed),
    factions: createFactions(),
    species: createSpecies(seed),
    characters: createCharacters(),
    facts: createFacts(),
    eventLog: [],
    nextEventSequence: 1,
    eventCooldownUntilHour: {},
  };
  appendWorldEvent(state, {
    type: 'world_created',
    severity: 1,
    title: '边境行省开始运行',
    summary: '时间、经济、生态、势力与重要人物状态已由确定性规则接管。',
    sourceSystem: 'bootstrap',
    factIds: ['fact_north_beasts', 'fact_border_harvest'],
    payload: { seed: state.seed },
  });
  return state;
}
