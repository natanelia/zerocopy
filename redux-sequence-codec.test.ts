import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedStack, SharedQueue, SharedList, getWorkerData, initWorker, resetQueue, resetStack } from './shared';
import { createZerocopyCodec } from './redux';

const codec = createZerocopyCodec();
const kinds = ['SharedStack', 'SharedQueue'] as const;
type Kind = typeof kinds[number];
const prototypes = { SharedStack: SharedStack.prototype, SharedQueue: SharedQueue.prototype };
const nextNames = { SharedStack: 'pop', SharedQueue: 'dequeue' } as const;

function make(kind: Kind, type: string, values: any[], drop = 0, arena = new Arena()): any {
  let sequence: any = kind === 'SharedStack' ? new SharedStack(type, 0, 0, undefined, arena)
    : new SharedQueue(type, 0, 0, 0, undefined, arena);
  for (const value of values) sequence = kind === 'SharedStack' ? sequence.push(value) : sequence.enqueue(value);
  for (let i = 0; i < drop; i++) sequence = sequence[nextNames[kind]]();
  return sequence;
}
function ordered(kind: Kind, values: any[], drop = 0): any[] {
  return (kind === 'SharedStack' ? [...values].reverse() : values).slice(drop);
}
function numberTag(value: number | boolean | string): any {
  if (typeof value !== 'number') return value;
  if (Number.isNaN(value)) return ['n', 'NaN'];
  if (!Number.isFinite(value)) return ['n', value > 0 ? 'Infinity' : '-Infinity'];
  return Object.is(value, -0) ? ['n', '-0'] : value;
}
function envelope(kind: Kind, type: string, values: any[]): any {
  return { $zerocopyRedux: 1, value: ['c', kind, type, null, values.map(numberTag)] };
}
function patch(object: object, name: string, descriptor: PropertyDescriptor, run: () => void): void {
  const old = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
  try { run(); }
  finally { if (old) Object.defineProperty(object, name, old); else Reflect.deleteProperty(object, name); }
}

describe('portable Redux primitive stack and queue reads', () => {
  for (const kind of kinds) {
    it(`${kind}: preserves empty, small, block-boundary and deep-tree numeric values`, () => {
      for (const count of [0, 1, 8, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 32769]) {
        const values = Array.from({ length: count }, (_, i) => i - 19.25);
        const source = make(kind, 'number', values), expected = envelope(kind, 'number', ordered(kind, values));
        assert.deepEqual(codec.encode(source), expected);
        assert.equal(codec.stringify(source), JSON.stringify(expected));
        assert.ok(Object.isFrozen(source)); assert.equal(source.size, count);
      }
    });

    it(`${kind}: preserves booleans and exact special-number tags`, () => {
      const numbers = Array.from({ length: 96 }, (_, i) => [NaN, -0, 0, Infinity, -Infinity, 0.5, -42][i % 7]);
      const booleans = Array.from({ length: 96 }, (_, i) => i % 3 === 0);
      for (const [type, values] of [['number', numbers], ['boolean', booleans]] as const) {
        const source = make(kind, type, values), expected = envelope(kind, type, ordered(kind, values));
        assert.deepEqual(codec.encode(source), expected);
        const restored: any = codec.parse(codec.stringify(source));
        assert.deepEqual(codec.encode(restored), expected);
        assert.notEqual(arenaOf(restored), arenaOf(source));
      }
    });

    it(`${kind}: keeps old roots, removed prefixes, forks and arena bytes unchanged`, () => {
      const values = Array.from({ length: 4097 }, (_, i) => i * 3);
      const source = make(kind, 'number', values, 1057), arena = arenaOf(source);
      const fork = kind === 'SharedStack' ? source.push(-1) : source.enqueue(-1);
      const used = arena.used, bytes = arena.buf.slice(0, used), descriptor = source.toWorkerData();
      assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values, 1057)));
      const expectedFork = kind === 'SharedStack' ? [-1, ...ordered(kind, values, 1057)] : [...ordered(kind, values, 1057), -1];
      assert.deepEqual(codec.encode(fork), envelope(kind, 'number', expectedFork));
      resetStack(); resetQueue();
      arena.memory.grow(2);
      assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values, 1057)));
      assert.equal(arena.used, used); assert.deepEqual(arena.buf.subarray(0, used), bytes);
      assert.deepEqual(source.toWorkerData(), descriptor);
    });

    it(`${kind}: preserves collection, node, depth and text budgets`, () => {
      const source = make(kind, 'number', Array.from({ length: 65 }, (_, i) => i));
      for (const limited of [
        createZerocopyCodec({ maxCollectionSize: 64 }), createZerocopyCodec({ maxNodes: 65 }),
        createZerocopyCodec({ maxTextLength: 2 }),
      ]) assert.throws(() => limited.stringify(source), RangeError);
      assert.deepEqual(createZerocopyCodec({ maxNodes: 66, maxDepth: 1 }).encode(source), codec.encode(source));
      assert.throws(() => createZerocopyCodec({ maxDepth: 1 }).encode({ source }), /codec limit/);
      assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, Array.from({ length: 65 }, (_, i) => i))));
    });

    it(`${kind}: keeps strings, JSON and nested collections on the generic path`, () => {
      const strings = Array.from({ length: 40 }, (_, i) => `${i}\0🙂\ufeff`);
      assert.deepEqual(codec.encode(make(kind, 'string', strings)), envelope(kind, 'string', ordered(kind, strings)));
      const objects = Array.from({ length: 40 }, (_, i) => ({ id: i, child: [false, { text: '🙂' }] }));
      const objectSource = make(kind, 'object', objects);
      const objectExpected = ordered(kind, objects).map(value => ['o', [['id', value.id], ['child', ['a', [false, ['o', [['text', '🙂']]]]]]]]);
      assert.deepEqual(codec.encode(objectSource), { $zerocopyRedux: 1, value: ['c', kind, 'object', null, objectExpected] });
      assert.ok(Object.isFrozen(objectSource.peek().child[1]));
      const children = Array.from({ length: 40 }, (_, i) => new SharedList('number').push(i));
      const nested = make(kind, 'SharedList<number>', children);
      const childExpected = ordered(kind, Array.from({ length: 40 }, (_, i) => i)).map(i => ['c', 'SharedList', 'number', null, [i]]);
      assert.deepEqual(codec.encode(nested), { $zerocopyRedux: 1, value: ['c', kind, 'SharedList<number>', null, childExpected] });
    });

    it(`${kind}: honors overridden methods, getters and original snapshot receivers`, () => {
      const values = Array.from({ length: 40 }, (_, i) => i), source = make(kind, 'number', values);
      const prototype = prototypes[kind], originalPeek = prototype.peek, originalNext = prototype[nextNames[kind]];
      let reads = 0, advances = 0, checks = 0;
      const peek = function (this: any) {
        assert.ok(Object.isFrozen(this)); return Reflect.apply(originalPeek, this, []) as number + 100;
      };
      Object.defineProperty(peek, 'call', { value() { throw new Error('must not invoke .call'); } });
      patch(prototype, 'peek', { get() { reads++; assert.ok(Object.isFrozen(this)); return peek; } }, () => {
        patch(prototype, nextNames[kind], { get() {
          advances++; assert.ok(Object.isFrozen(this)); return originalNext;
        } }, () => {
          patch(prototype, 'isEmpty', { get() { checks++; assert.ok(Object.isFrozen(this)); return (this as any).size < 5; } }, () => {
            assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values).slice(0, 36).map(value => value + 100)));
          });
        });
      });
      assert.equal(reads, 36); assert.equal(advances, 36); assert.equal(checks, 37);
      assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values)));
    });

    it(`${kind}: does not call overridden reader getters for an empty sequence`, () => {
      const source = make(kind, 'number', []), error = new Error('empty must not read');
      patch(prototypes[kind], 'peek', { get() { throw error; } }, () => {
        patch(prototypes[kind], nextNames[kind], { get() { throw error; } }, () => {
          assert.deepEqual(codec.encode(source), envelope(kind, 'number', []));
        });
      });
    });

    it(`${kind}: propagates exact reader errors and does not advance after a codec error`, () => {
      const source = make(kind, 'number', Array.from({ length: 40 }, (_, i) => i));
      const prototype = prototypes[kind], error = new Error('read stopped');
      for (const name of ['isEmpty', 'peek', nextNames[kind]]) {
        patch(prototype, name, { get() { throw error; } }, () => {
          assert.throws(() => codec.encode(source), thrown => thrown === error);
        });
      }
      let advances = 0, reads = 0;
      const next = prototype[nextNames[kind]], peek = prototype.peek;
      patch(prototype, nextNames[kind], { value: function (this: any) { advances++; return Reflect.apply(next, this, []); } }, () => {
        patch(prototype, 'peek', { value: function (this: any) { reads++; return Reflect.apply(peek, this, []); } }, () => {
          assert.throws(() => createZerocopyCodec({ maxNodes: 2 }).encode(source), /codec limit/);
        });
      });
      assert.equal(reads, 2); assert.equal(advances, 1);
    });

    it(`${kind}: preserves instance and prototype decoder overrides without extra getter calls`, () => {
      const values = Array.from({ length: 40 }, (_, i) => i), source = make(kind, 'number', values), arena = arenaOf(source);
      const native = Arena.prototype.decode;
      let reads = 0;
      const decode = function (this: Arena, type: string, raw: number) {
        assert.equal(this, arena); return Reflect.apply(native, this, [type, raw]) + 10;
      };
      patch(arena, 'decode', { get() { reads++; assert.equal(this, arena); return decode; } }, () => {
        assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values).map(value => value + 10)));
      });
      assert.equal(reads, 40);
      patch(Arena.prototype, 'decode', { value: decode }, () => {
        assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values).map(value => value + 10)));
      });
    });

    it(`${kind}: permits decoder reentry, growth and changing a reader during the scan`, () => {
      const values = Array.from({ length: 40 }, (_, i) => i), source = make(kind, 'number', values), arena = arenaOf(source);
      const prototype = prototypes[kind], originalPeek = prototype.peek, decode = arena.decode;
      let first = true;
      const nextPeek = function (this: any) { return Reflect.apply(originalPeek, this, []) as number + 1000; };
      patch(arena, 'decode', { value: function (this: Arena, type: string, raw: number) {
        if (first) {
          first = false; const oldBuffer = arena.memory.buffer; arena.memory.grow(2);
          assert.notEqual(arena.memory.buffer, oldBuffer);
          assert.deepEqual(codec.encode(new SharedList('number').push(7)).value, ['c', 'SharedList', 'number', null, [7]]);
          Object.defineProperty(prototype, 'peek', { value: nextPeek, configurable: true, writable: true });
        }
        return Reflect.apply(decode, this, [type, raw]);
      } }, () => {
        const old = Object.getOwnPropertyDescriptor(prototype, 'peek')!;
        try {
          const expected = ordered(kind, values); expected.splice(1, expected.length - 1, ...expected.slice(1).map(value => value + 1000));
          assert.deepEqual(codec.encode(source), envelope(kind, 'number', expected));
        } finally { Object.defineProperty(prototype, 'peek', old); }
      });
      assert.ok(!first); assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values)));
    });

    it(`${kind}: respects a custom Arena subclass`, () => {
      class CustomArena extends Arena {
        decode(type: string, raw: number): any { return type === 'number' ? raw + 1 : super.decode(type, raw); }
      }
      const values = Array.from({ length: 40 }, (_, i) => i);
      const source = make(kind, 'number', values, 0, new CustomArena());
      assert.deepEqual(codec.encode(source), envelope(kind, 'number', ordered(kind, values).map(value => value + 1)));
    });

    for (const copy of [false, true]) {
      it(`${kind}: serializes ${copy ? 'copied' : 'shared'} read-only worker attachments`, async () => {
        const values = Array.from({ length: 2049 }, (_, i) => i / 3), source = make(kind, 'number', values, 1057);
        const { sequence } = await initWorker(getWorkerData({ sequence: source }, { copy }));
        const arena = arenaOf(sequence), used = arena.used, before = arena.buf.slice(0, used);
        assert.ok(arena.readOnly);
        assert.deepEqual(codec.encode(sequence), envelope(kind, 'number', ordered(kind, values, 1057)));
        assert.equal(arena.used, used); assert.deepEqual(arena.buf.subarray(0, used), before);
        assert.throws(() => kind === 'SharedStack' ? (sequence as any).push(0) : (sequence as any).enqueue(0), /read-only/);
      });
    }
  }

  it('keeps the explicitly cached initial stack top', () => {
    const values = Array.from({ length: 40 }, (_, i) => i), source = make('SharedStack', 'number', values), arena = arenaOf(source);
    const withTop = new SharedStack('number', source.head, source.size, undefined, arena, -123);
    assert.deepEqual(codec.encode(withTop), envelope('SharedStack', 'number', [-123, ...values.slice(0, -1).reverse()]));
  });

  it('keeps queue read offsets around every block boundary', () => {
    const values = Array.from({ length: 2200 }, (_, i) => i);
    for (const drop of [1, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 2168]) {
      assert.deepEqual(codec.encode(make('SharedQueue', 'number', values, drop)), envelope('SharedQueue', 'number', values.slice(drop)));
    }
  });
});
