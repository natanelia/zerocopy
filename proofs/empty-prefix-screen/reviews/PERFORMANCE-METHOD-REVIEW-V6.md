# Performance method v6 independent review

No blocker in the narrow warmed-baseline calibration amendment. This disposition clears exact method v6 for driver and artifact review only; it grants no execution or publication authority.

Reviewed METHOD.md SHA-256 `70d4c38a862ce9caeae0c19904ee76cd1d0b2daed59f2943ae00b5b414bce6e4`, exact revision delta `45b8e4911c65df68242bef82a69c7aec8e1a8042afdb62de449d2a4f71bfa9bb`, and the separately cleared warmed-calibration design. The delta changes only status, baseline count-selection history and associated planning arithmetic. All three companion payloads and every v5 byte remain preserved.

At each of the four fixed counts, eight warmups precede three pilots. The existing final-four readiness gate applies before pilots; correctness, clock or readiness failure stops unresolved. Any pilot above 200 ms stops immediately. Only a three-pilot median below 5 ms advances; the first usable median uniquely determines aligned, capped N. No pilot CV threshold, replacement observations or candidate-informed selection is introduced. The final eight warmups and three verification batches retain the 16–40 ms median rule. Every stage and final observation must remain separately available for independent recomputation.

Static arithmetic confirms at most 44 selection batches / 245,104,640 reads and 55 total calibration batches / 429,654,016 reads. Actual added time enters the unchanged feasibility calculation. Extra loop history does not guarantee fresh-main readiness; a short unstable stage may reject early.

Main loops, fixtures, public routes, order, 16 paired rounds, 400-child schedule, 10-second / 1-GiB child bounds, 600-second study bound, clocks, quality gates, paired-log intervals and all decision thresholds are byte-identical to v5. Candidate source remains exactly 503 matching regular files against the sealed manifest; no production source changed. All 21 integrity checks pass.

Run 38676734117 remains independently sealed as incomplete with zero main-study pairs. No earlier samples are reused or pooled. No repository import, build, subject test, calibration or measurement was executed for this review. Driver/controller trace binding and visible workflow preservation are separate pending reviews.
