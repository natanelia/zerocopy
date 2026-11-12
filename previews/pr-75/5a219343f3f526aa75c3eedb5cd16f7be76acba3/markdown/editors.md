# Editors & history

Background validation should not force the user to stop editing. Immutable snapshots give a calculation a stable view while newer edits create new versions.

This is an application design pattern. Zerocopy does not supply an editor, undo manager, or collaboration protocol.

## Keep the version a calculation needs

A collection update returns a new handle:

```ts
import { SharedMap } from 'zerocopy';

const before = new SharedMap('string').set('document-1', 'Draft title');
const after = before.set('document-1', 'Updated title');

before.get('document-1'); // 'Draft title'
after.get('document-1'); // 'Updated title'
```

A worker holding the earlier snapshot can complete its check. The owner can keep editing. The [playground](../README.md#playground) makes this visible with actual shared memory.

## Make stale results explicit

The result of a background check can be correct for an old version and wrong for the current document. Store an application revision with the request. Reject, re-run, or reconcile a result when its inputs changed.

Cancellation helps avoid unwanted work, but it does not roll back side effects. A worker running synchronous JavaScript must yield to its event loop before it can process a cancel message.

For an existing Redux application, retain the store as the owner. Select only shared collections for worker publication. See the [Redux guide](../../docs/redux.md) and [source adapters](../../docs/worker-sessions.md#redux-and-other-stores).

## Budget the history

Retaining one small handle can retain its arena. Append-only allocation does not reclaim each unreachable node. An unlimited undo history can therefore keep memory alive.

Choose a history limit. Compact at a controlled application boundary. Release references from histories, workers, caches, and transport payloads. Compaction creates new backing storage and temporarily keeps the old storage too.

See [memory and ownership](../../docs/architecture.md) before treating immutable handles like free snapshots.

## Keep collaboration separate

Multiple users editing one document need conflict handling. Shared memory does not supply conflict-free replication or a multi-writer allocator. Keep one owner for each writable arena and define how external edits become owner commands.

Use zerocopy for local shared reads where it fits. Keep your collaboration and persistence mechanisms explicit.
