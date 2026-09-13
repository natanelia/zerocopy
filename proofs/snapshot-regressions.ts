/** Run unchanged against the pinned base and candidate to expose snapshot failures. */
import { SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedStack, SharedMap, resetQueue, resetLinkedList, resetDoublyLinkedList, resetOrderedMap, resetStack, resetMap } from '../shared';
import { isDeepStrictEqual } from 'node:util';
const cases: { name: string; expected: unknown; actual: unknown; passed: boolean }[] = [];
function record(name: string, expected: unknown, actual: unknown) { cases.push({ name, expected, actual, passed: isDeepStrictEqual(actual, expected) }); }
resetQueue(); const q = new SharedQueue('number').enqueue(1), qLeft = q.enqueue(2); q.enqueue(3);
record('queue fork keeps its own next item', 2, qLeft.dequeue().peek());
resetLinkedList(); const l = new SharedLinkedList('number').append(1), lLeft = l.append(2); l.append(3);
record('linked list fork keeps its own successor', [1, 2], lLeft.toArray());
resetDoublyLinkedList(); const d = new SharedDoublyLinkedList('number').append(1), dLeft = d.append(2); d.append(3);
record('doubly linked list fork keeps its own successor', [1, 2], dLeft.toArray());
resetOrderedMap(); const m = new SharedOrderedMap('number').set('a', 1), mLeft = m.set('b', 2); m.set('c', 3);
record('ordered map fork keeps its own insertion order', [['a', 1], ['b', 2]], [...mLeft.entries()]);
resetStack(); const input = { nested: { value: 1 } }, stack = new SharedStack('object').push(input); input.nested.value = 99;
record('stack does not retain a mutable caller object', 1, (stack.peek() as any).nested.value);
resetMap(); const map = new SharedMap('object').set('a', { nested: { value: 1 } });
Reflect.set((map.get('a') as any).nested, 'value', 99);
record('cached map values are deeply immutable', 1, (map.get('a') as any).nested.value);
console.log(JSON.stringify({ label: process.env.LABEL, cases }));
if (process.env.EXPECT_PASS === '1' && cases.some(c => !c.passed)) process.exitCode = 1;
