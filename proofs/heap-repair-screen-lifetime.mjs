// Owner-side control channel: lifetime records are persisted before browser work.
import assert from 'node:assert/strict';
import { readSync, writeSync } from 'node:fs';
const control = Number(process.env.HEAP_REPAIR_NATIVE_CONTROL_FD);
const ack = Number(process.env.HEAP_REPAIR_NATIVE_ACK_FD);
// These descriptors belong only to the Node owner, not the native browser's environment.
delete process.env.HEAP_REPAIR_NATIVE_CONTROL_FD;
delete process.env.HEAP_REPAIR_NATIVE_ACK_FD;
export function persistNativeCheckpoint(checkpoint, receipt) {
 assert(Number.isSafeInteger(control) && control >= 3 && Number.isSafeInteger(ack) && ack >= 3, 'Native lifetime supervisor is required');
 const bytes = Buffer.from(JSON.stringify({ kind: 'native-checkpoint', checkpoint, receipt }) + '\n');
 let offset = 0; while (offset < bytes.length) offset += writeSync(control, bytes, offset, bytes.length - offset);
 const pending = [], byte = Buffer.alloc(1);
 for (;;) { assert.equal(readSync(ack, byte, 0, 1, null), 1, 'Native supervisor closed before acknowledgement'); if (byte[0] === 10) break; pending.push(byte[0]); assert(pending.length < 1024); }
 assert.deepEqual(JSON.parse(Buffer.from(pending).toString()), { status: 'persisted', checkpoint });
 return receipt;
}
