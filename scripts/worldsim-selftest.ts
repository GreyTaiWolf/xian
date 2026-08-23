import {
  advanceWorldHours,
  buildNpcDialogueAiContext,
  buildWorldEventAiContext,
  createInitialWorldSimulation,
  validateAiCommand,
  validateSimulationInvariants,
  type AiCommandContext,
} from '../src/simulation';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`自测失败：${message}`);
  passed += 1;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

const initialA = createInitialWorldSimulation(882345);
const initialB = createInitialWorldSimulation(882345);
assert(stableJson(initialA) === stableJson(initialB), '相同种子必须生成相同世界');

const initialOther = createInitialWorldSimulation(882346);
assert(stableJson(initialA.regions) !== stableJson(initialOther.regions), '不同种子应产生不同区域参数');

const advancedA = advanceWorldHours(initialA, 24 * 180).state;
const advancedB = advanceWorldHours(initialB, 24 * 180).state;
assert(stableJson(advancedA) === stableJson(advancedB), '长时间推进必须保持确定性');
assert(validateSimulationInvariants(advancedA).length === 0, '半年模拟后不得破坏世界不变量');
assert(advancedA.eventLog.length <= 240, '事件日志必须有容量上限');
assert(advancedA.cadence.lastDailyTick >= 180, '每日 Tick 必须持续执行');
assert(advancedA.cadence.lastMonthlyTick >= 6, '每月 Tick 必须持续执行');

const untouched = createInitialWorldSimulation(882345);
const before = stableJson(untouched);
advanceWorldHours(untouched, 72);
assert(stableJson(untouched) === before, '推进函数不得修改输入状态');

const rangerContext = buildNpcDialogueAiContext(initialA, 'npc_ranger_mei', 'player', '最近为什么有野兽南下？');
assert(rangerContext.allowedFactIds.includes('fact_north_beasts'), 'NPC 对话上下文应包含角色已知事实');
assert(!rangerContext.allowedFactIds.includes('fact_merchant_hoarding'), 'NPC 对话上下文不得泄露角色不知道的秘密');
assert(rangerContext.playerMessage.length > 0, '玩家消息必须进入受限对话上下文');

const regionContext = buildWorldEventAiContext(advancedA, 'north_forest');
assert(regionContext.allowedLocationIds.includes('north_forest'), '世界事件上下文应声明允许地点');
assert(regionContext.allowedParticipantIds.includes('frost_wolf'), '世界事件上下文应声明允许参与者');
assert(!('facts' in regionContext), '世界事件上下文不得携带完整事实库');

const aiContext: AiCommandContext = {
  allowedKinds: ['WORLD_EVENT_PROPOSAL', 'NPC_ACTION', 'NPC_DIALOGUE_EFFECT'],
  allowedLocationIds: regionContext.allowedLocationIds,
  allowedActorIds: ['npc_ranger_mei', 'frost_wolf'],
  allowedTargetIds: ['player', 'northwatch_camp'],
  allowedActionIds: ['investigate_tracks', 'warn_settlement'],
  allowedFactIds: rangerContext.allowedFactIds,
};

const acceptedEvent = validateAiCommand(
  {
    kind: 'WORLD_EVENT_PROPOSAL',
    eventType: 'wolf_tracks_found',
    title: '寒林深处的新足迹',
    summary: '巡林者发现狼群正沿旧商道向南移动。',
    locationId: 'north_forest',
    participantIds: ['npc_ranger_mei', 'frost_wolf'],
    causeEventIds: [],
    severity: 3,
  },
  aiContext,
  initialA,
);
assert(acceptedEvent.ok && acceptedEvent.command?.kind === 'WORLD_EVENT_PROPOSAL', '合法事件提案应通过安全门');

const rejectedPatch = validateAiCommand(
  {
    kind: 'NPC_ACTION',
    actorId: 'npc_ranger_mei',
    actionId: 'warn_settlement',
    targetId: 'northwatch_camp',
    motivationSummary: '提醒营地防备狼群。',
    parameters: { population: 999999 },
  },
  aiContext,
  initialA,
);
assert(!rejectedPatch.ok, 'AI 试图直接修改人口时必须被拒绝');
assert(rejectedPatch.errors.some((error) => error.includes('禁止直接修改')), '拒绝结果必须说明越权字段');

const rejectedUnknownTarget = validateAiCommand(
  {
    kind: 'NPC_ACTION',
    actorId: 'npc_ranger_mei',
    actionId: 'warn_settlement',
    targetId: 'nonexistent_city',
    motivationSummary: '前往不存在的城市。',
    parameters: {},
  },
  aiContext,
  initialA,
);
assert(!rejectedUnknownTarget.ok, '未授权目标 ID 必须被拒绝');

const rejectedRelationshipBurst = validateAiCommand(
  {
    kind: 'NPC_DIALOGUE_EFFECT',
    actorId: 'npc_ranger_mei',
    targetId: 'player',
    dialogue: '我完全信任你。',
    revealedFactIds: ['fact_north_beasts'],
    relationshipDelta: { trust: 20, affection: 20 },
    memoryCandidate: '玩家询问了狼群。',
  },
  aiContext,
  initialA,
);
assert(!rejectedRelationshipBurst.ok, 'AI 不得一次大幅修改关系');

console.log(`AI 动态世界模拟自测通过：${passed} 项断言。`);
