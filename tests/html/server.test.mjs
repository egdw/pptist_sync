/** Run: node tests/html/server.test.mjs. No npm packages required. Isolated test data. */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pptist-html-test-'))
const dist = path.join(temp, 'dist'), data = path.join(temp, 'data')
await fsp.mkdir(dist)
await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><html><body>original-spa-fixture</body></html>')
const port = 18963, base = `http://127.0.0.1:${port}`
let child, count = 0, output = ''
const ok = v => { count++; console.log('✓ ' + v) }
async function start(extra = {}) {
  child = spawn(process.execPath, [path.join(ROOT, 'server/pptist-server.mjs')], { env: { ...process.env, PPTIST_PORT: String(port), PPTIST_DATA_DIR: data, PPTIST_DIST_DIR: dist, PPTIST_HTML_MAX_MB: '2', PPTIST_REMOTE_API: '', ...extra } })
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
  for (let i=0;i<80;i++) { try { if ((await fetch(base + '/html-api/config')).ok) return } catch {} await new Promise(r=>setTimeout(r,75)) }
  throw new Error('start failed: ' + output)
}
async function stop() { if (child?.exitCode === null) { child.kill(); await new Promise(r => child.once('exit',r)) } }
async function json(route, body, headers = {}) { const r = await fetch(base+route, body === undefined ? {} : { method:'POST', headers: {'Content-Type':'application/json', ...headers}, body:JSON.stringify(body) }); return { status:r.status, data: await r.json() } }
async function upload(html, name = '工作.html', headers={}) { const r=await fetch(base+'/html-api/upload?filename='+encodeURIComponent(name), {method:'POST',headers:{'Content-Type':'application/octet-stream',...headers},body:html}); return { status:r.status,data:await r.json() } }
const html = '<!doctype html><html><head><meta charset="utf-8"><title>中文工作页</title></head><body><h1>完整 HTML</h1><script>window.test=1</script></body></html>'
const sha = str => crypto.createHash('sha256').update(str).digest('hex')
let a,b,reader
try {
 await start()
 assert.equal((await json('/html-api/config')).data.maxUploadMB,2); ok('HTML 独立配置可读')
 assert.deepEqual((await json('/default-ppt-api/config')).data.acceptTypes,['.pptx','.pdf']);ok('原 PPT/PDF 接口类型未改')
 assert.equal((await json('/html-api/current')).data.mode,'ppt');ok('初始播放源保持 PPT')
 assert((await(await fetch(base+'/upload')).text()).includes('HTML 工作流程'));ok('/upload 提供 HTML 上传入口')
 assert((await(await fetch(base+'/upload?type=ppt')).text()).includes('original-spa-fixture'));ok('原 PPT 上传路径保留并注入入口')
 assert((await(await fetch(base+'/editor')).text()).includes('original-spa-fixture'));ok('原编辑器路由回退未变')
 assert.equal((await upload('x','photo.png')).status,400);ok('拒绝非 HTML 后缀')
 assert.equal((await upload('')).status,400);ok('拒绝空文件')
 assert.equal((await upload('<script>alert(1)</script>')).status,400);ok('拒绝非完整 HTML 文档')
 assert.equal((await upload(Buffer.from([0xff,0xfe,0x00,0x61]))).status,400);ok('拒绝无效 UTF-8')
 assert.equal((await upload(Buffer.alloc(2*1024*1024+1,97))).status,413);ok('拒绝超限文件')
 assert.equal((await upload(html,'a.html',{Origin:'null'})).status,403);ok('禁止沙箱来源写入')
 assert.equal((await upload(html,'a.html',{Origin:'https://other.example'})).status,403);ok('禁止跨站来源写入')
 a=(await upload(html,'测试工作.html',{Origin:base})).data;assert(a.ok&&a.version);ok('同源 HTML 上传成功')
 assert.equal((await json('/html-api/current')).data.activeVersion,null);ok('上传不自动启用，不打断现有大屏')
 let r=await fetch(base+'/html-api/source/'+a.version);assert(r.headers.get('Content-Type').startsWith('text/plain'));assert.equal(sha(await r.text()),sha(html));ok('原始文件完整存储，不按同源 HTML 执行')
 r=await fetch(base+'/html-api/file/'+a.version);assert(r.headers.get('Content-Disposition').includes('attachment'));assert.equal(sha(Buffer.from(await r.arrayBuffer())),sha(html));ok('下载内容与上传字节完全一致')
 const ac=new AbortController();r=await fetch(base+'/html-api/events',{signal:ac.signal});reader=r.body.getReader();assert(new TextDecoder().decode((await reader.read()).value).includes('event: state'));ok('SSE 首次状态通知')
 assert.equal((await json('/html-api/activate',{version:a.version})).status,200);const notice=new TextDecoder().decode((await reader.read()).value);assert(notice.includes(a.version));await reader.cancel();ac.abort();ok('启用原子切换并发送 SSE 通知')
 assert((await(await fetch(base+'/play')).text()).includes('/html-support/play.js'));ok('/play 自动使用启用后的 HTML 播放器')
 assert((await(await fetch(base+'/play?type=ppt')).text()).includes('original-spa-fixture'));ok('仍可强制访问原 PPT 播放器')
 b=(await upload(html.replace('完整 HTML','更新 HTML'),'测试工作.html')).data
 assert.notEqual(a.version,b.version);assert.equal((await json('/html-api/current')).data.activeVersion,a.version);ok('同名重复上传生成独立版本，尚不替换当前版本')
 assert.equal((await json('/html-api/activate',{version:'../../oops'})).status,400);assert.equal((await json('/html-api/current')).data.activeVersion,a.version);ok('非法启用不影响旧版本')
 await json('/html-api/activate',{version:b.version});await json('/html-api/activate',{version:a.version});assert.equal((await json('/html-api/current')).data.activeVersion,a.version);ok('历史版本可以重新启用 / 回退')
 assert.equal((await json('/html-api/versions')).data.versions.length,2);ok('历史文件保留')
 await stop();await start();assert.equal((await json('/html-api/current')).data.activeVersion,a.version);ok('重启后持久化恢复')
 assert.equal((await json('/html-api/select-ppt',{})).status,409);ok('没有原 PPT 时明确报错，保持 HTML')
 const raw=Buffer.from('PK\x03\x04original-pptx'), bundle=Buffer.from(JSON.stringify({slides:[{id:'test',elements:[]}],title:'original'})), header=Buffer.from(JSON.stringify({filename:'test.pptx',pageCount:1})), lens=Buffer.alloc(8);lens.writeUInt32BE(header.length,0);lens.writeUInt32BE(bundle.length,4)
 r=await fetch(base+'/default-ppt-api/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.concat([lens,header,bundle,raw])});assert.equal(r.status,200);assert.equal((await json('/html-api/current')).data.mode,'ppt');ok('原二进制 PPT 上传协议仍工作，上传成功切回 PPT')
 const stored=await fsp.readFile(path.join(data,'versions/v1/raw.file'));assert.deepEqual(stored,raw);ok('原 PPT 文件路径和字节保持原逻辑')
 await json('/html-api/activate',{version:a.version});assert.equal((await json('/default-ppt-api/current')).data.filename,'test.pptx');ok('启用 HTML 不删除或替换 PPT 数据')
 await json('/html-api/select-ppt',{});assert.equal((await json('/html-api/current')).data.mode,'ppt');ok('可随时切回已存 PPT')
 assert.equal((await fetch(base+'/html-support/not-a-file.js')).status,404);ok('扩展静态资源白名单')
 await stop();await start({PPTIST_HTML_UPLOAD_KEY:'secret-test'})
 assert.equal((await upload(html)).status,401);assert.equal((await upload(html,'key.html',{'X-PPTist-Upload-Key':'secret-test'})).status,201);ok('可选管理口令校验')
 console.log(`\n${count} tests passed. SPA routing tests use an index fixture; no claim of full PPT UI browser coverage.`)
}
catch(e) { console.error(e);console.error(output);process.exitCode=1 }
finally { await stop();await fsp.rm(temp,{recursive:true,force:true}) }
