import { el } from '../dom';

/** 标题界面：新建世界 / 继续游戏 / 设置。 */
export function buildStartScreen(opts: {
  onNew(): void;
  onContinue(): void;
  onSettings(): void;
}): HTMLElement {
  const root = el('div');
  root.id = 'start';
  root.innerHTML = `
    <div class="shapes">
      <div class="sq" style="left:12%;top:20%"></div>
      <div class="cir" style="left:84%;top:16%;width:30px;height:30px"></div>
      <div class="tri" style="left:78%;top:74%"></div>
      <div class="sq" style="left:88%;top:62%;transform:rotate(45deg)"></div>
      <div class="cir" style="left:16%;top:70%;width:16px;height:16px"></div>
      <div class="tri" style="left:26%;top:12%;transform:rotate(160deg)"></div>
      <div class="sq" style="left:60%;top:86%;width:14px;height:14px"></div>
      <div class="cir" style="left:8%;top:42%;width:22px;height:22px"></div>
    </div>
    <div class="card">
      <h1><span class="geom">▣</span> 仙</h1>
      <div class="sub">AI 天道导演 · 灰度几何世界 · 刷宝修真</div>
      <div class="btns">
        <button class="btn primary" data-act="new">新建世界</button>
        <button class="btn" data-act="continue">继续游戏</button>
        <button class="btn" data-act="settings">设置</button>
      </div>
    </div>
    <div class="ver">P0 框架 · 单机网页版 · v0.1.0</div>
  `;
  root.querySelector<HTMLElement>('[data-act="new"]')!.addEventListener('click', opts.onNew);
  root.querySelector<HTMLElement>('[data-act="continue"]')!.addEventListener('click', opts.onContinue);
  root.querySelector<HTMLElement>('[data-act="settings"]')!.addEventListener('click', opts.onSettings);
  return root;
}
