/**
 * 仙 —— 程序入口。
 * 装配：状态/存档/主循环/世界时钟/游戏运行时/弹层/屏幕切换。
 */
import './ui/theme.css';

import { bus } from './core/eventbus';
import { config } from './core/config';
import { startLoop } from './core/loop';
import { Store } from './core/store';
import { clearSave, exportSave, lastSavedAt, loadFromLocal, saveToLocal } from './core/save';
import { createWorldSimulation, defaultState, type ChronicleEntry, type GameState } from './game/state';
import { levelUp } from './game/stats';
import { WorldClock } from './world/clock';
import { GameRuntime } from './systems/runtime';
import { sfx } from './audio/sfx';
import { Director } from './ai/director';
import { generateSeedCard } from './ai/seedcard';
import { chat } from './ai/client';
import { buildNewWorldModal, buildSettingsModal } from './ui/modals';
import { buildMainShell, type MainShell } from './ui/screens/main';
import { buildStartScreen } from './ui/screens/start';
import { pickOfflineTemplateIndices, planOfflineCatchUp, synchronizeSimulationToWorldDay } from './simulation';

const app = document.getElementById('app')!;

// 状态容器：优先读档（v1 存档自动迁移）
const store = new Store<GameState>(loadFromLocal() ?? defaultState());

// 自动存档（事件性写入，量级小无需防抖）
store.subscribe((s) => saveToLocal(s));

// 音效音量跟随设置
sfx.setVolume(store.get().settings.sfxVolume);
store.subscribe((s) => sfx.setVolume(s.settings.sfxVolume));

// 主循环 + 世界时钟（世界日边界 = 天道 AI 的节拍，M2 接入导演）
const clock = new WorldClock();
clock.day = store.get().world.day;

let rt: GameRuntime | null = null;
let shell: MainShell | null = null;

startLoop({
  update: (dt) => {
    if (clock.tick(dt)) bus.emit('dayBoundary', { day: clock.day });
    rt?.update(dt);
  },
  render: () => shell?.render(),
});

// 天道世界导演：世界日边界 → AI 决策 → 执行 → 编年史（可降级模板）
const director = new Director(store, () => rt, (cls, text) => bus.emit('log', { cls, text }));

bus.on('dayBoundary', ({ day }) => {
  store.set((st) => ({
    ...st,
    world: { ...st.world, day },
    simulation: synchronizeSimulationToWorldDay(st.simulation, st.world.seed, day),
  }));
  director.runDay(day);
});

// 关页面前把热数据落盘
window.addEventListener('beforeunload', () => {
  rt?.sync();
  saveToLocal(store.get());
});

// 弹层
const settingsModal = buildSettingsModal({
  getSettings: () => store.get().settings,
  onSave: (settings) => store.set((s) => ({ ...s, settings })),
  onTestApi: (settings) => {
    void (async () => {
      bus.emit('log', { cls: 'sys', text: '[系统] 正在测试 API 连通……' });
      try {
        await chat(settings.apiKey, [{ role: 'system', content: '只回复两个字：正常' }], {
          maxTokens: 10,
          retries: 0,
        });
        bus.emit('log', { cls: 'sys', text: `[系统] API 连通正常（${config.ai.model}）。天道已就绪。` });
      } catch (e) {
        bus.emit('log', {
          cls: 'badl',
          text: `[系统] API 测试失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
  },
  onExport: () => exportSave(store.get()),
  onClear: () => {
    clearSave();
    bus.emit('log', { cls: 'badl', text: '[系统] 本地存档已清除。' });
  },
});

// 主界面外壳（随进入世界重建）
function buildShell(): void {
  startRoot.remove();
  shell?.dispose();
  rt = new GameRuntime(store, (cls, text) => bus.emit('log', { cls, text }), (name) => sfx.play(name));
  shell = buildMainShell(store, rt, { onSettings: () => settingsModal.open() });
  app.appendChild(shell.root);
}

/**
 * 离线快进：先更新存档状态，再构建运行时，避免内存角色与 Store 不一致。
 * 不调用 AI；模板选择、世界模拟和奖励天数都可复现且有硬上限。
 */
function catchUpOffline(): string | null {
  const savedAt = lastSavedAt();
  if (savedAt === null) return null;
  const dayMs = config.ui.dayLengthMinutes * 60 * 1000;
  const plan = planOfflineCatchUp(savedAt, Date.now(), dayMs);
  const days = plan.appliedDays;
  if (days < 1) return null;

  const before = store.get();
  const startWorldDay = before.world.day;
  const xpGain = days * (20 + before.player.level * 8);
  const moneyGain = days * 10;
  const templates = config.eventsTemplates.templates;
  const templateIndices = pickOfflineTemplateIndices(
    before.world.seed,
    startWorldDay + 1,
    days,
    templates.length,
  );
  const entries: ChronicleEntry[] = [];
  templateIndices.forEach((templateIndex, index) => {
    const template = templates[templateIndex];
    if (!template) return;
    entries.push({
      day: startWorldDay + 1 + index,
      text: template.text,
      major: template.type === 'beast_tide',
    });
  });

  store.set((st) => {
    const nextWorldDay = st.world.day + days;
    return {
      ...st,
      player: {
        ...levelUp({ ...st.player, xp: st.player.xp + xpGain }, () => {}),
        money: st.player.money + moneyGain,
      },
      world: {
        ...st.world,
        day: nextWorldDay,
        chronicle: [...st.world.chronicle, ...entries].slice(-60),
      },
      simulation: synchronizeSimulationToWorldDay(st.simulation, st.world.seed, nextWorldDay),
    };
  });
  clock.day = store.get().world.day;

  const capNotice = plan.capped
    ? `；离线共折算 ${plan.rawDays} 日，超过安全上限的部分不再结算`
    : '';
  return `[闭关] 你闭关 <b class="num">${days}</b> 日：修为 <b class="num">+${xpGain}</b>，灵石 <b class="num">+${moneyGain}</b>（编年史与世界模拟已更新${capNotice}）。`;
}

function createWorld(name: string, seed: number, useAi: boolean): void {
  store.set((s) => ({
    ...s,
    world: {
      seed,
      name,
      day: 1,
      createdAt: Date.now(),
      visited: [],
      chronicle: [{ day: 1, text: `${name}初开，天道伊始。`, major: false }],
      faction: { tension: 50, sectPower: 60, demonPower: 40 },
      bossDefeated: false,
      pendingTravelEvent: null,
      travelEventHistory: [],
      eventFlags: {},
      eventCooldowns: {},
      realmEntered: false,
    },
    simulation: createWorldSimulation(seed, 1),
  }));
  clock.day = 1;
  buildShell();
  bus.emit('worldCreated', { seed, name });
  bus.emit('log', {
    cls: 'sys',
    text: `[系统] 你踏入<b>${name}</b>（种子 <span class="num">${seed}</span>）。天道注视着这片大地。`,
  });
  bus.emit('log', {
    cls: 'gold',
    text: '[提示] WASD/点击移动，空格施展御剑术；靠近掉落物自动拾取；B 背包 · E 装备 · J 编年史 · T 任务。',
  });
  // 天道种子卡：AI 为世界命名并书写开篇（失败静默降级）
  const apiKey = store.get().settings.apiKey;
  if (useAi && apiKey) {
    void generateSeedCard(apiKey, seed)
      .then((card) => {
        if (card.name) {
          store.set((st) => ({ ...st, world: { ...st.world, name: card.name } }));
        }
        if (card.backstory) {
          store.set((st) => ({
            ...st,
            world: {
              ...st.world,
              chronicle: [...st.world.chronicle, { day: 1, text: card.backstory, major: true }],
            },
          }));
          bus.emit('log', { cls: 'sys', text: `[天道] ${card.backstory}` });
        }
        bus.emit('log', {
          cls: 'gold',
          text: card.name ? `[天道] 此界名为「${card.name}」。` : '[天道] 此界已开辟。',
        });
      })
      .catch((e: unknown) => {
        bus.emit('log', {
          cls: 'badl',
          text: `[天道] 种子卡生成失败（${e instanceof Error ? e.message : String(e)}），沿用默认。`,
        });
      });
  }
}

function continueGame(): void {
  const offlineMessage = catchUpOffline();
  buildShell();
  bus.emit('log', {
    cls: 'sys',
    text: `[系统] 欢迎回来，<b>${store.get().world.name}</b> 的第 ${store.get().world.day} 日。`,
  });
  if (offlineMessage) bus.emit('log', { cls: 'gold', text: offlineMessage });
}

const newWorldModal = buildNewWorldModal(createWorld);

const startRoot = buildStartScreen({
  onNew: () => newWorldModal.open(),
  onContinue: () => continueGame(),
  onSettings: () => settingsModal.open(),
});
app.appendChild(startRoot);
