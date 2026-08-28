# V2.0 战斗与秘境设计

## 目标

V2.0 把原先“靠近后瞬时扣血”的实现改为可观察、可打断、可测试的行动闭环。任何普通攻击、主动技能和怪物攻击都必须经过同一条确定性时间线；表现层只读取快照，不决定伤害、暴击、掉落或奖励。

## 战斗事实链

```text
queued → windup → travel → impact → recover → completed
                         │
                         └─ 唯一伤害结算点
```

- 排序规则：`priority↓ → readyAt↑ → speed↓ → actorKey → requestSeq`。
- 同一角色同一时间最多拥有一个进行中或待执行行动。
- `impact` 恰好发出一次；目标在此节点死亡时，其后续行动同步取消。
- 致命命中先进入 `dying`，保留 430ms 命中与退场演出，然后才进行收益、掉落和消失结算。
- 数值 RNG 与粒子 RNG 分流，修改粒子数量不会改变后续暴击或掉落。
- 主循环采用固定时间步；页面隐藏时清空积压，避免返回页面的一帧跳过整场战斗。

数值入口在 `src/config/combat.json`、`src/config/skills.json` 与 `src/config/monsters.json`，时间线纯模块在 `src/systems/combat.ts`。

## 三波秘境闭环

1. 在入口选择已解锁层数，生成确定性 `runId` 和首波 `encounterId`。
2. 每一波只追踪本 encounter 实际生成的怪物 ID；大世界、旧波次和重复死亡事件不会计入进度。
3. 前两波清空后进入 900ms 波间整备，第三波清空后通关。
4. 玩家陨落立即把挑战标记为失败，不写通关、不生成奖励。
5. 通关生成三件已入档候选，玩家择一；背包满时候选继续保留，不会吞奖励。
6. 领取后写入最高层、总通关数和世界日冷却，形成“挑战—结算—成长—下一层”的纵向循环。

## 视觉与布局

- 主色：墨黑底、暖金价值色、青色玩家/技能、朱红危险色。
- 主视野：当前目标、行动横幅、行动队列、秘境波次与小地图各自占据固定信息层，不用特效遮盖操作区。
- 技能区：三技能同时显示灵力、解锁与冷却；自动技能和 ×1/×2 战斗速度在顶栏可切换。
- 移动端：战斗视野优先，成长面板改为底部导航触发的抽屉；触控目标不小于 44px。
- 减少动态效果：遵循 `prefers-reduced-motion`，禁用震屏并降低位移、旋转和脉冲幅度。

## 研究参考与取舍

- [《崩坏：星穹铁道》行动序列资料](https://wiki.hoyolab.com/pc/hsr/entry/1247?lang=ja-jp)：参考可预判行动顺序，但本项目保持单通道实时推进，不复制回合制规则。
- [TapTap 战斗反馈讨论](https://www.taptap.cn/moment/461626100183731191)：提取“前摇可读、命中明确、收招完整”的反馈层级。
- [Material 3 Navigation Bar](https://m3.material.io/components/navigation-bar)：用于窄屏底部导航的信息优先级。
- [Android 无障碍触控默认值](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)：用于移动端触控尺寸。
- [WCAG：Animation from Interactions](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions)：用于减少动态效果策略。

参考只用于信息结构、反馈层级与可访问性；地图继续使用程序化格子 Canvas，战斗与奖励继续由确定性代码结算。
