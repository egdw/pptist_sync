<template>
  <div class="led-preview">
    <header><div><a href="/showflow">← 返回多屏联动编排</a><h1>LCD 预览与调试</h1><p>选择当前 Flow 中的实际副屏页面，按比赛现场相同数据生成四块 LCD。</p></div><div class="actions"><button class="secondary" @click="render">重新渲染</button><button class="primary" @click="publish" :disabled="!result">下发当前预览</button></div></header>

    <section class="panel flow-picker">
      <h2>当前 Flow 实际页面</h2>
      <label><span>选择步骤 / 副屏页</span><select v-model="selectedPageId" @change="applySelectedPage"><option value="">请选择包含 LCD 配置的页面</option><option v-for="item in flowPages" :key="item.key" :value="item.pageId">{{ item.label }}</option></select></label>
      <div class="source-info" v-if="selectedManifest">来源：{{ selectedManifest.lcd?.source.type }} · 页面：{{ selectedManifest.title }} · pageId：{{ selectedManifest.id }}</div>
      <div class="source-info warn" v-else>{{ flowLoadMessage }}</div>
    </section>

    <section class="panel portraits">
      <h2>岗位照片</h2>
      <div class="portrait-row" v-for="r in roles" :key="r"><strong>{{ names[r] }}</strong><span>默认使用内置的独立岗位照片</span><label class="upload">上传替换<input type="file" accept="image/png,image/jpeg,image/webp" @change="uploadPortrait(r, $event)"></label></div>
    </section>

    <details class="panel manual"><summary>手动调整当前状态（辅助调试）</summary><div class="form">
      <label><span>当前环节</span><input v-model="state.stage"></label>
      <label><span>主导岗位</span><select v-model="state.lead"><option v-for="r in roles" :key="r" :value="r">{{ names[r] }}</option></select></label>
      <label v-for="r in roles" :key="r"><span class="role-check"><input type="checkbox" :value="r" v-model="state.active"> {{ names[r] }}（进行中）</span><input v-model="state.roles[r].task" placeholder="当前任务"></label>
    </div><h3>LCD 独立样式</h3><div class="form theme-form"><label><span>背景色</span><input v-model="theme.background" type="color"></label><label><span>任务字号</span><input v-model.number="theme.taskFontSize" type="number" min="24" max="86"></label><label><span>岗位字号</span><input v-model.number="theme.roleFontSize" type="number" min="28" max="82"></label><label><span>阶段字号</span><input v-model.number="theme.stageFontSize" type="number" min="28" max="82"></label><label><span>任务最大行数</span><input v-model.number="theme.maxTaskLines" type="number" min="1" max="4"></label></div></details>

    <p class="status" :class="{ empty: !status }">{{ status || '选择 Flow 页面后将自动渲染' }}</p>
    <main><figure v-for="screen in result?.screens || []" :key="screen.role"><img :src="screen.url + '?v=' + result?.revision"><figcaption><strong>{{ names[screen.role] }}</strong><span>revision {{ result?.revision }}</span></figcaption><dl><dt>尺寸</dt><dd>{{ screen.width }} × {{ screen.height }}</dd><dt>格式</dt><dd>{{ screen.format }}</dd><dt>SHA256</dt><dd>{{ screen.sha256 }}</dd><dt>URL</dt><dd>{{ screen.url }}</dd></dl></figure><div v-if="!result" class="empty-preview">尚未生成预览</div></main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { LCD_ROLES, type LcdRole, type LcdSceneState, type PageManifest } from '@/show-flow/types'
import { renderLcdState, type LedRenderResult } from '@/show-flow/lcd/render-client'
import { publishPresentationMqtt } from '@/utils/presentation/bridge'
import { publishLcdRenderResult } from '@/show-flow/lcd/lcd-controller'
import { loadShowFlowState, loadShowFlowStateFromServer } from '@/show-flow/persistence'
import { buildPptistManifest, parseMarkdownManifest } from '@/show-flow/manifest'
import { fetchSecondaryDocSlides } from '@/services/defaultPpt'

const roles = LCD_ROLES
const names: Record<LcdRole, string> = { manager: '项目经理', platform: '平台系统开发工程师', twin: '数字孪生工程师', hardware: '软硬件调试工程师' }
const state = reactive<LcdSceneState>({ source: { type: 'pptist', pageId: 'preview' }, stage: '', lead: null, active: [], roles: { manager: { task: '' }, platform: { task: '' }, twin: { task: '' }, hardware: { task: '' } } })
const theme = reactive({ background: '#101b31', taskFontSize: 46, roleFontSize: 60, stageFontSize: 56, maxTaskLines: 3 })
const result = ref<LedRenderResult | null>(null)
const status = ref('')
const flowLoadMessage = ref('正在读取当前 Flow…')
const flowPages = ref<Array<{ key: string; pageId: string; label: string }>>([])
const selectedPageId = ref('')
const selectedManifest = ref<PageManifest | null>(null)
let manifest: PageManifest[] = []

onMounted(async () => {
  try { Object.assign(theme, (await (await fetch('/api/studio/lcd/themes/draft')).json()).config || {}) } catch { /* Studio 未配置时使用内置主题 */ }
  await loadFlowPages()
})

async function loadFlowPages() {
  try {
    const persisted = await loadShowFlowStateFromServer() || loadShowFlowState()
    const flows = persisted.flows?.length ? persisted.flows : [persisted.flow]
    const flow = flows.find(item => item.id === persisted.activeFlowId) || flows[0]
    const source = persisted.sources.find(item => item.id === flow.secondarySourceId) || persisted.sources.find(item => item.role === 'secondary')
    if (source?.kind === 'pptist-remote') manifest = buildPptistManifest((await fetchSecondaryDocSlides()).bundle.slides)
    else {
      const response = await fetch(source?.mdPath || '/reveal/slides.md', { cache: 'no-store' })
      if (!response.ok) throw new Error(`无法读取 Markdown（${response.status}）`)
      manifest = parseMarkdownManifest(await response.text())
    }
    const byId = new Map(manifest.map(page => [page.id, page]))
    let secondaryPageId: string | null = null
    flowPages.value = []
    flow.steps.forEach((step, index) => {
      if (step.secondary?.action === 'goto' && step.secondary.pageId) secondaryPageId = step.secondary.pageId
      const page = secondaryPageId ? byId.get(secondaryPageId) : undefined
      if (page?.lcd) flowPages.value.push({ key: `${step.id}-${page.id}`, pageId: page.id, label: `Step ${index + 1} · ${step.label || page.title}` })
    })
    // 同一副屏页面可能由多个 keep Step 引用，选择列表去重但保留首次出现顺序。
    flowPages.value = flowPages.value.filter((item, index, all) => all.findIndex(other => other.pageId === item.pageId) === index)
    if (!flowPages.value.length) { flowLoadMessage.value = '当前 Flow 没有包含 LCD 配置的副屏页面'; return }
    selectedPageId.value = flowPages.value[0].pageId
    await applySelectedPage()
  }
  catch (error) { flowLoadMessage.value = `读取 Flow 失败：${error instanceof Error ? error.message : error}` }
}

async function applySelectedPage() {
  const page = manifest.find(item => item.id === selectedPageId.value) || null
  selectedManifest.value = page
  if (!page?.lcd) return
  Object.assign(state, JSON.parse(JSON.stringify(page.lcd)))
  await render()
}

async function render() {
  try { status.value = '服务端渲染中…'; result.value = await renderLcdState(state, theme); status.value = `已按实际 LCD 状态生成 revision ${result.value.revision}` }
  catch (error) { status.value = `渲染失败：${error instanceof Error ? error.message : error}` }
}

async function uploadPortrait(role: LcdRole, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    status.value = `正在上传${names[role]}照片…`
    const response = await fetch(`/led-render-api/portrait/${role}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`)
    status.value = `${names[role]}照片已更新，正在重新渲染…`
    await render()
  }
  catch (error) { status.value = `照片上传失败：${error instanceof Error ? error.message : error}` }
  finally { input.value = '' }
}

function publish() {
  if (!result.value) return
  const sent = publishLcdRenderResult(result.value, publishPresentationMqtt)
  status.value = sent === 4 ? '已通过主控 MQTT 下发四块 LCD' : `仅成功下发 ${sent}/4，请检查 MQTT 连接`
}
</script>

<style scoped>
.led-preview{height:100vh;overflow-y:auto;background:#f2f3f7;color:#30343b;padding:22px 26px 40px;box-sizing:border-box;font-family:Arial,"Microsoft YaHei",sans-serif}header{display:flex;align-items:flex-end;gap:24px;max-width:1440px;margin:0 auto 16px}header>div:first-child{flex:1}a{color:#526fae;text-decoration:none;font-size:13px}h1{margin:8px 0 4px;font-size:25px;color:#242833}header p{margin:0;color:#646c79;font-size:13px}.actions{display:flex;gap:8px}button,.upload{padding:9px 18px;border:1px solid #c7cdd8;border-radius:6px;cursor:pointer;font-weight:600;background:#fff}button.primary{background:#526fae;color:#fff;border-color:#526fae}button:disabled{opacity:.45;cursor:not-allowed}.panel{max-width:1440px;margin:0 auto 12px;background:#fff;border:1px solid #dfe2e8;border-radius:9px;box-shadow:0 1px 4px rgba(32,40,60,.06);box-sizing:border-box;padding:18px}.panel h2{margin:0 0 12px;font-size:15px}.flow-picker label{display:flex;align-items:center;gap:12px}.flow-picker label span{width:160px}.flow-picker select{flex:1}.source-info{margin-top:10px;color:#536079;font-size:12px}.source-info.warn{color:#a06a22}.portraits{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 20px}.portraits h2{grid-column:1/-1}.portrait-row{display:flex;align-items:center;gap:10px;border:1px solid #e6e8ed;border-radius:6px;padding:9px}.portrait-row strong{width:145px}.portrait-row span{flex:1;color:#737b88;font-size:12px}.upload{padding:6px 10px;color:#526fae;font-size:12px}.upload input{display:none}.manual summary{cursor:pointer;font-weight:600;font-size:14px}.form{display:grid;grid-template-columns:repeat(2,minmax(280px,1fr));gap:12px 22px;padding-top:16px}.form label{display:flex;align-items:center;gap:12px;font-size:13px}.form label>span{width:160px;flex-shrink:0}.form label>input,.form select,.flow-picker select{min-width:0;padding:9px 10px;border:1px solid #c7cdd7;border-radius:5px;background:#fff;color:#252a32}.form label>input,.form select{flex:1}.status{max-width:1440px;margin:12px auto;color:#365a9d;background:#e4edff;border-radius:5px;padding:8px 12px;box-sizing:border-box;font-size:13px}.status.empty{color:#666e7a;background:#e3e5e9}main{max-width:1440px;margin:0 auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;background:#fff;padding:10px;border:1px solid #d9dde5;border-radius:9px;box-shadow:0 2px 8px rgba(30,40,60,.07)}img{display:block;width:100%;aspect-ratio:16/10;object-fit:contain;background:#101522;border-radius:5px}figcaption{display:flex;justify-content:space-between;padding:9px 2px 1px;color:#414854;font-size:13px}figcaption span{color:#737b88}.empty-preview{grid-column:1/-1;min-height:260px;display:flex;align-items:center;justify-content:center;background:#fff;border:1px dashed #bdc4d0;border-radius:9px;color:#737b88}@media(max-width:900px){.led-preview{padding:16px}header{align-items:stretch;flex-direction:column}.actions{justify-content:flex-end}main,.form,.portraits{grid-template-columns:1fr}.portraits h2{grid-column:auto}.flow-picker label{align-items:flex-start;flex-direction:column}.flow-picker label span{width:auto}.flow-picker select{width:100%}}
dl{display:grid;grid-template-columns:55px minmax(0,1fr);gap:4px;margin:8px 2px 2px;font-size:11px;color:#737b88}dt{font-weight:600}dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.manual h3{font-size:14px;margin:20px 0 0;border-top:1px solid #e5e8ee;padding-top:16px}
</style>
