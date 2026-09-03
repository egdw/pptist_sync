# 第二大屏 v4 模板规则

## 核心变化

- 深蓝大屏风格，与主PPT视觉更接近。
- 不再固定“左侧一个主讲人”。当前参与人数决定人物布局：
  - 1人：左侧1人；
  - 2人：左侧上下2人；
  - 3人：左侧2人 + 右侧1人；
  - 4人：左侧2人 + 右侧2人。
- 侧边人物卡负责讲清楚“这个工程师在本环节具体做什么、起什么作用”。
- 底部协作状态条保留四人，只显示粗粒度任务，字体和高度已放大。
- 删除“本页目标”字段。顶部只显示“当前环节”。
- `data-cue` 仅在确有实时变化值得评委注意时出现，不要求每页都写。

## Markdown 页面属性

```markdown
<!-- .slide: class="action"
 data-stage="车端联调"
 data-lead="hardware"
 data-active="hardware,platform,manager"
 data-role-detail="hardware=执行方向盘与踏板操作|产生真实输入并检查设备响应;platform=观察黑匣子实时数据|确认方向、数值和状态正确显示;manager=发起接口测试并核对结果|确认车端到平台链路打通"
 data-collab="manager=确认联调;platform=核对数据;hardware=执行操作;twin=准备仿真"
 data-cue="现场操作发生时，对应数据卡实时高亮"
 data-transition="slide" -->
```

- `data-active`：当前真正参与这一环节的岗位。
- `data-lead`：可选，当前主导岗位。
- `data-role-detail`：侧边大卡片详细任务，格式 `岗位=具体任务|本环节作用`。
- `data-collab`：底部粗粒度状态，文字应更短。
- `data-cue`：可选，仅用于值得评委关注的实时变化。

## HTML实时更新接口

网页加载后会暴露 `window.SecondScreen`，后续可直接接 MQTT/WebSocket 适配器：

```js
SecondScreen.goto(4)
SecondScreen.cue('事故记录写入成功，正在自动查询同一事故')
SecondScreen.role('platform', '正在查询本次事故', true)
SecondScreen.focus(1)
SecondScreen.value('speed', '42 km/h')
```

也可以发送浏览器事件：

```js
window.dispatchEvent(new CustomEvent('second-screen:update', {
  detail: {
    cue: '碰撞事件已触发',
    focus: 2,
    role: { key: 'platform', task: '锁定事故片段', active: true }
  }
}))
```

这样实时数据、事故触发、训练完成、连接异常等都可以在当前页面局部更新，不需要像PPT一样为了状态变化额外翻页。
