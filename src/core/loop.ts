/**
 * 主循环：固定时间步 update（毫秒） + 每帧 render（可选）。
 * P0 阶段渲染由事件驱动；M0 起玩法逐帧更新，M1 起逐帧渲染。
 */

export interface LoopCallbacks {
  update(dtMs: number): void;
  render?(): void;
}

export interface LoopOptions {
  stepMs?: number;
  maxFrameMs?: number;
  maxStepsPerFrame?: number;
}

/**
 * 固定步长主循环。长帧最多补有限次数，页面隐藏时暂停并清空积压，
 * 防止返回页面的一帧内把整段战斗与所有动画直接结算完。
 */
export function startLoop(cb: LoopCallbacks, options: LoopOptions = {}): () => void {
  const stepMs = Math.max(1, options.stepMs ?? 1000 / 60);
  const maxFrameMs = Math.max(stepMs, options.maxFrameMs ?? 250);
  const maxSteps = Math.max(1, Math.floor(options.maxStepsPerFrame ?? 8));
  let last = performance.now();
  let accumulator = 0;
  let raf = 0;
  const frame = (now: number) => {
    const frameMs = Math.min(maxFrameMs, Math.max(0, now - last));
    last = now;
    accumulator += frameMs;
    let steps = 0;
    while (accumulator >= stepMs && steps < maxSteps) {
      cb.update(stepMs);
      accumulator -= stepMs;
      steps += 1;
    }
    if (steps >= maxSteps && accumulator >= stepMs) accumulator %= stepMs;
    cb.render?.();
    raf = requestAnimationFrame(frame);
  };
  const resetClock = (): void => {
    last = performance.now();
    accumulator = 0;
  };
  document.addEventListener('visibilitychange', resetClock);
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', resetClock);
  };
}
