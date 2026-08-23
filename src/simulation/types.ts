/** AI 动态世界模拟的纯数据模型。所有字段必须可 JSON 序列化。 */

export type SimulationTier = 'world' | 'region' | 'local' | 'character';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type MarketGoodId = 'food' | 'timber' | 'ore' | 'medicine';
export type Primitive = string | number | boolean | null;
export type EventPayload = Record<string, Primitive>;

export interface SimulationClockState {
  year: number;
  season: Season;
  dayOfSeason: number;
  hour: number;
  totalHours: number;
}

export interface ResourceStock {
  food: number;
  timber: number;
  ore: number;
  medicine: number;
}

export interface MarketGoodState {
  basePrice: number;
  price: number;
  supply: number;
  demand: number;
}

export type MarketState = Record<MarketGoodId, MarketGoodState>;

export interface RegionState {
  id: string;
  name: string;
  biome: string;
  tier: SimulationTier;
  fertility: number;
  danger: number;
  temperature: number;
  rainfall: number;
  humanPressure: number;
  controllerFactionId: string;
  settlementIds: string[];
  speciesIds: string[];
}

export interface SettlementState {
  id: string;
  name: string;
  regionId: string;
  factionId: string;
  population: number;
  workforceRatio: number;
  stability: number;
  prosperity: number;
  resources: ResourceStock;
  market: MarketState;
}

export interface FactionRelationState {
  trust: number;
  hostility: number;
  trade: number;
}

export interface FactionState {
  id: string;
  name: string;
  kind: 'lordship' | 'guild' | 'merchant' | 'sect' | 'bandit';
  treasury: number;
  militaryPower: number;
  influence: number;
  tension: number;
  goals: string[];
  relations: Record<string, FactionRelationState>;
}

export interface SpeciesPopulationState {
  id: string;
  name: string;
  regionId: string;
  population: number;
  carryingCapacity: number;
  foodSupply: number;
  aggression: number;
  migrationPressure: number;
  diseaseLevel: number;
  humanHostility: number;
  preySpeciesIds: string[];
  predatorSpeciesIds: string[];
}

export interface RelationshipVector {
  trust: number;
  affection: number;
  respect: number;
  fear: number;
  hostility: number;
  debt: number;
  familiarity: number;
}

export interface CharacterKnowledgeState {
  knownFactIds: string[];
  secretFactIds: string[];
}

export interface CharacterMemoryState {
  id: string;
  atHour: number;
  summary: string;
  importance: number;
  relatedEntityIds: string[];
}

export interface ImportantCharacterState {
  id: string;
  name: string;
  alive: boolean;
  role: string;
  regionId: string;
  settlementId: string | null;
  factionId: string | null;
  personality: Record<string, number>;
  currentGoalIds: string[];
  relationships: Record<string, RelationshipVector>;
  knowledge: CharacterKnowledgeState;
  memories: CharacterMemoryState[];
}

export interface WorldFact {
  id: string;
  text: string;
  visibility: 'public' | 'rumor' | 'private' | 'secret';
  regionId: string | null;
  sourceEventId: string | null;
}

export type WorldEventType =
  | 'world_created'
  | 'famine_risk'
  | 'market_shock'
  | 'beast_migration'
  | 'border_tension'
  | 'world_event_proposal_accepted';

export interface WorldEventRecord {
  id: string;
  sequence: number;
  atHour: number;
  day: number;
  type: WorldEventType;
  severity: number;
  title: string;
  summary: string;
  sourceSystem: 'bootstrap' | 'economy' | 'ecology' | 'faction' | 'ai_orchestrator';
  causeEventIds: string[];
  actorIds: string[];
  targetIds: string[];
  factIds: string[];
  payload: EventPayload;
}

export interface SimulationCadenceState {
  lastDailyTick: number;
  lastMonthlyTick: number;
}

export interface WorldSimulationState {
  schemaVersion: 1;
  seed: number;
  clock: SimulationClockState;
  cadence: SimulationCadenceState;
  regions: Record<string, RegionState>;
  settlements: Record<string, SettlementState>;
  factions: Record<string, FactionState>;
  species: Record<string, SpeciesPopulationState>;
  characters: Record<string, ImportantCharacterState>;
  facts: Record<string, WorldFact>;
  eventLog: WorldEventRecord[];
  nextEventSequence: number;
  eventCooldownUntilHour: Record<string, number>;
}
