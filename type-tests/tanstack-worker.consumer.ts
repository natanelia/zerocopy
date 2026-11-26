import { createCollection, createTransaction } from '@tanstack/db';
import { sharedCollectionConfig } from 'zerocopy/tanstack';
import { getWorkerData, initWorker } from 'zerocopy';

interface Lane { id: string; revision: number }
const options = sharedCollectionConfig<Lane>({ id: 'lanes' });
const lanes = createCollection(options);
const tx = createTransaction<Lane>({
  mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction),
});
tx.mutate(() => lanes.insert({ id: 'north', revision: 1 }));
const rows = options.getSnapshot();
const worker = await initWorker<{ rows: typeof rows }>(getWorkerData({ rows }));
const row = worker.rows.get('north');
const revision: number | undefined = row?.revision;
void revision;
if (row) {
  // @ts-expect-error A decoded snapshot row is immutable.
  row.revision = 2;
}
