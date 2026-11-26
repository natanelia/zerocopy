import { notify } from './main.mjs';
import { setupCityDemo } from './city-demo.mjs';

setupCityDemo(document.querySelector('.city-demo'));

const intro = document.querySelector('.product-intro');
const copy = intro.querySelector('.copy-install');
copy.disabled = false;
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(intro.querySelector('.install-command code').textContent);
    notify('Install command copied.');
  } catch {
    notify('Select the install command to copy it.');
  }
});

// Keep the headline independent of the opt-in demo and pause it offscreen.
const word = intro.querySelector('.runtime-word');
const control = intro.querySelector('.runtime-control');
control.disabled = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const names = ['Node.js', 'Browser', 'Bun'];
let runtime = 0;
let timer;
let visible = false;
let paused = false;
function syncRuntime() {
  clearInterval(timer);
  control.hidden = reduced.matches;
  if (reduced.matches) {
    runtime = 0;
    word.textContent = names[runtime];
  } else if (visible && !document.hidden && !paused) {
    timer = setInterval(() => {
      runtime = (runtime + 1) % names.length;
      word.textContent = names[runtime];
    }, 6500);
  }
}
control.addEventListener('click', () => {
  paused = !paused;
  control.setAttribute('aria-label', paused ? 'Resume rotating runtime name' : 'Pause rotating runtime name');
  control.title = control.getAttribute('aria-label');
  control.querySelector('.pause-icon').toggleAttribute('hidden', paused);
  control.querySelector('.play-icon').toggleAttribute('hidden', !paused);
  syncRuntime();
});
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  syncRuntime();
}).observe(intro);
reduced.addEventListener('change', syncRuntime);
document.addEventListener('visibilitychange', syncRuntime);
syncRuntime();

const card = document.querySelector('.sharing-card');
const range = document.querySelector('#worker-count');
const writerThread = document.querySelector('#writer-thread');
const ownerThread = document.querySelector('#owner-thread');
function renderWriterThread() {
  ownerThread.textContent = writerThread.selectedOptions[0].text;
}
writerThread.addEventListener('change', renderWriterThread);
renderWriterThread();
let mode = 'shared';
function render() {
  const count = Number(range.value); card.dataset.model = mode;
  document.querySelector('#worker-count-value').textContent = String(count);
  document.querySelector('#arena-label').textContent = mode === 'shared' ? 'Shared backing storage' : 'Owner storage';
  document.querySelector('#storage-count').textContent = mode === 'shared' ? '1 backing store' : `${count + 1} separate stores`;
  const list = document.querySelector('#reader-nodes'); list.replaceChildren();
  for (let i = 0; i < count; i++) {
    const node = document.createElement('div'); node.className = 'reader-node';
    node.append(`Worker ${i + 1}`);
    const label = document.createElement('small'); label.textContent = mode === 'shared' ? 'READ-ONLY VIEW' : 'LOCAL COPY'; node.append(label);
    if (mode === 'cloned') { const memory = document.createElement('div'); memory.className = 'mini-memory'; memory.setAttribute('aria-hidden', 'true'); for (let j = 0; j < 4; j++) memory.append(document.createElement('i')); node.append(memory); }
    list.append(node);
  }
  document.querySelectorAll('[data-storage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storage === mode)));
}
range.addEventListener('input', render);
document.querySelectorAll('[data-storage]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.storage; render(); }));
render();
const tabs = [...document.querySelectorAll('[data-code-tab]')];
function select(tab) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).toggleAttribute('data-inactive', !active);
  }
}
tabs.forEach(tab => { tab.addEventListener('click', () => select(tab)); tab.addEventListener('keydown', event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[1 - tabs.indexOf(tab)]; select(next); next.focus(); } }); });
