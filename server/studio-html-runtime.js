/* Studio HTML DISPLAY adapter: the public wire contract remains the teacher's
 * /showflow + secondary + HELLO/NAVIGATE/ACK/SYNC_STATE. No MQTT/LCD publisher.
 * commandId is acknowledged only AFTER the requested public ID is on screen.
 */
(() => {
  'use strict';
  const params=new URLSearchParams(location.search);
  const preview=params.get('studio')==='draft'||params.has('thumb');
  document.body.classList.toggle('preview',preview);
  const $=id=>document.getElementById(id);
  const clients=new Map(), requests=new Map(), inFlight=new Map(), completed=new Map();
  let config, publicPages=[], bindings={}, activeClient=null, rendered=null;
  let ws=null, sessionId=null, sessionEpoch=0, socketSerial=0, stopped=false, joined=false;
  let retryDelay=2000,retryTimer,heartbeat,updateTimer,captureTimer, serial=Promise.resolve();
  let lastError=null,lastAck=null,lastCommand=null,capturePending=null,lastCapture=null;
  let navigationSerial=0;
  const random=()=>{const a=new Uint32Array(4);crypto.getRandomValues(a);return [...a].map(x=>x.toString(16).padStart(8,'0')).join('');};
  const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  function fail(message){lastError=String(message);$('status-title').textContent='流程网页加载失败';$('status-text').textContent=lastError;$('status').hidden=false;$('status').classList.add('failed');}
  function noteError(error){lastError=error.message||String(error);$('connection').textContent='未完成切换：'+lastError;console.error('[ShowFlow HTML]',lastError);}
  async function textAt(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error(`读取资源失败：${url} (${r.status})`);return r.text();}
  async function getConfig(){const q=new URLSearchParams({scope:preview?'draft':'active'});if(preview&&params.get('studioTheme'))q.set('theme',params.get('studioTheme'));const r=await fetch('/api/studio/render-config?'+q,{cache:'no-store'});if(!r.ok)throw new Error('读取 Studio 配置失败');return r.json();}
  function checkChild(client,state){
    if(!state||!Number.isInteger(state.pageIndex)||client.manifest[state.pageIndex]?.id!==state.pageId||state.pageCount!==client.manifest.length)throw new Error('显示帧与已发布页面清单不一致');
    return state;
  }
  function makeClient(kind,manifest){
    const iframe=document.createElement('iframe'),token=random();iframe.title=kind==='html'?'HTML 流程画面':'原 Reveal 兼容画面';iframe.referrerPolicy='no-referrer';
    iframe.setAttribute('allow','fullscreen *');iframe.style.cssText='position:absolute;inset:0;opacity:0;pointer-events:none;z-index:0';
    if(kind==='html')iframe.setAttribute('sandbox','allow-scripts');
    const client={kind,manifest,iframe,token,state:null,ready:false};
    client.promise=new Promise((resolve,reject)=>{client.resolve=resolve;client.reject=reject;client.timer=setTimeout(()=>reject(new Error(kind+' 显示帧 18 秒内未就绪')),18000);});
    clients.set(kind,client);$('stage').append(iframe);return client;
  }
  async function loadHtml(html,bridge,captureLib){
    const client=makeClient('html',config.displayManifest);
    const doc=new DOMParser().parseFromString(html,'text/html');doc.querySelectorAll('base,meta[http-equiv]').forEach(el=>el.remove());
    const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";doc.head.prepend(policy);
    const data=doc.createElement('script');data.id='showflow-bridge-config';data.type='application/json';data.textContent=JSON.stringify({token:client.token,parentOrigin:location.origin,adapter:config.adapter,manifest:client.manifest}).replace(/</g,'\\u003c');
    const capture=doc.createElement('script');capture.textContent=captureLib;
    const script=doc.createElement('script');script.textContent=bridge;
    doc.body.append(data,capture,script);client.iframe.srcdoc='<!doctype html>\n'+doc.documentElement.outerHTML;
    await client.promise;return client;
  }
  async function loadNative(){
    const client=makeClient('native',config.protocolManifest);
    const url=new URL(config.nativeUrl,location.href);url.searchParams.set('sfToken',client.token);if(preview)url.searchParams.set('studio','draft');
    client.iframe.src=url.pathname+url.search;await client.promise;return client;
  }
  function updateControls(){if(!rendered)return;$('page-picker').value=rendered.pageId;const i=publicPages.findIndex(p=>p.id===rendered.pageId);$('prev').disabled=i<=0;$('next').disabled=i<0||i>=publicPages.length-1;}
  function selectClient(client){for(const c of clients.values()){const on=c===client;c.iframe.style.opacity=on?'1':'0';c.iframe.style.pointerEvents=on?'auto':'none';c.iframe.style.zIndex=on?'1':'0';c.iframe.setAttribute('aria-hidden',String(!on));}activeClient=client;}
  function request(client,type,extra){
    const id=random();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(id);reject(new Error('显示帧没有返回渲染确认'));},4500);requests.set(id,{client,type,...extra,timer,resolve,reject});client.iframe.contentWindow.postMessage({type,token:client.token,requestId:id,...extra},client.kind==='html'||location.origin==='null'?'*':location.origin);});
  }
  function navigate(pageId,epoch=sessionEpoch){
    if(!Object.hasOwn(bindings,pageId))return Promise.reject(new Error('PAGE_NOT_FOUND: '+pageId));
    const binding=bindings[pageId];
    const navigation=++navigationSerial;
    const operation=serial.catch(()=>{}).then(async()=>{
      if(navigation!==navigationSerial)throw new Error('旧切换已被新操作取代');
      if(epoch!==sessionEpoch)throw new Error('旧会话指令已失效');
      const client=clients.get(binding.kind);if(!client)throw new Error('显示资源未就绪');await client.promise;
      // A visible renderer is essential: hidden-tab timers/RAF must never produce fake ACKs.
      selectClient(client);
      const state=await request(client,'sf-html:goto',{pageId:binding.targetId});
      if(epoch!==sessionEpoch)throw new Error('旧会话指令已失效');
      if(state.pageId!==binding.targetId||state.overlay)throw new Error('副屏尚未显示目标画面');
      await frames();
      if(navigation!==navigationSerial)throw new Error('旧切换已被新操作取代');
      rendered={pageId,displayPageId:state.pageId,displayIndex:state.pageIndex,displayCount:state.pageCount,kind:client.kind,overlay:false};
      lastError=null;updateControls();return rendered;
    });serial=operation;return operation;
  }
  window.addEventListener('message',event=>{
    const client=[...clients.values()].find(c=>event.source===c.iframe.contentWindow&&event.data?.token===c.token&&event.origin===(c.kind==='html'?'null':location.origin));
    if(!client)return;const msg=event.data;
    try{
      if(msg.type==='sf-html:ready'){client.state=checkChild(client,msg.state);client.ready=true;clearTimeout(client.timer);client.resolve(client.state);}
      if(msg.type==='sf-html:state'){
        client.state=checkChild(client,msg.state);
        // Local manual changes never emit fake ACK or LCD states. The next original
        // controller command reasserts its complete target snapshot.
        if(client===activeClient&&rendered&&client.state.pageId!==rendered.displayPageId){
          const id=client.kind==='html'?client.state.pageId:client.state.pageId;
          rendered={pageId:id,displayPageId:client.state.pageId,displayIndex:client.state.pageIndex,displayCount:client.state.pageCount,kind:client.kind,overlay:!!client.state.overlay};updateControls();
        }
      }
      if(msg.type==='sf-html:rendered'){
        const task=requests.get(msg.requestId);if(!task||task.client!==client)return;
        const state=checkChild(client,msg.state);clearTimeout(task.timer);requests.delete(msg.requestId);
        if(task.type==='sf-html:goto'&&(task.pageId!==state.pageId||state.overlay))task.reject(new Error('渲染确认目标不一致'));
        else {client.state=state;task.resolve(state);}
      }
      if(msg.type==='sf-html:error'){
        const task=requests.get(msg.requestId);
        if(task&&task.client===client){clearTimeout(task.timer);requests.delete(msg.requestId);task.reject(new Error(msg.message));}
        else if(!client.ready){clearTimeout(client.timer);client.reject(new Error(msg.message));}
      }
      if(msg.type==='sf-html:capture-result'){
        const pending=capturePending;
        if(!pending||pending.id!==msg.requestId||pending.client!==client)return;
        capturePending=null;
        if(preview||!joined||!rendered||pending.publicId!==rendered.pageId||msg.pageId!==rendered.displayPageId||typeof msg.image!=='string'||!msg.image.startsWith('data:image/jpeg;base64,')||msg.image.length>7*1024*1024)return;
        const original=config.protocolManifest.find(p=>p.id===rendered.pageId);
        const page=original?original.index:rendered.displayIndex+1,total=original?config.protocolManifest.length:rendered.displayCount;
        fetch('/monitor-api/screen/secondary',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page,total,image:msg.image})}).then(r=>{if(!r.ok)throw new Error('监控图片上传失败 '+r.status);lastCapture={page,total,at:Date.now(),ok:true};}).catch(e=>{lastCapture={ok:false,message:e.message};});
      }
      if(msg.type==='sf-html:capture-error'&&capturePending?.id===msg.requestId){capturePending=null;lastCapture={ok:false,message:msg.message};}
    }catch(error){if(!client.ready){clearTimeout(client.timer);client.reject(error);}else noteError(error);}
  });
  function send(msg){if(ws?.readyState===1)ws.send(JSON.stringify({...msg,sessionId,role:'secondary'}));}
  function scheduleCapture(){if(preview||!joined||ws?.readyState!==1||!rendered)return;clearTimeout(captureTimer);captureTimer=setTimeout(()=>{const client=activeClient;if(!client||!rendered)return;const id=random();capturePending={id,client,publicId:rendered.pageId};client.iframe.contentWindow.postMessage({type:'sf-html:capture',requestId:id,token:client.token},client.kind==='html'||location.origin==='null'?'*':location.origin);},250);}
  function changeSession(id){if(id&&id!==sessionId){sessionId=id;sessionEpoch++;completed.clear();}}
  async function command(msg){
    if(msg.type==='SYNC_STATE')changeSession(msg.sessionId);
    else if(msg.sessionId)changeSession(msg.sessionId);
    const pageId=msg.pageId||msg.state?.secondaryPageId;if(!pageId)return;
    joined=true;lastCommand={commandId:msg.commandId||null,pageId,type:msg.type,at:Date.now()};
    const epoch=sessionEpoch,connection=socketSerial,key=epoch+':'+(msg.commandId||random());let owns=false;
    try{
      const cached=completed.get(key);if(cached&&cached!==pageId)throw new Error('commandId 的目标与原指令不一致');
      let task=inFlight.get(key);if(task&&task.pageId!==pageId)throw new Error('commandId 的目标与在途指令不一致');
      // A repeated id is safe only while that target is still physically rendered.
      // Otherwise reapply its target; do not ACK a manually drifted page.
      if(!task){task={pageId,promise:navigate(pageId,epoch)};inFlight.set(key,task);owns=true;}
      const result=await task.promise;
      if(epoch!==sessionEpoch||connection!==socketSerial||ws?.readyState!==1)return;
      completed.set(key,pageId);if(completed.size>64)completed.delete(completed.keys().next().value);
      if(msg.commandId){send({type:'ACK',commandId:msg.commandId,pageId:result.pageId,rendered:true});lastAck={commandId:msg.commandId,pageId:result.pageId,at:Date.now()};}
      $('connection').textContent='副屏已就绪 · 当前 '+pageId;scheduleCapture();
    }catch(error){
      if(epoch!==sessionEpoch||connection!==socketSerial)return;
      noteError(error);send({type:'ERROR',code:Object.hasOwn(bindings,pageId)?'HTML_RENDER_FAILED':'PAGE_NOT_FOUND',commandId:msg.commandId,message:error.message});
    }finally{if(owns)inFlight.delete(key);}
  }
  function connect(){
    if(preview||stopped)return;const connection=++socketSerial;$('connection').textContent='正在连接原双屏控制台';
    try{ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/showflow`);}catch{retry();return;}
    const socket=ws;
    socket.onopen=()=>{if(connection!==socketSerial)return;retryDelay=2000;send({type:'HELLO',meta:{screen:'reveal-md',url:location.pathname}});clearInterval(heartbeat);heartbeat=setInterval(()=>send({type:'PING'}),2000);};
    socket.onmessage=event=>{if(connection!==socketSerial)return;let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if(msg.type==='HELLO_ACK'){$('connection').textContent='副屏已就绪 · 等待原 ShowFlow 指令';if(msg.sessionId)changeSession(msg.sessionId);return;}
      if(msg.type==='PING'){send({type:'PONG'});return;}
      if(msg.type==='ERROR'){noteError(new Error((msg.code||'ERROR')+'：'+(msg.message||'')));if(msg.code==='ROLE_TAKEN')retryDelay=10000;return;}
      if(msg.type==='NAVIGATE'||msg.type==='SYNC_STATE')void command(msg);
    };
    socket.onerror=()=>socket.close();socket.onclose=()=>{if(connection!==socketSerial)return;clearInterval(heartbeat);$('connection').textContent='连接中断 · 保留画面，等待原协议重同步';retry();};
  }
  function retry(){if(stopped||preview)return;clearTimeout(retryTimer);retryTimer=setTimeout(connect,retryDelay);retryDelay=Math.min(retryDelay*2,30000);}
  function localUpdate(update){const job=serial.catch(()=>{}).then(async()=>{if(!activeClient)throw new Error('副屏未就绪');await request(activeClient,'sf-html:update',{update});scheduleCapture();});serial=job;return job;}
  const change=offset=>{if(!rendered)return;const i=publicPages.findIndex(p=>p.id===rendered.pageId),p=publicPages[i+offset];if(p)navigate(p.id).catch(noteError);};
  $('prev').onclick=()=>change(-1);$('next').onclick=()=>change(1);$('page-picker').onchange=e=>navigate(e.target.value).catch(noteError);
  $('full').onclick=()=>document.documentElement.requestFullscreen?.().catch(()=>{});$('update').onclick=()=>location.reload();$('retry').onclick=()=>location.reload();
  window.SecondScreen={
    goto(index){const p=config?.protocolManifest[Math.max(0,Number(index)||0)];return p?navigate(p.id):Promise.resolve(false);},
    gotoById:id=>navigate(id),cue:text=>localUpdate({cue:text}),role:(key,task,active=true)=>localUpdate({role:{key,task,active}}),
    value:(key,value)=>localUpdate({values:{[key]:value}}),focus:index=>localUpdate({focus:index}),
    getManifest:()=>publicPages,getCurrentPageId:()=>rendered?.pageId||null,
    showflowStatus:()=>({connected:ws?.readyState===1,ready:!!rendered,sessionId,manifest:publicPages,rendered,lastCommand,lastAck,lastError,lastCapture,runtimeVersion:'studio-html-compat/2.0',preview})
  };
  window.addEventListener('second-screen:update',event=>{const d=event.detail||{};let job=Promise.resolve();if(d.slide!==undefined)job=window.SecondScreen.goto(d.slide);job.then(()=>localUpdate(d)).catch(noteError);});
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(heartbeat);clearInterval(updateTimer);clearTimeout(retryTimer);clearTimeout(captureTimer);for(const t of requests.values())clearTimeout(t.timer);ws?.close();});
  async function load(){
    config=await getConfig();if(config.kind!=='html'){location.reload();return;}
    if(config.runtimeVersion!=='studio-html-compat/2.0'||!config.displayManifest||!config.bindings)throw new Error('服务端与 HTML 运行文件不是同一版本，请完整替换并重启服务');
    publicPages=config.manifest;bindings=config.bindings;
    $('page-picker').replaceChildren(...publicPages.map(p=>{const opt=document.createElement('option');opt.value=p.id;opt.textContent=p.id+' · '+p.title;return opt;}));
    const [html,bridge,captureLib]=await Promise.all([textAt(config.contentUrl),textAt('/api/studio/html-bridge.js'),textAt('/reveal/vendor/html-to-image.js')]);
    const loads=[loadHtml(html,bridge,captureLib)];if(config.fallbackIds.length)loads.push(loadNative());await Promise.all(loads);
    const index=Math.max(0,Math.min(config.displayManifest.length-1,Number(params.get('studioPage')||0)));
    const initial=config.displayManifest[Number.isInteger(index)?index:0].id;await navigate(initial);
    $('status').hidden=true;$('connection').textContent=preview?'Draft 预览 · 不连接双屏协议':'准备连接';
    if(!preview)connect();
    updateTimer=setInterval(async()=>{if(preview)return;try{const next=await getConfig();if(next.kind!=='html'||next.fingerprint!==config.fingerprint)$('update').style.display='block';}catch{}},4000);
  }
  load().catch(fail);
})();
