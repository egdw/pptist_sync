# 放映联动（PPTist 放映事件通过 MQTT / WebSocket 对外发送）

本文档描述在 PPTist 中新增的「放映联动」能力：放映开始、切换页面、结束放映时，
将**当前页码 + 演讲者备注**以统一的四字段 JSON 通过 MQTT（over WebSocket）和/或
WebSocket 发送给外部服务（流程图大屏、ESP32-P4 小屏等）。

本改造只涉及 PPTist 的事件发送与连接配置，不改动原有的导入、编辑、播放、GIF
显示与观众窗口同步功能。

---

## 1. 消息协议（严格四字段，无外层包装）

MQTT 与 WebSocket 发送**完全相同**的 JSON 对象（`JSON.stringify` 后的文本）：

```json
{
  "event": "slide.changed",
  "page": 5,
  "id": "V1StGXR8_Z5jdHi6",
  "notes": "当前页的演讲者备注。\n保留换行。"
}
```

| 字段 | 说明 |
| --- | --- |
| `event` | 仅三种：`presentation.started` / `slide.changed` / `presentation.ended` |
| `page` | 对外页码，从 1 开始的整数 |
| `id` | 每次真实事件生成一次（复用项目内 nanoid）。同一次事件经两条通道发送时共用同一 id 与同一份数据 |
| `notes` | 当前页演讲者备注（`slide.remark`）转纯文本；无备注为 `""`；保留中文、标点与换行 |

不包含 `version`、`timestamp`、`session_id`、`seq`、`slide_id`、`previous_page`、`sync` 等任何附加字段。

### 三个事件示例

```json
{ "event": "presentation.started", "page": 1, "id": "kX9f2LqT8sB1cD00", "notes": "" }
```

```json
{
  "event": "slide.changed",
  "page": 5,
  "id": "V1StGXR8_Z5jdHi6",
  "notes": "本页要点：\n1. 项目背景\n2. 实施路径"
}
```

```json
{ "event": "presentation.ended", "page": 12, "id": "aZ83mNpQ6rT4eF72", "notes": "谢谢观看" }
```

### 事件语义

- `presentation.started`：开始放映，携带开始播放页的页码与备注（从中间页开始也正确）。
- `slide.changed`：实际切换页面（含后退、右键翻页、缩略图跳页、页内链接跳页、自动放映等），
  携带切换后的页码与备注。表示逻辑页面已切换，不等图片加载或过渡动画完成。
- `presentation.ended`：正常结束或退出放映，携带最后停留页的页码与备注。

### 触发规则（实现行为）

1. 事件统一由**主控窗口的放映状态与实际页码变化**驱动（监听 `screen.screening` 与
   `slides.slideIndex`），不在各按键/按钮中分散发送；键盘、翻页笔、播放按钮、滚轮、
   触摸滑动、右键菜单、缩略图、页内链接、自动放映全部覆盖。
2. 相同页码不重复触发（首页按上一页、末页按下一页、跳转到当前页均不发送）。
3. 开始放映只发一次 `started`，不补发同页 `slide.changed`；结束放映只发一次 `ended`，
   在状态清理前保存最后停留页。
4. 编辑模式选页、导入、调整页序不发送；观众窗口只跟随显示，不发送。
5. 普通/演讲者视图互相切换不视为重新开始；仅退出全屏继续放映不发送 `ended`。
6. 发送全程 try/catch + 发后即忘，网络异常不会阻塞翻页。
7. 断线期间不缓存消息、不建立历史重放队列；连接恢复时仅重发本次放映最近一条状态
   （沿用原 id 与原四字段数据）。

> **重复说明**：MQTT QoS>0 的重传机制或同时启用两条通道，会使同一事件被接收端收到多次。
> 接收端应以 `id` 去重。浏览器崩溃/断电时 `ended` 可能无法发出，不承诺可靠送达。

---

## 2. 配置界面

位置：**编辑器 → 左上主菜单（≡）→「放映联动」**。观众放映画面无任何新增界面元素。

- **MQTT 联动**：启用开关；Broker 地址（仅支持 `ws://` / `wss://`，即 MQTT over WebSocket，
  浏览器无法直连 `mqtt://` 或 TCP 1883）；用户名、密码（掩码输入）；Client ID（留空自动
  生成随机后缀，避免多个浏览器实例互踢）；发布 Topic（默认 `presentation/events`）；
  QoS（默认 1）；retain（默认关闭）。按钮：连接测试 / 连接 / 断开。
- **WebSocket 联动**：启用开关；服务地址（`ws://` / `wss://`）；可选 Token
  （以 `?token=xxx` 追加到地址——浏览器 WebSocket 不支持自定义请求头）。
  按钮：连接测试 / 连接 / 断开。
- **凭据**：默认不勾选「记住密码与 Token」，密码/Token 只保存在当前页面内存，保存后刷新
  需重新输入，localStorage 中不落盘；勾选后明文写入本机浏览器 localStorage。日志永远
  不显示密码/Token。
- **状态与日志**：每个通道显示 未启用/未连接/连接中/已连接/重连中/连接失败；面板内可见
  最近发送消息的 JSON 预览、最近发送列表（含送达通道）、运行日志（上限 200 条，可清空）。
- 配置保存在 localStorage（键 `PPTIST_PRESENTATION_LINK`），刷新后仍可用；地址与 Topic
  均为用户配置，无硬编码。

WS 重连采用指数退避（1s 起，30s 封顶）；MQTT 由 MQTT.js 内置重连（固定 5s 周期，有界）。

---

## 3. 启动与构建

```bash
npm install        # 安装依赖（含新增的 mqtt）
npm run dev        # 开发调试，默认 http://127.0.0.1:5173
npm run build      # 生产构建（含 vue-tsc 类型检查）
npm run type-check # 仅类型检查
```

## 4. 本地验证

### 4.1 自动化针对性验证（40 项，已通过）

```bash
# 首次运行需一次性安装本地测试 Broker（不会写入 package.json）：
npm install --no-save aedes websocket-stream
npm run test:presentation
```

覆盖：备注转换（普通文本/中文多行/比较符号/富文本段落 br 列表/实体/script 跳过）、
会话状态机（started 唯一、真实切页、同页去重、ended 最后页、id 唯一、页码备注原子性）、
桥接等价集成（编辑模式不发、视图切换不重启、全屏语义、四字段协议）、
WebSocket/MQTT 双通道本地实测（真实连接、双通道同 id 同内容、单通道故障不影响另一条、
断线不重放、重发沿用原 id、日志无鉴权信息）。

### 4.2 最小 WebSocket 接收示例

```bash
npm install ws
node examples/ws-receiver.mjs 9001
# PPTist「放映联动」中启用 WebSocket，地址填 ws://127.0.0.1:9001，保存后开始放映
```

### 4.3 MQTT 订阅验证

任选其一（Broker 需开启 WebSocket 监听，如 EMQX/Mosquitto 的 8083 端口）：

```bash
# mosquitto 客户端（注意 -h 指向 Broker，WS 与 TCP 端口不同）
mosquitto_sub -h <broker> -p 1883 -t 'presentation/events' -v

# 或用 Node + mqtt.js 订阅（与 PPTist 相同协议栈）
node -e "
const mqtt = require('mqtt')
const c = mqtt.connect('ws://<broker>:8083')
c.on('connect', () => c.subscribe('presentation/events'))
c.on('message', (t, m) => console.log(t, m.toString()))
"
```

---

## 5. 实现结构（新增/修改文件）

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/configs/presentationLink.ts` | 配置类型、默认值、localStorage 读写（密码按「记住凭据」决定是否落盘） |
| `src/utils/presentation/protocol.ts` | 四字段协议构建、通道状态枚举与中文标签 |
| `src/utils/presentation/session.ts` | 放映会话状态机（纯逻辑）：started/changed/ended 判定、同页去重 |
| `src/utils/presentation/remarkText.ts` | `remark` → 纯文本（块级标签转换行、实体解码、跳过 script/style，不创建 DOM） |
| `src/utils/presentation/channels.ts` | WsLink / MqttLink 双通道（重连退避、状态回报、连接测试） |
| `src/utils/presentation/bridge.ts` | 单例桥接：挂载/清理监听、事件扇出到双通道、日志与状态（响应式） |
| `src/views/Editor/PresentationLinkPanel.vue` | 「放映联动」设置面板 |
| `examples/ws-receiver.mjs` | 最小本地 WebSocket 接收示例 |
| `tests/presentation-link/` | 针对性验证（`npm run test:presentation`） |

### 修改（最小化）

| 文件 | 改动 |
| --- | --- |
| `src/App.vue` | 非观众窗口挂载/卸载桥接（2 行 + import） |
| `src/store/main.ts` | 新增设置面板开关状态（沿用既有面板模式） |
| `src/views/Editor/EditorHeader/index.vue` | 主菜单「放映联动」入口 + Modal 挂载面板 |
| `package.json` | 新增依赖 `mqtt@^5.15.2`；新增脚本 `test:presentation` |
| `src/components/Message.vue`、`src/hooks/useLoadSlides.ts`、`src/views/Screen/CountdownTimer.vue` | 修复**上游原有**的类型错误（定时器 ref 类型标注），否则 `npm run build` 无法通过 |
| `src/views/Screen/hooks/useExecPlay.ts`、`src/views/components/element/VideoElement/VideoPlayer/index.vue` | 同上（`window.setTimeout`/`window.setInterval` 前缀） |

原 BroadcastChannel 观众同步、GIF 渲染等路径均未改动。

---

## 6. 已验证内容与待人工联调项目

### 已在本地实测通过

- 类型检查（`vue-tsc`）、生产构建（`vite build`）通过。
- 40 项针对性验证全部通过（含 WebSocket 服务端与本地 MQTT Broker 的真实收发）。
- 备注：PPTist 编辑器保存的 HTML 备注（段落/列表/加粗等）与纯文本备注均正确转换；
  保存（`slide.remark`）→ 放映读取路径与上游一致，PPTX 导入备注字段（`remark: item.note`）未改动。

### 需要真实环境人工联调

- 真实 Broker（EMQX/Mosquitto/云服务）下的鉴权、TLS（wss）、QoS 行为。
- 浏览器中的端到端手测（建议步骤）：
  1. `npm run dev` → 打开 PPTist，导入含中文多行备注、GIF 的 PPTX 或新建备注；
  2. 启动 `node examples/ws-receiver.mjs 9001`，在「放映联动」中启用 WebSocket 并保存；
  3. F5 放映：确认 started 一次；键盘/滚轮/右键/缩略图翻页：每次真实切页一条 changed；
     首末页越界翻页无消息；ESC 退出：ended 带最后页备注；
  4. 从中间页放映一次，确认 started 页码正确；
  5. 打开观众视图窗口：确认观众窗口操作/显示不产生额外消息；
  6. 断开接收端后翻页再重启接收端：确认无历史重放、恢复后仅一条最近状态（原 id）。

### 已知限制

- 浏览器不保证崩溃/断电时发出 `ended`；接收端应按 `id` 去重并容忍重复。
- 观众窗口（`?mode=audience`）不发送事件；放映事件只来自主控窗口。
- MQTT 重连为 MQTT.js 内置固定周期（5s），非指数退避；WS 为指数退避（封顶 30s）。
- 密码「记住凭据」选项开启时明文存于本机 localStorage，请注意设备安全。
- 上游版本基线为 e4912589 对应代码结构；本仓库无 git 历史，未做版本回退。
