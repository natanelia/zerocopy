import { createCollection, createTransaction } from '@tanstack/db';
import { expect, it } from 'vitest';
import { sharedCollectionConfig } from './tanstack-db-collection.ts';

type Lane = { id: string; revision: number };
const first: Lane = { id: 'north', revision: 0 };

it('publishes confirmed transactions and keeps older worker snapshots readable', async () => {
  const options = sharedCollectionConfig({ id: 'lanes', initialData: [first] });
  const lanes = createCollection(options);
  const observer = lanes.subscribeChanges(() => {});
  try {
    await lanes.preload();
    const initial = options.getSnapshot();
    const tx = createTransaction<Lane>({
      autoCommit: false,
      mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction),
    });
    tx.mutate(() => {
      lanes.update('north', row => { row.revision++; });
      lanes.insert({ id: 'south', revision: 1 });
    });
    expect(lanes.get('north')?.revision).toBe(1);
    expect(options.getSnapshot()).toBe(initial);
    await tx.commit();
    expect(options.getSnapshot().get('north')).toEqual({ ...first, revision: 1 });
    expect(options.getSnapshot().size).toBe(2);
    expect(initial.size).toBe(1);
    expect(initial.get('north')).toEqual(first);

    const committed = options.getSnapshot();
    const rejected = createTransaction({
      autoCommit: false,
      mutationFn: async () => { throw new Error('Invalid geometry'); },
    });
    rejected.mutate(() => lanes.delete('south'));
    expect(lanes.has('south')).toBe(false);
    await expect(rejected.commit()).rejects.toThrow('Invalid geometry');
    expect(lanes.has('south')).toBe(true);
    expect(options.getSnapshot()).toBe(committed);

    await lanes.delete('south').isPersisted.promise;
    expect(options.getSnapshot().has('south')).toBe(false);
    await lanes.cleanup();
    await lanes.preload();
    expect(lanes.get('north')?.revision).toBe(1);
    expect(lanes.has('south')).toBe(false);
  } finally {
    observer.unsubscribe();
    await lanes.cleanup();
  }
});

it('uses the same custom string key for automatic writes and worker reads', async () => {
  const config = sharedCollectionConfig<Lane & { slug: string }>({ id: 'keyed', primaryKey: 'slug' });
  const lanes = createCollection(config);
  try {
    await lanes.preload();
    await lanes.insert({ ...first, slug: '' }).isPersisted.promise;
    await lanes.update('', row => { row.revision = 2; }).isPersisted.promise;
    expect(config.getSnapshot().get('')).toEqual({ ...first, slug: '', revision: 2 });
    await lanes.delete('').isPersisted.promise;
    expect(config.getSnapshot().size).toBe(0);
  } finally { await lanes.cleanup(); }
});

it('rejects a batch before opening sync when a later shared value cannot be encoded', async () => {
  type Row = Lane & { data?: unknown };
  const options = sharedCollectionConfig<Row>({ id: 'failure', initialData: [first] });
  let begins = 0;
  options.sync.sync({ begin: () => { begins++; }, write() {}, commit() {}, markReady() {} });
  const initial = options.getSnapshot();
  await expect(options.utils.acceptMutations({ mutations: [
    { type: 'update', modified: { ...first, revision: 1 } },
    { type: 'insert', modified: { id: 'south', revision: 1, data: 1n } },
  ] })).rejects.toThrow();
  expect(begins).toBe(1);
  expect(options.getSnapshot()).toBe(initial);
  await options.utils.acceptMutations({ mutations: [{ type: 'delete', modified: first }] });
  expect(options.getSnapshot().size).toBe(0);
});

it('never installs a delayed commit into a replacement sync connection', async () => {
  const options = sharedCollectionConfig<Lane>({ id: 'reconnect' });
  let release!: () => void, entered!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const close = options.sync.sync({
    begin() {}, write() {}, markReady() {},
    commit() { entered(); return new Promise<void>(resolve => { release = resolve; }); },
  });
  const result = options.utils.acceptMutations({ mutations: [{ type: 'insert', modified: first }] });
  await called;
  close();
  options.sync.sync({ begin() {}, write() {}, markReady() {}, commit() {} });
  release();
  await expect(result).rejects.toThrow('ended during confirmation');
  expect(options.getSnapshot().size).toBe(0);
});

it('reports a rejected initial commit and can retry from its initial rows', async () => {
  const options = sharedCollectionConfig({ id: 'startup', initialData: [first] });
  const error = new Error('Initial write rejected');
  let fail!: (error: unknown) => void;
  const failed = new Promise(resolve => { fail = resolve; });
  options.sync.sync({
    begin() {}, write() {}, commit: () => Promise.reject(error),
    markReady() { throw new Error('Premature readiness'); }, markError: fail,
  });
  expect(await failed).toBe(error);
  expect(options.getSnapshot().size).toBe(0);
  options.sync.sync({ begin() {}, write() {}, commit() {}, markReady() {} });
  expect(options.getSnapshot().get('north')).toEqual(first);
});

it('confirms changed fields without copying another optimistic edit into shared storage', async () => {
  const original = { ...first, direction: 'east' };
  const config = sharedCollectionConfig({ id: 'overlap', initialData: [original] });
  const lanes = createCollection(config);
  try {
    await lanes.preload();
    const draft = createTransaction({ autoCommit: false, mutationFn: async () => {} });
    draft.mutate(() => lanes.update('north', row => { row.direction = 'west'; }));
    await lanes.update('north', row => { row.revision++; }).isPersisted.promise;
    expect(config.getSnapshot().get('north')).toEqual({ ...original, revision: 1 });
    draft.rollback();
    expect(lanes.get('north')).toMatchObject({ ...original, revision: 1 });
  } finally { await lanes.cleanup(); }
});

it('serializes queued confirmations and allows retrying an unaccepted batch', async () => {
  const config = sharedCollectionConfig<Lane>({ id: 'queue' });
  const failure = new Error('First commit failed');
  let count = 0;
  config.sync.sync({
    begin() {}, write() {}, markReady() {},
    commit() { if (++count === 1) return Promise.reject(failure); },
  });
  const insert = { mutations: [{ type: 'insert' as const, modified: first }] };
  const second = { mutations: [{ type: 'insert' as const, modified: { id: 'south', revision: 1 } }] };
  const a = config.utils.acceptMutations(insert);
  const b = config.utils.acceptMutations(second);
  expect(config.utils.acceptMutations(second)).toBe(b);
  await expect(a).rejects.toBe(failure);
  await b;
  expect(config.getSnapshot().has('north')).toBe(false);
  await config.utils.acceptMutations(insert);
  expect(config.getSnapshot().size).toBe(2);
  expect(count).toBe(3);
});

it('recovers when a sync write throws halfway through a multi-row transaction', async () => {
  const options = sharedCollectionConfig<Lane>({ id: 'failed-write' });
  let reject = true;
  const lanes = createCollection({
    ...options, sync: { ...options.sync, sync: params => options.sync.sync({
      ...params, write: msg => {
        if (reject && msg.value?.id === 'bad') { reject = false; throw new Error('Invalid sync row'); }
        params.write(msg);
      },
    }) },
  });
  try {
    await lanes.preload();
    await expect(lanes.insert([first, { id: 'bad', revision: 0 }]).isPersisted.promise).rejects.toThrow();
    await lanes.insert({ id: 'good', revision: 1 }).isPersisted.promise;
    expect([...lanes.keys()]).toEqual(['good']);
    await lanes.insert({ ...first, revision: 2 }).isPersisted.promise;
    expect(lanes.get('north')?.revision).toBe(2);
    expect(options.getSnapshot().get('north')?.revision).toBe(2);
  } finally { await lanes.cleanup(); }
});
