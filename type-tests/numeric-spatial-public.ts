import { SharedList, getWorkerData, initWorker } from 'zerocopy';
import { countPointsInBox, type Bounds2D } from 'zerocopy/numeric';
const points = new SharedList('number').pushMany([0, 0, 1, 1]);
const bounds: Bounds2D = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
const count: number = countPointsInBox(points, bounds);
void count;
async function attached(): Promise<number> {
  const worker = await initWorker(getWorkerData({ points }));
  return countPointsInBox(worker.points, bounds);
}
void attached;
// @ts-expect-error String lists cannot contain binary numeric coordinates.
countPointsInBox(new SharedList('string'), bounds);
// @ts-expect-error All four numeric bounds are required.
countPointsInBox(points, { minX: 0, minY: 0, maxX: 1 });
// @ts-expect-error Bound types cannot be strings.
countPointsInBox(points, { ...bounds, minX: '0' });
