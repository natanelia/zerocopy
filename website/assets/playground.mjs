import { checkCapability } from './capability.mjs';
const start = document.querySelector('#start-playground'), apply = document.querySelector('#apply-edit'), stop = document.querySelector('#stop-playground'), speed = document.querySelector('#speed');
let state, worker, pending = false, generation = 0;
const log = document.querySelector('#snapshot-log');
function entry(message) {
  const item = document.createElement('li'); item.textContent = message; log.append(item);
  while (log.children.length > 16) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}
function value(id, number) {
  const element = document.getElementById(id); element.replaceChildren(document.createTextNode(String(number)));
  const unit = document.createElement('span'); unit.textContent = 'km/h'; element.append(unit);
  const card = element.closest('.snapshot-live'); card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
}
function disconnect() {
  generation++; pending = false; state?.dispose(); worker?.terminate(); state = undefined; worker = undefined;
  start.disabled = false; apply.disabled = true; stop.disabled = true; speed.disabled = true;
}
checkCapability(() => { start.disabled = false; });
start.addEventListener('click', async () => {
  if (pending || worker) return;
  pending = true; start.disabled = true; const currentGeneration = ++generation;
  log.replaceChildren(); entry('Loading zerocopy. No task server is used.');
  try {
    const [{ SharedMap }, { createState }] = await Promise.all([import('../library/shared.js'), import('../library/state.js')]);
    if (currentGeneration !== generation) return;
    state = createState({ limits: new SharedMap('number').set('lane-1', 30) }, { copy: false });
    value('owner-value', 30);
    worker = new Worker(new URL('./snapshot-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (currentGeneration !== generation) return;
      if (data.type === 'error') { entry(`Error: ${data.message}`); disconnect(); return; }
      if (data.type !== 'snapshot') return;
      value('reader-value', data.current); value('retained-value', data.retained);
      entry(`Worker received v${data.version}: current ${data.current}; first snapshot ${data.retained}.`);
    };
    worker.onerror = error => { if (currentGeneration !== generation) return; entry(`Worker error: ${error.message}`); disconnect(); };
    worker.onmessageerror = () => { if (currentGeneration !== generation) return; entry('Worker returned an unreadable message.'); disconnect(); };
    await state.connect(worker);
    if (currentGeneration !== generation) return;
    pending = false; apply.disabled = false; stop.disabled = false; speed.disabled = false;
    entry('Connected through shared transport. Each .get() reads locally.');
  } catch (error) { if (currentGeneration === generation) { entry(`Could not connect: ${error.message}`); disconnect(); } }
});
apply.addEventListener('click', () => {
  if (!state || !worker) return;
  if (!speed.reportValidity()) return;
  const next = Number(speed.value);
  if (!Number.isFinite(next) || next < 0 || next > 200) return;
  try { state.update('limits', limits => limits.set('lane-1', next)); value('owner-value', state.current.limits.get('lane-1')); entry(`Owner updated to ${next}. Snapshot publication is asynchronous.`); }
  catch (error) { entry(`Update failed: ${error.message}`); }
});
stop.addEventListener('click', () => { disconnect(); entry('Disconnected. This worker was terminated.'); });
window.addEventListener('pagehide', disconnect);
