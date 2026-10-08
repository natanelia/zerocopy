import { expect, it } from 'vitest';
import * as api from './shared';
import { runScanChecks } from './proofs/primitive-scan-checks.mjs';

// The runtime proof jobs run these same checks against built public bundles.
it('preserves scan byte order, view reuse and snapshot lifetimes', async () => {
  expect((await runScanChecks(api)).count).toBeGreaterThan(20);
});
