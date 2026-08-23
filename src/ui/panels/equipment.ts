import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { bus } from '../../core/eventbus';
import type { EquipSlot } from '../../game/state';
import {
  GRADE_BORDER_CLS,
  GRADE_NAMES,
  GRADE_TEXT_CLS,
  STAT_NAMES,
  affixText,
  derivedStats,
  itemDisplayName,
  itemTemplate,
} from '../../game/stats';

const SLOT_LAYOUT: { slot: EquipSlot; label: string; left: number; top: number }[] = [
  { slot: 'weapon', label: '武器', left: 112, top: 52 },
  { slot: 'head', label: '头部', left: 58, top: -34 },
  { slot: 'body', label: '身体', left: 56, top: 72 },
  { slot: 'hands', label: '手部', left: 6, top: 52 },
  { slot: 'feet', label: '脚部', left: 56, top: 150 },
  { slot: 'trinket1', label: '饰品一', left: 112, top: 118 },
  { slot: 'trinket2', label: '饰品二', left: 6, top: 118 },
];

/** 装备面板：8 槽位 + 属性总览；点击已装备槽位卸下。 */
export function buildEquipmentPanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');

  const itemInfo = (slot: EquipSlot | null): string => {
    if (!slot) {
      return '<h4 style="color:var(--tx3)">装备信息</h4><div class="ln"><span class="k">提示</span><span>点击槽位卸下装备；背包中点击装备穿戴</span></div>';
    }
    const it = ctx.store.get().equipment[slot];
    if (!it) return itemInfo(null);
    const t = itemTemplate(it.templateId);
    if (!t) return itemInfo(null);
    const plusName = it.plus > 0 ? ` <span class="goldc">+${it.plus}</span>` : '';
    let html = `<h4 class="${GRADE_TEXT_CLS[t.grade] ?? 'rw'}">${itemDisplayName(t)}${plusName}</h4>`;
    html += `<div class="ln"><span class="k">品阶</span><span class="${GRADE_TEXT_CLS[t.grade] ?? 'rw'}">${GRADE_NAMES[t.grade] ?? ''}</span></div>`;
    const mult = 1 + it.plus * 0.15;
    for (const [k, v] of Object.entries(t.stats as Record<string, number>)) {
      if (v) html += `<div class="ln"><span class="k">${STAT_NAMES[k] ?? k}</span><span class="num">+${Math.round(v * mult)}</span></div>`;
    }
    for (const a of it.affixes) {
      html += `<div class="ln"><span class="k">词条</span><span class="rg">${affixText(a)}</span></div>`;
    }
    html += `<div class="ln"><span class="k">描述</span><span>${t.desc || '——'}</span></div>`;
    return html;
  };

  const render = (): void => {
    const s = ctx.store.get();
    const st = derivedStats(s);
    let slots = '';
    for (const l of SLOT_LAYOUT) {
      const it = s.equipment[l.slot];
      if (it) {
        const t = itemTemplate(it.templateId);
        slots += `<div class="slot ${GRADE_BORDER_CLS[t?.grade ?? 'fan'] ?? 'bd-white'}" style="left:${l.left}px;top:${l.top}px" data-slot="${l.slot}"><span class="${GRADE_TEXT_CLS[t?.grade ?? 'fan'] ?? 'rw'}">${t?.char ?? '?'}</span><span class="sl">${l.label}</span></div>`;
      } else {
        slots += `<div class="slot" style="left:${l.left}px;top:${l.top}px" data-slot="${l.slot}"><span class="sl">${l.label}</span></div>`;
      }
    }
    root.innerHTML = `
      <div class="sec-title">装备</div>
      <div class="equip-wrap">
        <div class="fig">
          <div class="head"></div>
          <div class="body"></div>
          <div class="limb" style="left:40px;top:48px"></div>
          <div class="limb" style="left:92px;top:48px"></div>
          <div class="limb" style="left:50px;top:104px;transform:rotate(8deg)"></div>
          <div class="limb" style="left:82px;top:104px;transform:rotate(-8deg)"></div>
          ${slots}
        </div>
        <div class="equip-info">
          <div class="info" style="min-height:130px">${itemInfo(null)}</div>
          <div class="sec-title">属性总览</div>
          <div class="stat-line"><span class="tag">攻击</span><span class="spacer"></span><span class="num">${st.atk}</span></div>
          <div class="stat-line"><span class="tag">防御</span><span class="spacer"></span><span class="num">${st.def}</span></div>
          <div class="stat-line"><span class="tag">速度</span><span class="spacer"></span><span class="num">${st.spd}</span></div>
          <div class="stat-line"><span class="tag">暴击</span><span class="spacer"></span><span class="num">${st.crit}%</span></div>
          <div class="stat-line"><span class="tag">幸运</span><span class="spacer"></span><span class="num">${st.luck}</span></div>
          <div class="hint-line">点击槽位卸下装备</div>
        </div>
      </div>`;
    root.querySelectorAll<HTMLElement>('.slot[data-slot]').forEach((sl) => {
      sl.addEventListener('mouseenter', () => {
        root.querySelector<HTMLElement>('.equip-info .info')!.innerHTML = itemInfo(sl.dataset.slot as EquipSlot);
      });
      sl.addEventListener('click', () => {
        ctx.rt.unequip(sl.dataset.slot as EquipSlot);
      });
    });
  };

  render();
  bus.on('equipmentChanged', render);
  return { id: 'equip', element: root };
}
