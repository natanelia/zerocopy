# Rejected SIMD bitmask experiments (2026-10-18)

Evidence-only branch based on PR #41 head e578b26dc1392ca7efdbfebd5c3721b6d4c2fc5e. No performance clearance and no production change.

A/A and A/B used four ABBA/BAAB blocks, seven warm-ups, 21 measured batches, 8 million elements per sample, unchanged performance floors (0.95 regression, >1.05 large-input target, 1/0.95 A/A ceiling). Only Node 22.16 x64 was available locally.

Per-four bitmask: at 32768 values, direct SIMD speedup Stage5/candidate = 0.7979 (95% CI 0.7174-0.8874); public = 0.7803 (0.7505-0.8114). Its A/A confidence controls passed 8/12; A/B passed 1/12. Both full gates failed.

Packed per-leaf variant: direct SIMD 0.6469 (0.6328-0.6612); public 0.6527 (0.6335-0.6725). A/A confidence passed 2/3; A/B 1/3. Both gates failed.

Both variants passed 924 direct/public numerical checks plus 42 immutable-snapshot checks each. No source changes or performance PR were approved. Full 63-endpoint Node/Bun x64/ARM64 acceptance is still required. Local raw diagnostic archives are retained separately, not in Git history.
