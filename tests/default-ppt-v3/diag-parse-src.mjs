// 诊断：pptxtojson 解析后各页图片元素的 src/blob 状态（定位空 src 元素）
import { parse } from 'pptxtojson'

window.__diag = async file => {
  const buf = await file.arrayBuffer()
  const json = await parse(buf, { imageMode: 'blob', videoMode: 'blob', audioMode: 'blob' })
  const elSummary = el => ({
    type: el.type,
    name: el.name || '',
    x: Math.round(el.left || 0), y: Math.round(el.top || 0),
    w: Math.round(el.width || 0), h: Math.round(el.height || 0),
    srcLen: (el.src || '').length,
    srcHead: (el.src || '').slice(0, 48),
    blobLen: el.blob ? String(el.blob).length : -1,
  })
  const detail = json.slides.map((slide, i) => ({
    page: i + 1,
    fill: slide.fill?.type,
    fillSrcLen: slide.fill?.type === 'image' ? (slide.fill.value?.base64 || slide.fill.value?.blob || '').length : 0,
    elements: (slide.elements || []).map(elSummary),
  }))
  // 全局提取失败统计：图片元素 src 空 且 blob 空/缺失
  const empty = detail.map(d => ({
    page: d.page,
    deadImgs: d.elements.filter(e => e.type === 'image' && e.srcLen === 0 && e.blobLen <= 0).length,
    total: d.elements.length,
  })).filter(d => d.deadImgs > 0)
  return { pageCount: json.slides.length, size: json.size, page2: detail[1], emptyPages: empty }
}
