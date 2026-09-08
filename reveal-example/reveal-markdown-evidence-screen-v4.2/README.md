## v4.1 修复

- 修复双击 `index.html`（`file://`）时 Reveal 页面纵向堆叠、当前页跑到屏幕下方的问题。
- 保持 v4 多工程师协作布局与实时 API 不变。

# 智证先锋第二大屏 · reveal.js Markdown v4

基于 reveal.js 原生 Markdown。整体改为深蓝大屏风格，重点突出现场协作、事件状态与证据变化，不把它做成第二份PPT。

## 使用

- 双击 `index.html` 可直接打开内置版本。
- 修改 `slides.md` 后，可在左下角选择“打开 MD”；通过 HTTP 服务打开时会自动读取同目录 `slides.md`。
- `H` 隐藏工具栏；方向键翻页；Esc 总览。
- 如修改默认 `slides.md`，运行 `node build.mjs` 更新双击打开时的内置快照。

## v4重点

1. 深蓝色大屏视觉，与主PPT更统一。
2. 当前参与人数决定人物位置，不再永远只有一个主讲头像。
3. 侧边人物卡显示每位参与工程师在当前环节的具体任务与作用。
4. 底部四岗位协作条放大，始终保留团队并行状态。
5. 删除“本页目标”和泛泛的底部结论句。
6. `data-cue` 可显示事件提醒；JS提供实时更新接口，便于后续接 MQTT/WebSocket。

详细属性见 `TEMPLATE_GUIDE.md`。

需要交给 AI 修改 UI 时，请先让它完整阅读项目级指南：
`../../doc/REVEAL_MARKDOWN_UI_GUIDE.md`。
