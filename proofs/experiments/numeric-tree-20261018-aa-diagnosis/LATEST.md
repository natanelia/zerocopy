# Latest full hosted validation: still failed (18 October 2026)

Comparison: [run 39093228871](https://github.com/natanelia/zerocopy/actions/runs/39093228871), head e578b26dc1392ca7efdbfebd5c3721b6d4c2fc5e on draft PR #41. Runtime/portable-evidence repair from #40 is included. Full workflow has completed with a failed numeric comparison gate.

Original artifacts, downloaded and SHA-256 checked:
- x64 ID 12124386219; ZIP SHA-256 66f34ed4623fa361864e40c45feb4b96ea3b1bd2b5163997cfd4fd642318e874.
- ARM64 ID 12123807837; ZIP SHA-256 47d60980afb74c00bb7e1219f5dc7b9e0f6b9f5ec3edc7591c5e4c287eabc283.

The current PR #40 raw verifier recomputed all **1,408 retained child reports and their journals**. Cross-phase runtime and architecture coverage passed. No report, child, sample or existing threshold was rewritten or removed.

| Architecture | Runtime/method | Point checks / 63 | Confidence checks / 63 | Full gate |
| --- | --- | ---: | ---: | --- |
| x64 | Node A/A | 59 | 52 | FAIL |
| x64 | Node A/B | 63 | 62 | FAIL |
| x64 | Bun A/A | 55 | 35 | FAIL |
| x64 | Bun A/B | 59 | 48 | FAIL |
| ARM64 | Node A/A | 63 | 58 | FAIL |
| ARM64 | Node A/B | 63 | 62 | FAIL |
| ARM64 | Bun A/A | 58 | 57 | FAIL |
| ARM64 | Bun A/B | 60 | 57 | FAIL |

The A/A independent raw audit also found 8 x64 Node and 1 x64 Bun within-child early/late rises above its **diagnostic-only** 25% marker. No ARM64 A/A phase had one. These counts are not a new acceptance rule. The failing outcome remains failing on every platform.

A separate, unapproved local scalar sibling-leaf point-box experiment passed all 6 existing numeric snapshot tests but did not pass its paired A/A confidence controls. The 4 observed A/B point ratios were 0.9899, 1.0057, 1.0015 and 1.0592 (sizes 1024 and 32768, control then mixed). The 32768 known-miss lower confidence bound was 0.9472 < 0.95. Its retained local ZIP contains the changed source, built Wasm, exact Node paired raw sample files, the first interrupted larger screen and the safety log; SHA-256 **09d55096d68a388338eb1ff3d3d925e07e0d8bc8d87f62389a2f5a4f23af8b3b**. This local ZIP is separate from GitHub-hosted evidence and is not a hosted performance clearance.

No new production PR was justified. All existing PRs remain open; nothing was merged, released, retagged or force-pushed.
