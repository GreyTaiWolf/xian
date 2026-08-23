import { createStream } from '../core/rng';
import { collectSimulationAnomalies } from './anomalies';
import { appendWorldEvent, hasActiveCooldown, setEventCooldown } from './event-log';
import type {
  MarketGoodId,
  SettlementState,
  SpeciesPopulationState,
  WorldEventRecord,
  WorldSimulationState,
} from './types';
import { MARKET_GOODS, clamp, cloneSimulationState, hashString, round } from './utils';

const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
const DAILY_SALT = 0x4a11;
const ECOLOGY_SALT = 0x6c23;
const FACTION_SALT = 0x7d31;

export interface SimulationAdvanceResult {
  state: WorldSimulationState;
  emittedEvents: WorldEventRecord[];
}

function currentWorldDay(state: WorldSimulationState): number {
  return Math.floor(state.clock.totalHours / 24) + 1;
}

function advanceClockOneHour(state: WorldSimulationState): void {
  state.clock.totalHours += 1;
  state.clock.hour += 1;
  if (state.clock.hour < 24) return;
  state.clock.hour = 0;
  state.clock.dayOfSeason += 1;
  if (state.clock.dayOfSeason <= 30) return;
  state.clock.dayOfSeason = 1;
  const seasonIndex = SEASONS.indexOf(state.clock.season);
  if (seasonIndex === SEASONS.length - 1) {
    state.clock.season = SEASONS[0];
    state.clock.year += 1;
    return;
  }
  state.clock.season = SEASONS[seasonIndex + 1];
}

function seasonProductionMultiplier(state: WorldSimulationState): number {
  switch (state.clock.season) {
    case 'spring':
      return 1.05;
    case 'summer':
      return 1.18;
    case 'autumn':
      return 1.3;
    case 'winter':
      return 0.58;
  }
}

function updateMarketGood(
  settlement: SettlementState,
  goodId: MarketGoodId,
  stock: number,
  targetStock: number,
): void {
  const market = settlement.market[goodId];
  market.supply = round(clamp((stock / Math.max(1, targetStock)) * 100, 5, 240));
  market.demand = round(clamp(90 + settlement.population / 180 + (100 - settlement.stability) * 0.35, 55, 190));
  const pressure = market.demand / Math.max(10, market.supply);
  const targetPrice = market.basePrice * clamp(0.56 + pressure * 0.52, 0.55, 3.8);
  market.price = round(market.price * 0.64 + targetPrice * 0.36);
}

function runSettlementDailyTick(state: WorldSimulationState, settlement: SettlementState, day: number): void {
  const region = state.regions[settlement.regionId];
  const rng = createStream(state.seed, DAILY_SALT ^ Math.imul(day, 1009) ^ hashString(settlement.id));
  const seasonal = seasonProductionMultiplier(state);
  const workers = settlement.population * settlement.workforceRatio;
  const weatherDrift = 0.92 + rng() * 0.16;
  const foodProduced = workers * (0.105 + region.fertility / 1500) * seasonal * weatherDrift;
  const foodConsumed = settlement.population * (0.091 + rng() * 0.009);
  const timberProduced = workers * (region.biome.includes('forest') ? 0.07 : 0.025) * (0.9 + rng() * 0.2);
  const oreProduced = workers * (region.biome.includes('hill') ? 0.064 : 0.009) * (0.9 + rng() * 0.2);
  const medicineProduced = workers * (region.rainfall / 1000) * (0.85 + rng() * 0.3);

  settlement.resources.food = round(Math.max(0, settlement.resources.food + foodProduced - foodConsumed));
  settlement.resources.timber = round(Math.max(0, settlement.resources.timber + timberProduced));
  settlement.resources.ore = round(Math.max(0, settlement.resources.ore + oreProduced));
  settlement.resources.medicine = round(Math.max(0, settlement.resources.medicine + medicineProduced));

  const foodDays = settlement.resources.food / Math.max(1, foodConsumed);
  settlement.stability = round(clamp(settlement.stability + (foodDays > 25 ? 0.18 : foodDays < 8 ? -0.85 : -0.05), 0, 100));
  settlement.prosperity = round(
    clamp(settlement.prosperity + (settlement.stability - 50) * 0.006 + (rng() - 0.5) * 0.18, 0, 100),
  );

  updateMarketGood(settlement, 'food', settlement.resources.food, settlement.population * 2.5);
  updateMarketGood(settlement, 'timber', settlement.resources.timber, settlement.population * 1.2);
  updateMarketGood(settlement, 'ore', settlement.resources.ore, settlement.population * 0.8);
  updateMarketGood(settlement, 'medicine', settlement.resources.medicine, settlement.population * 0.22);
}

function preyAvailability(state: WorldSimulationState, species: SpeciesPopulationState): number {
  if (species.preySpeciesIds.length === 0) return 55;
  const values = species.preySpeciesIds
    .map((id) => state.species[id])
    .filter((prey): prey is SpeciesPopulationState => prey !== undefined)
    .map((prey) => (prey.population / Math.max(1, prey.carryingCapacity)) * 100);
  if (values.length === 0) return 30;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function runSpeciesDailyTick(state: WorldSimulationState, species: SpeciesPopulationState, day: number): void {
  const region = state.regions[species.regionId];
  const rng = createStream(state.seed, ECOLOGY_SALT ^ Math.imul(day, 2029) ^ hashString(species.id));
  const capacityRatio = species.population / Math.max(1, species.carryingCapacity);
  const environmentalFood = species.preySpeciesIds.length > 0 ? preyAvailability(state, species) : region.fertility;
  species.foodSupply = round(
    clamp(species.foodSupply * 0.72 + environmentalFood * 0.28 - capacityRatio * 2.4 + (rng() - 0.5) * 2.2, 0, 100),
  );
  const growthRate =
    0.012 * (species.foodSupply / 55) * (1 - capacityRatio) - species.diseaseLevel * 0.00045 - region.humanPressure * 0.00008;
  const populationDelta = Math.round(species.population * growthRate + (rng() - 0.5) * 2);
  species.population = Math.max(0, species.population + populationDelta);
  species.diseaseLevel = round(clamp(species.diseaseLevel + (rng() - 0.53) * 0.55, 0, 100));
  species.migrationPressure = round(
    clamp(
      (100 - species.foodSupply) * 0.64 + capacityRatio * 23 + region.humanPressure * 0.17 + species.diseaseLevel * 0.12,
      0,
      100,
    ),
  );
}

function runFactionMonthlyTick(state: WorldSimulationState, monthIndex: number): void {
  for (const faction of Object.values(state.factions)) {
    const rng = createStream(state.seed, FACTION_SALT ^ Math.imul(monthIndex, 3011) ^ hashString(faction.id));
    faction.treasury = round(Math.max(0, faction.treasury + faction.influence * 84 - faction.militaryPower * 37));
    faction.tension = round(clamp(faction.tension + (rng() - 0.48) * 4 + (faction.treasury < 30000 ? 2 : 0), 0, 100));
  }
}

function materializeDetectedEvents(state: WorldSimulationState): WorldEventRecord[] {
  const emitted: WorldEventRecord[] = [];
  for (const anomaly of collectSimulationAnomalies(state)) {
    if (hasActiveCooldown(state, anomaly.key)) continue;
    switch (anomaly.type) {
      case 'food_shortage': {
        emitted.push(
          appendWorldEvent(state, {
            type: 'famine_risk',
            severity: anomaly.severity,
            title: '粮食储备告急',
            summary: anomaly.summary,
            sourceSystem: 'economy',
            targetIds: [anomaly.entityId],
            payload: anomaly.evidence,
          }),
        );
        setEventCooldown(state, anomaly.key, 24 * 7);
        break;
      }
      case 'price_spike': {
        emitted.push(
          appendWorldEvent(state, {
            type: 'market_shock',
            severity: anomaly.severity,
            title: '市场价格异常波动',
            summary: anomaly.summary,
            sourceSystem: 'economy',
            targetIds: [anomaly.entityId],
            payload: anomaly.evidence,
          }),
        );
        setEventCooldown(state, anomaly.key, 24 * 5);
        break;
      }
      case 'migration_pressure': {
        emitted.push(
          appendWorldEvent(state, {
            type: 'beast_migration',
            severity: anomaly.severity,
            title: '生物种群出现迁徙征兆',
            summary: anomaly.summary,
            sourceSystem: 'ecology',
            actorIds: [anomaly.entityId],
            payload: anomaly.evidence,
          }),
        );
        setEventCooldown(state, anomaly.key, 24 * 10);
        break;
      }
      case 'faction_tension': {
        emitted.push(
          appendWorldEvent(state, {
            type: 'border_tension',
            severity: anomaly.severity,
            title: '势力紧张升级',
            summary: anomaly.summary,
            sourceSystem: 'faction',
            actorIds: [anomaly.entityId],
            payload: anomaly.evidence,
          }),
        );
        setEventCooldown(state, anomaly.key, 24 * 12);
        break;
      }
    }
  }
  return emitted;
}

function runDailyTick(state: WorldSimulationState): WorldEventRecord[] {
  const day = currentWorldDay(state);
  for (const settlement of Object.values(state.settlements)) runSettlementDailyTick(state, settlement, day);
  for (const species of Object.values(state.species)) runSpeciesDailyTick(state, species, day);
  state.cadence.lastDailyTick = day;
  const monthIndex = Math.floor((day - 1) / 30) + 1;
  if (monthIndex > state.cadence.lastMonthlyTick) {
    runFactionMonthlyTick(state, monthIndex);
    state.cadence.lastMonthlyTick = monthIndex;
  }
  return materializeDetectedEvents(state);
}

/**
 * 纯规则推进世界。AI 不参与资源、价格、人口与生态结算。
 * 输入状态不会被修改，便于存档回放与确定性测试。
 */
export function advanceWorldHours(input: WorldSimulationState, hours: number): SimulationAdvanceResult {
  if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 365 * 5) {
    throw new Error('hours 必须是 0 到 43800 之间的整数');
  }
  const state = cloneSimulationState(input);
  const emittedEvents: WorldEventRecord[] = [];
  for (let index = 0; index < hours; index += 1) {
    const previousDay = currentWorldDay(state);
    advanceClockOneHour(state);
    const nextDay = currentWorldDay(state);
    if (nextDay > previousDay) emittedEvents.push(...runDailyTick(state));
  }
  return { state, emittedEvents };
}

/** 调试用：返回当前四类市场商品的平均价格。 */
export function averageMarketPrices(state: WorldSimulationState): Record<MarketGoodId, number> {
  const settlements = Object.values(state.settlements);
  const result = {} as Record<MarketGoodId, number>;
  for (const goodId of MARKET_GOODS) {
    result[goodId] = round(
      settlements.reduce((sum, settlement) => sum + settlement.market[goodId].price, 0) /
        Math.max(1, settlements.length),
    );
  }
  return result;
}
