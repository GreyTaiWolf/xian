# 参考学习笔记：Wenxian_game（作者自研半成品修仙文字 RPG）

> 来源：`reference/Wenxian_game`（GitHub: GreyTaiWolf/Wenxian_game，仅参考代码/设计，不参考图片）。
> 目的：吸收其设计纪律、内容结构与玩法布局，供《沧溟·几何修真》借鉴。

---

## 一、最值得学：文档纪律（AGENTS.md + docs/）

该项目的工程自律是最大亮点：

- **强制同步**：改玩法→`GAME_DESIGN.md`；改数值→`BALANCE.md`；新增系统必须同时动：类型定义、数据配置、UI 入口、设计说明、数值说明。
- **文档体系**：GAME_DESIGN（长期设计）、BALANCE（47KB 数值）、QUEST_SYSTEM（任务契约）、MAIN_QUEST（主线判定回归清单）、MAP_CONTENT、ITEM_SKILL_CATALOG。
- **变更记录模板**（每次改动追加一条）：
  > 玩法目的 / 解锁条件 / 玩家收益 / 关联系统 / UI 规则 / 影响范围
- 代码 ID 用 `lower_snake_case`，玩家文本中文，全程 UTF-8。

**→ 我们的动作**：本文件即起点；后续每轮改动在 `docs/` 追加"变更记录"。

## 二、境界体系

- **10 大境 × 4 小阶段**（初期/中期/后期/圆满），每阶段一个配置项：修为需求、基础属性表、寿元、突破成本（灵石+材料）、成功率、`unlocks[]`（解锁系统列表）。
- **突破失败惩罚分档**：小境界=修为回落+心境下降+不稳层数；大境界额外伤势。突破成功=套用目标境界属性、回满气血灵力、心境提升。
- **属性**：存档存核心字段，境界名/战力等显示值实时派生（与我们的架构一致）。
- **心境系统**：清明/稳定/波动/紊乱，影响突破成功率；另有意境字段：年龄/寿元/悟性/伤势/灵气不稳。
- **解锁驱动**：系统入口（洞府/同伴/灵宠）由境界 unlocks 控制，未解锁的底部导航按钮禁用并提示"此系统尚未解锁"。

**→ 我们的动作**：9 层制显示升级为"大境界+小阶段"（初期 1-3 / 中期 4-6 / 后期 7-8 / 圆满 9）；突破成功率加入心境/悟性系数；境界解锁入口。

## 三、装备双轴体系（强烈推荐抄）

- **双轴**：器类阶位（凡阶/炼气阶/筑基阶…= 穿戴门槛）压过 颜色品级（稀有度=词条数/光效/价格）。
- **9 档品级**：凡/良/精/灵/玄/地/天/仙/神。每档配置：前缀（`凡·铁剑`、`玄·赤霄剑`）、颜色、词条数区间（0-8）、系数、价格倍率（1→60）、效果倍率（1→2.72）、特效 tone（"紫色符纹"/"金色天光"）。
- **词条池按境界权重**：攻击/防御/资源/速度/闪避/暴击/神识/特殊 八类，低境界不出特殊词条，元婴后才出神识。
- **装备实例化**：实例固化 name/tier/quality/slot/mainStats/affixes；背包同名装备是不同实例。
- **投放节奏**：初期白绿、中期绿蓝、后期蓝紫、圆满紫+突破材料。
- **首通唯一奖励**：战斗组胜场写档，防重复领取。

**→ 我们的动作**：6 档稀有度 → 引入品级前缀命名 + 词条数量随品级 + 按境界的词条池权重（全配置化）。

## 四、地图：三层结构 + 纯文字格子

- **州域 → 地点 → 场景** 三层：州域（中州/东海/西漠/南疆/北境，各配势力/描述/坐标）→ 地点（城/镇/野/秘）→ 场景（hotspots 可点姓名标记 + actions 行动列表）。
- **48×32 文字格 + A* 寻路**：地形通行成本、地点锚点、角色位置，格子说明空间、文字异闻表达世界。
- **场景行动类型**：dialogue / shop / taskBoard / combat / gather / recruitPet / recruitCompanion / joinSect / treasure。
- **行路异闻**（两选一事件）：条件筛选（地图/起终点/最短步数/权重/冷却），每事件 2 个选项、至少一个免费；结果改修为/灵石/物品/心境/时间/标记，可**因果延续**（nextEventId 第二段）；事件历史/标记/冷却入档。

**→ 我们的动作**：无限噪声世界 + 地点锚点（城镇/宗门/秘境）= 走近出现"行动列表"；行走时按路程触发两选一异闻（与我们"世界轨迹由天道驱动"的定位很契合，天道事件+路上异闻双轨）。

## 五、主线：阶段卡 + CTA 引导

- `mainQuestStages` 阶段数组：chapter/title/summary/**destination/action/reward/module/ctaLabel**。
- 常驻"主线指引卡"（MainQuestCard）：显示当前阶段 + "前往修炼/前往历练"按钮直接切模块。

**→ 我们的动作**：任务升级为阶段化主线卡 + CTA 跳转（点击直接打开对应面板/传送到目标点）。

## 六、布局（移动端优先，430px 主容器）

- 骨架：`TopStatus（顶部状态）→ MainQuestCard（常驻主线卡）→ 内容区（当前模块）→ BottomNav（底部导航）`。
- 顶部状态条：名字+境界 / 战力 / 灵石 / 心境 / 日历 / 时间·天气；下排 寿元、修为 两条 meter。
- 底部导航 5 模块：修炼/背包/历练/洞府/宗门，未解锁禁用+title 提示。
- 修炼页：**圆形聚气按钮**（修为进度=球形液面填充），满后按钮变"突 破"，弹突破准备面板（5 个材料格，只能放入所需且拥有的材料）。
- 背包：3×3 九宫格分页；装备格只显名称+品级不显数量；灵品以上名称加粗+光效集中在徽章；详情浮层只展示玩家决策信息（**策划参数不上前台**）。
- 已穿装备格：只显示部位+装备名，点击进详情浮层，操作"卸下/返回"。
- 弹窗体系：战斗结算、异闻两选一、突破准备。
- 按钮最小高度 42px；操作都要有日志反馈，保证文字 RPG 连续叙事感。

## 七、战斗与结算

- 小队回合制，速度排序；普攻吃完整闪避、指向法术 50% 闪避、范围伤害不可闪避。
- 战斗操作：武技槽/功法槽/神通/法宝/丹药 + 凝神防御（本回合减伤 50%）+ 逃离。
- **胜负都同步气血灵力回角色**（禁止进出战斗免费回满）；战败回安全点、保留最低恢复比例、不删装备/任务进度。
- 战后弹窗：修为/灵石/材料/装备 + 首通状态。
- 掉落统一数据表：普通怪稳定材料+低概率基础装；精英提高掉装率与品级；首领保证装备+首通唯一奖励。

## 八、时间 / 洞府 / 存档

- 游戏内日历 + 时间 + 天气；旅行按小时计费；采集冷却 24h、宝箱/机缘冷却 720h。
- 洞府：筑基解锁；闭关=离线收益（手动开始、回来领取），聚灵阵消耗灵石材料升级提升效率/时长。
- 存档：3 槽位 RootSave V4，`normalizeSlotSafely` 容错归一化（非法数据回退而非崩溃）、settings（textSize/motion/autoSave）。

---

## 借鉴落地方案（按优先级）

| # | 借鉴项 | 对应我们项目 | 成本 |
|---|---|---|---|
| 1 | 变更记录模板 + BALANCE 数值文档 | `docs/game-design.md` 追加变更记录节；新建 `docs/balance.md` | 低 |
| 2 | 品级前缀命名（凡·/玄·）+ 品级表扩展 | items.json 加 grade 表（前缀/词条数/倍率），显示层加前缀 | 低-中 |
| 3 | 大境界+小阶段显示、突破解锁系统 | stats.ts realmOf 改 初期/中期/后期/圆满；境界 unlocks 数组 | 中 |
| 4 | 地点行动列表（走近城镇/宗门/秘境弹行动） | runtime 附近 POI 检测 + 行动按钮组 | 中 |
| 5 | 行路异闻两选一（行走触发，因果延续） | 新 systems/travelEvents + 事件表 JSON | 中-高 |
| 6 | 主线阶段卡 + CTA 跳转 | quests.json 扩展 stage 字段 + 常驻卡片 | 中 |
| 7 | 心境/悟性 → 影响突破成功率 | state + realms.json 加系数 | 低 |
| 8 | 战后结算弹窗 + 首通唯一奖励 | runtime kill 结算 + drops 首通表 | 中 |
| 9 | 顶部状态条信息密度（战力/日期天气） | 顶栏改造 | 低 |
| 10 | 多槽位存档 | save.ts 扩展（3 槽） | 中 |

---

# 深度学习补充（第二轮：实现层细节）

> 本轮精读了任务契约、异闻结算、装备生成、时间/地图数据结构与数值基线。以下为可直接复用的实现模式。

## A. 行路异闻完整实现模式（src/game/travelEvents.ts + data/travelEvents.ts）

- **事件配置**：`{id, title, locationName, description, regionId, mapIds[], locationIds[], minStepCount, weight, cooldownKey, cooldownHours, stageOnly?, choices:[2]}`；choice = `{id, label, description, cost, isFallback?, outcome}`；outcome = `{resultText, preview, rewards?, mindValueDelta?, timeHours?, flags?, nextEventId?}`。
- **触发管线**：候选筛选（区域/地图/起终点 locationIds/最短步数/冷却/指定事件）→ **首次行程必触发**（triggerChance=1），之后 `0.14 + 步数×0.025`，上限 0.72 → 权重抽取 → `pendingTravelEvent` 入档 → 日志"行至某地，你遇见了…"。
- **结算管线**：`canAffordCost` → `spendCost`（扣灵石/物品）→ 加奖励 → 心境 ± → 时间推进 → `nextEventId` 因果延续（替换 pending，第二段剧情）→ 历史记录（40 条上限）→ `eventFlags` 标记（防重复剧情分支）→ 冷却入档。
- **护栏**：两选一，至少一个 `isFallback` 免费选项；资源不足不能选贵选项；rng 注入可测试。

## B. 任务系统契约（docs/QUEST_SYSTEM.md + game/quests.ts）

- **目标类型两种真值来源**：①实时派生（gather=背包数量、realm、equip）——不写重复状态；②事件型进度（kill/visit/talk）——仅任务已接取时在 `objectiveProgress` 计数。
- **前置条件**：quest（前置任务状态）/ cultivation / realm / region / sect；未满足只显示"先完成《XX》"式解锁提示，不显示任务详情。
- **结算护栏 6 条**：不能重复接取；全部目标完成才可提交；材料检查与扣除用同一份背包数据；先置 completed 再发奖励（同次提交不能重复领）；奖励集中在 `completeQuest()`；击杀只在胜利结算记录（逃跑/战败不推进）。
- **任务链示例**：采集凝气草 → 讨伐黑风山妖兽 → 送信落霞镇（visit+talk 双目标）；筑基后开南疆线。

## C. 装备生成模式（game/generateEquipment.ts + data/affixPools.ts）

- **主属性按部位规则表**（slotMainStatRules）：武器吃"境界×品级攻击范围表"；其他部位按武器值×部位系数派生（护符→神识、靴→闪避、戒指→暴击）。
- **词条**：品级决定数量区间；词条池逐条过滤 `canAffixAppear(词条, 境界, 品级, 部位)`（特殊词条按境界解锁）；特殊效果 28 种（on_hit_fire/double_strike/execute_low_hp/armor_break/damage_reduce/start_shield/crit_extra_hit/revive_once/domain_skill…）。
- **战力**：`powerBonus` 从加成合计；`applyBalanceLimits` 统一钳制；高一大境界装备"封印"（按封印后数值比较）。

## D. 战斗技能数据化（data/skills.ts）

- 技能=纯数据：`{id, name, category, allowedUsers[], targetType, hitType(fullDodge/halfDodge/noDodge), spiritCost, power, effectType(damage/heal/shield/restoreSpirit/control), weight, unlockRealm, description}`。
- 闪避三档：普攻吃完整闪避、指向法术 50%、范围不可闪避；治疗/护盾 noDodge。
- AI 行动按 `weight` 权重抽取（game/ai.ts）。

## E. 时间系统（game/time.ts + data/time.ts）

- 世界钟 = tick（小时制）：`(day-1)*24 + hour`；日历 年/月/日 + 节气（立春/惊蛰…）+ 天气池（晴朗/多云/雨天）。
- 旅行按小时计费；采集冷却 24h、宝箱/机缘 720h；`normalizeWorldTimeState` 容错归一（tick 与 day/hour 互相校验）。

## F. 网格地图（data/gridMaps.ts）

- 48×32 手绘网格：`blockedRects`（障碍矩形）、`highCostRects`（地形成本×2）、`portals`（州域传送点：coord→目标 map+坐标）、地点坐标表（locationCoords）。
- 与我们的无限噪声世界是互补路线：它靠手工布局保证叙事节奏，我们靠程序生成保证探索新鲜感；"地点锚点+传送"模式可借鉴。

## G. 数值基线参考（BALANCE.md）

- 初期：气血 220 / 灵力 48 / 攻击 34 / 防御 18 / 速度 18 / 闪避 2% / 暴击 5% / 暴击倍率 1.5；灵石 120 开局。
- 数值原则：早期成长稳定短反馈；突破成本引导探索而非重复劳动；新资源必有来源和用途；难度按区域+境界递进；关键数值不进 UI 组件。
- 突破成功率带心境/悟性修正（与我们的实现同构）；大境界倍率表驱动装备模板/掉落/敌人强度。
