import type { WorldSimulationState } from './types';
import { round } from './utils';

export interface SimulationAnomaly {
  key: string;
  type: 'food_shortage' | 'price_spike' | 'migration_pressure' | 'faction_tension';
  severity: number;
  entityId: string;
  summary: string;
  evidence: Record<string, number | string>;
}

export function collectSimulationAnomalies(
  state: WorldSimulationState,
  regionId?: string,
): SimulationAnomaly[] {
  const anomalies: SimulationAnomaly[] = [];
  for (const settlement of Object.values(state.settlements)) {
    if (regionId && settlement.regionId !== regionId) continue;
    const dailyFoodNeed = Math.max(1, settlement.population * 0.095);
    const foodDays = settlement.resources.food / dailyFoodNeed;
    if (foodDays < 12) {
      anomalies.push({
        key: `food:${settlement.id}`,
        type: 'food_shortage',
        severity: foodDays < 5 ? 5 : foodDays < 8 ? 4 : 3,
        entityId: settlement.id,
        summary: `${settlement.name}的粮食储备只够约${round(foodDays, 1)}天。`,
        evidence: { foodDays: round(foodDays, 2), population: settlement.population },
      });
    }
    for (const [goodId, good] of Object.entries(settlement.market)) {
      const ratio = good.price / good.basePrice;
      if (ratio >= 1.65) {
        anomalies.push({
          key: `price:${settlement.id}:${goodId}`,
          type: 'price_spike',
          severity: ratio >= 2.5 ? 5 : ratio >= 2 ? 4 : 3,
          entityId: settlement.id,
          summary: `${settlement.name}的${goodId}价格已涨至基准价的${round(ratio, 2)}倍。`,
          evidence: { goodId, priceRatio: round(ratio, 3) },
        });
      }
    }
  }
  for (const species of Object.values(state.species)) {
    if (regionId && species.regionId !== regionId) continue;
    if (species.migrationPressure >= 70) {
      anomalies.push({
        key: `migration:${species.id}`,
        type: 'migration_pressure',
        severity: species.migrationPressure >= 90 ? 5 : species.migrationPressure >= 80 ? 4 : 3,
        entityId: species.id,
        summary: `${species.name}的迁徙压力达到${round(species.migrationPressure, 1)}。`,
        evidence: {
          migrationPressure: round(species.migrationPressure, 2),
          foodSupply: round(species.foodSupply, 2),
          population: species.population,
        },
      });
    }
  }
  for (const faction of Object.values(state.factions)) {
    if (faction.tension >= 72) {
      anomalies.push({
        key: `tension:${faction.id}`,
        type: 'faction_tension',
        severity: faction.tension >= 90 ? 5 : faction.tension >= 82 ? 4 : 3,
        entityId: faction.id,
        summary: `${faction.name}的紧张度达到${round(faction.tension, 1)}。`,
        evidence: { tension: round(faction.tension, 2), militaryPower: faction.militaryPower },
      });
    }
  }
  return anomalies.sort((a, b) => b.severity - a.severity || a.key.localeCompare(b.key));
}
