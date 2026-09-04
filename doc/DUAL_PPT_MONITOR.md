# 双 PPT 合成监控

联动放映中，主屏和副屏各自上传当前页面的轻量 JPEG 截图。服务端按顺序合成为
`1280×800`：主屏在左、Reveal/PPTist 副屏在右；页码分别绘制在左上和右上。

服务端会将每次合成保存为独立 revision：

```text
/monitor-api/display/42.jpg
```

MQTT 默认 Topic 为 `presentation/led/display`，QoS 1、retain。Payload 保持
`led-display/1.0`：`revision`、`image.url`、`image.sha256` 对应同一份不可变 JPEG。
板端不得把旧 revision 的 SHA256 用来校验新的 URL。

服务端从“放映联动”已保存的 MQTT 配置连接 Broker 并发布，不依赖主屏浏览器；因此主、副屏
无论哪一端最后完成渲染，都会发布最新合成图。连续切换时发布器仅保留最新待发送 revision，
不会让板端排队下载过时页面。

可用接口：

- `GET /monitor-api/status`：revision、当前主副页码和 MQTT 状态。
- `GET /monitor-api/display`：兼容入口，返回当前图。
- `GET /monitor-api/display/:revision.jpg`：不可变 revision 图片，供板端使用。

部署时必须设置可从板端访问的 `PPTIST_PUBLIC_URL`，例如：

```text
PPTIST_PUBLIC_URL=http://192.168.2.10:8686
PPTIST_MONITOR_MQTT_TOPIC=presentation/led/display
```
