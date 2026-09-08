# Reveal Markdown 副屏 UI 修改指南（含 AI 操作约束）

这份文档用于修改 `/reveal/` 副屏的页面内容和视觉。目标是让不了解本项目的 AI 也能安全调整 UI，同时不破坏 ShowFlow、LCD、页面 ID 和主副屏同步。

## 1. 先理解四个文件的职责

实际目录：`reveal-example/reveal-markdown-evidence-screen-v4.2/`

| 文件 | 职责 | 通常何时修改 |
| --- | --- | --- |
| `slides.md` | 页面内容、稳定页面 ID、业务语义和 LCD 元数据 | 改文字、增删页面、换图片、调整岗位状态 |
| `theme.css` | Reveal 页面视觉 | 改颜色、字号、留白、卡片、头像位置、响应式布局 |
| `app.js` | 把 Markdown 页面增强成舞台条、人物卡、协作条等 UI | 改自动生成的 DOM 结构或交互 |
| `showflow.js` | ShowFlow 的 NAVIGATE/ACK/SYNC_STATE 客户端 | 一般禁止修改 |
| `index.html` | Reveal 容器和脚本入口 | 增加全局资源时才修改 |
| `embedded.js` | `slides.md` 的离线快照，由脚本生成 | 不要手改 |

LCD 不从 Reveal DOM 读取。LCD 的数据路径是：

```text
slides.md 属性 → src/show-flow/manifest.ts → LcdSceneState
→ ShowFlow Controller → 服务端 Renderer → JPEG → MQTT
```

因此，重写 `theme.css`、删除协作栏 DOM、改变人物卡位置，都不应影响 LCD。

## 2. AI 修改时必须遵守的边界

可以修改：

- `slides.md` 的普通 Markdown 正文；
- `theme.css`；
- `app.js` 中只负责页面显示的代码；
- `assets/` 和 `portraits/` 中的页面素材。

不得做：

- 不要从 `.collab-bar`、人物卡、`innerText`、`classList` 或其他 DOM 推导 LCD 状态；
- 不要在 Reveal 的 `slidechanged` 中发布 LCD MQTT；
- 不要让 Reveal 页面调用 `/led-render-api/render`；
- 不要修改 `showflow.js` 的 ACK 时机和协议，除非任务明确要求修改通信协议；
- 不要删除或随意改变已有 `data-page-id`；
- 不要手工修改 `embedded.js`；
- 不要把 LCD 样式写进 `theme.css`。LCD 样式只在 `server/led/templates/` 修改。

## 3. 可复制的标准页面模板

```markdown
<!-- .slide: class="action"
 data-page-id="flow-04"
 data-stage="车端联调"
 data-lead="hardware"
 data-active="manager,platform,hardware"
 data-role-detail="manager=发起测试并核对结果|控制测试节奏;platform=观察实时数据|确认平台显示正确;hardware=执行方向盘与踏板操作|产生真实设备输入;twin=准备下一阶段仿真|保持环境就绪"
 data-collab="manager=确认联调;platform=核对数据;twin=准备仿真;hardware=执行操作"
 data-cue="现场操作发生时，对应数据卡实时高亮"
 data-transition="slide" -->
# 方向盘和踏板数据进入行车黑匣子
现场操作、采集结果和平台显示同步核对

- **现场操作** 方向盘 / 油门 / 刹车
- **实时采集** 转角与踏板深度
- **平台显示** 黑匣子同步更新
```

页面之间使用单独一行 `---` 分隔。

## 4. 属性说明

### 同时影响页面语义和 LCD

- `data-page-id`：稳定页面 ID。创建后不要因标题或排序改变而修改。
- `data-stage`：当前环节，进入 LCD 的 `stage`。
- `data-lead`：主导岗位，可为空。
- `data-active`：正在参与操作的岗位，英文逗号分隔。
- `data-collab`：四岗位简短任务，进入 LCD 的 `roles.*.task`。

固定岗位 key：

| key | 中文岗位 |
| --- | --- |
| `manager` | 项目经理 |
| `platform` | 平台系统开发工程师 |
| `twin` | 数字孪生工程师 |
| `hardware` | 软硬件调试工程师 |

`data-collab` 推荐始终写完整四岗位：

```text
manager=确认联调;platform=核对数据;twin=准备仿真;hardware=执行操作
```

### 只影响 Reveal 页面 UI

- `class`：页面视觉类型，例如 `team`、`problem`、`parallel`、`action`、`compare`、`timeline`、`scene`、`evidence`、`reasoning`、`results`、`closing`。
- `data-role-detail`：人物大卡片的详细说明，格式为 `岗位=任务|作用;岗位=任务|作用`。
- `data-cue`：页面上的现场提醒，可不写。
- `data-transition`：Reveal 切页动画，例如 `fade` 或 `slide`。

注意：`data-role-detail` 和 `data-cue` 当前不进入 LCD。

## 5. 常见 UI 修改方法

### 只改颜色、字体、间距或卡片尺寸

只编辑 `theme.css`。优先修改现有选择器和 CSS 变量，不要在 `slides.md` 写内联样式。

### 改人物照片

Reveal 页面照片放在：

```text
portraits/manager.png
portraits/platform.png
portraits/twin.png
portraits/hardware.png
```

保持文件名不变即可替换。LCD 电子工牌照片是服务端独立资产，应在 `/led-preview` 上传；两者不要求使用同一份文件。

### 改自动生成的舞台条、人物卡或协作栏

编辑 `app.js`，先搜索这些函数或类名：

- `stage-strip`
- `live-cue`
- `collab-bar`
- `collab-grid`
- `collab-item`
- `data-role-detail` / `dataset.roleDetail`

可以彻底改变这些 DOM，但必须继续保证 LCD 不依赖它们。

### 删除底部协作栏

可以删除或禁用 `app.js` 创建 `.collab-bar` 的代码，并清理 `theme.css` 对应样式。不要删除 `slides.md` 中的 `data-collab`，因为 LCD 仍使用该语义数据。

### 增加新页面类型

1. 在 `slides.md` 给页面设置新的 class，例如 `class="dashboard"`；
2. 在 `theme.css` 添加 `.reveal .slides section.dashboard ...`；
3. 如果只靠 CSS 可以实现，不要修改 `app.js`；
4. 保留该页全部语义属性。

## 6. 图片和 Markdown 注意事项

- 图片使用相对于 Reveal 目录的路径，例如 `![说明](assets/example.svg)`；
- 不要使用开发电脑的绝对路径；
- 属性值使用双引号；
- 属性内部不要直接放未转义的双引号；
- `data-active` 使用英文逗号；
- `data-collab` 和 `data-role-detail` 使用英文分号分隔岗位；
- H1 使用一个 `#`，每页建议只有一个 H1；
- 页面 ID 应有明确规律，例如 `flow-01`、`flow-02`。

## 7. 修改后的运行和验证

启动服务：

```powershell
npm run server
```

检查页面：

- Reveal 页面：`http://localhost:8686/reveal/`
- ShowFlow 编排：`http://localhost:8686/showflow`
- LCD 真实状态预览：`http://localhost:8686/led-preview`

修改 `slides.md` 后，HTTP 模式会直接读取它。如果还需要双击 `index.html` 离线预览，运行：

```powershell
node reveal-example/reveal-markdown-evidence-screen-v4.2/build.mjs
```

然后执行项目检查：

```powershell
npm run type-check
npm run test:showflow:reconciliation
npm run test:showflow:lcd
npm run build-only
```

人工验收至少包括：

1. Reveal 能正常显示并翻页；
2. ShowFlow 清单中的页面 ID 和顺序正确；
3. NAVIGATE 后副屏仍能 ACK；
4. `/led-preview` 能从当前 Flow 选择该页面；
5. 改 CSS 或删除协作栏后，LCD 状态不变化；
6. 没有 LCD 语义属性的页面不会触发新的 LCD 下发。

## 8. 可直接交给 AI 的任务提示词

```text
请修改 reveal-example/reveal-markdown-evidence-screen-v4.2 的 Reveal Markdown 副屏 UI。

开始前完整阅读 doc/REVEAL_MARKDOWN_UI_GUIDE.md。

允许修改 slides.md 的正文、theme.css、页面显示相关的 app.js 和页面素材。
必须保留所有已有 data-page-id，不得把 LCD 数据改成从 DOM 读取，不得在 Reveal
slidechanged 中发布 LCD MQTT，不得修改 ShowFlow ACK/WS 架构。

data-stage、data-lead、data-active、data-collab 是独立语义数据；即使删除或重写
人物卡和底部协作栏，也必须保留这些属性。LCD 样式不属于 Reveal theme.css。

修改完成后运行类型检查、ShowFlow reconciliation、LCD 测试和生产构建，并说明：
1. 修改了哪些 UI 文件；
2. 是否改变语义属性；
3. 如何确认 LCD 与 DOM 仍然解耦。
```

