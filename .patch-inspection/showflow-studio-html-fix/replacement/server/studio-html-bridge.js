/* Runs only INSIDE the opaque-origin HTML frame. No networking or host access. */
(() => {
  'use strict';
  const cfg = JSON.parse(document.getElementById('showflow-bridge-config').textContent);
  const manifest = cfg.manifest;
  const report = (type, extra = {}) => parent.postMessage({ type, token: cfg.token, ...extra }, cfg.parentOrigin === 'null' ? '*' : cfg.parentOrigin);
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let booted = false, lastId = null, serial = Promise.resolve();
  function state() {
    if (cfg.adapter === 'zhizheng') {
      const raw = window.ZhizhengFlow.getState();
      const index = raw.pageIndex;
      if (!Number.isInteger(index) || !manifest[index] || raw.pageId !== manifest[index].id || raw.pageCount !== manifest.length) throw new Error('HTML 实际页码与上传清单不一致');
      return { pageId: manifest[index].id, pageIndex: index, pageCount: manifest.length, overlay: !!raw.overviewOverlay, activeWorkers: raw.activeWorkers || [] };
    }
    if (cfg.adapter === 'showflow') {
      const id = window.ShowFlowPage.getCurrentPageId();
      const index = manifest.findIndex(p => p.id === id);
      if (index < 0) throw new Error('ShowFlowPage 返回了清单外的页面 ID');
      return { pageId: id, pageIndex: index, pageCount: manifest.length };
    }
    return { pageId: manifest[0].id, pageIndex: 0, pageCount: 1 };
  }
  async function navigate(pageId) {
    const index = manifest.findIndex(p => p.id === pageId);
    if (index < 0) throw new Error('页面 ID 不存在');
    const before = state();
    if (before.pageId !== pageId || before.overlay) {
      if (cfg.adapter === 'zhizheng') {
        const result = await window.ZhizhengFlow.goTo(index);
        if (result === false) throw new Error('HTML 拒绝跳页');
      } else if (cfg.adapter === 'showflow') await window.ShowFlowPage.gotoById(pageId);
    }
    await frames(); // ACK must follow rendering, not merely receiving a command.
    const result = state();
    if (result.pageId !== pageId || result.overlay) throw new Error('页面没有完成目标切换');
    return result;
  }
  window.addEventListener('message', e => {
    if (e.source !== parent || e.origin !== cfg.parentOrigin || e.data?.token !== cfg.token || !booted) return;
    const msg = e.data;
    if (msg.type === 'sf-html:goto' && typeof msg.requestId === 'string' && typeof msg.pageId === 'string') {
      serial = serial.catch(() => {}).then(async () => {
        try { const result = await navigate(msg.pageId); report('sf-html:rendered', { requestId: msg.requestId, state: result }); }
        catch (error) { report('sf-html:error', { requestId: msg.requestId, message: error.message }); }
      });
    }
    if (msg.type === 'sf-html:capture' && typeof msg.requestId === 'string' && window.htmlToImage) {
      const current = state();
      window.htmlToImage.toJpeg(document.getElementById('app') || document.body, { quality: .72, pixelRatio: .5, backgroundColor: '#071b38', skipFonts: true }).then(image => {
        if (image.length < 7 * 1024 * 1024) report('sf-html:capture-result', { requestId: msg.requestId, pageId: current.pageId, image });
      }).catch(() => {});
    }
  });
  async function boot() {
    try {
      for (let count = 0; count < 100; count++) {
        if (cfg.adapter === 'static' || (cfg.adapter === 'zhizheng' && window.ZhizhengFlow?.goTo && window.ZhizhengFlow?.getState) || (cfg.adapter === 'showflow' && window.ShowFlowPage?.gotoById && window.ShowFlowPage?.getCurrentPageId)) break;
        await delay(100);
      }
      if (document.fonts?.ready) await Promise.race([document.fonts.ready, delay(1200)]);
      await Promise.all([...document.images].map(img => img.complete ? Promise.resolve() : Promise.race([new Promise(resolve => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); }), delay(1800)])));
      await frames();
      const result = state();
      booted = true; lastId = result.pageId;
      report('sf-html:ready', { state: result });
      setInterval(() => {
        try { const current = state(); if (current.pageId !== lastId) { lastId = current.pageId; report('sf-html:state', { state: current }); } } catch { /* next navigation returns a visible error */ }
      }, 200);
    } catch (error) { report('sf-html:error', { message: 'HTML 控制接口未就绪：' + error.message }); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
