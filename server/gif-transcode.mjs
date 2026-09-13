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
  log?.('[gif-transcode] 未找到 ffmpeg（PPTIST_FFMPEG / PATH / .devtools），超大 GIF 保持原状')
  return ''
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
      const out = path.join(workDir, hasAlpha ? 'out.webm' : 'out.mp4')
      const scale = `scale='min(${MAX_VIDEO_WIDTH},iw)':-2`
      if (hasAlpha) {
        await runFfmpeg(await ffmpegReady(), ['-y', '-i', gifPath, '-an', '-vf', scale, '-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-crf', '34', '-b:v', '0', '-pix_fmt', 'yuva420p', out])
      }
      else {
        await runFfmpeg(await ffmpegReady(), ['-y', '-i', gifPath, '-an', '-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
      }
      const videoBytes = await fsp.readFile(out)
      if (!videoBytes.length) throw new Error('转码产物为空')
      const posterBytes = await fsp.readFile(path.join(workDir, 'probe.png')).catch(() => null)
      const videoAsset = await storeAsset(videoBytes, hasAlpha ? 'webm' : 'mp4')
      const posterAsset = posterBytes ? await storeAsset(posterBytes, 'png') : null
      const sec = ((Date.now() - t0) / 1000).toFixed(1)
      log(`[gif-transcode] ${assetName} ${(stat.size / 1e6).toFixed(1)}MB → ${videoAsset} ${(videoBytes.length / 1e6).toFixed(1)}MB（${hasAlpha ? 'VP9-透明' : 'H.264'}，${sec}s）`)
      return { videoAsset, posterAsset }
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
