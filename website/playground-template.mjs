const products = [
  ['headphones', '01', 'Studio headphones', 'Audio / H-001', '$129.00', '12'],
  ['keyboard', '02', 'Mechanical keyboard', 'Desk / K-002', '$89.00', '24'],
  ['lamp', '03', 'Task lamp', 'Lighting / L-003', '$49.00', '8'],
];

function reader(index) {
  const first = index === 1;
  const currentId = first ? 'reader' : `reader-${index}`;
  const pinnedId = first ? 'retained' : `retained-${index}`;
  return `<article class="studio-reader" id="studio-reader-${index}" ${first ? '' : 'hidden'} aria-labelledby="reader-title-${index}">
    <div class="studio-reader-heading"><h3 id="reader-title-${index}"><span class="studio-node" aria-hidden="true">${String(index).padStart(2, '0')}</span>Reader ${String(index).padStart(2, '0')}</h3><span class="studio-worker-status" data-reader-status>Not running</span></div>
    <div class="studio-snapshots"><div class="studio-snapshot"><div class="studio-snapshot-label">Latest <span data-latest-version>—</span></div><div class="stock-value" id="${currentId}-value">—<span>units</span></div><p class="studio-price" data-latest-price>—</p><p class="stock-status" id="${currentId}-availability">Not loaded</p></div><div class="studio-snapshot studio-pinned"><div class="studio-snapshot-label">Pinned <span data-pinned-version>—</span></div><div class="stock-value" id="${pinnedId}-value">—<span>units</span></div><p class="studio-price" data-pinned-price>—</p><p class="stock-status" id="${pinnedId}-availability">Not loaded</p></div></div>
    <div class="studio-pin-controls"><label for="pin-revision-${index}">Keep reading</label><select id="pin-revision-${index}" data-pin-select disabled><option value="0">Revision 0</option></select><button class="text-button" data-pin-latest disabled>Pin latest</button></div>
  </article>`;
}

/** Capability UI is supplied by the shared shell so isolation has one source. */
export function playground(base, capabilityNotice = '') {
  return `<main id="main" class="wrap studio-page">
    <div class="studio-intro"><div><p class="eyebrow">THE SNAPSHOT STUDIO</p><h1>New edits.<br><span>Unchanged history.</span></h1></div><p>A tiny catalog. Real shared memory. Edit a product, publish a revision, and let each worker keep its own point of view.</p></div>
    ${capabilityNotice}
    <div class="studio-toolbar"><div class="studio-session-status"><span class="studio-live-dot" aria-hidden="true"></span><span id="studio-session-label">No workers running</span></div><div><button class="button primary" id="start-playground" disabled>Connect a worker <span aria-hidden="true">→</span></button><button class="text-button" id="stop-playground" disabled>Disconnect</button></div></div>
    <p class="studio-status" id="studio-status" role="status">Start with one worker. Then change the stock to zero and publish your first revision.</p>
    <section class="studio-app" aria-label="Interactive shared product catalog">
      <div class="studio-app-chrome"><span><span aria-hidden="true">◈</span> catalog.local</span><span>SharedMap <i aria-hidden="true">/</i> <strong>3 products</strong></span></div>
      <div class="studio-workspace"><section class="studio-owner" aria-labelledby="catalog-heading">
        <div class="studio-panel-heading"><div><span class="eyebrow">01 / SINGLE WRITER</span><h2 id="catalog-heading">Product catalog</h2></div><span class="studio-revision" id="owner-revision">r0</span></div>
        <div class="studio-product-list" role="group" aria-label="Select a product">${products.map(([id, number, title, meta, price, stock], index) => `<button class="studio-product" data-product="${id}" aria-pressed="${index === 0}" disabled><span class="studio-product-icon" aria-hidden="true">${number}</span><span class="studio-product-name"><strong>${title}</strong><small>${meta}</small></span><span class="studio-product-data"><strong data-product-price>${price}</strong><small data-product-stock>${stock} in stock</small></span></button>`).join('')}</div>
        <form id="studio-editor" class="studio-editor"><div class="studio-editor-heading"><h3 id="editing-product">Edit headphones</h3><span>UNPUBLISHED DRAFT</span></div><div class="studio-fields"><label for="price">Price (USD)<input id="price" type="number" required inputmode="decimal" min="0.01" max="9999.99" step="0.01" value="129.00" disabled></label><label for="stock"><span id="stock-label">Headphones in stock</span><input id="stock" type="number" required inputmode="numeric" min="0" max="200" step="1" value="0" disabled></label></div><button class="button primary" id="apply-edit" type="submit" disabled>Publish revision <span aria-hidden="true">→</span></button><p>Publishing creates a new snapshot. Earlier revisions keep their original values.</p></form>
        <div class="studio-owner-read"><div><span class="eyebrow">OWNER / CURRENT VALUE</span><div class="stock-value" id="owner-value">—<span>units</span></div></div><div><p id="owner-price">—</p><p class="stock-status" id="owner-availability">Not loaded</p></div></div>
      </section>
      <section class="studio-readers-panel" aria-labelledby="readers-heading"><div class="studio-panel-heading"><div><span class="eyebrow">02 / INDEPENDENT READERS</span><h2 id="readers-heading">Same data. Your view.</h2></div><button class="text-button" id="add-reader" disabled>+ Add reader</button></div><p class="studio-readers-note">Latest follows the writer. Pinned stays at the revision you choose.</p><div id="studio-readers">${[1, 2, 3].map(reader).join('')}</div></section></div>
      <section class="studio-history" aria-labelledby="history-heading"><div class="studio-history-heading"><h2 id="history-heading"><span class="eyebrow">03 / REVISION HISTORY</span>Every edit has a before.</h2><span id="studio-history-count">No revisions published</span></div><ol id="revision-timeline" aria-label="Published revision history"><li class="studio-empty-history">Connect a worker to create the initial snapshot.</li></ol><p>Timeline shows the latest 8 revisions. Each reader also keeps its first and pinned snapshots. Demo limited to 40 edits per session; this is not a memory benchmark.</p></section>
    </section>
    <div class="studio-explanation"><section><span class="eyebrow">TRY THIS</span><h2>Sell out. Look back.</h2><p>Publish zero stock. The latest snapshot shows sold out; the pinned initial snapshot still has 12. Add a reader after an edit and see it start at the current revision.</p></section><section><span class="eyebrow">WHAT IS REAL</span><h2>Local reads. Real workers.</h2><p>Each reader attaches to the shared collection and reads it locally. Small display reports travel back to this page. JSON product reads may decode and allocate objects.</p><a href="${base}docs/getting-started/" class="text-link">Build your first shared store →</a></section><section><span class="eyebrow">GO BIGGER</span><h2>Measure your workload.</h2><p>Three products make the behavior easy to follow. The full catalog comparison explores larger datasets and different collection implementations.</p><a href="${base}compare/" class="text-link">Open the catalog comparison →</a></section></div>
    <details class="studio-event-log"><summary>Worker event log <span>Actual messages, most recent 16</span></summary><ol id="snapshot-log" role="log" aria-live="polite"><li>Ready. No worker is running yet.</li></ol></details>
    <p class="studio-footnote">Everything runs in this tab. Disconnect and page navigation terminate the workers and release this session. The catalog is a learning demo; stock reservations still need server validation.</p>
  </main>`;
}
