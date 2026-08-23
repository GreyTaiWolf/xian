import type { BuiltPanel, PanelCtx } from './types';
import { el } from '../dom';
import { bus } from '../../core/eventbus';
import { config } from '../../core/config';
import { CHUNK_SIZE } from '../../world/map';

const ATLAS_W = 336;
const ATLAS_H = 228;

/** 地图面板：已探索区域图集（chunk 快照拼接，随探索扩张）。 */
export function buildMapPanel(ctx: PanelCtx): BuiltPanel {
  const root = el('div');

  const draw = (): void => {
    root.innerHTML = `
      <div class="sec-title">${ctx.store.get().world.name} · 已探索区域</div>
      <div class="mapbox" style="height:${ATLAS_H + 2}px">
        <canvas id="atlasCanvas" width="${ATLAS_W}" height="${ATLAS_H}"></canvas>
      </div>
      <div class="legend">
        ▓ 灰度 = 海拔 · 字符 = 生物群系（≈水 ∴沙 ♣林 ∧山 *雪）<br>
        ● 你 · 地标随探索显形<br>
        <span style="color:var(--tx3)">无限大陆按 seed 确定性生成：探索到哪，世界生成到哪。</span>
      </div>`;
    const canvas = root.querySelector<HTMLCanvasElement>('#atlasCanvas');
    if (!canvas) return;
    const actx = canvas.getContext('2d')!;
    const world = ctx.rt.map;
    const visited = world.visitedChunks();
    if (visited.length === 0) return;

    // 已探索 chunk 包围盒
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of visited) {
      minX = Math.min(minX, c.cx * CHUNK_SIZE);
      maxX = Math.max(maxX, (c.cx + 1) * CHUNK_SIZE);
      minY = Math.min(minY, c.cy * CHUNK_SIZE);
      maxY = Math.max(maxY, (c.cy + 1) * CHUNK_SIZE);
    }
    const scale = Math.max(0.2, Math.min(4, Math.min(ATLAS_W / (maxX - minX), ATLAS_H / (maxY - minY))));
    for (let py = 0; py < ATLAS_H; py++) {
      for (let px = 0; px < ATLAS_W; px++) {
        const t = world.at(minX + px / scale, minY + py / scale);
        actx.fillStyle = `rgb(${t.g},${t.g},${t.g})`;
        actx.fillRect(px, py, 1.05, 1.05);
      }
    }
    // 玩家
    const pos = ctx.store.get().player.pos;
    actx.fillStyle = '#58c4ff';
    actx.fillRect((pos.x - minX) * scale - 2, (pos.y - minY) * scale - 2, 4, 4);
    // 地标
    for (const p of config.factions.pois) {
      const mx = (p.x + 0.5 - minX) * scale;
      const my = (p.y + 0.5 - minY) * scale;
      if (mx < 0 || my < 0 || mx > ATLAS_W || my > ATLAS_H) continue;
      actx.font = '11px "Microsoft YaHei", sans-serif';
      actx.textAlign = 'center';
      actx.fillStyle = p.color;
      actx.fillText(p.char, mx, my);
    }
  };

  draw();
  bus.on('worldChanged', draw);
  return { id: 'map', element: root };
}
