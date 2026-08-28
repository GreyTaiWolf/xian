/**
 * 弹层系统：新建世界 / 设置。Esc 或点击遮罩关闭（关闭前触发回调）。
 */
import type { Settings } from '../game/state';
import { el } from './dom';

/** 打开中的弹层栈（Esc 关闭最上层）。 */
const modalStack: Modal[] = [];

export class Modal {
  root: HTMLElement;

  constructor(title: string, bodyHtml: string, footerHtml = '') {
    this.root = el('div', 'modal-bg hidden');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', '', title));
    modal.appendChild(el('div', '', bodyHtml));
    if (footerHtml) modal.appendChild(el('div', 'row', footerHtml));
    this.root.appendChild(modal);
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    document.body.appendChild(this.root);
  }

  open(): void {
    if (!this.root.classList.contains('hidden')) return;
    modalStack.push(this);
    this.root.classList.remove('hidden');
  }

  close(): void {
    this.root.classList.add('hidden');
    const i = modalStack.indexOf(this);
    if (i >= 0) modalStack.splice(i, 1);
  }

  q<T extends HTMLElement = HTMLElement>(sel: string): T | null {
    return this.root.querySelector(sel);
  }
}

// Esc 关闭最上层弹层（输入框聚焦时不触发）
window.addEventListener('keydown', (ev) => {
  if (ev.code !== 'Escape' || modalStack.length === 0) return;
  const target = ev.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
  ev.preventDefault();
  modalStack[modalStack.length - 1].close();
});

/** 新建世界弹层。 */
export function buildNewWorldModal(
  onCreate: (name: string, seed: number, useAi: boolean) => void,
): Modal {
  const m = new Modal(
    '开辟新世界',
    `
    <div class="field">
      <label>世界名</label>
      <input id="worldNameInput" value="沧溟界">
    </div>
    <div class="field">
      <label>世界种子</label>
      <div class="row">
        <input id="seedInput" class="num" value="882345">
        <button class="btn sm" data-act="rand" style="flex:0 0 auto">随机</button>
      </div>
      <div class="sub">同一种子生成完全相同的世界（确定性程序化生成）</div>
    </div>
    <div class="field check">
      <input type="checkbox" id="aiSeed" checked>
      <label>由天道 AI 生成世界种子卡（首次进入时调用）</label>
    </div>
    `,
    `
    <button class="btn" data-act="cancel">取消</button>
    <button class="btn primary" data-act="create">创建世界</button>
    `,
  );
  m.q<HTMLElement>('[data-act="rand"]')!.addEventListener('click', () => {
    m.q<HTMLInputElement>('#seedInput')!.value = String(Math.floor(100000 + Math.random() * 900000));
  });
  m.q<HTMLElement>('[data-act="cancel"]')!.addEventListener('click', () => m.close());
  m.q<HTMLElement>('[data-act="create"]')!.addEventListener('click', () => {
    const name = m.q<HTMLInputElement>('#worldNameInput')!.value.trim() || '沧溟界';
    const seed = parseInt(m.q<HTMLInputElement>('#seedInput')!.value, 10) || 882345;
    const useAi = m.q<HTMLInputElement>('#aiSeed')!.checked;
    m.close();
    onCreate(name, seed, useAi);
  });
  return m;
}

/** 设置弹层。 */
export function buildSettingsModal(opts: {
  getSettings: () => Settings;
  onSave: (s: Settings) => void;
  onTestApi: (s: Settings) => void;
  onExport: () => void;
  onClear: () => void;
}): Modal {
  const m = new Modal(
    '设置',
    `
    <div class="field">
      <label>AI API Key（OpenAI 兼容，如 DeepSeek）</label>
      <input type="password" id="apiKey" placeholder="sk-...">
      <div class="sub">仅保存在本地浏览器，用于调用天道 AI；不填则世界以模板事件运行</div>
    </div>
    <div class="field check">
      <input type="checkbox" id="aiOn" checked>
      <label>启用天道 AI（世界导演 / NPC 对话 / 命名）</label>
    </div>
    <div class="field">
      <label>世界导演频率</label>
      <select id="interval">
        <option value="1">每个世界日</option>
        <option value="3">每 3 个世界日</option>
        <option value="0">关闭（模板事件）</option>
      </select>
    </div>
    <div class="field check">
      <input type="checkbox" id="autoSkills" checked>
      <label>自动施展已解锁技能（仍遵守灵力与冷却）</label>
    </div>
    <div class="field">
      <label>战斗表现速度</label>
      <select id="combatSpeed">
        <option value="1">1× 沉浸</option>
        <option value="2">2× 加速</option>
      </select>
    </div>
    <div class="field"><label>音乐音量</label><input type="range" id="musicVol" min="0" max="100"></div>
    <div class="field"><label>音效音量</label><input type="range" id="sfxVol" min="0" max="100"></div>
    `,
    `
    <button class="btn" data-act="export">导出存档</button>
    <button class="btn" data-act="test">测试 API</button>
    <button class="btn danger" data-act="clear">清除存档</button>
    <button class="btn" data-act="close">关闭</button>
    `,
  );

  const collect = (): Settings => ({
    aiEnabled: m.q<HTMLInputElement>('#aiOn')!.checked,
    apiKey: m.q<HTMLInputElement>('#apiKey')!.value.trim(),
    directorIntervalDays: parseInt(m.q<HTMLSelectElement>('#interval')!.value, 10) || 1,
    musicVolume: parseInt(m.q<HTMLInputElement>('#musicVol')!.value, 10),
    sfxVolume: parseInt(m.q<HTMLInputElement>('#sfxVol')!.value, 10),
    autoSkills: m.q<HTMLInputElement>('#autoSkills')!.checked,
    combatSpeed: m.q<HTMLSelectElement>('#combatSpeed')!.value === '2' ? 2 : 1,
  });

  const originalOpen = m.open.bind(m);
  m.open = () => {
    const s = opts.getSettings();
    m.q<HTMLInputElement>('#apiKey')!.value = s.apiKey;
    m.q<HTMLInputElement>('#aiOn')!.checked = s.aiEnabled;
    m.q<HTMLSelectElement>('#interval')!.value = String(s.directorIntervalDays);
    m.q<HTMLInputElement>('#musicVol')!.value = String(s.musicVolume);
    m.q<HTMLInputElement>('#sfxVol')!.value = String(s.sfxVolume);
    m.q<HTMLInputElement>('#autoSkills')!.checked = s.autoSkills;
    m.q<HTMLSelectElement>('#combatSpeed')!.value = String(s.combatSpeed);
    originalOpen();
  };

  m.q<HTMLElement>('[data-act="close"]')!.addEventListener('click', () => {
    opts.onSave(collect());
    m.close();
  });
  m.q<HTMLElement>('[data-act="export"]')!.addEventListener('click', opts.onExport);
  m.q<HTMLElement>('[data-act="test"]')!.addEventListener('click', () => opts.onTestApi(collect()));
  m.q<HTMLElement>('[data-act="clear"]')!.addEventListener('click', () => {
    opts.onClear();
    m.close();
  });
  return m;
}
