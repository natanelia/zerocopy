import { test, expect } from 'vitest';
import * as S from './shared';


test('ordered iteration stays empty after the last deletion and handles re-insertion', async () => {
  const old = new S.SharedOrderedMap('number').set('old', 1);
  const empty = old.delete('old'), next = empty.set('new', 2);
  expect([...empty.entries()]).toEqual([]); expect([...old.entries()]).toEqual([['old', 1]]);
  expect([...next.entries()]).toEqual([['new', 2]]);
  const overwritten = next.set('new', 3);
  expect([...overwritten.entries()]).toEqual([['new', 3]]);
  const data = await S.initWorker<any>(S.getWorkerData({ empty, next, overwritten }));
  expect([...data.empty.entries()]).toEqual([]); expect([...data.next.entries()]).toEqual([['new', 2]]);
  expect([...data.overwritten.entries()]).toEqual([['new', 3]]);
  const set = new S.SharedOrderedSet().add('old').delete('old').add('new');
  expect([...set.values()]).toEqual(['new']);
});
