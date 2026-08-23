/**
 * 面板注册表：id 与 config/ui.json 中 panels[].id 一一对应。
 */
import type { BuiltPanel, PanelCtx } from './types';
import { buildInventoryPanel } from './inventory';
import { buildEquipmentPanel } from './equipment';
import { buildCharacterPanel } from './character';
import { buildMapPanel } from './map';
import { buildSectPanel } from './sect';
import { buildShopPanel } from './shop';
import { buildQuestPanel } from './quest';
import { buildChroniclePanel } from './chronicle';

export type { BuiltPanel, PanelCtx } from './types';

export const panelBuilders: Record<string, (ctx: PanelCtx) => BuiltPanel> = {
  inv: buildInventoryPanel,
  equip: buildEquipmentPanel,
  char: buildCharacterPanel,
  map: buildMapPanel,
  sect: buildSectPanel,
  shop: buildShopPanel,
  quest: buildQuestPanel,
  chron: buildChroniclePanel,
};
