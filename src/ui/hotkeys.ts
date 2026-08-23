/**
 * 全局快捷键（按 e.code 匹配）；输入框聚焦时忽略。返回解绑函数。
 */
export function bindHotkeys(map: Record<string, () => void>): () => void {
  const handler = (ev: KeyboardEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
      return;
    }
    const fn = map[ev.code];
    if (fn) {
      ev.preventDefault();
      fn();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
