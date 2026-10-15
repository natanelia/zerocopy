# Source and synthetic validation record

The original seven-command validation passed: Python AST/JSON/hash/inventory inspection; pinned Node syntax checks for subject.mjs and subject-check.mjs; one synthetic subject check each on Node 22.16.0 and Bun 1.4.2; 24 synthetic analysis tests; and seven mocked supervisor tests. A later two-command controller AST/inventory and mocked-supervisor validation also passed. The resulting source identities are preserved by the publication manifests and review provenance.

These checks used a 30-second command limit, 180-second whole limit, 30-second metadata limit, sampled 512 MiB process-group RSS stop and two-second cleanup limit. They stopped on first failure, retained complete output and inspected descendants before reaping original process leaders. Python -B and PYTHONDONTWRITEBYTECODE=1 prevented bytecode writes.

The subject checks use synthetic iterators, controlled counters and fake numeric clocks; they do not invoke main, import the target, collect garbage, execute allocation probes or measure a workload. Analysis checks use synthetic complete/invalid observations and deterministic mathematics. Supervisor checks use fabricated records and mocked subprocess, timer and OS hooks. They exercise exact schedules/caps, raw-summary identity, terminal eligibility and cleanup predicates without real supervision.

The statistical constants were independently checked using the recorded positive-tail series and transformed-density quadrature. The synthetic analysis tests check their fixed residuals and formulas. The 22 memory and 38 latency simultaneous families remain separately 95%, using two-sided quantiles.

These are source/synthetic results. They provide neither full target correctness nor measured performance evidence. Both arms' hosted ordinary suites, typechecks and real-worker proofs remain prerequisites for the fixed scientific schedule. This editorial successor changes only technical documentation and its identity pins; no validation or study was repeated for it.
