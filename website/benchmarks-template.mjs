import { featureMemoryData, featureChartModel } from './feature-memory-charts.mjs';

const MIB = 1048576;
const labels = { shared: 'ZeroCopy', native: 'Native Map', immutable: 'Immutable.js', immer: 'Immer' };
const mib = bytes => (bytes / MIB).toFixed(2);

/** The same verified recording used by the full memory report, without extra navigation. */
export function benchmarkMemory(base) {
  const model = featureChartModel('rss');
  const data = featureMemoryData;
  const controls = data.summary.filter(row => row.readers === 0 && row.stage === 'edited-retained');
  const control = kind => mib(controls.find(row => row.kind === kind).medians.rssBytes);
  return `<section id="memory" class="benchmark-memory" aria-labelledby="memory-heading">
    <div class="benchmark-section-heading"><div><span class="eyebrow">01 / MEMORY</span><h2 id="memory-heading">Whole-process memory</h2></div><span class="benchmark-unit">MiB · lower is better</span></div>
    <p class="benchmark-workload">100,000 synthetic records <span>·</span> 100 replacements <span>·</span> initial + current revision retained</p>
    <div class="benchmark-memory-grid">${model.groups.map(group => `<figure class="benchmark-chart" data-memory-readers="${group.points[0].readers}" data-memory-maximum="${model.maximum * MIB}">
      <figcaption><h3>${group.label}</h3><p><strong>${group.percentLower.toFixed(1)}%</strong> less RAM vs native Map</p></figcaption>
      <div class="benchmark-bars">${group.points.map(point => `<div class="benchmark-bar" data-memory-kind="${point.kind}" data-memory-bytes="${point.bytes}">
        <div class="benchmark-bar-label"><span>${labels[point.kind]}</span><strong>${mib(point.bytes)} <small>MiB</small></strong></div>
        <div class="benchmark-bar-track" aria-hidden="true"><span style="width:${point.bytes / (model.maximum * MIB) * 100}%"></span></div>
      </div>`).join('')}</div>
      <div class="benchmark-scale" aria-hidden="true"><span>0</span><span>${model.maximum / 2}</span><span>${model.maximum} MiB</span></div>
    </figure>`).join('')}</div>
    <div class="benchmark-source"><p><span class="benchmark-recorded">Recorded</span> ${data.measuredAt.slice(0, 10)} · Node ${data.runtime.slice(1)} · ${data.cpu.replace(/ \d+-Core Processor$/, '')} · median of 3 trials</p><a href="${base}assets/feature-memory-data.json" download>Raw data ↓</a></div>
    <p class="benchmark-caveat">Earlier synthetic fixture with incremental copies. Post-GC process RAM, not browser or peak memory. The owner-only control uses more RAM with ZeroCopy.</p>
    <details class="benchmark-method"><summary>Memory method &amp; controls</summary><div>
      <p>Absolute process RSS includes the owner, all readers, and the Node runtime. The charts use the same zero-based scale and compare matched reader counts after the first edit. All implementations retain revision 0 and revision 1. Native Map, Immutable.js, and Immer send only the 100 changed records on updates.</p>
      <p>The owner-only control uses ${control('shared')} MiB for ZeroCopy SharedMap and ${control('native')} MiB for native Map. These historical measurements use runtime <a href="https://github.com/natanelia/zerocopy/commit/${data.runtimeSourceCommit}">${data.runtimeSourceCommit.slice(0, 7)}</a>, before later optimizations. They do not measure the current product catalog or this browser.</p>
      <p>Each bar is the median of three fresh processes. Raw data contains every sample, observed ranges, source hashes, and environment. The separate eight-reader recording uses a different host and remains in the full report.</p>
      <p>The original reports are available in <a href="#sources">source data</a> below.</p>
    </div></details>
  </section>`;
}

/** Performance is supplied by the checked catalog benchmark presentation. */
export function benchmarks(base, performancePanel = '') {
  return `<main id="main" class="wrap evidence-page">
    <header class="benchmark-intro"><span class="eyebrow">MEMORY &amp; PERFORMANCE</span><h1>Benchmarks<span>.</span></h1><p>Compare memory use. Run the performance test on your device.</p></header>
    ${benchmarkMemory(base)}
    ${performancePanel}
  </main>`;
}
