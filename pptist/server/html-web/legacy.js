// Response-time add-on for the original SPA. No imports from / changes to the PPT rendering pipeline.
import { subscribe } from './api.js'
if (location.pathname === '/upload') {
  const bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;bottom:18px;right:20px;z-index:99999;background:#0c2846;color:white;padding:12px 20px;border-radius:10px;box-shadow:0 4px 20px #0004;font:15px system-ui'
  const link = document.createElement('a'); link.href = '/upload'; link.textContent = '切换到 HTML 网页上传 →'; link.style.cssText = 'color:#fff;text-decoration:none'
  bar.append(link); document.body.append(bar)
}
if (location.pathname === '/play' && new URLSearchParams(location.search).get('type') !== 'ppt') {
  subscribe(s => { if (s.mode === 'html') location.reload() })
}
