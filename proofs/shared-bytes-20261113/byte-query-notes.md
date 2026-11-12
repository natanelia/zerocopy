# Shared-byte object predicates: exploratory prototype

## What the prototype does

`byte-query.mjs` exports three query compilers:

```js
const isBooks = compileJsonFieldEquals('category', 'books');
const revision = compileJsonNumberField('revision');
const inRange = compileJsonFieldNumberRange('revision', 10, 20); // inclusive

isBooks(bytes, start, end); // boolean
revision(bytes, start, end); // number | undefined
inRange(bytes, start, end); // boolean
```

`start` defaults to zero and `end` to `bytes.length`; `end` is exclusive. A caller
can pass one arena view plus record offsets without creating a `subarray` view
for every row. Query compilation encodes the requested key and equality value
once. The predicate skips unrelated fields using JSON structure, so quoted text,
nested keys, brackets inside strings, and escaped quotes cannot masquerade as a
top-level field.

Equality examines the scalar's stored representation. Canonical values can be
compared directly against query bytes. Alternate JSON string escapes are compared
as UTF-16 code units without constructing a string. Numeric projection parses
safe integer tokens into a number directly; decimals, exponents and large integer
tokens use a temporary string for native `Number` conversion and correct rounding.
The numeric fallback is deliberately narrow: it converts the selected token,
not the entire JSON document.

None of these operations constructs a record object, recursively freezes a tree,
keeps a decoded dataset, or builds a row index. A caller that needs only an answer,
count or numeric aggregate can stop here. A caller that wants to display selected
rows still calls the ordinary reader for those rows and pays its existing decode,
parse and freeze cost.

## Exact contract

This experiment consumes immutable UTF-8 records produced by the current writer's
`JSON.stringify(value)` with no replacer or indentation. Top-level object keys
therefore have canonical spellings and are unique. Returning on the first matching
key is correct for those records and lets an early field avoid the rest of the row.

`JSON.rawJSON` scalar values are supported. They can supply alternate string
escapes, number spellings, overflowing numbers, and underflowing numbers. They
cannot inject an object, array or duplicate outer key. The prototype checks string
semantics and native number conversion when canonical token comparison is not
enough. For example, raw `"\\u0062ooks"` compares equal to `"books"`, `1e0` to `1`,
and `1e400` to positive infinity, matching the existing `JSON.parse` path. If a raw
JSON string contains a literal unpaired surrogate, the current writer's
`TextEncoder` replacement happens first; the reference is the decoded stored
bytes, not the original pre-encoding string.

Arrays and primitive root values have no eligible object fields. Missing fields
are distinct from present nulls. Equality uses strict scalar equality; it does
not coerce types, normalize Unicode, fold case, or consult object prototypes.
Numeric ranges are inclusive and accept infinities but reject NaN bounds.

This is **not** an arbitrary JSON parser or input validator. It does not accept
hand-written outer JSON with whitespace, alternate key escapes or duplicate keys.
Such input would require broader parsing and last-key-wins semantics, removing
the safe early return. It also assumes callers keep records immutable and supply
valid in-bounds record offsets. These restrictions must not silently become a new
public API contract if the library currently accepts wider input through an
extension point or an overridden global serializer.

## Where it helps, and where it does not

The favorable workload is a selective operation such as “count objects whose
category is books” or “sum revisions” where the needed field occurs early and
the remainder contains large strings, nested objects or coordinate arrays. It
avoids decoding and constructing content that the operation never needs.

A late field still requires scanning all preceding bytes. A missing field requires
scanning the whole record. There is no constant-time field access and no claim
that a JavaScript byte scan always beats the native parser. Repeated queries
against already cached objects are a different regime: reading a JavaScript
property may beat rescanning bytes. Measure early, late, missing and cached cases
separately, with realistic match selectivity and output materialization costs.

This cannot transparently accelerate the same `.get(key)` operation while keeping
its ordinary, fully materialized, deeply frozen object result. An opaque callback
such as `row => row.category === 'books'` also does not tell the library which bytes
it can skip. A practical integration would use an explicit compiled field query,
projection or aggregate that resolves a key to a raw record address internally.
The snapshot's root and arena lifetime must be retained exactly as the existing
compiled text predicate does. It must continue to work on read-only worker
attachments and after later writer updates or memory growth.

No writer-side index or new record format is needed for this experiment, so it
does not shift an indexing cost into construction. If repeated queries need fast
arbitrary field access, a schema or offset directory could avoid rescanning, but
its write cost, memory size, snapshot handling and update behavior would need a
separate measured design. Such an index is a different experiment.

## What ZeroCopy already has

`text-search.ts` and `SharedList.compileTextSearch` already do the analogous work
for string lists: compile once, scan shared bytes, decode only when necessary.
Short terms use WASM scanning, with special handling for ASCII case folding and
fallbacks for Unicode lowercase and UTF-16 surrogate semantics. The existing
`docs/text-search.md` explicitly documents immutable snapshot capture and the
difference between a scan and an index. This prototype extends the *idea* to
selected fields inside the current JSON object representation; it is not a new
replacement for that existing string search.

## Correctness checks

Run `node proofs/shared-bytes-20261113/byte-query-checks.mjs`.

On Node 24 with `JSON.rawJSON` available, the suite passes 90,576 differential
assertions. It compares results with `JSON.parse(TextDecoder.decode(storedBytes))`
on both ordinary and shared buffers, using nonzero record offsets and hostile
bytes outside each record. Coverage includes early/late/missing fields, nested
lookalikes, escaped property names, `__proto__`, Unicode, lone surrogates,
supplementary characters, null/boolean/type distinctions, fractional/exponent
numbers, numeric boundaries, raw scalar spellings, and deterministic varied trees.
Contiguous signed integers near `Number.MAX_SAFE_INTEGER` protect against a subtle
temporary rounding bug when accumulating an ASCII digit before subtracting 48.

This is evidence for the prototype's bounded contract, not a claim of production
readiness or a substitute for broader snapshot/transport testing during integration.
