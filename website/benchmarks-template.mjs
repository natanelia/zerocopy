/** Benchmark discovery only. Measurements stay in the existing checked harnesses. */
export function benchmarks(base) {
  return `<main id="main" class="wrap evidence-page">
    <header class="evidence-intro">
      <span class="eyebrow">THE BENCHMARK EXPLORER</span>
      <div class="evidence-heading"><h1>Find the cost<br>that <span>matters.</span></h1><p>Building a collection, publishing an edit, and keeping history are different jobs. Choose the question that matches your application. Then inspect the work behind the number.</p></div>
      <div class="evidence-legend"><span><i aria-hidden="true"></i> Live · runs on your device</span><span><i aria-hidden="true"></i> Recorded · includes its original environment</span></div>
    </header>

    <section class="evidence-suites" aria-label="Choose a benchmark">
      <article class="evidence-suite evidence-suite-featured" aria-labelledby="suite-publish">
        <div class="evidence-suite-top"><span class="evidence-number">01 / PUBLISHING</span><span class="evidence-kind evidence-kind-live">LIVE IN YOUR BROWSER</span></div>
        <h2 id="suite-publish">What does an<br>update really cost?</h2>
        <p>Replace 100 products. Compare shared snapshots, incremental copies, and full copies while two workers keep reading.</p>
        <dl><div><dt>Dataset</dt><dd>1,000–100,000 product records</dd></div><div><dt>Answers</dt><dd>Build, publish, query, and edit timings</dd></div><div><dt>Evidence</dt><dd>Checked results + raw JSON export</dd></div></dl>
        <a class="button primary" href="${base}investigation-benchmark/">Run the catalog benchmark <span aria-hidden="true">→</span></a>
        <a class="evidence-method-link" href="${base}docs/catalog/#read-the-measurements">Read the catalog method →</a>
      </article>

      <article class="evidence-suite" aria-labelledby="suite-fanout">
        <div class="evidence-suite-top"><span class="evidence-number">02 / WORKER FAN-OUT</span><span class="evidence-kind evidence-kind-live">LIVE IN YOUR BROWSER</span></div>
        <h2 id="suite-fanout">What changes with<br>more readers?</h2>
        <p>Publish the same numeric Map to one, two, or four workers. Each worker attaches and reads every key.</p>
        <dl><div><dt>Dataset</dt><dd>1,000–50,000 string-keyed numbers</dd></div><div><dt>Answers</dt><dd>Full publication + local reads</dd></div><div><dt>Evidence</dt><dd>Checked checksums + raw JSON export</dd></div></dl>
        <a class="button secondary" href="${base}lab/">Run the worker fan-out control <span aria-hidden="true">→</span></a>
        <p class="evidence-suite-note">This separate control uses full-copy Immutable.js and Immer replicas on every publication.</p>
      </article>

      <article class="evidence-suite" aria-labelledby="suite-collections">
        <div class="evidence-suite-top"><span class="evidence-number">03 / COLLECTION OPERATIONS</span><span class="evidence-kind">RECORDED · BUN</span></div>
        <h2 id="suite-collections">How much does<br>a local operation cost?</h2>
        <p>Compare construction, reads, edits, and scans. See both warmed operations and first-use setup, including slower workloads.</p>
        <dl><div><dt>Dataset</dt><dd>Maps, lists, queues, and other collections</dd></div><div><dt>Answers</dt><dd>Local operations; no worker transport</dd></div><div><dt>Evidence</dt><dd>Historical results + reproduction commands</dd></div></dl>
        <a class="button secondary" href="${base}docs/benchmarks/">Explore the collection results <span aria-hidden="true">→</span></a>
        <a class="evidence-method-link" href="${base}docs/benchmarks/#evidence">Inspect recorded evidence →</a>
      </article>

      <article class="evidence-suite" aria-labelledby="suite-memory">
        <div class="evidence-suite-top"><span class="evidence-number">04 / RETAINED MEMORY</span><span class="evidence-kind">RECORDED · NODE.JS</span></div>
        <h2 id="suite-memory">What stays in memory<br>when history stays open?</h2>
        <p>Inspect retained backing storage and whole-process RAM with multiple readers and earlier snapshots still available.</p>
        <dl><div><dt>Dataset</dt><dd>100,000 synthetic records</dd></div><div><dt>Answers</dt><dd>Retained data and endpoint process RSS</dd></div><div><dt>Evidence</dt><dd>Original cohorts, raw data, and accounting</dd></div></dl>
        <a class="button secondary" href="${base}docs/memory-comparison/">Explore the memory report <span aria-hidden="true">→</span></a>
        <p class="evidence-suite-note">An earlier synthetic fixture with incremental copies. These are not current product-catalog or browser measurements.</p>
      </article>
    </section>

    <section class="evidence-reading" aria-labelledby="evidence-reading-title">
      <div><span class="eyebrow">BEFORE COMPARING THE BARS</span><h2 id="evidence-reading-title">Same question.<br>Same work.</h2><p>A useful result tells you what ran, where it ran, and what the timer included.</p></div>
      <ol class="evidence-checks">
        <li><span>01</span><div><h3>Match the workload</h3><p>Use the same dataset, reader count, update size, and retained history. Compare native collections and incremental copies too.</p></div></li>
        <li><span>02</span><div><h3>Keep the environment attached</h3><p>Browser exports include your browser identity, hardware concurrency, source commit, and dependency versions. Recorded reports retain their original runtime and host.</p></div></li>
        <li><span>03</span><div><h3>Open the method and raw samples</h3><p>The live suites rotate case order, warm up, and check results. Export the JSON after the run. Startup and module loading are outside the timers; memory has a separate method.</p></div></li>
      </ol>
    </section>

    <aside class="evidence-copy-note" aria-labelledby="copy-note-title"><span class="evidence-note-icon" aria-hidden="true">↳</span><div><h2 id="copy-note-title">Full-copy bars have a specific job.</h2><p>In the catalog benchmark, only <strong>Publish the edited revision</strong> and <strong>Replace and publish 100 products</strong> add full-copy native Map, Immutable.js, and Immer results. Other phases show the four baseline cases. There are no invented full-copy construction or query results.</p></div><a href="${base}investigation-benchmark/">Open the benchmark →</a></aside>

    <footer class="evidence-next"><div><h2>Decide with your application.</h2><p>ZeroCopy avoids copying shared collection storage between readers. Encoding, local reads, decoding, and keeping arenas alive still have costs.</p></div><a class="text-link" href="${base}docs/choose-zerocopy/">Is ZeroCopy a fit? <span aria-hidden="true">→</span></a></footer>
  </main>`;
}
