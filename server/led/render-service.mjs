import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LED_ROLES } from './role-config.mjs'
import { renderLedJpeg } from './renderer.mjs'

export function createLedRenderService({ cacheDir, portraitDir, publicUrl = '' }) {
  let revision = 0
  const render = async (state, requestOrigin = '') => {
    const nextRevision = ++revision
    const screens = []
    await Promise.all(LED_ROLES.map(async role => {
      const data = await renderLedJpeg(state, role, portraitDir)
      const dir = path.join(cacheDir, role)
      await fsp.mkdir(dir, { recursive: true })
      const filename = `${nextRevision}.jpg`
      const target = path.join(dir, filename)
      const temp = `${target}.${crypto.randomUUID()}.tmp`
      await fsp.writeFile(temp, data)
      await fsp.rename(temp, target)
      screens.push({
        role,
        url: `${publicUrl || requestOrigin}/led/${role}/${filename}`,
        format: 'jpeg', width: 1280, height: 800,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      })
    }))
    screens.sort((a, b) => LED_ROLES.indexOf(a.role) - LED_ROLES.indexOf(b.role))
    return { revision: nextRevision, screens }
  }
  return { render }
}
