/**
 * PPTX blob 模式桥接（纯函数，浏览器与 Node 测试共用）。
 *
 * pptxtojson 的 imageMode:'blob' 会把图片字节做成 objectURL 放在 `blob` 字段、
 * `base64` 留空；而既有转换逻辑读取 `base64` 字段。此桥接把 blob URL 复制进
 * base64 字段，使整套转换/渲染管线无需感知 blob 模式。
 * 随后上传流程会把 base64 字段里的 blob: 引用逐个上传为资产并替换为
 * /default-ppt-api/assets/ URL。
 */
interface BlobCarrying {
  type?: string
  fill?: { type?: string; value?: unknown }
  elements?: BlobCarrying[]
}

export function bridgePptxBlobImages(parsed: { slides?: unknown[] }): void {
  for (const item of (parsed.slides || []) as BlobCarrying[]) {
    const fill = item.fill as { type?: string; value?: { base64?: string; blob?: string } } | undefined
    if (fill?.type === 'image' && fill.value?.blob) fill.value.base64 = fill.value.blob
    for (const el of item.elements || []) {
      if (el.type === 'image') {
        const carrier = el as unknown as { base64?: string; blob?: string }
        if (carrier.blob) carrier.base64 = carrier.blob
      }
    }
  }
}
