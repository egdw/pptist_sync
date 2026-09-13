/**
 * 超大 GIF → 视频转码（服务端，ffmpeg）
 *
 * 背景：Chromium 对动图有解码内存上限，超大 GIF（如 139MB、上千帧、
 * 解码帧总量 GB~TB 级）只会显示首帧不播动画；且每只驻留 +500MB 内存。
 * 解决：v3 上传发布后，异步把超过阈值的 GIF 覆盖层转码为视频资产
 * （不透明 → H.264 MP4；含透明 → VP9 yuva420p WebM），并把 bundle 中
 * 对应元素改写为 autoplay 视频元素，播放端走 <video> 硬解码循环播放。
 *
 * ffmpeg 解析顺序：PPTIST_FFMPEG 环境变量 → PATH 中的 ffmpeg →
 * 仓库 .devtools/bin/ffmpeg.exe（仅开发机，不入库/不入部署包）。
 * 找不到 ffmpeg 时整体禁用，GIF 保持原状（小 GIF 本就能直接播）。
 *
 * 编码器按构建实际能力回退：libx264 → h264_rkmpp（RK 硬编）→ libvpx-vp9
 * → mpeg4；全部失败时降级为静态首帧图——巨型 GIF 永不原样下发播放端
 * （RK3588 实测：解码驻留 GB 级 → 渲染进程卡死 → 整机假死）。
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { assertUploadedImage } from './image-guard.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000
const MAX_VIDEO_WIDTH = 1600

let ffmpegResolved = null
async function resolveFfmpeg(log) {
  if (ffmpegResolved !== null) return ffmpegResolved
  const candidates = [
    process.env.PPTIST_FFMPEG,
    'ffmpeg',
    path.resolve(moduleDir, '../.devtools/bin/ffmpeg.exe'),
  ].filter(Boolean)
  for (const cmd of candidates) {
    const ok = await spawnSync(cmd, ['-version'], 8000) // 注意：返回 Promise，必须 await
    if (ok) {
      ffmpegResolved = cmd
      return cmd
    }
  }
  ffmpegResolved = ''
  log?.('[gif-transcode] 未找到 ffmpeg（PPTIST_FFMPEG / PATH / .devtools），超大 GIF 将降级为静态首帧')
  return ''
}

/** 可用视频编码器列表（一次性探测并缓存）。
 *  ffmpeg 构建差异极大：RK3588 板卡的 rkmpp 构建不带 libx264（无 -preset 选项），
 *  标准构建不带 h264_rkmpp——转码参数必须按实际编码器生成，否则全线失败。 */
let encodersCache = null
async function listEncoders(log) {
  if (encodersCache) return encodersCache
  const cmd = await resolveFfmpeg(log)
  if (!cmd) { encodersCache = []; return encodersCache }
  const text = await captureOutput(cmd, ['-hide_banner', '-encoders'], 8000)
  const found = new Set()
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^[A-Z.]{3,11}\s+([\w@._-]+)\s+.*/)
    if (m) found.add(m[1])
  }
  encodersCache = found
  return found
}

function captureOutput(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    let out = ''
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => {
        if (!done) { done = true; child.kill('SIGKILL'); resolve('') }
      }, timeoutMs)
      child.stdout.on('data', d => { out += d; if (out.length > 262144) child.kill('SIGKILL') })
      child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve('') } })
      child.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(out) } })
    }
    catch { resolve('') }
  })
}

/** 不透明编码回退链：libx264（标准构建）→ h264_rkmpp（RK 硬编）→
 *  libvpx-vp9 → mpeg4（ffmpeg 内置，任何构建都有）。ext 决定输出容器。 */
function opaqueEncoderPlan(name) {
  switch (name) {
    case 'libx264': return { args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], ext: 'mp4', label: 'H.264(x264)' }
    case 'h264_rkmpp': return { args: ['-c:v', 'h264_rkmpp', '-b:v', '4M', '-pix_fmt', 'nv12'], ext: 'mp4', label: 'H.264(rkmpp)' }
    case 'libvpx-vp9': return { args: ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-crf', '34', '-b:v', '0', '-pix_fmt', 'yuv420p'], ext: 'webm', label: 'VP9' }
    default: return { args: ['-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], ext: 'mp4', label: 'MPEG-4' }
  }
}

function spawnSync(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] })
      const timer = setTimeout(() => {
        if (!done) { done = true; child.kill('SIGKILL'); resolve(null) }
      }, timeoutMs)
      child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
      child.on('exit', code => { if (!done) { done = true; clearTimeout(timer); resolve(code === 0) } })
    }
    catch { resolve(null) }
  })
}

function runFfmpeg(cmd, args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false
    let stderr = ''
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      const timer = setTimeout(() => {
        if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('ffmpeg 超时')) }
      }, timeoutMs)
      child.stderr.on('data', d => { stderr += d; if (stderr.length > 8192) stderr = stderr.slice(-4096) })
      child.on('error', error => { if (!done) { done = true; clearTimeout(timer); reject(error) } })
      child.on('exit', code => {
        if (!done) { done = true; clearTimeout(timer); code === 0 ? resolve(true) : reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-300)}`)) }
      })
    }
    catch (error) { reject(error) }
  })
}

export function createGifTranscoder({ assetsDir, thresholdMB = 24, decodedCapMB = 128, assetUrlPrefix = '/default-ppt-api', log = () => {} }) {
  const thresholdBytes = Math.max(0, Number(thresholdMB) || 0) * 1024 * 1024
  /** 解码后字节上限：Chromium 对动图有解码内存上限（实测 413MB 解码体量即只显首帧，
   *  36MB 正常播放），且大体量动画本身也是驻留负担——超过即转码为视频，与文件大小无关
   *  （一个 0.9MB 的 368 帧 GIF 解码后同样高达 1.5GB）。 */
  const decodedCapBytes = Math.max(1, Number(decodedCapMB) || 128) * 1024 * 1024
  /** 资产名 → 转码结果 memo（同稿多元素复用同一 GIF） */
  const memo = new Map()
  let queue = Promise.resolve()
  const ffmpegReady = () => resolveFfmpeg(log)

  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

  async function storeAsset(bytes, ext) {
    const name = `${sha(bytes)}.${ext}`
    const target = path.join(assetsDir, name)
    if (!(await fsp.stat(target).catch(() => null))) {
      const tmp = path.join(assetsDir, `.${crypto.randomUUID()}.asset-tmp`)
      await fsp.writeFile(tmp, bytes)
      await fsp.rename(tmp, target)
    }
    return name
  }

  /** 首帧是否含透明像素 */
  async function firstFrameHasAlpha(gifPath, workDir) {
    try {
      const poster = path.join(workDir, 'probe.png')
      await runFfmpeg(await ffmpegReady(), ['-y', '-i', gifPath, '-vframes', 1, '-vf', `scale='min(${MAX_VIDEO_WIDTH},iw)':-2`, poster], 120_000)
      // ffmpeg 输出也可能损坏（磁盘满/中断），解码前校验防段错误
      const posterBytes = await fsp.readFile(poster)
      assertUploadedImage(posterBytes, 'GIF 首帧')
      const image = await loadImage(posterBytes)
      const { width, height } = image
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const data = ctx.getImageData(0, 0, width, height).data
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return true
      }
      return false
    }
    catch {
      return true // 探测失败按含透明处理（保守）
    }
  }

  async function transcodeOne(assetName) {
    const gifPath = path.join(assetsDir, assetName)
    const stat = await fsp.stat(gifPath)
    if (stat.size <= thresholdBytes) {
      // 文件不大也可能解码体量巨大（帧数多/分辨率高），同样需要转码
      const decoded = await estimateDecodedBytes(gifPath)
      if (decoded <= decodedCapBytes) return null
      log(`[gif-transcode] ${assetName.slice(0, 12)} 文件仅 ${(stat.size / 1e6).toFixed(1)}MB 但解码体量 ${(decoded / 1048576).toFixed(0)}MB 超限，转码为视频`)
    }
    const workDir = path.join(assetsDir, `.transcode-${crypto.randomUUID().slice(0, 8)}`)
    await fsp.mkdir(workDir, { recursive: true })
    try {
      const t0 = Date.now()
      const hasAlpha = await firstFrameHasAlpha(gifPath, workDir)
      // probe.png 是永久的降级兜底：无论编码器成败，首帧静态图都能终结解码驻留
      const posterBytes = await fsp.readFile(path.join(workDir, 'probe.png')).catch(() => null)
      const scale = `scale='min(${MAX_VIDEO_WIDTH},iw)':-2`
      const encoders = await listEncoders(log)

      let videoBytes = null
      let videoExt = 'mp4'
      let label = ''
      // 编码器回退链（详见 opaqueEncoderPlan）：按 ffmpeg 构建实际具备的编码器依次尝试。
      // 含透明 GIF 只有 VP9 yuva420p 能保透明；无 VP9 时走静态首帧降级（不透明化会出现黑块）
      const chain = hasAlpha
        ? (encoders.has('libvpx-vp9') ? ['libvpx-vp9'] : [])
        : ['libx264', 'h264_rkmpp', 'libvpx-vp9', 'mpeg4'].filter(n => encoders.has(n) || n === 'mpeg4')
      for (const name of chain) {
        const plan = hasAlpha
          ? { args: ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-crf', '34', '-b:v', '0', '-pix_fmt', 'yuva420p'], ext: 'webm', label: 'VP9-透明' }
          : opaqueEncoderPlan(name)
        const out = path.join(workDir, `out.${plan.ext}`)
        try {
          await runFfmpeg(await ffmpegReady(), ['-y', '-i', gifPath, '-an', '-vf', scale, ...plan.args, out])
          const bytes = await fsp.readFile(out)
          if (!bytes.length) throw new Error('转码产物为空')
          videoBytes = bytes
          videoExt = plan.ext
          label = plan.label
          break
        }
        catch (error) {
          log(`[gif-transcode] 编码器 ${name} 失败（${String(error.message).slice(0, 120)}），尝试下一个`)
        }
      }

      if (videoBytes) {
        const videoAsset = await storeAsset(videoBytes, videoExt)
        const posterAsset = posterBytes ? await storeAsset(posterBytes, 'png') : null
        const sec = ((Date.now() - t0) / 1000).toFixed(1)
        log(`[gif-transcode] ${assetName} ${(stat.size / 1e6).toFixed(1)}MB → ${videoAsset} ${(videoBytes.length / 1e6).toFixed(1)}MB（${label}，${sec}s）`)
        return { videoAsset, posterAsset }
      }

      // 所有编码器失败：降级为静态首帧。巨型 GIF 原样下发播放端必然造成
      // 解码驻留卡死（RK3588 整机假死实测根因），静态图是最后防线
      if (posterBytes?.length) {
        const posterAsset = await storeAsset(posterBytes, 'png')
        log(`[gif-transcode] 警告：${assetName} 全部编码器失败，已降级为静态首帧（${(stat.size / 1e6).toFixed(1)}MB GIF 不再下发播放端）`)
        return { staticAsset: posterAsset }
      }
      throw new Error('转码失败且无法提取首帧')
    }
    finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 解析 GIF 画布尺寸与帧数（只扫块结构不解码像素），估算解码后体量。
   *  服务端瞬时读入整文件（≤转码阈值量级，读完即释放）；块结构扫描逻辑
   *  与诊断脚本同源，已对全部真实素材验证帧数正确。 */
  async function estimateDecodedBytes(gifPath) {
    try {
      const buf = await fsp.readFile(gifPath)
      if (buf.subarray(0, 3).toString('latin1') !== 'GIF') return 0
      const width = buf.readUInt16LE(6)
      const height = buf.readUInt16LE(8)
      let i = 13
      if (buf[10] & 0x80) i += 3 * (2 ** ((buf[10] & 7) + 1))
      let frames = 0
      while (i < buf.length) {
        const b = buf[i]
        if (b === 0x3b) break
        if (b === 0x21) { i += 2; while (i < buf.length && buf[i] !== 0) i += buf[i] + 1; i++ }
        else if (b === 0x2c) {
          frames++
          const hasLct = buf[i + 9] & 0x80
          i += 10 + (hasLct ? 3 * (2 ** ((buf[i + 9] & 7) + 1)) : 0)
          i++ // LZW 最小码长
          while (i < buf.length && buf[i] !== 0) i += buf[i] + 1
          i++
        }
        else break
      }
      return frames * width * height * 4
    }
    catch { return 0 }
  }

  /**
   * 改写 bundle 中超过阈值的 GIF 覆盖层为视频元素；返回是否发生变化。
   * 幂等：已升级（type=video）与转码失败（memo null）都会跳过。
   */
  async function upgradeBundleOverlays(bundle) {
    if (!(await ffmpegReady()) || !bundle?.slides) return false
    let changed = false
    for (const slide of bundle.slides) {
      if (!Array.isArray(slide.elements)) continue
      for (let i = 0; i < slide.elements.length; i++) {
        const el = slide.elements[i]
        if (el?.type !== 'image' || typeof el.src !== 'string') continue
        const assetName = el.src.startsWith(`${assetUrlPrefix}/assets/`) ? decodeURIComponent(el.src.split('/').pop()) : ''
        if (!assetName.endsWith('.gif')) continue
        if (!memo.has(assetName)) {
          const result = await transcodeOne(assetName).catch(error => {
            log(`[gif-transcode] ${assetName} 转码失败，保留 GIF：`, error.message)
            return null
          })
          memo.set(assetName, result)
        }
        const result = memo.get(assetName)
        if (!result) continue
        if (result.staticAsset) {
          // 编码器全败的降级：GIF → 静态首帧（type 仍为 image，保住原有布局属性）
          slide.elements[i] = {
            ...el,
            src: `${assetUrlPrefix}/assets/${result.staticAsset}`,
          }
          changed = true
          continue
        }
        slide.elements[i] = {
          ...el,
          type: 'video',
          src: `${assetUrlPrefix}/assets/${result.videoAsset}`,
          autoplay: true,
          loop: true,
          muted: true,
          ...(result.posterAsset ? { poster: `${assetUrlPrefix}/assets/${result.posterAsset}` } : {}),
        }
        changed = true
      }
    }
    return changed
  }

  /** 串行队列：同一时间只跑一个转码，避免内存/CPU 叠加 */
  function enqueue(task) {
    const next = queue.then(task, task)
    queue = next.catch(() => {})
    return next
  }

  return {
    ensureFfmpeg: ffmpegReady,
    enqueue,
    upgradeBundleOverlays,
  }
}
