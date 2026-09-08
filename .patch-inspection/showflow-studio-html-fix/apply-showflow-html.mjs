#!/usr/bin/env node
/** Apply only the reviewed source patch; never touches dist/data/config/dependencies. */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const hash = data => crypto.createHash('sha256').update(data).digest('hex')
async function read(file) { try { return await fs.readFile(file) } catch (e) { if(e.code==='ENOENT') return null; throw e } }
function validPath(name) { return typeof name === 'string' && !path.isAbsolute(name) && !name.includes('\\') && name.split('/').every(p=>p && p!=='.' && p!=='..') && !/^(data|dist|node_modules|deploy)(\/|$)/.test(name) }
async function noSymlinks(root, rel) {
 let current=root
 for(const part of rel.split('/')) { current=path.join(current,part); try { if((await fs.lstat(current)).isSymbolicLink()) throw new Error(`拒绝写入符号链接：${current}`) } catch(e){ if(e.code!=='ENOENT')throw e } }
}
async function atomic(file, data) { await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,data);await fs.rename(temp,file)}finally{await fs.rm(temp,{force:true}).catch(()=>{})} }
async function main() {
 const args=process.argv.slice(2), check=args.includes('--check'), targetArg=args.find(x=>x!=='--check')
 if(!targetArg)throw new Error('用法：node apply-showflow-html.mjs "最新工程根目录" [--check]')
 const target=await fs.realpath(path.resolve(targetArg))
 const manifest=JSON.parse(await fs.readFile(path.join(here,'patch-manifest.json'),'utf8'))
 const pkg=await read(path.join(target,'package.json'))
 if(!pkg || JSON.parse(pkg).name!=='pptist' || !await read(path.join(target,'src/views/Studio/index.vue')))throw new Error('这不是最新源码根目录。请选择包含 src、server、package.json 的目录；不能选择 deploy/pptist。')
 const items=[]
 for(const entry of manifest.files) {
  if(!validPath(entry.path))throw new Error('补丁清单含非法路径')
  await noSymlinks(target,entry.path)
  const payload=await read(path.join(here,'replacement',entry.path))
  if(!payload || hash(payload)!==entry.afterSha256)throw new Error(`修复包文件损坏：${entry.path}`)
  const current=await read(path.join(target,entry.path)), currentHash=current?hash(current):null
  if(currentHash===entry.afterSha256)continue
  if(currentHash!==entry.beforeSha256)throw new Error(`版本不一致，尚未修改任何文件：${entry.path}\n请使用用户提供的 pptist_sync-feature-virtual-show-flow.zip 根目录源码。教师另有改动时请人工合并 changes.diff；不要强制覆盖。`)
  items.push({...entry,current,payload})
 }
 if(!items.length){console.log('这份源码已经应用过本修复包。确认重新构建并部署过前端即可。');return}
 console.log(`校验通过：${items.length} 个源文件需要新增/替换。不会修改 data、dist、deploy、node_modules、配置和已保存方案。`)
 if(check){console.log('仅检查完成，未写入文件。');return}
 const backup=path.join(target,'.showflow-studio-html-backup-'+new Date().toISOString().replace(/[:.]/g,'-'))
 await fs.mkdir(backup,{recursive:true})
 const journal={format:'showflow-source-backup/1.0',target,createdAt:new Date().toISOString(),files:items.map(({path,beforeSha256,afterSha256})=>({path,beforeSha256,afterSha256}))}
 for(const e of items)if(e.current){const p=path.join(backup,'original',e.path);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,e.current)}
 await fs.writeFile(path.join(backup,'backup.json'),JSON.stringify(journal,null,2))
 const written=[]
 try {
  for(const e of items){await atomic(path.join(target,e.path),e.payload);written.push(e)}
 } catch(error) {
  for(const e of written.reverse()){if(e.current)await atomic(path.join(target,e.path),e.current);else await fs.rm(path.join(target,e.path),{force:true})}
  throw new Error(`写入失败，已还原本次已写入文件：${error.message}。备份位于 ${backup}`)
 }
 console.log('ShowFlow 原主题入口 HTML 源码修复完成。')
 console.log('源码备份：'+backup)
 console.log('下一步必须在工程根目录执行：npm run build')
 console.log('依赖尚未安装时先执行 npm ci；构建或类型检查失败时停止部署，不要沿用旧 dist。')
 console.log('运行根目录服务：按原方式停止旧服务后 npm run server；Linux/RK3588 则从更新后的根源码重新打包部署。')
 console.log('访问 /studio/theme → 原文件选择框上传 HTML → 设为 Draft → 预览 → 发布。主屏 PPT 不替换。')
}
main().catch(error=>{console.error('\n停止：'+error.message);process.exitCode=1})
