import { confirmCopy, notify } from './main.mjs';
import { setupCityDemo } from './city-demo.mjs';

setupCityDemo(document.querySelector('.city-demo'));

const intro = document.querySelector('.product-intro');
const copy = intro.querySelector('.copy-install');
copy.disabled = false;
copy.addEventListener('click', async () => {
  copy.removeAttribute('data-copy-success');
  try {
    await navigator.clipboard.writeText(intro.querySelector('.install-command code').textContent);
    confirmCopy(copy, 'Install command copied.');
  } catch {
    notify('Select the install command to copy it.');
  }
});

// Keep the headline independent of the opt-in demo and pause it offscreen.
const word = intro.querySelector('.runtime-word');
const control = intro.querySelector('.runtime-control');
control.disabled = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const effects = new Map();
const liftIn = [
  { opacity: .86, transform: 'translateY(9px)' },
  { opacity: 1, transform: 'translateY(0)' },
];
function playEffect(element, id, frames, duration, delay = 0) {
  if (reduced.matches) return;
  effects.get(element)?.cancel();
  const animation = element.animate(frames, {
    duration, delay, fill: 'backwards', easing: 'cubic-bezier(.2,.7,.2,1)',
  });
  animation.id = id;
  effects.set(element, animation);
  const forget = () => {
    if (effects.get(element) === animation) effects.delete(element);
  };
  animation.finished.then(forget, forget);
}
reduced.addEventListener('change', () => {
  if (reduced.matches) for (const animation of effects.values()) animation.cancel();
});

// Start reveals only after scrolling so the page's first paint is static.
window.addEventListener('scroll', () => {
  if (reduced.matches) return;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      playEffect(entry.target, 'section-enter', liftIn, 440);
    }
  }, { threshold: .16 });
  for (const element of document.querySelectorAll('[data-scroll-reveal]')) observer.observe(element);
}, { passive: true, once: true });
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
      playEffect(word, 'runtime-change', liftIn, 320);
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
const readerNodes = document.querySelector('#reader-nodes');
const pulses = [...card.querySelectorAll('.snapshot-pulse')];

function showSnapshotTransfer() {
  const travel = [
    { opacity: 0, transform: 'translateY(-3px) scale(.6)' },
    { opacity: 1, offset: .3 },
    { opacity: 1, offset: .72 },
    { opacity: 0, transform: 'translateY(14px) scale(.8)' },
  ];
  pulses.forEach((pulse, index) => playEffect(pulse, 'snapshot-transfer', travel, 420, index * 130));
  [...readerNodes.children].forEach((reader, index) => {
    playEffect(reader, 'worker-receives-snapshot', liftIn, 260, 120 + index * 35);
  });
}
function renderWriterThread() {
  ownerThread.textContent = writerThread.selectedOptions[0].text;
}
writerThread.addEventListener('change', () => {
  renderWriterThread();
  playEffect(ownerThread, 'writer-location', liftIn, 260);
  showSnapshotTransfer();
});
renderWriterThread();
let mode = 'shared';
function render() {
  const count = Number(range.value); card.dataset.model = mode;
  document.querySelector('#worker-count-value').textContent = String(count);
  document.querySelector('#arena-label').textContent = mode === 'shared' ? 'Shared backing storage' : 'Owner storage';
  document.querySelector('#storage-count').textContent = mode === 'shared' ? '1 backing store' : `${count + 1} separate stores`;
  readerNodes.replaceChildren();
  for (let i = 0; i < count; i++) {
    const node = document.createElement('div'); node.className = 'reader-node';
    node.append(`Worker ${i + 1}`);
    const label = document.createElement('small'); label.textContent = mode === 'shared' ? 'READ-ONLY VIEW' : 'LOCAL COPY'; node.append(label);
    if (mode === 'cloned') { const memory = document.createElement('div'); memory.className = 'mini-memory'; memory.setAttribute('aria-hidden', 'true'); for (let j = 0; j < 4; j++) memory.append(document.createElement('i')); node.append(memory); }
    readerNodes.append(node);
  }
  document.querySelectorAll('[data-storage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.storage === mode)));
}
range.addEventListener('input', () => {
  const previousCount = readerNodes.childElementCount;
  render();
  for (const reader of [...readerNodes.children].slice(previousCount)) {
    playEffect(reader, 'worker-arrival', liftIn, 280);
  }
});
for (const button of card.querySelectorAll('[data-storage]')) {
  button.addEventListener('click', () => {
    if (mode === button.dataset.storage) return;
    mode = button.dataset.storage;
    render();
    showSnapshotTransfer();
  });
}
render();
const tabs = [...document.querySelectorAll('[data-code-tab]')];
function select(tab) {
  if (tab.getAttribute('aria-selected') === 'true') return;
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).toggleAttribute('data-inactive', !active);
  }
  const source = document.getElementById(tab.getAttribute('aria-controls')).querySelector('code');
  playEffect(source, 'source-switch', [
    { opacity: .78, transform: 'translateX(5px)' },
    { opacity: 1, transform: 'translateX(0)' },
  ], 240);
}
for (const tab of tabs) {
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[1 - tabs.indexOf(tab)];
    select(next);
    next.focus();
  });
}
