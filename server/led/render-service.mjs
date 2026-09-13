import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { LED_ROLES } from './role-config.mjs'
import { renderLedJpeg } from './renderer.mjs'

export function createLedRenderService({ cacheDir, portraitDir, publicUrl = '' }) {
  let revision = 0
  let lastResult = null
  /** 渲染结果缓存：state+theme+头像指纹 相同的直接复用（后退/重访步骤不再
   *  重复渲染，也保持 URL 不变——板端按 sha256 可跳过重复下载）。 */
  const renderCache = new Map()
  const CACHE_MAX = 64

  const portraitFingerprint = () => LED_ROLES.map(role => {
    try {
      const stat = fs.statSync(path.join(portraitDir, `${role}.image`))
      return `${role}:${stat.size}:${Math.round(stat.mtimeMs)}`
    }
    catch {
      return `${role}:-`
    }
  }).join('|')

  // 磁盘缓存上限：内容寻址文件按 mtime 保留最近若干张，否则每次状态变化
  // 留 4 张、永不清理（实测单角色累积 129 张）。
  async function pruneRoleDir(role, keep = 12) {
    try {
      const dir = path.join(cacheDir, role)
      const names = (await fsp.readdir(dir)).filter(n => /\.(jpg|tmp)$/.test(n))
      const stats = await Promise.all(names.map(async name => ({
        name,
        mtime: (await fsp.stat(path.join(dir, name)).catch(() => null))?.mtimeMs || 0,
      })))
      stats.sort((a, b) => b.mtime - a.mtime)
      for (const { name } of stats.slice(keep)) {
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {})
      }
    }
    catch { /* 目录不存在时忽略 */ }
  }

  const render = async (state, requestOrigin = '', theme = {}) => {
    const nextRevision = ++revision
    const fingerprint = JSON.stringify([state, theme, portraitFingerprint()])
    const screens = []
    await Promise.all(LED_ROLES.map(async role => {
      const cacheKey = crypto.createHash('sha256').update(`${fingerprint}:${role}`).digest('hex')
      const cached = renderCache.get(cacheKey)
      if (cached) {
        screens.push({ role, ...cached })
        return
      }
      const data = await renderLedJpeg(state, role, portraitDir, theme)
      const dir = path.join(cacheDir, role)
      await fsp.mkdir(dir, { recursive: true })
      // 内容寻址文件名：相同画面共用同一 URL，板端/浏览器可按 sha 跳过重复下载
      const contentSha = crypto.createHash('sha256').update(data).digest('hex')
      const filename = `${contentSha.slice(0, 32)}.jpg`
      const target = path.join(dir, filename)
      if (!(await fsp.stat(target).catch(() => null))) {
        const temp = `${target}.${crypto.randomUUID()}.tmp`
        await fsp.writeFile(temp, data)
        await fsp.rename(temp, target)
      }
      void pruneRoleDir(role)
      const entry = {
        url: `${publicUrl || requestOrigin}/led/${role}/${filename}`,
        format: 'jpeg', width: 1280, height: 800,
        sha256: contentSha,
      }
      renderCache.set(cacheKey, entry)
      if (renderCache.size > CACHE_MAX) renderCache.delete(renderCache.keys().next().value)
      screens.push({ role, ...entry })
    }))
    screens.sort((a, b) => LED_ROLES.indexOf(a.role) - LED_ROLES.indexOf(b.role))
    lastResult = { revision: nextRevision, screens, renderedAt: Date.now() }
    return { revision: nextRevision, screens }
  }
  async function init() {
    for (const role of LED_ROLES) await pruneRoleDir(role)
  }
  return { render, init, getStatus: () => lastResult }
}
