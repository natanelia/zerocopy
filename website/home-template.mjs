import { codeBlock } from './render.mjs';
import { projectName, repository } from './config.mjs';

const arrow = '<svg class="external-arrow" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 12.5 12 4M4 4h8v8"/></svg>';

// These are ordinary public API examples. Hosting and bundler setup live in
// the linked, executable quickstart; the homepage never loads the runtime.
const ownerExample = `if (!crossOriginIsolated) {
  throw new Error('Enable COOP/COEP headers first.');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');

const state = createState({
  stock: new SharedMap('number').set('item/42', 12),
}, { copy: false });

const worker = new Worker(
  new URL('./worker.ts', import.meta.url),
  { type: 'module' },
);
window.addEventListener('pagehide', () => {
  state.dispose();
  worker.terminate();
}, { once: true });

await state.connect(worker);
state.update('stock', stock => stock.set('item/42', 7));`;

const readerExample = `import type { SharedMap } from 'zerocopy';
import { connectSharedSession } from 'zerocopy/worker';

type Model = { stock: SharedMap<'number'> };
const shared = await connectSharedSession<Model>();
const initial = shared.current;

shared.subscribe(snapshot => {
  // Both reads are local. Neither asks the writer.
  console.log(snapshot.stock.get('item/42')); // 7
  console.log(initial.stock.get('item/42'));  // 12
});

// When this session is no longer needed:
// shared.dispose();`;

export function home(base) {
  return `<main id="main" class="product-home">
    <section class="hero wrap" aria-labelledby="hero-heading">
      <div class="hero-copy">
        <a class="project-badge" href="${repository}"><span class="status-dot"></span>${projectName}<span aria-hidden="true">${arrow}</span></a>
        <h1 id="hero-heading">Share your data.<br><span>Not copies.</span></h1>
        <p class="hero-description">Immutable collections.<br>One shared foundation for your workers.</p>
        <p class="hero-detail">zerocopy is a JavaScript and TypeScript library that lets your UI and workers read the same data. Publish a new snapshot. Keep the old one intact.</p>
        <div class="hero-buttons"><a class="button primary" href="${base}playground/">Try the playground <span aria-hidden="true">→</span></a><a class="button secondary" href="${base}docs/getting-started/">Read the docs ${arrow}</a></div>
        <div class="install-command code-block"><code>npm install zerocopy</code><button class="copy-code" aria-label="Copy install command"><svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 4V3H3v9h1"/></svg></button></div>
        <p class="hero-note">TypeScript native <span>·</span> WebAssembly powered <span>·</span> MIT licensed</p>
      </div>
      <div class="sharing-card" data-model="shared" aria-label="Interactive conceptual view of shared and cloned storage">
        <div class="diagram-toolbar"><span class="diagram-title"><span class="signal-dot"></span> MEMORY TOPOLOGY</span><div class="segmented" role="group" aria-label="Storage model"><button data-storage="shared" aria-pressed="true">Shared</button><button data-storage="cloned" aria-pressed="false">Cloned</button></div></div>
        <div class="diagram">
          <div class="diagram-coordinate" aria-hidden="true">00:01 / SHARED MEMORY</div>
          <div class="owner-node"><span class="node-icon" aria-hidden="true">↳</span><span>Writer<small>Main thread or worker</small></span><span class="node-live" aria-hidden="true"></span></div>
          <div class="wire wire-top" aria-hidden="true"></div>
          <div class="arena"><div class="arena-header"><span id="arena-label">Shared backing storage</span><span id="arena-revision">r01</span></div><div class="memory-stage" aria-hidden="true"><div class="memory-shadow"></div><div class="memory-grid">${Array.from({ length: 72 }, (_, i) => `<i class="${[7,8,9,19,20,21,31,32,33].includes(i) ? 'memory-hot' : ''}" style="--i:${i}"></i>`).join('')}</div><span class="memory-axis axis-left">SharedArrayBuffer</span><span class="memory-axis axis-right">Map · List · Set</span></div></div>
          <div class="wire wire-bottom" aria-hidden="true"></div>
          <div class="reader-nodes" id="reader-nodes"><div class="reader-node"><span class="reader-icon" aria-hidden="true">◈</span><span>UI<small>READ-ONLY VIEW</small></span><span class="reader-revision">r01</span></div><div class="reader-node"><span class="reader-icon" aria-hidden="true">⌕</span><span>Search<small>READ-ONLY VIEW</small></span><span class="reader-revision">r01</span></div><div class="reader-node"><span class="reader-icon" aria-hidden="true">✓</span><span>Validation<small>READ-ONLY VIEW</small></span><span class="reader-revision">r01</span></div></div>
        </div>
        <div class="diagram-controls"><label for="worker-count">Readers <output id="worker-count-value">3</output></label><input id="worker-count" type="range" min="1" max="4" value="3"><button id="publish-concept" class="concept-publish">Update data <span aria-hidden="true">↻</span></button></div>
        <div class="diagram-summary"><span id="storage-count">1 backing store</span><span id="concept-state" role="status">Same bytes. Independent readers.</span></div>
        <p class="diagram-caption">Interactive explanation. Not a measured benchmark.</p>
        <noscript><p class="diagram-caption">This diagram shows one writer and three readers. Enable JavaScript to change the model.</p></noscript>
      </div>
    </section>

    <section class="foundation-strip wrap" aria-label="The model in three parts"><div><span class="small-index">01</span><strong>One writer.</strong><p>A clear owner for every arena.</p></div><div><span class="small-index">02</span><strong>Local reads.</strong><p>No message for every lookup.</p></div><div><span class="small-index">03</span><strong>Stable snapshots.</strong><p>New edits. Undisturbed readers.</p></div></section>

    <section class="section wrap story-section" id="how-it-works" aria-labelledby="story-heading">
      <div class="story-copy"><span class="eyebrow">01 / THE MENTAL MODEL</span><h2 id="story-heading">More workers.<br>Less baggage.</h2><p class="section-lead">Your dataset shouldn’t need a new home every time you start a worker.</p><p>With structured cloning, each reader gets its own copy. ZeroCopy puts collections in shared storage and gives each reader an immutable view.</p><p>Change a product, publish a revision, and readers can move forward when they’re ready. A captured snapshot stays exactly as it was.</p><a class="text-link" href="${base}docs/mental-model/">Understand the architecture <span aria-hidden="true">→</span></a></div>
      <div class="revision-illustration" aria-label="Illustration: a new revision changes stock from 12 to 7, while a reader keeps revision 1"><div class="illustration-label"><span>EDIT ONCE. KEEP BOTH VIEWS.</span><span>ILLUSTRATION</span></div><div class="revision-record"><div class="record-icon" aria-hidden="true">◈</div><div><span class="mono">product / 0042</span><strong>A record changes.</strong></div><span class="record-badge">PUBLISHED</span></div><div class="revision-path" aria-hidden="true"><span></span><span></span></div><div class="revision-pair"><div class="revision-card earlier"><div class="revision-card-title"><span>r01</span><span>Retained</span></div><p>Previous stock</p><strong>12<span> units</span></strong><div class="revision-card-footer"><span class="status-dot"></span>Reader keeps its view</div></div><div class="revision-card current"><div class="revision-card-title"><span>r02</span><span>Current</span></div><p>Updated stock</p><strong>7<span> units</span></strong><div class="revision-card-footer"><span class="status-dot"></span>Ready for new reads</div></div></div><p class="revision-footnote">Snapshots share backing storage. Old versions remain readable.</p></div>
    </section>

    <section class="playground-promo" id="worker-architecture" aria-labelledby="try-heading"><div class="wrap playground-promo-inner"><div><span class="eyebrow">02 / FEEL THE DIFFERENCE</span><h2 id="try-heading">A little app.<br>A real shared world.</h2><p>Edit a product. Publish a revision. Pin an older snapshot in one reader while another follows the latest.</p><div class="hero-buttons"><a class="button primary" href="${base}playground/">Open snapshot studio <span aria-hidden="true">→</span></a></div><p class="demo-disclosure">Actual SharedMap. Real Web Workers. Runs in your browser.</p></div><ol class="demo-steps"><li><span>01</span><div><strong>Make an edit</strong><p>Change a price or stock level.</p></div><i aria-hidden="true">${arrow}</i></li><li><span>02</span><div><strong>Publish a snapshot</strong><p>Watch connected readers update.</p></div><i aria-hidden="true">${arrow}</i></li><li><span>03</span><div><strong>Keep a moment in time</strong><p>Read an earlier revision, unchanged.</p></div><i aria-hidden="true">${arrow}</i></li></ol></div></section>

    <section class="section wrap code-section" aria-labelledby="code-heading"><div class="code-intro"><span class="eyebrow">03 / START WITH WHAT YOU KNOW</span><h2 id="code-heading">Familiar collections.<br>Shared by design.</h2><p>Map. List. Set. The building blocks you already use, with immutable versions your workers can read directly.</p><p>Connect once. Then <code>.get()</code> is a synchronous local read. Sessions deliver new snapshots asynchronously.</p><div class="code-facts"><div><span>Storage</span><strong>SharedArrayBuffer + WebAssembly</strong></div><div><span>Ownership</span><strong>One allocating writer per arena</strong></div><div><span>Scheduling</span><strong>Your workers. Tasks optional.</strong></div></div><a class="text-link" href="${base}docs/getting-started/">Complete runnable setup <span aria-hidden="true">→</span></a><p class="code-host-note">Browser examples need HTTPS or localhost and cross-origin isolation. The guide includes the headers and bundler setup.</p></div><div class="code-demo"><div class="code-window-bar"><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>A SHARED CONNECTION</span><span>TS</span></div><div class="code-tabs" role="tablist" aria-label="Thread example"><button role="tab" aria-selected="true" id="tab-owner" aria-controls="panel-owner" data-code-tab="owner">main.ts</button><button role="tab" aria-selected="false" id="tab-reader" aria-controls="panel-reader" tabindex="-1" data-code-tab="reader">worker.ts</button></div><div role="tabpanel" id="panel-owner" aria-labelledby="tab-owner" tabindex="0">${codeBlock(ownerExample, 'main.ts · one writer')}</div><div role="tabpanel" id="panel-reader" aria-labelledby="tab-reader" tabindex="0" hidden>${codeBlock(readerExample, 'worker.ts · local reads')}</div><div class="code-demo-bottom"><span><span class="status-dot"></span> Small messages. Shared collection bytes.</span><a href="${base}docs/transport/">Bring your own transport ${arrow}</a></div></div></section>

    <section class="section wrap measure-section" aria-labelledby="measure-heading"><div class="section-heading"><div><span class="eyebrow">04 / BENCHMARKS</span><h2 id="measure-heading">Memory first.<br>Measure for yourself.</h2></div><div class="measure-summary"><p>See how much memory each implementation uses. Then run the performance test on your device, on the same page.</p><a class="button primary" href="${base}benchmarks/">Open benchmarks <span aria-hidden="true">→</span></a><p class="measure-source">Recorded results include their source. Your browser run stays on your device.</p></div></div></section>

    <section class="section wrap fit-section" aria-labelledby="fit-heading"><div><span class="eyebrow">05 / CHOOSE IT FOR THE RIGHT REASONS</span><h2 id="fit-heading">A powerful fit.<br>With clear boundaries.</h2><p>Sharing can remove repeated dataset copies. It doesn’t make every operation faster, and it doesn’t mean zero allocations.</p><a class="text-link" href="${base}docs/choose-zerocopy/">Should I use ZeroCopy? <span aria-hidden="true">→</span></a></div><div class="fit-details"><div><span class="fit-marker" aria-hidden="true">+</span><h3>Large data. Multiple readers.</h3><p>Useful when several threads need stable views of the same changing dataset.</p><div class="pattern-links"><a href="${base}docs/catalog/">Catalogs ${arrow}</a><a href="${base}docs/editors/">Editors ${arrow}</a><a href="${base}docs/data-tables/">Data tables ${arrow}</a><a href="${base}docs/graphs/">Graphs ${arrow}</a><a href="${base}docs/analytics/">Filtering ${arrow}</a><a href="${base}docs/simulations/">Simulations ${arrow}</a></div></div><div><span class="fit-marker" aria-hidden="true">↳</span><h3>Plan for ownership and lifetime.</h3><p>One writer per arena. Browser isolation. Asynchronous snapshot delivery. Explicit compaction for long-lived data.</p><a href="${base}docs/memory/">Read the memory guide →</a></div><div><span class="fit-marker" aria-hidden="true">−</span><h3>Small, single-threaded data?</h3><p>Native collections are often the simpler choice. Measure your application before adding a shared-memory layer.</p></div></div></section>

    <section class="closing wrap"><span class="eyebrow">BUILD SOMETHING THAT SHARES.</span><h2>Same data.<br><span>More possibilities.</span></h2><div class="hero-buttons"><a class="button primary" href="${base}docs/getting-started/">Connect your first worker <span aria-hidden="true">→</span></a><a class="text-link" href="${repository}">Explore the source ${arrow}</a></div></section>
  </main>`;
}
