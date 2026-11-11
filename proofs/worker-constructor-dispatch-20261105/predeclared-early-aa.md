# Additional A/A control predeclaration

Declared at 2026-11-05T15:15:22.550297+00:00, while `formal-01.json` was still running.

The inline V2 pilot's Node `early-map-128-control` pairs were 0.795 and 1.525. The original A/A subset does not include that exact control. Before seeing the completed formal outcome, we declare one additional A/A-only recording for that case, using four fresh paired processes per runtime with the original driver, warmup and verification rules. It runs after the original A/A recording on CPU 2 under the common lock.

`workloads-early-aa.mjs` is a full copy of `workloads.mjs` with only `aaCases` replaced by `['early-map-128-control']`. There is no wrapper or unhashed fixture dependency. The original formal matrix and original A/A subset remain unchanged. Results are diagnostic; they will not be subtracted from A/B results and will not trigger a new A/B timing run.

Original workload SHA-256: 8e50b9436dcad4b668b13fa849ddf5cd0b01ac787dee24912ac13ff861721e53.

Additional A/A workload SHA-256: cb13a8f08f1e9c37dea44156e81b7b6c2b4d343634aa66c3c9bf67bc58e669d2.

Planned recording: `aa-early-01.json`, mode `aa`.
