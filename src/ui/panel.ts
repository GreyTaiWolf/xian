/**
 * 面板管理器：右侧标签页区的注册与切换。
 */
import { el } from './dom';

export interface PanelDef {
  id: string;
  label: string;
  element: HTMLElement;
}

export class PanelManager {
  private tabEls = new Map<string, HTMLElement>();
  private panelEls = new Map<string, HTMLElement>();
  private current = '';

  constructor(
    private tabbar: HTMLElement,
    private container: HTMLElement,
    private onChange?: (id: string) => void,
  ) {}

  register(def: PanelDef): void {
    const tab = el('button', 'tab', def.label);
    tab.addEventListener('click', () => this.show(def.id));
    def.element.classList.add('panel', 'hidden');
    this.tabbar.appendChild(tab);
    this.container.appendChild(def.element);
    this.tabEls.set(def.id, tab);
    this.panelEls.set(def.id, def.element);
  }

  show(id: string): void {
    if (id === this.current) return;
    this.tabEls.forEach((t, tid) => t.classList.toggle('on', tid === id));
    this.panelEls.forEach((p, pid) => p.classList.toggle('hidden', pid !== id));
    this.current = id;
    this.onChange?.(id);
  }
}
