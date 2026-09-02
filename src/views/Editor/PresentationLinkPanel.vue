<template>
  <div class="presentation-link-panel">
    <div class="desc">
      放映开始、切换页面、结束放映时，向外部大屏 / 服务端推送当前页码与演讲者备注（四字段 JSON）。两个通道相互独立，可只启用一个，也可同时启用。接收端请按消息 <b>id</b> 去重。
    </div>

    <Divider :margin="12" />

    <div class="section">
      <div class="section-title">
        <span class="name">MQTT 联动</span>
        <Switch v-model:value="draft.mqtt.enabled" @update:value="applyDraft()" />
        <span class="status" :class="levelClass(mqttLevel)">{{ mqttStatusLabel }}</span>
      </div>
      <div class="form">
        <div class="form-item">
          <span class="label">Broker 地址</span>
          <Input
            class="fill"
            v-model:value="draft.mqtt.url"
            placeholder="ws://broker:8083/mqtt 或 wss://（浏览器不支持 mqtt:// 直连）"
          ></Input>
        </div>
        <div class="form-item">
          <span class="label">用户名</span>
          <Input class="fill" v-model:value="draft.mqtt.username" placeholder="可留空"></Input>
          <span class="label">密码</span>
          <input
            class="pw-input fill"
            type="password"
            v-model="draft.mqtt.password"
            placeholder="可留空（掩码显示，日志不记录）"
            autocomplete="off"
          />
        </div>
        <div class="form-item">
          <span class="label">Client ID</span>
          <Input class="fill" v-model:value="draft.mqtt.clientId" placeholder="留空自动生成，避免多实例互踢"></Input>
          <span class="label">发布 Topic</span>
          <Input class="fill topic" v-model:value="draft.mqtt.topic" placeholder="presentation/events"></Input>
        </div>
        <div class="form-item">
          <span class="label">QoS</span>
          <Select
            class="fill qos"
            :width="90"
            v-model:value="mqttQos"
            :options="[{ label: '0', value: 0 }, { label: '1（默认）', value: 1 }, { label: '2', value: 2 }]"
          ></Select>
          <Checkbox class="retain" v-model:value="draft.mqtt.retain">retain（保留消息）</Checkbox>
        </div>
        <div class="btns">
          <Button size="small" @click="testConnection('mqtt')">连接测试</Button>
          <Button size="small" @click="connect('mqtt')">连接</Button>
          <Button size="small" @click="disconnect('mqtt')">断开</Button>
        </div>
      </div>
    </div>

    <Divider :margin="12" />

    <div class="section">
      <div class="section-title">
        <span class="name">WebSocket 联动</span>
        <Switch v-model:value="draft.ws.enabled" @update:value="applyDraft()" />
        <span class="status" :class="levelClass(wsLevel)">{{ wsStatusLabel }}</span>
      </div>
      <div class="form">
        <div class="form-item">
          <span class="label">服务地址</span>
          <Input class="fill" v-model:value="draft.ws.url" placeholder="ws://127.0.0.1:9001 或 wss://"></Input>
        </div>
        <div class="form-item">
          <span class="label">Token（可选）</span>
          <Input
            class="fill"
            v-model:value="draft.ws.token"
            placeholder="以 ?token=xxx 追加到地址（浏览器 WebSocket 无法自定义请求头）"
          ></Input>
        </div>
        <div class="btns">
          <Button size="small" @click="testConnection('ws')">连接测试</Button>
          <Button size="small" @click="connect('ws')">连接</Button>
          <Button size="small" @click="disconnect('ws')">断开</Button>
        </div>
      </div>
    </div>

    <Divider :margin="12" />

    <div class="section">
      <div class="btns">
        <Checkbox v-model:value="draft.rememberCredentials">
          记住密码与 Token（写入本机浏览器，刷新后仍可用）
        </Checkbox>
        <Button type="primary" size="small" @click="saveConfig()">保存配置</Button>
      </div>
      <div class="tip">不勾选时，密码 / Token 只保留在当前页面内存中，保存后刷新需重新输入；日志不显示任何鉴权信息。</div>
    </div>

    <Divider :margin="12" />

    <div class="section">
      <div class="section-title">
        <span class="name">最近发送的消息</span>
        <span class="sub" v-if="!sessionActive">（未在放映中）</span>
        <span class="sub active" v-else>（放映中）</span>
      </div>
      <pre class="preview">{{ lastMessagePreview }}</pre>
      <div class="recent" v-if="recentEvents.length">
        <div class="recent-item" v-for="item in recentEvents" :key="item.id">
          <span class="time">{{ item.time }}</span>
          <span class="event">{{ item.event }}</span>
          <span class="page">第 {{ item.page }} 页</span>
          <span class="id">id: {{ item.id }}</span>
          <span class="channels">{{ channelText(item) }}</span>
        </div>
      </div>
    </div>

    <Divider :margin="12" />

    <div class="section">
      <div class="section-title">
        <span class="name">日志</span>
        <span class="sub">（最多保留 {{ LOG_LIMIT }} 条）</span>
        <Button size="small" @click="clearLogs()">清空</Button>
      </div>
      <div class="logs">
        <div class="log-item" :class="item.level" v-for="item in logs" :key="item.id">
          <span class="time">{{ item.time }}</span>
          <span class="channel">[{{ item.channel }}]</span>
          <span class="text">{{ item.text }}</span>
        </div>
        <div class="log-empty" v-if="!logs.length">暂无日志</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, reactive, ref } from 'vue'
import {
  applyConfig,
  clearLogs,
  connectChannel,
  disconnectChannel,
  getRuntimePresentationLinkConfig,
  presentationLinkState,
  testChannel,
} from '@/utils/presentation/bridge'
import { CHANNEL_STATUS_LABELS, CHANNEL_STATUS_LEVELS } from '@/utils/presentation/protocol'
import type { ChannelId } from '@/utils/presentation/channels'
import type { PresentationLinkConfig } from '@/configs/presentationLink'
import message from '@/utils/message'

import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'
import Switch from '@/components/Switch.vue'
import Checkbox from '@/components/Checkbox.vue'
import Button from '@/components/Button.vue'
import Divider from '@/components/Divider.vue'

const LOG_LIMIT = 200

const draft = reactive<PresentationLinkConfig>(getRuntimePresentationLinkConfig())

const testChannelName = ref<ChannelId | null>(null)

const mqttStatusLabel = computed(() => CHANNEL_STATUS_LABELS[presentationLinkState.mqttStatus])
const wsStatusLabel = computed(() => CHANNEL_STATUS_LABELS[presentationLinkState.wsStatus])
const mqttLevel = computed(() => CHANNEL_STATUS_LEVELS[presentationLinkState.mqttStatus])
const wsLevel = computed(() => CHANNEL_STATUS_LEVELS[presentationLinkState.wsStatus])

const sessionActive = computed(() => presentationLinkState.sessionActive)
const recentEvents = computed(() => presentationLinkState.recentEvents)
const logs = computed(() => presentationLinkState.logs)

// Select 组件的 value 类型为 string | number，这里收敛为协议要求的 0 | 1 | 2
const mqttQos = computed({
  get: () => draft.mqtt.qos,
  set: value => {
    draft.mqtt.qos = value === 0 || value === 2 ? value : 1
  },
})

const lastMessagePreview = computed(() => {
  const first = presentationLinkState.recentEvents[0]
  if (!first) return '尚未发送消息。开始放映后将在此预览对外发送的 JSON。'
  try {
    return JSON.stringify(JSON.parse(first.text), null, 2)
  }
  catch {
    return first.text
  }
})

const channelText = (item: { mqtt: boolean; ws: boolean }) => {
  const channels = []
  if (item.mqtt) channels.push('MQTT')
  if (item.ws) channels.push('WebSocket')
  return channels.length ? channels.join(' + ') : '（未送达任何通道）'
}

const levelClass = (level: string) => `status-${level}`

function applyDraft() {
  applyConfig({ ...draft, mqtt: { ...draft.mqtt }, ws: { ...draft.ws } })
}

function saveConfig() {
  applyDraft()
  message.success('放映联动配置已保存')
}

function connect(channel: ChannelId) {
  draft[channel].enabled = true
  applyDraft()
  connectChannel(channel)
  message.success(channel === 'mqtt' ? '正在连接 MQTT Broker' : '正在连接 WebSocket 服务')
}

function disconnect(channel: ChannelId) {
  draft[channel].enabled = false
  disconnectChannel(channel)
}

async function testConnection(channel: ChannelId) {
  if (testChannelName.value) return
  testChannelName.value = channel
  try {
    const result = await testChannel(channel, {
      ...draft,
      mqtt: { ...draft.mqtt },
      ws: { ...draft.ws },
    })
    if (result.ok) message.success(`${channel === 'mqtt' ? 'MQTT' : 'WebSocket'} 连接测试成功`)
    else message.error(`连接测试失败：${result.error || '未知错误'}`)
  }
  finally {
    testChannelName.value = null
  }
}
</script>

<style lang="scss" scoped>
.presentation-link-panel {
  padding: 12px 20px 20px;
  font-size: 13px;
}
.desc {
  color: #666;
  line-height: 1.6;
}
.section {
  .section-title {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    margin-bottom: 10px;

    .name {
      font-weight: 700;
      margin-right: 10px;
    }
    .sub {
      color: #999;
      font-size: 12px;
      margin-right: 10px;

      &.active {
        color: $themeColor;
      }
    }
    .status {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: $borderRadius;

      &.status-neutral {
        background-color: #f1f2f4;
        color: #909399;
      }
      &.status-info {
        background-color: #e8f3ff;
        color: #338fe5;
      }
      &.status-success {
        background-color: #e8f7e8;
        color: #47a04b;
      }
      &.status-warning {
        background-color: #fdf2e2;
        color: #d08a1d;
      }
      &.status-error {
        background-color: #fdeaea;
        color: #d65050;
      }
    }
  }
  .form {
    .form-item {
      display: flex;
      justify-content: flex-start;
      align-items: center;
      margin-bottom: 8px;

      .label {
        flex-shrink: 0;
        width: 88px;
        color: #666;
      }
      .fill {
        flex: 1;
        min-width: 0;
        margin-right: 12px;

        &.topic {
          flex: 0 0 180px;
          margin-right: 0;
        }
        &.qos {
          flex: 0 0 110px;
          margin-right: 12px;
        }
      }
      .retain {
        flex-shrink: 0;
      }
    }
    .pw-input {
      height: 32px;
      outline: 0;
      border: 1px solid #d9d9d9;
      border-radius: $borderRadius;
      padding: 0 5px 0 10px;
      font-size: 13px;
      transition: border-color 0.25s;

      &:hover,
      &:focus {
        border-color: $themeColor;
      }
      &::placeholder {
        color: #bfbfbf;
      }
    }
  }
  .btns {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .tip {
    color: #999;
    font-size: 12px;
    line-height: 1.6;
  }
}
.preview {
  background-color: #f7f8fa;
  border: 1px solid $borderColor;
  border-radius: $borderRadius;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  margin: 0 0 8px;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.recent {
  max-height: 110px;
  overflow: auto;

  .recent-item {
    display: flex;
    align-items: center;
    font-size: 12px;
    color: #666;
    line-height: 22px;

    .time {
      color: #999;
      margin-right: 8px;
    }
    .event {
      font-weight: 700;
      margin-right: 8px;
    }
    .page {
      margin-right: 8px;
    }
    .id {
      margin-right: 8px;
      font-family: monospace;
    }
    .channels {
      color: $themeColor;
    }
  }
}
.logs {
  max-height: 150px;
  overflow: auto;
  background-color: #f7f8fa;
  border: 1px solid $borderColor;
  border-radius: $borderRadius;
  padding: 8px 10px;

  .log-item {
    font-size: 12px;
    line-height: 20px;
    color: #555;

    &.warn .text {
      color: #d08a1d;
    }
    &.error .text {
      color: #d65050;
    }
    .time {
      color: #999;
      margin-right: 6px;
    }
    .channel {
      margin-right: 6px;
      color: #888;
    }
  }
  .log-empty {
    font-size: 12px;
    color: #999;
    text-align: center;
  }
}
</style>
