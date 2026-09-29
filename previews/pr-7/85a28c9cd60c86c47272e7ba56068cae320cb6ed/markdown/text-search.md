# Search shared text without decoding every row

A shared string is stored as UTF-8 bytes. Calling `get()` gives you a JavaScript string. That conversion is useful for display, but a filter usually needs only a yes-or-no answer.

Compile a literal search once. Test indices locally. Decode only the rows you need to display.

```ts
import { SharedList } from 'zerocopy';

const messages = new SharedList('string').pushMany([
  'Request completed',
  'Payment request timed out',
  'Background job completed',
]);

const contains = messages.compileTextSearch('REQUEST', {
  caseSensitive: false,
});

contains(0); // true
contains(1); // true
contains(2); // false

// Ordinary reads still work. Use them for the selected results.
messages.get(1); // 'Payment request timed out'
```

`compileTextSearch` is available only on string lists. Its result is a function that accepts a list index and returns a boolean. There is no worker message, Promise, dataset copy, or index build in a predicate call.

## The matching contract

Case-sensitive matching is the default. The predicate has the same result as `messages.get(index)?.includes(term) ?? false`.

With `caseSensitive: false`, it has the same result as `messages.get(index)?.toLowerCase().includes(term.toLowerCase()) ?? false`.

Search text is literal. It is not trimmed. Regular expressions, locale-specific collation, accent removal, and Unicode normalization are not applied. Invalid indices return false. An empty term matches each valid string, including an empty string. Passing non-string search text or calling this method on a non-string list throws `TypeError`.

The contract uses the decoded value returned by `get()`. As elsewhere in the library, encoding replaces unpaired UTF-16 surrogates with U+FFFD. A query containing a lone surrogate still follows JavaScript substring rules, including matching a surrogate half inside a valid pair.

## One predicate, one snapshot

A compiled predicate retains its immutable snapshot. Later appends, edits, resets, and memory growth do not change what it sees.

```ts
const before = new SharedList('string').push('Request completed');
const isTimeout = before.compileTextSearch('timeout');
const after = before.set(0, 'Request timeout');

isTimeout(0); // false: still reads before
const latestIsTimeout = after.compileTextSearch('timeout');
latestIsTimeout(0); // true
```

Compile a new predicate when the query or snapshot changes. Release old predicates when they are no longer needed; they retain the underlying arena. Predicate functions are not transferable. In a worker, first attach the shared state, then compile the search there. Read-only attachments support this operation without becoming writable.

## Performance boundaries

Needles up to 16 bytes use a scratch-free WASM scan with word-level candidate detection. A predicate lazily tests up to 16 adjacent values per WASM call and keeps only two bit masks for that half-leaf. This reduces call overhead during scans; sparse lookups may read up to 15 extra values. It does not build a dataset-wide index or cache matching records. Query words are passed as function arguments; readers never write search scratch into the owner's memory. Needles from 17 to 32 bytes use a bounded byte-skip search with masked four-byte comparisons. ASCII case-insensitive matches avoid creating JavaScript strings. Failed ASCII searches check for non-ASCII bytes before returning false: Unicode can lowercase to ASCII, such as the Kelvin sign becoming `k`.

Well-formed case-sensitive text can also use UTF-8 matching. Cases that need Unicode lowercase conversion or UTF-16 surrogate semantics use the existing JavaScript decoding path. Longer needles use a linear KMP scan. The search does not change the storage format or allocate writer scratch space.

State grows with the query, not with the dataset. There is no full decoded-string cache or stored answer for every row. This is a scan, not a full-text search engine. For repeated complex queries over very large datasets, consider a separate index and measure its construction and update cost too.

The website log explorer and comparison compile this predicate once per scan. Native arrays and Immutable.js retain their ordinary lowercase/includes path. All implementations keep the same filters, iteration order, cancellation checkpoints, and result checks. Compilation is included in query timing. See `proofs/text-search-performance.mjs` for the before/after browser proof, including unique text, misses, and Unicode data.
