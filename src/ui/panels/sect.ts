import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { config } from '../../core/config';
import { GRADE_TEXT_CLS, itemDisplayName, itemTemplate } from '../../game/stats';

/** 宗门面板：加入/退出 + 贡献 + 兑换 + 宗门战况。 */
export function buildSectPanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');

  const render = (): void => {
    const s = ctx.store.get();
    const tension = s.world.faction.tension;
    const warBanner =
      tension >= 80
        ? '<div class="card" style="border-color:var(--bad)"><div class="desc" style="margin:0"><span style="color:var(--bad)">● 宗门战进行中</span> 正魔紧张度 ' +
          tension +
          '/100 —— 击杀妖兽贡献翻倍。</div></div>'
        : '';
    const cards = config.sects.sects
      .map((def) => {
        const mine = s.player.sectId === def.id;
        const badge = `<span class="badge ${def.alignment === '正道' ? 'good' : def.alignment === '魔道' ? 'bad' : 'mid'}">${def.alignment}</span>`;
        const info = mine
          ? `<div class="bar-row"><span class="tag">贡献</span><div class="bar"><i style="width:${Math.min(100, s.player.contribution / 100)}%;background:var(--gold)"></i></div><span class="num">${s.player.contribution}</span></div>`
          : `<div class="desc" style="margin:4px 0 0">入门要求：Lv.${def.joinLevel} · 被动：${def.passive}</div>`;
        const btns = mine
          ? `<div class="row" style="margin-top:8px"><button class="btn sm danger" data-act="leave" style="flex:1">退出宗门</button></div>`
          : `<div class="row" style="margin-top:8px"><button class="btn sm primary" data-act="join" data-sect="${def.id}" style="flex:1">拜入宗门</button></div>`;
        return `<div class="card">
          <h4>${def.name} ${badge}</h4>
          <div class="desc">${def.desc}</div>
          ${info}
          ${btns}
        </div>`;
      })
      .join('');
    const mySect = config.sects.sects.find((x) => x.id === s.player.sectId);
    const exchange = mySect
      ? '<div class="sec-title">贡献兑换</div>' +
        mySect.exchange
          .map((e) => {
            const t = itemTemplate(e.item);
            return `<div class="srow"><span class="${GRADE_TEXT_CLS[t?.grade ?? 'fan'] ?? 'rw'}">${t ? itemDisplayName(t) : e.item}</span><span class="name" style="text-align:right;color:var(--tx3)">${t?.desc ?? ''}</span><span class="price">${e.cost} 贡献</span><button class="btn sm" data-act="exchange" data-item="${e.item}">兑换</button></div>`;
          })
          .join('')
      : '<div class="hint-line">拜入宗门后可获得被动加成，并以贡献兑换物资。</div>';
    root.innerHTML = `
      <div class="sec-title">宗门势力</div>
      ${warBanner}
      ${cards}
      ${exchange}
      <div class="hint-line">击杀妖兽获得贡献；宗门战期间贡献翻倍。</div>`;
    root.querySelectorAll<HTMLElement>('[data-act="join"]').forEach((b) => {
      b.addEventListener('click', () => ctx.rt.joinSect(b.dataset.sect ?? ''));
    });
    root.querySelector<HTMLElement>('[data-act="leave"]')?.addEventListener('click', () => ctx.rt.leaveSect());
    root.querySelectorAll<HTMLElement>('[data-act="exchange"]').forEach((b) => {
      b.addEventListener('click', () => ctx.rt.sectExchange(b.dataset.item ?? ''));
    });
  };

  render();
  ctx.store.subscribe(() => render());
  return { id: 'sect', element: root };
}
