/**
 * Canvas 渲染器：灰度地形 / 地标 / 掉落光柱 / 怪物 / 玩家 / 伤害数字 / 小地图。
 */
import { Camera } from './camera';
import { gradeDef, itemTemplate } from '../game/stats';
import type { GameRuntime, Monster } from '../systems/runtime';
import { config } from '../core/config';

/** 怪物模板缓存（每帧查询优化）。 */
const MONSTER_TPL = new Map(config.monsters.monsters.map((m) => [m.id, m]));

export class Renderer {
  readonly camera = new Camera();
  private vw = 1;
  private vh = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private ctx: CanvasRenderingContext2D,
  ) {}

  resize(w: number, h: number, dpr: number): void {
    this.vw = w;
    this.vh = h;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 主视口：摄像机跟随玩家。 */
  drawWorld(rt: GameRuntime): void {
    const { ctx, camera } = this;
    const w = this.vw;
    const h = this.vh;
    const z = camera.zoom;
    camera.x = rt.player.x;
    camera.y = rt.player.y;
    ctx.clearRect(0, 0, w, h);

    // 地形（只画视口内；世界无限，坐标可越界）
    const x0 = Math.floor(camera.x - w / 2 / z) - 1;
    const y0 = Math.floor(camera.y - h / 2 / z) - 1;
    const x1 = Math.ceil(camera.x + w / 2 / z) + 1;
    const y1 = Math.ceil(camera.y + h / 2 / z) + 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.max(10, z * 0.5)}px monospace`;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t = rt.map.at(x, y);
        const sx = (x + 0.5 - camera.x) * z + w / 2;
        const sy = (y + 0.5 - camera.y) * z + h / 2;
        ctx.fillStyle = `rgb(${t.g},${t.g},${t.g})`;
        ctx.fillRect(sx - z / 2, sy - z / 2, z + 0.5, z + 0.5);
        if (t.ch) {
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.fillText(t.ch, sx, sy + 1);
        }
      }
    }

    // 地标（城镇/宗门/首领巢穴，来自 factions 配置）
    for (const p of config.factions.pois) {
      this.marker(ctx, w, h, p.x + 0.5, p.y + 0.5, p.char, p.color, p.kind === 'town' ? 16 : 14, p.name);
    }

    // 掉落：光柱 + 菱形（颜色随品级）
    for (const d of rt.drops) {
      const color = gradeDef(itemTemplate(d.templateId)?.grade ?? 'fan')?.color ?? '#d8d8dc';
      const sx = (d.x - camera.x) * z + w / 2;
      const sy = (d.y - camera.y) * z + h / 2;
      const pulse = 0.4 + 0.35 * Math.sin(rt.now / 280 + d.uid);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = color;
      ctx.fillRect(sx - 2, sy - z * 1.15, 4, z * 0.9);
      ctx.globalAlpha = 0.9;
      this.diamond(ctx, sx, sy, Math.max(5, z * 0.32), color);
      ctx.globalAlpha = 1;
    }

    // 怪物
    for (const m of rt.monsters) this.drawMonster(ctx, rt, m, w, h, z);

    // 死亡/稀有掉落粒子
    for (const p of rt.particles) {
      const a = Math.max(0, 1 - p.t / p.life);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const px = (p.x - camera.x) * z + w / 2;
      const py = (p.y - camera.y) * z + h / 2;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.5, p.size * z * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 玩家
    const px = (rt.player.x - camera.x) * z + w / 2;
    const py = (rt.player.y - camera.y) * z + h / 2;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(7, z * 0.3), 0, Math.PI * 2);
    ctx.fillStyle = '#58c4ff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.stroke();
    // 受击闪白
    if (rt.player.flashT > 0) {
      ctx.globalAlpha = (rt.player.flashT / 120) * 0.8;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(9, z * 0.38), 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 伤害数字
    ctx.font = `bold ${Math.max(12, z * 0.55)}px Consolas, monospace`;
    for (const n of rt.dmgNumbers) {
      const a = Math.max(0, 1 - n.t / 0.8);
      ctx.globalAlpha = a;
      ctx.fillStyle = n.color;
      ctx.fillText(n.text, (n.x - camera.x) * z + w / 2, (n.y - camera.y) * z + h / 2);
    }
    ctx.globalAlpha = 1;
  }

  private drawMonster(
    ctx: CanvasRenderingContext2D,
    rt: GameRuntime,
    m: Monster,
    w: number,
    h: number,
    z: number,
  ): void {
    const mt = MONSTER_TPL.get(m.templateId);
    if (!mt || m.state === 'dead') return;
    const sx = (m.x - rt.player.x) * z + w / 2;
    const sy = (m.y - rt.player.y) * z + h / 2;
    const size = Math.max(7, z * 0.3) * (mt.scale ?? 1);
    ctx.beginPath();
    ctx.moveTo(sx, sy - size);
    ctx.lineTo(sx + size * 0.85, sy + size * 0.7);
    ctx.lineTo(sx - size * 0.85, sy + size * 0.7);
    ctx.closePath();
    ctx.fillStyle = mt.color;
    ctx.fill();
    if (mt.boss) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,77,77,.8)';
      ctx.stroke();
    }
    // 受击闪白
    if (m.flashT > 0) {
      ctx.globalAlpha = (m.flashT / 120) * 0.75;
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // 血条
    const bw = Math.max(22, z * 0.9);
    ctx.fillStyle = '#2a2a33';
    ctx.fillRect(sx - bw / 2, sy - size - 12, bw, 4);
    ctx.fillStyle = mt.elite ? '#ff9a3c' : '#ff5a5a';
    ctx.fillRect(sx - bw / 2, sy - size - 12, bw * Math.max(0, m.hp / m.hpMax), 4);
    // 名称（等级为按距离缩放后的实际值）
    ctx.font = '10px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = mt.boss ? '#ff4d4d' : '#ff8a8a';
    ctx.fillText(`${mt.name} Lv.${m.lvl}`, sx, sy - size - 18);
  }

  private marker(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    wx: number,
    wy: number,
    ch: string,
    color: string,
    size: number,
    label: string,
  ): void {
    const sx = (wx - this.camera.x) * this.camera.zoom + w / 2;
    const sy = (wy - this.camera.y) * this.camera.zoom + h / 2;
    ctx.font = `${size}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(ch, sx, sy);
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#e8e8ec';
    ctx.fillText(label, sx, sy + size * 0.8);
  }

  private diamond(ctx: CanvasRenderingContext2D, sx: number, sy: number, r: number, color: string): void {
    ctx.beginPath();
    ctx.moveTo(sx, sy - r);
    ctx.lineTo(sx + r * 0.75, sy);
    ctx.lineTo(sx, sy + r);
    ctx.lineTo(sx - r * 0.75, sy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** 小地图地形层（每 16 格移动才重绘，由调用方缓存）。 */
  drawMinimapTerrain(mctx: CanvasRenderingContext2D, rt: GameRuntime, wpx: number, hpx: number): void {
    const tpp = 2;
    const halfW = wpx / tpp / 2;
    const halfH = hpx / tpp / 2;
    mctx.clearRect(0, 0, wpx, hpx);
    for (let sy = 0; sy < hpx; sy++) {
      for (let sx = 0; sx < wpx; sx++) {
        const wx = rt.player.x - halfW + (sx + 0.5) / tpp;
        const wy = rt.player.y - halfH + (sy + 0.5) / tpp;
        const t = rt.map.at(wx, wy);
        mctx.fillStyle = `rgb(${t.g},${t.g},${t.g})`;
        mctx.fillRect(sx, sy, 1.05, 1.05);
      }
    }
  }

  /** 小地图覆盖层（玩家/地标/视口框，每帧绘制）。 */
  drawMinimapOverlay(mctx: CanvasRenderingContext2D, rt: GameRuntime, wpx: number, hpx: number): void {
    const tpp = 2;
    // 玩家（窗口中心）
    mctx.fillStyle = '#58c4ff';
    mctx.fillRect(wpx / 2 - 2, hpx / 2 - 2, 4, 4);
    // 地标点
    for (const p of config.factions.pois) {
      const sx = wpx / 2 + (p.x + 0.5 - rt.player.x) * tpp;
      const sy = hpx / 2 + (p.y + 0.5 - rt.player.y) * tpp;
      if (sx < -4 || sy < -4 || sx > wpx + 4 || sy > hpx + 4) continue;
      mctx.fillStyle = p.color;
      mctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
    }
    // 视口框
    mctx.strokeStyle = 'rgba(255,255,255,.35)';
    mctx.strokeRect(
      wpx / 2 - (this.vw / this.camera.zoom / 2) * tpp,
      hpx / 2 - (this.vh / this.camera.zoom / 2) * tpp,
      (this.vw / this.camera.zoom) * tpp,
      (this.vh / this.camera.zoom) * tpp,
    );
  }
}
