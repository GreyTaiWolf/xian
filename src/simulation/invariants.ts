import type { RelationshipVector, WorldSimulationState } from './types';
import { MARKET_GOODS } from './utils';

const RELATIONSHIP_KEYS: readonly (keyof RelationshipVector)[] = [
  'trust',
  'affection',
  'respect',
  'fear',
  'hostility',
  'debt',
  'familiarity',
];

/** 长时间模拟与存档加载后都可调用，发现破坏世界物理法则的数据。 */
export function validateSimulationInvariants(state: WorldSimulationState): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(state.seed) || state.seed < 0) errors.push('seed 必须是非负整数');
  if (!Number.isInteger(state.clock.totalHours) || state.clock.totalHours < 0) errors.push('totalHours 非法');
  for (const settlement of Object.values(state.settlements)) {
    if (settlement.population < 0 || !Number.isFinite(settlement.population)) {
      errors.push(`${settlement.id}.population 非法`);
    }
    for (const [resourceId, amount] of Object.entries(settlement.resources)) {
      if (!Number.isFinite(amount) || amount < 0) errors.push(`${settlement.id}.resources.${resourceId} 非法`);
    }
    for (const goodId of MARKET_GOODS) {
      const market = settlement.market[goodId];
      if (!Number.isFinite(market.price) || market.price <= 0 || market.price > market.basePrice * 4.01) {
        errors.push(`${settlement.id}.market.${goodId}.price 越界`);
      }
    }
  }
  for (const species of Object.values(state.species)) {
    if (!Number.isInteger(species.population) || species.population < 0) errors.push(`${species.id}.population 非法`);
    if (species.foodSupply < 0 || species.foodSupply > 100) errors.push(`${species.id}.foodSupply 越界`);
    if (species.migrationPressure < 0 || species.migrationPressure > 100) {
      errors.push(`${species.id}.migrationPressure 越界`);
    }
  }
  for (const character of Object.values(state.characters)) {
    for (const [targetId, relation] of Object.entries(character.relationships)) {
      for (const key of RELATIONSHIP_KEYS) {
        const value = relation[key];
        if (!Number.isFinite(value) || value < -100 || value > 100) {
          errors.push(`${character.id}.relationships.${targetId}.${key} 越界`);
        }
      }
    }
  }
  for (let index = 1; index < state.eventLog.length; index += 1) {
    const previous = state.eventLog[index - 1];
    const current = state.eventLog[index];
    if (current.sequence <= previous.sequence) errors.push('eventLog sequence 非严格递增');
    if (current.atHour < previous.atHour) errors.push('eventLog 时间发生倒退');
  }
  return errors;
}
