# ShowFlow Studio

访问 `/studio`（默认 `/studio/slides`）可在浏览器中维护 Reveal Markdown 内容。

## 内容生命周期

Studio 编辑器只写 `data/studio/draft/slides.md`。正式 Reveal 页面只读取
`data/studio/active/slides.md`。点击发布时，服务端先原子写入版本快照，再原子切换 Active；
正在运行的 ShowFlow 不会被强制跳页。历史版本恢复只会复制为 Draft，需要再次发布。

持久化目录：

- `data/studio/draft/`：草稿。
- `data/studio/active/`：正式内容。
- `data/studio/versions/`：发布历史。
- `data/studio/assets/`：上传素材。
- `data/studio/themes/`：Reveal 主题目录。
- `data/studio/lcd-themes/`：LCD 主题配置目录。

## 页面

- `/studio/slides`：页面列表、拖拽排序、可视化字段、Markdown 源码、实时 Draft 预览、发布和历史恢复。
- `/studio/assets`：PNG/JPG/JPEG/GIF/SVG/WebP 素材上传、预览、复制 URL 和删除。
- `/studio/theme`：Reveal Theme ZIP 安全上传、Draft 预览、随内容发布生效和删除保护。
- `/studio/lcd`：LCD Theme ZIP、Draft 参数、发布/回滚、四岗位 Renderer 调试入口和 PPT LCD Remark 生成器。
- `/studio/system`：Studio 与 Runtime 基础状态。

## 升级与回滚

升级前备份 `data/`，用新部署包覆盖程序文件但保留 `data/`，再重启服务。程序版本回滚时同样保留
`data/studio/`；内容回滚在“版本历史”选择“复制为草稿”，预览确认后发布。

Studio 不是 Runtime 依赖。关闭 Studio 浏览器页面不会影响 ShowFlow、Reveal Active 内容、LCD、
MQTT 或 WebSocket。

Theme ZIP 必须包含 `theme.css`，只允许网页视觉资源。服务端拒绝绝对路径、`..`、符号链接、
非法扩展名、超大文件和过多文件；上传内容不能覆盖 Reveal core 或服务器文件。
主题页可以下载当前正式主题或 Draft 主题。导出的 ZIP 包含 `theme.css`、
`theme-manifest.json` 和 `AI-修改说明.md`，可直接交给 AI 修改后重新上传。

LCD Theme ZIP 必须包含 `lcd-theme.json`。支持字段为 `background`、`taskFontSize`、
`roleFontSize`、`stageFontSize`、`maxTaskLines`。这些字段只进入 LCD Renderer，不修改
`LcdSceneState`、MQTT Topic、`led-display/1.0` Payload、revision 或 SHA256 机制。

`/studio/system` 展示服务端、Reveal、Renderer、WebSocket 角色连接、最后消息、最后 ACK、
最后心跳以及最近一次 LCD 渲染结果。当前板端协议没有定义 ACK/心跳/RSSI 回传 Topic 时，
页面明确标为“未回传”，不会把未知状态伪装成在线。
