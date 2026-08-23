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
- 所有随机行为必须使用可播种 RNG；禁止使用 `Math.random()`。
- 世界状态必须可 JSON 序列化、可迁移、可回放。
- 新系统优先写为独立纯模块，不把业务规则堆入 UI 组件。
- 不得把未完成或未验证内容标记为完成。

## 修改后最低验证

```bash
npm.cmd run typecheck
npm.cmd run selftest
npm.cmd run build
```

其中 `selftest` 必须同时覆盖原玩法回归和 `worldsim-selftest`。

## 动态世界模块边界

- `src/simulation/types.ts`：纯数据模型。
- `src/simulation/state.ts`：确定性初始世界切片。
- `src/simulation/tick.ts`：小时/每日/每月规则推进。
- `src/simulation/event-log.ts`：统一历史与因果记录。
- `src/simulation/ai-context.ts`：最小必要上下文。
- `src/simulation/ai-boundary.ts`：AI 命令安全门，不执行命令。
- `src/simulation/invariants.ts`：长时间模拟不变量。

## 当前开发顺序

1. WS-P0：动态世界内核与验证。
2. WS-P1：接入主存档和离线快进。
3. WS-P2：把市场、生态和世界事件显示到现有 UI。
4. WS-P3：重要 NPC 知识、记忆、关系和聊天闭环。
5. 之后再扩展公会、拍卖行、AI 冒险者和真正多人服务端。
