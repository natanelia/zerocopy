import { Arena, Snapshot, arenaOf, primitiveReadProtocol } from './arena';
import { SharedStack, stackReadProtocol } from './shared-stack';
import { SharedQueue, queueReadProtocol } from './shared-queue';

/** Internal to the codec: with native Arena kernels, encode receives only
 * numbers/booleans and does not invoke user callbacks. Generic values and overridden readers keep
 * the public peek/pop loop, including changes made during nested decoding.
 * Small sequences avoid the fixed cost of checking the reader descriptors.
 */
export function readReduxPrimitiveSequence<R>(kind: 'SharedStack' | 'SharedQueue',
  sequence: SharedStack<any> | SharedQueue<any>, encode: (value: number | boolean) => R, items: R[]): boolean {
  if (sequence.size < 32 || (sequence.valueType !== 'number' && sequence.valueType !== 'boolean')) return false;
  const reads = kind === 'SharedStack' ? stackReadProtocol : queueReadProtocol, prototype = reads.prototype;
  // Inspect descriptors rather than reading methods: an overridden getter must
  // still be called exactly once by the fallback, with its snapshot receiver.
  if (Object.getOwnPropertyDescriptor(prototype, 'peek')?.value !== reads.peek
    || Object.getOwnPropertyDescriptor(prototype, reads.nextName)?.value !== reads.next
    || Object.getOwnPropertyDescriptor(prototype, 'isEmpty')?.get !== reads.empty
    || Object.getPrototypeOf(prototype) !== Snapshot.prototype
    || Object.hasOwn(prototype, 'arena')
    || Object.getOwnPropertyDescriptor(Snapshot.prototype, 'arena')?.get !== primitiveReadProtocol.owner) return false;
  const arena = arenaOf(sequence);
  if (Object.getPrototypeOf(arena) !== Arena.prototype
    || Object.hasOwn(arena, 'decode') || Object.hasOwn(arena, 'dv') || Object.hasOwn(arena, 'refresh')
    || Object.getOwnPropertyDescriptor(Arena.prototype, 'decode')?.value !== primitiveReadProtocol.decode
    || Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')?.get !== primitiveReadProtocol.view
    || Object.getOwnPropertyDescriptor(Arena.prototype, 'refresh')?.value !== primitiveReadProtocol.refresh) return false;

  const isNumber = sequence.valueType === 'number';
  if (kind === 'SharedStack') {
    const stack = sequence as SharedStack<any>;
    // The first peek also preserves the constructor's explicitly cached top.
    let value = stack.peek() as number | boolean, head = stack.head;
    const view = arena.dv;
    for (let i = 0; i < stack.size; i++) {
      items.push(encode(value));
      // Preserve pop's reads even after the last value. In particular, codec
      // limits throw before the next node is touched, just as in the old loop.
      head = view.getUint32(head, true);
      const raw = head ? view.getFloat64(head + 8, true) : 0;
      value = isNumber ? raw : raw !== 0;
    }
  } else {
    const queue = sequence as SharedQueue<any>, end = queue.tail + queue.size;
    const tailStart = (end - 1) & ~31, view = arena.dv;
    for (let i = queue.tail; i < end; i++) {
      const raw = i >= tailStart ? view.getFloat64(queue.block + (i - tailStart) * 8, true)
        : arena.wasm.vecGet(queue.head, queue.depth, i);
      items.push(encode(isNumber ? raw : raw !== 0));
    }
  }
  return true;
}
