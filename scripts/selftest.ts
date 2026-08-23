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
import { simulationWorldDay } from '../src/simulation';

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
  const rt = new GameRuntime(store, () => {});
  for (let i = 0; i < 5; i++) rt.update(1000); // 先触发首轮刷怪
  rt.player.hp = 1;
  const target = rt.monsters.find((m) => m.state !== 'dead' && Math.hypot(m.x, m.y) < 30);
  if (target) {
    rt.player.x = target.x + 0.3;
    rt.player.y = target.y;
    for (let i = 0; i < 120 && rt.player.hp > 0; i++) rt.update(500);
    const town = config.factions.pois.find((p) => p.kind === 'town')!;
    const atTown = Math.hypot(rt.player.x - town.x, rt.player.y - (town.y + 1)) < 0.5;
    check('死亡后回城复活', atTown && rt.player.hp > 0, `pos=(${rt.player.x.toFixed(1)},${rt.player.y.toFixed(1)}) hp=${rt.player.hp}`);
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
    '默认存档为 v9 且动态世界字段齐全',
    d4.version === 9 &&
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
  const snap = JSON.parse(JSON.stringify(s9)) as GameState;
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
  const before = rt.monsters.length;
  rt.enterRealm();
  check('筑基前秘境拒绝进入', rt.monsters.length === before, `${before} -> ${rt.monsters.length}`);
  store.set((st) => ({ ...st, player: { ...st.player, level: 10 } }));
  rt.enterRealm();
  check('筑基后秘境开启刷怪', rt.monsters.length >= before + 8, `${before} -> ${rt.monsters.length}`);
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

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
