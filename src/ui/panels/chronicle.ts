import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { bus } from '../../core/eventbus';
import { talkToNpc } from '../../ai/npc';

/** 编年史面板：天道 AI 书写（降级为模板），可向史官打听近况。 */
export function buildChroniclePanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');
  let reply: string | null = null;
  let loading = false;

  const render = (): void => {
    const s = ctx.store.get();
    const entries = [...s.world.chronicle].reverse();
    const list = entries
      .map(
        (c) => `
      <div class="entry${c.major ? ' major' : ''}">
        <div class="day">第 ${c.day} 日</div>
        <p>${escapeHtml(c.text)}</p>
      </div>`,
      )
      .join('');
    const replyHtml = loading
      ? '<div class="desc" style="margin:0;color:var(--tx3)">史官沉吟片刻……</div>'
      : reply
        ? `<div class="desc" style="margin:0;white-space:normal">${escapeHtml(reply)}</div>`
        : '<div class="desc" style="margin:0;color:var(--tx3)">点击「打听近况」，听史官评说天下大势。</div>';
    root.innerHTML = `
      <div class="sec-title">天道编年史</div>
      ${list || '<div class="hint-line">尚无记载。</div>'}
      <div class="card" style="margin-top:10px">
        <div class="row-between">
          <h4 style="margin:0">史官 沈墨</h4>
          <button class="btn sm" data-act="talk">打听近况</button>
        </div>
        ${replyHtml}
      </div>
      <div class="hint-line">编年史由天道 AI 书写；AI 关闭时以模板事件运行。</div>`;
    root.querySelector<HTMLElement>('[data-act="talk"]')!.addEventListener('click', () => void ask());
  };

  const ask = async (): Promise<void> => {
    const s = ctx.store.get();
    if (loading) return;
    if (!s.settings.apiKey) {
      reply = '墨某观之：未请天道，何以谈天下？客官可先在设置中填入 API Key。';
      render();
      return;
    }
    loading = true;
    render();
    const recent = s.world.chronicle
      .slice(-5)
      .map((c) => `第${c.day}日 ${c.text}`)
      .join('；');
    const context = `近来天下大事：${recent || '尚无记载'}。正魔紧张度 ${s.world.faction.tension}/100。请讲讲近来天下大势。`;
    try {
      reply = await talkToNpc(s.settings.apiKey, 'historian', context);
    } catch {
      reply = '墨某观之：天道缄默，今日无话可说。';
    } finally {
      loading = false;
      render();
    }
  };

  render();
  bus.on('worldChanged', () => {
    if (!loading) render();
  });
  return { id: 'chron', element: root };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
