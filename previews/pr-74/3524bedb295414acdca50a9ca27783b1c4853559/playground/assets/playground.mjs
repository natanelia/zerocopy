import { checkCapability } from './capability.mjs';

const MAX_READERS = 3, MAX_EDITS = 40, HISTORY_LIMIT = 8;
const seeds = [
  ['headphones', { name: 'Studio headphones', priceCents: 12900, stock: 12 }],
  ['keyboard', { name: 'Mechanical keyboard', priceCents: 8900, stock: 24 }],
  ['lamp', { name: 'Task lamp', priceCents: 4900, stock: 8 }],
];
const labels = { headphones: 'headphones', keyboard: 'keyboard', lamp: 'lamp' };
const $ = selector => document.querySelector(selector);
const start = $('#start-playground'), apply = $('#apply-edit'), stop = $('#stop-playground');
const stock = $('#stock'), price = $('#price'), add = $('#add-reader'), log = $('#snapshot-log');
const status = $('#studio-status'), page = $('.studio-page');
let state, readers = [], history = [], selected = 'headphones', generation = 0, busy = false, capable = false;
const money = cents => `$${(cents / 100).toFixed(2)}`;
const readerLabel = reader => `Reader ${String(reader.id).padStart(2, '0')}`;

function entry(message) {
  const item = document.createElement('li'); item.textContent = message; log.append(item);
  while (log.children.length > 16) log.firstElementChild.remove();
}
function controls() {
  start.disabled = !capable || !!state || busy;
  stop.disabled = !state && !busy;
  apply.disabled = !state || busy || state.version >= MAX_EDITS;
  add.disabled = !state || busy || readers.length >= MAX_READERS;
  stock.disabled = price.disabled = !state || busy || state.version >= MAX_EDITS;
  for (const button of document.querySelectorAll('[data-product]')) button.disabled = !state || busy;
  for (const reader of readers) {
    reader.card.querySelector('[data-pin-select]').disabled = busy || !reader.report;
    reader.card.querySelector('[data-pin-latest]').disabled = busy || !reader.report;
  }
  page.dataset.connected = String(!!state);
  page.setAttribute('aria-busy', String(busy));
  $('#studio-session-label').textContent = state ? `${readers.length} real worker${readers.length === 1 ? '' : 's'} · shared transport` : 'No workers running';
}
function showValue(prefix, value) {
  const output = document.getElementById(`${prefix}-value`);
  output.replaceChildren(document.createTextNode(String(value.stock)));
  const unit = document.createElement('span'); unit.textContent = 'units'; output.append(unit);
  document.getElementById(`${prefix}-availability`).textContent = value.stock === 0 ? 'Sold out' : 'In stock';
}
function renderOwner() {
  if (!state) return;
  const current = state.current.catalog.get(selected);
  showValue('owner', current); $('#owner-price').textContent = money(current.priceCents);
  $('#owner-revision').textContent = `r${state.version}`;
  for (const button of document.querySelectorAll('[data-product]')) {
    const value = state.current.catalog.get(button.dataset.product);
    button.setAttribute('aria-pressed', String(button.dataset.product === selected));
    button.querySelector('[data-product-price]').textContent = money(value.priceCents);
    button.querySelector('[data-product-stock]').textContent = `${value.stock} in stock`;
  }
}
function renderReader(reader) {
  if (!reader.report) return;
  const { report, card } = reader, first = reader.id === 1;
  showValue(first ? 'reader' : `reader-${reader.id}`, report.products[selected]);
  showValue(first ? 'retained' : `retained-${reader.id}`, report.pinned.products[selected]);
  card.querySelector('[data-latest-version]').textContent = `r${report.version}`;
  card.querySelector('[data-pinned-version]').textContent = `r${report.pinned.version}`;
  card.querySelector('[data-latest-price]').textContent = money(report.products[selected].priceCents);
  card.querySelector('[data-pinned-price]').textContent = money(report.pinned.products[selected].priceCents);
  card.querySelector('[data-reader-status]').textContent = `Reading r${report.version}`;
  card.dataset.ready = 'true';
  const select = card.querySelector('[data-pin-select]');
  select.replaceChildren(...report.available.map(version => {
    const option = document.createElement('option'); option.value = String(version);
    option.textContent = `Revision ${version}`; option.selected = version === report.pinned.version; return option;
  }));
}
function renderHistory() {
  const list = $('#revision-timeline');
  list.replaceChildren(...history.map(item => {
    const li = document.createElement('li'), version = document.createElement('strong'), detail = document.createElement('span');
    version.textContent = `r${item.version}`; detail.textContent = item.detail; li.append(version, detail); return li;
  }));
  $('#studio-history-count').textContent = `Current revision ${state.version} / ${MAX_EDITS}`;
  list.scrollLeft = list.scrollWidth;
}
function draft(product, initial = false) {
  selected = product;
  const value = state.current.catalog.get(product);
  stock.value = initial ? '0' : String(value.stock); price.value = (value.priceCents / 100).toFixed(2);
  $('#editing-product').textContent = `Edit ${labels[product]}`;
  $('#stock-label').textContent = `${labels[product][0].toUpperCase() + labels[product].slice(1)} in stock`;
  renderOwner(); readers.forEach(renderReader);
}
function disconnect() {
  generation++; busy = false;
  const oldState = state; state = undefined;
  oldState?.dispose();
  for (const reader of readers) {
    reader.worker.terminate();
    for (const waiter of [...reader.waiters]) waiter.finish(new Error('Session disconnected'));
    reader.card.dataset.ready = 'false';
    reader.card.querySelector('[data-reader-status]').textContent = 'Disconnected';
    reader.card.querySelector('[data-pin-select]').disabled = true;
    reader.card.querySelector('[data-pin-latest]').disabled = true;
  }
  readers = []; controls();
}
function fail(error, currentGeneration) {
  if (currentGeneration !== generation) return;
  const message = error instanceof Error ? error.message : String(error);
  disconnect(); status.textContent = `Session stopped: ${message}. Connect a worker to try again.`; entry(`Error: ${message}`);
}
function waitForReport(reader, predicate) {
  if (reader.report && predicate(reader.report)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { predicate, finish(error) { clearTimeout(timer); reader.waiters.delete(waiter); error ? reject(error) : resolve(); } };
    const timer = setTimeout(() => waiter.finish(new Error(`${readerLabel(reader)} did not report within 10 seconds`)), 10000);
    reader.waiters.add(waiter);
  });
}
async function connectReader(currentGeneration) {
  const id = readers.length + 1;
  const worker = new Worker(new URL('./snapshot-worker.mjs', import.meta.url), { type: 'module' });
  const reader = { id, worker, card: $(`#studio-reader-${id}`), waiters: new Set(), report: undefined };
  readers.push(reader); reader.card.hidden = false; reader.card.querySelector('[data-reader-status]').textContent = 'Connecting…'; controls();
  worker.onmessage = ({ data }) => {
    if (currentGeneration !== generation) return;
    if (data?.type === 'error') { fail(new Error(data.message), currentGeneration); return; }
    if (data?.type !== 'snapshot') return;
    const previousVersion = reader.report?.version;
    reader.report = data; renderReader(reader);
    for (const waiter of [...reader.waiters]) if (waiter.predicate(data)) waiter.finish();
    if (previousVersion !== data.version) entry(`${readerLabel(reader)} received r${data.version}; pinned snapshot remains r${data.pinned.version}.`);
  };
  worker.onerror = error => fail(new Error(error.message || `${readerLabel(reader)} failed to load`), currentGeneration);
  worker.onmessageerror = () => fail(new Error(`${readerLabel(reader)} returned an unreadable message`), currentGeneration);
  await Promise.all([state.connect(worker), waitForReport(reader, () => true)]);
}

checkCapability(() => { capable = true; controls(); });
start.addEventListener('click', async () => {
  if (state || busy || !capable) return;
  const currentGeneration = ++generation; busy = true; controls(); log.replaceChildren();
  status.textContent = 'Creating shared storage and connecting a real worker…';
  try {
    const [{ SharedMap, resetMap }, { createState }] = await Promise.all([import('../library/shared.js'), import('../library/state.js')]);
    if (currentGeneration !== generation) return;
    // A fresh arena per session lets a previous disconnected session be collected.
    resetMap();
    state = createState({ catalog: new SharedMap('object').setMany(seeds) }, {
      copy: false, timeoutMs: 10000, onError: error => fail(error, currentGeneration),
    });
    for (let i = 2; i <= MAX_READERS; i++) $(`#studio-reader-${i}`).hidden = true;
    history = [{ version: 0, detail: 'Initial catalog · 3 products' }];
    draft('headphones', true); renderHistory();
    await connectReader(currentGeneration);
    if (currentGeneration !== generation) return;
    busy = false; controls();
    status.textContent = 'Connected. Publish zero stock and watch the pinned snapshot keep its original 12 units.';
    entry('Shared transport connected. Collection reads happen locally inside each worker.');
  } catch (error) { fail(error, currentGeneration); }
});

$('#studio-editor').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state || busy || state.version >= MAX_EDITS || !event.currentTarget.reportValidity()) return;
  const stockValue = Number(stock.value), cents = Math.round(Number(price.value) * 100);
  if (!Number.isSafeInteger(stockValue) || stockValue < 0 || stockValue > 200 || !Number.isSafeInteger(cents) || cents < 1 || cents > 999999) return;
  const product = state.current.catalog.get(selected);
  if (product.stock === stockValue && product.priceCents === cents) { status.textContent = 'No changes yet. Edit the price or stock before publishing.'; return; }
  const currentGeneration = generation; busy = true; controls();
  try {
    const version = state.publish({ catalog: state.current.catalog.set(selected, { ...product, stock: stockValue, priceCents: cents }) });
    history.push({ version, detail: `${labels[selected]} · ${stockValue} units · ${money(cents)}` });
    if (history.length > HISTORY_LIMIT) history.shift();
    renderOwner(); renderHistory(); status.textContent = `Published revision ${version}. Waiting for the readers…`;
    await Promise.all(readers.map(reader => waitForReport(reader, report => report.version === version)));
    if (currentGeneration !== generation) return;
    busy = false; controls();
    status.textContent = version >= MAX_EDITS ? 'Session limit reached. Disconnect and reconnect to start a fresh catalog.' : `All ${readers.length} reader${readers.length === 1 ? '' : 's'} received revision ${version}. Their pinned snapshots are unchanged.`;
  } catch (error) { fail(error, currentGeneration); }
});

add.addEventListener('click', async () => {
  if (!state || busy || readers.length >= MAX_READERS) return;
  const currentGeneration = generation; busy = true; controls();
  try {
    await connectReader(currentGeneration);
    if (currentGeneration !== generation) return;
    busy = false; controls(); status.textContent = `Reader ${readers.length} joined at revision ${state.version}. Its first pinned snapshot starts here.`;
  } catch (error) { fail(error, currentGeneration); }
});

async function pin(reader, version) {
  if (!state || busy || !reader?.report || !reader.report.available.includes(version)) return;
  const currentGeneration = generation; busy = true; controls();
  try {
    reader.worker.postMessage({ type: 'studio:pin', version });
    await waitForReport(reader, report => report.pinned.version === version);
    if (currentGeneration !== generation) return;
    busy = false; controls();
    status.textContent = `${readerLabel(reader)} now keeps revision ${version}. Its latest snapshot still follows the writer.`;
    entry(`${readerLabel(reader)} pinned r${version}.`);
  } catch (error) { fail(error, currentGeneration); }
}
for (let index = 1; index <= MAX_READERS; index++) {
  $(`#pin-revision-${index}`).addEventListener('change', event => { void pin(readers[index - 1], Number(event.target.value)); });
  $(`#studio-reader-${index} [data-pin-latest]`).addEventListener('click', () => {
    const reader = readers[index - 1]; if (reader?.report) void pin(reader, reader.report.version);
  });
}
for (const button of document.querySelectorAll('[data-product]')) button.addEventListener('click', () => {
  if (state && !busy) draft(button.dataset.product);
});
stop.addEventListener('click', () => { disconnect(); status.textContent = 'Disconnected. All workers are terminated. Connect again for a fresh catalog.'; entry('Disconnected. Session released; all reader workers terminated.'); });
window.addEventListener('pagehide', () => {
  disconnect();
  status.textContent = 'Page navigation ended this session. Connect a worker to start a fresh catalog.';
  entry('Page navigation terminated all workers and released the session.');
});
