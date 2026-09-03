<template>
  <div class="studio">
    <header>
      <div><strong>ShowFlow Studio</strong><span>浏览器内容工作台</span></div>
      <div class="state" :class="status?.dirty ? 'dirty' : 'published'">{{ status?.dirty ? '已保存为草稿 · 未发布' : '已发布' }}</div>
      <button v-if="['slides','theme','lcd'].includes(module)" class="primary" :disabled="saving || !status?.dirty" @click="publish">发布 Draft</button>
    </header>
    <aside>
      <button v-for="item in nav" :key="item.id" :class="{ active: module === item.id }" @click="go(item.id)">{{ item.label }}</button>
      <a href="/showflow">返回 ShowFlow</a><a href="/led-preview">LCD 预览</a>
    </aside>

    <main v-if="module === 'slides'" class="slides-workspace">
      <section class="pages">
        <div class="section-head"><b>页面</b><button @click="openTemplatePicker">＋</button></div>
        <input v-model="query" placeholder="搜索页面" />
        <div class="page-list">
          <button v-for="page in filteredPages" :key="page.key" draggable="true" :class="{ selected: page.index === selected }" @click="selected = page.index" @dragstart="dragIndex = page.index" @dragover.prevent @drop="dropPage(page.index)">
            <span>{{ String(page.index + 1).padStart(2, '0') }}</span><em>{{ page.title }}</em>
          </button>
        </div>
        <div class="page-actions"><button @click="move(-1)">上移</button><button @click="move(1)">下移</button><button @click="duplicate">复制</button><button class="danger" @click="removePage">删除</button></div>
      </section>

      <section class="preview">
        <div class="section-head"><b>Draft 实时预览</b><span>约 1 秒更新</span></div>
        <iframe :key="previewKey" :src="previewUrl"></iframe>
      </section>

      <section class="editor">
        <div class="tabs"><button :class="{ active: mode === 'visual' }" @click="mode = 'visual'">可视化</button><button :class="{ active: mode === 'markdown' }" @click="mode = 'markdown'">Markdown 源码</button></div>
        <template v-if="mode === 'visual' && current">
          <label>页面标题<input v-model="form.title" @input="applyForm" /></label>
          <label>副标题<textarea v-model="form.subtitle" @input="applyForm"></textarea></label>
          <label>当前阶段<input v-model="form.stage" @input="applyForm" /></label>
          <label>页面模板<input v-model="form.template" placeholder="action / compare / scene" @input="applyForm" /></label>
          <label>主导岗位<select v-model="form.lead" @change="applyForm"><option value="">无</option><option v-for="role in roles" :key="role" :value="role">{{ role }}</option></select></label>
          <fieldset><legend>参与岗位</legend><label v-for="role in roles" :key="role" class="check"><input v-model="form.active" type="checkbox" :value="role" @change="applyForm" />{{ role }}</label></fieldset>
          <label v-for="role in roles" :key="role">{{ role }} 任务<input v-model="form.tasks[role]" @input="applyForm" /></label>
          <label>事件提醒 cue<input v-model="form.cue" @input="applyForm" /></label>
          <label>页面正文<textarea class="body" v-model="form.body" @input="applyForm"></textarea></label>
        </template>
        <textarea v-else class="source" v-model="markdown" spellcheck="false"></textarea>
        <div class="savebar"><span>{{ saveLabel }}</span><button @click="saveNow">保存草稿</button></div>
        <details class="versions"><summary>版本历史（{{ versions.length }}）</summary><article v-for="version in versions" :key="version.id"><span><b>{{ version.id }}</b><small>{{ version.message || '发布版本' }}</small></span><button @click="restore(version.id)">复制为草稿</button></article></details>
      </section>
    </main>

    <main v-else-if="module === 'lcd'" class="lcd-workspace">
      <section class="lcd-state-panel"><div class="panel-title"><b>测试状态</b><span>不影响正式播放</span></div><div class="panel-body"><label>当前阶段<input v-model="lcdState.stage"></label><label>主导岗位<select v-model="lcdState.lead"><option :value="null">无</option><option v-for="role in roles" :key="role" :value="role">{{roleNames[role]}}</option></select></label><fieldset><legend>参与岗位</legend><label v-for="role in roles" :key="role" class="check"><input v-model="lcdState.active" type="checkbox" :value="role">{{roleNames[role]}}</label></fieldset><label v-for="role in roles" :key="role">{{roleNames[role]}}任务<textarea v-model="lcdState.roles[role].task"></textarea></label><details class="remark"><summary>PPT LCD Remark 生成器</summary><textarea readonly :value="lcdRemarkText"></textarea><button @click="copy(lcdRemarkText)">复制 Remark</button></details></div></section>
      <section class="lcd-preview-panel"><div class="panel-title"><b>四屏实际渲染</b><div><button @click="renderStudioLcd">即时渲染</button><button class="primary" :disabled="!lcdResult" @click="testDisplay">测试下发</button></div></div><p class="lcd-message">{{lcdMessage || '修改状态或样式后点击即时渲染'}}</p><div class="screen-grid"><figure v-for="screen in lcdResult?.screens || []" :key="screen.role"><img :src="screen.url+'?v='+lcdResult?.revision" @click="openImage(screen.url)"><figcaption><b>{{roleNames[screen.role]}}</b><span>rev {{lcdResult?.revision}}</span></figcaption><small>{{screen.width}}×{{screen.height}} · {{screen.format}} · {{screen.sha256.slice(0,12)}}…</small></figure><div v-if="!lcdResult" class="lcd-empty">尚未渲染</div></div></section>
      <section class="lcd-style-panel"><div class="panel-title"><b>LCD Draft 样式</b><span>独立 Renderer</span></div><div class="panel-body"><label>主题<select :value="lcdThemes.find((x:any)=>x.draft)?.id" @change="selectLcdTheme(($event.target as HTMLSelectElement).value)"><option v-for="item in lcdThemes" :key="item.id" :value="item.id">{{item.name}}{{item.active?'（正式）':''}}</option></select></label><label>背景色<input v-model="lcdConfig.background" type="color"></label><label>任务字号<div class="range"><input v-model.number="lcdConfig.taskFontSize" type="range" min="24" max="86"><output>{{lcdConfig.taskFontSize}}</output></div></label><label>岗位字号<div class="range"><input v-model.number="lcdConfig.roleFontSize" type="range" min="28" max="82"><output>{{lcdConfig.roleFontSize}}</output></div></label><label>阶段字号<div class="range"><input v-model.number="lcdConfig.stageFontSize" type="range" min="28" max="82"><output>{{lcdConfig.stageFontSize}}</output></div></label><label>任务最大行数<input v-model.number="lcdConfig.maxTaskLines" type="number" min="1" max="4"></label><button class="wide" @click="saveLcdConfig">保存 LCD Draft</button><div class="divider"></div><label class="upload-box">上传 LCD Theme ZIP<input type="file" accept=".zip" @change="uploadLcdTheme"></label><article v-for="item in lcdThemes.filter((x:any)=>x.id!=='default')" :key="item.id" class="theme-row"><span><b>{{item.name}}</b><small>{{item.active?'正式':item.draft?'Draft':''}}</small></span><button v-if="!item.active&&!item.draft" class="danger" @click="deleteLcdTheme(item.id)">删除</button></article></div></section>
    </main>
    <main v-else-if="module === 'assets'" class="simple">
      <h2>素材库</h2><input type="file" multiple accept=".png,.jpg,.jpeg,.gif,.svg,.webp" @change="uploadAssets" />
      <div class="assets"><article v-for="asset in assets" :key="asset.id"><img :src="asset.url" /><b>{{ asset.name }}</b><small>{{ Math.ceil(asset.size / 1024) }} KB</small><div><button @click="copy(asset.url)">复制 URL</button><button class="danger" @click="deleteAsset(asset.id)">删除</button></div></article></div>
    </main>
    <main v-else-if="module === 'system'" class="simple"><h2>系统状态</h2><button @click="loadSystem">刷新状态</button><div class="status-grid"><article v-for="(value, key) in system?.services" :key="key"><b>{{ key }}</b><span>{{ value }}</span></article></div><h3>WebSocket 客户端</h3><div class="status-grid"><article v-for="(item,key) in system?.websocket?.roles" :key="key"><b>{{key}} · {{item.online?'在线':'离线'}}</b><small>连接数 {{item.connections}}</small><small>最后消息 {{formatTime(item.lastSeen)}}</small><small>最后 ACK {{formatTime(item.lastAck)}}</small><small>最后心跳 {{formatTime(item.lastHeartbeat)}}</small></article></div><h3>四块 LCD</h3><div class="status-grid"><article v-for="role in system?.lcd?.roles" :key="role.role"><b>{{role.role}}</b><small>revision {{role.currentRevision || '—'}}</small><small>最近渲染 {{formatTime(role.lastRender)}}</small><small>ACK / 心跳 / RSSI：{{role.lastAck || '未回传'}} / {{role.lastHeartbeat || '未回传'}} / {{role.rssi || '未回传'}}</small><small :title="role.imageUrl">{{role.imageUrl || '暂无图片'}}</small></article></div><p>{{system?.lcd?.acknowledgement}}</p><h3>版本</h3><pre>{{ JSON.stringify(system?.studio || {}, null, 2) }}</pre></main>
    <main v-else class="theme-page">
      <section class="theme-list"><h2>Reveal 页面主题</h2><p>上传只加入主题库；“设为 Draft”后可预览，点击顶部发布才影响正式页面。</p><div class="download-actions"><a href="/api/studio/themes/current/download?scope=active">下载当前正式主题</a><a href="/api/studio/themes/current/download?scope=draft">下载 Draft 主题</a></div><input type="file" accept=".zip" @change="uploadTheme" /><article v-for="theme in themes" :key="theme.id" :class="{chosen:theme.draft}"><span><b>{{ theme.name }}</b><small>{{ theme.active ? '当前正式' : theme.draft ? 'Draft 预览' : '' }}</small></span><div><button @click="selectTheme(theme.id)">设为 Draft</button><button v-if="theme.id !== 'default' && !theme.active && !theme.draft" class="danger" @click="deleteTheme(theme.id)">删除</button></div></article></section>
      <section class="theme-preview"><h3>Draft Theme 预览</h3><iframe :key="previewKey" :src="previewUrl"></iframe><details><summary>CSS 高级编辑</summary><textarea v-model="themeCss" spellcheck="false"></textarea><button @click="saveThemeCss">保存 CSS Draft</button></details></section>
    </main>

    <!-- 新增页面：排版模板选择器（缩略图为真实渲染的迷你 reveal） -->
    <div v-if="pickerVisible" class="tpl-picker" @click.self="pickerVisible = false">
      <div class="tpl-panel">
        <div class="tpl-head">
          <b>新增页面 · 选择排版模板</b>
          <span>点击卡片即按该排版新增页面（含基础占位内容，之后可可视化修改）</span>
          <button class="close" @click="pickerVisible = false">×</button>
        </div>
        <div class="tpl-grid">
          <div v-for="tpl in templates" :key="tpl.id" class="tpl-card" @click="addFromTemplate(tpl)">
            <div class="tpl-thumb">
              <iframe :src="`/reveal/?md=${encodeURIComponent(tpl.build(currentStage))}&thumb=1`" scrolling="no" loading="lazy"></iframe>
            </div>
            <div class="tpl-meta"><b>{{ tpl.name }}</b><small>{{ tpl.desc }}</small></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { LcdSceneState } from '@/show-flow/types'
import { renderLcdState, type LedRenderResult } from '@/show-flow/lcd/render-client'
import { publishLcdRenderResult } from '@/show-flow/lcd/lcd-controller'
import { publishPresentationMqtt } from '@/utils/presentation/bridge'
import { STUDIO_TEMPLATES } from './templates'

type Role = 'manager' | 'platform' | 'twin' | 'hardware'
const roles: Role[] = ['manager', 'platform', 'twin', 'hardware']
const roleNames: Record<Role,string> = {manager:'项目经理',platform:'平台系统开发工程师',twin:'数字孪生工程师',hardware:'软硬件调试工程师'}
const nav = [{ id: 'slides', label: '页面内容' }, { id: 'theme', label: '页面主题' }, { id: 'lcd', label: 'LCD 设计' }, { id: 'assets', label: '素材库' }, { id: 'system', label: '系统状态' }]
const module = ref(location.pathname.split('/')[2] || 'slides')
const markdown = ref(''), selected = ref(0), query = ref(''), mode = ref<'visual'|'markdown'>('visual')
const status = ref<any>(null), saving = ref(false), previewKey = ref(0), saveLabel = ref(''), assets = ref<any[]>([]), themes = ref<any[]>([]), lcdThemes = ref<any[]>([]), system = ref<any>(null), versions = ref<any[]>([]), dragIndex = ref(-1), themeCss = ref('')
const lcdConfig = reactive({background:'#101b31',taskFontSize:46,roleFontSize:60,stageFontSize:56,maxTaskLines:3})
const lcdState = reactive<LcdSceneState>({source:{type:'reveal-md',pageId:'studio-preview'},stage:'车端联调',lead:'hardware',active:['manager','platform','hardware'],roles:{manager:{task:'确认联调'},platform:{task:'核对数据'},twin:{task:'准备仿真'},hardware:{task:'执行操作'}}})
const lcdResult = ref<LedRenderResult|null>(null), lcdMessage = ref('')
const lcdRemarkText = computed(()=>`[LCD]\nstage=${lcdState.stage}\nlead=${lcdState.lead || ''}\nactive=${lcdState.active.join(',')}\n${roles.map(role=>`${role}=${lcdState.roles[role].task}`).join('\n')}\n[/LCD]`)
let timer = 0
const form = reactive({ title: '', subtitle: '', stage: '', template: '', lead: '', active: [] as string[], tasks: { manager: '', platform: '', twin: '', hardware: '' } as Record<Role,string>, cue: '', body: '' })

const splitPages = () => markdown.value.replace(/\r\n/g, '\n').split(/^---\s*$/m).map(s => s.trim()).filter(Boolean)
const titleOf = (text: string) => text.match(/^#\s+(.+)$/m)?.[1]?.trim() || '未命名页面'
const pages = computed(() => splitPages().map((text, index) => ({ text, index, title: titleOf(text), key: text.match(/data-page-id="([^"]+)"/)?.[1] || `${index}-${titleOf(text)}` })))
const filteredPages = computed(() => pages.value.filter(p => !query.value || p.title.toLowerCase().includes(query.value.toLowerCase())))
const current = computed(() => pages.value[selected.value])
const previewUrl = computed(() => `/reveal/?studio=draft&studioPage=${selected.value}&studioTheme=${encodeURIComponent(status.value?.draftRevealTheme || status.value?.activeRevealTheme || 'default')}`)
const attrs = (text: string) => Object.fromEntries([...text.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
function syncForm() {
  const text = current.value?.text || ''; const a = attrs(text); const lines = text.replace(/<!--\s*\.slide:[\s\S]*?-->/, '').trim().split('\n')
  form.title = titleOf(text); form.subtitle = lines.slice(1).find(l => l.trim() && !l.startsWith('#'))?.trim() || ''; form.stage = a.stage || ''; form.template = (a.class || '').split(/\s+/)[0] || ''; form.lead = a.lead || ''; form.active = (a.active || '').split(',').filter(Boolean); form.cue = a.cue || ''
  const tasks = Object.fromEntries((a.collab || '').split(';').map(x => x.split('='))) as Record<string,string>; roles.forEach(r => form.tasks[r] = tasks[r] || '')
  form.body = lines.filter((line, i) => i > 1 || (i === 1 && line.trim() !== form.subtitle)).join('\n').trim()
}
function esc(value: string) { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') }
function applyForm() {
  const list = splitPages(); if (!list[selected.value]) return; const old = attrs(list[selected.value]);
  const collab = roles.map(r => `${r}=${form.tasks[r] || ''}`).join(';'); const id = old['page-id'] || `studio-${Date.now().toString(36)}`
  const managed = new Set(['page-id','stage','lead','active','collab','cue']); const preserved = Object.entries(old).filter(([key]) => !managed.has(key)).map(([key,value]) => `data-${key}="${esc(value)}"`)
  const meta = [`class="${esc(form.template || 'action')}"`, ...preserved, `data-page-id="${esc(id)}"`, `data-stage="${esc(form.stage)}"`, `data-lead="${esc(form.lead)}"`, `data-active="${esc(form.active.join(','))}"`, `data-collab="${esc(collab)}"`, form.cue ? `data-cue="${esc(form.cue)}"` : ''].filter(Boolean).join(' ')
  list[selected.value] = `<!-- .slide: ${meta} -->\n# ${form.title}\n${form.subtitle}${form.body ? `\n\n${form.body}` : ''}`
  markdown.value = list.join('\n\n---\n\n') + '\n'; scheduleSave()
}
watch(selected, syncForm); watch(mode, value => { if (value === 'visual') syncForm() }); watch(markdown, () => { if (mode.value === 'markdown') scheduleSave() })
function scheduleSave() { saveLabel.value = '未保存'; clearTimeout(timer); timer = window.setTimeout(saveNow, 800) }
async function saveNow() { clearTimeout(timer); saving.value = true; try { const r = await fetch('/api/studio/slides', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ markdown: markdown.value }) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); status.value = data.status; saveLabel.value = '已保存为草稿'; previewKey.value++ } catch (e: any) { saveLabel.value = `保存失败：${e.message}` } finally { saving.value = false } }
async function publish() { if (!confirm('确认将当前 Draft 发布为正式版本？当前播放不会被强制跳页。')) return; await saveNow(); const r = await fetch('/api/studio/publish', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); const data = await r.json(); status.value = data.status; saveLabel.value = '已发布'; await loadVersions() }
function setPages(list: string[]) { markdown.value = list.join('\n\n---\n\n') + '\n'; selected.value = Math.min(selected.value, list.length - 1); scheduleSave(); syncForm() }
function addPage() { const list = splitPages(); list.push(`<!-- .slide: class="action" data-page-id="studio-${Date.now().toString(36)}" data-stage="" data-active="" data-collab="" -->\n# 新页面\n请输入副标题`); selected.value = list.length - 1; setPages(list) }
function duplicate() { const list = splitPages(); if (!list[selected.value]) return; list.splice(selected.value + 1, 0, list[selected.value].replace(/data-page-id="[^"]+"/, `data-page-id="studio-${Date.now().toString(36)}"`)); selected.value++; setPages(list) }
function removePage() { if (pages.value.length <= 1 || !confirm('确认删除当前页面？')) return; const list = splitPages(); list.splice(selected.value, 1); setPages(list) }
function move(delta: number) { const list = splitPages(), to = selected.value + delta; if (to < 0 || to >= list.length) return; [list[selected.value], list[to]] = [list[to], list[selected.value]]; selected.value = to; setPages(list) }
function dropPage(to:number) { const from = dragIndex.value; if (from < 0 || from === to) return; const list = splitPages(); const [page] = list.splice(from, 1); list.splice(to, 0, page); selected.value = to; dragIndex.value = -1; setPages(list) }

// ---- 新增页面：排版模板选择 ----
const templates = STUDIO_TEMPLATES
const pickerVisible = ref(false)
const currentStage = computed(() => {
  // 默认阶段名取当前选中页的阶段，保持流程语境连贯
  const a = attrs(current.value?.text || '')
  return a.stage || '未命名阶段'
})
function openTemplatePicker() { pickerVisible.value = true }
function addFromTemplate(tpl: { id: string; build: (stage: string) => string }) {
  const list = splitPages()
  const insertAt = Math.min(selected.value + 1, list.length)
  list.splice(insertAt, 0, tpl.build(currentStage.value))
  pickerVisible.value = false
  setPages(list)
  selected.value = insertAt
}
function go(id: string) { history.pushState({}, '', `/studio/${id}`); module.value = id; if (id === 'assets') loadAssets(); if (id === 'theme') loadThemes(); if(id==='lcd')loadLcdThemes(); if (id === 'system') loadSystem() }
async function loadAssets() { assets.value = (await (await fetch('/api/studio/assets')).json()).assets }
async function uploadAssets(event: Event) { for (const file of Array.from((event.target as HTMLInputElement).files || [])) await fetch('/api/studio/assets/upload', { method:'POST', headers:{'X-Filename':encodeURIComponent(file.name)}, body:file }); await loadAssets() }
async function deleteAsset(id:string) { if (!confirm(`确认删除 ${id}？`)) return; await fetch(`/api/studio/assets/${encodeURIComponent(id)}`, {method:'DELETE'}); await loadAssets() }
function copy(value:string) { navigator.clipboard.writeText(value.startsWith('/') ? `${location.origin}${value}` : value) }
async function loadSystem() { system.value = await (await fetch('/api/studio/system/status')).json() }
async function loadThemes() { themes.value = (await (await fetch('/api/studio/themes')).json()).themes; themeCss.value=(await (await fetch('/api/studio/themes/draft/css')).json()).css }
async function uploadTheme(event:Event) { const input=event.target as HTMLInputElement,file=input.files?.[0]; if(!file)return; const r=await fetch('/api/studio/themes/upload',{method:'POST',headers:{'X-Filename':encodeURIComponent(file.name)},body:file}); const data=await r.json(); if(!r.ok){alert(data.error);return} input.value=''; await loadThemes() }
async function selectTheme(id:string) { const data=await (await fetch(`/api/studio/themes/${encodeURIComponent(id)}/preview`,{method:'POST'})).json(); status.value=data.status; previewKey.value++; await loadThemes() }
async function deleteTheme(id:string) { if(!confirm(`确认删除主题 ${id}？`))return; const r=await fetch(`/api/studio/themes/${encodeURIComponent(id)}`,{method:'DELETE'}); if(!r.ok)alert((await r.json()).error); await loadThemes() }
async function saveThemeCss(){const data=await(await fetch('/api/studio/themes/draft/css',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({css:themeCss.value})})).json();status.value=data.status;previewKey.value++;await loadThemes()}
async function loadLcdThemes(){const data=await(await fetch('/api/studio/lcd/themes')).json();lcdThemes.value=data.themes;const draft=await(await fetch('/api/studio/lcd/themes/draft')).json();Object.assign(lcdConfig,draft.config||{});if(!lcdResult.value)await renderStudioLcd()}
async function uploadLcdTheme(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;const r=await fetch('/api/studio/lcd/themes/upload',{method:'POST',headers:{'X-Filename':encodeURIComponent(file.name)},body:file});const data=await r.json();if(!r.ok)alert(data.error);input.value='';await loadLcdThemes()}
async function selectLcdTheme(id:string){const data=await(await fetch(`/api/studio/lcd/themes/${encodeURIComponent(id)}/preview`,{method:'POST'})).json();Object.assign(lcdConfig,data.config);status.value=data.status;await loadLcdThemes();await renderStudioLcd()}
async function saveLcdConfig(){const id=lcdThemes.value.find((x:any)=>x.draft)?.id||'default';const data=await(await fetch('/api/studio/lcd/themes/draft',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,config:lcdConfig})})).json();Object.assign(lcdConfig,data.config);status.value=data.status;await loadLcdThemes();await renderStudioLcd();lcdMessage.value='LCD Draft 已保存并重新渲染'}
async function deleteLcdTheme(id:string){if(!confirm(`确认删除 LCD Theme ${id}？`))return;const r=await fetch(`/api/studio/lcd/themes/${encodeURIComponent(id)}`,{method:'DELETE'});if(!r.ok)alert((await r.json()).error);await loadLcdThemes()}
function formatTime(value:number|null){return value?new Date(value).toLocaleTimeString():'—'}
async function renderStudioLcd(){try{lcdMessage.value='服务端正在生成四张 JPEG…';lcdResult.value=await renderLcdState(lcdState,lcdConfig);lcdMessage.value=`已生成 revision ${lcdResult.value.revision}`}catch(error){lcdMessage.value=`渲染失败：${error instanceof Error?error.message:error}`}}
function testDisplay(){if(!lcdResult.value)return;const sent=publishLcdRenderResult(lcdResult.value,publishPresentationMqtt);lcdMessage.value=sent===4?'已通过 Controller MQTT 通道下发四块 LCD':`仅下发 ${sent}/4，请检查 MQTT 连接`}
function openImage(url:string){window.open(url,'_blank')}
async function loadVersions() { versions.value = (await (await fetch('/api/studio/versions')).json()).versions }
async function restore(id:string) { if (!confirm(`将版本 ${id} 复制为 Draft？正式版本不会改变。`)) return; const data = await (await fetch(`/api/studio/versions/${encodeURIComponent(id)}/restore`, {method:'POST'})).json(); status.value = data.status; const slides = await (await fetch('/api/studio/slides')).json(); markdown.value = slides.markdown; selected.value = 0; syncForm(); previewKey.value++; saveLabel.value = '历史版本已复制为草稿' }
onMounted(async () => { const data = await (await fetch('/api/studio/slides')).json(); markdown.value = data.markdown; status.value = data.status; syncForm(); await loadVersions(); if (module.value === 'assets') loadAssets(); if (module.value === 'theme') loadThemes(); if(module.value==='lcd')loadLcdThemes(); if (module.value === 'system') loadSystem() })
</script>

<style scoped lang="scss">
*{box-sizing:border-box}.studio{height:100vh;background:#f4f6f9;color:#263247;display:grid;grid-template:64px 1fr/180px 1fr;font-family:Arial,"Microsoft YaHei",sans-serif}header{grid-column:1/3;background:#fff;border-bottom:1px solid #dfe4ec;display:flex;align-items:center;padding:0 22px;gap:20px}header div:first-child{display:flex;gap:12px;align-items:baseline}header strong{font-size:19px}header span{color:#8993a4}.state{margin-left:auto;padding:7px 12px;border-radius:16px;font-size:13px}.dirty{background:#fff1d6;color:#9a6200}.published{background:#e1f7eb;color:#137846}button,.card-link{border:1px solid #cdd4df;background:#fff;border-radius:6px;padding:8px 12px;color:#344057;cursor:pointer}.primary{background:#2867e8;color:#fff;border-color:#2867e8}button:disabled{opacity:.45;cursor:not-allowed}.danger{color:#c43a3a}aside{background:#202a3b;padding:18px 12px;display:flex;flex-direction:column;gap:7px}aside button,aside a{color:#bac5d5;background:transparent;border:0;text-align:left;text-decoration:none;padding:11px;border-radius:6px}aside button.active,aside button:hover{background:#34425a;color:#fff}aside a:first-of-type{margin-top:auto}.slides-workspace{min-width:0;display:grid;grid-template-columns:220px minmax(400px,1fr) 350px;gap:1px;background:#dfe4ec;overflow:hidden}.slides-workspace>section{background:#fff;min-width:0;overflow:auto}.section-head{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid #e5e9ef}.section-head span{font-size:12px;color:#8993a4}.pages>input{width:calc(100% - 24px);margin:12px;padding:9px;border:1px solid #d8dee8;border-radius:5px}.page-list{padding:0 8px}.page-list button{width:100%;border:0;display:flex;gap:9px}.page-list button span{color:#8490a3}.page-list button em{font-style:normal;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.page-list button.selected{background:#eaf1ff;color:#1856c7}.page-actions{display:flex;flex-wrap:wrap;gap:5px;padding:12px}.page-actions button{padding:6px}.preview{display:flex;flex-direction:column}.preview iframe{border:0;width:100%;aspect-ratio:16/9;background:#111}.editor{padding-bottom:64px}.tabs{height:48px;display:flex;border-bottom:1px solid #e5e9ef}.tabs button{border:0;border-radius:0}.tabs button.active{color:#2867e8;border-bottom:2px solid #2867e8}.editor>label{display:block;margin:12px 14px;font-size:12px;color:#647086}.editor input,.editor textarea,.editor select{width:100%;margin-top:5px;padding:9px;border:1px solid #d5dce7;border-radius:5px;color:#263247}.editor textarea{min-height:58px;resize:vertical}.editor .body{min-height:120px}.editor fieldset{margin:12px 14px;border:1px solid #d5dce7;border-radius:5px}.editor .check{display:block;margin:7px}.editor .check input{width:auto;margin-right:6px}.source{width:100%;height:calc(100vh - 180px);border:0;padding:16px;resize:none;font:13px/1.6 Consolas,monospace;outline:0}.savebar{position:fixed;right:0;bottom:0;width:350px;padding:10px 14px;background:#fff;border-top:1px solid #dfe4ec;display:flex;align-items:center;justify-content:space-between;font-size:12px}.simple{padding:28px;overflow:auto}.card-link{display:inline-block;text-decoration:none;margin-top:16px}.assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-top:20px}.assets article,.status-grid article{background:#fff;border:1px solid #dfe4ec;border-radius:8px;padding:12px}.assets img{width:100%;height:120px;object-fit:contain;background:#eef1f5}.assets b,.assets small{display:block;margin-top:7px;overflow:hidden;text-overflow:ellipsis}.assets small{color:#8993a4}.assets article div{display:flex;gap:5px;margin-top:8px}.status-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.status-grid span{display:block;color:#16804c;margin-top:7px}@media(max-width:1150px){.slides-workspace{grid-template-columns:190px 1fr 310px}.savebar{width:310px}}
.versions{margin:14px;border-top:1px solid #e1e6ee;padding-top:12px}.versions summary{cursor:pointer}.versions article{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #edf0f4}.versions article span,.versions small{display:block}.versions small{color:#8993a4;margin-top:3px}.versions button{padding:5px;white-space:nowrap}
.theme-page{display:grid;grid-template-columns:360px 1fr;gap:1px;background:#dfe4ec;overflow:hidden}.theme-page>section{background:#fff;padding:24px;overflow:auto}.theme-list article{display:flex;justify-content:space-between;align-items:center;border:1px solid #dfe4ec;border-radius:7px;padding:12px;margin-top:10px}.theme-list article.chosen{border-color:#2867e8;background:#f1f6ff}.theme-list small{display:block;color:#16804c;margin-top:4px}.theme-list article div{display:flex;gap:5px}.theme-preview{display:flex;flex-direction:column}.theme-preview iframe{width:100%;aspect-ratio:16/9;flex:0 0 auto;border:0;background:#111}
.download-actions{display:flex;gap:7px;margin:12px 0}.download-actions a{border:1px solid #cdd4df;border-radius:6px;padding:8px;text-decoration:none;color:#285fc0;background:#f7f9fc;font-size:12px}
.theme-preview details{margin-top:12px}.theme-preview details textarea{width:100%;height:260px;margin:10px 0;font:13px/1.55 Consolas,monospace}.lcd-tools{display:grid;grid-template-columns:1fr 1fr;gap:18px}.lcd-tools>section,.remark{background:#fff;border:1px solid #dfe4ec;border-radius:8px;padding:18px}.theme-row{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #edf0f4}.theme-row span{margin-right:auto}.theme-row small,.status-grid small{display:block;color:#7d8797;margin-top:4px}.lcd-tools label,.remark-form label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:9px 0}.lcd-tools input,.remark input,.remark select{padding:7px;border:1px solid #cdd4df;border-radius:5px}.remark{margin-top:18px}.remark-form{display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:0 20px}.remark textarea{width:100%;height:190px;font:13px/1.6 Consolas,monospace;margin:10px 0}.status-grid{margin-top:12px}
.lcd-workspace{min-width:0;display:grid;grid-template-columns:300px minmax(480px,1fr) 300px;gap:1px;background:#dfe4ec;overflow:hidden}.lcd-workspace>section{background:#fff;min-width:0;overflow:auto}.panel-title{height:52px;padding:0 16px;border-bottom:1px solid #e5e9ef;display:flex;align-items:center;justify-content:space-between;gap:10px}.panel-title>span{font-size:12px;color:#8993a4}.panel-title>div{display:flex;gap:7px}.panel-body{padding:14px 16px}.panel-body>label{display:block;margin-bottom:14px;font-size:12px;color:#667389}.panel-body input,.panel-body select,.panel-body textarea{display:block;width:100%;margin-top:6px;padding:9px;border:1px solid #d5dce7;border-radius:6px;background:#fff;color:#263247}.panel-body textarea{min-height:58px;resize:vertical}.panel-body fieldset{border:1px solid #dce2eb;border-radius:7px;margin:0 0 15px;padding:9px 12px}.panel-body .check{display:block;margin:7px 0;font-size:12px}.panel-body .check input{display:inline;width:auto;margin:0 7px 0 0}.range{display:flex;align-items:center;gap:8px}.range input{padding:0}.range output{min-width:32px;text-align:right;color:#2867e8;font-weight:700}.wide{width:100%}.divider{height:1px;background:#e5e9ef;margin:18px 0}.upload-box{border:1px dashed #aeb9ca;border-radius:7px;padding:12px;text-align:center;color:#2867e8;cursor:pointer}.upload-box input{display:none}.lcd-preview-panel{display:flex;flex-direction:column}.lcd-message{margin:10px 14px;padding:8px 10px;background:#edf3ff;color:#3460ad;border-radius:6px;font-size:12px}.screen-grid{padding:4px 14px 18px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.screen-grid figure{margin:0;border:1px solid #dce2eb;border-radius:8px;padding:8px;box-shadow:0 2px 8px rgba(30,45,70,.06)}.screen-grid img{display:block;width:100%;aspect-ratio:16/10;object-fit:contain;background:#101522;border-radius:5px;cursor:zoom-in}.screen-grid figcaption{display:flex;justify-content:space-between;gap:8px;padding-top:7px;font-size:12px}.screen-grid figcaption span,.screen-grid small{color:#7d8797}.screen-grid small{display:block;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lcd-empty{grid-column:1/-1;height:280px;display:flex;align-items:center;justify-content:center;border:1px dashed #bac3d1;border-radius:8px;color:#8a94a4}.remark{margin:18px 0 0;padding:0;border:0}.remark summary{cursor:pointer;font-size:12px;font-weight:700}.remark textarea{width:100%;height:180px;margin:8px 0;font:12px/1.55 Consolas,monospace}.theme-row button{padding:5px 7px}.simple>h2,.theme-list h2{margin-top:0}.simple>p,.theme-list>p{color:#697588;line-height:1.6}.status-grid article{min-height:92px}.assets article{transition:.15s}.assets article:hover{border-color:#9fb2d3;box-shadow:0 4px 14px rgba(35,55,85,.08)}
@media(max-width:1200px){.lcd-workspace{grid-template-columns:270px minmax(420px,1fr) 270px}.screen-grid{grid-template-columns:1fr}}

/* ---- 新增页面模板选择器 ---- */
.tpl-picker{position:fixed;inset:0;z-index:200;background:rgba(15,23,38,.62);display:flex;align-items:center;justify-content:center}
.tpl-panel{width:min(1080px,92vw);max-height:88vh;background:#fff;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(10,25,50,.35)}
.tpl-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #e5e9ef}
.tpl-head b{font-size:15px}
.tpl-head span{flex:1;font-size:12px;color:#8993a4}
.tpl-head .close{border:0;font-size:18px;padding:2px 8px}
.tpl-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;padding:16px 18px;overflow-y:auto}
.tpl-card{border:1px solid #dce2eb;border-radius:8px;overflow:hidden;cursor:pointer;transition:.15s;background:#0d1524}
.tpl-card:hover{border-color:#2867e8;box-shadow:0 4px 16px rgba(40,103,232,.18)}
.tpl-thumb{position:relative;width:100%;aspect-ratio:16/9;pointer-events:none}
.tpl-thumb iframe{border:0;width:100%;height:100%;pointer-events:none}
.tpl-meta{display:flex;flex-direction:column;gap:3px;padding:9px 12px;background:#fff}
.tpl-meta b{font-size:13px}
.tpl-meta small{color:#8993a4}
@media(max-width:1000px){.tpl-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
