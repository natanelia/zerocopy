# Direct JSON view scan screen — 2026-11-27

Pinned runtime 84ad23a76ee197f45cbc7316017f28b5bbe93d6c; temporary candidate patch and raw results in [run 45946410822](https://github.com/natanelia/zerocopy/actions/runs/45946410822), proof d431be0831089c5817769e6bbc1c1fd74a0571e8. Six green jobs, eight measured rounds of four modes per job, 192 fresh process trials, each with two real Node workers. Both snapshots, point reads and stable iteration order checked. Peak process RSS sampled before full verification.

| Records / shape | Keyed → direct five scans (ms) | Paired direct/keyed | Repeat A/A | Point-read paired ratio |
|---|---:|---:|---:|---:|
| 1k flat | 22.40 → 17.43 | .792 | 1.044 | 1.751 |
| 1k nested | 12.76 → 11.62 | .864 | 1.057 | 1.335 |
| 10k flat | 38.15 → 26.67 | .722 | 1.040 | 1.618 |
| 10k nested | 54.15 → 38.96 | .726 | 1.018 | 1.520 |
| 100k flat | 477.39 → 223.87 | .463 | .998 | 1.739 |
| 100k nested | 379.16 → 163.40 | .450 | 1.023 | 1.461 |

100k nested first publication/scan 155.75 → 96.56 ms; updated 408.80 → 194.09 ms; retained 360.32 → 163.48 ms; peak process RSS 351022 → 342768 KiB. Same-job full-decoding control five scans 1760.55 ms (not a native Map control). The post-scan 2,000 ordinary get() operations per reader slowed in all eight pairs at 100k nested (10.09 → 14.70 ms) and flat (8.40 → 14.56 ms).

Do not promote on these scan wins alone. Keyed getView calls Arena.find and trains the bounded ReadCache; direct iteration never calls it. JIT warmup and GC state also differ. The point result is real for this sequence, but does not demonstrate that adding an unused method slows ordinary get(). Next bounded diagnostic: same candidate build keyed vs direct, baseline keyed A/A, immediately repeated ordinary reads, fresh independent worker isolates doing only point reads on the same published roots, and combined mixed workload wall time. Separate cold point-loop timings from worker startup/attachment. Preserve the exact original scan correctness oracle. Memory measurement remains before additional diagnostic workers and full verification, now after two point passes. No default change, PR, merge or publication; lifetime/growth, runtime portability and API qualification still needed if the mixed workload passes.
