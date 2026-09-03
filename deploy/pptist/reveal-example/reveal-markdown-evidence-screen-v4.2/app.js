/* reveal.js Markdown remains native; this file only adds the large-screen runtime UI. */
/* Fixed physical seat order on the competition floor.
   All rendered role lists use this order even if Markdown data-active is written differently. */
const roles = {
  manager: ['项目经理', 'manager.png'],
  platform: ['平台系统开发工程师', 'platform.png'],
  twin: ['数字孪生工程师', 'twin.png'],
  hardware: ['软硬件调试工程师', 'hardware.png']
};
const seatOrder = ['manager', 'platform', 'twin', 'hardware'];
let deck;
let loading = false;
const notice = document.querySelector('#notice');

function parseMap(value='') {
  const map = {};
  value.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const text = part.slice(i + 1).trim();
    if (roles[key]) map[key] = text;
  });
  return map;
}

function activeKeys(slide) {
  const requested = new Set((slide.dataset.active || '').split(',').map(v => v.trim()).filter(v => roles[v]));
  return seatOrder.filter(key => requested.has(key));
}

function addStage(slide) {
  const stage = slide.dataset.stage;
  if (!stage) return;
  const strip = document.createElement('div');
  strip.className = 'stage-strip';
  const dot = document.createElement('i');
  const label = document.createElement('span');
  label.textContent = '当前环节 · ' + stage;
  const counter = document.createElement('b');
  counter.className = 'stage-counter';
  strip.append(dot, label, counter);
  slide.prepend(strip);
}

function addCue(slide) {
  if (!slide.dataset.cue) return;
  const cue = document.createElement('aside');
  cue.className = 'live-cue';
  cue.innerHTML = '<span>当前提示</span><strong></strong>';
  cue.querySelector('strong').textContent = slide.dataset.cue;
  slide.append(cue);
}

function splitDetail(text='') {
  const [task, role] = text.split('|');
  return [task || '参与当前任务', role || '配合当前环节完成验证'];
}

function roleCard(key, detail, lead=false) {
  const [name, file] = roles[key];
  const [task, effect] = splitDetail(detail);
  const card = document.createElement('article');
  card.className = 'role-card active-role' + (lead ? ' lead' : '');
  card.dataset.role = key;
  const status = lead ? '主导' : '协作';
  card.innerHTML = `
    <div class="role-card-top"><span class="role-status">${status}</span><i></i></div>
    <div class="role-card-main">
      <div class="role-avatar-wrap"><img src="portraits/${file}" alt="${name}"></div>
      <div class="role-copy">
        <h3>${name}</h3>
        <strong>${task}</strong>
        <p>${effect}</p>
      </div>
    </div>`;
  return card;
}

function arrangeRoleSides(keys) {
  if (keys.length <= 1) return [keys, []];
  if (keys.length === 2) return [keys, []];
  if (keys.length === 3) return [keys.slice(0,2), keys.slice(2)];
  return [keys.slice(0,2), keys.slice(2,4)];
}

function buildWorkLayout(slide) {
  const keys = activeKeys(slide);
  if (!keys.length) return;
  const details = parseMap(slide.dataset.roleDetail || '');
  const lead = slide.dataset.lead || '';
  const heading = slide.querySelector('h1');
  if (!heading) return;
  const subtitle = heading.nextElementSibling?.tagName === 'P' ? heading.nextElementSibling : null;

  const headline = document.createElement('header');
  headline.className = 'headline';
  headline.append(heading);
  if (subtitle) headline.append(subtitle);

  const main = document.createElement('main');
  main.className = 'main-content';
  [...slide.children].forEach(child => {
    if (child === headline || child.classList?.contains('stage-strip') || child.classList?.contains('live-cue') || child.classList?.contains('collab-bar')) return;
    if (child !== heading && child !== subtitle) main.append(child);
  });

  const work = document.createElement('div');
  work.className = `work-layout roles-${keys.length}`;
  const left = document.createElement('aside');
  left.className = 'role-side role-side-left';
  const center = document.createElement('div');
  center.className = 'work-center';
  const right = document.createElement('aside');
  right.className = 'role-side role-side-right';
  const [leftKeys, rightKeys] = arrangeRoleSides(keys);
  leftKeys.forEach(key => left.append(roleCard(key, details[key], key === lead)));
  rightKeys.forEach(key => right.append(roleCard(key, details[key], key === lead)));
  center.append(main);
  work.append(left, center, right);
  slide.append(headline, work);
  slide.classList.add('has-work-layout');
  if (!rightKeys.length) slide.classList.add('no-right-roles');
}

function addCollab(slide) {
  if (!slide.dataset.collab) return;
  const tasks = parseMap(slide.dataset.collab);
  const active = new Set(activeKeys(slide));
  const bar = document.createElement('aside');
  bar.className = 'collab-bar';
  const label = document.createElement('div');
  label.className = 'collab-label';
  label.innerHTML = '<span>协作状态</span><small>实时</small>';
  bar.append(label);
  const grid = document.createElement('div');
  grid.className = 'collab-grid';
  Object.entries(roles).forEach(([key, role]) => {
    const item = document.createElement('div');
    item.className = 'collab-item' + (active.has(key) ? ' active' : '');
    item.dataset.role = key;
    const portrait = document.createElement('img');
    portrait.src = 'portraits/' + role[1];
    portrait.alt = role[0];
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = role[0];
    const task = document.createElement('span');
    task.textContent = tasks[key] || '按当前任务推进';
    text.append(name, task);
    const state = document.createElement('i');
    item.append(portrait, text, state);
    grid.append(item);
  });
  bar.append(grid);
  slide.append(bar);
}

function updateSlideCounter() {
  if (!deck) return;
  const indices = deck.getIndices();
  const slides = deck.getSlides();
  const slide = deck.getCurrentSlide();
  const counter = slide?.querySelector('.stage-counter');
  if (counter) counter.textContent = String(indices.h + 1).padStart(2,'0') + ' / ' + String(slides.length).padStart(2,'0');
}

function addRuntimeHooks(slide) {
  slide.querySelectorAll('.main-content li, .main-content td, .main-content img').forEach((el, i) => {
    el.style.setProperty('--enter-delay', `${Math.min(i,6) * 70}ms`);
  });
}

function enhanceSlides() {
  document.querySelectorAll('.slides section').forEach(slide => {
    addStage(slide);
    addCue(slide);
    addCollab(slide);
    buildWorkLayout(slide);
    addRuntimeHooks(slide);
  });
}

async function mount(markdown) {
  if (loading) return;
  loading = true;
  try {
    if (deck) await deck.destroy();
    const slides = document.querySelector('.slides');
    slides.replaceChildren();
    const section = document.createElement('section');
    section.setAttribute('data-markdown', '');
    section.setAttribute('data-separator', '^---\\s*$');
    const source = document.createElement('script');
    source.type = 'text/template';
    source.textContent = markdown;
    section.append(source);
    slides.append(section);
    deck = new Reveal(document.querySelector('.reveal'), {
      width:1600, height:900, margin:0.012, center:false,
      hash:false, transition:'fade', transitionSpeed:'fast',
      controls:true, progress:true, slideNumber:false,
      keyboard:true, overview:true, plugins:[RevealMarkdown]
    });
    await deck.initialize();
    enhanceSlides();
    deck.on('slidechanged', updateSlideCounter);
    deck.on('ready', updateSlideCounter);
    deck.sync();
    deck.slide(0);
    updateSlideCounter();
    notice.textContent = '';
  } catch (error) {
    notice.textContent = '页面载入失败，请检查 Markdown 或重新打开网页。';
    console.error(error);
  } finally { loading = false; }
}

function currentSlide() { return deck?.getCurrentSlide(); }

/* Runtime API for MQTT/WebSocket adapters. Values can be changed without turning a page. */
window.SecondScreen = {
  goto(index) { deck?.slide(Math.max(0, Number(index) || 0)); },
  cue(text) {
    const slide = currentSlide(); if (!slide) return;
    let cue = slide.querySelector('.live-cue');
    if (!cue) { cue = document.createElement('aside'); cue.className='live-cue'; cue.innerHTML='<span>当前提示</span><strong></strong>'; slide.append(cue); }
    cue.querySelector('strong').textContent = text || '';
    cue.classList.remove('pulse'); void cue.offsetWidth; cue.classList.add('pulse');
  },
  role(key, task, active=true) {
    const slide = currentSlide(); if (!slide || !roles[key]) return;
    slide.querySelectorAll(`[data-role="${key}"]`).forEach(el => {
      el.classList.toggle('active', active);
      const target = el.querySelector('span');
      if (task && target) target.textContent = task;
    });
  },
  value(key, value) {
    const slide = currentSlide(); if (!slide) return;
    slide.querySelectorAll(`[data-live-value="${key}"]`).forEach(el => el.textContent = value);
  },
  focus(index) {
    const slide = currentSlide(); if (!slide) return;
    const items = [...slide.querySelectorAll('.main-content li, .main-content tbody tr')];
    items.forEach((el,i) => el.classList.toggle('runtime-focus', i === Number(index)));
  }
};
window.addEventListener('second-screen:update', event => {
  const d = event.detail || {};
  if (d.slide !== undefined) window.SecondScreen.goto(d.slide);
  if (d.cue !== undefined) window.SecondScreen.cue(d.cue);
  if (d.focus !== undefined) window.SecondScreen.focus(d.focus);
  if (d.role) window.SecondScreen.role(d.role.key, d.role.task, d.role.active !== false);
  if (d.values) Object.entries(d.values).forEach(([k,v]) => window.SecondScreen.value(k,v));
});

document.querySelector('#file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (file) await mount(await file.text());
  event.target.value = '';
});
document.querySelector('#overview').onclick = () => deck?.toggleOverview();
document.querySelector('#fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { notice.textContent = '当前浏览器不支持全屏，请尝试 F11。'; }
};
document.querySelector('#clean').onclick = () => document.body.classList.add('clean');
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() === 'h') document.body.classList.toggle('clean');
});
(async () => {
  let markdown = window.DEFAULT_MARKDOWN;
  if (location.protocol !== 'file:') {
    try {
      const response = await fetch('slides.md', {cache:'no-store'});
      if (response.ok) markdown = await response.text();
    } catch { /* Offline default remains available. */ }
  }
  await mount(markdown);
})();
