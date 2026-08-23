/**
 * 视口摄像机：世界坐标（tile）↔ 屏幕坐标。M1 世界地图使用，P0 先建立坐标系。
 */
export class Camera {
  /** 视口中心的世界坐标（tile） */
  x = 0;
  y = 0;
  /** 缩放：1 tile = zoom 像素 */
  zoom = 24;

  worldToScreen(wx: number, wy: number, viewW: number, viewH: number): [number, number] {
    return [(wx - this.x) * this.zoom + viewW / 2, (wy - this.y) * this.zoom + viewH / 2];
  }

  screenToWorld(sx: number, sy: number, viewW: number, viewH: number): [number, number] {
    return [(sx - viewW / 2) / this.zoom + this.x, (sy - viewH / 2) / this.zoom + this.y];
  }
}
