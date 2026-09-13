/**
 * 服务端图片字节预校验：@napi-rs/canvas 对截断/损坏图片会原生段错误
 * （进程级崩溃，try/catch 无法捕获——实测一个缺 EOI 的 JPEG 即可击杀
 * 整个服务端，所有屏幕联动随之冻结）。任何进入服务端解码路径的用户
 * 上传字节（监控半区截图、LCD 头像等）必须先过此校验。
 *
 * 校验规则（覆盖截断这一最常见的损坏形态）：
 * - JPEG: SOI(FFD8FF) 开头 且 EOI(FFD9) 结尾
 * - PNG: 签名开头 且 IEND 结尾
 * - GIF: GIF87a/GIF89a 开头 且 0x3B 结尾
 * - WebP: RIFF....WEBP
 * 另拒绝空数据与异常小体积。
 */
const MIN_IMAGE_BYTES = 64

export function assertUploadedImage(buffer, label = '图片') {
  const fail = reason => {
    const error = new Error(`${label}数据不完整或已损坏（${reason}），已拒绝`)
    error.status = 400
    throw error
  }
  if (!buffer || buffer.length < MIN_IMAGE_BYTES) fail('数据为空或过小')
  const head = buffer.subarray(0, 12)
  const tail = buffer.subarray(-4)

  if (head[0] === 0xff && head[1] === 0xd8) {
    if (head[2] !== 0xff) fail('JPEG 头不完整')
    if (!(tail[2] === 0xff && tail[3] === 0xd9)) fail('JPEG 缺少结束标记（可能传输被截断）')
    return
  }
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    if (!(tail[0] === 0xae && tail[1] === 0x42 && tail[2] === 0x60 && tail[3] === 0x82)) fail('PNG 缺少 IEND 结束块')
    return
  }
  const sig = head.toString('latin1', 0, 6)
  if (sig === 'GIF87a' || sig === 'GIF89a') {
    if (buffer[buffer.length - 1] !== 0x3b) fail('GIF 缺少结束标记')
    return
  }
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return
  fail('无法识别的图片格式')
}
