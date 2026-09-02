/* eslint-env node */
/* eslint-disable no-console */
/**
 * 运行“放映联动”针对性验证：
 *   npm run test:presentation
 * 或：node tests/presentation-link/run.mjs
 *
 * 原理：用项目自带的 esbuild 将 entry.ts（含 src 下的纯逻辑与通道模块）打包为
 * 单文件 ESM，再交给 Node 执行；本地 WS 服务端与 MQTT Broker（aedes，仅 --no-save 安装）
 * 由测试自建自停，不依赖任何外部服务。
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(here, '.bundled-entry.mjs')

await build({
  entryPoints: [path.join(here, 'entry.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  alias: { '@': path.resolve(here, '../../src') },
  // 测试专用依赖（本地 Broker 等）保持 Node 原生解析，不参与打包
  external: ['aedes', 'websocket-stream', 'ws', 'mqtt'],
  define: {
    'process.env.NODE_ENV': '"test"',
  },
  logLevel: 'silent',
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
fs.rmSync(outfile, { force: true })
process.exit(result.status ?? 1)
