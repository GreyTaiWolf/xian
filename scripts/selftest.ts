/**
 * 无头自检：直接运行游戏核心逻辑（世界生成 / 运行时 / 掉落 / 背包 / 存档迁移），
 * 不依赖浏览器。运行：npm run selftest
 */
import { config } from '../src/core/config';
import { fbm, valueNoise2D } from '../src/world/noise';
import { World } from '../src/world/map';
import { Store } from '../src/core/store';
import {
  defaultState,
  migrateV1toV2,
  migrateV2toV3,
  migrateV3toV4,
  migrateV4toV5,
  migrateV5toV6,
  migrateV6toV7,
  migrateV7toV8,
  migrateV8toV9,
  migrateV9toV10,
  normalizeV10State,
  normalizeV9State,
  type GameState,
} from '../src/game/state';
import {
  derivedStats,
  itemDisplayName,
  itemTemplate,
  levelUp,
  realmOf,
  tierOf,
  xpNeed,
} from '../src/game/stats';
import { generateAffixes } from '../src/game/equipment-gen';
import { rollTable } from '../src/systems/loot';
import { canAffordChoice, choiceCostText, pickTravelEvent, resolveTravelEvent } from '../src/systems/travelEvents';
import { GameRuntime } from '../src/systems/runtime';
import { validateDirectives } from '../src/ai/validator';
import { bus } from '../src/core/eventbus';
import { SAVE_VERSION } from '../src/core/save';
import { simulationWorldDay } from '../src/simulation';
import { CombatTimeline } from '../src/systems/combat';
import {
  advanceTrialWave,
  beginTrialWave,
  canAdvanceTrialWave,
  createTrialRun,
  isTrialCleared,
  recordTrialDefeat,
  TRIAL_WAVE_COUNT,
} from '../src/systems/trial';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name} ${extra}`);
  }
}

console.log('== 1. 噪声 ==');
{
  const a = fbm(1.5, 2.5, 42, 4);
  const b = fbm(1.5, 2.5, 42, 4);
  check('fbm 确定性', a === b, `${a} vs ${b}`);
  check('fbm 值域 [0,1]', a >= 0 && a <= 1, String(a));
  let inRange = true;
  for (let i = 0; i < 200; i++) {
    const v = valueNoise2D(Math.random() * 100, Math.random() * 100, 7);
    if (v < 0 || v > 1) inRange = false;
  }
  check('valueNoise2D 值域', inRange);
}

console.log('== 2. 世界生成 ==');
{
  const w1 = new World(882345);
  const w2 = new World(882345);
  let same = true;
  for (let i = 0; i < 300; i++) {
    const x = Math.floor(Math.random() * 500) - 250;
    const y = Math.floor(Math.random() * 500) - 250;
    const a = w1.at(x, y);
    const b = w2.at(x, y);
    if (a.g !== b.g || a.walkable !== b.walkable || a.biome !== b.biome) {
      same = false;
      break;
    }
  }
  check('同 seed 完全一致', same);
  const spawn = w1.at(0, 0);
  check('出生点安全区 walkable', spawn.walkable && spawn.biome === 'grass', JSON.stringify(spawn));
  const biomes = new Set<string>();
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const t = w1.at(x * 40, y * 40);
      biomes.add(t.biome);
    }
  }
  check('生物群系多样性（≥4 种）', biomes.size >= 4, `${biomes.size}: ${[...biomes].join(',')}`);
  const town = config.factions.pois.find((p) => p.kind === 'town')!;
  check('城镇安全区 walkable', w1.at(town.x, town.y).walkable);
  const t0 = w1.at(3.2, -1.7);
  const t1 = w1.at(3.2, -1.7);
  check('chunk 缓存命中（同一对象）', t0 === t1);
  check('visitedChunks 有记录', w1.visitedChunks().length > 0);
  // 大陆连通性（回归：出生点被海围死的 bug）
  let land = 0;
  for (let y = -20; y < 20; y++) {
    for (let x = -20; x < 20; x++) {
      if (w1.at(x, y).walkable) land += 1;
    }
  }
  const landRatio = land / 1600;
  check('默认种子出生点周边陆地比例 ≥25%', landRatio >= 0.25, `${(landRatio * 100).toFixed(1)}%`);
  const seen = new Set<string>([`0,0`]);
  const queue: [number, number][] = [[0, 0]];
  let reachable = 0;
  while (queue.length > 0 && reachable < 10000) {
    const [cx, cy] = queue.pop()!;
    reachable += 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (w1.at(nx, ny).walkable) {
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  check('默认种子出生点可达格 ≥400（能走出去）', reachable >= 400, String(reachable));
}

console.log('== 3. 配置与掉落 ==');
{
  let allValid = true;
  for (const tableId of Object.keys(config.drops.tables as object)) {
    for (let i = 0; i < 100; i++) {
      const r = rollTable(tableId, Math.random);
      if (r && !itemTemplate(r.templateId)) allValid = false;
    }
  }
  check('所有掉落表产物都在物品表内', allValid);
  const ids = new Set(config.items.items.map((t) => t.id));
  const refs = config.drops.tables as unknown as Record<string, { item: string }[]>;
  check('掉落表引用物品齐全', Object.values(refs).flat().every((e) => ids.has(e.item)));
  check('升级曲线递增', xpNeed(5) > xpNeed(1) && xpNeed(20) > xpNeed(5));
}

console.log('== 4. 运行时仿真（60 秒挂机） ==');
{
  const store = new Store<GameState>(defaultState());
  const logs: string[] = [];
  const rt = new GameRuntime(store, (_c, text) => logs.push(text));
  const baseAtk = derivedStats(store.get()).atk;
  for (let i = 0; i < 60; i++) rt.update(1000);
  check('动态刷怪已生效', rt.monsters.length > 0, `monsters=${rt.monsters.length}`);
  const finite = rt.monsters.every(
    (m) => Number.isFinite(m.x) && Number.isFinite(m.hp) && Number.isFinite(m.atk),
  );
  check('怪物数值无 NaN/Infinity', finite);
  const h = rt.hudData();
  check('HUD 数据有限', Object.values(h).every((v) => v === null || typeof v !== 'number' || Number.isFinite(v)));
  const levelGrad = rt.monsters.some((m) => m.lvl > config.monsters.monsters[0].lvl);
  check('等级梯度存在（有高于模板等级的怪）', levelGrad);

  // 战斗仿真：站到怪物脸上挂机
  const target = rt.monsters.find((m) => m.state !== 'dead' && Math.hypot(m.x, m.y) < 30);
  if (target) {
    rt.player.x = target.x + 0.4;
    rt.player.y = target.y;
    for (let i = 0; i < 40 && rt.player.hp > 0 && target.state !== 'dead'; i++) rt.update(1000);
    const kills = store.get().player.kills;
    const money = store.get().player.money;
    const xp = store.get().player.xp;
    check('击杀后击杀数增加', kills > 0, `kills=${kills}`);
    check('击杀后获得收益（灵石或修为）', money > 100 || xp > 0, `money=${money} xp=${xp}`);
  } else {
    check('找到近距离怪物', false, '未找到，跳过战斗仿真');
  }
}

console.log('== 8. 死亡与回城 ==');
{
  const store = new Store<GameState>(defaultState());
  const deathLogs: string[] = [];
  const rt = new GameRuntime(store, (_cls, text) => deathLogs.push(text));
  for (let i = 0; i < 5; i++) rt.update(1000); // 先触发首轮刷怪
  rt.player.hp = 1;
  const target = rt.monsters.find((m) => m.state !== 'dead' && Math.hypot(m.x, m.y) < 30);
  if (target) {
    rt.player.x = target.x + 0.3;
    rt.player.y = target.y;
    const town = config.factions.pois.find((p) => p.kind === 'town')!;
    for (let i = 0; i < 120; i++) {
      rt.update(500);
      const revivedAtTown =
        deathLogs.some((text) => text.includes('[陨落]')) &&
        Math.hypot(rt.player.x - town.x, rt.player.y - (town.y + 1)) < 0.5 &&
        rt.player.hp > 0;
      if (revivedAtTown) break;
    }
    const atTown = Math.hypot(rt.player.x - town.x, rt.player.y - (town.y + 1)) < 0.5;
    check(
      '死亡演出完成后回城复活',
      deathLogs.some((text) => text.includes('[陨落]')) && atTown && rt.player.hp > 0,
      `pos=(${rt.player.x.toFixed(1)},${rt.player.y.toFixed(1)}) hp=${rt.player.hp}`,
    );
  } else {
    check('找到怪物', false, '未找到，跳过死亡仿真');
  }
  rt.returnToTown();
  const town = config.factions.pois.find((p) => p.kind === 'town')!;
  check('主动回城定位正确', Math.hypot(rt.player.x - town.x, rt.player.y - (town.y + 1)) < 0.5);
}

console.log('== 5. 背包 / 装备 / 拾取 ==');
{
  const store = new Store<GameState>(defaultState());
  const rt = new GameRuntime(store, () => {});
  const sword = store.get().inventory[0]!;
  const before = derivedStats(store.get()).atk;
  rt.equipItem(sword.uid);
  const after = derivedStats(store.get()).atk;
  check('装备木剑后攻击提升', after > before, `${before} -> ${after}`);
  rt.unequip('weapon');
  check('卸下后攻击回落', derivedStats(store.get()).atk === before);
  const invBefore = store.get().inventory.filter(Boolean).length;
  rt.addItem('iron_ingot', 3);
  const invAfter = store.get().inventory.filter(Boolean).length;
  check('获得物品入包（占新格）', invAfter === invBefore + 1, `${invBefore} -> ${invAfter}`);
  const money0 = store.get().player.money;
  rt.sellItem('hp_pill');
  check('出售后灵石增加', store.get().player.money > money0);
  rt.addItem('wolf_pelt', 5000, 0, true);
  const slots = store.get().inventory.filter(Boolean).length;
  check('背包有容量上限（不会超 32 格）', slots <= 32, String(slots));

  const atomicState = defaultState();
  atomicState.inventory = Array.from({ length: 32 }, (_, index) => ({
    uid: 100_000 + index,
    templateId: index === 0 ? 'wolf_pelt' : 'wood_sword',
    count: index === 0 ? 98 : 1,
    plus: 0,
    affixes: [],
  }));
  const atomicStore = new Store<GameState>(atomicState);
  const atomicRuntime = new GameRuntime(atomicStore, () => {});
  const inventoryBeforeFailedAdd = JSON.stringify(atomicStore.get().inventory);
  const addedPastCapacity = atomicRuntime.addItem('wolf_pelt', 2, 0, true);
  check(
    '背包容量不足时 addItem 原子失败且不部分堆叠',
    !addedPastCapacity &&
      JSON.stringify(atomicStore.get().inventory) === inventoryBeforeFailedAdd &&
      atomicRuntime.countItem('wolf_pelt') === 98,
    JSON.stringify(atomicStore.get().inventory[0]),
  );
}

console.log('== 6. 存档迁移链 ==');
{
  const v1 = {
    world: { seed: 123456, name: '旧世界', day: 7, createdAt: 1 },
    player: { name: '旧玩家', money: 999 },
    settings: { aiEnabled: false },
  };
  const s2 = migrateV1toV2(v1);
  check('v1→v2 保留名字/灵石', s2.player.name === '旧玩家' && s2.player.money === 999);
  const s3 = migrateV2toV3(s2);
  check('v2→v3 补 visited 并重置出生点', Array.isArray(s3.world.visited) && s3.player.pos.x === 0.5 && s3.player.pos.y === 0.5);
  const s3b = migrateV3toV4(s3 as GameState);
  check(
    'v3→v4 补编年史与势力态',
    Array.isArray(s3b.world.chronicle) && typeof s3b.world.faction.tension === 'number',
  );
  const d4 = defaultState();
  check(
    '默认存档为 v10 且 V2 / 动态世界字段齐全',
    SAVE_VERSION === 10 &&
      d4.version === 10 &&
      d4.simulation.seed === d4.world.seed &&
      simulationWorldDay(d4.simulation) === d4.world.day &&
      d4.world.chronicle.length === 1 &&
      d4.player.quests.length === 3 &&
      d4.player.mind === 60 &&
      d4.player.insight === 30 &&
      d4.player.achievements.length === 0 &&
      d4.player.tutorialDone === false &&
      d4.player.mainQuestStage === 0 &&
      d4.world.bossDefeated === false &&
      d4.world.pendingTravelEvent === null &&
      d4.world.realmEntered === false &&
      d4.world.realmProgress.highestCleared === 0 &&
      d4.world.realmProgress.pendingRewards.length === 0 &&
      d4.settings.autoSkills === true &&
      d4.settings.combatSpeed === 1 &&
      d4.inventory[0]!.affixes.length === 0,
  );
  const s4 = migrateV2toV3(s3b as GameState);
  const s5 = migrateV4toV5(s4 as GameState);
  check(
    'v4→v5 补宗门/贡献/任务/转世',
    s5.player.sectId === null && s5.player.quests.length === 3 && s5.player.ascension === 0,
  );
  const s6 = migrateV5toV6(s5 as GameState);
  check(
    'v5→v6 补心境/悟性与词条字段',
    s6.player.mind === 60 &&
      s6.player.insight === 30 &&
      Array.isArray(s6.inventory[0]!.affixes) &&
      Array.isArray(s6.drops),
  );
  const s7 = migrateV6toV7(s6 as GameState);
  check(
    'v6→v7 补成就/引导/首领标记',
    Array.isArray(s7.player.achievements) && s7.player.tutorialDone === false && s7.world.bossDefeated === false,
  );
  const s8 = migrateV7toV8(s7 as GameState);
  check(
    'v7→v8 补异闻状态与主线阶段',
    s8.world.pendingTravelEvent === null &&
      Array.isArray(s8.world.travelEventHistory) &&
      typeof s8.world.eventFlags === 'object' &&
      s8.player.mainQuestStage === 0,
  );
  const legacyV8 = { ...s8, simulation: undefined } as unknown as GameState;
  const s9 = migrateV8toV9(legacyV8);
  check(
    'v8→v9 补动态世界并同步种子/世界日',
    s9.version === 9 &&
      s9.simulation.seed === s9.world.seed &&
      simulationWorldDay(s9.simulation) === s9.world.day,
  );
  const normalized = normalizeV9State({ ...s9, simulation: defaultState().simulation });
  check(
    'v9 归一可修复种子不符的模拟状态',
    normalized.simulation.seed === normalized.world.seed &&
      simulationWorldDay(normalized.simulation) === normalized.world.day,
  );

  const legacyV9 = JSON.parse(JSON.stringify(s9)) as GameState;
  legacyV9.version = 9;
  delete (legacyV9.world as typeof legacyV9.world & { realmProgress?: unknown }).realmProgress;
  delete (legacyV9.settings as typeof legacyV9.settings & { autoSkills?: unknown }).autoSkills;
  delete (legacyV9.settings as typeof legacyV9.settings & { combatSpeed?: unknown }).combatSpeed;
  const s10 = migrateV9toV10(legacyV9);
  check(
    'v9→v10 补秘境进度、自动技能与战斗速度',
    s10.version === 10 &&
      s10.world.realmProgress.highestCleared === 0 &&
      s10.world.realmProgress.totalClears === 0 &&
      s10.world.realmProgress.readyDay === 1 &&
      s10.world.realmProgress.pendingRewards.length === 0 &&
      s10.settings.autoSkills === true &&
      s10.settings.combatSpeed === 1 &&
      s10.simulation.seed === s10.world.seed &&
      simulationWorldDay(s10.simulation) === s10.world.day,
  );

  const damagedV10 = {
    ...s10,
    version: 10,
    simulation: defaultState().simulation,
    world: {
      ...s10.world,
      realmProgress: {
        highestCleared: -4.8,
        totalClears: -2.2,
        readyDay: 0,
        pendingRewards: [],
      },
    },
    settings: {
      ...s10.settings,
      autoSkills: false,
      combatSpeed: 9,
    },
  } as unknown as GameState;
  const normalizedV10 = normalizeV10State(damagedV10);
  check(
    'v10 归一修复新增字段并保持模拟时钟一致',
    normalizedV10.version === 10 &&
      normalizedV10.world.realmProgress.highestCleared === 0 &&
      normalizedV10.world.realmProgress.totalClears === 0 &&
      normalizedV10.world.realmProgress.readyDay === 1 &&
      normalizedV10.settings.autoSkills === false &&
      normalizedV10.settings.combatSpeed === 1 &&
      normalizedV10.simulation.seed === normalizedV10.world.seed &&
      simulationWorldDay(normalizedV10.simulation) === normalizedV10.world.day,
  );

  const corruptedV10 = {
    ...s10,
    version: 10,
    world: {
      ...s10.world,
      realmProgress: {
        highestCleared: Number.NaN,
        totalClears: Number.POSITIVE_INFINITY,
        readyDay: '非法日期',
        pendingRewards: [
          { uid: 7_001, templateId: 'hp_pill', count: 1, plus: 0 },
          { uid: 7_002, templateId: 'missing_template', count: 1, plus: 0, affixes: [] },
          { uid: 7_003, templateId: 'hp_pill', count: -4, plus: 0, affixes: [] },
        ],
      },
    },
  } as unknown as GameState;
  let repairedCorruptedV10: GameState | null = null;
  let corruptedV10Error = '';
  try {
    repairedCorruptedV10 = normalizeV10State(corruptedV10);
  } catch (error) {
    corruptedV10Error = error instanceof Error ? error.message : String(error);
  }
  const repairedProgress = repairedCorruptedV10?.world.realmProgress;
  const repairedRewards = repairedProgress?.pendingRewards ?? [];
  const missingAffixesReward = repairedRewards.find((item) => item.uid === 7_001);
  const negativeCountReward = repairedRewards.find((item) => item.uid === 7_003);
  check(
    'v10 归一安全修复 realmProgress 的 NaN、Infinity 与字符串',
    corruptedV10Error === '' &&
      !!repairedProgress &&
      Number.isSafeInteger(repairedProgress.highestCleared) &&
      repairedProgress.highestCleared >= 0 &&
      Number.isSafeInteger(repairedProgress.totalClears) &&
      repairedProgress.totalClears >= 0 &&
      Number.isSafeInteger(repairedProgress.readyDay) &&
      repairedProgress.readyDay >= 1,
    corruptedV10Error || JSON.stringify(repairedProgress),
  );
  check(
    'v10 归一丢弃非法模板、修复或丢弃负数奖励并补齐缺词条奖励',
    corruptedV10Error === '' &&
      repairedRewards.every(
        (item) =>
          !!itemTemplate(item.templateId) &&
          Number.isSafeInteger(item.count) &&
          item.count > 0 &&
          Array.isArray(item.affixes),
      ) &&
      !repairedRewards.some((item) => item.uid === 7_002) &&
      (negativeCountReward === undefined || negativeCountReward.count > 0) &&
      (missingAffixesReward === undefined || Array.isArray(missingAffixesReward.affixes)),
    corruptedV10Error || JSON.stringify(repairedRewards),
  );

  const snap = JSON.parse(JSON.stringify(s10)) as GameState;
  check(
    '存档 JSON 往返后派生属性与动态世界一致',
    JSON.stringify(derivedStats(s4)) === JSON.stringify(derivedStats(snap)) &&
      snap.simulation.seed === snap.world.seed &&
      simulationWorldDay(snap.simulation) === snap.world.day,
  );
}

console.log('== 7. 日志事件管道 ==');
{
  const got: string[] = [];
  const off = bus.on('log', (e) => got.push(e.text));
  bus.emit('log', { cls: 'sys', text: 'selftest' });
  off();
  check('事件总线收发', got.length === 1 && got[0] === 'selftest');
}

console.log('== 9. 天道指令校验与钩子 ==');
{
  const good = validateDirectives({
    directives: [
      { type: 'faction_relation_change', delta: 999, reason: 'x'.repeat(200) },
      { type: 'beast_tide', target: 'bogus', power: 99 },
      { type: 'spirit_surge', xpMult: 'abc', durationDays: 9 },
      { type: 'world_rumor', text: '城中流言四起' },
      { type: 'hack_the_world', delta: 1 },
    ],
  });
  check(
    '越界指令被钳制、非法类型被丢弃',
    good.length === 4 &&
      good[0].delta === 20 &&
      (good[0].reason?.length ?? 0) <= 60 &&
      good[1].power === 4 &&
      good[1].target === 'player' &&
      good[2].xpMult === 1.1 &&
      good[2].durationDays === 5,
    JSON.stringify(good),
  );
  check('空/非法输入返回空数组', validateDirectives(null).length === 0 && validateDirectives({}).length === 0);
  const store = new Store<GameState>(defaultState());
  const rt = new GameRuntime(store, () => {});
  const before = rt.monsters.length;
  rt.spawnWave(6, 0.5, 'player');
  check('兽潮刷怪钩子', rt.monsters.length === before + 6, `${before} -> ${rt.monsters.length}`);
  rt.setAura(1.25, 3);
  check('灵潮 HUD 标签', rt.hudData().auraLabel !== null, String(rt.hudData().auraLabel));
}

console.log('== 10. 境界 / 宗门 / 任务 / 秘境 ==');
{
  check(
    '境界命名（大境界+小阶段）',
    realmOf(1) === '炼气 · 初期' &&
      realmOf(4) === '炼气 · 中期' &&
      realmOf(9) === '炼气 · 圆满' &&
      realmOf(10) === '筑基 · 初期',
    `${realmOf(1)} ${realmOf(4)} ${realmOf(9)} ${realmOf(10)}`,
  );
  check('境界层级', tierOf(1) === 0 && tierOf(10) === 1 && tierOf(54) === 5);
  check(
    '品级前缀命名',
    itemDisplayName(itemTemplate('war_spear')!) === '灵·破军枪' &&
      itemDisplayName(itemTemplate('green_sword')!) === '精·青云剑',
  );
  const affixes = generateAffixes('xuan', 2, Math.random);
  check('玄品词条数量 3~4', affixes.length >= 3 && affixes.length <= 4, String(affixes.length));
  check('词条数值有效', affixes.every((a) => a.value > 0 && typeof a.stat === 'string'));
  const peak = levelUp(
    { ...defaultState().player, level: 9, xp: xpNeed(9) + 500 },
    () => {},
  );
  check('境界圆满时修为封顶不升级', peak.level === 9 && peak.xp === xpNeed(9) - 1, `lv=${peak.level} xp=${peak.xp}`);

  const store = new Store<GameState>(defaultState());
  const rt = new GameRuntime(store, () => {});
  for (let i = 0; i < 5; i++) rt.update(1000);
  // 加入宗门（先升到 3 级）
  store.set((st) => ({ ...st, player: { ...st.player, level: 3 } }));
  rt.joinSect('qingyun');
  check('拜入宗门', store.get().player.sectId === 'qingyun');
  rt.sectExchange('portal_fu');
  check('贡献不足无法兑换', store.get().player.contribution === 0);
  // 击杀推进任务与贡献（提高生命上限避免落入怪堆暴毙；回血会钳到 hpMax）
  const target = rt.monsters.find((m) => m.state !== 'dead' && Math.hypot(m.x, m.y) < 30);
  if (target) {
    store.set((st) => ({
      ...st,
      player: { ...st.player, base: { ...st.player.base, hpMax: 5000 } },
    }));
    rt.player.hp = 5000;
    rt.player.x = target.x + 0.4;
    rt.player.y = target.y;
    for (let i = 0; i < 60 && target.state !== 'dead'; i++) rt.update(1000);
    const q = store.get().player.quests.find((x) => x.id === 'daily_any');
    check('击杀推进任务进度', (q?.progress ?? 0) >= 1, `progress=${q?.progress}`);
    check('击杀获得宗门贡献', store.get().player.contribution >= 1, String(store.get().player.contribution));
  } else {
    check('找到怪物', false, '跳过');
  }
  // 合成
  store.set((st) => ({ ...st, player: { ...st.player, money: 1000 } }));
  rt.addItem('wolf_pelt', 10, 0, true);
  const pillBefore = rt.countItem('hp_pill');
  rt.craft('craft_hp_pill');
  check('合成回灵丹', rt.countItem('hp_pill') === pillBefore + 2, `${pillBefore} -> ${rt.countItem('hp_pill')}`);
  // 秘境（需筑基）
  const realm = config.factions.pois.find((p) => p.kind === 'realm')!;
  rt.player.x = realm.x + 1;
  rt.player.y = realm.y + 1;
  const trialMonstersBefore = rt.monsters.filter((monster) => monster.source === 'trial').length;
  rt.enterRealm();
  check(
    '筑基前秘境拒绝进入',
    rt.trialRun === null && rt.monsters.filter((monster) => monster.source === 'trial').length === trialMonstersBefore,
  );
  store.set((st) => ({ ...st, player: { ...st.player, level: 10 } }));
  rt.enterRealm();
  const firstFloor = config.trials.floors[0];
  const firstWave = firstFloor.waves[0];
  const currentEncounterId = rt.trialRun?.encounterId;
  const firstWaveMonsters = rt.monsters.filter(
    (monster) => monster.source === 'trial' && monster.encounterId === currentEncounterId,
  );
  check(
    '筑基后秘境仅生成首波配置数量并进入 active',
    rt.trialRun?.status === 'active' &&
      rt.trialRun.waveIndex === 0 &&
      rt.trialRun.trackedMonsterIds.length === firstWave.count &&
      firstWaveMonsters.length === firstWave.count &&
      firstWaveMonsters.every((monster) => monster.templateId === firstWave.monster),
    `trial=${JSON.stringify(rt.trialRun)} monsters=${firstWaveMonsters.length}`,
  );
  // 地点行动数据
  const town = config.factions.pois.find((p) => p.kind === 'town')!;
  rt.player.x = town.x + 0.5;
  rt.player.y = town.y + 0.5;
  check('靠近城镇可检测到地点', rt.nearPois().some((p) => p.kind === 'town'));
  rt.restAtTown();
  check('城镇打坐回满', rt.player.hp === rt.hudData().hpMax);
  // 突破（圆满 + 材料；成功或失败均扣材料）
  store.set((st) => ({
    ...st,
    player: { ...st.player, level: 9, xp: xpNeed(9) - 1, money: 5000 },
  }));
  rt.addItem('xp_pill', 10, 0, true);
  const pills0 = rt.countItem('xp_pill');
  rt.breakthrough();
  const after = store.get().player;
  check(
    '突破：成功升 10 级或失败修为折半，材料必扣',
    (after.level === 10 || after.xp <= (xpNeed(9) - 1) / 2 + 1) && rt.countItem('xp_pill') === pills0 - 3,
    `lv=${after.level} xp=${after.xp} pills=${rt.countItem('xp_pill')}`,
  );
}

console.log('== 11. 成就与首领首杀 ==');
{
  const store = new Store<GameState>(defaultState());
  const rt = new GameRuntime(store, () => {});
  for (let i = 0; i < 5; i++) rt.update(1000);
  // 击杀一只怪 → 首杀成就
  const target = rt.monsters.find((m) => m.state !== 'dead' && Math.hypot(m.x, m.y) < 30);
  if (target) {
    store.set((st) => ({
      ...st,
      player: { ...st.player, base: { ...st.player.base, hpMax: 8000, atk: 200 } },
    }));
    rt.player.hp = 8000;
    rt.player.x = target.x + 0.4;
    rt.player.y = target.y;
    for (let i = 0; i < 30 && target.state !== 'dead'; i++) rt.update(1000);
    check('击杀触发首杀成就', store.get().player.achievements.includes('first_kill'), String(store.get().player.achievements));
  } else {
    check('找到怪物', false, '跳过');
  }
  // 狼王首杀 → bossDefeated + 成就
  store.set((st) => ({
    ...st,
    player: { ...st.player, base: { ...st.player.base, hpMax: 20000, atk: 400, def: 100 } },
  }));
  rt.player.hp = 20000;
  const boss = rt.monsters.find((m) => m.templateId === 'wolf_king')!;
  rt.player.x = boss.x + 0.4;
  rt.player.y = boss.y;
  for (let i = 0; i < 150 && boss.state !== 'dead'; i++) rt.update(1000);
  check(
    '狼王首杀广播与成就',
    store.get().world.bossDefeated === true && store.get().player.achievements.includes('boss_kill'),
    `bossDefeated=${store.get().world.bossDefeated}`,
  );
  // 世界日 → 成就
  store.set((st) => ({ ...st, world: { ...st.world, day: 10 } }));
  rt.checkAchievements();
  check('世界日成就', store.get().player.achievements.includes('day_10'));
}

console.log('== 12. 行路异闻与主线阶段 ==');
{
  const store = new Store<GameState>(defaultState());
  const rt = new GameRuntime(store, () => {});
  for (let i = 0; i < 5; i++) rt.update(1000);
  // 首次行走必触发：直接走够距离
  const s0 = store.get();
  const picked = pickTravelEvent(s0, Math.random);
  check('首次行程必触发异闻', picked !== null, String(picked?.id));
  const allIds = config.travelEvents.events.map((e) => e.id);
  const cdAll = {
    ...s0,
    world: { ...s0.world, travelEventHistory: ['x@1'], eventCooldowns: Object.fromEntries(allIds.map((id) => [id, 999])) },
  };
  check('全部冷却时无异闻', pickTravelEvent(cdAll, () => 0.01) === null);
  const cdFirst = {
    ...s0,
    world: {
      ...s0.world,
      travelEventHistory: ['x@1'],
      eventCooldowns: { [config.travelEvents.events[0].id]: 999 },
    },
  };
  const picked2 = pickTravelEvent(cdFirst, () => 0.01);
  check(
    '冷却中的事件不被选中',
    picked2 !== null && picked2.id !== config.travelEvents.events[0].id,
    String(picked2?.id),
  );
  check('选项代价文本', choiceCostText(config.travelEvents.events[0].choices[0]).length > 0);
  // 手动挂起一个事件并结算
  store.set((st) => ({ ...st, world: { ...st.world, pendingTravelEvent: { eventId: 'spirit_spring' } } }));
  const before = { money: store.get().player.money, xp: store.get().player.xp, history: store.get().world.travelEventHistory.length };
  rt.resolveTravelEvent('drink_spring');
  const after = store.get();
  check(
    '异闻结算：修为+50 且历史入档、事件清除',
    after.player.xp >= before.xp + 50 &&
      after.world.travelEventHistory.length === before.history + 1 &&
      after.world.pendingTravelEvent === null &&
      (after.world.eventCooldowns['spirit_spring'] ?? 0) === after.world.day + 1,
  );
  // 因果延续：负伤客 → 废窑
  store.set((st) => ({ ...st, world: { ...st.world, pendingTravelEvent: { eventId: 'wounded_guest' } } }));
  rt.addItem('hp_pill', 5, 0, true);
  rt.resolveTravelEvent('use_medicine');
  check('因果延续弹出第二段', store.get().world.pendingTravelEvent?.eventId === 'old_kiln');
  rt.resolveTravelEvent('dig_treasure');
  const sFinal = store.get();
  check(
    '第二段结算：灵石+80 玄铁+2',
    sFinal.player.money >= 180 && rt.countItem('iron_ingot') >= 2 && sFinal.world.pendingTravelEvent === null,
  );
  // 主线推进：击杀 1 → 阶段 1；击杀 3 → 阶段 2
  store.set((st) => ({ ...st, player: { ...st.player, kills: 1 } }));
  rt.checkMainQuest();
  check('击杀 1 推进主线阶段', store.get().player.mainQuestStage === 1);
  store.set((st) => ({ ...st, player: { ...st.player, kills: 3 } }));
  rt.checkMainQuest();
  check('击杀 3 推进主线阶段', store.get().player.mainQuestStage === 2);
  store.set((st) => ({ ...st, player: { ...st.player, level: 10 } }));
  rt.checkMainQuest();
  check('筑基推进主线阶段（秘境解锁）', store.get().player.mainQuestStage === 3);
}

console.log('== 13. V2 战斗时间线 ==');
{
  const timings = { windup: 10, travel: 20, impact: 5, recover: 15 } as const;
  const player = { kind: 'player', id: 'hero' } as const;
  const monster = { kind: 'monster', id: 101 } as const;
  const timeline = new CombatTimeline(100);
  const first = timeline.enqueue({
    actor: player,
    target: monster,
    kind: 'basic',
    timings,
    priority: 50,
    speed: 6,
  });
  const duplicate = timeline.enqueue({
    actor: player,
    target: monster,
    kind: 'skill',
    timings,
    priority: 99,
    speed: 99,
  });
  const events = timeline.advance(100);
  const signature = events.map((event) => event.type === 'phase' ? `phase:${event.phase}` : event.type);
  const expectedSignature = [
    'started',
    'phase:windup',
    'phase:travel',
    'phase:impact',
    'impact',
    'phase:recover',
    'completed',
  ];
  check(
    'CombatTimeline 严格按前摇→突进→命中→收招完成',
    JSON.stringify(signature) === JSON.stringify(expectedSignature) &&
      events.every((event, index) => index === 0 || event.eventSeq > events[index - 1].eventSeq) &&
      events.every((event, index) => index === 0 || event.atMs >= events[index - 1].atMs),
    JSON.stringify(signature),
  );
  check(
    'CombatTimeline 同 actor 去重且 impact 仅触发一次',
    first !== null &&
      duplicate === null &&
      events.filter((event) => event.type === 'impact').length === 1 &&
      !timeline.hasActor(player) &&
      timeline.enqueue({ actor: player, target: monster, kind: 'basic', timings }) !== null,
  );

  const deathTimeline = new CombatTimeline(200);
  deathTimeline.enqueue({
    actor: player,
    target: monster,
    kind: 'basic',
    timings,
    priority: 100,
  });
  deathTimeline.enqueue({
    actor: monster,
    target: player,
    kind: 'enemy',
    timings,
    priority: 10,
  });
  const deathEvents = deathTimeline.advance(100, {
    onEvent: (event) => {
      if (event.type === 'impact' && event.action.actor.kind === 'player') {
        deathTimeline.cancelByActor(monster, 'defeated');
      }
    },
  });
  const monsterEvents = deathEvents.filter((event) => event.action.actorKey === 'monster:number:101');
  check(
    '命中导致死亡会取消死者待执行行动',
    monsterEvents.length === 1 &&
      monsterEvents[0].type === 'cancelled' &&
      monsterEvents[0].reason === 'defeated' &&
      deathEvents.filter((event) => event.type === 'impact' && event.action.actor.kind === 'monster').length === 0 &&
      !deathTimeline.hasActor(monster),
    JSON.stringify(monsterEvents.map((event) => event.type)),
  );
}

console.log('== 14. V2 三波秘境状态机 ==');
{
  const created = createTrialRun('trial:selftest:1', 1);
  const wave1 = beginTrialWave(created, 'encounter:1', [101, 101, 102], 100);
  const wrongEncounter = recordTrialDefeat(wave1, 'encounter:stale', 101);
  const wave1OneDefeat = recordTrialDefeat(wave1, 'encounter:1', 101);
  const repeatedDefeat = recordTrialDefeat(wave1OneDefeat, 'encounter:1', 101);
  const wave1Cleared = recordTrialDefeat(wave1OneDefeat, 'encounter:1', 102);
  const between1 = advanceTrialWave(wave1Cleared, 500);
  const earlyWave2 = beginTrialWave(between1, 'encounter:2', [201], 499);
  const wave2 = beginTrialWave(between1, 'encounter:2', [201], 500);
  const between2 = advanceTrialWave(recordTrialDefeat(wave2, 'encounter:2', 201), 900);
  const wave3 = beginTrialWave(between2, 'encounter:3', [301], 900);
  const victory = advanceTrialWave(recordTrialDefeat(wave3, 'encounter:3', 301), 1_300);
  const staleAfterVictory = recordTrialDefeat(victory, 'encounter:3', 301);

  check(
    '试炼 begin 去重怪物并拒绝过早开启下一波',
    TRIAL_WAVE_COUNT === 3 &&
      wave1.status === 'active' &&
      JSON.stringify(wave1.trackedMonsterIds) === JSON.stringify([101, 102]) &&
      between1.status === 'between' &&
      between1.waveIndex === 1 &&
      earlyWave2 === between1 &&
      wave2.status === 'active' &&
      wave2.encounterId === 'encounter:2',
  );
  check(
    '试炼错误 encounter 与重复死亡事件幂等',
    wrongEncounter === wave1 &&
      repeatedDefeat === wave1OneDefeat &&
      wave1OneDefeat.defeatedMonsterIds.length === 1 &&
      !canAdvanceTrialWave(wave1OneDefeat),
  );
  check(
    '试炼三波 defeat→advance 后唯一进入 victory',
    between2.status === 'between' &&
      between2.waveIndex === 2 &&
      victory.status === 'victory' &&
      victory.waveIndex === 2 &&
      isTrialCleared(victory) &&
      staleAfterVictory === victory,
    JSON.stringify(victory),
  );
}

console.log('== 15. V2 运行时战斗集成 ==');
{
  const createCombatFixture = (atk: number) => {
    const state = defaultState();
    state.settings = { ...state.settings, autoSkills: false, combatSpeed: 1 };
    state.player.base = { ...state.player.base, atk, crit: 0 };
    const store = new Store<GameState>(state);
    const runtime = new GameRuntime(store, () => {});
    const target = runtime.monsters.find((monster) => monster.templateId === 'wolf_king')!;
    runtime.player.x = target.x + 0.4;
    runtime.player.y = target.y;
    return { runtime, store, target };
  };

  const lethal = createCombatFixture(50_000);
  const hpBeforeWindup = lethal.target.hp;
  lethal.runtime.update(200);
  const beforeImpact = lethal.runtime.combatSnapshot.active;
  check(
    'GameRuntime 普攻先进入时间线且命中前 HP 不变',
    lethal.target.hp === hpBeforeWindup &&
      beforeImpact?.actor.kind === 'player' &&
      beforeImpact.phase === 'travel' &&
      beforeImpact.impactEmitted === false,
    `hp=${lethal.target.hp}/${hpBeforeWindup} phase=${beforeImpact?.phase}`,
  );

  lethal.runtime.update(50);
  check(
    'GameRuntime 只在 impact 结算并保留 dying 演出',
    lethal.target.hp === 0 &&
      lethal.target.state === 'dying' &&
      lethal.target.deathT > 0 &&
      lethal.store.get().player.kills === 0 &&
      lethal.runtime.dmgNumbers.length > 0 &&
      lethal.runtime.combatFx.length > 0,
    `state=${lethal.target.state} deathT=${lethal.target.deathT}`,
  );
  lethal.runtime.update(400);
  check(
    '死亡演出未结束前目标不会提前变为 dead',
    lethal.target.state === 'dying' && lethal.store.get().player.kills === 0,
    `state=${lethal.target.state} deathT=${lethal.target.deathT}`,
  );
  lethal.runtime.update(50);
  check(
    '死亡演出结束后才 finalizeKill 并结算击杀',
    lethal.target.state === 'dead' && lethal.store.get().player.kills === 1,
    `state=${lethal.target.state} kills=${lethal.store.get().player.kills}`,
  );

  const visualA = createCombatFixture(25);
  const visualB = createCombatFixture(25);
  const visualStream = (visualB.runtime as unknown as { visualRng: () => number }).visualRng;
  for (let i = 0; i < 64; i++) visualStream();
  visualA.runtime.update(250);
  visualB.runtime.update(250);
  check(
    '视觉随机流变化不影响战斗数值随机结果',
    visualA.target.hp === visualB.target.hp &&
      visualA.runtime.dmgNumbers.length === 1 &&
      visualB.runtime.dmgNumbers.length === 1 &&
      visualA.runtime.dmgNumbers[0].x !== visualB.runtime.dmgNumbers[0].x,
    `hp=${visualA.target.hp}/${visualB.target.hp}`,
  );
}

console.log('== 16. V2 回城边界与秘境重入 ==');
{
  const trialState = defaultState();
  trialState.player = { ...trialState.player, level: 10 };
  trialState.settings = { ...trialState.settings, autoSkills: false, combatSpeed: 1 };
  const trialStore = new Store<GameState>(trialState);
  const trialRuntime = new GameRuntime(trialStore, () => {});
  const realm = config.factions.pois.find((poi) => poi.kind === 'realm')!;
  trialRuntime.player.x = realm.x + 1;
  trialRuntime.player.y = realm.y + 1;
  trialRuntime.enterRealm();
  const abandonedRunId = trialRuntime.trialRun?.runId;
  const trialTarget = trialRuntime.monsters.find(
    (monster) => monster.source === 'trial' && monster.encounterId === trialRuntime.trialRun?.encounterId,
  );
  if (trialTarget) {
    trialRuntime.player.x = trialTarget.x + 0.4;
    trialRuntime.player.y = trialTarget.y;
  }
  trialRuntime.update(50);
  const combatBeforeReturn = trialRuntime.combatSnapshot;
  trialRuntime.returnToTown();
  const combatAfterReturn = trialRuntime.combatSnapshot;
  const trialAfterReturn = trialRuntime.trialRun;
  check(
    '秘境战斗中主动回城清空时间线、结束试炼并移除试炼怪',
    !!abandonedRunId &&
      !!trialTarget &&
      combatBeforeReturn.active !== null &&
      combatAfterReturn.active === null &&
      combatAfterReturn.queued.length === 0 &&
      (trialAfterReturn === null || (trialAfterReturn.status !== 'active' && trialAfterReturn.status !== 'between')) &&
      trialRuntime.monsters.every((monster) => monster.source !== 'trial'),
    `before=${combatBeforeReturn.active?.phase ?? 'none'} after=${combatAfterReturn.active?.phase ?? 'none'} trial=${trialAfterReturn?.status ?? 'null'} monsters=${trialRuntime.monsters.filter((monster) => monster.source === 'trial').length}`,
  );

  trialRuntime.player.x = realm.x + 1;
  trialRuntime.player.y = realm.y + 1;
  trialRuntime.enterRealm();
  const reenteredRun = trialRuntime.trialRun;
  const reenteredMonsters = trialRuntime.monsters.filter(
    (monster) => monster.source === 'trial' && monster.encounterId === reenteredRun?.encounterId,
  );
  check(
    '回城放弃秘境后回到入口可开启全新首波',
    reenteredRun?.status === 'active' &&
      reenteredRun.runId !== abandonedRunId &&
      reenteredRun.waveIndex === 0 &&
      reenteredMonsters.length === config.trials.floors[0].waves[0].count,
    `old=${abandonedRunId ?? 'null'} new=${reenteredRun?.runId ?? 'null'} monsters=${reenteredMonsters.length}`,
  );

  const windupState = defaultState();
  windupState.settings = { ...windupState.settings, autoSkills: false, combatSpeed: 1 };
  windupState.player.base = { ...windupState.player.base, atk: 25, crit: 0 };
  const windupStore = new Store<GameState>(windupState);
  const windupRuntime = new GameRuntime(windupStore, () => {});
  const windupTarget = windupRuntime.monsters.find((monster) => monster.templateId === 'wolf_king')!;
  windupRuntime.player.x = windupTarget.x + 0.4;
  windupRuntime.player.y = windupTarget.y;
  windupRuntime.update(50);
  const windupAction = windupRuntime.combatSnapshot.active;
  const hpAtReturn = windupTarget.hp;
  windupRuntime.returnToTown();
  const windupClearedAtReturn =
    windupRuntime.combatSnapshot.active === null && windupRuntime.combatSnapshot.queued.length === 0;
  windupRuntime.update(1_000);
  check(
    '攻击前摇中主动回城会取消延迟命中且目标 HP 不再变化',
    windupAction?.actor.kind === 'player' &&
      windupAction.phase === 'windup' &&
      windupAction.impactEmitted === false &&
      windupClearedAtReturn &&
      windupTarget.hp === hpAtReturn &&
      windupRuntime.combatSnapshot.active === null &&
      windupRuntime.combatSnapshot.queued.length === 0,
    `phase=${windupAction?.phase ?? 'none'} hp=${hpAtReturn}->${windupTarget.hp} active=${windupRuntime.combatSnapshot.active?.phase ?? 'none'}`,
  );

  const dyingState = defaultState();
  dyingState.settings = { ...dyingState.settings, autoSkills: false, combatSpeed: 1 };
  dyingState.player.base = { ...dyingState.player.base, atk: 50_000, crit: 0 };
  const dyingStore = new Store<GameState>(dyingState);
  const dyingRuntime = new GameRuntime(dyingStore, () => {});
  const dyingTarget = dyingRuntime.monsters.find((monster) => monster.templateId === 'wolf_king')!;
  dyingRuntime.player.x = dyingTarget.x + 0.4;
  dyingRuntime.player.y = dyingTarget.y;
  dyingRuntime.update(250);
  const killsBeforeReturn = dyingStore.get().player.kills;
  dyingRuntime.returnToTown();
  const dyingPreservedAtReturn = dyingTarget.state === 'dying' && dyingTarget.hp === 0;
  dyingRuntime.update(450);
  check(
    '致命命中后回城仍完成死亡演出与唯一奖励结算',
    dyingPreservedAtReturn &&
      dyingTarget.state === 'dead' &&
      dyingStore.get().player.kills === killsBeforeReturn + 1,
    `state=${dyingTarget.state} kills=${killsBeforeReturn}->${dyingStore.get().player.kills}`,
  );
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
