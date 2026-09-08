#!/usr/bin/env node
/** Restore reviewed source backup; does not delete user data or HTML uploads. */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
async function read(p){try{return await fs.readFile(p)}catch(e){if(e.code==='ENOENT')return null;throw e}}
async function atomic(p,b){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,b);await fs.rename(tmp,p)}finally{await fs.rm(tmp,{force:true}).catch(()=>{})}}
async function main(){
 const [rootArg,backupArg]=process.argv.slice(2)
 if(!rootArg||!backupArg)throw new Error('用法：node restore-showflow-html.mjs "工程根目录" "安装时输出的备份目录"')
 const root=await fs.realpath(path.resolve(rootArg)),backup=await fs.realpath(path.resolve(backupArg))
 const journal=JSON.parse(await fs.readFile(path.join(backup,'backup.json'),'utf8'))
 if(journal.format!=='showflow-source-backup/1.0'||journal.target!==root)throw new Error('备份与目标目录不匹配')
 const changes=[]
 for(const e of journal.files){
  if(typeof e.path!=='string'||path.isAbsolute(e.path)||e.path.includes('\\')||e.path.split('/').some(v=>!v||v==='..'||v==='.')||/^(data|dist|node_modules|deploy)(\/|$)/.test(e.path))throw new Error('备份清单路径不合法')
  let cur=root
  for(const part of e.path.split('/')){cur=path.join(cur,part);try{if((await fs.lstat(cur)).isSymbolicLink())throw new Error('拒绝恢复符号链接')}catch(x){if(x.code!=='ENOENT')throw x}}
  const current=await read(path.join(root,e.path)),sha=current?hash(current):null
  if(sha===e.beforeSha256)continue
  if(sha!==e.afterSha256)throw new Error(`发现安装后的其他修改，停止覆盖：${e.path}`)
  const original=e.beforeSha256?await read(path.join(backup,'original',e.path)):null
  if(e.beforeSha256&&(!original||hash(original)!==e.beforeSha256))throw new Error('备份损坏：'+e.path)
  changes.push({...e,original})
 }
 for(const e of changes){const p=path.join(root,e.path);if(e.original)await atomic(p,e.original);else await fs.rm(p,{force:true})}
 console.log(`已恢复 ${changes.length} 个源码文件；data、已上传 HTML、配置和旧 dist 均未删除。`)
 console.log('请在启动前使用对应原版本源码重新 npm run build，或恢复升级前完整 dist；前后端版本必须匹配。')
 console.log('旧程序不认识 HTML 主题：回滚代码前应在 Studio 选回旧 CSS 主题并发布，或同步恢复升级前 data 备份。')
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
