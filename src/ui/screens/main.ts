/**
 * 主游戏界面外壳：顶栏 / 角色卡 / 地图视口 / 日志操作条 / 右侧面板区。
 * 输入（WASD/点击/空格）→ 运行时；渲染每帧驱动；HUD 由运行时 4Hz 事件刷新。
 */
import type { Store } from '../../core/store';
import type { GameState } from '../../game/state';
import { bus, type LogCls } from '../../core/eventbus';
import { config } from '../../core/config';
import { el } from '../dom';
import { PanelManager } from '../panel';
import { bindHotkeys } from '../hotkeys';
import { Renderer } from '../../render/renderer';
import type { GameRuntime, HudData } from '../../systems/runtime';
import { panelBuilders, type PanelCtx } from '../panels';
import { derivedStats, realmOf, xpNeed } from '../../game/stats';

export interface MainCallbacks {
  onSettings(): void;
}

export interface MainShell {
  root: HTMLElement;
  render(): void;
  dispose(): void;
}

export function buildMainShell(store: Store<GameState>, rt: GameRuntime, cb: MainCallbacks): MainShell {
  const s = store.get();

  const root = el('div');
  root.id = 'game';
  root.innerHTML = `
    <div id="topbar">
      <span class="world" id="worldNameTop"></span>
      <span class="day">第 <span class="num" id="dayTop"></span> 日 · 晴</span>
      <span class="ai-chip" id="aiChip"><i></i>天道 AI <span id="aiState"></span></span>
      <span class="ai-chip aura" id="auraChip" style="display:none"><i></i><span id="auraText"></span></span>
      <span class="spacer"></span>
      <span class="goldc num" id="hudMoney"></span><span class="goldc" style="font-size:12px">灵石</span>
      <span style="color:var(--tx2);font-size:12px">境界</span><span class="goldc" id="hudRealmTop" style="font-size:12px"></span>
      <button class="btn sm" data-act="settings">设置</button>
    </div>
    <div id="mid">
      <div id="sideL">${charCard(s)}</div>
      <div id="center">
        <div id="view">
          <canvas id="terrainCanvas"></canvas>
          <div id="hint">WASD / 点击移动 · 空格 = 御剑术 · 靠近掉落自动拾取</div>
          <div id="minimap">
            <div class="title">小地图</div>
            <canvas id="mmCanvas" width="120" height="90"></canvas>
          </div>
        </div>
        <div id="bottom">
          <div id="log"></div>
          <div id="actions">
            <button class="btn primary" data-act="skill">御剑术</button>
            <button class="btn" data-act="pickup">拾取</button>
            <button class="btn" data-act="town">回城</button>
            <button class="btn" data-act="realm">秘境</button>
            <div class="hint-line">空格 = 御剑术</div>
          </div>
        </div>
      </div>
      <div id="sideR">
        <div id="tabbar"></div>
        <div id="panels"></div>
      </div>
    </div>`;

  // ---- 日志 ----
  const logEl = root.querySelector<HTMLElement>('#log')!;
  const log = (cls: LogCls, text: string): void => {
    const div = el('div', 'log-line ' + cls, text);
    logEl.appendChild(div);
    while (logEl.children.length > 40) logEl.removeChild(logEl.firstChild as HTMLElement);
    logEl.scrollTop = logEl.scrollHeight;
  };
  const offLog = bus.on('log', (e) => log(e.cls, e.text));

  // ---- 面板 ----
  const pm = new PanelManager(
    root.querySelector<HTMLElement>('#tabbar')!,
    root.querySelector<HTMLElement>('#panels')!,
  );
  const ctx: PanelCtx = { store, rt, log };
  config.ui.panels.forEach(({ id, label }) => {
    const builder = panelBuilders[id];
    if (!builder) return;
    pm.register({ id, label, element: builder(ctx).element });
  });
  pm.show(config.ui.panels[0]?.id ?? 'inv');

  // ---- 状态同步 ----
  const syncWorld = (st: GameState): void => {
    root.querySelector<HTMLElement>('#worldNameTop')!.textContent = st.world.name;
    root.querySelector<HTMLElement>('#dayTop')!.textContent = String(st.world.day);
    const chip = root.querySelector<HTMLElement>('#aiChip')!;
    chip.classList.toggle('off', !st.settings.aiEnabled);
    root.querySelector<HTMLElement>('#aiState')!.textContent = st.settings.aiEnabled ? '在线' : '离线';
  };
  const syncMoney = (money: number): void => {
    root.querySelectorAll('[data-bind="money"]').forEach((n) => {
      n.textContent = String(money);
    });
  };
  syncWorld(s);
  syncMoney(s.player.money);
  const offWorld = store.subscribe(syncWorld);
  const offMoney = store.subscribe((st) => syncMoney(st.player.money));

  // ---- HUD（4Hz 热数据） ----
  const applyHud = (d: HudData): void => {
    const set = (id: string, v: string): void => {
      const n = root.querySelector<HTMLElement>('#' + id);
      if (n) n.textContent = v;
    };
    const bar = (id: string, pct: number): void => {
      const n = root.querySelector<HTMLElement>('#' + id);
      if (n) n.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    };
    set('hudMoney', String(d.money));
    set('hudRealmTop', d.realm);
    set('hudLvl', String(d.level));
    set('hudRealm', `散修 · ${d.realm}`);
    set('hudHpV', String(d.hp));
    set('hudMpV', String(d.mp));
    set('hudXpV', `${d.xp}/${d.xpMax}`);
    set('hudAtk', String(d.atk));
    set('hudDef', String(d.def));
    set('hudSpd', String(d.spd));
    set('hudCrit', `${d.crit}%`);
    set('hudLuck', String(d.luck));
    set('hudPower', String(d.atk + d.def * 2 + Math.round(d.hpMax / 10)));
    bar('hudHp', (d.hp / d.hpMax) * 100);
    bar('hudMp', (d.mp / d.mpMax) * 100);
    bar('hudXp', (d.xp / d.xpMax) * 100);
    const sb = root.querySelector<HTMLElement>('[data-act="skill"]');
    if (sb) {
      sb.textContent = d.skillCd > 0 ? `${d.skillName} ${d.skillCd.toFixed(1)}s` : d.skillName;
      sb.classList.toggle('off', d.skillCd > 0);
    }
    const ac = root.querySelector<HTMLElement>('#auraChip');
    if (ac) {
      if (d.auraLabel) {
        ac.style.display = '';
        root.querySelector<HTMLElement>('#auraText')!.textContent = d.auraLabel;
      } else {
        ac.style.display = 'none';
      }
    }
    const rb = root.querySelector<HTMLElement>('[data-act="realm"]');
    if (rb) rb.classList.toggle('off', !d.realmReady);
  };
  const offHud = bus.on('hud', applyHud);

  // ---- 渲染 ----
  const canvas = root.querySelector<HTMLCanvasElement>('#terrainCanvas')!;
  const renderer = new Renderer(canvas, canvas.getContext('2d')!);
  const view = root.querySelector<HTMLElement>('#view')!;
  const mmCtx = root.querySelector<HTMLCanvasElement>('#mmCanvas')!.getContext('2d')!;
  const render = (): void => {
    const r = view.getBoundingClientRect();
    renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
    renderer.drawWorld(rt);
    // 小地图：地形层每 16 格缓存，覆盖层每帧
    const mmKey = `${Math.floor(rt.player.x / 16)},${Math.floor(rt.player.y / 16)}`;
    if (mmKey !== lastMmKey) {
      lastMmKey = mmKey;
      renderer.drawMinimapTerrain(mmCtx, rt, 120, 90);
    }
    renderer.drawMinimapOverlay(mmCtx, rt, 120, 90);
    updateLocStrip();
  };

  let lastMmKey = '';

  // ---- 地点行动列表（走近城镇/宗门/秘境时出现） ----
  const locStrip = el('div');
  locStrip.id = 'locstrip';
  locStrip.classList.add('hidden');
  view.appendChild(locStrip);
  let locKey = '';
  const updateLocStrip = (): void => {
    const pois = rt.nearPois();
    const key = pois.map((p) => `${p.kind}:${p.name}`).join('|');
    if (key === locKey) return;
    locKey = key;
    if (pois.length === 0) {
      locStrip.classList.add('hidden');
      locStrip.innerHTML = '';
      return;
    }
    locStrip.classList.remove('hidden');
    const acts: Record<string, { label: string; act: string; panel?: string }[]> = {
      town: [
        { label: '商店', act: 'panel', panel: 'shop' },
        { label: '任务', act: 'panel', panel: 'quest' },
        { label: '编年史', act: 'panel', panel: 'chron' },
        { label: '打坐', act: 'rest' },
      ],
      sect: [{ label: '宗门', act: 'panel', panel: 'sect' }],
      realm: [{ label: '进入秘境', act: 'realm' }],
    };
    let html = `<span class="loc-name">${pois[0].name}</span>`;
    for (const p of pois) {
      for (const a of acts[p.kind] ?? []) {
        html += `<button class="btn sm loc-act" data-act="${a.act}" data-panel="${a.panel ?? ''}">${a.label}</button>`;
      }
    }
    locStrip.innerHTML = html;
    locStrip.querySelectorAll<HTMLElement>('[data-act="panel"]').forEach((b) => {
      b.addEventListener('click', () => pm.show(b.dataset.panel ?? 'inv'));
    });
    locStrip.querySelector<HTMLElement>('[data-act="rest"]')?.addEventListener('click', () => rt.restAtTown());
    locStrip.querySelector<HTMLElement>('[data-act="realm"]')?.addEventListener('click', () => rt.enterRealm());
  };
  render();

  // ---- 新手引导（首次进入） ----
  if (!store.get().player.tutorialDone) {
    const tut = el('div');
    tut.className = 'tutorial';
    tut.innerHTML = `
      <div class="tut-card">
        <h3>沧溟修行录</h3>
        <div class="tut-steps">
          <p><b>移动</b>：WASD 或点击地面行走，越远离出生点妖兽越强</p>
          <p><b>战斗</b>：靠近自动攻击，空格施展【御剑术】</p>
          <p><b>拾取</b>：走过掉落物自动拾取，光柱越亮品级越高</p>
          <p><b>面板</b>：B 背包 · E 装备 · C 角色 · M 地图 · J 编年史 · T 任务</p>
          <p><b>城镇</b>：走到霜落城门口会出现行动条（商店/任务/打坐）</p>
          <p><b>天道</b>：每 5 分钟一个世界日，天道 AI 将导演世界事件</p>
        </div>
        <button class="btn primary" style="width:100%">开始修行</button>
      </div>`;
    tut.querySelector<HTMLElement>('button')!.addEventListener('click', () => {
      store.set((st) => ({ ...st, player: { ...st.player, tutorialDone: true } }));
      tut.remove();
    });
    view.appendChild(tut);
  }

  // ---- 输入 ----
  const keys = new Set<string>();
  const isTyping = (t: EventTarget | null): boolean => {
    const target = t as HTMLElement | null;
    return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  };
  const updateMoveDir = (): void => {
    let x = 0;
    let y = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    if (x !== 0 && y !== 0) {
      x *= 0.7071;
      y *= 0.7071;
    }
    rt.moveDir = { x, y };
    if (x !== 0 || y !== 0) rt.moveTarget = null;
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    keys.add(e.code);
    updateMoveDir();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code);
    updateMoveDir();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  canvas.addEventListener('mousedown', (e) => {
    const r = view.getBoundingClientRect();
    const [wx, wy] = renderer.camera.screenToWorld(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    rt.moveTarget = { x: wx, y: wy };
    rt.moveDir = { x: 0, y: 0 };
  });

  // ---- 操作 ----
  root.querySelector<HTMLElement>('[data-act="settings"]')!.addEventListener('click', cb.onSettings);
  root.querySelector<HTMLElement>('[data-act="skill"]')!.addEventListener('click', () => rt.castSkill());
  root.querySelector<HTMLElement>('[data-act="pickup"]')!.addEventListener('click', () => rt.pickupNearby(1.5));
  root.querySelector<HTMLElement>('[data-act="town"]')!.addEventListener('click', () => rt.returnToTown());
  root.querySelector<HTMLElement>('[data-act="realm"]')!.addEventListener('click', () => rt.enterRealm());

  const unbind = bindHotkeys({
    KeyB: () => pm.show('inv'),
    KeyC: () => pm.show('char'),
    KeyE: () => pm.show('equip'),
    KeyM: () => pm.show('map'),
    KeyG: () => pm.show('sect'),
    KeyT: () => pm.show('quest'),
    KeyJ: () => pm.show('chron'),
    Space: () => rt.castSkill(),
  });

  return {
    root,
    render,
    dispose: () => {
      unbind();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      offLog();
      offHud();
      offWorld();
      offMoney();
    },
  };
}

/** 左侧角色卡（骨架；数值由 HUD 事件高频更新）。 */
function charCard(s: GameState): string {
  const st = derivedStats(s);
  return `
    <div class="avatar"><div class="lvl" id="hudLvl">${s.player.level}</div></div>
    <div class="pname">${s.player.name}</div>
    <div class="ptitle" id="hudRealm">散修 · ${realmOf(s.player.level)}</div>
    <div class="stat-line"><span class="tag">生命</span><div class="bar"><i id="hudHp" style="width:100%;background:var(--bad)"></i></div><span class="val num"><span id="hudHpV">${s.player.hp}</span>/${st.hpMax}</span></div>
    <div class="stat-line"><span class="tag">灵力</span><div class="bar"><i id="hudMp" style="width:100%;background:#58a6ff"></i></div><span class="val num"><span id="hudMpV">${s.player.mp}</span>/${st.mpMax}</span></div>
    <div class="stat-line"><span class="tag">修为</span><div class="bar"><i id="hudXp" style="width:0%;background:var(--gold)"></i></div><span class="val num" id="hudXpV">${s.player.xp}/${xpNeed(s.player.level)}</span></div>
    <div class="stat-line"><span class="tag">攻击</span><span class="spacer"></span><span class="num" id="hudAtk">${st.atk}</span><span style="width:34px"></span></div>
    <div class="stat-line"><span class="tag">防御</span><span class="spacer"></span><span class="num" id="hudDef">${st.def}</span><span style="width:34px"></span></div>
    <div class="stat-line"><span class="tag">速度</span><span class="spacer"></span><span class="num" id="hudSpd">${st.spd}</span><span style="width:34px"></span></div>
    <div class="stat-line"><span class="tag">暴击</span><span class="spacer"></span><span class="num" id="hudCrit">${st.crit}%</span><span style="width:34px"></span></div>
    <div class="stat-line"><span class="tag">幸运</span><span class="spacer"></span><span class="num" id="hudLuck">${st.luck}</span><span style="width:34px"></span></div>
    <div class="power">战力 <b class="goldc" id="hudPower">${st.atk + st.def * 2 + Math.round(st.hpMax / 10)}</b></div>`;
}
