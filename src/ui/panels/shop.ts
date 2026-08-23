import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { config } from '../../core/config';
import { GRADE_TEXT_CLS, itemDisplayName, itemTemplate } from '../../game/stats';

interface ShopRow {
  templateId: string;
  note: string;
  price: number;
  buy: boolean;
}

const ROWS: ShopRow[] = [
  { templateId: 'hp_pill', note: '恢复生命 80', price: 25, buy: true },
  { templateId: 'mp_pill', note: '恢复灵力 40', price: 25, buy: true },
  { templateId: 'portal_fu', note: '回城', price: 60, buy: true },
  { templateId: 'iron_ingot', note: '炼器/强化材料', price: 80, buy: true },
  { templateId: 'xp_pill', note: '修为 +100 · 突破材料', price: 150, buy: true },
  { templateId: 'treasure_frag', note: '集齐三片寻仙府', price: 300, buy: true },
  { templateId: 'wolf_pelt', note: '出售材料', price: 12, buy: false },
  { templateId: 'wolf_core', note: '出售材料', price: 45, buy: false },
  { templateId: 'iron_ingot', note: '出售材料', price: 80, buy: false },
];

/** 商店面板：真实买卖 + 炼丹合成（接运行时背包与经济）。 */
export function buildShopPanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');
  const rows = (): string =>
    ROWS.map((r) => {
      const t = itemTemplate(r.templateId);
      const name = `<span class="${GRADE_TEXT_CLS[t?.grade ?? 'fan'] ?? 'rw'}">${t ? itemDisplayName(t) : r.templateId}</span>`;
      return `<div class="srow">${name}<span class="name" style="text-align:right;color:var(--tx3)">${r.note}</span><span class="price">${r.price} 灵石</span><button class="btn sm" data-act="${r.buy ? 'buy' : 'sell'}" data-item="${r.templateId}">${r.buy ? '购买' : '出售'}</button></div>`;
    }).join('');
  const recipes = config.crafting.recipes
    .map((r) => {
      const t = itemTemplate(r.output);
      const mats = r.materials
        .map((m) => `${itemTemplate(m.item)?.name ?? m.item}×${m.count}`)
        .join(' + ');
      return `<div class="srow"><span class="${GRADE_TEXT_CLS[t?.grade ?? 'fan'] ?? 'rw'}">${r.name}×${r.outputCount}</span><span class="name" style="text-align:right;color:var(--tx3)">${mats} + ${r.money} 灵石</span><button class="btn sm" data-act="craft" data-recipe="${r.id}">炼制</button></div>`;
    })
    .join('');
  root.innerHTML = `
    <div class="row-between">
      <span>霜落城 · 万宝商会</span><span class="goldc num" data-bind="money"></span>
    </div>
    <div class="sec-title">购买</div>
    ${rows()}
    <div class="sec-title">炼丹 · 合成</div>
    ${recipes}
    <div class="hint-line">购买/炼制直接入背包；出售从背包扣除（万宝商会弟子售价 +10%）</div>`;
  root.querySelectorAll<HTMLElement>('[data-act="buy"]').forEach((b) => {
    b.addEventListener('click', () => ctx.rt.buyItem(b.dataset.item ?? ''));
  });
  root.querySelectorAll<HTMLElement>('[data-act="sell"]').forEach((b) => {
    b.addEventListener('click', () => ctx.rt.sellItem(b.dataset.item ?? ''));
  });
  root.querySelectorAll<HTMLElement>('[data-act="craft"]').forEach((b) => {
    b.addEventListener('click', () => ctx.rt.craft(b.dataset.recipe ?? ''));
  });
  return { id: 'shop', element: root };
}
