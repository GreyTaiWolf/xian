/**
 * Canvas 渲染器：程序化地形、战斗时间线表现、掉落、粒子与小地图。
 */
import { Camera } from './camera';
import { gradeDef, itemTemplate } from '../game/stats';
import type { GameRuntime, Monster } from '../systems/runtime';
import type { CombatAction, CombatActorRef, CombatTimelineSnapshot } from '../systems/combat';
import { config } from '../core/config';

/** 怪物模板缓存（每帧查询优化）。 */
const MONSTER_TPL = new Map(config.monsters.monsters.map((m) => [m.id, m]));

type Point = { x: number; y: number };

interface ImpactEcho {
  actionId: number;
  startedAt: number;
  x: number;
  y: number;
  angle: number;
  cue: string;
  kind: CombatAction['kind'];
  boss: boolean;
  color: string;
}

const COLORS = {
  ink: '#06090d',
  gold: '#d7bc72',
  cyan: '#78c7d2',
  cyanBright: '#b9f3f4',
  vermilion: '#d5655d',
  vermilionBright: '#ff8b75',
  paper: '#edf1ec',
  shadow: 'rgba(4, 7, 10, 0.72)',
} as const;

const FALLBACK_DEATH_MS = 430;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function easeInOut(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function easeOut(value: number): number {
  const t = clamp01(value);
  return 1 - (1 - t) * (1 - t);
}

function actionCue(action: CombatAction): string {
  return action.cue ?? action.kind;
}

export class Renderer {
  readonly camera = new Camera();
  private vw = 1;
  private vh = 1;
  private backingWidth = 0;
  private backingHeight = 0;
  private appliedDpr = 0;
  private readonly reducedMotion =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  private readonly impactEchoes = new Map<number, ImpactEcho>();
  private minimapTerrain: ImageData | null = null;
  private minimapTerrainSize = '';

  constructor(
    private canvas: HTMLCanvasElement,
    private ctx: CanvasRenderingContext2D,
  ) {}

  /** 仅在实际像素尺寸或 DPR 变化时重建画布，避免每帧隐式清空与状态重置。 */
  resize(w: number, h: number, dpr: number): void {
    const safeW = Math.max(1, Number.isFinite(w) ? w : 1);
    const safeH = Math.max(1, Number.isFinite(h) ? h : 1);
    const safeDpr = Math.max(1, Math.min(3, Number.isFinite(dpr) ? dpr : 1));
    const backingWidth = Math.max(1, Math.round(safeW * safeDpr));
    const backingHeight = Math.max(1, Math.round(safeH * safeDpr));

    this.vw = safeW;
    this.vh = safeH;
    if (
      backingWidth === this.backingWidth &&
      backingHeight === this.backingHeight &&
      safeDpr === this.appliedDpr
    ) {
      return;
    }

    this.backingWidth = backingWidth;
    this.backingHeight = backingHeight;
    this.appliedDpr = safeDpr;
    this.canvas.width = backingWidth;
    this.canvas.height = backingHeight;
    this.ctx.setTransform(safeDpr, 0, 0, safeDpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
  }

  /** 主视口：摄像机跟随玩家，战斗位移只作用于表现层。 */
  drawWorld(rt: GameRuntime): void {
    const { ctx, camera } = this;
    const w = this.vw;
    const h = this.vh;
    const z = camera.zoom;
    camera.x = rt.player.x;
    camera.y = rt.player.y;

    const snapshot: CombatTimelineSnapshot = rt.combatSnapshot;
    const action = snapshot?.active ?? null;
    const motion = action ? this.actionMotion(rt, action) : new Map<string, Point>();
    this.captureImpact(rt, action);
    this.pruneImpacts(rt.now);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, 0, w, h);

    const shake = this.cameraShake(rt);
    ctx.save();
    ctx.translate(shake.x, shake.y);

    this.drawTerrain(ctx, rt, w, h, z);
    for (const p of config.factions.pois) {
      this.marker(ctx, w, h, p.x + 0.5, p.y + 0.5, p.char, p.color, p.kind === 'town' ? 16 : 14, p.name);
    }

    this.drawDrops(ctx, rt, w, h, z);
    if (action) {
      this.drawTelegraph(ctx, rt, action, w, h, z);
      this.drawActionTrail(ctx, rt, action, motion, w, h, z);
    }
    for (const m of rt.monsters) this.drawMonster(ctx, m, motion, w, h, z);
    this.drawParticles(ctx, rt, w, h, z);
    this.drawPlayer(ctx, rt, motion, w, h, z);
    this.drawImpactEchoes(ctx, rt, w, h, z);
    this.drawRuntimeFx(ctx, rt, w, h, z);
    this.drawDamageNumbers(ctx, rt, w, h, z);

    ctx.restore();
    this.drawVignette(ctx, w, h, Boolean(action));
  }

  private drawTerrain(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    w: number,
    h: number,
    z: number,
  ): void {
    const { camera } = this;
    const x0 = Math.floor(camera.x - w / 2 / z) - 1;
    const y0 = Math.floor(camera.y - h / 2 / z) - 1;
    const x1 = Math.ceil(camera.x + w / 2 / z) + 1;
    const y1 = Math.ceil(camera.y + h / 2 / z) + 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.max(10, z * 0.5)}px monospace`;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t = rt.map.at(x, y);
        const sx = (x + 0.5 - camera.x) * z + w / 2;
        const sy = (y + 0.5 - camera.y) * z + h / 2;
        ctx.fillStyle = `rgb(${t.g},${t.g},${t.g})`;
        ctx.fillRect(sx - z / 2, sy - z / 2, z + 0.5, z + 0.5);
        ctx.strokeStyle = 'rgba(4,7,10,.12)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(sx - z / 2, sy - z / 2, z, z);
        if (t.ch) {
          ctx.fillStyle = 'rgba(255,255,255,0.42)';
          ctx.fillText(t.ch, sx, sy + 1);
        }
      }
    }
  }

  private drawDrops(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    w: number,
    h: number,
    z: number,
  ): void {
    const reduce = this.prefersReducedMotion();
    for (const d of rt.drops) {
      const color = gradeDef(itemTemplate(d.templateId)?.grade ?? 'fan')?.color ?? '#d8d8dc';
      const { x: sx, y: sy } = this.screenPoint(d.x, d.y, w, h, z);
      const pulse = reduce ? 0.62 : 0.48 + 0.26 * Math.sin(rt.now / 280 + d.uid);
      const beam = ctx.createLinearGradient(sx, sy - z * 1.15, sx, sy);
      beam.addColorStop(0, 'rgba(255,255,255,0)');
      beam.addColorStop(0.72, color);
      beam.addColorStop(1, 'rgba(255,255,255,.88)');
      ctx.globalAlpha = pulse;
      ctx.fillStyle = beam;
      ctx.fillRect(sx - 2, sy - z * 1.15, 4, z * 0.95);
      ctx.globalAlpha = 0.92;
      this.diamond(ctx, sx, sy, Math.max(5, z * 0.32), color);
      ctx.globalAlpha = 1;
    }
  }

  private drawParticles(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    w: number,
    h: number,
    z: number,
  ): void {
    for (const p of rt.particles) {
      const a = Math.max(0, 1 - p.t / p.life);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const point = this.screenPoint(p.x, p.y, w, h, z);
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(1.5, p.size * z * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    motion: ReadonlyMap<string, Point>,
    w: number,
    h: number,
    z: number,
  ): void {
    const offset = motion.get('player') ?? { x: 0, y: 0 };
    const point = this.screenPoint(rt.player.x + offset.x, rt.player.y + offset.y, w, h, z);
    const deathProgress = rt.playerDeathProgress;
    const size = Math.max(7, z * 0.3) * (1 - deathProgress * 0.36);

    ctx.save();
    ctx.globalAlpha = 1 - deathProgress * 0.72;
    ctx.translate(point.x, point.y + deathProgress * z * 0.14);
    if (deathProgress > 0 && !this.prefersReducedMotion()) {
      ctx.rotate(deathProgress * 0.16);
    }
    ctx.shadowColor = COLORS.cyan;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.cyan;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.paper;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(size * 0.1, -size * 1.45);
    ctx.lineTo(size * 0.38, -size * 0.28);
    ctx.lineTo(0, -size * 0.48);
    ctx.closePath();
    ctx.fillStyle = COLORS.gold;
    ctx.fill();

    if (rt.player.flashT > 0) {
      ctx.globalAlpha = clamp01(rt.player.flashT / 135) * 0.82;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(9, z * 0.38), 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.restore();
  }

  private drawMonster(
    ctx: CanvasRenderingContext2D,
    monster: Monster,
    motion: ReadonlyMap<string, Point>,
    w: number,
    h: number,
    z: number,
  ): void {
    const m = monster;
    const mt = MONSTER_TPL.get(m.templateId);
    if (!mt || m.state === 'dead') return;

    const offset = motion.get(`monster:${String(m.id)}`) ?? { x: 0, y: 0 };
    const point = this.screenPoint(m.x + offset.x, m.y + offset.y, w, h, z);
    const death = this.deathAppearance(m);
    const size = Math.max(7, z * 0.3) * (mt.scale ?? 1) * death.scale;

    ctx.save();
    ctx.globalAlpha = death.alpha;
    ctx.translate(point.x, point.y);
    if (m.state === 'dying' && !this.prefersReducedMotion()) {
      ctx.rotate((1 - death.alpha) * 0.3 * (m.id % 2 === 0 ? 1 : -1));
    }
    ctx.shadowColor = mt.boss ? COLORS.vermilionBright : mt.color;
    ctx.shadowBlur = mt.boss ? 18 : 8;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.85, size * 0.7);
    ctx.lineTo(-size * 0.85, size * 0.7);
    ctx.closePath();
    ctx.fillStyle = mt.color;
    ctx.fill();
    ctx.shadowBlur = 0;
    if (mt.elite || mt.boss) {
      ctx.lineWidth = mt.boss ? 2.5 : 1.5;
      ctx.strokeStyle = mt.boss ? COLORS.vermilionBright : COLORS.gold;
      ctx.stroke();
    }

    if (m.flashT > 0) {
      ctx.globalAlpha = death.alpha * clamp01(m.flashT / 135) * 0.78;
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.globalAlpha = death.alpha;
    }
    ctx.restore();

    if (m.state === 'dying') return;
    const bw = Math.max(22, z * 0.9);
    ctx.fillStyle = 'rgba(4,7,10,.78)';
    ctx.fillRect(point.x - bw / 2 - 1, point.y - size - 13, bw + 2, 6);
    ctx.fillStyle = '#2a2a33';
    ctx.fillRect(point.x - bw / 2, point.y - size - 12, bw, 4);
    ctx.fillStyle = mt.elite ? COLORS.gold : COLORS.vermilion;
    ctx.fillRect(point.x - bw / 2, point.y - size - 12, bw * Math.max(0, m.hp / m.hpMax), 4);
    ctx.font = '10px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = mt.boss ? COLORS.vermilionBright : '#efaaa2';
    ctx.fillText(`${mt.name} Lv.${m.lvl}`, point.x, point.y - size - 19);
  }

  private deathAppearance(m: Monster): { alpha: number; scale: number } {
    if (m.state !== 'dying') return { alpha: 1, scale: 1 };
    const remaining = clamp01(m.deathT / FALLBACK_DEATH_MS);
    const eased = easeOut(remaining);
    return { alpha: Math.max(0.06, remaining), scale: 0.36 + eased * 0.64 };
  }

  private drawTelegraph(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    action: CombatAction,
    w: number,
    h: number,
    z: number,
  ): void {
    if (action.phase !== 'windup') return;
    const target = this.actorPoint(rt, action.target);
    if (!target) return;
    const point = this.screenPoint(target.x, target.y, w, h, z);
    const progress = clamp01(action.phaseProgress);
    const hostile = action.actor.kind === 'monster' || action.kind === 'enemy';
    const cue = actionCue(action);
    const boss = this.isBossActor(rt, action.actor);
    const color = hostile ? COLORS.vermilionBright : cue === 'sword_qi' ? COLORS.cyanBright : COLORS.gold;
    const radius = Math.max(13, z * (boss ? 0.78 : 0.58));
    const pulse = this.prefersReducedMotion() ? 0.72 : 0.56 + Math.sin(progress * Math.PI * 6) * 0.16;

    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = boss ? 2.5 : 1.5;
    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = this.prefersReducedMotion() ? 0 : -progress * 24;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * (1.28 - progress * 0.28), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const bracket = radius * 0.72;
    const arm = Math.max(4, radius * 0.28);
    ctx.globalAlpha = 0.35 + progress * 0.55;
    ctx.beginPath();
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        ctx.moveTo(point.x + sx * bracket, point.y + sy * (bracket - arm));
        ctx.lineTo(point.x + sx * bracket, point.y + sy * bracket);
        ctx.lineTo(point.x + sx * (bracket - arm), point.y + sy * bracket);
      }
    }
    ctx.stroke();

    if (hostile) {
      ctx.globalAlpha = 0.08 + progress * 0.12;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 0.72, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawActionTrail(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    action: CombatAction,
    motion: ReadonlyMap<string, Point>,
    w: number,
    h: number,
    z: number,
  ): void {
    const actor = this.actorPoint(rt, action.actor);
    const target = this.actorPoint(rt, action.target);
    if (!actor || !target) return;
    const cue = actionCue(action);
    const isSkill = action.kind === 'skill';
    const progress = clamp01(action.phaseProgress);
    const dx = target.x - actor.x;
    const dy = target.y - actor.y;
    const distance = Math.max(0.001, Math.hypot(dx, dy));
    const nx = dx / distance;
    const ny = dy / distance;
    const actorOffset = motion.get(this.motionKey(action.actor)) ?? { x: 0, y: 0 };

    if (action.phase === 'windup' && isSkill) {
      const center = this.screenPoint(actor.x + actorOffset.x, actor.y + actorOffset.y, w, h, z);
      this.drawSkillSeal(ctx, center, cue, progress, z);
      return;
    }
    if (action.phase !== 'travel') return;

    if (!isSkill) {
      const start = this.screenPoint(actor.x, actor.y, w, h, z);
      const end = this.screenPoint(actor.x + actorOffset.x, actor.y + actorOffset.y, w, h, z);
      ctx.save();
      ctx.globalAlpha = 0.22 + (1 - progress) * 0.48;
      ctx.strokeStyle = action.actor.kind === 'player' ? COLORS.gold : COLORS.vermilionBright;
      ctx.lineWidth = Math.max(2, z * 0.12);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const t = easeInOut(progress);
    const arc = this.prefersReducedMotion()
      ? 0
      : Math.sin(t * Math.PI) * (config.combat.visual.projectileArcTiles ?? 0.24);
    const px = actor.x + dx * t - ny * arc;
    const py = actor.y + dy * t + nx * arc;
    const head = this.screenPoint(px, py, w, h, z);
    const trailTiles = config.combat.visual.trailLengthTiles ?? 0.68;
    const tail = this.screenPoint(px - nx * trailTiles, py - ny * trailTiles, w, h, z);
    const color = cue === 'heaven_breaker' ? COLORS.gold : COLORS.cyanBright;

    ctx.save();
    const gradient = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
    gradient.addColorStop(0, 'rgba(120,199,210,0)');
    gradient.addColorStop(0.55, color);
    gradient.addColorStop(1, '#ffffff');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = cue === 'heaven_breaker' ? 6 : config.combat.visual.trailWidthPx ?? 3.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = cue === 'heaven_breaker' ? 18 : 10;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.quadraticCurveTo((tail.x + head.x) / 2 - ny * arc * z, (tail.y + head.y) / 2 + nx * arc * z, head.x, head.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    this.diamond(ctx, head.x, head.y, cue === 'heaven_breaker' ? 8 : 5, color);

    if (cue === 'sword_array') {
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + progress * Math.PI;
        this.drawBlade(ctx, head.x + Math.cos(angle) * 12, head.y + Math.sin(angle) * 8, angle + Math.PI / 2, 10, color);
      }
    }
    ctx.restore();
  }

  private drawSkillSeal(ctx: CanvasRenderingContext2D, p: Point, cue: string, progress: number, z: number): void {
    const color = cue === 'heaven_breaker' ? COLORS.gold : COLORS.cyanBright;
    const radius = Math.max(13, z * (cue === 'heaven_breaker' ? 0.68 : 0.5));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(this.prefersReducedMotion() ? 0 : progress * Math.PI * 0.8);
    ctx.globalAlpha = 0.24 + progress * 0.64;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const b = a + Math.PI * 2 / 6;
      ctx.moveTo(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.lineTo(Math.cos(b) * radius, Math.sin(b) * radius);
      ctx.lineTo(0, 0);
    }
    ctx.stroke();
    if (cue === 'heaven_breaker') {
      ctx.globalAlpha = 0.15 + progress * 0.38;
      ctx.fillStyle = color;
      ctx.fillRect(-2, -radius * 2.2, 4, radius * 2.5);
    }
    ctx.restore();
  }

  private actionMotion(rt: GameRuntime, action: CombatAction): Map<string, Point> {
    const result = new Map<string, Point>();
    const actor = this.actorPoint(rt, action.actor);
    const target = this.actorPoint(rt, action.target);
    if (!actor || !target || !action.phase) return result;
    const dx = target.x - actor.x;
    const dy = target.y - actor.y;
    const distance = Math.max(0.001, Math.hypot(dx, dy));
    const nx = dx / distance;
    const ny = dy / distance;
    const p = clamp01(action.phaseProgress);
    const motionScale = this.prefersReducedMotion() ? 0.18 : 1;
    const lunge = (config.combat.visual.lungeDistanceTiles ?? 0.42) * motionScale;
    const recoil = (config.combat.visual.recoilDistanceTiles ?? 0.12) * motionScale;
    const isSkill = action.kind === 'skill';
    let actorDistance = 0;
    let targetDistance = 0;

    switch (action.phase) {
      case 'windup':
        actorDistance = -0.12 * easeOut(p) * motionScale;
        break;
      case 'travel':
        actorDistance = (isSkill ? 0.08 : lunge) * easeInOut(p);
        break;
      case 'impact':
        actorDistance = (isSkill ? 0.08 : lunge) * (1 - p * 0.18);
        targetDistance = recoil * Math.sin(p * Math.PI);
        break;
      case 'recover':
        actorDistance = (isSkill ? 0.08 : lunge) * (1 - easeOut(p));
        targetDistance = recoil * (1 - easeOut(p));
        break;
    }

    result.set(this.motionKey(action.actor), { x: nx * actorDistance, y: ny * actorDistance });
    result.set(this.motionKey(action.target), { x: nx * targetDistance, y: ny * targetDistance });
    return result;
  }

  private captureImpact(rt: GameRuntime, action: CombatAction | null): void {
    if (!action || action.phase !== 'impact' || this.impactEchoes.has(action.actionId)) return;
    const actor = this.actorPoint(rt, action.actor);
    const target = this.actorPoint(rt, action.target);
    if (!actor || !target) return;
    const cue = actionCue(action);
    this.impactEchoes.set(action.actionId, {
      actionId: action.actionId,
      startedAt: rt.now,
      x: target.x,
      y: target.y,
      angle: Math.atan2(target.y - actor.y, target.x - actor.x),
      cue,
      kind: action.kind,
      boss: this.isBossActor(rt, action.actor),
      color:
        action.actor.kind === 'monster' || action.kind === 'enemy'
          ? COLORS.vermilionBright
          : cue === 'heaven_breaker'
            ? COLORS.gold
            : COLORS.cyanBright,
    });
  }

  private pruneImpacts(now: number): void {
    const life = config.combat.visual.impactRingMs ?? 260;
    for (const [id, echo] of this.impactEchoes) {
      if (now - echo.startedAt > life) this.impactEchoes.delete(id);
    }
  }

  private drawImpactEchoes(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    w: number,
    h: number,
    z: number,
  ): void {
    const life = config.combat.visual.impactRingMs ?? 260;
    for (const echo of this.impactEchoes.values()) {
      const p = clamp01((rt.now - echo.startedAt) / life);
      const alpha = (1 - p) * (1 - p);
      const center = this.screenPoint(echo.x, echo.y, w, h, z);
      const start = config.combat.visual.impactRingStartPx ?? 7;
      const end = config.combat.visual.impactRingEndPx ?? 34;
      const radius = start + (end - start) * easeOut(p) * (echo.boss ? 1.35 : 1);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = echo.color;
      ctx.lineWidth = echo.boss ? 3 : 2;
      ctx.shadowColor = echo.color;
      ctx.shadowBlur = echo.boss ? 18 : 10;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const slashLength = (config.combat.visual.slashLengthPx ?? 48) * (echo.cue === 'heaven_breaker' ? 1.65 : 1);
      const slashAngle = echo.cue === 'heaven_breaker' ? Math.PI / 2 : echo.angle + Math.PI / 3;
      ctx.lineWidth = echo.cue === 'heaven_breaker' ? 6 : config.combat.visual.slashWidthPx ?? 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(center.x - Math.cos(slashAngle) * slashLength / 2, center.y - Math.sin(slashAngle) * slashLength / 2);
      ctx.lineTo(center.x + Math.cos(slashAngle) * slashLength / 2, center.y + Math.sin(slashAngle) * slashLength / 2);
      ctx.stroke();

      if (echo.cue === 'sword_array') {
        for (let i = 0; i < 3; i++) {
          const angle = (i / 3) * Math.PI * 2 + p * 0.5;
          this.drawBlade(ctx, center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius, angle + Math.PI / 2, 14, echo.color);
        }
      }
      if (echo.boss) {
        ctx.globalAlpha = alpha * 0.62;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** 运行时命中事件是事实源；这里仅把 ring/slash/burst 翻译为程序化图形。 */
  private drawRuntimeFx(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    w: number,
    h: number,
    z: number,
  ): void {
    for (const fx of rt.combatFx) {
      const p = clamp01(fx.t / Math.max(0.001, fx.life));
      const alpha = (1 - p) * (fx.critical ? 0.98 : 0.72);
      const scale = fx.critical ? config.combat.visual.criticalScale ?? 1.28 : 1;
      const center = this.screenPoint(fx.x, fx.y, w, h, z);
      const cueScale = fx.cue === 'heaven_breaker' ? 1.55 : fx.cue === 'sword_array' ? 1.18 : 1;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = fx.color;
      ctx.fillStyle = fx.color;
      ctx.shadowColor = fx.color;
      ctx.shadowBlur = fx.critical ? 20 : 10;

      if (fx.kind === 'ring') {
        const radius = (8 + easeOut(p) * 36) * scale * cueScale;
        ctx.lineWidth = fx.critical ? 3.5 : 2;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        if (fx.critical) {
          ctx.globalAlpha = alpha * 0.48;
          ctx.beginPath();
          ctx.arc(center.x, center.y, radius * 0.58, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (fx.kind === 'slash') {
        const length = (config.combat.visual.slashLengthPx ?? 48) * scale * cueScale;
        const angle = fx.cue === 'heaven_breaker' ? Math.PI / 2 : -Math.PI / 4;
        ctx.lineWidth = (config.combat.visual.slashWidthPx ?? 4) * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(center.x - Math.cos(angle) * length / 2, center.y - Math.sin(angle) * length / 2);
        ctx.quadraticCurveTo(center.x + length * 0.08, center.y - length * 0.12, center.x + Math.cos(angle) * length / 2, center.y + Math.sin(angle) * length / 2);
        ctx.stroke();
      } else {
        const rayLength = (15 + p * 28) * scale * cueScale;
        ctx.lineWidth = fx.critical ? 2.5 : 1.5;
        ctx.beginPath();
        for (let i = 0; i < (fx.critical ? 10 : 7); i++) {
          const angle = (i / (fx.critical ? 10 : 7)) * Math.PI * 2 + p * 0.35;
          const inner = 6 + p * 8;
          ctx.moveTo(center.x + Math.cos(angle) * inner, center.y + Math.sin(angle) * inner);
          ctx.lineTo(center.x + Math.cos(angle) * rayLength, center.y + Math.sin(angle) * rayLength);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawDamageNumbers(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    w: number,
    h: number,
    z: number,
  ): void {
    ctx.font = `bold ${Math.max(12, z * 0.55)}px Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of rt.dmgNumbers) {
      const a = Math.max(0, 1 - n.t / 0.8);
      ctx.globalAlpha = a;
      ctx.fillStyle = n.color;
      ctx.shadowColor = COLORS.shadow;
      ctx.shadowBlur = 4;
      const point = this.screenPoint(n.x, n.y, w, h, z);
      ctx.fillText(n.text, point.x, point.y);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  private cameraShake(rt: GameRuntime): Point {
    if (this.prefersReducedMotion() || this.impactEchoes.size === 0) return { x: 0, y: 0 };
    const now = rt.now;
    const duration = config.combat.visual.screenShakeMs ?? 145;
    const critical = rt.combatFx.some((fx) => fx.critical && fx.t < fx.life);
    let x = 0;
    let y = 0;
    for (const echo of this.impactEchoes.values()) {
      const p = clamp01((now - echo.startedAt) / duration);
      if (p >= 1) continue;
      const max = echo.boss
        ? config.combat.visual.bossScreenShakePx ?? 7.5
        : config.combat.visual.screenShakePx ?? 4.5;
      const criticalScale = critical ? config.combat.visual.criticalShakeMultiplier ?? 1.45 : 1;
      const strength = max * criticalScale * (1 - p) * (1 - p);
      // 由 actionId 派生，确保表现层可复现且不消耗玩法随机流。
      x += Math.sin(echo.actionId * 12.9898 + p * 43.1) * strength;
      y += Math.cos(echo.actionId * 7.233 + p * 37.7) * strength * 0.72;
    }
    return { x, y };
  }

  private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number, inCombat: boolean): void {
    const radius = Math.max(w, h) * 0.68;
    const gradient = ctx.createRadialGradient(w / 2, h / 2, radius * 0.35, w / 2, h / 2, radius);
    gradient.addColorStop(0, 'rgba(4,7,10,0)');
    gradient.addColorStop(0.72, inCombat ? 'rgba(4,7,10,.12)' : 'rgba(4,7,10,.08)');
    gradient.addColorStop(1, inCombat ? 'rgba(4,7,10,.58)' : 'rgba(4,7,10,.42)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = inCombat ? 'rgba(215,188,114,.26)' : 'rgba(215,188,114,.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(7.5, 7.5, Math.max(0, w - 15), Math.max(0, h - 15));
  }

  private actorPoint(rt: GameRuntime, actor: CombatActorRef): Point | null {
    if (actor.kind === 'player') return { x: rt.player.x, y: rt.player.y };
    const exact = rt.monsters.find((m) => m.id === actor.id);
    const monster = exact ?? rt.monsters.find((m) => String(m.id) === String(actor.id));
    return monster ? { x: monster.x, y: monster.y } : null;
  }

  private motionKey(actor: CombatActorRef): string {
    return actor.kind === 'player' ? 'player' : `monster:${String(actor.id)}`;
  }

  private isBossActor(rt: GameRuntime, actor: CombatActorRef): boolean {
    if (actor.kind !== 'monster') return false;
    const monster = rt.monsters.find((m) => String(m.id) === String(actor.id));
    return Boolean(monster && MONSTER_TPL.get(monster.templateId)?.boss);
  }

  private screenPoint(wx: number, wy: number, w: number, h: number, z: number): Point {
    return {
      x: (wx - this.camera.x) * z + w / 2,
      y: (wy - this.camera.y) * z + h / 2,
    };
  }

  private prefersReducedMotion(): boolean {
    return this.reducedMotion?.matches ?? false;
  }

  private drawBlade(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    length: number,
    color: string,
  ): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -length / 2);
    ctx.lineTo(2.2, length * 0.24);
    ctx.lineTo(0, length / 2);
    ctx.lineTo(-2.2, length * 0.24);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  private marker(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    wx: number,
    wy: number,
    ch: string,
    color: string,
    size: number,
    label: string,
  ): void {
    const point = this.screenPoint(wx, wy, w, h, this.camera.zoom);
    ctx.font = `${size}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(ch, point.x, point.y);
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#e8e8ec';
    ctx.fillText(label, point.x, point.y + size * 0.8);
  }

  private diamond(ctx: CanvasRenderingContext2D, sx: number, sy: number, r: number, color: string): void {
    ctx.beginPath();
    ctx.moveTo(sx, sy - r);
    ctx.lineTo(sx + r * 0.75, sy);
    ctx.lineTo(sx, sy + r);
    ctx.lineTo(sx - r * 0.75, sy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** 小地图地形层（由调用方按玩家附近的细粒度中心缓存）。 */
  drawMinimapTerrain(mctx: CanvasRenderingContext2D, rt: GameRuntime, wpx: number, hpx: number): void {
    const tpp = 2;
    const halfW = wpx / tpp / 2;
    const halfH = hpx / tpp / 2;
    mctx.clearRect(0, 0, wpx, hpx);
    for (let sy = 0; sy < hpx; sy++) {
      for (let sx = 0; sx < wpx; sx++) {
        const wx = rt.player.x - halfW + (sx + 0.5) / tpp;
        const wy = rt.player.y - halfH + (sy + 0.5) / tpp;
        const t = rt.map.at(wx, wy);
        mctx.fillStyle = `rgb(${t.g},${t.g},${t.g})`;
        mctx.fillRect(sx, sy, 1.05, 1.05);
      }
    }
    this.minimapTerrain = mctx.getImageData(0, 0, wpx, hpx);
    this.minimapTerrainSize = `${wpx}x${hpx}`;
  }

  /** 小地图覆盖层（玩家/地标/视口框，每帧绘制）。 */
  drawMinimapOverlay(mctx: CanvasRenderingContext2D, rt: GameRuntime, wpx: number, hpx: number): void {
    const tpp = 2;
    if (this.minimapTerrain && this.minimapTerrainSize === `${wpx}x${hpx}`) {
      mctx.putImageData(this.minimapTerrain, 0, 0);
    }
    mctx.fillStyle = COLORS.cyan;
    mctx.fillRect(wpx / 2 - 2, hpx / 2 - 2, 4, 4);
    for (const p of config.factions.pois) {
      const sx = wpx / 2 + (p.x + 0.5 - rt.player.x) * tpp;
      const sy = hpx / 2 + (p.y + 0.5 - rt.player.y) * tpp;
      if (sx < -4 || sy < -4 || sx > wpx + 4 || sy > hpx + 4) continue;
      mctx.fillStyle = p.color;
      mctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
    }
    mctx.strokeStyle = 'rgba(255,255,255,.35)';
    mctx.strokeRect(
      wpx / 2 - (this.vw / this.camera.zoom / 2) * tpp,
      hpx / 2 - (this.vh / this.camera.zoom / 2) * tpp,
      (this.vw / this.camera.zoom) * tpp,
      (this.vh / this.camera.zoom) * tpp,
    );
  }
}
