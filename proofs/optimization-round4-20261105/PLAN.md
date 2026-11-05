# Combined validation after the fourth optimization round

This is a correctness and installed-package check, not a performance measurement or a merge request. The new experimental candidates from this round did not clear their predeclared control checks. They remain in separate evidence branches and are excluded from this checkout.

## Included existing optimization PRs

| PR | Standalone published commit | Change |
| --- | --- | --- |
| [50](https://github.com/natanelia/zerocopy/pull/50) | `766b2226324e4a8d37705ab82fd86207cb79622f` | Long text-search loops |
| [51](https://github.com/natanelia/zerocopy/pull/51) | `3b4042abcbe7b5745d24f6daf1e9aea66cb9d242` | Bulk list tail reuse |
| [53](https://github.com/natanelia/zerocopy/pull/53) | `5b53cd652fbc582c39c84c87c736903c7ec3c72c` | Native checkpoint Base64 |
| [54](https://github.com/natanelia/zerocopy/pull/54) | `2f47642651712ce1b8fc6c67d8c65c0371c09e79` | TanStack values materialization |
| [55](https://github.com/natanelia/zerocopy/pull/55) | `2883a6e20943d721d0572c3d70a744fab6351be9` | Linked-list block callbacks |
| [56](https://github.com/natanelia/zerocopy/pull/56) | `cd1297394ee4ea80fa1d3a6454634865899a60c2` | Ordered-map projections |
| [57](https://github.com/natanelia/zerocopy/pull/57) | `af96028e0c30846354eb4a2f05d58f3dbcc269d5` | Redux descriptor validation |
| [58](https://github.com/natanelia/zerocopy/pull/58) | `254e5c288eaba5258a99db9c4c41c8a17271b6cb` | Sorted-map callbacks |

All originate from runtime baseline `77599337867dbf785a5f0311d34637d0b36678fc` or its runtime-equivalent predecessor. The first six were already combined and checked in round three. The published trees for PRs 57 and 58 were checked against GitHub before importing their local equivalents. The one CI conflict is resolved by keeping both additions. The combined source before this plan was local commit `dc95e2fdfde4d8431b378eefe74d68f4e365ddde` (local provenance, not presumed remotely fetchable).

## Fixed gate

Run `integration-gate.py` once under the shared performance lock after the final timing study. Build WASM, portable JavaScript and declarations; check project/Redux/value/geometry/worker types; run the default unit suite; execute actual worker lifecycle and affected-collection proofs; replay the relevant archived evidence checks; verify documentation preservation; and check installed Node/Bun/TypeScript package consumers offline. Record every command, exit code, source hash, portable/WASM hash, tool version and raw output.

No timing reruns or speed claims are part of this combined gate. Standalone performance results remain tied to their own measured sources and reports. The included PRs remain separate and open. This validation branch is not a request to merge them as a batch.

The baseline has no committed dependency lockfile. The original validation uses the shared installed dependency tree with pinned direct versions. A future `bun install` can resolve different transitive versions; record that difference when reproducing.
