# Synchronous block callback traversal: initial screen

Fixed baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.
The candidate adds an Arena block visitor and changes only linked/doubly-linked
callback consumers. `Arena.blocks`, SharedList, WASM kernels and bulk append
remain unchanged. The historical block-traversal improvement already captures
one DataView; this candidate removes per-value generator advancement from the
synchronous public callback path. Each block visitor passes its existing view,
data pointer and length, and wrappers call the user once for every value.

The initial screen uses the following fixed ten cases. It is a screening run,
not final confirmation. Keep all observations and unsuccessful versions.

| Case | Collection | Type | Size | Operation | Role |
| --- | --- | --- | ---: | --- | --- |
| linked-empty | Linked | number | 0 | forEach | Empty control |
| linked-tail | Linked | number | 32 | forEach | Tail-only control |
| linked-first-block | Linked | number | 33 | forEach | First block boundary |
| linked-large | Linked | number | 65,537 | forEach | Main traversal target |
| doubly-forward | Doubly | number | 4,097 | forEach | Forward second wrapper |
| doubly-reverse | Doubly | boolean | 4,097 | forEachReverse | Reverse and primitive type |
| string-uncached | Linked | string | 4,097 | forEach | Exceeds 2,048-entry decode cache |
| object-uncached | Doubly | object | 4,097 | forEachReverse | JSON fallback |
| edited-array | Linked | number | 4,097 | toArray | Edited variable-length blocks, downstream consumer |
| unchanged-values | SharedList | number | 4,097 | values | Unchanged public generator control |

Both engines use the built portable bundle in separate fresh processes: one
build and workload per process, at the same neutral import path with all chunks
replaced. Use two balanced process pairs per runtime/case, seven measured
batches per process and common repetitions/warm-up counts selected in disposable
calibration. Calibration and measured warm-up both use the eventual repeated
scan shape; record their actual timed durations. CPU 2 and the common `perf.lock`
serialize every heavy command. Fixture construction is outside timing.

Each callback scan writes every value and callback index to prepared output
arrays, then every operation's full arrays are checked after timing. Array
materialization retains and checks every returned array. The unchanged generator
is fully consumed and its output retained. This is not a count-only benchmark.
Normal callback output preparation and validation stay outside timing; library
array materialization remains inside. No shared allocation is permitted during
these read-only operations. Scans reuse one immutable fixture with normal
bounded decode caches; string/JSON cases are not wholly cached.

After the complete screen, retain the whole table and choose any additional
controls or longer study before measuring them. Do not edit old evidence.
