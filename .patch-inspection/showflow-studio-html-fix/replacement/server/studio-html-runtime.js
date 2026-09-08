/* Host side of the Studio HTML renderer. It is the existing secondary role,
   not an alternate PPT player. Draft/thumbnail mode NEVER registers a role. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const preview = params.get('studio') === 'draft' || params.has('thumb');
  document.body.classList.toggle('preview', preview);
  const $ = id => document.getElementById(id);
  let config, frame, token, rendered = null, ws, stopped = false, sessionId = null;
  let retryDelay = 1000, retryTimer, heartbeat, updateTimer, captureTimer;
  let joined = false, readyResolve, readyReject;
  const completed = new Map(), inFlight = new Map(), requests = new Map(), captures = new Set();
  const requestId = () => { const a = new Uint32Array(4); crypto.getRandomValues(a); return [...a].map(n => n.toString(16)).join(''); };
  function fail(message) { $('status-title').textContent = '流程网页加载失败'; $('status-text').textContent = message; $('status').hidden = false; $('status').classList.add('failed'); }
  function updateState(state) {
    if (!state || !Number.isInteger(state.pageIndex) || config.manifest[state.pageIndex]?.id !== state.pageId || state.pageCount !== config.manifest.length) throw new Error('副屏状态不在已发布清单内');
    rendered = state; $('page-picker').value = state.pageId;
    $('prev').disabled = state.pageIndex === 0; $('next').disabled = state.pageIndex === config.manifest.length - 1;
  }
  const getConfig = async () => {
    const q = new URLSearchParams({ scope: preview ? 'draft' : 'active' });
    if (preview && params.get('studioTheme')) q.set('theme', params.get('studioTheme'));
    const r = await fetch('/api/studio/render-config?' + q, { cache: 'no-store' });
    if (!r.ok) throw new Error('读取 Studio 页面配置失败');
    return r.json();
  };
  async function load() {
    config = await getConfig();
    if (config.kind !== 'html') { location.reload(); return; }
    token = requestId();
    const results = await Promise.all([config.contentUrl, '/api/studio/html-bridge.js', '/reveal/vendor/html-to-image.js'].map(async url => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('读取页面资源失败'); return r.text(); }));
    const [html, bridge, captureLib] = results;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('base,meta[http-equiv]').forEach(el => el.remove());
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
    doc.head.prepend(policy);
    const data = doc.createElement('script'); data.id = 'showflow-bridge-config'; data.type = 'application/json';
    data.textContent = JSON.stringify({ token, parentOrigin: location.origin, adapter: config.adapter, manifest: config.manifest }).replace(/</g, '\\u003c');
    const capture = doc.createElement('script'); capture.textContent = captureLib.replace(/<\/script/gi, '<\\/script');
    const script = doc.createElement('script'); script.textContent = bridge;
    doc.body.append(data, capture, script);
    frame = document.createElement('iframe'); frame.title = 'ShowFlow 流程图';
    frame.setAttribute('sandbox', 'allow-scripts'); // deliberately no allow-same-origin
    frame.setAttribute('allow', 'fullscreen *');
    frame.referrerPolicy = 'no-referrer';
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timeout = setTimeout(() => readyReject(new Error('HTML 15 秒内未就绪，请检查控制接口或缺失资源')), 15000);
    frame.srcdoc = '<!doctype html>\n' + doc.documentElement.outerHTML;
    $('stage').replaceChildren(frame);
    $('page-picker').replaceChildren(...config.manifest.map(p => { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = `${String(p.index).padStart(2, '0')} · ${p.title}`; return opt; }));
    try { await ready; } finally { clearTimeout(timeout); }
    if (preview) {
      const index = Math.max(0, Math.min(config.manifest.length - 1, Number(params.get('studioPage') || 0)));
      if (Number.isInteger(index) && index) await navigate(config.manifest[index].id);
      $('connection').textContent = 'Draft 预览 · 不发送联动消息';
    }
    $('status').hidden = true;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!preview) connect();
    updateTimer = setInterval(async () => {
      if (preview) return;
      try { const next = await getConfig(); if (next.id !== config.id || next.fingerprint !== config.fingerprint || next.kind !== 'html') $('update').style.display = 'block'; } catch { /* keep current content offline */ }
    }, 4000);
  }
  window.addEventListener('message', e => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== 'null' || e.data?.token !== token) return;
    const msg = e.data;
    try {
      if (msg.type === 'sf-html:ready') { updateState(msg.state); readyResolve?.(); }
      if (msg.type === 'sf-html:state') { updateState(msg.state); scheduleCapture(); }
      if (msg.type === 'sf-html:rendered') {
        const task = requests.get(msg.requestId); if (!task) return;
        updateState(msg.state);
        if (msg.state.pageId !== task.pageId || msg.state.overlay) throw new Error('收到的渲染确认与目标不一致');
        clearTimeout(task.timer); requests.delete(msg.requestId); task.resolve(msg.state);
      }
      if (msg.type === 'sf-html:error') {
        const task = requests.get(msg.requestId);
        if (task) { clearTimeout(task.timer); requests.delete(msg.requestId); task.reject(new Error(msg.message || 'HTML 跳页失败')); }
        else if (!rendered) readyReject?.(new Error(msg.message));
      }
      if (msg.type === 'sf-html:capture-result' && captures.delete(msg.requestId) && rendered?.pageId === msg.pageId && typeof msg.image === 'string' && msg.image.startsWith('data:image/jpeg;base64,') && msg.image.length < 7 * 1024 * 1024 && !preview && joined) {
        fetch('/monitor-api/screen/secondary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: rendered.pageIndex + 1, total: config.manifest.length, image: msg.image }) }).catch(() => {});
      }
    } catch (error) { if (!rendered) readyReject?.(error); }
  });
  function navigate(pageId) {
    if (!config.manifest.some(p => p.id === pageId)) return Promise.reject(new Error('PAGE_NOT_FOUND: ' + pageId));
    const id = requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('副屏渲染确认超时')); }, 5000);
      requests.set(id, { pageId, timer, resolve, reject });
      frame.contentWindow.postMessage({ type: 'sf-html:goto', token, pageId, requestId: id }, '*'); // opaque frame: exact origin is unavailable; source+token validated
    });
  }
  function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify({ ...msg, role: 'secondary', sessionId })); }
  function scheduleCapture() {
    if (preview || !joined || ws?.readyState !== 1) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => { const id = requestId(); captures.clear(); captures.add(id); frame.contentWindow.postMessage({ type: 'sf-html:capture', token, requestId: id }, '*'); }, 260);
  }
  async function command(msg) {
    if (msg.sessionId && msg.sessionId !== sessionId) { sessionId = msg.sessionId; completed.clear(); }
    const pageId = msg.pageId || msg.state?.secondaryPageId;
    if (!pageId) return; // keep means keep; no guessed first page
    joined = true;
    const commandSession = sessionId;
    const key = commandSession + ':' + (msg.commandId || requestId());
    let ownsRequest = false;
    try {
      if (completed.has(key)) {
        const previous = completed.get(key);
        if (previous !== pageId) throw new Error('同一 commandId 的目标不一致');
        if (msg.commandId) send({ type: 'ACK', commandId: msg.commandId, pageId, rendered: true });
        return;
      }
      const pending = inFlight.get(key);
      if (pending && pending.pageId !== pageId) throw new Error('同一 commandId 的目标不一致');
      if (!pending) { inFlight.set(key, { pageId, task: navigate(pageId) }); ownsRequest = true; }
      const state = await inFlight.get(key).task;
      if (commandSession !== sessionId) return; // superseded by a newer session
      completed.set(key, pageId); if (completed.size > 64) completed.delete(completed.keys().next().value);
      if (msg.commandId) send({ type: 'ACK', commandId: msg.commandId, pageId: state.pageId, rendered: true });
      scheduleCapture();
    } catch (error) { if (commandSession === sessionId) send({ type: 'ERROR', commandId: msg.commandId, code: config.manifest.some(p => p.id === pageId) ? 'HTML_RENDER_FAILED' : 'PAGE_NOT_FOUND', message: error.message }); }
    finally { if (ownsRequest) inFlight.delete(key); }
  }
  function connect() {
    if (preview || stopped) return;
    $('connection').textContent = '正在连接原双屏控制台';
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/showflow`);
    ws.onopen = () => { retryDelay = 1000; $('connection').textContent = '副屏已连接 · 由 ShowFlow 编排控制'; send({ type: 'HELLO', meta: { screen: 'studio-html', url: location.pathname, theme: config.id } }); heartbeat = setInterval(() => send({ type: 'PING' }), 2000); };
    ws.onmessage = e => { let msg; try { msg = JSON.parse(e.data); } catch { return; } if (msg.type === 'PING') send({ type: 'PONG' }); if (msg.type === 'NAVIGATE' || msg.type === 'SYNC_STATE') void command(msg); };
    ws.onerror = () => ws.close();
    ws.onclose = () => { clearInterval(heartbeat); $('connection').textContent = '联动连接中断 · 保留当前画面'; if (!stopped) { retryTimer = setTimeout(connect, retryDelay); retryDelay = Math.min(30000, retryDelay * 2); } };
  }
  const change = offset => { if (rendered) { const p = config.manifest[rendered.pageIndex + offset]; if (p) navigate(p.id).catch(e => fail(e.message)); } };
  $('prev').onclick = () => change(-1); $('next').onclick = () => change(1);
  $('page-picker').onchange = e => navigate(e.target.value).catch(error => fail(error.message));
  $('full').onclick = () => document.documentElement.requestFullscreen?.().catch(() => {});
  $('update').onclick = () => location.reload(); $('retry').onclick = () => location.reload();
  window.addEventListener('beforeunload', () => { stopped = true; clearInterval(heartbeat); clearInterval(updateTimer); clearTimeout(retryTimer); clearTimeout(captureTimer); ws?.close(); });
  // Existing integrations may inspect SecondScreen; do not overwrite the PPT interface.
  window.SecondScreen = { getManifest: () => config?.manifest || [], gotoById: id => navigate(id), showflowStatus: () => ({ connected: ws?.readyState === 1, sessionId, manifest: config?.manifest || [] }), getCurrentPageId: () => rendered?.pageId || null };
  load().catch(error => fail(error.message));
})();
