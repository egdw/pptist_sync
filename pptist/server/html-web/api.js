export const $ = (s, root = document) => root.querySelector(s)
export function uid() { return Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join('') }
export function text(node, value) { node.textContent = value == null ? '' : String(value) }
let key = ''
export function setKey(value) { key = value }
export async function request(route, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PPTist-Upload-Key': key }, body: JSON.stringify(body) }
  const res = await fetch('/html-api' + route, { cache: 'no-store', ...options })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data) throw new Error(data?.error || `请求失败（${res.status}）`)
  return data
}
export async function source(version) {
  const res = await fetch('/html-api/source/' + encodeURIComponent(version), { cache: 'no-store' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || '读取 HTML 失败')
  return res.text()
}
export function upload(file, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/html-api/upload?filename=' + encodeURIComponent(file.name))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (key) xhr.setRequestHeader('X-PPTist-Upload-Key', key)
    xhr.timeout = 120000
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.min(99, Math.round(100 * e.loaded / e.total))) }
    xhr.onerror = () => reject(new Error('网络连接失败，请检查服务器'))
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'))
    xhr.onload = () => {
      let data
      try { data = JSON.parse(xhr.responseText) } catch { reject(new Error('服务器响应无效，请确认已安装 HTML 扩展')); return }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) { progress(100); resolve(data) }
      else reject(new Error(data.error || `上传失败（${xhr.status}）`))
    }
    xhr.send(file)
  })
}
export function subscribe(callback, onError) {
  const s = new EventSource('/html-api/events')
  s.addEventListener('state', e => { try { callback(JSON.parse(e.data)) } catch (err) { console.warn('HTML 状态通知失败', err) } })
  s.onerror = () => onError?.()
  return () => s.close()
}
export function saveTextFile(filename, content) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
