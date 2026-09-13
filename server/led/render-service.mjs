import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LED_ROLES } from './role-config.mjs'
import { renderLedJpeg } from './renderer.mjs'

export function createLedRenderService({ cacheDir, portraitDir, publicUrl = '' }) {
  let revision = 0
  let lastResult = null
  // 磁盘缓存上限：每个角色仅保留最近几张 revision JPEG，否则每次状态变化
  // 留 4 张、永不清理（实测单角色累积 129 张）。retain 迟到下载 + 当前即够用。
  async function pruneRoleDir(role, keep = 3) {
    try {
      const names = (await fsp.readdir(path.join(cacheDir, role))).filter(n => /^\d+\.jpg$/.test(n))
      names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))
      for (const name of names.slice(keep)) {
        await fsp.rm(path.join(cacheDir, role, name), { force: true }).catch(() => {})
      }
    }
    catch { /* 目录不存在时忽略 */ }
  }
  const render = async (state, requestOrigin = '', theme = {}) => {
    const nextRevision = ++revision
    const screens = []
    await Promise.all(LED_ROLES.map(async role => {
      const data = await renderLedJpeg(state, role, portraitDir, theme)
      const dir = path.join(cacheDir, role)
      await fsp.mkdir(dir, { recursive: true })
      const filename = `${nextRevision}.jpg`
      const target = path.join(dir, filename)
      const temp = `${target}.${crypto.randomUUID()}.tmp`
      await fsp.writeFile(temp, data)
      await fsp.rename(temp, target)
      void pruneRoleDir(role)
      screens.push({
        role,
        url: `${publicUrl || requestOrigin}/led/${role}/${filename}`,
        format: 'jpeg', width: 1280, height: 800,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      })
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
