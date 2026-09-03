/* ShowFlow 副屏联动客户端（PPTist Virtual Show Flow）。
   职责：注册 role=secondary；接收 NAVIGATE（commandId 幂等去重）；
   页面真实切换且渲染至少一帧后才回 ACK（禁止收到消息立即 ACK）；
   断线重连后由 controller 的 SYNC_STATE 恢复完整状态。 */
(function () {
  'use strict';

  var state = {
    ws: null,
    connected: false,
    sessionId: null,
    executed: [],      // 最近执行过的 commandId（幂等去重）
    pendingCommandId: null,
    idToIndex: null,   // pageId -> deck index
    sessionActive: false, // 收到过联动指令：作为正式副屏参与联动放映
    retryDelay: 2000
  };

  /* ---- 双 PPT 合成监控：联动会话中页变化后截图上传（与主屏合成 1280×800） ---- */
  var captureTimer = null;
  function scheduleCapture() {
    if (!state.sessionActive) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(postCapture, 250);
  }
  function postCapture() {
    if (!state.sessionActive || !state.ws || state.ws.readyState !== 1) return;
    try {
      var slide = deck && deck.getCurrentSlide ? deck.getCurrentSlide() : null;
      if (!slide) return;
      var total = deck.getTotalSlides ? deck.getTotalSlides() : 0;
      var page = (deck.getState ? deck.getState().indexh : 0) + 1;
      if (typeof htmlToImage === 'undefined') return;
      htmlToImage.toPng(slide, { pixelRatio: 1 }).then(function (dataUrl) {
        return fetch('/monitor-api/screen/secondary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: page, total: total, image: dataUrl })
        });
      }).catch(function () {});
    } catch (e) { /* 截图失败不影响放映 */ }
  }

  /* ---- 与 PPTist 端 manifest.ts 完全一致的 MD 解析（仅用于建立 pageId -> index 映射） ---- */
  function stablePageHash(text) {
    var h = 5381;
    var normalized = text.replace(/\r\n/g, '\n').trim();
    for (var i = 0; i < normalized.length; i++) h = ((h << 5) + h + normalized.charCodeAt(i)) | 0;
    return 'md-' + (h >>> 0).toString(36);
  }
  function parseManifest(md) {
    return md.replace(/\r\n/g, '\n').split(/^---\s*$/m).map(function (section) {
      var trimmed = section.trim();
      if (!trimmed) return null;
      var m = trimmed.match(/<!--\s*\.slide:\s*([\s\S]*?)-->/);
      var id = null, title = '';
      if (m) {
        var re = /data-([a-z0-9-]+)\s*=\s*"([^"]*)"/g, am;
        while ((am = re.exec(m[1]))) {
          if (am[1] === 'page-id') id = am[2];
          if (am[1] === 'title') title = am[2];
        }
      }
      var h1 = trimmed.match(/^\s*#\s+(.+?)\s*$/m);
      title = title || (h1 ? h1[1] : '');
      return {
        id: id || stablePageHash(trimmed),
        title: title || '',
        stage: (m && /data-stage="([^"]*)"/.exec(m[1])) ? RegExp.$1 : '',
        tabletScene: (m && /data-tablet-scene="([^"]*)"/.exec(m[1])) ? RegExp.$1 : ''
      };
    }).filter(Boolean);
  }

  function deckReady(cb) {
    var tries = 0;
    (function poll() {
      if (typeof deck !== 'undefined' && deck && deck.isReady && deck.isReady()) return cb();
      if (++tries > 100) return;
      setTimeout(poll, 100);
    })();
  }

  function ensureIdMap() {
    if (state.idToIndex) return state.idToIndex;
    var map = {};
    var slides = deck.getSlides ? deck.getSlides() : [];
    // 运行时 section 顺序与 MD section 顺序一致；显式 data-page-id 优先，
    // 否则用 MD 源文顺序对应的稳定 hash id
    slides.forEach(function (section, i) {
      if (section.dataset.pageId) map[section.dataset.pageId] = i;
    });
    if (Object.keys(map).length < slides.length) {
      var mdText = null;
      var src = document.querySelector('.slides script[type="text/template"]');
      if (src) mdText = src.textContent;
      if (mdText) {
        var manifest = parseManifest(mdText);
        manifest.forEach(function (page, i) { if (map[page.id] === undefined) map[page.id] = i; });
      }
    }
    state.idToIndex = map;
    return map;
  }

  function getManifest() {
    var mdText = null;
    var src = document.querySelector('.slides script[type="text/template"]');
    if (src) mdText = src.textContent;
    var manifest = mdText ? parseManifest(mdText) : [];
    manifest.forEach(function (p, i) { p.index = i + 1; });
    return manifest;
  }

  function indexOfPage(pageId) {
    var map = ensureIdMap();
    if (Object.prototype.hasOwnProperty.call(map, pageId)) return map[pageId];
    return -1;
  }

  /* ---- ACK：真正切换完成 + 至少一帧渲染后才回发 ---- */
  function ackRendered(commandId) {
    requestAnimationFrame(function () {
      send({ type: 'ACK', commandId: commandId, pageId: currentRenderedPageId(), rendered: true });
      state.pendingCommandId = null;
      // 合成监控：联动会话中每次页面渲染完成后上传最新画面
      scheduleCapture();
    });
  }

  function currentRenderedPageId() {
    var slides = deck.getSlides ? deck.getSlides() : [];
    var current = deck.getCurrentSlide ? deck.getCurrentSlide() : null;
    var i = slides.indexOf(current);
    var manifest = getManifest();
    return (manifest[i] && manifest[i].id) || null;
  }

  function gotoPageById(pageId, commandId) {
    var index = indexOfPage(pageId);
    if (index < 0) {
      send({ type: 'ERROR', code: 'PAGE_NOT_FOUND', commandId: commandId, message: 'pageId 不存在: ' + pageId });
      return false;
    }
    state.pendingCommandId = commandId || null;
    deck.slide(index);
    // slidechanged 事件触发 ack；若目标即当前页（无事件），下一帧直接 ACK
    if (deck.getCurrentSlide && deck.getSlides().indexOf(deck.getCurrentSlide()) === index) {
      ackRendered(state.pendingCommandId);
    }
    return true;
  }

  /* ---- WebSocket ---- */
  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/showflow';
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === 1) {
      msg.sessionId = state.sessionId;
      msg.role = 'secondary';
      state.ws.send(JSON.stringify(msg));
    }
  }

  function handleCommand(msg) {
    // 联动指令到达：本页作为正式副屏参与联动放映（合成监控开始上传）
    state.sessionActive = true;
    // 幂等：同一 commandId 只执行一次
    if (msg.commandId && state.executed.indexOf(msg.commandId) !== -1) {
      send({ type: 'ACK', commandId: msg.commandId, pageId: currentRenderedPageId(), rendered: true });
      return;
    }
    if (msg.commandId) {
      state.executed.push(msg.commandId);
      if (state.executed.length > 32) state.executed.shift();
    }
    var pageId = msg.pageId || (msg.state && msg.state.secondaryPageId);
    if (!pageId) return;
    if (gotoPageById(pageId, msg.commandId)) return;
    // deck 尚未就绪的兜底：初始化完成后再执行
    deckReady(function () {
      if (gotoPageById(pageId, msg.commandId)) return;
      if (msg.commandId) {
        state.executed = state.executed.filter(function (id) { return id !== msg.commandId; });
      }
    });
  }

  function connect() {
    try { state.ws = new WebSocket(wsUrl()); } catch (e) { return retry(); }
    state.ws.onopen = function () {
      state.retryDelay = 2000;
      state.connected = true;
      send({ type: 'HELLO', role: 'secondary', meta: { screen: 'reveal-md', url: location.pathname } });
      startHeartbeat();
    };
    state.ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === 'HELLO_ACK') { state.sessionId = msg.sessionId || null; return; }
      if (msg.type === 'ERROR' && msg.code === 'ROLE_TAKEN') { state.retryDelay = Math.max(state.retryDelay || 2000, 10000); return; }
      if (msg.type === 'PING') { send({ type: 'PONG' }); return; }
      if (msg.type === 'SYNC_STATE') { state.sessionId = msg.sessionId || state.sessionId; handleCommand(msg); return; }
      if (msg.type === 'NAVIGATE') { handleCommand(msg); return; }
    };
    state.ws.onclose = function () { state.connected = false; stopHeartbeat(); retry(); };
    state.ws.onerror = function () { try { state.ws.close(); } catch (e) {} };
  }
  /* 重连退避：2s 起指数递增至 30s，避免重连风暴刷屏 */
  function retry() { setTimeout(connect, state.retryDelay || 2000); state.retryDelay = Math.min((state.retryDelay || 2000) * 2, 30000); }

  var hbTimer = null;
  function startHeartbeat() { stopHeartbeat(); hbTimer = setInterval(function () { send({ type: 'PING' }); }, 2000); }
  function stopHeartbeat() { if (hbTimer) clearInterval(hbTimer); hbTimer = null; }

  /* ---- slidechanged -> 渲染一帧 -> ACK ---- */
  deckReady(function () {
    deck.on('slidechanged', function () {
      if (state.pendingCommandId) ackRendered(state.pendingCommandId);
    });
  });

  connect();

  /* ---- 暴露给 window.SecondScreen（补充 gotoById / getManifest，不影响既有 goto(index)） ---- */
  deckReady(function () {
    window.SecondScreen = window.SecondScreen || {};
    window.SecondScreen.gotoById = function (pageId) { return gotoPageById(pageId, null); };
    window.SecondScreen.getManifest = function () { return getManifest(); };
    window.SecondScreen.showflowStatus = function () {
      return { connected: state.connected, sessionId: state.sessionId, manifest: getManifest() };
    };
  });
})();
