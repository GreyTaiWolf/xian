import type { RelationshipVector, WorldSimulationState } from './types';

export type AiCommandKind = 'WORLD_EVENT_PROPOSAL' | 'NPC_ACTION' | 'NPC_DIALOGUE_EFFECT';

export interface WorldEventProposalCommand {
  kind: 'WORLD_EVENT_PROPOSAL';
  eventType: string;
  title: string;
  summary: string;
  locationId: string;
  participantIds: string[];
  causeEventIds: string[];
  severity: number;
}

export interface NpcActionCommand {
  kind: 'NPC_ACTION';
  actorId: string;
  actionId: string;
  targetId: string | null;
  motivationSummary: string;
  parameters: Record<string, string | number | boolean | null>;
}

export interface NpcDialogueEffectCommand {
  kind: 'NPC_DIALOGUE_EFFECT';
  actorId: string;
  targetId: string;
  dialogue: string;
  revealedFactIds: string[];
  relationshipDelta: Partial<RelationshipVector>;
  memoryCandidate: string;
}

export type ValidatedAiCommand = WorldEventProposalCommand | NpcActionCommand | NpcDialogueEffectCommand;

export interface AiCommandContext {
  allowedKinds: AiCommandKind[];
  allowedLocationIds: string[];
  allowedActorIds: string[];
  allowedTargetIds: string[];
  allowedActionIds: string[];
  allowedFactIds: string[];
}

export interface AiValidationResult {
  ok: boolean;
  command: ValidatedAiCommand | null;
  errors: string[];
}

const FORBIDDEN_KEYS = new Set([
  'state',
  'worldState',
  'inventory',
  'equipment',
  'money',
  'hp',
  'damage',
  'dropRate',
  'rewardAmount',
  'population',
  'resources',
  'price',
  'treasury',
]);

const RELATIONSHIP_KEYS: readonly (keyof RelationshipVector)[] = [
  'trust',
  'affection',
  'respect',
  'fear',
  'hostility',
  'debt',
  'familiarity',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 4 || !isRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return key;
    const child = findForbiddenKey(nested, depth + 1);
    if (child) return child;
  }
  return null;
}

function text(value: unknown, field: string, maxLength: number, errors: string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} 必须是非空字符串`);
    return '';
  }
  if (value.length > maxLength) errors.push(`${field} 超过最大长度 ${maxLength}`);
  return value.slice(0, maxLength);
}

function stringArray(value: unknown, field: string, maxItems: number, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${field} 必须是字符串数组`);
    return [];
  }
  if (value.length > maxItems) errors.push(`${field} 最多允许 ${maxItems} 项`);
  return value.slice(0, maxItems);
}

function ensureAllowed(ids: string[], allowed: string[], field: string, errors: string[]): void {
  const allowedSet = new Set(allowed);
  for (const id of ids) {
    if (!allowedSet.has(id)) errors.push(`${field} 包含未授权 ID：${id}`);
  }
}

function parseWorldEventProposal(
  raw: Record<string, unknown>,
  context: AiCommandContext,
  state: WorldSimulationState,
  errors: string[],
): WorldEventProposalCommand {
  const locationId = text(raw.locationId, 'locationId', 64, errors);
  const participantIds = stringArray(raw.participantIds, 'participantIds', 8, errors);
  const causeEventIds = stringArray(raw.causeEventIds, 'causeEventIds', 6, errors);
  const severity = typeof raw.severity === 'number' ? Math.round(raw.severity) : Number.NaN;
  if (!Number.isInteger(severity) || severity < 1 || severity > 5) errors.push('severity 必须是 1 到 5 的整数');
  ensureAllowed([locationId], context.allowedLocationIds, 'locationId', errors);
  ensureAllowed(participantIds, [...context.allowedActorIds, ...context.allowedTargetIds], 'participantIds', errors);
  const existingEvents = new Set(state.eventLog.map((event) => event.id));
  for (const eventId of causeEventIds) {
    if (!existingEvents.has(eventId)) errors.push(`causeEventIds 引用了不存在的事件：${eventId}`);
  }
  return {
    kind: 'WORLD_EVENT_PROPOSAL',
    eventType: text(raw.eventType, 'eventType', 48, errors),
    title: text(raw.title, 'title', 80, errors),
    summary: text(raw.summary, 'summary', 320, errors),
    locationId,
    participantIds,
    causeEventIds,
    severity: Number.isFinite(severity) ? severity : 1,
  };
}

function parseParameters(value: unknown, errors: string[]): Record<string, string | number | boolean | null> {
  if (!isRecord(value)) {
    errors.push('parameters 必须是对象');
    return {};
  }
  const result: Record<string, string | number | boolean | null> = {};
  const entries = Object.entries(value);
  if (entries.length > 8) errors.push('parameters 最多允许 8 个字段');
  for (const [key, parameter] of entries.slice(0, 8)) {
    if (
      typeof parameter === 'string' ||
      typeof parameter === 'number' ||
      typeof parameter === 'boolean' ||
      parameter === null
    ) {
      result[key.slice(0, 48)] = typeof parameter === 'string' ? parameter.slice(0, 120) : parameter;
    } else {
      errors.push(`parameters.${key} 只能是基础类型`);
    }
  }
  return result;
}

function parseNpcAction(raw: Record<string, unknown>, context: AiCommandContext, errors: string[]): NpcActionCommand {
  const actorId = text(raw.actorId, 'actorId', 64, errors);
  const actionId = text(raw.actionId, 'actionId', 64, errors);
  const targetId = raw.targetId === null || raw.targetId === undefined ? null : text(raw.targetId, 'targetId', 64, errors);
  ensureAllowed([actorId], context.allowedActorIds, 'actorId', errors);
  ensureAllowed([actionId], context.allowedActionIds, 'actionId', errors);
  if (targetId) ensureAllowed([targetId], context.allowedTargetIds, 'targetId', errors);
  return {
    kind: 'NPC_ACTION',
    actorId,
    actionId,
    targetId,
    motivationSummary: text(raw.motivationSummary, 'motivationSummary', 180, errors),
    parameters: parseParameters(raw.parameters, errors),
  };
}

function parseRelationshipDelta(value: unknown, errors: string[]): Partial<RelationshipVector> {
  if (!isRecord(value)) {
    errors.push('relationshipDelta 必须是对象');
    return {};
  }
  const result: Partial<RelationshipVector> = {};
  let absoluteTotal = 0;
  for (const key of RELATIONSHIP_KEYS) {
    const rawDelta = value[key];
    if (rawDelta === undefined) continue;
    if (typeof rawDelta !== 'number' || !Number.isFinite(rawDelta) || rawDelta < -3 || rawDelta > 3) {
      errors.push(`relationshipDelta.${key} 必须在 -3 到 3 之间`);
      continue;
    }
    result[key] = rawDelta;
    absoluteTotal += Math.abs(rawDelta);
  }
  if (absoluteTotal > 6) errors.push('单次关系变化绝对值合计不得超过 6');
  return result;
}

function parseNpcDialogueEffect(
  raw: Record<string, unknown>,
  context: AiCommandContext,
  errors: string[],
): NpcDialogueEffectCommand {
  const actorId = text(raw.actorId, 'actorId', 64, errors);
  const targetId = text(raw.targetId, 'targetId', 64, errors);
  const revealedFactIds = stringArray(raw.revealedFactIds, 'revealedFactIds', 5, errors);
  ensureAllowed([actorId], context.allowedActorIds, 'actorId', errors);
  ensureAllowed([targetId], context.allowedTargetIds, 'targetId', errors);
  ensureAllowed(revealedFactIds, context.allowedFactIds, 'revealedFactIds', errors);
  return {
    kind: 'NPC_DIALOGUE_EFFECT',
    actorId,
    targetId,
    dialogue: text(raw.dialogue, 'dialogue', 500, errors),
    revealedFactIds,
    relationshipDelta: parseRelationshipDelta(raw.relationshipDelta, errors),
    memoryCandidate: typeof raw.memoryCandidate === 'string' ? raw.memoryCandidate.slice(0, 240) : '',
  };
}

/**
 * AI 输出的统一安全门：只接受白名单命令、白名单实体和受限数值。
 * 该函数只校验候选，不会直接修改任何游戏状态。
 */
export function validateAiCommand(
  raw: unknown,
  context: AiCommandContext,
  state: WorldSimulationState,
): AiValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, command: null, errors: ['AI 输出必须是对象'] };
  const forbiddenKey = findForbiddenKey(raw);
  if (forbiddenKey) errors.push(`AI 输出包含禁止直接修改的字段：${forbiddenKey}`);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !context.allowedKinds.includes(kind as AiCommandKind)) {
    return { ok: false, command: null, errors: [...errors, `未授权的命令类型：${String(kind)}`] };
  }
  let command: ValidatedAiCommand;
  switch (kind) {
    case 'WORLD_EVENT_PROPOSAL':
      command = parseWorldEventProposal(raw, context, state, errors);
      break;
    case 'NPC_ACTION':
      command = parseNpcAction(raw, context, errors);
      break;
    case 'NPC_DIALOGUE_EFFECT':
      command = parseNpcDialogueEffect(raw, context, errors);
      break;
    default:
      return { ok: false, command: null, errors: [...errors, `未知命令类型：${kind}`] };
  }
  return errors.length === 0 ? { ok: true, command, errors: [] } : { ok: false, command: null, errors };
}
