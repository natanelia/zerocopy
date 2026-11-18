# Combined JSON cursor and selected-string validation

All 12 serial checks passed after a clean automatic merge. Both dedicated worker CI registrations are retained. No tracked source or staged tree changed during validation.

- Published cursor parent: `0b7c0960adcad3ec61b4a2557490be45df6dcdf7`.
- Published equivalent string parent: `74e5f05e135cc252d0b611519806b3e7bdb886da`.
- Actual tested local string parent: `3f832b150d8304250ab5f79a53f38e3fd8fe2b6d`. Its tree is identical to the published string parent: `adce0dc3dce5d0efb0be42787d35cf7f4e4dba73`.
- Exact tested combined tree: `340a0d5a8ad0184c90ba90c60b48fc720158448e`.
- Full Bun suite: **68 files and 1,274 tests passed**.
- WASM audits: **7/7 passed**; combined core is 55,289 bytes with 26 audited reader functions.
- Both dedicated worker proofs passed with two readers each. Retained readers stayed correct while capacity grew from 131,072 to 327,680 bytes, and shared bytes remained unchanged.
- Pinned tools: Node 24.22.3, Bun 1.4.2, Rust/Cargo 1.100.0.

| Check | Result | Process seconds | Exact log |
| --- | --- | ---: | --- |
| source-whitespace | Passed | 0.008 | [log](logs/01-source-whitespace.log.gz) |
| build-wasm | Passed | 4.060 | [log](logs/02-build-wasm.log.gz) |
| build-browser | Passed | 0.067 | [log](logs/03-build-browser.log.gz) |
| wasm-audits | Passed | 1.274 | [log](logs/04-wasm-audits.log.gz) |
| build-types | Passed | 2.427 | [log](logs/05-build-types.log.gz) |
| typecheck | Passed | 1.527 | [log](logs/06-typecheck.log.gz) |
| typecheck-redux | Passed | 0.768 | [log](logs/07-typecheck-redux.log.gz) |
| typecheck-values | Passed | 4.083 | [log](logs/08-typecheck-values.log.gz) |
| typecheck-geometry | Passed | 0.416 | [log](logs/09-typecheck-geometry.log.gz) |
| full-bun-suite | Passed | 33.168 | [log](logs/10-full-bun-suite.log.gz) |
| array-cursor-workers | Passed | 0.166 | [log](logs/11-array-cursor-workers.log.gz) |
| string-scan-workers | Passed | 0.167 | [log](logs/12-string-scan-workers.log.gz) |

The whitespace check excludes the preserved historical .patch artifacts, whose context-line spaces are part of the patch format.

## Evidence

- [Summary and exact parent identities](summary.json), including all log hashes and worker outputs.
- [Full before/after source and built-artifact identities](results.json.gz).
- [Exact original local runner](run.py); its checkout/tool paths and identity assertions describe the recorded environment.
- [Archive checksums](archive.json). Every compressed file was read back and decompressed to verify exact original bytes; the summary and runner were copied byte-for-byte.

This validates correctness and clean integration of both changes. No combined performance workload or browser suite was run here. The cursor timing measurements remain the separate cursor-only reports in the parent directory.
