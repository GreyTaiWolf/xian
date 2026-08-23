/**
 * 单一状态树容器 —— 所有可存档数据都在这里；变更即通知订阅者。
 */

export type Updater<S> = (state: S) => S;

export class Store<S> {
  private state: S;
  private listeners = new Set<(s: S) => void>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): S {
    return this.state;
  }

  set(updater: Updater<S>): void {
    this.state = updater(this.state);
    this.listeners.forEach((fn) => fn(this.state));
  }

  patch(patch: Partial<S>): void {
    this.set((s) => ({ ...s, ...patch }));
  }

  /** 订阅状态变化，返回取消订阅函数。 */
  subscribe(fn: (s: S) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
