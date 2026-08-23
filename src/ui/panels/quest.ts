import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { config } from '../../core/config';

/** 任务面板：主线/日常/宗门，进度实时更新，可领取奖励。 */
export function buildQuestPanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');

  const render = (): void => {
    const s = ctx.store.get();
    const groups: { type: string; title: string }[] = [
      { type: 'main', title: '主线' },
      { type: 'daily', title: '日常' },
    ];
    let html = '';
    for (const g of groups) {
      const defs = config.quests.quests.filter((q) => q.type === g.type);
      if (defs.length === 0) continue;
      html += `<div class="sec-title">${g.title}</div>`;
      for (const def of defs) {
        const qs = s.player.quests.find((q) => q.id === def.id);
        const progress = qs?.progress ?? 0;
        const done = progress >= def.target.count;
        const claimed = qs?.claimed ?? false;
        const pct = Math.min(100, (progress / def.target.count) * 100);
        html += `<div class="card">
          <h4>${def.name}${claimed ? ' <span class="badge good">已领取</span>' : done ? ' <span class="badge mid">可领取</span>' : ''}</h4>
          <div class="desc">${def.desc}</div>
          <div class="bar-row"><span class="tag">进度</span><div class="bar"><i style="width:${pct}%;background:${done ? 'var(--good)' : 'var(--gold)'}"></i></div><span class="num">${progress}/${def.target.count}</span></div>
          <div class="bar-row"><span style="color:var(--tx3)">奖励：修为 ${def.reward.xp} · 灵石 ${def.reward.money}${def.reward.contribution ? ` · 贡献 ${def.reward.contribution}` : ''}</span>
          ${claimed ? '' : `<button class="btn sm ${done ? 'gold' : 'off'}" data-act="claim" data-quest="${def.id}">领取</button>`}
          </div>
        </div>`;
      }
    }
    root.innerHTML = html + '<div class="hint-line">击杀妖兽自动推进任务进度；主线为引导，日常可反复刷。</div>';
    root.querySelectorAll<HTMLElement>('[data-act="claim"]').forEach((b) => {
      b.addEventListener('click', () => ctx.rt.claimQuest(b.dataset.quest ?? ''));
    });
  };

  render();
  ctx.store.subscribe(() => render());
  return { id: 'quest', element: root };
}
