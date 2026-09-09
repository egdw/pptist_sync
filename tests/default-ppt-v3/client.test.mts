/**
 * 客户端逻辑测试体（由 run-client.mjs esbuild 打包后在 Node 执行）。
 * 以浏览器等价环境（Blob + createObjectURL + fetch）运行真实前端模块。
 */
// pptxtojson 的 package main 是 UMD（Node 下 require 为空对象）；直接引其 ESM 产物
import * as pptxtojsonNS from 'pptxtojson/dist/index.js'
import { bridgePptxBlobImages } from '@/utils/pptxBlobBridge'
import { uploadMainDeckV3 } from '@/services/mainDeckUpload'
import type { Slide } from '@/types/slides'

const ptj = pptxtojsonNS as unknown as { parse?: any, default?: any }
const parse = ptj.parse ?? ptj.default?.parse

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗ FAIL:', name) } }

export async function run({ pptxPath, base }: { pptxPath: string; base: string }) {
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  const { statSync } = await import('node:fs')

  // ---- 浏览器等价环境：Blob 存储 + objectURL ----
  const blobStore = new Map<string, Blob>()
  const realCreateObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (blob: Blob) => {
    for (const [url, existing] of blobStore) {
      if (existing === blob) return url
    }
    const url = `blob:mock-${Math.random().toString(36).slice(2, 10)}`
    blobStore.set(url, blob)
    return url
  }
  const revoked = new Set<string>()
  const realRevokeObjectURL = URL.revokeObjectURL.bind(URL)
  URL.revokeObjectURL = (url: string) => { revoked.add(url); blobStore.delete(url); realRevokeObjectURL(url) }

  // blob: URL 的 fetch 拦截（Node 原生 fetch 不支持 blob: 协议）；
  // 相对路径补 origin（等价浏览器同源解析，mainDeckUpload 在浏览器中使用相对路径）
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('blob:')) {
      const blob = blobStore.get(url)
      if (!blob) return new Response('not found', { status: 404 })
      return new Response(blob, { status: 200 })
    }
    const target = url.startsWith('/') ? base + url : url
    return realFetch(typeof input === 'string' ? target : new Request(target, input), init)
  }) as typeof fetch

  // ---- 1. 真实 PPTX blob 模式解析 ----
  console.log(`解析 ${path.basename(pptxPath)}（${(statSync(pptxPath).size / 1048576).toFixed(0)}MB）...`)
  const t0 = Date.now()
  const buffer = await fsp.readFile(pptxPath)
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const parsed = await parse(arrayBuffer as ArrayBuffer, { imageMode: 'blob', videoMode: 'blob', audioMode: 'blob' })
  console.log(`解析完成：${parsed.slides.length} 页 / ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  ok(parsed.slides.length > 0, `PPTX 解析出 ${parsed.slides.length} 页`)

  // ---- 2. 桥接（与 useImport 共用实现） ----
  bridgePptxBlobImages(parsed)

  // 桥接正确性：图片元素与背景填充的 base64 字段已等于 blob(objectURL)
  let bridgedImg = 0, bridgedFill = 0
  for (const item of parsed.slides as any[]) {
    if (item.fill?.type === 'image' && item.fill.value?.blob && item.fill.value.base64 === item.fill.value.blob) bridgedFill++
    for (const el of item.elements || []) {
      if (el.type === 'image' && el.blob && el.base64 === el.blob) bridgedImg++
    }
  }
  ok(bridgedImg + bridgedFill > 0, `blob 桥接到 base64 字段（元素 ${bridgedImg} + 背景 ${bridgedFill}）`)

  // 嵌套桥接：group/diagram 子元素图片也必须被桥接（否则拍平后 src 为空被剔除，页面内容丢失）
  let nestedImg = 0, nestedBridged = 0
  for (const item of parsed.slides as any[]) {
    for (const el of item.elements || []) {
      if (Array.isArray(el.elements)) {
        for (const child of el.elements) {
          if (child.type === 'image' && child.blob) { nestedImg++; if (child.base64 === child.blob) nestedBridged++ }
        }
      }
    }
  }
  ok(nestedBridged === nestedImg && nestedImg > 0, `group 子元素图片桥接（${nestedBridged}/${nestedImg}）`)

  // 模拟 useImport 转换后的媒体字段形状（src 承载引用）——上传器遍历的就是这个形状
  const rawSlides = parsed.slides.map((item: any) => ({
    id: `s-${Math.random().toString(36).slice(2, 10)}`,
    elements: (item.elements || []).map((el: any) => {
      if (el.type === 'image') return { type: 'image', id: 'e', src: el.base64 }
      if (el.type === 'video') return { type: 'video', id: 'e', src: el.blob }
      if (el.type === 'audio') return { type: 'audio', id: 'e', src: el.blob }
      return { type: 'text', id: 'e', content: '' }
    }),
    background: item.fill?.type === 'image'
      ? { type: 'image' as const, image: { src: item.fill.value.base64, size: 'cover' as const } }
      : undefined,
  })) as unknown as Slide[]

  // ---- 3. 真实上传（会话/资产/raw/bundle/commit 全链路） ----
  const rawStat = await fsp.stat(pptxPath)
  const t1 = Date.now()
  let lastProgress = ''
  await uploadMainDeckV3({
    filename: path.basename(pptxPath),
    rawFile: new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
    slides: rawSlides,
    theme: {} as any,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    title: path.basename(pptxPath).replace(/\.pptx$/i, ''),
    onProgress: info => {
      const line = `[${info.phase}] ${info.done}/${info.total} ${info.detail || ''}`
      if (line !== lastProgress) { lastProgress = line; console.log('  进度:', line) }
    },
  })
  console.log(`上传完成：${((Date.now() - t1) / 1000).toFixed(1)}s`)
  ok(true, 'v3 上传全链路（会话→资产→raw→bundle→commit）成功')

  // ---- 4. 服务端状态校验 ----
  const current = await (await realFetch(`${base}/default-ppt-api/current`)).json()
  ok(current.exists && current.pageCount === rawSlides.length, `current.pageCount=${current.pageCount} 与解析页数一致`)

  const bundleRes = await realFetch(`${base}/default-ppt-api/current/slides`)
  const bundle = await bundleRes.json()
  let assetRefCount = 0, residualBlob = 0, residualData = 0
  const checkSrc = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.startsWith('/default-ppt-api/assets/')) assetRefCount++
      else if (v.startsWith('blob:')) residualBlob++
      else if (v.startsWith('data:image')) residualData++
    }
    else if (Array.isArray(v)) v.forEach(checkSrc)
    else if (v && typeof v === 'object') Object.values(v).forEach(checkSrc)
  }
  checkSrc(bundle.slides)
  ok(assetRefCount > 0, `bundle 中全部为资产 URL（${assetRefCount} 处）`)
  ok(residualBlob === 0 && residualData === 0, `无残留 blob:/data: 引用（blob=${residualBlob}, data=${residualData}）`)

  // 抽样 3 个资产可访问且缓存头正确
  const assetUrls: string[] = []
  const collect = (v: unknown): void => {
    if (typeof v === 'string' && v.startsWith('/default-ppt-api/assets/')) assetUrls.push(v)
    else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  collect(bundle.slides)
  let assetOk = 0
  for (const url of assetUrls.slice(0, 3)) {
    const r = await realFetch(base + url)
    if (r.ok && (r.headers.get('cache-control') || '').includes('immutable')) assetOk++
  }
  ok(assetOk === Math.min(3, assetUrls.length), `抽样资产可访问且 immutable（${assetOk}/${Math.min(3, assetUrls.length)}）`)

  ok(revoked.size > 0, `objectURL 全部撤销（${revoked.size} 个）`)

  // ---- 5. 服务端原始文件字节一致 ----
  const rawDown = await realFetch(`${base}/default-ppt-api/current/file`)
  const downloaded = Buffer.from(await rawDown.arrayBuffer())
  ok(downloaded.length === rawStat.size, `原始文件字节一致（${downloaded.length} / ${rawStat.size}）`)

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  return fail
}
