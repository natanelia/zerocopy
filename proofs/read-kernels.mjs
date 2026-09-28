/** Small browser kernels expose workload limits separately from worker timings.
 * Each implementation gets a fresh context, so the read call site is not made
 * polymorphic by switching between library implementations inside one realm.
 */
export async function measureReadKernels(browser, origin) {
  const results = [];
  for (const implementation of ['legacy', 'candidate', 'immutable']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/candidate/`);
      results.push(await page.evaluate(async implementation => {
        const count = 100000;
        const library = implementation === 'immutable' ? null : await import(`/${implementation}/library/shared.js`);
        const { List } = await import('/candidate/vendor/immutable.mjs');
        async function lists(columns, type) {
          if (!library) return columns.map(values => List(values));
          library.resetSharedList();
          const source = Object.fromEntries(columns.map((values, index) => [index, new library.SharedList(type).pushMany(values)]));
          return Object.values(await library.initWorker(library.getWorkerData(source, { copy: false })));
        }
        function measure(name, operation, expected) {
          const samples = [];
          for (let round = -5; round < 11; round++) {
            const start = performance.now(), answer = operation(), elapsed = performance.now() - start;
            if (answer !== expected) throw new Error(`${name}: incorrect answer`);
            if (round >= 0) samples.push(elapsed);
          }
          const sorted = [...samples].sort((a, b) => a - b);
          return { name, samples, medianMs: sorted[5], checks: 'exact checksum on every warmup and sample' };
        }
        const numeric = Array.from({ length: 4 }, (_, column) => Array.from({ length: count }, (_, i) => i + column));
        const numbers = await lists(numeric, 'number');
        const numericResult = measure('four-column numeric scan', () => {
          let sum = 0;
          for (let i = 0; i < count; i++) sum += numbers[0].get(i) + numbers[1].get(i) + numbers[2].get(i) + numbers[3].get(i);
          return sum;
        }, 4 * count * (count - 1) / 2 + 6 * count);
        const cases = [numericResult];
        for (const unique of [false, true]) {
          const values = Array.from({ length: count }, (_, i) => `Request ${unique ? i : i % 7} completed by service ${i % 4}`);
          const [text] = await lists([values], 'string');
          cases.push(measure(unique ? 'unique-string scan' : 'repeated-string scan', () => {
            let sum = 0; for (let i = 0; i < count; i++) sum += text.get(i).length; return sum;
          }, values.reduce((sum, value) => sum + value.length, 0)));
        }
        return { implementation, count, userAgent: navigator.userAgent, crossOriginIsolated, cases };
      }, implementation));
    } finally { await context.close(); }
  }
  return {
    method: 'Fresh browser context per implementation. 100000 values; five warmups and eleven samples. Shared lists use attached read-only snapshots. Primitive numeric data, 28 repeated messages, and 100000 unique messages are separate cases. All checksums checked. Construction and transport excluded; no task yields or DOM. These kernels expose trade-offs, not end-to-end results. Every sample retained.',
    results,
  };
}
