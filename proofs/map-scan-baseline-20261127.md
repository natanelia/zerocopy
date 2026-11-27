# Map scan baseline and attribution — 2026-11-27

Baseline production source: 84ad23a76ee197f45cbc7316017f28b5bbe93d6c. Original proof: 252289fc2fd8b2191a649e90d896846205d8ea56 ([run 45916896487](https://github.com/natanelia/zerocopy/actions/runs/45916896487)). All three matrix jobs succeeded; 12 measured trials per mode with two readers and two excluded warmup trials. Both snapshots were validated for all keys/values. At 100k synthetic object records:

| Mode | First round trip (one scan) | Repeat round trip (five scans) | Repeat individual scan | Updated round trip (five scans) | Retained round trip (five scans) |
|---|---:|---:|---:|---:|---:|
| Shared forEach | 187.75 ms | 622.98 ms | 120.19 ms | 624.65 ms | 611.21 ms |
| Shared entries | 192.30 ms | 648.43 ms | 124.18 ms | 654.40 ms | 638.34 ms |
| Native Map forEach (cloned to each reader) | 198.40 ms | 21.36 ms | 1.69 ms | 186.58 ms | 12.90 ms |

Medians of the stated sample type, not candidate speedups. Shared first and updated round trips include attachment; native includes structured clone. Round trips include response, hash and sorting; scan timings exclude hash/sorting. Repeat heapUsed samples were approximately 17.2 MB shared vs 32.3 MB native per reader (not peak RSS, GC or shared arena memory). Sparse writer mutation 0.245 ms shared vs 14.04 ms native, which copies the map to preserve snapshots. Repeated full JSON decoding is a hypothesis. The small forEach/entries gap does not justify blindly transplanting #68.

Next proof: profile actual worker scan phases including fingerprinting, retain raw profiles and self-time summaries. Diagnostic only: inspector overhead and profile transfer invalidate timing comparisons. Only shared forEach at 10k and 100k with three measured trials. No runtime changes, merge or deploy. Follow the dominant cost before selecting a candidate; keep bounded caches and public contracts.
