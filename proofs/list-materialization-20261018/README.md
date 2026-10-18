# Primitive list materialization experiment

This branch tests number and boolean decoding in `SharedList.toArray`. The x64 local A/B checks improved, but one identical-build A/A confidence gate failed. No performance clearance or merge is authorized.

The change must pass regression tests on Node, Bun, and browser before review can finish.

Baseline commit: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
