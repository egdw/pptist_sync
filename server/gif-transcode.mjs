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

export function createGifTranscoder({ assetsDir, thresholdMB = 24, log = () => {} }) {
  const thresholdBytes = Math.max(0, Number(thresholdMB) || 0) * 1024 * 1024
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
      const image = await loadImage(poster)
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
    if (stat.size <= thresholdBytes) return null
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
        const assetName = el.src.startsWith('/default-ppt-api/assets/') ? decodeURIComponent(el.src.split('/').pop()) : ''
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
          src: `/default-ppt-api/assets/${result.videoAsset}`,
          autoplay: true,
          loop: true,
          muted: true,
          ...(result.posterAsset ? { poster: `/default-ppt-api/assets/${result.posterAsset}` } : {}),
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
