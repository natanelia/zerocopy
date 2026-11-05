"""Audit retained observations from the interrupted V1 pilot, without timing or repairing it."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parent
BASELINE = "b07bffe073a7f7d60f1dd7731358c16d1075eb45"
EXPECTED_SUBJECTS = 64


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12), (actual, expected)


def audit():
    path = ROOT / "results/pilot.json"
    if not path.exists():
        path = ROOT / "results/pilot.json.gz"
    stored = path.read_bytes()
    raw = gzip.decompress(stored) if path.suffix == ".gz" else stored
    data = json.loads(raw)
    assert data["schema"] == "zerocopy-paired-public-operation/v1"
    assert data["study"]["id"] == "checkpoint-validation-20261105"
    assert data["mode"] == "pilot" and data["status"] == "running"
    assert "completedAt" not in data and "failure" not in data and "error" not in data
    method, specs = data["method"], data["study"]["cases"]
    assert method["pairs"] == 2 and method["minimumWarmupMs"] == 150
    assert method["minimumWarmupBatches"] == 8 and method["samples"] == 9
    assert method["cases"] == specs and len(specs) == 8
    assert method["lock"] == "/tmp/zerocopy-performance.lock"
    assert data["host"]["affinity"] == "2"
    assert data["driver"]["sha256"] == sha256((ROOT / "paired-benchmark.mjs").read_bytes())
    workload_hash = sha256((ROOT / "archive/workloads-v1.mjs").read_bytes())
    assert data["workload"]["sha256"] == workload_hash

    before, after = data["source"]["before"], data["source"]["after"]
    assert before["commit"] == BASELINE and data["study"]["baseline"] == BASELINE
    assert data["study"]["changedSources"] == ["redux-checkpoint.ts"]
    names = set(before["sources"]) | set(after["sources"])
    assert sorted(name for name in names if before["sources"].get(name) != after["sources"].get(name)) == ["redux-checkpoint.ts"]
    assert before["wasm"] == after["wasm"]
    for variant, metadata in [("before", before), ("after", after)]:
        text = data["snapshots"]["redux-checkpoint.ts"][variant]
        assert sha256(text.encode()) == metadata["sources"]["redux-checkpoint.ts"]
    archived_source = (ROOT / "archive/redux-checkpoint-v1.ts.txt").read_bytes()
    assert archived_source == data["snapshots"]["redux-checkpoint.ts"]["after"].encode()
    assert sha256(archived_source) == after["sources"]["redux-checkpoint.ts"]

    schedule = []
    for pair in range(2):
        for runtime in (["bun", "node"] if pair % 2 else ["node", "bun"]):
            for spec in (list(reversed(specs)) if pair % 2 else specs):
                for variant in (["after", "before"] if pair % 2 else ["before", "after"]):
                    schedule.append((runtime, pair, variant, spec["name"]))
    assert len(schedule) == EXPECTED_SUBJECTS
    assert len(data["runs"]) == EXPECTED_SUBJECTS - 1
    indexed, versions = {}, {}
    specs_by_name = {spec["name"]: spec for spec in specs}
    for expected_key, run in zip(schedule, data["runs"]):
        key = (run["runtime"], run["pair"], run["variant"], run["caseName"])
        assert key == expected_key and key not in indexed
        indexed[key] = run
        spec = specs_by_name[run["caseName"]]
        assert run["spec"] == spec and run["affinity"] == data["host"]["affinity"]
        assert bool(run["versions"].get("bun")) == (run["runtime"] == "bun")
        versions.setdefault(run["runtime"], run["versions"])
        assert run["versions"] == versions[run["runtime"]]
        warmup, samples = run["warmupBatchMs"], run["sampleBatchMs"]
        assert len(warmup) >= 8 and sum(warmup) >= 150
        assert len(samples) == 9
        assert all(math.isfinite(value) and value > 0 for value in warmup + samples)
        assert run["verifiedOutputs"] == (len(warmup) + 9) * spec["repetitions"]
        close(run["medianMs"], statistics.median(samples) / spec["repetitions"])
        assert run["batchTiming"] == {
            "minimumObservedMs": min(warmup + samples), "minimumMeasuredMs": min(samples),
            "measuredBelow2ms": sum(value < 2 for value in samples),
            "warmupBelow2ms": sum(value < 2 for value in warmup),
        }

    complete_pairs, unpaired, estimates = 0, [], []
    for runtime in ["node", "bun"]:
        for spec in specs:
            points = []
            for pair in range(2):
                left = indexed.get((runtime, pair, "before", spec["name"]))
                right = indexed.get((runtime, pair, "after", spec["name"]))
                if left is None or right is None:
                    unpaired.append({"runtime": runtime, "caseName": spec["name"], "pair": pair,
                                     "presentVariant": "before" if left is not None else "after"})
                    continue
                assert left["expectedDigest"] == right["expectedDigest"]
                assert left["fixture"] == right["fixture"]
                points.append({"pair": pair, "before": left["medianMs"], "after": right["medianMs"],
                               "ratio": right["medianMs"] / left["medianMs"]})
                complete_pairs += 1
            summary = next(row for row in data["summary"] if row["runtime"] == runtime and row["name"] == spec["name"])
            assert summary["role"] == spec["role"] and len(summary["points"]) == len(points)
            for actual, expected in zip(summary["points"], points):
                assert actual["pair"] == expected["pair"]
                for key in ["before", "after", "ratio"]:
                    close(actual[key], expected[key])
            ratio = math.exp(statistics.mean(math.log(point["ratio"]) for point in points))
            close(summary["pairedRatio"], ratio)
            close(summary["beforeMs"], statistics.median(point["before"] for point in points))
            close(summary["afterMs"], statistics.median(point["after"] for point in points))
            assert summary["fasterPairs"] == sum(point["ratio"] < 1 for point in points)
            assert summary["interval95"] is None
            estimates.append({"runtime": runtime, "caseName": spec["name"], "completePairs": len(points),
                              "pairedRatio": ratio, "fasterPairs": summary["fasterPairs"], "interval95": None})
    assert len(data["summary"]) == 16 and complete_pairs == 31
    assert unpaired == [{"runtime": "node", "caseName": "decode-array-8192", "pair": 1, "presentVariant": "after"}]
    assert path.read_bytes() == stored, "The audit must not modify original evidence"
    return {
        "schema": "zerocopy-interrupted-pilot-audit/v1", "classification": "interrupted; incomplete experiment",
        "originalStatusUnchanged": data["status"], "originalRawSha256": sha256(raw), "originalRawBytes": len(raw),
        "startedAt": data["startedAt"], "lastSavedSubjectCompletedAt": data["runs"][-1]["completedAt"],
        "plannedSubjects": EXPECTED_SUBJECTS, "retainedSubjects": len(data["runs"]),
        "retainedMeasuredBatches": sum(len(run["sampleBatchMs"]) for run in data["runs"]),
        "completePairs": complete_pairs, "unpairedSubjects": unpaired,
        "missingSubject": {"runtime": schedule[-1][0], "pair": schedule[-1][1], "variant": schedule[-1][2], "caseName": schedule[-1][3]},
        "checks": {
            "strictSchedulePrefix": True, "uniqueSubjects": True, "sourceSnapshotsAndArchivesMatchLaunchHashes": True,
            "baselineCommitDeclared": BASELINE, "driverAndArchivedWorkloadHashesMatch": True,
            "warmupAndMeasurementCountsValid": True, "outputVerificationCountsValid": True,
            "allRetainedMediansAndCompletePairEstimatesRecomputed": True, "rawBytesUnmodified": True,
            "endOfStudySourceBuildIdentityChecksVerified": False, "completeExperimentVerified": False,
        },
        "sourceArchives": {"archive/redux-checkpoint-v1.ts.txt": sha256(archived_source), "archive/workloads-v1.mjs": workload_hash},
        "completePairEstimatesOnly": estimates,
        "limitations": [
            "The interruption cause is unknown; the raw recording contains no completion or structured failure record.",
            "Launch-time source/build identities are retained, but final identity checks and the missing subject cannot be recovered or inferred.",
            "One unpaired candidate is preserved but excluded from all paired estimates.",
            "This incomplete two-pair pilot is not pooled with V2 or used to establish a confirmed performance improvement.",
            "The normal complete-study verifier remains unchanged and rejects this incomplete recording.",
        ],
    }


if __name__ == "__main__":
    report = audit()
    (ROOT / "interrupted-pilot-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Audited {report['retainedSubjects']}/{report['plannedSubjects']} retained subjects, "
          f"{report['retainedMeasuredBatches']} measured batches, {report['completePairs']} complete pairs; experiment remains incomplete")
