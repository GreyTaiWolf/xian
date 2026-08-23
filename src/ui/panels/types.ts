import type { Store } from '../../core/store';
import type { GameState } from '../../game/state';
import type { LogCls } from '../../core/eventbus';
import type { GameRuntime } from '../../systems/runtime';

/** 面板构建上下文：面板只通过它访问框架与运行时，不触碰全局。 */
export interface PanelCtx {
  store: Store<GameState>;
  rt: GameRuntime;
  log(cls: LogCls, text: string): void;
}

export interface BuiltPanel {
  id: string;
  element: HTMLElement;
}
