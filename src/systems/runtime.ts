/**
 * 游戏运行时：玩家 / 怪物 / 战斗 / 掉落 / 成长 —— 世界层与玩法层的胶水。
 * 可存档数据事件性同步进 Store；热数据（HP/位置/怪物）只在此处。
 * M2 起，天道 AI 将通过事件指令影响此处的实体与刷新。
 */
import { bus, type LogCls } from '../core/eventbus';
import type { SfxName } from '../audio/sfx';
import { config } from '../core/config';
import { mulberry32, randInt } from '../core/rng';
import type { Store } from '../core/store';
import type { EquipSlot, GameState, GroundDrop, ItemAffix } from '../game/state';
import { SPAWN_POS, nextUid } from '../game/state';
import {
  atRealmPeak,
  damage,
  derivedStats,
  gradeDefColor,
  gradeTier,
  itemDisplayName,
  itemTemplate,
  levelUp,
  realmMult,
  realmOf,
  rollPlus,
  tierOf,
  xpNeed,
} from '../game/stats';
import { generateAffixes } from '../game/equipment-gen';
import { World } from '../world/map';
import { rollTable, type RolledLoot } from './loot';
import { pickTravelEvent, resolveTravelEvent as resolveTravelEventFn } from './travelEvents';
import {
  CombatTimeline,
  type CombatAction,
  type CombatActionTimings,
  type CombatTimelineEvent,
  type CombatTimelineSnapshot,
} from './combat';
import {
  advanceTrialWave,
  beginTrialWave,
  canAdvanceTrialWave,
  createTrialRun,
  failTrial,
  recordTrialDefeat,
  type TrialRun,
} from './trial';

export interface Monster {
  id: number;
  templateId: string;
  x: number;
  y: number;
  spawnX: number;
  spawnY: number;
  hp: number;
  hpMax: number;
  /** 以下为按距出生点距离缩放后的实际值 */
  lvl: number;
  atk: number;
  def: number;
  xp: number;
  state: 'idle' | 'chase' | 'dying' | 'dead';
  respawnAt: number;
  atkCd: number;
  /** 受击闪白剩余 ms */
  flashT: number;
  /** 死亡演出的剩余时间；归零后才进行收益结算与消失。 */
  deathT: number;
  /** 大世界怪会复活，秘境怪只属于当前 encounter。 */
  source: 'world' | 'trial';
  encounterId: string | null;
  wanderT: number;
  wanderX: number;
  wanderY: number;
}

export interface DmgNumber {
  x: number;
  y: number;
  text: string;
  color: string;
  t: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  color: string;
  size: number;
}

export interface CombatFx {
  kind: 'ring' | 'slash' | 'burst';
  x: number;
  y: number;
  t: number;
  life: number;
  color: string;
  critical: boolean;
  cue: string;
}

export interface HudSkill {
  id: string;
  name: string;
  shortName: string;
  mp: number;
  cooldown: number;
  cooldownMax: number;
  unlocked: boolean;
  ready: boolean;
}

export interface HudTarget {
  id: number;
  name: string;
  level: number;
  hp: number;
  hpMax: number;
  elite: boolean;
  boss: boolean;
  distance: number;
}

export interface HudTrial {
  status: TrialRun['status'];
  floor: number;
  name: string;
  wave: number;
  waveCount: number;
  defeated: number;
  total: number;
  nextWaveIn: number;
}

export interface HudData {
  hp: number;
  mp: number;
  hpMax: number;
  mpMax: number;
  xp: number;
  xpMax: number;
  level: number;
  atk: number;
  def: number;
  spd: number;
  crit: number;
  luck: number;
  money: number;
  kills: number;
  pity: number;
  pityMax: number;
  realm: string;
  power: number;
  skillCd: number;
  skillCdMax: number;
  skillName: string;
  /** 灵潮标签（无则 null） */
  auraLabel: string | null;
  /** 境界圆满，可突破 */
  canBreak: boolean;
  /** 靠近秘境且可进入 */
  realmReady: boolean;
  /** V2 技能列、锁定目标、行动时间线与秘境状态。 */
  skills: HudSkill[];
  target: HudTarget | null;
  combat: CombatTimelineSnapshot;
  actionLabel: string;
  actionPhase: string;
  trial: HudTrial | null;
  pendingTrialRewards: number;
}

type MonsterTemplate = (typeof config.monsters.monsters)[number];

const PITY_THRESHOLD = 10;
const PLAYER_RADIUS = 0.28;
const MONSTER_RADIUS = 0.25;
const ATTACK_RANGE = 1.15;
const PICKUP_RADIUS = 0.6;
const REGEN_DELAY = 5000;
const LEASH_RANGE = 10;
const DEATH_ANIMATION_MS = 430;
const PLAYER_ACTOR = { kind: 'player', id: 'hero' } as const;

export class GameRuntime {
  readonly map: World;
  readonly player = { x: 0, y: 0, hp: 0, mp: 0, flashT: 0 };
  monsters: Monster[] = [];
  drops: GroundDrop[] = [];
  dmgNumbers: DmgNumber[] = [];
  particles: Particle[] = [];
  combatFx: CombatFx[] = [];
  moveDir = { x: 0, y: 0 };
  moveTarget: { x: number; y: number } | null = null;
  now = performance.now();
  readonly combat = new CombatTimeline(this.now);
  /** 灵潮增益（天道导演可施加） */
  aura: { xpMult: number; untilDay: number } | null = null;
  /** 秘境运行态不入档；只把通关、冷却和待选奖励写入 Store。 */
  trialRun: TrialRun | null = null;
  /** 行路异闻：累计行走距离与下一次触发距离 */
  private travelled = 0;
  private nextTriggerDist = config.travelEvents.trigger.interval;

  private rng: () => number;
  private visualRng: () => number;
  private atkCd = 0;
  private readonly skillCooldowns = new Map<string, number>();
  private hurtT = -1e9;
  private hudT = 0;
  private syncT = 0;
  private maintainT = 0;
  private mid = 1;
  private trialSeq = 1;
  private actionLabel = '寻敌';
  private actionPhase = '待机';
  private playerDeath: { killerId: number; remainingMs: number } | null = null;

  constructor(
    private store: Store<GameState>,
    readonly log: (cls: LogCls, text: string) => void,
    readonly sfx?: (name: SfxName) => void,
  ) {
    const s = store.get();
    this.map = new World(s.world.seed);
    this.rng = mulberry32((s.world.seed ^ 0x51ab) >>> 0);
    // 表现随机流与数值随机流严格分离，改变粒子数量不会改变暴击或掉落。
    this.visualRng = mulberry32((s.world.seed ^ 0xa711ce) >>> 0);
    for (const skill of config.skills.skills) this.skillCooldowns.set(skill.id, 0);
    // 出生保护：若存档位置不可行走（世界生成参数变更等），拉回出生点
    if (!this.map.isWalkable(s.player.pos.x, s.player.pos.y)) {
      this.player.x = SPAWN_POS.x;
      this.player.y = SPAWN_POS.y;
    } else {
      this.player.x = s.player.pos.x;
      this.player.y = s.player.pos.y;
    }
    this.player.hp = s.player.hp;
    this.player.mp = s.player.mp;
    this.drops = s.drops;
    this.spawnBoss();
  }

  get combatSnapshot(): CombatTimelineSnapshot {
    return this.combat.getSnapshot();
  }

  get playerDeathProgress(): number {
    if (!this.playerDeath) return 0;
    return Math.max(0, Math.min(1, 1 - this.playerDeath.remainingMs / DEATH_ANIMATION_MS));
  }

  // ---------------- 状态辅助 ----------------
  getState(): GameState {
    return this.store.get();
  }

  setState(updater: (st: GameState) => GameState): void {
    this.store.set(updater);
  }

  addMoney(delta: number): boolean {
    if (this.store.get().player.money + delta < 0) return false;
    this.store.set((st) => ({ ...st, player: { ...st.player, money: st.player.money + delta } }));
    return true;
  }

  /** 气血灵力回满。 */
  healFull(): void {
    const st = this.stats();
    this.player.hp = st.hpMax;
    this.player.mp = st.mpMax;
  }

  private stats() {
    return derivedStats(this.store.get());
  }

  private monsterTemplate(id: string): MonsterTemplate | undefined {
    return config.monsters.monsters.find((t) => t.id === id);
  }

  // ---------------- 怪物出生（动态刷怪 + 距出生点等级梯度） ----------------
  private poi(kind: string): { x: number; y: number } {
    const p = config.factions.pois.find((q) => q.kind === kind);
    return { x: p?.x ?? SPAWN_POS.x, y: p?.y ?? SPAWN_POS.y };
  }

  private spawnBoss(): void {
    const mt = this.monsterTemplate('wolf_king');
    const p = this.poi('boss');
    if (mt) this.pushMonster(mt, p.x + 0.5, p.y + 0.5);
  }

  /** 维持玩家周围的目标怪物密度（等级随距出生点距离递增）。 */
  private spawnMaintain(): void {
    const sp = config.spawns;
    for (const pt of sp.perType) {
      const mt = this.monsterTemplate(pt.monster);
      if (!mt) continue;
      let alive = 0;
      for (const m of this.monsters) {
        if (
          m.templateId === pt.monster &&
          m.state !== 'dead' &&
          Math.hypot(m.x - this.player.x, m.y - this.player.y) < sp.spawnRadius
        ) {
          alive += 1;
        }
      }
      if (alive >= pt.count) continue;
      const toSpawn = Math.min(2, pt.count - alive);
      for (let i = 0; i < toSpawn; i++) {
        const pos = this.findSpawnPos(mt);
        if (pos) this.pushMonster(mt, pos.x, pos.y);
      }
    }
  }

  private findSpawnPos(mt: MonsterTemplate): { x: number; y: number } | null {
    const sp = config.spawns;
    const pred = (b: string): boolean =>
      mt.id === 'wolf'
        ? b === 'forest' || b === 'grass'
        : mt.id === 'panther'
          ? b === 'grass' || b === 'sand'
          : b === 'grass' || b === 'sand' || b === 'forest';
    for (let i = 0; i < 80; i++) {
      const a = this.rng() * Math.PI * 2;
      const d = sp.bandMin + this.rng() * (sp.bandMax - sp.bandMin);
      const x = this.player.x + Math.cos(a) * d;
      const y = this.player.y + Math.sin(a) * d;
      const t = this.map.at(x, y);
      if (t.walkable && pred(t.biome)) return { x, y };
    }
    return null;
  }

  private pushMonster(
    mt: MonsterTemplate,
    x: number,
    y: number,
    extraPower = 0,
    source: Monster['source'] = 'world',
    encounterId: string | null = null,
  ): Monster {
    const dist = Math.hypot(x - SPAWN_POS.x, y - SPAWN_POS.y);
    const power = Math.min(
      1 + dist / config.spawns.levelScaleDist + extraPower,
      config.spawns.powerCap + 1,
    );
    const monster: Monster = {
      id: this.mid++,
      templateId: mt.id,
      x,
      y,
      spawnX: x,
      spawnY: y,
      hp: Math.round(mt.hp * power),
      hpMax: Math.round(mt.hp * power),
      lvl: mt.lvl + Math.floor(dist / 20),
      atk: Math.round(mt.atk * power),
      def: Math.round(mt.def * power),
      xp: Math.round(mt.xp * power),
      state: 'idle',
      respawnAt: 0,
      atkCd: 0,
      flashT: 0,
      deathT: 0,
      source,
      encounterId,
      wanderT: 0,
      wanderX: 0,
      wanderY: 0,
    };
    this.monsters.push(monster);
    return monster;
  }

  // ---------------- 主更新 ----------------
  update(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;
    // 直接调用运行时（测试/离线工具）也按小步推进，避免长帧越过命中与死亡演出。
    let remaining = Math.min(dtMs, 5000);
    while (remaining > 0) {
      const step = Math.min(50, remaining);
      this.updateStep(step);
      remaining -= step;
    }
  }

  private updateStep(dtMs: number): void {
    const dt = dtMs / 1000;
    const combatDtMs = dtMs * this.store.get().settings.combatSpeed;
    this.now += dtMs;
    const st = this.stats();

    // 先衰减旧帧表现，再结算本帧命中，保证新闪光至少经历一次 render。
    this.player.flashT = Math.max(0, this.player.flashT - dtMs);
    for (const m of this.monsters) m.flashT = Math.max(0, m.flashT - dtMs);
    if (this.playerDeath) {
      this.playerDeath.remainingMs -= combatDtMs;
      if (this.playerDeath.remainingMs <= 0) this.completePlayerDeath();
    }

    // 玩家移动（记录实际位移用于异闻触发）
    const prevX = this.player.x;
    const prevY = this.player.y;
    let dx = this.moveDir.x;
    let dy = this.moveDir.y;
    if (dx === 0 && dy === 0 && this.moveTarget) {
      const vx = this.moveTarget.x - this.player.x;
      const vy = this.moveTarget.y - this.player.y;
      const d = Math.hypot(vx, vy);
      if (d < 0.2) this.moveTarget = null;
      else {
        dx = vx / d;
        dy = vy / d;
      }
    }
    if ((dx !== 0 || dy !== 0) && !this.playerDeath && !this.combat.hasActor(PLAYER_ACTOR)) {
      this.moveEntity(this.player, st.spd, dx, dy, dt, PLAYER_RADIUS);
    }
    this.travelled += Math.hypot(this.player.x - prevX, this.player.y - prevY);
    this.maybeTriggerTravelEvent();

    // 脱战回复
    if (!this.playerDeath && this.now - this.hurtT > REGEN_DELAY) {
      this.player.hp = Math.min(st.hpMax, this.player.hp + 2 * dt);
      this.player.mp = Math.min(st.mpMax, this.player.mp + 1.5 * dt);
    } else if (!this.playerDeath) {
      this.player.mp = Math.min(st.mpMax, this.player.mp + 0.5 * dt);
    }

    // 冷却
    this.atkCd -= combatDtMs;
    for (const [id, cooldown] of this.skillCooldowns) {
      this.skillCooldowns.set(id, Math.max(0, cooldown - combatDtMs));
    }

    this.updateTrialFlow();

    // 动态刷怪
    this.maintainT -= dtMs;
    if (this.maintainT <= 0) {
      this.maintainT = config.spawns.updateIntervalMs;
      if (!this.trialRun || (this.trialRun.status !== 'active' && this.trialRun.status !== 'between')) {
        this.spawnMaintain();
      }
    }

    // 怪物 AI
    for (const m of this.monsters) {
      const mt = this.monsterTemplate(m.templateId);
      if (!mt) continue;
      if (m.state === 'dead') {
        if (m.source === 'world' && this.now >= m.respawnAt) {
          m.state = 'idle';
          m.hp = m.hpMax;
          m.x = m.spawnX;
          m.y = m.spawnY;
        }
        continue;
      }
      if (m.state === 'dying') {
        m.deathT = Math.max(0, m.deathT - combatDtMs);
        if (m.deathT <= 0) this.finalizeKill(m);
        continue;
      }
      if (!this.isCurrentCombatant(m) || this.playerDeath) continue;
      const distP = Math.hypot(m.x - this.player.x, m.y - this.player.y);
      const distSpawn = Math.hypot(m.x - m.spawnX, m.y - m.spawnY);
      if (distP < mt.aggro) m.state = 'chase';
      if (m.state === 'chase') {
        if (distSpawn > LEASH_RANGE && distP > mt.aggro) {
          // 脱战回巢
          this.moveEntity(m, mt.spd, m.spawnX - m.x, m.spawnY - m.y, dt, MONSTER_RADIUS);
          if (distSpawn < 0.3) {
            m.state = 'idle';
            m.hp = m.hpMax;
          }
        } else if (!this.combat.hasActor(this.monsterActor(m))) {
          this.moveEntity(m, mt.spd, this.player.x - m.x, this.player.y - m.y, dt, MONSTER_RADIUS);
        }
        m.atkCd -= combatDtMs;
        const currentDist = Math.hypot(m.x - this.player.x, m.y - this.player.y);
        if (currentDist < 1.05 && m.atkCd <= 0) this.queueEnemyAttack(m, mt);
      } else {
        // 游荡
        m.wanderT -= dt;
        if (m.wanderT <= 0) {
          m.wanderT = 1.5 + this.rng() * 2;
          const a = this.rng() * Math.PI * 2;
          m.wanderX = Math.cos(a) * 0.5;
          m.wanderY = Math.sin(a) * 0.5;
        }
        this.moveEntity(m, mt.spd, m.wanderX, m.wanderY, dt * 0.5, MONSTER_RADIUS);
      }
    }

    // 玩家意图排在怪物意图之后统一进入排序器；最终次序只由优先级/readyAt/速度/ID 决定。
    if (!this.playerDeath && !this.combat.hasActor(PLAYER_ACTOR)) {
      const autoCast = this.store.get().settings.autoSkills && this.tryAutoSkill();
      if (!autoCast && this.atkCd <= 0) this.queuePlayerBasic(st.spd);
    }

    this.combat.advance(combatDtMs, {
      canStart: (action) => this.canStartCombatAction(action),
      onEvent: (event) => this.onCombatEvent(event),
    });

    // 自动拾取
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (Math.hypot(d.x - this.player.x, d.y - this.player.y) < PICKUP_RADIUS) this.pickup(d);
    }

    // 伤害数字动画
    for (let i = this.dmgNumbers.length - 1; i >= 0; i--) {
      const n = this.dmgNumbers[i];
      n.t += dt;
      n.y -= 0.5 * dt;
      if (n.t > 0.8) this.dmgNumbers.splice(i, 1);
    }

    // 粒子动画
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.t += dt;
      if (p.t >= p.life) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 1.2 * dt;
    }

    for (let i = this.combatFx.length - 1; i >= 0; i--) {
      const fx = this.combatFx[i];
      fx.t += dt;
      if (fx.t >= fx.life) this.combatFx.splice(i, 1);
    }

    // HUD / 存档同步
    this.hudT -= dtMs;
    this.syncT -= dtMs;
    // 战斗中按模拟帧刷新行动播报；脱战时降至 4Hz，兼顾阶段可见性与 DOM 开销。
    const combatHudActive = !!this.combat.active || this.combat.queued.length > 0 || !!this.playerDeath;
    if (combatHudActive || this.hudT <= 0) {
      this.hudT = 250;
      bus.emit('hud', this.hudData());
    }
    if (this.syncT <= 0) {
      this.syncT = 5000;
      this.sync();
    }
  }

  // ---------------- 移动 ----------------
  private moveEntity(
    e: { x: number; y: number },
    speed: number,
    dx: number,
    dy: number,
    dt: number,
    radius: number,
  ): void {
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    const step = speed * dt;
    const mx = (dx / d) * step;
    const my = (dy / d) * step;
    if (mx !== 0 && this.map.isWalkable(e.x + mx + Math.sign(mx) * radius, e.y)) e.x += mx;
    if (my !== 0 && this.map.isWalkable(e.x, e.y + my + Math.sign(my) * radius)) e.y += my;
  }

  // ---------------- 天道钩子（世界导演调用） ----------------
  /** 灵潮：一定天数内修为加成。 */
  setAura(xpMult: number, durationDays: number): void {
    this.aura = { xpMult, untilDay: this.store.get().world.day + durationDays };
  }

  /** 兽潮：在目标附近刷一波强化怪。 */
  spawnWave(count: number, powerBonus: number, target: 'player' | 'town'): void {
    const p = target === 'town' ? this.poi('town') : { x: this.player.x, y: this.player.y };
    const pool = config.monsters.monsters.filter((m) => !m.boss);
    for (let i = 0; i < count; i++) {
      const mt = pool[Math.floor(this.rng() * pool.length)];
      const a = this.rng() * Math.PI * 2;
      const d = 3 + this.rng() * 5;
      const x = p.x + Math.cos(a) * d;
      const y = p.y + Math.sin(a) * d;
      if (this.map.at(x, y).walkable) this.pushMonster(mt, x, y, powerBonus);
      else this.pushMonster(mt, p.x + 1 + this.rng() * 2, p.y + 1 + this.rng() * 2, powerBonus);
    }
  }

  private auraMult(): number {
    const a = this.aura;
    return a && this.store.get().world.day <= a.untilDay ? a.xpMult : 1;
  }

  // ---------------- M3：突破 / 宗门 / 任务 / 秘境 / 合成 / 强化 ----------------
  /** 境界突破（圆满时调用）；渡劫圆满再突破 = 飞升转世。 */
  breakthrough(): void {
    const s = this.store.get();
    const p = s.player;
    const tier = tierOf(p.level);
    if (!atRealmPeak(p.level)) {
      this.log('badl', '[突破] 当前境界尚未圆满，还无法突破。');
      return;
    }
    const r = config.realms.realms[tier];
    if (!r) return;
    if (p.money < r.breakthrough.money) {
      this.log('badl', `[突破] 灵石不足（需 <b class="num">${r.breakthrough.money}</b>）。`);
      return;
    }
    const itemName = itemTemplate(r.breakthrough.item)?.name ?? r.breakthrough.item;
    if (this.countItem(r.breakthrough.item) < r.breakthrough.count) {
      this.log('badl', `[突破] 材料不足（需 ${itemName}×${r.breakthrough.count}）。`);
      return;
    }
    this.store.set((st) => ({
      ...st,
      player: { ...st.player, money: st.player.money - r.breakthrough.money },
    }));
    this.removeItemCount(r.breakthrough.item, r.breakthrough.count);
    // 成功率：基础 + 幸运 + 心境 + 悟性
    const rate = Math.min(
      0.95,
      r.breakthrough.successBase +
        this.stats().luck * r.breakthrough.successLuck +
        p.mind * 0.001 +
        p.insight * 0.001,
    );
    if (this.rng() < rate) {
      if (tier >= config.realms.realms.length - 1) {
        // 飞升：转世重修，基础属性 +15%
        this.store.set((st) => {
          const b = st.player.base;
          return {
            ...st,
            player: {
              ...st.player,
              level: 1,
              xp: 0,
              ascension: st.player.ascension + 1,
              mind: Math.min(100, st.player.mind + 5),
              base: {
                hpMax: Math.round(b.hpMax * 1.15),
                mpMax: Math.round(b.mpMax * 1.15),
                atk: Math.round(b.atk * 1.15),
                def: Math.round(b.def * 1.15),
                spd: Math.round(b.spd * 1.15 * 10) / 10,
                crit: Math.round(b.crit * 1.15),
                luck: Math.round(b.luck * 1.15),
              },
            },
          };
        });
        this.log('gold', '[飞升] 渡过天劫，飞升转世！基础属性 +15%，心境大进。');
      } else {
        this.store.set((st) => ({
          ...st,
          player: { ...st.player, level: p.level + 1, xp: 0, mind: Math.min(100, st.player.mind + 5) },
        }));
        this.log('gold', `[突破] 破境成功！晋入 ${realmOf(p.level + 1)}，心境澄明（+5）。`);
      }
      this.player.hp = this.stats().hpMax;
      this.player.mp = this.stats().mpMax;
      this.sfx?.('break');
      this.checkAchievements();
      this.checkMainQuest();
    } else {
      this.store.set((st) => ({
        ...st,
        player: { ...st.player, xp: Math.floor(st.player.xp / 2), mind: Math.max(1, st.player.mind - 8) },
      }));
      this.log('badl', '[突破] 破境失败，心魔反噬，修为折半，心境蒙尘（-8）。');
      this.sfx?.('fail');
    }
  }

  joinSect(id: string): void {
    const def = config.sects.sects.find((x) => x.id === id);
    if (!def) return;
    const s = this.store.get();
    if (s.player.sectId === id) {
      this.log('badl', `[宗门] 你已是${def.name}弟子。`);
      return;
    }
    if (s.player.level < def.joinLevel) {
      this.log('badl', `[宗门] 修为不足，${def.name}要求 Lv.${def.joinLevel}。`);
      return;
    }
    this.store.set((st) => ({ ...st, player: { ...st.player, sectId: id, contribution: 0 } }));
    this.log('gold', `[宗门] 你拜入${def.name}（${def.passive}）。`);
  }

  leaveSect(): void {
    const s = this.store.get();
    if (!s.player.sectId) {
      this.log('badl', '[宗门] 你本是无门无派的散修。');
      return;
    }
    const name = config.sects.sects.find((x) => x.id === s.player.sectId)?.name ?? '宗门';
    this.store.set((st) => ({ ...st, player: { ...st.player, sectId: null, contribution: 0 } }));
    this.log('c', `[宗门] 你离开了${name}，重归散修之身。`);
  }

  sectExchange(itemId: string): void {
    const s = this.store.get();
    const def = config.sects.sects.find((x) => x.id === s.player.sectId);
    if (!def) {
      this.log('badl', '[宗门] 未入宗门，无法兑换。');
      return;
    }
    const entry = def.exchange.find((e) => e.item === itemId);
    if (!entry) return;
    if (s.player.contribution < entry.cost) {
      this.log('badl', `[宗门] 贡献不足（需 ${entry.cost}）。`);
      return;
    }
    if (!this.addItem(itemId, 1, 0, true)) {
      this.log('badl', '[背包] 背包已满。');
      return;
    }
    this.store.set((st) => ({
      ...st,
      player: { ...st.player, contribution: st.player.contribution - entry.cost },
    }));
    const t = itemTemplate(itemId);
    this.log('gold', `[宗门] 以 ${entry.cost} 贡献兑换了「${t?.name ?? itemId}」。`);
  }

  claimQuest(id: string): void {
    const s = this.store.get();
    const qs = s.player.quests.find((q) => q.id === id);
    if (!qs) return;
    const def = config.quests.quests.find((x) => x.id === id);
    if (!def) return;
    if (qs.claimed) {
      this.log('badl', '[任务] 奖励已领取。');
      return;
    }
    if (qs.progress < def.target.count) {
      this.log('badl', `[任务] 尚未完成（${qs.progress}/${def.target.count}）。`);
      return;
    }
    this.store.set((st) => ({
      ...st,
      player: {
        ...st.player,
        quests: st.player.quests.map((q) => (q.id === id ? { ...q, claimed: true } : q)),
        contribution: st.player.contribution + (def.reward.contribution ?? 0),
      },
    }));
    this.addXp(def.reward.xp);
    this.store.set((st) => ({
      ...st,
      player: { ...st.player, money: st.player.money + def.reward.money },
    }));
    this.log('gold', `[任务] 完成「${def.name}」：修为 +${def.reward.xp}，灵石 +${def.reward.money}。`);
    this.checkAchievements();
  }

  /** 成就结算：达成即入档并播报。 */
  checkAchievements(): void {
    const s = this.store.get();
    const p = s.player;
    const earned = new Set(p.achievements);
    const claimedQuests = p.quests.filter((q) => q.claimed).length;
    let anyNew = false;
    for (const a of config.achievements.achievements) {
      if (earned.has(a.id)) continue;
      let ok = false;
      switch (a.cond.type) {
        case 'kills': ok = p.kills >= a.cond.value; break;
        case 'level': ok = p.level >= a.cond.value; break;
        case 'money': ok = p.money >= a.cond.value; break;
        case 'boss': ok = s.world.bossDefeated; break;
        case 'quests': ok = claimedQuests >= a.cond.value; break;
        case 'day': ok = s.world.day >= a.cond.value; break;
        case 'ascend': ok = p.ascension >= a.cond.value; break;
      }
      if (ok) {
        earned.add(a.id);
        anyNew = true;
        this.log('gold', `[成就] 达成「${a.name}」——${a.desc}`);
        this.sfx?.('achievement');
      }
    }
    if (anyNew) {
      this.store.set((st) => ({ ...st, player: { ...st.player, achievements: [...earned] } }));
    }
  }

  private progressQuests(m: Monster): void {
    this.store.set((prev) => ({
      ...prev,
      player: {
        ...prev.player,
        quests: prev.player.quests.map((q) => {
          if (q.claimed) return q;
          const def = config.quests.quests.find((x) => x.id === q.id);
          if (!def || def.target.kind !== 'kill') return q;
          if (def.target.monster === 'any' || def.target.monster === m.templateId) {
            return { ...q, progress: Math.min(def.target.count, q.progress + 1) };
          }
          return q;
        }),
      },
    }));
  }

  craft(recipeId: string): void {
    const r = config.crafting.recipes.find((x) => x.id === recipeId);
    if (!r) return;
    const s = this.store.get();
    if (s.player.money < r.money) {
      this.log('badl', `[合成] 灵石不足（需 ${r.money}）。`);
      return;
    }
    for (const m of r.materials) {
      if (this.countItem(m.item) < m.count) {
        this.log('badl', `[合成] 缺少 ${itemTemplate(m.item)?.name ?? m.item}×${m.count}。`);
        return;
      }
    }
    this.store.set((st) => ({
      ...st,
      player: { ...st.player, money: st.player.money - r.money },
    }));
    for (const m of r.materials) this.removeItemCount(m.item, m.count);
    this.addItem(r.output, r.outputCount);
    const t = itemTemplate(r.output);
    this.log('c', `[合成] 你炼制了「${t?.name ?? r.output}」×${r.outputCount}。`);
  }

  /** 铁匠强化：玄铁锭 ×1 + 灵石，成功率随强化等级递减。 */
  upgradeItem(uid: number): void {
    const s = this.store.get();
    const idx = s.inventory.findIndex((it) => it?.uid === uid);
    if (idx < 0) return;
    const it = s.inventory[idx]!;
    const t = itemTemplate(it.templateId);
    if (!t || (t.type !== 'weapon' && t.type !== 'armor')) return;
    if (it.plus >= 5) {
      this.log('badl', '[强化] 已达 +5 上限。');
      return;
    }
    const moneyCost = 50 * (it.plus + 1);
    if (s.player.money < moneyCost) {
      this.log('badl', `[强化] 灵石不足（需 ${moneyCost}）。`);
      return;
    }
    if (this.countItem('iron_ingot') < 1) {
      this.log('badl', '[强化] 缺少玄铁锭 ×1。');
      return;
    }
    this.store.set((st) => ({
      ...st,
      player: { ...st.player, money: st.player.money - moneyCost },
    }));
    this.removeItemCount('iron_ingot', 1);
    if (this.rng() < 0.9 - 0.15 * it.plus) {
      this.store.set((st) => ({
        ...st,
        inventory: st.inventory.map((x, i) => (i === idx ? { ...it, plus: it.plus + 1 } : x)),
      }));
      this.log('gold', `[强化] 「${t.name}」强化成功，升至 +${it.plus + 1}！`);
      bus.emit('equipmentChanged', null);
    } else {
      this.log('badl', `[强化] 「${t.name}」强化失败，玄铁锭已损毁。`);
    }
    bus.emit('inventoryChanged', null);
  }

  /** 秘境：入口附近可进入，按固定 encounter 串联三波与奖励选择。 */
  nearRealm(): boolean {
    const rp = config.factions.pois.find((p) => p.kind === 'realm');
    if (!rp) return false;
    return Math.hypot(this.player.x - rp.x, this.player.y - rp.y) <= 3;
  }

  enterRealm(floor?: number): void {
    const s = this.store.get();
    const nextFloor = Math.min(config.trials.floors.length, s.world.realmProgress.highestCleared + 1);
    const requestedFloor = floor ?? nextFloor;
    const def = config.trials.floors.find((entry) => entry.floor === requestedFloor);
    if (!def) {
      this.log('badl', '[秘境] 未知的试炼层数。');
      return;
    }
    if (this.trialRun && (this.trialRun.status === 'active' || this.trialRun.status === 'between')) {
      this.log('badl', '[秘境] 当前试炼尚未结束。');
      return;
    }
    if (s.world.realmProgress.pendingRewards.length > 0) {
      this.log('badl', '[秘境] 请先从通关奖励中选择一件。');
      return;
    }
    if (requestedFloor > s.world.realmProgress.highestCleared + 1) {
      this.log('badl', '[秘境] 需依次通关前置层数。');
      return;
    }
    if (tierOf(s.player.level) < def.unlockTier) {
      this.log('badl', `[秘境] ${def.name}需达到更高境界方可进入。`);
      return;
    }
    if (s.world.day < s.world.realmProgress.readyDay) {
      this.log('badl', `[秘境] 灵雾尚未重聚（第 ${s.world.realmProgress.readyDay} 日起可入）。`);
      return;
    }
    if (!this.nearRealm()) {
      this.log('badl', '[秘境] 你离秘境入口太远（地图上 ✦ 标记处）。');
      return;
    }

    this.combat.clear('trial-start');
    for (const m of this.monsters) {
      if (m.source !== 'world' || m.state === 'dead') continue;
      m.state = 'idle';
      m.hp = m.hpMax;
      m.x = m.spawnX;
      m.y = m.spawnY;
    }
    const runId = `trial:${s.world.seed}:${s.world.day}:${this.trialSeq++}`;
    this.trialRun = createTrialRun(runId, requestedFloor);
    this.spawnTrialWave();
    this.log('gold', `[秘境] ${def.name}开启——三波连战，所有伤害只在命中帧结算。`);
    this.sfx?.('realm');
  }

  /** 选择一件已入档的通关奖励；背包满时保持候选，不会吞奖励。 */
  claimTrialReward(uid: number): boolean {
    const state = this.store.get();
    const selected = state.world.realmProgress.pendingRewards.find((item) => item.uid === uid);
    if (!selected) return false;
    const inventory = this.planInventoryAdd(
      state.inventory,
      selected.templateId,
      selected.count,
      selected.plus,
      selected.affixes,
      selected.uid,
    );
    if (!inventory) {
      this.log('badl', '[背包] 背包已满，通关奖励会继续保留。');
      return false;
    }
    this.store.set((st) => ({
      ...st,
      inventory,
      world: {
        ...st.world,
        realmProgress: { ...st.world.realmProgress, pendingRewards: [] },
      },
    }));
    bus.emit('inventoryChanged', null);
    const item = itemTemplate(selected.templateId);
    this.log('gold', `[秘境] 你选取了「${item?.name ?? selected.templateId}」。`);
    return true;
  }

  private updateTrialFlow(): void {
    const run = this.trialRun;
    if (!run || run.status !== 'between' || run.nextWaveAt === null || this.now < run.nextWaveAt) return;
    this.spawnTrialWave();
  }

  private spawnTrialWave(): void {
    const run = this.trialRun;
    if (!run || (run.status !== 'active' && run.status !== 'between')) return;
    const floor = config.trials.floors.find((entry) => entry.floor === run.floor);
    const wave = floor?.waves[run.waveIndex];
    if (!floor || !wave) return;
    const mt = this.monsterTemplate(wave.monster);
    if (!mt) return;

    this.monsters = this.monsters.filter((monster) => monster.source === 'world');
    const encounterId = `${run.runId}:wave:${run.waveIndex + 1}`;
    const ids: number[] = [];
    for (let i = 0; i < wave.count; i++) {
      const angle = -Math.PI * 0.85 + (Math.PI * 1.7 * (i + 0.5)) / wave.count;
      const distance = 1.75 + (i % 2) * 0.55;
      let x = this.player.x + Math.cos(angle) * distance;
      let y = this.player.y + Math.sin(angle) * distance;
      if (!this.map.isWalkable(x, y)) {
        x = this.player.x + Math.cos(angle) * 1.15;
        y = this.player.y + Math.sin(angle) * 1.15;
      }
      const monster = this.pushMonster(mt, x, y, wave.powerBonus, 'trial', encounterId);
      monster.state = 'chase';
      ids.push(monster.id);
    }
    this.trialRun = beginTrialWave(run, encounterId, ids, this.now);
    this.actionLabel = `${floor.name} · 第 ${run.waveIndex + 1} 波`;
    this.actionPhase = '迎战';
    this.log('sys', `[秘境] 第 ${run.waveIndex + 1}/3 波：${mt.name} ×${wave.count}。`);
  }

  private finishTrial(run: TrialRun): void {
    const floor = config.trials.floors.find((entry) => entry.floor === run.floor);
    if (!floor) return;
    const rewards = this.createTrialRewards(floor.rewardTable, floor.pickCount, run.floor);
    this.store.set((st) => ({
      ...st,
      world: {
        ...st.world,
        realmEntered: true,
        realmProgress: {
          highestCleared: Math.max(st.world.realmProgress.highestCleared, run.floor),
          totalClears: st.world.realmProgress.totalClears + 1,
          readyDay: st.world.day + floor.cooldownDays,
          pendingRewards: rewards,
        },
      },
    }));
    this.actionLabel = `${floor.name} · 通关`;
    this.actionPhase = '择宝';
    this.log('gold', `[秘境] 三波尽破！${floor.name}通关，可从三件战利品中择一。`);
    this.sfx?.('achievement');
    this.checkMainQuest();
  }

  private createTrialRewards(table: string, count: number, sourceTier: number) {
    const rewards = [];
    const used = new Set<string>();
    for (let i = 0; i < count; i++) {
      let rolled: RolledLoot | null = null;
      for (let retry = 0; retry < 8; retry++) {
        const candidate = rollTable(table, this.rng);
        if (!candidate) continue;
        rolled = candidate;
        if (!used.has(candidate.templateId)) break;
      }
      if (!rolled) continue;
      used.add(rolled.templateId);
      const template = itemTemplate(rolled.templateId);
      if (!template) continue;
      const equipment = template.type === 'weapon' || template.type === 'armor';
      rewards.push({
        uid: nextUid(),
        templateId: rolled.templateId,
        count: rolled.count,
        plus: equipment ? rollPlus(this.rng, this.stats().luck) : 0,
        affixes: equipment
          ? generateAffixes(template.grade, Math.min(config.realms.realms.length - 1, sourceTier), this.rng)
          : [],
      });
    }
    return rewards;
  }

  // ---------------- 地点与交互 ----------------
  /** 玩家附近的地点（≤4 格），供地点行动列表使用。 */
  nearPois(): { kind: string; name: string; x: number; y: number; dist: number }[] {
    const out: { kind: string; name: string; x: number; y: number; dist: number }[] = [];
    for (const p of config.factions.pois) {
      const d = Math.hypot(this.player.x - p.x, this.player.y - p.y);
      if (d <= 4) out.push({ kind: p.kind, name: p.name, x: p.x, y: p.y, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** 城镇打坐：气血灵力尽复。 */
  restAtTown(): void {
    this.healFull();
    this.log('c', '[打坐] 你于霜落城打坐调息，气血灵力尽复。');
  }

  // ---------------- 行路异闻 ----------------
  private maybeTriggerTravelEvent(): void {
    if (this.travelled < this.nextTriggerDist) return;
    this.travelled = 0;
    this.nextTriggerDist = config.travelEvents.trigger.interval + this.rng() * 6;
    const ev = pickTravelEvent(this.store.get(), this.rng);
    if (!ev) return;
    this.setState((st) => ({ ...st, world: { ...st.world, pendingTravelEvent: { eventId: ev.id } } }));
    this.log('sys', `行至${ev.locationName}，你遇见了「${ev.title}」。`);
    this.sfx?.('ui');
  }

  resolveTravelEvent(choiceId: string): void {
    resolveTravelEventFn(this, choiceId);
  }

  /** 主线进度判定：条件满足自动推进阶段。 */
  checkMainQuest(): void {
    const s = this.store.get();
    const stage = s.player.mainQuestStage;
    const stages = config.quests.mainStages;
    if (stage >= stages.length - 1) return;
    let done = false;
    switch (stage) {
      case 0: done = s.player.kills >= 1; break;
      case 1: done = s.player.kills >= 3; break;
      case 2: done = s.player.level >= 10; break;
      case 3: done = s.world.realmEntered; break;
      case 4: done = s.world.bossDefeated; break;
    }
    if (done) {
      this.setState((st) => ({
        ...st,
        player: { ...st.player, mainQuestStage: st.player.mainQuestStage + 1 },
      }));
      const next = stages[stage + 1];
      this.log('gold', `[主线] ${next.chapter}：「${next.title}」——${next.summary}`);
      this.sfx?.('achievement');
    }
  }

  countItem(templateId: string): number {
    return this.store
      .get()
      .inventory.reduce((sum, it) => sum + (it && it.templateId === templateId ? it.count : 0), 0);
  }

  removeItemCount(templateId: string, count: number): boolean {
    if (this.countItem(templateId) < count) return false;
    let remaining = count;
    this.store.set((prev) => ({
      ...prev,
      inventory: prev.inventory.map((it) => {
        if (!it || it.templateId !== templateId || remaining <= 0) return it;
        const take = Math.min(it.count, remaining);
        remaining -= take;
        return it.count - take > 0 ? { ...it, count: it.count - take } : null;
      }),
    }));
    bus.emit('inventoryChanged', null);
    return true;
  }

  // ---------------- 战斗 ----------------
  private monsterActor(m: Monster) {
    return { kind: 'monster', id: m.id } as const;
  }

  private isCurrentCombatant(m: Monster): boolean {
    if (m.state === 'dead' || m.state === 'dying') return false;
    const run = this.trialRun;
    if (run && (run.status === 'active' || run.status === 'between')) {
      return run.status === 'active' && m.source === 'trial' && m.encounterId === run.encounterId;
    }
    return m.source === 'world';
  }

  private nearestMonster(range: number): Monster | null {
    let best: Monster | null = null;
    let bestD = range;
    for (const m of this.monsters) {
      if (!this.isCurrentCombatant(m)) continue;
      const d = Math.hypot(m.x - this.player.x, m.y - this.player.y);
      if (d < bestD || (d === bestD && best && m.id < best.id)) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private monstersInRange(range: number): Monster[] {
    return this.monsters
      .filter((m) => this.isCurrentCombatant(m))
      .map((m) => ({ m, d: Math.hypot(m.x - this.player.x, m.y - this.player.y) }))
      .filter((entry) => entry.d <= range)
      .sort((a, b) => a.d - b.d || a.m.id - b.m.id)
      .map((entry) => entry.m);
  }

  private queuePlayerBasic(speed: number): boolean {
    const target = this.nearestMonster(ATTACK_RANGE);
    if (!target) return false;
    const action = this.combat.enqueue({
      actor: PLAYER_ACTOR,
      target: this.monsterActor(target),
      kind: 'basic',
      timings: config.combat.timings.playerBasic,
      priority: 50,
      speed,
      cue: 'basic',
    });
    if (!action) return false;
    const interval = config.combat.attackInterval;
    const normalizedSpeed = Math.max(interval.speedMin, Math.min(interval.speedMax, speed));
    this.atkCd = Math.max(
      interval.minMs,
      Math.min(interval.maxMs, interval.baseMs - normalizedSpeed * interval.reductionPerSpeedMs),
    );
    return true;
  }

  private queueEnemyAttack(m: Monster, mt: MonsterTemplate): boolean {
    const base = mt.boss ? config.combat.timings.boss : config.combat.timings.enemyBasic;
    const timings: CombatActionTimings = { ...base, windup: mt.windupMs };
    const action = this.combat.enqueue({
      actor: this.monsterActor(m),
      target: PLAYER_ACTOR,
      kind: 'enemy',
      timings,
      priority: mt.boss ? 45 : mt.elite ? 35 : 30,
      speed: mt.spd,
      cue: `enemy:${m.templateId}`,
    });
    if (!action) return false;
    m.atkCd = mt.attackIntervalMs;
    return true;
  }

  private tryAutoSkill(): boolean {
    const level = this.store.get().player.level;
    const skills = [...config.skills.skills].sort((a, b) => b.priority - a.priority);
    for (const skill of skills) {
      if (level < skill.unlockLevel || (this.skillCooldowns.get(skill.id) ?? 0) > 0) continue;
      if (this.player.mp < skill.mp || this.monstersInRange(skill.range).length < skill.autoMinTargets) continue;
      if (this.queueSkill(skill.id, true)) return true;
    }
    return false;
  }

  private queueSkill(skillId: string, automatic: boolean): boolean {
    const skill = config.skills.skills.find((entry) => entry.id === skillId);
    if (!skill) return false;
    const state = this.store.get();
    const cooldown = this.skillCooldowns.get(skill.id) ?? 0;
    if (state.player.level < skill.unlockLevel) {
      if (!automatic) this.log('badl', `[技能] ${skill.name}将在 Lv.${skill.unlockLevel} 解锁。`);
      return false;
    }
    if (cooldown > 0) {
      if (!automatic) this.log('badl', `[技能] ${skill.name}冷却中（${(cooldown / 1000).toFixed(1)}s）。`);
      return false;
    }
    if (this.player.mp < skill.mp) {
      if (!automatic) this.log('badl', `[技能] 灵力不足（需 ${skill.mp}）。`);
      return false;
    }
    const target = this.nearestMonster(skill.range);
    if (!target) {
      if (!automatic) this.log('badl', '[技能] 范围内没有目标。');
      return false;
    }
    const action = this.combat.enqueue({
      actor: PLAYER_ACTOR,
      target: this.monsterActor(target),
      kind: 'skill',
      timings: config.combat.timings.skill,
      priority: 80 + skill.priority,
      speed: this.stats().spd,
      cue: skill.id,
    });
    if (!action) return false;
    this.player.mp -= skill.mp;
    this.skillCooldowns.set(skill.id, skill.cdMs);
    return true;
  }

  private canStartCombatAction(action: CombatAction): boolean {
    if (action.actor.kind === 'player') {
      const target = this.monsters.find((m) => m.id === Number(action.target.id));
      if (!target || !this.isCurrentCombatant(target)) return false;
      const skill = config.skills.skills.find((entry) => entry.id === action.cue);
      const range = skill?.range ?? ATTACK_RANGE + 0.25;
      return Math.hypot(target.x - this.player.x, target.y - this.player.y) <= range;
    }
    const actor = this.monsters.find((m) => m.id === Number(action.actor.id));
    return !!actor && this.isCurrentCombatant(actor) && Math.hypot(actor.x - this.player.x, actor.y - this.player.y) <= 1.35;
  }

  private onCombatEvent(event: CombatTimelineEvent): void {
    const action = event.action;
    // 确保完成/取消发生在同一模拟步时，步末仍会立即推送最终 HUD。
    this.hudT = 0;
    if (event.type === 'started') {
      this.actionLabel = this.actionName(action);
      this.actionPhase = '起势';
      return;
    }
    if (event.type === 'phase') {
      this.actionPhase = {
        windup: '前摇',
        travel: action.kind === 'skill' ? '剑虹' : '突进',
        impact: '命中',
        recover: '收招',
      }[event.phase];
      return;
    }
    if (event.type === 'impact') {
      this.resolveCombatImpact(action);
      return;
    }
    if (event.type === 'completed' && this.combat.queued.length === 0) {
      this.actionPhase = '寻敌';
    }
  }

  private actionName(action: CombatAction): string {
    if (action.kind === 'skill') {
      return config.skills.skills.find((skill) => skill.id === action.cue)?.name ?? '剑诀';
    }
    if (action.kind === 'enemy') {
      const monster = this.monsters.find((entry) => entry.id === Number(action.actor.id));
      const mt = monster ? this.monsterTemplate(monster.templateId) : undefined;
      return `${mt?.name ?? '妖兽'} · ${mt?.attackName ?? '攻击'}`;
    }
    return '流云剑式';
  }

  private resolveCombatImpact(action: CombatAction): void {
    if (action.actor.kind === 'player') this.resolvePlayerImpact(action);
    else this.resolveEnemyImpact(action);
  }

  private resolvePlayerImpact(action: CombatAction): void {
    const primary = this.monsters.find((m) => m.id === Number(action.target.id));
    if (!primary || !this.isCurrentCombatant(primary)) return;
    const skill = config.skills.skills.find((entry) => entry.id === action.cue);
    const maxTargets = skill?.maxTargets ?? 1;
    const range = skill?.range ?? ATTACK_RANGE + 0.3;
    if (Math.hypot(primary.x - this.player.x, primary.y - this.player.y) > range) {
      this.actionLabel = skill?.name ?? '流云剑式';
      this.actionPhase = '落空';
      this.log('sys', `[闪避] ${this.monsterTemplate(primary.templateId)?.name ?? '目标'}脱离攻击范围。`);
      return;
    }
    const targets = [primary];
    if (skill?.targetMode === 'multi') {
      for (const candidate of this.monstersInRange(range)) {
        if (candidate.id !== primary.id && targets.length < maxTargets) targets.push(candidate);
      }
    }

    let total = 0;
    let anyCrit = false;
    for (const target of targets) {
      const result = this.applyPlayerDamage(target, skill?.mult ?? 1, action.cue ?? 'basic');
      total += result.amount;
      anyCrit ||= result.critical;
    }
    if (!skill) this.player.mp = Math.min(this.stats().mpMax, this.player.mp + 5);
    this.sfx?.(skill ? 'skill' : anyCrit ? 'crit' : 'hit');
    if (skill) {
      const mt = this.monsterTemplate(primary.templateId);
      this.log(
        'c',
        `你施展【${skill.name}】，${targets.length > 1 ? `剑阵贯穿 ${targets.length} 个目标` : `剑气命中${mt?.name ?? '目标'}`}，造成 <b class="num">${total}</b> 伤害${anyCrit ? '（<span class="crit">暴击</span>）' : ''}。`,
      );
    }
  }

  private applyPlayerDamage(m: Monster, multiplier: number, cue: string): { amount: number; critical: boolean } {
    const st = this.stats();
    const s0 = this.store.get();
    const realmM = realmMult(tierOf(s0.player.level), tierOf(m.lvl));
    const sectM = s0.player.sectId === 'qingyun' ? 1.05 : 1;
    const critical = this.rng() < st.crit / 100;
    const amount = Math.round(damage(st.atk * multiplier * realmM * sectM, m.def, this.rng) * (critical ? 2 : 1));
    m.hp = Math.max(0, m.hp - amount);
    m.state = m.hp <= 0 ? 'dying' : 'chase';
    m.flashT = config.combat.visual.targetFlashMs;
    this.addDmg(m.x, m.y, `-${amount}`, critical ? '#ffd46a' : '#f2ead4');
    this.addCombatFx(m.x, m.y, cue, critical, cue === 'basic' ? '#d7bc72' : '#78c7d2');
    if (m.hp <= 0) this.beginMonsterDeath(m);
    return { amount, critical };
  }

  private resolveEnemyImpact(action: CombatAction): void {
    const monster = this.monsters.find((m) => m.id === Number(action.actor.id));
    if (!monster || !this.isCurrentCombatant(monster)) return;
    const mt = this.monsterTemplate(monster.templateId);
    if (!mt) return;
    if (Math.hypot(monster.x - this.player.x, monster.y - this.player.y) > 1.35) {
      this.actionLabel = `${mt.name} · ${mt.attackName}`;
      this.actionPhase = '闪避';
      this.log('sys', `[闪避] 你避开了${mt.name}的「${mt.attackName}」。`);
      return;
    }
    const st = this.stats();
    const realmM = realmMult(tierOf(monster.lvl), tierOf(this.store.get().player.level));
    const amount = damage(monster.atk * mt.attackMult * realmM, st.def, this.rng);
    this.player.hp = Math.max(0, this.player.hp - amount);
    this.player.flashT = config.combat.visual.targetFlashMs;
    this.hurtT = this.now;
    this.addDmg(this.player.x, this.player.y, `-${amount}`, '#ef6f68');
    this.addCombatFx(this.player.x, this.player.y, action.cue ?? 'enemy', false, '#d5655d');
    this.sfx?.('hurt');
    if (this.player.hp <= 0) this.beginPlayerDeath(monster);
  }

  private beginMonsterDeath(m: Monster): void {
    if (m.state === 'dead' || m.deathT > 0) return;
    m.state = 'dying';
    m.hp = 0;
    m.deathT = DEATH_ANIMATION_MS;
    this.combat.cancelByActor(this.monsterActor(m), 'defeated');
  }

  private finalizeKill(m: Monster): void {
    if (m.state !== 'dying') return;
    const mt = this.monsterTemplate(m.templateId);
    if (!mt) return;
    m.state = 'dead';
    m.deathT = 0;
    m.respawnAt = m.source === 'world' ? this.now + mt.respawnMs : Number.POSITIVE_INFINITY;
    const st = this.stats();
    const s0 = this.store.get();
    const sectXp = s0.player.sectId === 'xuesha' ? 1.1 : 1;
    const xp = Math.round(m.xp * this.auraMult() * sectXp);
    const money = randInt(this.rng, 3, 6) + m.lvl;
    const pityNow = s0.player.pity + 1;
    const pityHit = pityNow >= PITY_THRESHOLD;
    const warBonus = s0.world.faction.tension >= 80 ? 2 : 1;
    const addC = s0.player.sectId ? (mt.boss ? 20 : mt.elite ? 5 : 1) * warBonus : 0;
    this.store.set((prev) => ({
      ...prev,
      player: {
        ...prev.player,
        money: prev.player.money + money,
        kills: prev.player.kills + 1,
        pity: pityHit ? 0 : pityNow,
        contribution: prev.player.contribution + addC,
      },
    }));
    this.addXp(xp);
    this.progressQuests(m);
    const srcTier = Math.min(config.realms.realms.length - 1, tierOf(m.lvl));
    // 常规掉落（首领双倍次数）
    const rolls = mt.boss ? 2 : 1;
    for (let i = 0; i < rolls; i++) {
      const rolled = rollTable(mt.dropTable, this.rng);
      if (rolled) this.spawnDrop(rolled, m.x, m.y, st.luck, srcTier, mt.name);
    }
    if (pityHit) {
      const rolled = rollTable('pity', this.rng);
      if (rolled) this.spawnDrop({ ...rolled, count: 1 }, m.x, m.y, st.luck, srcTier, null, true);
    }
    this.spawnPuff(m.x, m.y, mt.color, 10);
    // 世界首领首杀
    if (mt.boss && m.source === 'world' && !s0.world.bossDefeated) {
      this.store.set((st) => ({
        ...st,
        world: {
          ...st.world,
          bossDefeated: true,
          chronicle: [
            ...st.world.chronicle,
            { day: st.world.day, text: '赤焰狼王被斩杀！妖兽闻风丧胆，沧溟为之震动。', major: true },
          ].slice(-60),
        },
      }));
      this.log('gold', '[首杀] 赤焰狼王首次被斩杀！天道震动，史笔如刀。');
      this.sfx?.('boss');
    }
    this.checkAchievements();
    this.checkMainQuest();
    this.log('c', `击杀 ${mt.name} Lv.${m.lvl}（+${xp} 修为，+${money} 灵石）`);

    if (m.source === 'trial' && m.encounterId && this.trialRun) {
      const recorded = recordTrialDefeat(this.trialRun, m.encounterId, m.id);
      if (canAdvanceTrialWave(recorded)) {
        const advanced = advanceTrialWave(recorded, this.now + config.trials.waveDelayMs);
        this.trialRun = advanced;
        if (advanced.status === 'victory') this.finishTrial(advanced);
        else {
          this.actionLabel = '波次肃清';
          this.actionPhase = '灵雾重构';
          this.log('sys', `[秘境] 第 ${recorded.waveIndex + 1} 波肃清，下一波即将显化。`);
        }
      } else {
        this.trialRun = recorded;
      }
    }
  }

  private spawnDrop(
    rolled: RolledLoot,
    x: number,
    y: number,
    luck: number,
    srcTier: number,
    sourceName: string | null,
    isPity = false,
  ): void {
    const t = itemTemplate(rolled.templateId);
    if (!t) return;
    let plus = 0;
    let affixes: ItemAffix[] = [];
    if (t.type === 'weapon' || t.type === 'armor') {
      plus = rollPlus(this.rng, luck);
      affixes = generateAffixes(t.grade, srcTier, this.rng);
    }
    this.drops.push({
      uid: nextUid(),
      templateId: rolled.templateId,
      count: rolled.count,
      plus,
      affixes,
      x: x + (this.rng() - 0.5) * 0.8,
      y: y + (this.rng() - 0.5) * 0.8,
    });
    // 掉落实体一生成就入档，刷新页面不会因角色未移动而丢失。
    this.store.set((prev) => ({ ...prev, drops: this.drops }));
    if (gradeTier(t.grade) >= 2) {
      this.log(
        'lootL',
        isPity
          ? '[保底] 天道垂青！「' + itemDisplayName(t) + '」破空而出！'
          : `[掉落] ${sourceName ?? ''}掉落了「${itemDisplayName(t)}」${rolled.count > 1 ? ` ×${rolled.count}` : ''}！`,
      );
      this.spawnPuff(x, y, gradeDefColor(t.grade), 8);
      this.sfx?.('lootRare');
    }
  }

  private spawnPuff(x: number, y: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = this.visualRng() * Math.PI * 2;
      const sp = 0.8 + this.visualRng() * 1.6;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.4,
        t: 0,
        life: 0.5 + this.visualRng() * 0.4,
        color,
        size: 1.5 + this.visualRng() * 2,
      });
    }
  }

  addXp(xp: number): void {
    const before = this.store.get().player.level;
    this.store.set((prev) => {
      const p = levelUp({ ...prev.player, xp: prev.player.xp + xp }, (lv) => {
        this.log('gold', `[突破] 修为精进，晋入 ${realmOf(lv)}！生命与攻防全面提升。`);
      });
      return { ...prev, player: p };
    });
    const gained = this.store.get().player.level - before;
    if (gained > 0) {
      this.store.set((st) => ({
        ...st,
        player: { ...st.player, mind: Math.min(100, st.player.mind + gained) },
      }));
      this.sfx?.('levelUp');
      this.checkAchievements();
    }
    this.player.hp = Math.min(this.player.hp, this.stats().hpMax);
    this.player.mp = Math.min(this.player.mp, this.stats().mpMax);
  }

  private beginPlayerDeath(killer: Monster): void {
    if (this.playerDeath) return;
    this.playerDeath = { killerId: killer.id, remainingMs: DEATH_ANIMATION_MS };
    this.actionLabel = '神魂溃散';
    this.actionPhase = '陨落';
    this.combat.clear('player-defeated');
    this.sfx?.('death');
    if (this.trialRun && (this.trialRun.status === 'active' || this.trialRun.status === 'between')) {
      this.trialRun = failTrial(this.trialRun);
      this.log('badl', '[秘境] 神魂正在被逐出灵雾，本次挑战不记录通关，也不会生成奖励。');
    }
  }

  private completePlayerDeath(): void {
    const killerId = this.playerDeath?.killerId;
    const killer = this.monsters.find((monster) => monster.id === killerId);
    if (!this.playerDeath) return;
    this.playerDeath = null;
    const mt = killer ? this.monsterTemplate(killer.templateId) : undefined;
    const town = this.poi('town');
    const townName = config.factions.pois.find((q) => q.kind === 'town')?.name ?? '城镇';
    this.log('badl', `[陨落] 你被 ${mt?.name ?? '妖兽'} 击杀，在${townName}苏醒。心魔暗生（心境 -4）。`);
    this.player.x = town.x;
    this.player.y = town.y + 1;
    this.store.set((st) => ({
      ...st,
      player: { ...st.player, mind: Math.max(1, st.player.mind - 4) },
    }));
    this.player.hp = this.stats().hpMax;
    this.player.mp = this.stats().mpMax;
    this.hurtT = -1e9;
    this.moveTarget = null;
    if (this.trialRun?.status === 'failed') {
      this.actionLabel = '试炼失败';
      this.actionPhase = '整备重来';
    }
    for (const m of this.monsters) {
      if (m.source === 'trial') {
        m.state = 'dead';
        m.hp = 0;
        m.respawnAt = Number.POSITIVE_INFINITY;
        continue;
      }
      if (m.state === 'dead') continue;
      m.state = 'idle';
      m.hp = m.hpMax;
      m.x = m.spawnX;
      m.y = m.spawnY;
    }
    this.sync();
  }

  // ---------------- 技能 ----------------
  castSkill(skillId = config.skills.skills[0].id): void {
    this.queueSkill(skillId, false);
  }

  // ---------------- 拾取 / 背包 ----------------
  private pickup(d: GroundDrop): void {
    const t = itemTemplate(d.templateId);
    if (!t) {
      this.removeDrop(d.uid);
      return;
    }
    if (!this.addItem(d.templateId, d.count, d.plus, true, d.affixes)) return; // 满了留在地上
    this.removeDrop(d.uid);
    this.log(
      gradeTier(t.grade) >= 2 ? 'lootL' : 'gold',
      `[拾取] ${itemDisplayName(t)}${d.count > 1 ? ` ×${d.count}` : ''}`,
    );
    this.sfx?.(gradeTier(t.grade) >= 2 ? 'lootRare' : 'pickup');
  }

  /** 拾取附近（≤ range）的掉落。 */
  pickupNearby(range: number): void {
    const near = this.drops
      .filter((d) => Math.hypot(d.x - this.player.x, d.y - this.player.y) <= range)
      .slice(0, 20);
    if (near.length === 0) {
      this.log('badl', '[拾取] 附近没有掉落物');
      return;
    }
    for (const d of near) this.pickup(d);
  }

  private removeDrop(uid: number): void {
    this.drops = this.drops.filter((d) => d.uid !== uid);
    this.store.set((prev) => ({ ...prev, drops: this.drops }));
    bus.emit('worldChanged', null);
  }

  /** 尝试加入背包；满则失败。 */
  addItem(templateId: string, count: number, plus = 0, silent = false, affixes: ItemAffix[] = []): boolean {
    const t = itemTemplate(templateId);
    if (!t || !Number.isInteger(count) || count <= 0) return false;
    const inventory = this.planInventoryAdd(this.store.get().inventory, templateId, count, plus, affixes);
    if (!inventory) {
      if (!silent) this.log('badl', '[背包] 背包已满，无法拾取');
      return false;
    }
    this.store.set((st) => ({ ...st, inventory }));
    bus.emit('inventoryChanged', null);
    return true;
  }

  /** 先验证总容量，再构造完整新背包；失败时绝不产生“部分放入”。 */
  private planInventoryAdd(
    source: GameState['inventory'],
    templateId: string,
    count: number,
    plus: number,
    affixes: ItemAffix[],
    preferredUid?: number,
  ): GameState['inventory'] | null {
    const t = itemTemplate(templateId);
    if (!t || !Number.isInteger(count) || count <= 0) return null;
    let capacity = 0;
    for (const item of source) {
      if (!item) capacity += t.stack;
      else if (t.stack > 1 && item.templateId === templateId) capacity += Math.max(0, t.stack - item.count);
    }
    if (capacity < count) return null;

    const inventory = source.slice();
    let remaining = count;
    if (t.stack > 1) {
      for (let i = 0; i < inventory.length && remaining > 0; i++) {
        const item = inventory[i];
        if (!item || item.templateId !== templateId || item.count >= t.stack) continue;
        const add = Math.min(t.stack - item.count, remaining);
        inventory[i] = { ...item, count: item.count + add };
        remaining -= add;
      }
    }
    let firstNew = true;
    for (let i = 0; i < inventory.length && remaining > 0; i++) {
      if (inventory[i]) continue;
      const take = Math.min(remaining, t.stack);
      inventory[i] = {
        uid: firstNew && preferredUid !== undefined ? preferredUid : nextUid(),
        templateId,
        count: take,
        plus,
        affixes: [...affixes],
      };
      firstNew = false;
      remaining -= take;
    }
    return remaining === 0 ? inventory : null;
  }

  /** 丢弃背包中 1 个单位。 */
  dropItem(uid: number): void {
    this.store.set((prev) => {
      const inv = prev.inventory.slice();
      const idx = inv.findIndex((it) => it?.uid === uid);
      if (idx < 0) return prev;
      const it = inv[idx]!;
      inv[idx] = it.count > 1 ? { ...it, count: it.count - 1 } : null;
      return { ...prev, inventory: inv };
    });
    this.log('c', '你丢弃了物品。');
    bus.emit('inventoryChanged', null);
  }

  /** 使用消耗品。 */
  useItem(uid: number): void {
    const st0 = this.store.get();
    const it = st0.inventory.find((x) => x?.uid === uid);
    if (!it) return;
    const t = itemTemplate(it.templateId);
    if (!t || t.type !== 'consumable') return;
    const use = (t as unknown as { use?: string }).use ?? '';
    const st = this.stats();
    switch (use) {
      case 'heal80':
        this.player.hp = Math.min(st.hpMax, this.player.hp + 80);
        this.log('c', `你服用「${t.name}」，恢复 <b class="num">80</b> 生命。`);
        break;
      case 'mp40':
        this.player.mp = Math.min(st.mpMax, this.player.mp + 40);
        this.log('c', `你服用「${t.name}」，恢复 <b class="num">40</b> 灵力。`);
        break;
      case 'xp100':
        this.addXp(100);
        this.log('c', `你服用「${t.name}」，修为 <b class="num">+100</b>。`);
        break;
      case 'portal':
        this.returnToTown();
        break;
      default:
        this.log('badl', '[使用] 该物品暂不可用');
        return;
    }
    this.consumeOne(uid);
  }

  private consumeOne(uid: number): void {
    this.store.set((prev) => {
      const inv = prev.inventory.slice();
      const idx = inv.findIndex((it) => it?.uid === uid);
      if (idx < 0) return prev;
      const it = inv[idx]!;
      inv[idx] = it.count > 1 ? { ...it, count: it.count - 1 } : null;
      return { ...prev, inventory: inv };
    });
    bus.emit('inventoryChanged', null);
  }

  // ---------------- 装备 ----------------
  equipItem(uid: number): void {
    const st0 = this.store.get();
    const idx = st0.inventory.findIndex((it) => it?.uid === uid);
    if (idx < 0) return;
    const it = st0.inventory[idx]!;
    const t = itemTemplate(it.templateId);
    if (!t || (t.type !== 'weapon' && t.type !== 'armor')) {
      this.log('badl', '[装备] 该物品无法装备');
      return;
    }
    const slot = t.slot as EquipSlot;
    this.store.set((prev) => {
      const inv = prev.inventory.slice();
      const equip = { ...prev.equipment };
      inv[idx] = equip[slot];
      equip[slot] = { ...it, count: 1 };
      return { ...prev, inventory: inv, equipment: equip };
    });
    this.log('c', `你装备了「${t.name}」。`);
    bus.emit('inventoryChanged', null);
    bus.emit('equipmentChanged', null);
    this.player.hp = Math.min(this.player.hp, this.stats().hpMax);
    this.player.mp = Math.min(this.player.mp, this.stats().mpMax);
  }

  unequip(slot: EquipSlot): void {
    const st0 = this.store.get();
    const it = st0.equipment[slot];
    if (!it) return;
    const t = itemTemplate(it.templateId);
    const idx = st0.inventory.findIndex((x) => x === null);
    if (idx < 0) {
      this.log('badl', '[背包] 背包已满，无法卸下');
      return;
    }
    this.store.set((prev) => {
      const inv = prev.inventory.slice();
      inv[idx] = prev.equipment[slot];
      const equip = { ...prev.equipment, [slot]: null };
      return { ...prev, inventory: inv, equipment: equip };
    });
    this.log('c', `你卸下了「${t?.name ?? '装备'}」。`);
    bus.emit('inventoryChanged', null);
    bus.emit('equipmentChanged', null);
  }

  // ---------------- 经济 / 城镇 ----------------
  buyItem(templateId: string): void {
    const t = itemTemplate(templateId);
    if (!t) return;
    const st0 = this.store.get();
    if (st0.player.money < t.price) {
      this.log('badl', `[商店] 灵石不足（需 <b class="num">${t.price}</b>）`);
      return;
    }
    if (!this.addItem(templateId, 1, 0, true)) {
      this.log('badl', '[商店] 背包已满');
      return;
    }
    this.store.set((prev) => ({
      ...prev,
      player: { ...prev.player, money: prev.player.money - t.price },
    }));
    this.log('gold', `[商店] 你花费 <b class="num">${t.price}</b> 灵石购买了「${t.name}」`);
  }

  sellItem(templateId: string): void {
    const t = itemTemplate(templateId);
    if (!t) return;
    const st0 = this.store.get();
    const idx = st0.inventory.findIndex((it) => it?.templateId === templateId);
    if (idx < 0) {
      this.log('badl', `[商店] 背包里没有「${t.name}」`);
      return;
    }
    const sectMult = st0.player.sectId === 'wanbao' ? 1.1 : 1;
    const gain = Math.round(t.price * sectMult);
    this.store.set((prev) => {
      const inv = prev.inventory.slice();
      const it = inv[idx]!;
      inv[idx] = it.count > 1 ? { ...it, count: it.count - 1 } : null;
      return {
        ...prev,
        inventory: inv,
        player: { ...prev.player, money: prev.player.money + gain },
      };
    });
    this.log('gold', `[商店] 你出售了「${t.name}」，获得 <b class="num">${gain}</b> 灵石`);
    bus.emit('inventoryChanged', null);
  }

  returnToTown(): void {
    if (this.playerDeath) {
      this.log('badl', '[回城] 神魂溃散期间无法催动传送。');
      return;
    }

    const activeTrial = !!this.trialRun &&
      (this.trialRun.status === 'active' || this.trialRun.status === 'between');
    this.combat.clear('return-to-town');
    this.atkCd = 0;
    this.moveDir.x = 0;
    this.moveDir.y = 0;
    this.moveTarget = null;

    if (activeTrial && this.trialRun) {
      this.trialRun = failTrial(this.trialRun);
      this.log('badl', '[秘境] 你主动撤离，本次三波试炼已中止且不会生成通关奖励。');
      this.trialRun = null;
    }
    this.monsters = this.monsters.filter((monster) => monster.source === 'world');
    for (const monster of this.monsters) {
      // 已命中的致命伤仍应完成退场与奖励结算，不能被回城复位吞掉。
      if (monster.state === 'dead' || monster.state === 'dying') continue;
      monster.state = 'idle';
      monster.hp = monster.hpMax;
      monster.x = monster.spawnX;
      monster.y = monster.spawnY;
    }

    const town = this.poi('town');
    this.player.x = town.x;
    this.player.y = town.y + 1;
    this.actionLabel = activeTrial ? '试炼中止' : '霜落城';
    this.actionPhase = '脱离战斗';
    this.log('c', '灵光一闪，你回到了霜落城。');
    this.sync();
  }

  // ---------------- 存档同步 / HUD ----------------
  /** 把热数据写回存档（事件性 + 定时）。 */
  sync(): void {
    const s = this.store.get();
    const moved = Math.hypot(s.player.pos.x - this.player.x, s.player.pos.y - this.player.y) > 0.3;
    const changed = Math.abs(s.player.hp - this.player.hp) > 1 || Math.abs(s.player.mp - this.player.mp) > 1;
    if (!moved && !changed) return;
    this.store.set((st) => ({
      ...st,
      player: {
        ...st.player,
        pos: { x: this.player.x, y: this.player.y },
        hp: Math.round(this.player.hp),
        mp: Math.round(this.player.mp),
      },
      drops: this.drops,
    }));
    if (moved) bus.emit('worldChanged', null);
  }

  hudData(): HudData {
    const s = this.store.get();
    const st = this.stats();
    const skill = config.skills.skills[0];
    const skills: HudSkill[] = config.skills.skills.map((entry) => {
      const cooldownMs = this.skillCooldowns.get(entry.id) ?? 0;
      const unlocked = s.player.level >= entry.unlockLevel;
      return {
        id: entry.id,
        name: entry.name,
        shortName: entry.shortName,
        mp: entry.mp,
        cooldown: cooldownMs / 1000,
        cooldownMax: entry.cdMs / 1000,
        unlocked,
        ready: unlocked && cooldownMs <= 0 && this.player.mp >= entry.mp,
      };
    });
    const activeTargetId = this.combat.active?.target.kind === 'monster'
      ? Number(this.combat.active.target.id)
      : null;
    const maxSkillRange = Math.max(ATTACK_RANGE, ...config.skills.skills.map((entry) => entry.range));
    const targetMonster = activeTargetId !== null
      ? this.monsters.find((monster) => monster.id === activeTargetId) ?? null
      : this.nearestMonster(maxSkillRange);
    const targetTemplate = targetMonster ? this.monsterTemplate(targetMonster.templateId) : undefined;
    const target: HudTarget | null = targetMonster && targetTemplate && targetMonster.state !== 'dead'
      ? {
          id: targetMonster.id,
          name: targetTemplate.name,
          level: targetMonster.lvl,
          hp: Math.max(0, Math.round(targetMonster.hp)),
          hpMax: targetMonster.hpMax,
          elite: targetTemplate.elite,
          boss: targetTemplate.boss,
          distance: Math.hypot(targetMonster.x - this.player.x, targetMonster.y - this.player.y),
        }
      : null;
    const trialFloor = this.trialRun
      ? config.trials.floors.find((entry) => entry.floor === this.trialRun?.floor)
      : undefined;
    const trial: HudTrial | null = this.trialRun && trialFloor
      ? {
          status: this.trialRun.status,
          floor: this.trialRun.floor,
          name: trialFloor.name,
          wave: this.trialRun.waveIndex + 1,
          waveCount: 3,
          defeated: this.trialRun.defeatedMonsterIds.length,
          total: this.trialRun.trackedMonsterIds.length,
          nextWaveIn: this.trialRun.nextWaveAt === null
            ? 0
            : Math.max(0, (this.trialRun.nextWaveAt - this.now) / 1000),
        }
      : null;
    const firstCooldown = this.skillCooldowns.get(skill.id) ?? 0;
    const power = st.atk + st.def * 2 + Math.round(st.hpMax / 10) + Math.round(st.spd * 3 + st.crit * 2);
    return {
      hp: Math.max(0, Math.round(this.player.hp)),
      mp: Math.max(0, Math.round(this.player.mp)),
      hpMax: st.hpMax,
      mpMax: st.mpMax,
      xp: s.player.xp,
      xpMax: xpNeed(s.player.level),
      level: s.player.level,
      atk: st.atk,
      def: st.def,
      spd: st.spd,
      crit: st.crit,
      luck: st.luck,
      money: s.player.money,
      kills: s.player.kills,
      pity: s.player.pity,
      pityMax: PITY_THRESHOLD,
      realm: realmOf(s.player.level),
      power,
      skillCd: Math.max(0, firstCooldown / 1000),
      skillCdMax: config.skills.skills[0].cdMs / 1000,
      skillName: skill.name,
      auraLabel: this.aura && this.store.get().world.day <= this.aura.untilDay
        ? `灵潮 ×${this.aura.xpMult.toFixed(2)}（至第 ${this.aura.untilDay} 日）`
        : null,
      canBreak: atRealmPeak(s.player.level),
      realmReady:
        this.nearRealm() &&
        s.world.day >= s.world.realmProgress.readyDay &&
        s.world.realmProgress.pendingRewards.length === 0 &&
        (!this.trialRun || (this.trialRun.status !== 'active' && this.trialRun.status !== 'between')) &&
        tierOf(s.player.level) >= (config.trials.floors[Math.min(s.world.realmProgress.highestCleared, config.trials.floors.length - 1)]?.unlockTier ?? 1),
      skills,
      target,
      combat: this.combatSnapshot,
      actionLabel: this.actionLabel,
      actionPhase: this.actionPhase,
      trial,
      pendingTrialRewards: s.world.realmProgress.pendingRewards.length,
    };
  }

  private addDmg(x: number, y: number, text: string, color: string): void {
    this.dmgNumbers.push({
      x: x + (this.visualRng() - 0.5) * 0.4,
      y: y - 0.4,
      text,
      color,
      t: 0,
    });
  }

  private addCombatFx(x: number, y: number, cue: string, critical: boolean, color: string): void {
    const life = config.combat.visual.impactRingMs / 1000;
    this.combatFx.push(
      { kind: 'ring', x, y, t: 0, life, color, critical, cue },
      { kind: 'slash', x, y, t: 0, life: life * 0.72, color, critical, cue },
      { kind: 'burst', x, y, t: 0, life: life * 0.85, color, critical, cue },
    );
    this.spawnPuff(x, y, color, Math.min(config.combat.visual.maxParticlesPerImpact, critical ? 16 : 10));
  }
}
