/* DISPLAY-ONLY bridge. No WebSocket, MQTT, controller or LCD data lives here.
   In an uploaded HTML it runs in an opaque-origin sandbox. Native mode runs
   beside the teacher's untouched Reveal app.js for unrepresented original pages. */
(() => {
  'use strict';
  const cfg = JSON.parse(document.getElementById('showflow-bridge-config').textContent);
  if (cfg.parentOrigin === 'self') cfg.parentOrigin = location.origin;
  const manifest = cfg.manifest;
  const roles = ['manager','platform','twin','hardware'];
  const report = (type, extra = {}) => parent.postMessage({type,token:cfg.token,...extra},cfg.parentOrigin === 'null' ? '*' : cfg.parentOrigin);
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
  let booted=false, serial=Promise.resolve(), lastSignature='';
  const changes = new Map();
  function readState() {
    if (cfg.adapter === 'native') {
      const slides=deck.getSlides(), slide=deck.getCurrentSlide(), index=slides.indexOf(slide);
      if (!manifest[index] || (slide.dataset.pageId && slide.dataset.pageId!==manifest[index].id)) throw new Error('原 Reveal 清单与实际页面不一致');
      return {pageId:manifest[index].id,pageIndex:index,pageCount:manifest.length,overlay:false};
    }
    if (cfg.adapter === 'zhizheng') {
      const raw=window.ZhizhengFlow.getState(), index=raw.pageIndex;
      if (!Number.isInteger(index)||!manifest[index]||raw.pageId!==manifest[index].id||raw.pageCount!==manifest.length) throw new Error('HTML 实际页码与上传清单不一致');
      return {pageId:raw.pageId,pageIndex:index,pageCount:manifest.length,overlay:!!raw.overviewOverlay,activeWorkers:raw.activeWorkers||[]};
    }
    if (cfg.adapter==='showflow') {
      const id=window.ShowFlowPage.getCurrentPageId(), index=manifest.findIndex(p=>p.id===id);
      if(index<0) throw new Error('ShowFlowPage 返回清单外的 ID');
      return {pageId:id,pageIndex:index,pageCount:manifest.length,overlay:false};
    }
    return {pageId:manifest[0].id,pageIndex:0,pageCount:1,overlay:false};
  }
  function nativeReady() {return typeof deck!=='undefined' && deck?.isReady?.();}
  function applyDisplayUpdate(update) {
    if(cfg.adapter==='native') {
      if(update.cue!==undefined) window.SecondScreen.cue(update.cue);
      if(update.focus!==undefined) window.SecondScreen.focus(update.focus);
      if(update.role) window.SecondScreen.role(update.role.key,update.role.task,update.role.active!==false);
      if(update.values) for(const [key,value] of Object.entries(update.values)) window.SecondScreen.value(key,value);
      return;
    }
    const root=document.getElementById('view')||document.body;
    if(update.cue!==undefined) {
      let cue=document.getElementById('sf-compat-cue');
      if(!cue) {cue=document.createElement('aside');cue.id='sf-compat-cue';cue.style.cssText='position:fixed;right:2vw;top:10vh;max-width:50vw;padding:12px 22px;background:#073050ee;color:#dffaff;border:1px solid #60d7ff;z-index:90;font:600 clamp(16px,2vw,32px) sans-serif;pointer-events:none';document.body.append(cue);}
      cue.textContent=String(update.cue||'');cue.hidden=!update.cue;
    }
    if(update.role && roles.includes(update.role.key)) {
      const i=roles.indexOf(update.role.key), card=root.querySelector(`[data-worker="${i}"]`)||root.querySelector(`[data-role="${update.role.key}"]`);
      if(card) {
        const active=update.role.active!==false;
        card.classList.toggle('current',active);card.classList.toggle('active',active);card.classList.remove('joint-current');card.setAttribute('aria-pressed',String(active));
        const task=card.querySelector('.crew-task,.collab-main p');if(task&&update.role.task!==undefined) task.textContent=String(update.role.task);
        const label=card.querySelector('.crew-status');if(label)label.textContent=active?'进行中':'并行协作';
      }
    }
    if(update.values) for(const [key,value] of Object.entries(update.values)) {
      root.querySelectorAll('[data-live-value]').forEach(el=>{if(el.dataset.liveValue===key)el.textContent=String(value);});
    }
    if(update.focus!==undefined) {
      const items=root.querySelectorAll('.screen-point,.screen-case,.checklist li,.task');
      items.forEach((el,i)=>{el.classList.toggle('runtime-focus',i===Number(update.focus));el.style.outline=i===Number(update.focus)?'3px solid #61efff':'';});
    }
  }
  async function navigate(pageId) {
    const index=manifest.findIndex(p=>p.id===pageId);if(index<0) throw new Error('页面 ID 不存在');
    const before=readState();
    if(before.pageId!==pageId||before.overlay) {
      if(cfg.adapter==='native') {if(deck.isOverview?.())deck.toggleOverview(false);deck.slide(index);}
      else if(cfg.adapter==='zhizheng') {if(await window.ZhizhengFlow.goTo(index)===false)throw new Error('HTML 拒绝跳页');}
      else if(cfg.adapter==='showflow') await window.ShowFlowPage.gotoById(pageId);
    }
    await frames();
    const result=readState();if(result.pageId!==pageId||result.overlay)throw new Error('目标页面尚未完成切换');
    return result;
  }
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.origin!==cfg.parentOrigin||event.data?.token!==cfg.token||!booted)return;
    const msg=event.data;
    if((msg.type==='sf-html:goto'||msg.type==='sf-html:update')&&typeof msg.requestId==='string') {
      serial=serial.catch(()=>{}).then(async()=>{
        try{
          let result;
          if(msg.type==='sf-html:goto')result=await navigate(msg.pageId);
          else {applyDisplayUpdate(msg.update||{});await frames();result=readState();}
          report('sf-html:rendered',{requestId:msg.requestId,state:result});
        }catch(error){report('sf-html:error',{requestId:msg.requestId,message:error.message});}
      });
    }
    if(msg.type==='sf-html:capture'&&typeof msg.requestId==='string') {
      const current=readState();
      if(!window.htmlToImage) {report('sf-html:capture-error',{requestId:msg.requestId,message:'截图库未就绪'});return;}
      const node=cfg.adapter==='native'?deck.getCurrentSlide():(document.getElementById('app')||document.body);
      window.htmlToImage.toJpeg(node,{quality:.78,pixelRatio:.65,backgroundColor:'#101522',skipFonts:true}).then(image=>{
        const after=readState();
        if(after.pageId===current.pageId&&image.length<7*1024*1024)report('sf-html:capture-result',{requestId:msg.requestId,pageId:current.pageId,image});
      }).catch(error=>report('sf-html:capture-error',{requestId:msg.requestId,message:error.message}));
    }
  });
  async function boot(){
    try{
      let usable=false;
      for(let n=0;n<150;n++) {
        usable=cfg.adapter==='static'||(cfg.adapter==='native'&&nativeReady())||(cfg.adapter==='zhizheng'&&window.ZhizhengFlow?.goTo&&window.ZhizhengFlow?.getState)||(cfg.adapter==='showflow'&&window.ShowFlowPage?.gotoById&&window.ShowFlowPage?.getCurrentPageId);
        if(usable)break;await delay(100);
      }
      if(!usable)throw new Error('页面控制接口未就绪');
      if(document.fonts?.ready)await Promise.race([document.fonts.ready,delay(1200)]);
      await frames(); const result=readState(); booted=true;
      report('sf-html:ready',{state:result});
      setInterval(()=>{try{const s=readState(),signature=JSON.stringify(s);if(signature!==lastSignature){lastSignature=signature;report('sf-html:state',{state:s});}}catch{}},200);
    }catch(error){report('sf-html:error',{message:'显示接口未就绪：'+error.message});}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
