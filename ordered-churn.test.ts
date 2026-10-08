import { test, expect } from 'vitest';
import * as S from './shared';
import { runChurnChecks, runChurnMechanism } from './proofs/ordered-churn-checks.mjs';

test('ordered scans preserve snapshots, values and descriptor behavior across the adaptive boundary', async () => {
  expect((await runChurnChecks(S)).length).toBeGreaterThan(60);
}, 30000);

test('history-independent traversal and live-sized temporary pointer storage after heavy churn', () => {
  expect(runChurnMechanism(S, true).length).toBe(15);
}, 30000);
