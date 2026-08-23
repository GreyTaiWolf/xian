/**
 * 派生属性与数值公式：基础属性 + 装备（主属性 + 词条 × 强化）+ 品级曲线。
 * 一切公式集中于此，便于平衡与配置表驱动化。
 */
import { config } from '../core/config';
import type { GameState, ItemAffix, PlayerState } from './state';

export interface DerivedStats {
  hpMax: number;
  mpMax: number;
  atk: number;
  def: number;
  spd: number;
  crit: number;
  luck: number;
}

export type ItemTemplate = (typeof config.items.items)[number];
export type GradeDef = (typeof config.items.grades)[number];

/** 品级 → CSS 文字色类 / 边框类 前缀（见 theme.css） */
export const GRADE_TEXT_CLS: Record<string, string> = {
  fan: 'rw',
  liang: 'rg',
  jing: 'rb',
  ling: 'rp',
  xuan: 'ro',
  di: 'rr',
  tian: 'rgold',
  xian: 'rplat',
  shen: 'rshen',
};

export const GRADE_NAMES: Record<string, string> = Object.fromEntries(
  config.items.grades.map((g) => [g.id, g.name]),
);

/** 品级 → 边框类名（bd-*，见 theme.css） */
export const GRADE_BORDER_CLS: Record<string, string> = {
  fan: 'bd-white',
  liang: 'bd-green',
  jing: 'bd-blue',
  ling: 'bd-purple',
  xuan: 'bd-orange',
  di: 'bd-red',
  tian: 'bd-tian',
  xian: 'bd-xian',
  shen: 'bd-shen',
};

export const STAT_NAMES: Record<string, string> = {
  hpMax: '生命',
  mpMax: '灵力',
  atk: '攻击',
  def: '防御',
  spd: '速度',
  crit: '暴击',
  luck: '幸运',
};

export const USE_DESC: Record<string, string> = {
  heal80: '恢复 80 生命',
  mp40: '恢复 40 灵力',
  xp100: '修为 +100',
  portal: '回到最近城镇',
};

export function itemTemplate(id: string): ItemTemplate | undefined {
  return config.items.items.find((t) => t.id === id);
}

export function gradeDef(id: string): GradeDef | undefined {
  return config.items.grades.find((g) => g.id === id);
}

/** 品级阶位（0=凡 … 8=神）。 */
export function gradeTier(id: string): number {
  return config.items.grades.findIndex((g) => g.id === id);
}

/** 品级颜色。 */
export function gradeDefColor(id: string): string {
  return gradeDef(id)?.color ?? '#d8d8dc';
}

/** 显示名：品级前缀 + 物品名，如「灵·破军枪」。 */
export function itemDisplayName(t: ItemTemplate): string {
  const g = gradeDef(t.grade);
  return g ? `${g.prefix}·${t.name}` : t.name;
}

export function statOf(t: ItemTemplate, key: string): number {
  return (t.stats as Record<string, number>)[key] ?? 0;
}

/** 装备加成后的总属性（主属性 + 词条，强化 +15%/级）。 */
export function derivedStats(s: GameState): DerivedStats {
  let hpMax = 0;
  let mpMax = 0;
  let atk = 0;
  let def = 0;
  let spd = 0;
  let crit = 0;
  let luck = 0;
  for (const it of Object.values(s.equipment)) {
    if (!it) continue;
    const t = itemTemplate(it.templateId);
    if (!t) continue;
    const mult = 1 + it.plus * 0.15;
    hpMax += statOf(t, 'hpMax') * mult;
    mpMax += statOf(t, 'mpMax') * mult;
    atk += statOf(t, 'atk') * mult;
    def += statOf(t, 'def') * mult;
    spd += statOf(t, 'spd') * mult;
    crit += statOf(t, 'crit') * mult;
    luck += statOf(t, 'luck') * mult;
    for (const a of it.affixes) {
      const v = a.value * mult;
      if (a.stat === 'hpMax') hpMax += v;
      else if (a.stat === 'mpMax') mpMax += v;
      else if (a.stat === 'atk') atk += v;
      else if (a.stat === 'def') def += v;
      else if (a.stat === 'spd') spd += v;
      else if (a.stat === 'crit') crit += v;
      else if (a.stat === 'luck') luck += v;
    }
  }
  return {
    hpMax: Math.round(s.player.base.hpMax + hpMax),
    mpMax: Math.round(s.player.base.mpMax + mpMax),
    atk: Math.round(s.player.base.atk + atk),
    def: Math.round(s.player.base.def + def),
    spd: Math.round((s.player.base.spd + spd) * 10) / 10,
    crit: Math.round(s.player.base.crit + crit),
    luck: Math.round(s.player.base.luck + luck),
  };
}

/** 升级所需修为。 */
export function xpNeed(level: number): number {
  return Math.floor(40 + level * 35);
}

/** 境界层级（每 9 级一大境）。 */
export function tierOf(level: number): number {
  return Math.max(0, Math.floor((level - 1) / 9));
}

/** 大境界名。 */
export function majorRealmName(level: number): string {
  const names = ['炼气', '筑基', '金丹', '元婴', '化神', '渡劫'];
  return names[Math.min(names.length - 1, tierOf(level))] ?? '炼气';
}

/** 小阶段（初期/中期/后期/圆满）。 */
export function realmPhase(level: number): string {
  const sub = ((level - 1) % 9) + 1;
  if (sub <= 3) return '初期';
  if (sub <= 6) return '中期';
  if (sub <= 8) return '后期';
  return '圆满';
}

/** 境界显示：大境界 + 小阶段，如「筑基 · 中期」。 */
export function realmOf(level: number): string {
  return `${majorRealmName(level)} · ${realmPhase(level)}`;
}

/** 是否处于境界圆满（需要突破才能继续升级）。 */
export function atRealmPeak(level: number): boolean {
  return (level - 1) % 9 === 8;
}

/** 跨境界压制倍率：每高一个大境 +25% 伤害。 */
export function realmMult(attackerTier: number, defenderTier: number): number {
  const diff = attackerTier - defenderTier;
  return Math.max(0.25, Math.min(3, 1 + diff * 0.25));
}

/**
 * 升级结算（纯函数，运行时与离线快进共用）：
 * 修为满自动升级；境界圆满时修为封顶，需突破后才能继续。
 */
export function levelUp(p: PlayerState, onLevel: (level: number) => void): PlayerState {
  const out: PlayerState = { ...p, base: { ...p.base } };
  while (!atRealmPeak(out.level) && out.xp >= xpNeed(out.level)) {
    out.xp -= xpNeed(out.level);
    out.level += 1;
    out.base = {
      ...out.base,
      hpMax: out.base.hpMax + 30,
      atk: out.base.atk + 6,
      def: out.base.def + 4,
      spd: out.base.spd + 0.2,
      crit: out.base.crit + (out.level % 5 === 0 ? 1 : 0),
      luck: out.base.luck + (out.level % 5 === 0 ? 1 : 0),
    };
    onLevel(out.level);
  }
  if (atRealmPeak(out.level) && out.xp >= xpNeed(out.level)) {
    out.xp = xpNeed(out.level) - 1;
  }
  return out;
}

/** 伤害公式：攻防比 + 波动。 */
export function damage(atk: number, def: number, rng: () => number): number {
  return Math.max(1, Math.round(atk * (1 - def / (def + 40)) * (0.9 + rng() * 0.2)));
}

/** 装备强化等级随机（幸运加成）。 */
export function rollPlus(rng: () => number, luck: number): number {
  const r = rng() - luck * 0.001;
  if (r < 0.02) return 3;
  if (r < 0.1) return 2;
  if (r < 0.3) return 1;
  return 0;
}

/** 词条转显示文本，如「攻击 +12」。 */
export function affixText(a: ItemAffix): string {
  return `${STAT_NAMES[a.stat] ?? a.stat} +${a.value}`;
}
