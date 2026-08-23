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
  state: 'idle' | 'chase' | 'dead';
  respawnAt: number;
  atkCd: number;
  /** 受击闪白剩余 ms */
  flashT: number;
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
  skillCd: number;
  skillCdMax: number;
  skillName: string;
  /** 灵潮标签（无则 null） */
  auraLabel: string | null;
  /** 境界圆满，可突破 */
  canBreak: boolean;
  /** 靠近秘境且可进入 */
  realmReady: boolean;
}

type MonsterTemplate = (typeof config.monsters.monsters)[number];

const PITY_THRESHOLD = 10;
const PLAYER_RADIUS = 0.28;
const MONSTER_RADIUS = 0.25;
const ATTACK_RANGE = 1.15;
const ATTACK_INTERVAL = 800;
const PICKUP_RADIUS = 0.6;
const REGEN_DELAY = 5000;
const LEASH_RANGE = 10;

export class GameRuntime {
  readonly map: World;
  readonly player = { x: 0, y: 0, hp: 0, mp: 0, flashT: 0 };
  monsters: Monster[] = [];
  drops: GroundDrop[] = [];
  dmgNumbers: DmgNumber[] = [];
  particles: Particle[] = [];
  moveDir = { x: 0, y: 0 };
  moveTarget: { x: number; y: number } | null = null;
  now = performance.now();
  /** 灵潮增益（天道导演可施加） */
  aura: { xpMult: number; untilDay: number } | null = null;
  /** 秘境试炼：剩余双倍掉落击杀数 */
  private realmKillsLeft = 0;
  private realmReadyDay = 1;

  private rng: () => number;
  private atkCd = 0;
  private skillCd = 0;
  private hurtT = -1e9;
  private hudT = 0;
  private syncT = 0;
  private maintainT = 0;
  private mid = 1;

  constructor(
    private store: Store<GameState>,
    private log: (cls: LogCls, text: string) => void,
    private sfx?: (name: SfxName) => void,
  ) {
    const s = store.get();
    this.map = new World(s.world.seed);
    this.rng = mulberry32((s.world.seed ^ 0x51ab) >>> 0);
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

  // ---------------- 状态辅助 ----------------
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

  private pushMonster(mt: MonsterTemplate, x: number, y: number, extraPower = 0): void {
    const dist = Math.hypot(x - SPAWN_POS.x, y - SPAWN_POS.y);
    const power = Math.min(
      1 + dist / config.spawns.levelScaleDist + extraPower,
      config.spawns.powerCap + 1,
    );
    this.monsters.push({
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
      wanderT: 0,
      wanderX: 0,
      wanderY: 0,
    });
  }

  // ---------------- 主更新 ----------------
  update(dtMs: number): void {
    const dt = Math.min(dtMs, 100) / 1000;
    this.now += dtMs;
    const st = this.stats();

    // 玩家移动
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
    if (dx !== 0 || dy !== 0) this.moveEntity(this.player, st.spd, dx, dy, dt, PLAYER_RADIUS);

    // 脱战回复
    if (this.now - this.hurtT > REGEN_DELAY) {
      this.player.hp = Math.min(st.hpMax, this.player.hp + 2 * dt);
      this.player.mp = Math.min(st.mpMax, this.player.mp + 1.5 * dt);
    }

    // 冷却
    this.atkCd -= dtMs;
    this.skillCd -= dtMs;

    // 动态刷怪
    this.maintainT -= dtMs;
    if (this.maintainT <= 0) {
      this.maintainT = config.spawns.updateIntervalMs;
      this.spawnMaintain();
    }

    // 自动攻击
    if (this.atkCd <= 0) {
      const target = this.nearestMonster(ATTACK_RANGE);
      if (target) {
        this.atkCd = ATTACK_INTERVAL;
        this.hitMonster(target, st.atk, st.crit);
      }
    }

    // 怪物 AI
    for (const m of this.monsters) {
      const mt = this.monsterTemplate(m.templateId);
      if (!mt) continue;
      if (m.state === 'dead') {
        if (this.now >= m.respawnAt) {
          m.state = 'idle';
          m.hp = m.hpMax;
          m.x = m.spawnX;
          m.y = m.spawnY;
        }
        continue;
      }
      m.flashT = Math.max(0, m.flashT - dtMs);
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
        } else {
          this.moveEntity(m, mt.spd, this.player.x - m.x, this.player.y - m.y, dt, MONSTER_RADIUS);
          if (distP < 1.0) {
            m.atkCd -= dtMs;
            if (m.atkCd <= 0) {
              m.atkCd = 1300;
              const rM = realmMult(tierOf(m.lvl), tierOf(this.store.get().player.level));
              const d = damage(m.atk * rM, st.def, this.rng);
              this.player.hp -= d;
              this.player.flashT = 120;
              this.hurtT = this.now;
              this.addDmg(this.player.x, this.player.y, `-${d}`, '#ff5a5a');
              this.sfx?.('hurt');
              if (this.player.hp <= 0) this.die(m);
            }
          }
        }
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

    this.player.flashT = Math.max(0, this.player.flashT - dtMs);

    // HUD / 存档同步
    this.hudT -= dtMs;
    this.syncT -= dtMs;
    if (this.hudT <= 0) {
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

  /** 秘境：入口附近可进入，限时双倍掉落试炼。 */
  nearRealm(): boolean {
    const rp = config.factions.pois.find((p) => p.kind === 'realm');
    if (!rp) return false;
    return Math.hypot(this.player.x - rp.x, this.player.y - rp.y) <= 3;
  }

  enterRealm(): void {
    const rp = config.factions.pois.find((p) => p.kind === 'realm');
    if (!rp) return;
    if (tierOf(this.store.get().player.level) < 1) {
      this.log('badl', '[秘境] 灵雾秘境灵气汹涌，需筑基方可入内。');
      return;
    }
    if (this.store.get().world.day < this.realmReadyDay) {
      this.log('badl', `[秘境] 灵雾秘境尚未开启（第 ${this.realmReadyDay} 日起可入）。`);
      return;
    }
    if (!this.nearRealm()) {
      this.log('badl', '[秘境] 你离秘境入口太远（地图上 ✦ 标记处）。');
      return;
    }
    this.spawnWave(8, 0.8, 'player');
    this.realmKillsLeft = 8;
    this.realmReadyDay = this.store.get().world.day + 2;
    this.log('gold', '[秘境] 灵雾秘境开启！击杀 8 只秘境凶兽，掉落翻倍。');
    this.sfx?.('realm');
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
    const st = this.stats();
    this.player.hp = st.hpMax;
    this.player.mp = st.mpMax;
    this.log('c', '[打坐] 你于霜落城打坐调息，气血灵力尽复。');
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
  private nearestMonster(range: number): Monster | null {
    let best: Monster | null = null;
    let bestD = range;
    for (const m of this.monsters) {
      if (m.state === 'dead') continue;
      const d = Math.hypot(m.x - this.player.x, m.y - this.player.y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private hitMonster(m: Monster, atk: number, crit: number): void {
    const mt = this.monsterTemplate(m.templateId);
    if (!mt) return;
    const s0 = this.store.get();
    const realmM = realmMult(tierOf(s0.player.level), tierOf(m.lvl));
    const sectM = s0.player.sectId === 'qingyun' ? 1.05 : 1;
    const isCrit = this.rng() < crit / 100;
    const d = Math.round(damage(atk * realmM * sectM, m.def, this.rng) * (isCrit ? 2 : 1));
    m.hp -= d;
    m.state = 'chase';
    m.flashT = 120;
    this.addDmg(m.x, m.y, `-${d}`, isCrit ? '#ffd24d' : '#e8e8ec');
    this.sfx?.(isCrit ? 'crit' : 'hit');
    if (m.hp <= 0) this.kill(m);
  }

  private kill(m: Monster): void {
    const mt = this.monsterTemplate(m.templateId);
    if (!mt) return;
    m.state = 'dead';
    m.respawnAt = this.now + mt.respawnMs;
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
    const srcTier = tierOf(m.lvl);
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
    // 秘境试炼：双倍掉落
    if (this.realmKillsLeft > 0) {
      this.realmKillsLeft -= 1;
      const extra = rollTable(mt.dropTable, this.rng);
      if (extra) this.spawnDrop(extra, m.x, m.y, st.luck, srcTier, mt.name);
      if (this.realmKillsLeft === 0) this.log('gold', '[秘境] 试炼结束，灵雾秘境再次隐入山雾。');
    }
    this.spawnPuff(m.x, m.y, mt.color, 10);
    // 世界首领首杀
    if (mt.boss && !s0.world.bossDefeated) {
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
    this.log('c', `击杀 ${mt.name} Lv.${m.lvl}（+${xp} 修为，+${money} 灵石）`);
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
      const a = this.rng() * Math.PI * 2;
      const sp = 0.8 + this.rng() * 1.6;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.4,
        t: 0,
        life: 0.5 + this.rng() * 0.4,
        color,
        size: 1.5 + this.rng() * 2,
      });
    }
  }

  private addXp(xp: number): void {
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

  private die(killer: Monster): void {
    const mt = this.monsterTemplate(killer.templateId);
    const town = this.poi('town');
    const townName = config.factions.pois.find((q) => q.kind === 'town')?.name ?? '城镇';
    this.log('badl', `[陨落] 你被 ${mt?.name ?? '妖兽'} 击杀，在${townName}苏醒。心魔暗生（心境 -4）。`);
    this.sfx?.('death');
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
    for (const m of this.monsters) {
      if (m.state === 'dead') continue;
      m.state = 'idle';
      m.hp = m.hpMax;
      m.x = m.spawnX;
      m.y = m.spawnY;
    }
    this.sync();
  }

  // ---------------- 技能 ----------------
  castSkill(): void {
    const skill = config.skills.skills[0];
    if (this.skillCd > 0) {
      this.log('badl', `[技能] ${skill.name} 冷却中（${(this.skillCd / 1000).toFixed(1)}s）`);
      return;
    }
    if (this.player.mp < skill.mp) {
      this.log('badl', `[技能] 灵力不足（需 ${skill.mp}）`);
      return;
    }
    const target = this.nearestMonster(skill.range);
    if (!target) {
      this.log('badl', '[技能] 范围内没有目标');
      return;
    }
    const mt = this.monsterTemplate(target.templateId);
    const st = this.stats();
    this.player.mp -= skill.mp;
    this.skillCd = skill.cdMs;
    const isCrit = this.rng() < st.crit / 100;
    const d = Math.round(damage(st.atk * skill.mult, mt?.def ?? 0, this.rng) * (isCrit ? 2 : 1));
    target.hp -= d;
    target.state = 'chase';
    target.flashT = 120;
    this.addDmg(target.x, target.y, `-${d}`, '#ffd24d');
    this.sfx?.('skill');
    this.log(
      'c',
      `你施展【${skill.name}】，剑气如虹！对${mt?.name ?? ''}造成 <b class="num">${d}</b> 伤害${isCrit ? '（<span class="crit">暴击</span>）' : ''}。`,
    );
    if (target.hp <= 0) this.kill(target);
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
    if (!t) return false;
    let placed = false;
    this.store.set((st) => {
      const inv = st.inventory.slice();
      let remaining = count;
      if (t.stack > 1) {
        for (let i = 0; i < inv.length && remaining > 0; i++) {
          const it = inv[i];
          if (it && it.templateId === templateId && it.count < t.stack) {
            const add = Math.min(t.stack - it.count, remaining);
            inv[i] = { ...it, count: it.count + add };
            remaining -= add;
          }
        }
      }
      for (let i = 0; i < inv.length && remaining > 0; i++) {
        if (!inv[i]) {
          const take = Math.min(remaining, t.stack);
          inv[i] = { uid: nextUid(), templateId, count: take, plus, affixes: plus > 0 || affixes.length > 0 ? affixes : [] };
          remaining -= take;
        }
      }
      placed = remaining === 0;
      return { ...st, inventory: inv };
    });
    if (!placed && !silent) this.log('badl', '[背包] 背包已满，无法拾取');
    if (placed) bus.emit('inventoryChanged', null);
    return placed;
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
    const town = this.poi('town');
    this.player.x = town.x;
    this.player.y = town.y + 1;
    this.moveTarget = null;
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
      skillCd: Math.max(0, this.skillCd / 1000),
      skillCdMax: config.skills.skills[0].cdMs / 1000,
      skillName: skill.name,
      auraLabel: this.aura && this.store.get().world.day <= this.aura.untilDay
        ? `灵潮 ×${this.aura.xpMult.toFixed(2)}（至第 ${this.aura.untilDay} 日）`
        : null,
      canBreak: atRealmPeak(s.player.level),
      realmReady:
        this.nearRealm() &&
        s.world.day >= this.realmReadyDay &&
        tierOf(s.player.level) >= 1,
    };
  }

  private addDmg(x: number, y: number, text: string, color: string): void {
    this.dmgNumbers.push({
      x: x + (this.rng() - 0.5) * 0.4,
      y: y - 0.4,
      text,
      color,
      t: 0,
    });
  }
}
