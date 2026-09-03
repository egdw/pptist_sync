/* eslint-env node */
/* eslint-disable no-console */
/**
 * ShowFlowController 行为自测：
 *   npm run test:showflow:controller
 *
 * 原理同 tests/presentation-link/run.mjs：esbuild 打包为单文件 ESM 后交给 Node 执行。
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(here, '.bundled-controller-test.mjs')

await build({
  entryPoints: [path.join(here, 'controller.test.mts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  logLevel: 'silent',
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
fs.rmSync(outfile, { force: true })
process.exit(result.status ?? 1)
