/**
 * 世界地图：chunk 化无限世界。
 * 每个 chunk 由「大陆掩膜 → 高度 → 湿度 → 河流 → 生物群系 → 灰度」管线确定性生成；
 * 惰性生成 + LRU 缓存；同 seed 同坐标永远同 tile。
 */
import { config } from '../core/config';
import { hash2 } from '../core/rng';
import { fbm } from './noise';
import { SPAWN_POS } from '../game/state';

export interface MapTile {
  walkable: boolean;
  /** 灰度值（高度/地貌） */
  g: number;
  /** 生物群系装饰字符 */
  ch: string;
  biome: string;
}

export type Chunk = MapTile[];

export const CHUNK_SIZE = config.terrain.chunkSize;
const MAX_CACHED = 96;

export class World {
  private chunks = new Map<string, Chunk>();

  constructor(readonly seed: number) {}

  getChunkCached(cx: number, cy: number): Chunk | null {
    return this.chunks.get(this.chunkKey(cx, cy)) ?? null;
  }

  getChunk(cx: number, cy: number): Chunk {
    const key = this.chunkKey(cx, cy);
    const cached = this.chunks.get(key);
    if (cached) return cached;
    const chunk = this.generateChunk(cx, cy);
    this.chunks.set(key, chunk);
    if (this.chunks.size > MAX_CACHED) {
      const oldest = this.chunks.keys().next().value;
      if (oldest !== undefined) this.chunks.delete(oldest);
    }
    return chunk;
  }

  /** 任意坐标取 tile（跨 chunk，含负坐标）。 */
  at(x: number, y: number): MapTile {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const tx = Math.floor(x) - cx * CHUNK_SIZE;
    const ty = Math.floor(y) - cy * CHUNK_SIZE;
    return this.getChunk(cx, cy)[ty * CHUNK_SIZE + tx];
  }

  isWalkable(x: number, y: number): boolean {
    return this.at(x, y).walkable;
  }

  visitedChunks(): { cx: number; cy: number }[] {
    return [...this.chunks.keys()].map((k) => {
      const [a, b] = k.split(',');
      return { cx: parseInt(a, 10), cy: parseInt(b, 10) };
    });
  }

  private chunkKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private generateChunk(cx: number, cy: number): Chunk {
    const t = config.terrain;
    const tiles: MapTile[] = new Array<MapTile>(CHUNK_SIZE * CHUNK_SIZE);
    for (let ty = 0; ty < CHUNK_SIZE; ty++) {
      for (let tx = 0; tx < CHUNK_SIZE; tx++) {
        const wx = cx * CHUNK_SIZE + tx;
        const wy = cy * CHUNK_SIZE + ty;
        // 大陆掩膜：以世界原点为大陆中心（任何种子出生点都在大陆上），
        // 140 格外恢复纯噪声判定，形成"中央大陆 + 外海"结构。
        const dist = Math.hypot(wx, wy);
        const boost = 0.3 * Math.max(0, 1 - dist / 140);
        const land =
          fbm(wx * t.continent.scale, wy * t.continent.scale, this.seed, t.continent.octaves) +
            boost >
          t.continent.threshold;
        const h = fbm(wx * t.height.scale, wy * t.height.scale, this.seed + 11, t.height.octaves);
        const moisture = fbm(
          wx * t.moisture.scale,
          wy * t.moisture.scale,
          this.seed + 23,
          t.moisture.octaves,
        );
        // 河流：山脊噪声（ridge noise）在接近 0.5 处形成蜿蜒带状
        const ridge =
          1 - Math.abs(2 * fbm(wx * t.river.scale, wy * t.river.scale, this.seed + 37, t.river.octaves) - 1);
        let biomeId: string;
        if (!land) biomeId = h < 0.3 ? 'deep_water' : 'shallow_water';
        else if (ridge > t.river.threshold && h < t.grassMaxH) biomeId = 'river';
        else if (h < t.sandMaxH) biomeId = 'sand';
        else if (h < t.grassMaxH) biomeId = moisture > t.forestMinMoisture ? 'forest' : 'grass';
        else if (h < t.mountainMaxH) biomeId = 'mountain';
        else biomeId = 'snow';
        const b = this.biome(biomeId);
        const g = Math.round(b.gMin + hash2(wx * 7, wy * 9, this.seed + 51) * (b.gMax - b.gMin));
        tiles[ty * CHUNK_SIZE + tx] = { walkable: b.walkable, g, ch: b.ch, biome: biomeId };
      }
    }
    // 雕刻安全区与地标
    this.carve(tiles, cx, cy, SPAWN_POS.x, SPAWN_POS.y, 4);
    for (const p of config.factions.pois) {
      this.carve(tiles, cx, cy, p.x, p.y, p.carve);
    }
    return tiles;
  }

  private biome(id: string): (typeof config.biomes.biomes)[number] {
    return config.biomes.biomes.find((b) => b.id === id) ?? config.biomes.biomes[4];
  }

  /** 在 chunk 内雕刻一块 walkable 草地（若地标落在此 chunk）。 */
  private carve(tiles: Chunk, cx: number, cy: number, px: number, py: number, r: number): void {
    const x0 = Math.max(0, Math.floor(px - r) - cx * CHUNK_SIZE);
    const y0 = Math.max(0, Math.floor(py - r) - cy * CHUNK_SIZE);
    const x1 = Math.min(CHUNK_SIZE - 1, Math.ceil(px + r) - cx * CHUNK_SIZE);
    const y1 = Math.min(CHUNK_SIZE - 1, Math.ceil(py + r) - cy * CHUNK_SIZE);
    if (x1 < 0 || y1 < 0 || x0 >= CHUNK_SIZE || y0 >= CHUNK_SIZE) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x + cx * CHUNK_SIZE + 0.5 - px, y + cy * CHUNK_SIZE + 0.5 - py) <= r) {
          tiles[y * CHUNK_SIZE + x] = { walkable: true, g: 118, ch: '', biome: 'grass' };
        }
      }
    }
  }
}
