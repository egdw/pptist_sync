/* eslint-env node */
/* eslint-disable no-console */
/**
 * SecondaryShowFlowClient 行为自测入口：
 *   npm run test:showflow:secondary
 *
 * 原理同 tests/showflow-ws/run-controller.mjs：esbuild 打包后交给 Node 执行。
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(here, '.bundled-secondary-test.mjs')

await build({
  entryPoints: [path.join(here, 'secondary.test.mts')],
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
