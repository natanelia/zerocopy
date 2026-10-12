# Private prototype lookup in the Redux codec

The independently audited original result supports the tested serialization workload in both engines. Two Bun controls remain unresolved, and cold-import results do not provide startup clearance. The two unresolved warm controls prevent an all-controls clearance.

The candidate replaces the codec's twelve-class linear search with a private exact-prototype Map. It preserves the existing input guards and branded-arena validation. A fixed additional twelve-entry registry is initialized once; the portable Redux entry grows by 22 bytes. This is not a net-memory-saving claim.

## Recorded cohort

The single [GitHub Actions run](https://github.com/natanelia/zerocopy/actions/runs/38136133463) used proof commit `8255f381325f920b280b7a015c67d83973d3ea1b` (tree `64f27c22ddea0dc3e8f542c710eb4a4896164512`) on sole parent `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e` (source tree `eb3bd4217f132e13b01c42f9b9c6bdc5aa92afab`). Candidate `redux-codec.ts` SHA-256 is `6677302e6c0d6199d2170c7f6c7d611e5ba3936fb90c3b05957a4b50f1f61ff6`.

Date: 2026-10-11 UTC. Hosted Ubuntu 24 image `20261004.327.1`, Linux x86-64, AMD EPYC 7763, four available logical CPUs; Bun 1.4.2 source entry and Node 22.23.3 portable entry. This shared hosted machine is not representative of every deployment.

The [fixed method and driver](https://github.com/natanelia/zerocopy/tree/8255f381325f920b280b7a015c67d83973d3ea1b/proofs/redux-codec-private-map-hosted) specify the workload, fixed ABBA/BAAB schedule, warmed sizing, independent output models, stop rules and statistics. The primary repeatedly calls `codec.stringify(state)` with the codec factory outside timing: a frozen state with 32 plain records, a three-entry shared Map and a three-entry priority queue. It checks the complete serialized output and unchanged native used bytes, descriptors and published prefixes. It does not measure Redux dispatch.

Each endpoint/engine has four blocks, with eight baseline and eight candidate observations. All 192 scheduled observations completed; the controller used 217 children and 617.305 seconds within its fixed 900-second cap. Warm measurement phases target 1.5 seconds and require at least 500 ms after four warmup batches. Natural JavaScript allocation and GC remain inside the measured work. Calibration per-batch limits stayed at 2^27; the prospectively accepted primitive-only final-count ceiling was 2^29. Bun primitive used common N 284,181,504. This filled the new candidate's planned observations without changing any old candidate's missing observations.

## Results and limits

Ratios are candidate elapsed time divided by baseline elapsed time. Lower is faster. Primary upper bounds are the prespecified one-sided 97.5% modeled Student-t bounds across four block log ratios, conditional on the model assumptions.

| Primary | Geometric time ratio | Primary upper bound | Fixed decision |
| --- | ---: | ---: | --- |
| Bun frozen-state stringify | 0.762491 | 0.768504 | Qualified |
| Node frozen-state stringify | 0.741429 | 0.761668 | Qualified |

The primary observed time reductions are 23.75% and 25.86%. They are local workload results, not a general application-speed guarantee.

| Control | Bun | Node |
| --- | --- | --- |
| Same-root SharedMap selector | Individual guard supported | Individual guard supported |
| Changing-root selector | Unresolved: stability gate | Individual guard supported |
| Primitive serializability | Unresolved: stability gate | Individual guard supported |
| Unfrozen serializability | Individual guard supported | Individual guard supported |
| Fresh public-entry import | Descriptive, unresolved | Descriptive, unresolved |

Bun changing-root typical log drift was 0.054335, exceeding the fixed ln(1.05) limit. Bun primitive typical/tail drift was 0.071676/0.238847, exceeding ln(1.05)/ln(1.15). All sixteen observations in each cell remain retained, including the slower primitive baseline observation. No outlier is deleted and no replacement run is allowed. Bun unfrozen's individual 95% upper loss bound was 1.019025, narrowly within 1.02; that is a scoped guard, not universal clearance.

No declared material-regression trigger fired. Cold imports had zero adverse blocks in either engine, but remain descriptive: there is no throughput-duration floor, startup regression clearance or all-controls pass. The recorded aggregate outcome is `supported-primary-with-unresolved-controls`.

The earlier [shared-helper candidate run](https://github.com/natanelia/zerocopy/actions/runs/38129907987) remains blocked by its Bun unfrozen regression and retains its missing primitive observations. These candidates are distinct; the new study does not prove why the earlier one regressed. The new implementation also retains the ordinary native-intrinsic boundary documented in the method; arbitrary replacement of private Map machinery is not covered.

Existing README/website charts benchmark collection construction, reads, traversal or memory paths and do not call the optional Redux codec. Their historical values are unchanged.

## Evidence and correctness

The original official artifact SHA-256 is `8dfc6eeebdee5478bc83c81d6883146970bb109fbd863eaf176e63eb0feb9992`. The [durable evidence ZIP](redux-codec-private-map/2026-10-11-run-38136133463.zip) contains all 1,166 selected original setup/correctness/timing records and provenance files, byte for byte. Its [relative-path manifest](redux-codec-private-map/2026-10-11-run-38136133463.manifest.json) gives every checksum and 108 explicit exclusions: the source TAR, duplicate emitted builds and original full-export seal. The focused ZIP SHA-256 is `a62e45f36c5ebf70360380fcc4200045e871b867592a447c76f4df74217899ea`. Retained input/gate seals describe historical execution, not subset completeness. The original official artifact has the separate digest above. No observation is omitted or replaced.

Both the accepted local gate and the fresh hosted gate exercised all twelve kinds, genuine attachments, forged/subclass/proxy observer and brand behavior, no-scan behavior and codec/JSAN/checkpoint round trips in both engines. Each arm also passed the four existing relevant Redux files containing 86 exact cases. Declaration outputs remained identical, the internal registry/import ordering remained unchanged, and only the expected two local emitted replacements differed. Full repository, packed-package and browser/docs validation is reported separately by the pull request checks on their exact tested source. The performance result does not stand in for those correctness checks.
