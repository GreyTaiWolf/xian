import type { MarketGoodId, MarketState, RelationshipVector, WorldSimulationState } from './types';

export const MARKET_GOODS: readonly MarketGoodId[] = ['food', 'timber', 'ore', 'medicine'];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function cloneSimulationState(state: WorldSimulationState): WorldSimulationState {
  return JSON.parse(JSON.stringify(state)) as WorldSimulationState;
}

export function createNeutralRelationship(): RelationshipVector {
  return {
    trust: 0,
    affection: 0,
    respect: 0,
    fear: 0,
    hostility: 0,
    debt: 0,
    familiarity: 0,
  };
}

export function createMarket(basePrices: Record<MarketGoodId, number>): MarketState {
  return {
    food: { basePrice: basePrices.food, price: basePrices.food, supply: 100, demand: 100 },
    timber: { basePrice: basePrices.timber, price: basePrices.timber, supply: 100, demand: 100 },
    ore: { basePrice: basePrices.ore, price: basePrices.ore, supply: 100, demand: 100 },
    medicine: { basePrice: basePrices.medicine, price: basePrices.medicine, supply: 100, demand: 100 },
  };
}
