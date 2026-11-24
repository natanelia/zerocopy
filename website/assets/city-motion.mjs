import { notify } from './main.mjs';

const hero = document.querySelector('.city-hero');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const playback = hero.querySelector('.city-playback');
const runtime = hero.querySelector('.runtime-word');
const copy = hero.querySelector('.copy-install');
const nodes = [...hero.querySelectorAll('[data-job]')];
const labels = { queued: 'Waiting', running: 'Running', done: 'Complete' };
const jobs = ['school', 'train', 'utility'];

// The timeline describes an example. It does not start workers or take measurements.
// All three jobs overlap on one snapshot. Hold the completed city before resetting.
const frames = [
  { ms: 850,   raised: false, states: ['queued',  'queued',  'queued'],  runtime: 'Node.js' },
  { ms: 1100,  raised: true,  states: ['queued',  'queued',  'queued'],  runtime: 'Node.js' },
  { ms: 1100,  raised: true,  states: ['running', 'queued',  'queued'],  runtime: 'Node.js' },
  { ms: 1100,  raised: true,  states: ['running', 'running', 'queued'],  runtime: 'Node.js' },
  { ms: 3000,  raised: true,  states: ['running', 'running', 'running'], runtime: 'Node.js' },
  { ms: 2700,  raised: true,  states: ['done',    'running', 'running'], runtime: 'Browser' },
  { ms: 2700,  raised: true,  states: ['done',    'done',    'running'], runtime: 'Browser' },
  { ms: 6000,  raised: true,  states: ['done',    'done',    'done'],    runtime: 'Bun' },
];
let frame = 0;
let remaining = frames[0].ms;
let timer;
let deadline;
let inView = false;
let paused = false;

copy.hidden = false;
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(hero.querySelector('.install-command code').textContent);
    notify('Install command copied.');
  } catch {
    notify('Select the install command to copy it.');
  }
});

function render(current) {
  hero.dataset.district = current.raised ? 'raised' : 'planned';
  if (runtime.textContent !== current.runtime) {
    runtime.textContent = current.runtime;
    if (!motion.matches) runtime.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 330 });
  }
  for (const node of nodes) {
    const state = current.states[jobs.indexOf(node.dataset.job)];
    node.dataset.state = state;
    const status = node.querySelector('.job-status');
    if (status) status.textContent = labels[state];
  }
}

function stopClock() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  remaining = Math.max(0, deadline - performance.now());
}

function syncPlayback() {
  if (motion.matches) {
    stopClock();
    frame = 0;
    remaining = frames[0].ms;
    playback.hidden = true;
    for (const animation of hero.getAnimations({ subtree: true })) animation.cancel();
    render({ raised: true, states: ['done', 'done', 'done'], runtime: 'Node.js' });
    return;
  }
  playback.hidden = false;
  if (paused || !inView || document.hidden) {
    stopClock();
    return;
  }
  if (timer !== undefined) return;
  render(frames[frame]);
  deadline = performance.now() + remaining;
  timer = setTimeout(() => {
    timer = undefined;
    frame = (frame + 1) % frames.length;
    remaining = frames[frame].ms;
    syncPlayback();
  }, remaining);
}

playback.addEventListener('click', () => {
  paused = !paused;
  playback.setAttribute('aria-label', paused ? 'Resume animation' : 'Pause animation');
  playback.querySelector('.pause-icon').hidden = paused;
  playback.querySelector('.play-icon').hidden = !paused;
  for (const animation of hero.getAnimations({ subtree: true })) {
    if (paused) animation.pause();
    else animation.play();
  }
  syncPlayback();
});
new IntersectionObserver(([entry]) => {
  inView = entry.isIntersecting;
  syncPlayback();
}).observe(hero);
motion.addEventListener('change', syncPlayback);
document.addEventListener('visibilitychange', syncPlayback);
syncPlayback();
