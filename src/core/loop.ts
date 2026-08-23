/**
 * 主循环：固定时间步 update（毫秒） + 每帧 render（可选）。
 * P0 阶段渲染由事件驱动；M0 起玩法逐帧更新，M1 起逐帧渲染。
 */

export interface LoopCallbacks {
  update(dtMs: number): void;
  render?(): void;
}

export function startLoop(cb: LoopCallbacks): () => void {
  let last = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    const dt = now - last;
    last = now;
    cb.update(dt);
    cb.render?.();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
