import { SharedList, getWorkerData, initWorker } from 'zerocopy';
import { countInRange } from 'zerocopy/numeric';
const list = new SharedList('number').pushMany([1, 2, 3]);
const count: number = countInRange(list, 1, 2);
void count;
async function workerTypes(): Promise<number> {
  const data = getWorkerData({ list });
  const worker = await initWorker(data);
  return countInRange(worker.list, -Infinity, Infinity);
}
void workerTypes;
// @ts-expect-error A list of strings is not a numeric list.
countInRange(new SharedList('string'), 1, 2);
// @ts-expect-error Bounds must be numbers.
countInRange(list, '1', 2);
// @ts-expect-error JSON-backed records are not numeric storage.
countInRange(new SharedList('object'), 1, 2);
