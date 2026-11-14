# Guarded property assignment experiment

This variant copies the existing `proofs/shared-bytes-20261113/direct-json.mjs`
parser and changes only container bookkeeping and property insertion. It is an
experiment, not a production decoder.

The earlier parser calls `Object.defineProperty` for every object property and
every array index. The variant assigns fresh keys directly when the container
has an ordinary prototype chain and `key in container` is false. Existing or
inherited names keep the original `Object.defineProperty` path. This preserves
own-property behavior for `__proto__`, inherited setters, inherited read-only
properties and duplicate keys.

Arrays whose `Array.prototype` parent has been changed use the original path
for every insertion. The `in` operator is not used against that altered chain,
so an exotic prototype's Proxy `has` trap cannot observe it. The accompanying
check covers this case. The fast-path decision is captured when a container is
created; arbitrary replacement of built-ins or prototype mutation from a
reentrant monkeypatched intrinsic remains outside this experimental contract,
as does the original parser's full decoder monkeypatch/reentry behavior.

Both variants still build all ordinary objects, arrays and native strings.
Both still parse numeric decimals through a short token string and native
`Number` for correct rounding. They still freeze containers as parsing closes
them. There is no retained cross-document key cache or generated schema code.

## Correctness

Run:

```sh
node proofs/utf8-rust-20261114/direct-json-guarded-checks.mjs
```

Observed on Node v24.22.1: **3,071 documents / 64,715 assertions pass**. This
includes the original Unicode, numeric, duplicate-key and deep-array corpus,
plus own-property descriptor checks, inherited object setters and read-only
fields, inherited numeric array setters and read-only fields, and an exotic
array prototype with a throwing Proxy `has` trap.

This note contains no new performance claim. The parent experiment runner
measures this variant separately.
