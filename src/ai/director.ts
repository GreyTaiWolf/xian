/**
 * 天道世界导演：每个世界日 —— 状态摘要 → LLM 决策 → 校验 → 执行 → 编年史。
 * AI 不可用 / 无 key / 导演关闭时降级到模板事件库，游戏照常运转。
 */
import { config } from '../core/config';
import { bus, type LogCls } from '../core/eventbus';
import type { Store } from '../core/store';
import type { GameState } from '../game/state';
import type { GameRuntime } from '../systems/runtime';
import { AiError, chat, extractJson } from './client';
import { validateDirectives, type Directive } from './validator';

const SYSTEM_PROMPT = `你是「沧溟界」的天道，一个几何修真世界的运行者与史官。
你通过结构化指令影响世界：势力消长、兽潮、灵潮、市井传闻。你绝不直接改动任何数值或角色的命运，只颁布天道旨意。
输出必须是严格 JSON（不要任何解释文字），格式：
{"directives":[{"type":"...","..."}],"chronicle":"一句话编年史，30字内"}
可用指令类型：
1. {"type":"faction_relation_change","delta":-15,"reason":"边境灵矿争夺"} —— delta 范围 -20~20，正值=局势更紧张
2. {"type":"beast_tide","target":"town","power":2} —— target 为 town 或 player；power 1~4
3. {"type":"spirit_surge","xpMult":1.2,"durationDays":3} —— 灵气潮汐，修炼加速；xpMult 0.9~1.3
4. {"type":"world_rumor","text":"传闻……"} —— 市井传闻，不改变数值
每次 1~3 条指令，考虑当前局势、编年史走向与玩家进度，让世界像活的一样。`;

export class Director {
  private running = false;

  constructor(
    private store: Store<GameState>,
    private getRt: () => GameRuntime | null,
    private log: (cls: LogCls, text: string) => void,
  ) {}

  /** 世界日边界触发（fire-and-forget，绝不阻塞主循环）。 */
  runDay(day: number): void {
    if (this.running) return;
    const s = this.store.get();
    const interval = s.settings.directorIntervalDays;
    if (interval <= 0) return; // 导演关闭
    if ((day - 1) % interval !== 0) return; // 非导演日
    this.running = true;
    const run = async (): Promise<void> => {
      try {
        if (!s.settings.aiEnabled || !s.settings.apiKey) this.templateDay(day);
        else await this.aiDay(day, s.settings.apiKey);
      } finally {
        this.running = false;
      }
    };
    void run();
  }

  private async aiDay(day: number, apiKey: string): Promise<void> {
    try {
      const raw = await chat(
        apiKey,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: this.summary() },
        ],
        { json: true, maxTokens: 600 },
      );
      const data = extractJson(raw) as { directives?: unknown; chronicle?: unknown };
      const dirs = validateDirectives(data);
      for (const d of dirs) this.execute(d);
      const chronicle =
        typeof data.chronicle === 'string' && data.chronicle.trim()
          ? data.chronicle.trim().slice(0, 60)
          : this.fallbackChronicle(dirs);
      this.appendChronicle(day, chronicle, dirs.some((d) => d.type === 'beast_tide' || d.type === 'faction_relation_change'));
      this.log('sys', `[天道] 第 ${day} 日：${chronicle}`);
    } catch (e) {
      const msg = e instanceof AiError ? e.message : String(e);
      this.log('badl', `[天道] 决策失败（${msg}），以模板事件运行。`);
      this.templateDay(day);
    }
  }

  /** 降级路径：模板事件库（AI 关闭/失败时世界依然运转）。 */
  private templateDay(day: number): void {
    const tpls = config.eventsTemplates.templates;
    const t = tpls[Math.floor(Math.random() * tpls.length)];
    this.execute(this.templateToDirective(t));
    this.appendChronicle(day, t.text, t.type === 'beast_tide');
    this.log('sys', `[天道] 第 ${day} 日：${t.text}`);
  }

  private templateToDirective(t: (typeof config.eventsTemplates.templates)[number]): Directive {
    switch (t.type) {
      case 'relation':
        return { type: 'faction_relation_change', delta: t.delta };
      case 'buff':
        return { type: 'spirit_surge', xpMult: t.xpMult, durationDays: t.durationDays };
      case 'beast_tide':
        return { type: 'beast_tide', target: 'town', power: t.power };
      default:
        return { type: 'world_rumor', text: t.text };
    }
  }

  private execute(d: Directive): void {
    const rt = this.getRt();
    switch (d.type) {
      case 'faction_relation_change': {
        const delta = d.delta ?? 0;
        this.store.set((st) => ({
          ...st,
          world: {
            ...st.world,
            faction: {
              ...st.world.faction,
              tension: Math.min(100, Math.max(0, st.world.faction.tension + delta)),
            },
          },
        }));
        if (d.reason) this.log('gold', `[势力] 正魔两派：${d.reason}（紧张度 ${delta > 0 ? '+' : ''}${delta}）`);
        break;
      }
      case 'beast_tide': {
        const power = d.power ?? 1;
        rt?.spawnWave(4 + power * 3, power * 0.3, d.target === 'town' ? 'town' : 'player');
        this.log('badl', `[兽潮] ${d.target === 'town' ? '霜落城' : '你'}附近妖兽躁动，天降杀机！`);
        break;
      }
      case 'spirit_surge': {
        const mult = d.xpMult ?? 1.1;
        rt?.setAura(mult, d.durationDays ?? 2);
        this.log('gold', `[灵潮] 天地灵气涌动，修炼速度 ×${mult.toFixed(2)}（持续 ${d.durationDays ?? 2} 日）。`);
        break;
      }
      case 'world_rumor':
      case 'npc_action':
        this.log('c', `[传闻] ${d.text ?? ''}`);
        break;
    }
  }

  private appendChronicle(day: number, text: string, major: boolean): void {
    this.store.set((st) => {
      const chronicle = [...st.world.chronicle, { day, text, major }].slice(-60);
      return { ...st, world: { ...st.world, chronicle } };
    });
    bus.emit('worldChanged', null);
  }

  private fallbackChronicle(dirs: Directive[]): string {
    const names: Record<string, string> = {
      faction_relation_change: '正魔两派暗流涌动',
      beast_tide: '妖祸骤起',
      spirit_surge: '灵潮涌动，天地异象',
      world_rumor: '市井流言四起',
      npc_action: '城中人事变动',
    };
    const text = dirs.map((d) => names[d.type]).filter(Boolean).join('；');
    return text || '天下无事';
  }

  private summary(): string {
    const s = this.store.get();
    const p = s.player;
    const recent =
      s.world.chronicle.slice(-3).map((c) => `第${c.day}日 ${c.text}`).join('；') || '无';
    return [
      `世界：${s.world.name}，第 ${s.world.day} 日`,
      `玩家：${p.name}，Lv.${p.level}，灵石 ${p.money}，累计击杀 ${p.kills}`,
      `势力：青云剑宗(${s.world.faction.sectPower}) vs 血煞魔教(${s.world.faction.demonPower})，紧张度 ${s.world.faction.tension}/100`,
      `近况：${recent}`,
      '请颁布今日天道旨意。',
    ].join('\n');
  }
}
