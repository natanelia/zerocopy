#!/usr/bin/env python3
"""Independently recompute saved no-op-list evidence; never run the library.

Default: audit the completed pilot JSON (plain or gzip). Pass explicit saved
JSON/gzip paths to audit confirmation too. Optional --baseline/--candidate
directories verify the recorded file hashes against those measured checkouts;
without them, no current production files or build outputs are read.

The arithmetic, fixed matrix and allocation expectations below are independent
Python implementations. This script does not import the JS benchmark. Recorded
content-check counters are validated; raw result values are not stored in the
timing JSON, so this does not independently rerun those content comparisons.
"""

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import statistics


HERE = Path(__file__).resolve().parent
BASELINE_COMMIT = "77599337867dbf785a5f0311d34637d0b36678fc"
MEASURED_COMMIT = "11c73280eeaa636894851a48411fcbb5957dac54"
CORE_HASHES = {
    "baseline": "baa5d5a7682af2738a216566d3a8b61ee8f298e3abb61e34eb597d3ae277f976",
    "candidate": "6bf2d7ae51bd39606b50e6446e80434e2cbb4125688b212066345aa41e505618",
}
ALIASES = {
    "doubly-linked-list.wasm", "linked-list.wasm", "ordered-map.wasm",
    "persistent-core.wasm", "priority-queue.wasm", "shared-list.wasm",
    "shared-map.wasm", "singly-linked-list.wasm", "sorted-tree.wasm",
}
CONFIG = {
    "pilot": {"pairs": 2, "samples": 7, "warmupMs": 150},
    "formal": {"pairs": 6, "samples": 11, "warmupMs": 500},
    "targetBatchMs": 20, "minWarmupBatches": 8, "maxWarmupBatches": 2048,
    "maxCalibrationSteps": 12, "childTimeoutMs": 300000,
    "maxCheckedElements": 1048576, "maxSharedBytes": 16777216,
    "updatesPerOperation": 1024,
}
CASES = [
    ("tail-number-noop", "number", 1, 0, "noop", "target"),
    ("tree-number-noop", "number", 65537, 32768, "noop", "target"),
    ("tree-boolean-noop", "boolean", 1057, 511, "noop", "target"),
    ("tree-string-noop", "string", 1057, 511, "noop", "target"),
    ("tail-number-changed", "number", 1, 0, "changed", "changed-write control"),
    ("tree-number-changed", "number", 65537, 32768, "changed", "changed-write control"),
    ("tree-boolean-changed", "boolean", 1057, 511, "changed", "changed-write control"),
    ("tree-string-changed", "string", 1057, 511, "changed", "changed-write control"),
    ("tree-json-reencode", "object", 1057, 511, "reencode", "generic fallback"),
    ("get-control", "number", 65537, None, "get", "unchanged read control"),
]
MATRIX = []
for name, kind, size, index, mode, role in CASES:
    spec = {"name": name, "type": kind, "size": size, "mode": mode, "role": role}
    if index is not None:
        spec["index"] = index
    MATRIX.append(spec)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def close(actual, expected, label):
    assert math.isfinite(actual) and math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-10), (label, actual, expected)


def saved_path(path):
    path = Path(path)
    if path.exists():
        return path
    compressed = Path(str(path) + ".gz")
    assert compressed.exists(), f"Saved evidence missing: {path} or {compressed}"
    return compressed


def load(path):
    path = saved_path(path)
    packed = path.read_bytes()
    raw = gzip.decompress(packed) if path.suffix == ".gz" else packed
    return path, raw, json.loads(raw)


def native_expectations(spec):
    size, kind, mode = spec["size"], spec["type"], spec["mode"]
    strings = [f"interned-{i}-界🙂" for i in range(8)]
    values = [i + .25 if kind == "number" else bool(i % 2) if kind == "boolean"
              else strings[i % 8] if kind == "string" else {"i": i, "tag": "界🙂"}
              for i in range(size)]
    if mode == "get":
        expected = [values[(i * 67) % size] for i in range(1024)]
    else:
        expected = list(values)
        if mode == "changed":
            expected[spec["index"]] = -1024.25 if kind == "number" else values[spec["index"]] if kind == "boolean" else strings[7]
    serialized = json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode()
    prefix = ((size - 1) // 32) * 32
    depth, capacity = 0, 32
    while prefix > capacity:
        depth, capacity = depth + 1, capacity * 32
    node_bytes = 0 if mode == "get" else (size - prefix) * 8 if spec["index"] >= prefix else 256 + depth * 128
    blob_bytes = 0
    if kind == "object":
        encoded = json.dumps(values[spec["index"]], ensure_ascii=False, separators=(",", ":")).encode()
        blob_bytes = ((4 + len(encoded) + 7) // 8) * 8
    worst = (node_bytes + blob_bytes) * (0 if mode == "get" else 1024)
    cap = max(1, min(65536, 1048576 // len(expected), 16777216 // worst if worst else 65536))
    return {"expectedDigest": digest(serialized), "outputElements": len(expected), "maxRepeat": cap,
            "updatesPerOperation": 1024, "nodeBytes": node_bytes, "blobBytes": blob_bytes,
            "worstSharedBytesPerOperation": worst}


def audit_source(record, roots):
    source = record["source"]
    assert source["baseline"]["commit"] == BASELINE_COMMIT
    assert re.fullmatch(r"[0-9a-f]{40}", source["candidate"]["commit"])
    if record["phase"] == "pilot":
        assert source["candidate"]["commit"] == MEASURED_COMMIT
    left, right = source["baseline"], source["candidate"]
    assert left["production"].keys() == right["production"].keys()
    assert [name for name in left["production"] if left["production"][name] != right["production"][name]] == ["persistent-core.as.ts"]
    assert left["support"] == right["support"]
    assert left["wasm"].keys() == right["wasm"].keys()
    assert {name for name in left["wasm"] if left["wasm"][name] != right["wasm"][name]} == ALIASES
    file_checks = 0
    for label in ("baseline", "candidate"):
        tree = source[label]
        assert tree["production"]["persistent-core.as.ts"] == CORE_HASHES[label]
        assert all(tree["wasm"][name] == tree["wasm"]["persistent-core.wasm"] for name in ALIASES)
        assert "dist/shared.js" in tree["bundles"] and any("chunk-" in name for name in tree["bundles"])
        for group in ("production", "tests", "support", "wasm", "bundles", "ci"):
            for name, expected in tree[group].items():
                assert expected is None or re.fullmatch(r"[0-9a-f]{64}", expected), (label, group, name)
                if roots.get(label):
                    file = roots[label] / name
                    actual = digest(file.read_bytes()) if file.exists() else None
                    assert actual == expected, ("measured-file identity", label, name, actual, expected)
                    file_checks += 1
    assert set(source["driver"]) == {"benchmark.mjs", "workloads.mjs", "PLAN.md"}
    for name, expected in source["driver"].items():
        assert digest((HERE / name).read_bytes()) == expected, ("frozen driver identity", name)
    return file_checks


def audit_subject(subject, spec, runtime, candidate, stage, measurement, repeat=None):
    expected = native_expectations(spec)
    assert subject["status"] == "complete" and subject["runtime"] == runtime
    assert subject["phase"] == stage and subject["name"] == spec["name"] and subject["candidate"] == candidate
    assert subject["versions"].get("bun") == ("1.4.2" if runtime == "bun" else None)
    if runtime == "node":
        assert subject["versions"]["node"] == "24.22.1"
    for field, value in expected.items():
        assert subject[field] == value, (spec["name"], stage, field, subject[field], value)
    assert re.fullmatch(r"[0-9a-f]{64}", subject["sourceSha256"])
    assert subject["allPublishedBytesVerified"] is True and subject["allAllocationDeltasVerified"] is True
    assert subject["capped"] == (subject["repeat"] == expected["maxRepeat"])
    warm = subject["warmup"]
    assert 8 <= len(warm) <= 2048
    floor = 150 if stage == "calibrate" else measurement["warmupMs"]
    elapsed = math.fsum(row["ms"] for row in warm)
    close(subject["warmupMs"], elapsed, "actual timed warm-up total")
    assert elapsed >= floor
    assert len(warm) == 8 or math.fsum(row["ms"] for row in warm[:-1]) < floor
    assert subject["warmupCalls"] == sum(row["repeat"] for row in warm)
    initial_repeat = min(expected["maxRepeat"], 64) if stage == "calibrate" else repeat
    assert all(row["repeat"] == initial_repeat for row in warm)
    assert subject["initial"]["repeat"] == 1
    batches = [subject["initial"], *warm]
    if stage == "calibrate":
        assert subject["samples"] == []
        calibration = subject["calibration"]
        assert 1 <= len(calibration) <= 12
        running_repeat = initial_repeat
        for index, step in enumerate(calibration):
            assert step["repeat"] == running_repeat and len(step["trials"]) == 3
            assert all(row["repeat"] == running_repeat for row in step["trials"])
            batches.extend(step["trials"])
            elapsed_step = statistics.median(row["ms"] for row in step["trials"])
            stopped = elapsed_step >= 25 or running_repeat == expected["maxRepeat"]
            if index < len(calibration) - 1:
                assert not stopped
                running_repeat = min(expected["maxRepeat"], math.ceil(running_repeat * max(1.1, min(8, 30 / max(elapsed_step, .001)))))
            else:
                assert stopped
        assert subject["repeat"] == running_repeat
        close(subject["minMsPerCall"], min(row["ms"] / running_repeat for row in calibration[-1]["trials"]), "calibration minimum")
    else:
        assert subject["calibration"] == [] and subject["repeat"] == repeat
        assert len(subject["samples"]) == measurement["samples"]
        assert all(row["repeat"] == repeat for row in subject["samples"])
        batches.extend(subject["samples"])
        close(subject["medianMs"], statistics.median(row["ms"] / repeat for row in subject["samples"]), "process median")
        close(subject["minBatchMs"], min(row["ms"] for row in subject["samples"]), "minimum batch")
        assert subject["belowTargetBatches"] == sum(row["ms"] < 20 for row in subject["samples"])
    per_operation = 0 if candidate and spec["mode"] == "noop" else expected["worstSharedBytesPerOperation"]
    first = subject["initial"]
    for row in batches:
        count = row["repeat"]
        assert isinstance(count, int) and 1 <= count <= expected["maxRepeat"]
        assert math.isfinite(row["ms"]) and row["ms"] > 0
        assert row["verifiedCalls"] == count and row["publicCalls"] == count * 1024
        assert row["verifiedElements"] == count * expected["outputElements"]
        assert row["sourceVerifiedElements"] == spec["size"] * 2
        assert row["sourceBytesUnchanged"] is True
        assert row["sourceSha256"] == subject["sourceSha256"]
        assert row["sourceUsed"] == first["sourceUsed"] and row["sourceBufferBytes"] == first["sourceBufferBytes"]
        assert row["sourceUsed"] >= 65536 and row["sourceUsed"] % 8 == 0
        assert row["sourceBufferBytes"] >= row["sourceUsed"] and row["sourceBufferBytes"] % 65536 == 0
        allocated = count * per_operation
        assert row["allocatedBytes"] == row["expectedAllocatedBytes"] == allocated
        assert row["finalBufferBytes"] >= max(row["sourceBufferBytes"], row["sourceUsed"] + allocated)
        assert row["finalBufferBytes"] % 65536 == 0
        if allocated == 0:
            assert row["finalBufferBytes"] == row["sourceBufferBytes"]
    assert subject["checkedCalls"] == sum(row["repeat"] for row in batches)
    assert subject["checkedElements"] == sum(row["verifiedElements"] for row in batches)
    assert subject["checkedSourceElements"] == sum(row["sourceVerifiedElements"] for row in batches)
    return len(batches)


def comparable(record):
    return {label: {group: record["source"][label][group] for group in ("production", "support", "wasm", "bundles")}
            for label in ("baseline", "candidate")}


def audit(path, roots):
    path, raw, record = load(path)
    assert record["schema"] == "zerocopy-list-set-noop/v1" and record["status"] == "complete"
    assert record["phase"] in ("pilot", "formal") and record["config"] == CONFIG and record["cases"] == MATRIX
    phase, measurement = record["phase"], CONFIG[record["phase"]]
    assert record["hardware"]["affinity"] == "2" and record["hardware"]["availableParallelism"] == 1
    assert record["hardware"]["platform"] == "linux" and record["hardware"]["arch"] == "x64"
    file_checks = audit_source(record, roots)
    if phase == "formal":
        pilot_name = Path(record["pilotFile"]["path"]).name
        _, pilot_raw, pilot = load(HERE / "results" / pilot_name)
        assert digest(pilot_raw) == record["pilotFile"]["sha256"]
        assert pilot["phase"] == "pilot" and pilot["status"] == "complete"
        assert record["plans"] == pilot["plans"] and record["source"]["driver"] == pilot["source"]["driver"]
        assert comparable(record) == comparable(pilot)
    else:
        assert record["pilotFile"] is None
    expected_keys = [(runtime, spec["name"]) for runtime in ("node", "bun") for spec in MATRIX]
    assert [(p["runtime"], p["name"]) for p in record["plans"]] == expected_keys
    assert [(s["runtime"], s["name"]) for s in record["summary"]] == expected_keys
    expected_order = [(runtime, MATRIX[index]["name"], pair)
                      for runtime in ("node", "bun") for pair in range(measurement["pairs"])
                      for index in [*(range(pair, 10)), *(range(0, pair))]]
    assert [(p["runtime"], p["name"], p["pair"]) for p in record["pairs"]] == expected_order
    plans = {(p["runtime"], p["name"]): p for p in record["plans"]}
    lookup = {spec["name"]: spec for spec in MATRIX}
    measured_subjects, calibrated_subjects = [], []
    checked_batches = 0
    for runtime, name in expected_keys:
        plan, spec = plans[runtime, name], lookup[name]
        index = next(i for i, value in enumerate(MATRIX) if value["name"] == name)
        assert plan["order"] == (["candidate", "baseline"] if index % 2 else ["baseline", "candidate"])
        assert list(plan["calibration"]) == plan["order"]
        for build in plan["order"]:
            subject = plan["calibration"][build]
            checked_batches += audit_subject(subject, spec, runtime, build == "candidate", "calibrate", measurement)
            assert subject["expectedDigest"] == plan["expectedDigest"] and subject["sourceSha256"] == plan["sourceSha256"]
            calibrated_subjects.append(subject)
        assert plan["repeat"] == max(s["repeat"] for s in plan["calibration"].values())
    for pair in record["pairs"]:
        runtime, name = pair["runtime"], pair["name"]
        plan, spec = plans[runtime, name], lookup[name]
        assert pair["order"] == (["after", "before"] if pair["pair"] % 2 else ["before", "after"])
        for side in pair["order"]:
            subject = pair[side]
            checked_batches += audit_subject(subject, spec, runtime, side == "after", "measure", measurement, plan["repeat"])
            assert subject["sourceSha256"] == plan["sourceSha256"] and subject["expectedDigest"] == plan["expectedDigest"]
            measured_subjects.append(subject)
    # Sequence numbers prove the recorded order matches the actual spawned order.
    # Pilot calibration precedes each runtime's pairs; formal copies pilot plans.
    ordered_subjects = []
    for runtime in ("node", "bun"):
        if phase == "pilot":
            ordered_subjects += [s for s in calibrated_subjects if s["runtime"] == runtime]
        ordered_subjects += [s for s in measured_subjects if s["runtime"] == runtime]
    assert [s["sequence"] for s in ordered_subjects] == list(range(len(ordered_subjects)))
    print(f"\nPASS {path.name}: phase={phase}; raw_bytes={len(raw)}; raw_sha256={digest(raw)}")
    print(f"Source: baseline={record['source']['baseline']['commit']}; recorded candidate={record['source']['candidate']['commit']}; measured runtime={MEASURED_COMMIT}")
    print(f"Identity checks: source/WASM relationship constraints and 3 frozen driver files; {file_checks} optional measured-tree files")
    print("runtime | case | before ms/1024 calls | after ms/1024 calls | paired after/before | 95% interval (formal only) | pair ratios")
    for row in record["summary"]:
        pairs = [p for p in record["pairs"] if (p["runtime"], p["name"]) == (row["runtime"], row["name"])]
        assert len(pairs) == measurement["pairs"] and row["pairs"] == len(pairs)
        before = [p["before"]["medianMs"] for p in pairs]
        after = [p["after"]["medianMs"] for p in pairs]
        ratios = [a / b for a, b in zip(after, before)]
        logs = [math.log(ratio) for ratio in ratios]
        ratio = math.exp(statistics.fmean(logs))
        close(row["beforeMedianMs"], statistics.median(before), "marginal before median")
        close(row["afterMedianMs"], statistics.median(after), "marginal after median")
        close(row["ratio"], ratio, "geometric mean paired ratio")
        close(row["minRatio"], min(ratios), "minimum ratio")
        close(row["maxRatio"], max(ratios), "maximum ratio")
        assert len(row["pairRatios"]) == len(ratios)
        for stored, computed in zip(row["pairRatios"], ratios):
            close(stored, computed, "individual pair ratio")
        interval = "not inferred"
        if phase == "formal":
            half = 2.570581835636314 * statistics.stdev(logs) / math.sqrt(6)
            lower, upper = math.exp(statistics.fmean(logs) - half), math.exp(statistics.fmean(logs) + half)
            close(row["lower95"], lower, "paired log-t lower endpoint")
            close(row["upper95"], upper, "paired log-t upper endpoint")
            assert row["degreesOfFreedom"] == 5
            interval = f"[{lower:.6f}, {upper:.6f}]"
        else:
            assert "lower95" not in row and "upper95" not in row
        print(f"{row['runtime']} | {row['name']} | {statistics.median(before):.9f} | {statistics.median(after):.9f} | {ratio:.9f} | {interval} | " + ", ".join(f"{r:.9f}" for r in ratios))
    samples = [b for s in measured_subjects for b in s["samples"]]
    print(f"Verified {len(measured_subjects)} measured-process medians; {len(record['pairs'])} paired ratios; {len(record['summary'])} summary rows; {len(samples)} measured batches")
    print(f"Also checked {len(calibrated_subjects)} calibration records; {checked_batches} total initial/warm/calibration/measured batches")
    print(f"Measured subjects recorded {sum(s['checkedCalls'] for s in measured_subjects)} fully checked final results and {sum(s['checkedElements'] for s in measured_subjects)} output elements")
    print(f"Measured subjects recorded {sum(s['checkedSourceElements'] for s in measured_subjects)} source elements checked; every batch matched independently predicted shared allocation")
    for runtime in ("node", "bun"):
        subjects = [s for s in measured_subjects if s["runtime"] == runtime]
        times = [b["ms"] for s in subjects for b in s["samples"]]
        warm = [s["warmupMs"] for s in subjects]
        print(f"{runtime}: actual timed warm-up {min(warm):.6f}–{max(warm):.6f} ms; min measured batch {min(times):.6f} ms; below-20-ms batches {sum(t < 20 for t in times)}/{len(times)}; max warm-up batches {max(len(s['warmup']) for s in subjects)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("records", nargs="*", type=Path)
    parser.add_argument("--baseline", type=Path, help="Optional fixed measured baseline checkout for file hash checks")
    parser.add_argument("--candidate", type=Path, help="Optional fixed measured candidate checkout for file hash checks")
    args = parser.parse_args()
    records = args.records or [HERE / "results" / "pilot-01.json"]
    roots = {"baseline": args.baseline, "candidate": args.candidate}
    for path in records:
        audit(path, roots)
    print("\nAll requested saved-data audits passed. No library import, build, test, benchmark or timing run was performed.")


if __name__ == "__main__":
    main()
