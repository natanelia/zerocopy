# Follow-up pilot: combine tail reservation in WASM

The fixed baseline remains `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.
The [first completed pilot](PILOT.md) showed consistent Node penalties in the
33-value batch and retained-root controls, despite strong small-batch gains.
The JavaScript candidate added a separate `getHeapEnd` call even when the old
tail could not be reused.

V2 moves the frontier decision, allocation and fallback prefix copy into one
internal WASM helper. JavaScript still validates the original total allocation
size before converting arguments to unsigned integers. Only nonnegative safe
integer counts use the helper; exotic lengths keep the original arithmetic,
allocation and copying path. The existing `copyWords` helper copies at most
32 old tail values. No published prefix is rewritten.

Keep all 14 workloads in [the original matrix](PLAN.md), four alternating
fresh-process pairs per runtime, seven measured batches per subject and the
same calibration/warm-up rules. The separate driver is [pilot-wasm.mjs](pilot-wasm.mjs).
Do not discard the JavaScript pilot or any control based on its direction.
After the complete screen, choose whether a longer study is justified.

The V1 production source, source patch and exact driver remain under
`exploration/js-v1-*`; all V1 raw data remains in `results/pilot-02.json.gz`.
V2 records its complete source/bundle identities and both changed source files
in `results/pilot-wasm-v2-01.json.gz`.
