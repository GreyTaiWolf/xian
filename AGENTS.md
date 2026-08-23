# AGENTS.md

本仓库是一个网页端、移动端适配的修真刷宝 RPG，正在扩展为“网游风角色成长 + AI 动态世界模拟”。

## 开发前必须阅读

1. `README.md`
2. `docs/game-design.md`
3. `docs/ai-world-simulation.md`
4. `docs/ai-prompt-contracts.md`
5. `src/game/state.ts`
6. `src/simulation/index.ts`
7. 修改对应系统前，再阅读其配置表与自测文件。

## 不可违反的工程规则

- 变量、类型、文件名使用英文；文档与新增注释使用中文。
- 保留纯格子/程序化地图路线，不恢复图片大地图作为实际移动系统。
- 战斗、掉落、经济、人口、价格、关系结算由代码完成。
- AI 只能返回结构化候选，必须经过白名单、引用、范围与权限验证。
- AI 不得直接修改 `GameState`、`WorldSimulationState`、背包、货币、伤害、人口、资源和价格。
- 所有游戏逻辑随机行为必须使用可播种 RNG；禁止在正式运行逻辑中使用 `Math.random()`。
- 世界状态必须可 JSON 序列化、可迁移、可回放。
- 动态世界与旧玩法世界日必须保持一致，禁止只改 `world.day` 而不推进 `simulation`。
- 离线快进必须先于运行时对象构造完成，避免内存角色与 Store 状态分叉。
- 新系统优先写为独立纯模块，不把业务规则堆入 UI 组件。
- 不得把未完成或未验证内容标记为完成。

## 修改后最低验证

```bash
npm.cmd run typecheck
npm.cmd run selftest
npm.cmd run build
```

其中 `selftest` 必须同时覆盖原玩法回归和 `worldsim-selftest`。

涉及存档、时间或离线逻辑时，额外检查：

- 当前存档版本与迁移链连续；
- 旧档、损坏档、错误种子和超长世界日可安全归一；
- `simulationWorldDay(state.simulation) === state.world.day`；
- 离线天数受到硬上限保护；
- 同一输入的离线编年史选择可复现。

## 动态世界模块边界

- `src/simulation/types.ts`：纯数据模型。
- `src/simulation/state.ts`：确定性初始世界切片。
- `src/simulation/tick.ts`：小时、每日、每月规则推进。
- `src/simulation/integration.ts`：旧世界日、存档迁移与模拟时钟同步。
- `src/simulation/offline.ts`：离线时间规划、硬上限和确定性模板选择。
- `src/simulation/event-log.ts`：统一历史与因果记录。
- `src/simulation/ai-context.ts`：最小必要上下文。
- `src/simulation/ai-boundary.ts`：AI 命令安全门，不执行命令。
- `src/simulation/invariants.ts`：长时间模拟不变量。

## 当前开发顺序

1. [x] WS-P0：动态世界内核与验证。
2. [x] WS-P1：接入主存档、世界时间与离线快进。
3. [ ] WS-P2：把市场、生态、迁徙和世界事件显示到现有 UI，并形成动态任务闭环。
4. [ ] WS-P3：重要 NPC 知识、记忆、关系和聊天闭环。
5. [ ] WS-P4：公会、拍卖行、AI 冒险者和单人网游社会。
6. [ ] WS-P5：服务端权威、持久化与真正多人扩展准备。
