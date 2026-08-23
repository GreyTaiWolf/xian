/**
 * 天道指令校验器：schema 检查 + 数值钳制 + 引用检查。
 * 铁律：AI 只能建议，不能越权 —— 非法指令直接丢弃，越界数值钳回合法范围。
 */

export interface Directive {
  type: 'faction_relation_change' | 'beast_tide' | 'spirit_surge' | 'npc_action' | 'world_rumor';
  delta?: number;
  reason?: string;
  target?: 'player' | 'town';
  power?: number;
  xpMult?: number;
  durationDays?: number;
  npc?: string;
  text?: string;
}

export function validateDirectives(raw: unknown): Directive[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { directives?: unknown };
  if (!Array.isArray(obj.directives)) return [];
  const out: Directive[] = [];
  for (const item of obj.directives) {
    const d = parseOne(item);
    if (d) out.push(d);
  }
  return out.slice(0, 4);
}

function parseOne(item: unknown): Directive | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const t = String(o.type ?? '');
  switch (t) {
    case 'faction_relation_change': {
      const delta = clampNum(o.delta, -20, 20, 0);
      if (delta === 0) return null;
      return { type: 'faction_relation_change', delta, reason: str(o.reason, 60) };
    }
    case 'beast_tide': {
      return {
        type: 'beast_tide',
        target: o.target === 'town' ? 'town' : 'player',
        power: Math.round(clampNum(o.power, 1, 4, 1)),
      };
    }
    case 'spirit_surge': {
      return {
        type: 'spirit_surge',
        xpMult: clampNum(o.xpMult, 0.9, 1.3, 1.1),
        durationDays: Math.round(clampNum(o.durationDays, 1, 5, 2)),
      };
    }
    case 'npc_action':
    case 'world_rumor': {
      const text = str(o.text ?? o.action, 80);
      if (!text) return null;
      return { type: t, npc: str(o.npc, 20), text };
    }
    default:
      return null;
  }
}

function clampNum(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : '';
}
