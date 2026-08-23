import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { bus } from '../../core/eventbus';
import type { HudData } from '../../systems/runtime';
import { config } from '../../core/config';
import { realmOf, realmPhase, tierOf } from '../../game/stats';

/** 心境标签。 */
function mindLabel(v: number): string {
  if (v >= 70) return '清明';
  if (v >= 45) return '稳定';
  if (v >= 25) return '波动';
  return '紊乱';
}

/** 角色面板：境界突破（真实）/ 属性 / 统计。 */
export function buildCharacterPanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');

  const render = (): void => {
    const s = ctx.store.get();
    const p = s.player;
    const tier = tierOf(p.level);
    const realmDef = config.realms.realms[tier];
    const peak = (p.level - 1) % 9 === 8;
    const sectName = config.sects.sects.find((x) => x.id === p.sectId)?.name ?? '散修';
    const ratePct = peak
      ? Math.min(95, Math.round((realmDef!.breakthrough.successBase + p.base.luck * 0.002 + p.mind * 0.001 + p.insight * 0.001) * 100))
      : 0;
    const breakHtml = peak
      ? `<div class="desc">成功率约 <b class="goldc">${ratePct}%</b>（受幸运/心境/悟性影响）· 条件：灵石 ${realmDef?.breakthrough.money ?? '-'} · 材料 ${realmDef?.breakthrough.item ?? '-'}×${realmDef?.breakthrough.count ?? '-'}${tier >= config.realms.realms.length - 1 ? '；渡劫圆满突破 = 飞升转世' : ''}</div>
         <div class="bar-row"><button class="btn gold sm" data-act="break" style="flex:1">突破</button></div>`
      : `<div class="desc">修为圆满后方可突破（当前 ${realmPhase(p.level)}）</div>
         <div class="bar-row"><button class="btn gold sm off" style="flex:1">突破</button></div>`;
    root.innerHTML = `
      <div class="sec-title">境界</div>
      <div class="card" style="margin-bottom:12px">
        <h4><span id="cRealm" class="goldc">${realmOf(p.level)}</span>${p.ascension > 0 ? ` <span class="badge mid">${p.ascension} 转</span>` : ''}</h4>
        <div class="desc">炼气 → 筑基 → 金丹 → 元婴 → 化神 → 渡劫（每 9 级一大境）</div>
        <div class="bar-row"><div class="bar"><i id="cXp" style="width:0%;background:var(--gold)"></i></div><span class="num" id="cXpV">0/0</span></div>
        ${breakHtml}
        <div class="bar-row"><span class="tag">保底</span><div class="bar"><i id="cPity" style="width:0%;background:var(--r-blue)"></i></div><span class="num" id="cPityV">0/10</span></div>
      </div>
      <div class="sec-title">属性</div>
      <div class="card">
        <div class="ln" style="display:flex;justify-content:space-between"><span>生命</span><span class="num" id="cHp">${p.hp}/${p.base.hpMax}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>灵力</span><span class="num" id="cMp">${p.mp}/${p.base.mpMax}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>攻击</span><span class="num" id="cAtk">${p.base.atk}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>防御</span><span class="num" id="cDef">${p.base.def}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>速度</span><span class="num" id="cSpd">${p.base.spd}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>暴击</span><span class="num" id="cCrit">${p.base.crit}%</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>幸运</span><span class="num" id="cLuck">${p.base.luck}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>心境</span><span style="color:var(--gold)" id="cMind">${mindLabel(p.mind)}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>悟性</span><span class="num" id="cInsight">${p.insight}</span></div>
      </div>
      <div class="sec-title">游历统计</div>
      <div class="card">
        <div class="ln" style="display:flex;justify-content:space-between"><span>等级</span><span class="num" id="cLevel">${p.level}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>累计击杀</span><span class="num" id="cKills">${p.kills}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>宗门</span><span style="color:var(--tx2)">${sectName}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>宗门贡献</span><span class="num">${p.contribution}</span></div>
        <div class="ln" style="display:flex;justify-content:space-between"><span>游历时日</span><span class="num">${ctx.store.get().world.day} 日</span></div>
      </div>
      <div class="sec-title">成就 <span class="num" style="color:var(--tx3)">${p.achievements.length}/${config.achievements.achievements.length}</span></div>
      <div class="card">
        ${config.achievements.achievements
          .map((a) => {
            const got = p.achievements.includes(a.id);
            return `<div class="ln" style="display:flex;justify-content:space-between"><span style="${got ? 'color:var(--gold)' : 'color:var(--tx3)'}">${got ? '✓ ' : ''}${a.name}</span><span style="color:var(--tx3)">${a.desc}</span></div>`;
          })
          .join('')}
      </div>`;
    root.querySelector<HTMLElement>('[data-act="break"]')?.addEventListener('click', () => ctx.rt.breakthrough());
  };

  const applyHud = (d: HudData): void => {
    const set = (id: string, v: string): void => {
      const n = root.querySelector<HTMLElement>('#' + id);
      if (n) n.textContent = v;
    };
    const bar = (id: string, pct: number): void => {
      const n = root.querySelector<HTMLElement>('#' + id);
      if (n) n.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    };
    set('cRealm', d.realm);
    set('cHp', `${d.hp}/${d.hpMax}`);
    set('cMp', `${d.mp}/${d.mpMax}`);
    set('cXpV', `${d.xp}/${d.xpMax}`);
    set('cAtk', String(d.atk));
    set('cDef', String(d.def));
    set('cSpd', String(d.spd));
    set('cCrit', `${d.crit}%`);
    set('cLuck', String(d.luck));
    set('cLevel', String(d.level));
    set('cKills', String(d.kills));
    set('cPityV', `${d.pity}/${d.pityMax}`);
    bar('cXp', (d.xp / Math.max(1, d.xpMax)) * 100);
    bar('cPity', (d.pity / d.pityMax) * 100);
  };

  render();
  bus.on('hud', applyHud);
  bus.on('equipmentChanged', render);
  ctx.store.subscribe(() => render());
  return { id: 'char', element: root };
}
