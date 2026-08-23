import { collectSimulationAnomalies } from './anomalies';
import type { WorldEventRecord, WorldFact, WorldSimulationState } from './types';

export interface WorldEventAiContext {
  worldTime: {
    year: number;
    season: string;
    dayOfSeason: number;
    hour: number;
  };
  region: {
    id: string;
    name: string;
    biome: string;
    danger: number;
    controllerFactionId: string;
  };
  settlements: Array<{
    id: string;
    name: string;
    population: number;
    stability: number;
    prosperity: number;
    food: number;
    foodPrice: number;
  }>;
  anomalies: ReturnType<typeof collectSimulationAnomalies>;
  recentEvents: WorldEventRecord[];
  allowedLocationIds: string[];
  allowedParticipantIds: string[];
}

export interface NpcDialogueAiContext {
  npc: {
    id: string;
    name: string;
    role: string;
    personality: Record<string, number>;
    goals: string[];
  };
  relationship: Record<string, number>;
  knownFacts: WorldFact[];
  secretFacts: WorldFact[];
  recentMemories: Array<{ summary: string; importance: number }>;
  playerMessage: string;
  allowedFactIds: string[];
}

/** 仅抽取一个区域的异常、聚落与近期事件，禁止把整个世界状态塞给模型。 */
export function buildWorldEventAiContext(state: WorldSimulationState, regionId: string): WorldEventAiContext {
  const region = state.regions[regionId];
  if (!region) throw new Error(`未知区域：${regionId}`);
  const settlements = region.settlementIds
    .map((id) => state.settlements[id])
    .filter((settlement) => settlement !== undefined)
    .map((settlement) => ({
      id: settlement.id,
      name: settlement.name,
      population: settlement.population,
      stability: settlement.stability,
      prosperity: settlement.prosperity,
      food: settlement.resources.food,
      foodPrice: settlement.market.food.price,
    }));
  const relatedEntityIds = new Set<string>([
    region.id,
    region.controllerFactionId,
    ...region.settlementIds,
    ...region.speciesIds,
  ]);
  const recentEvents = state.eventLog
    .filter((event) => [...event.actorIds, ...event.targetIds].some((id) => relatedEntityIds.has(id)))
    .slice(-12);
  const allowedParticipantIds = [
    region.controllerFactionId,
    ...region.settlementIds,
    ...region.speciesIds,
    ...Object.values(state.characters)
      .filter((character) => character.regionId === regionId && character.alive)
      .map((character) => character.id),
  ];
  return {
    worldTime: {
      year: state.clock.year,
      season: state.clock.season,
      dayOfSeason: state.clock.dayOfSeason,
      hour: state.clock.hour,
    },
    region: {
      id: region.id,
      name: region.name,
      biome: region.biome,
      danger: region.danger,
      controllerFactionId: region.controllerFactionId,
    },
    settlements,
    anomalies: collectSimulationAnomalies(state, regionId).slice(0, 8),
    recentEvents,
    allowedLocationIds: [region.id, ...region.settlementIds],
    allowedParticipantIds,
  };
}

/** NPC 对话只带入该角色确实掌握的事实与记忆。 */
export function buildNpcDialogueAiContext(
  state: WorldSimulationState,
  npcId: string,
  targetId: string,
  playerMessage: string,
): NpcDialogueAiContext {
  const npc = state.characters[npcId];
  if (!npc || !npc.alive) throw new Error(`NPC 不存在或已死亡：${npcId}`);
  const knownFacts = npc.knowledge.knownFactIds
    .map((id) => state.facts[id])
    .filter((fact): fact is WorldFact => fact !== undefined);
  const secretFacts = npc.knowledge.secretFactIds
    .map((id) => state.facts[id])
    .filter((fact): fact is WorldFact => fact !== undefined);
  return {
    npc: {
      id: npc.id,
      name: npc.name,
      role: npc.role,
      personality: { ...npc.personality },
      goals: [...npc.currentGoalIds],
    },
    relationship: { ...(npc.relationships[targetId] ?? {}) },
    knownFacts,
    secretFacts,
    recentMemories: npc.memories
      .slice()
      .sort((a, b) => b.importance - a.importance || b.atHour - a.atHour)
      .slice(0, 12)
      .map((memory) => ({ summary: memory.summary, importance: memory.importance })),
    playerMessage: playerMessage.slice(0, 500),
    allowedFactIds: [...npc.knowledge.knownFactIds, ...npc.knowledge.secretFactIds],
  };
}
