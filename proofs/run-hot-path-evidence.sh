#!/usr/bin/env bash
set -euo pipefail
mkdir -p proofs/results/hot-path proofs/results/cold-build
export SOURCE_COMMIT="$(git rev-parse HEAD)"
for round in 1 2 3; do
  # Persistent operations in an existing arena; fresh arena setup stays outside
  # the timer. The cold-build comparison below includes that cost explicitly.
  ROUND="$round" SAMPLES=15 INCLUDE_ARENA_SETUP=0 bun proofs/readme-libraries.ts "proofs/results/hot-path/readme-libraries-round-$round.json"
  ROUND="$round" SAMPLES=15 INCLUDE_ARENA_SETUP=1 CASE_FILTER='SharedMap:set,SharedList:push,SharedStack:push,SharedQueue:enqueue,SharedLinkedList:append,SharedLinkedList:prepend,SharedDoublyLinkedList:append,SharedDoublyLinkedList:prepend,SharedOrderedMap:set,SharedSortedMap:set' bun proofs/readme-libraries.ts "proofs/results/cold-build/readme-libraries-round-$round.json"
  ROUND="$round" SAMPLES=15 bun proofs/hot-path-workloads.ts "proofs/results/hot-path/workloads-$round.json"
done
node proofs/summarize-readme-libraries.mjs proofs/results/hot-path
node proofs/summarize-readme-libraries.mjs proofs/results/cold-build
node proofs/library-memory.mjs proofs/results/hot-path/library-memory.json
node proofs/node-worker.mjs > proofs/results/hot-path/node-worker.json
