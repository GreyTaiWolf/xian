import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { bus } from '../../core/eventbus';
import {
  GRADE_BORDER_CLS,
  GRADE_NAMES,
  GRADE_TEXT_CLS,
  STAT_NAMES,
  USE_DESC,
  affixText,
  itemDisplayName,
  itemTemplate,
} from '../../game/stats';

/** 背包面板：32 格 + 点击查看 + 装备/使用/丢弃。 */
export function buildInventoryPanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');
  let selected: number | null = null;

  const itemInfo = (idx: number | null): string => {
    if (idx === null) {
      return '<h4 style="color:var(--tx3)">物品信息</h4><div class="ln"><span class="k">提示</span><span>点击背包中的物品查看详情</span></div>';
    }
    const s = ctx.store.get();
    const it = s.inventory[idx];
    if (!it) return itemInfo(null);
    const t = itemTemplate(it.templateId);
    if (!t) return itemInfo(null);
    const plusName = it.plus > 0 ? ` <span class="goldc">+${it.plus}</span>` : '';
    let html = `<h4 class="${GRADE_TEXT_CLS[t.grade] ?? 'rw'}">${itemDisplayName(t)}${plusName}</h4>`;
    html += `<div class="ln"><span class="k">品阶</span><span class="${GRADE_TEXT_CLS[t.grade] ?? 'rw'}">${GRADE_NAMES[t.grade] ?? ''}</span></div>`;
    if (t.type === 'weapon' || t.type === 'armor') {
      const mult = 1 + it.plus * 0.15;
      for (const [k, v] of Object.entries(t.stats as Record<string, number>)) {
        if (v) html += `<div class="ln"><span class="k">${STAT_NAMES[k] ?? k}</span><span class="num">+${Math.round(v * mult)}</span></div>`;
      }
      for (const a of it.affixes) {
        html += `<div class="ln"><span class="k">词条</span><span class="rg">${affixText(a)}</span></div>`;
      }
      html += `<div class="ln"><span class="k">描述</span><span>${t.desc || '——'}</span></div>`;
    } else if (t.type === 'consumable') {
      const use = (t as unknown as { use?: string }).use ?? '';
      html += `<div class="ln"><span class="k">效果</span><span>${USE_DESC[use] ?? t.desc}</span></div>`;
    } else {
      html += `<div class="ln"><span class="k">描述</span><span>${t.desc || '材料，可出售。'}</span></div>`;
    }
    html += `<div class="ln"><span class="k">售价</span><span class="num goldc">${t.price} 灵石</span></div>`;
    html += '<div class="row" style="margin-top:8px">';
    if (t.type === 'weapon' || t.type === 'armor') {
      html += '<button class="btn sm primary" data-act="equip" style="flex:1">装备</button>';
      if (it.plus < 5) html += '<button class="btn sm gold" data-act="upgrade" style="flex:1">强化</button>';
    }
    if (t.type === 'consumable') html += '<button class="btn sm primary" data-act="use" style="flex:1">使用</button>';
    html += '<button class="btn sm danger" data-act="drop" style="flex:1">丢弃</button></div>';
    return html;
  };

  const render = (): void => {
    const s = ctx.store.get();
    let cells = '';
    s.inventory.forEach((it, i) => {
      if (!it) {
        cells += '<div class="cell empty"></div>';
        return;
      }
      const t = itemTemplate(it.templateId);
      if (!t) {
        cells += '<div class="cell empty"></div>';
        return;
      }
      const sel = i === selected ? ' selected' : '';
      cells += `<div class="cell ${GRADE_BORDER_CLS[t.grade] ?? 'bd-white'}${sel}" data-idx="${i}"><span class="${GRADE_TEXT_CLS[t.grade] ?? 'rw'}">${t.char}</span>${it.count > 1 ? `<div class="cnt">×${it.count}</div>` : ''}</div>`;
    });
    const used = s.inventory.filter((x) => x !== null).length;
    root.innerHTML = `
      <div class="row-between">
        <span>背包</span><span class="num" style="color:var(--tx2)">${used} / ${s.inventory.length}</span>
      </div>
      <div class="inv-grid">${cells}</div>
      <div class="info">${itemInfo(selected)}</div>
      <div class="hint-line">点击物品查看 · 装备/使用/丢弃 · 靠近掉落自动拾取</div>`;
    root.querySelectorAll<HTMLElement>('.cell[data-idx]').forEach((c) => {
      c.addEventListener('click', () => {
        selected = parseInt(c.dataset.idx ?? '-1', 10);
        render();
      });
    });
    root.querySelector<HTMLElement>('[data-act="equip"]')?.addEventListener('click', () => {
      const it = ctx.store.get().inventory[selected ?? -1];
      if (it) ctx.rt.equipItem(it.uid);
    });
    root.querySelector<HTMLElement>('[data-act="use"]')?.addEventListener('click', () => {
      const it = ctx.store.get().inventory[selected ?? -1];
      if (it) ctx.rt.useItem(it.uid);
    });
    root.querySelector<HTMLElement>('[data-act="upgrade"]')?.addEventListener('click', () => {
      const it = ctx.store.get().inventory[selected ?? -1];
      if (it) ctx.rt.upgradeItem(it.uid);
    });
    root.querySelector<HTMLElement>('[data-act="drop"]')?.addEventListener('click', () => {
      const it = ctx.store.get().inventory[selected ?? -1];
      if (it) ctx.rt.dropItem(it.uid);
    });
  };

  render();
  bus.on('inventoryChanged', render);
  return { id: 'inv', element: root };
}
