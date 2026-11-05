"""Independently recompute paired public-operation timing evidence; no timings run."""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parent
SETTINGS = {"pilot": (2, 150), "formal": (6, 500), "aa": (4, 500)}
CRITICAL95 = {4: 3.182446305284263, 6: 2.5705818356363155}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def close(actual, expected):
    assert isinstance(actual, (float, int))
    assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12), (actual, expected)


def source_artifact(metadata, record_path):
    name = Path(metadata["name"]).name
    candidates = [record_path.parent / name, ROOT / name, Path(metadata["name"])]
    existing = next((path for path in candidates if path.is_file()), None)
    assert existing is not None, f"Keep the frozen {name} beside the verifier or recording"
    assert sha256(existing.read_bytes()) == metadata["sha256"], f"Artifact digest mismatch: {existing}"


def verify(path):
    stored = path.read_bytes()
    raw = gzip.decompress(stored) if path.suffix == ".gz" else stored
    for manifest_path in [path.parent / "manifest.json", ROOT / "manifest.json"]:
        if manifest_path.is_file():
            evidence = json.loads(manifest_path.read_text()).get("evidence", {}).get(path.name)
            if evidence is not None:
                assert sha256(stored) == evidence["sha256"]
                assert sha256(raw) == evidence["uncompressedSha256"]
                assert len(raw) == evidence["uncompressedBytes"]
                break
    data = json.loads(raw)
    assert data["schema"] == "zerocopy-paired-public-operation/v1"
    assert data["status"] == "complete"
    assert data["startedAt"] and data["completedAt"]
    study, method, mode = data["study"], data["method"], data["mode"]
    pairs, warmup_ms = SETTINGS[mode]
    assert method["pairs"] == pairs and method["minimumWarmupMs"] == warmup_ms
    assert method["samples"] == 9 and method["minimumWarmupBatches"] == 8
    assert method["lock"] == "/tmp/zerocopy-performance.lock"
    assert set(method["runtimes"]) == {"node", "bun"}
    assert data["host"]["affinity"].isdigit()
    assert data["host"]["arch"] and data["host"]["platform"] and data["host"]["cpu"]
    source_artifact(data["driver"], path)
    source_artifact(data["workload"], path)

    before, after = data["source"]["before"], data["source"]["after"]
    assert before["commit"] == study["baseline"]
    assert len(study["baseline"]) == 40
    names = set(before["sources"]) | set(after["sources"])
    changed = sorted(name for name in names if before["sources"].get(name) != after["sources"].get(name))
    assert changed == ([] if mode == "aa" else sorted(study["changedSources"]))
    wasm_names = set(before["wasm"]) | set(after["wasm"])
    wasm_changed = sorted(name for name in wasm_names if before["wasm"].get(name) != after["wasm"].get(name))
    assert wasm_changed == ([] if mode == "aa" else sorted(study["changedWasm"]))
    for metadata in [before, after]:
        for name in study["changedWasm"]:
            assert metadata["wasm"][name] == metadata["wasm"]["persistent-core.wasm"]
    assert before["wasm"] and before["bundles"] and after["bundles"]
    if mode == "aa":
        assert before == after
    for metadata in [before, after]:
        for category in ["sources", "wasm", "bundles"]:
            assert all(len(value) == 64 and int(value, 16) >= 0 for value in metadata[category].values())
    assert sorted(data["snapshots"]) == sorted(study["changedSources"])
    for name, snapshots in data["snapshots"].items():
        for variant, metadata in [("before", before), ("after", after)]:
            text = snapshots[variant]
            if text is None:
                assert name not in metadata["sources"]
            else:
                assert sha256(text.encode()) == metadata["sources"][name]

    all_cases = study["cases"]
    assert len({spec["name"] for spec in all_cases}) == len(all_cases)
    selected = study["aaCases"] if mode == "aa" else study.get("pilotCases") if mode == "pilot" else None
    cases = [spec for spec in all_cases if selected is None or spec["name"] in selected]
    if selected is not None:
        assert sorted(selected) == sorted(spec["name"] for spec in cases)
    assert cases and method["cases"] == cases
    specs = {spec["name"]: spec for spec in cases}
    assert len(data["runs"]) == pairs * 4 * len(cases)
    expected_order = []
    for pair in range(pairs):
        runtimes = ["bun", "node"] if pair % 2 else ["node", "bun"]
        selected_cases = list(reversed(cases)) if pair % 2 else cases
        for runtime in runtimes:
            for spec in selected_cases:
                for variant in (["after", "before"] if pair % 2 else ["before", "after"]):
                    expected_order.append((runtime, pair, variant, spec["name"]))

    indexed, versions = {}, {}
    for expected_key, run in zip(expected_order, data["runs"]):
        key = (run["runtime"], run["pair"], run["variant"], run["caseName"])
        assert key == expected_key and key not in indexed
        indexed[key] = run
        assert run["spec"] == specs[run["caseName"]]
        assert run["affinity"] == data["host"]["affinity"]
        assert run["startedAt"] and run["completedAt"] and run["executable"]
        assert len(run["expectedDigest"]) == 64 and int(run["expectedDigest"], 16) >= 0
        assert bool(run["versions"].get("bun")) == (run["runtime"] == "bun")
        versions.setdefault(run["runtime"], run["versions"])
        assert versions[run["runtime"]] == run["versions"]
        warmup, samples = run["warmupBatchMs"], run["sampleBatchMs"]
        assert len(warmup) >= 8 and sum(warmup) >= warmup_ms
        assert len(samples) == 9
        assert all(isinstance(value, (int, float)) and math.isfinite(value) and value > 0 for value in warmup + samples)
        repetitions = run["spec"]["repetitions"]
        assert isinstance(repetitions, int) and repetitions > 0
        assert run["verifiedOutputs"] == repetitions * (len(warmup) + len(samples))
        observations = run["observations"]
        assert len(observations) == len(warmup) + len(samples) + 2
        assert [item["operations"] for item in observations] == [1] + [repetitions] * (len(warmup) + len(samples)) + [1]
        for item in observations:
            assert item["sourceBytes"] > 0 and item["allocatedBytes"] >= 0
            assert item["capacityBytes"] >= item["sourceBytes"] + item["allocatedBytes"] + 65536
            close(item["allocatedBytesPerOperation"], item["allocatedBytes"] / item["operations"])
        close(run["medianMs"], statistics.median(samples) / repetitions)
        assert run["batchTiming"] == {
            "minimumObservedMs": min(warmup + samples),
            "minimumMeasuredMs": min(samples),
            "measuredBelow2ms": sum(value < 2 for value in samples),
            "warmupBelow2ms": sum(value < 2 for value in warmup),
        }

    rows = []
    for runtime in ["node", "bun"]:
        for spec in cases:
            points = []
            for pair in range(pairs):
                left = indexed[runtime, pair, "before", spec["name"]]
                right = indexed[runtime, pair, "after", spec["name"]]
                assert left["expectedDigest"] == right["expectedDigest"]
                assert left["fixture"] == right["fixture"]
                points.append({"pair": pair, "before": left["medianMs"], "after": right["medianMs"],
                               "ratio": right["medianMs"] / left["medianMs"]})
            logs = [math.log(point["ratio"]) for point in points]
            mean = statistics.mean(logs)
            interval = None
            if pairs in CRITICAL95:
                margin = CRITICAL95[pairs] * statistics.stdev(logs) / math.sqrt(pairs)
                interval = [math.exp(mean - margin), math.exp(mean + margin)]
            rows.append({"runtime": runtime, "name": spec["name"], "role": spec["role"],
                         "beforeMs": statistics.median(point["before"] for point in points),
                         "afterMs": statistics.median(point["after"] for point in points),
                         "pairedRatio": math.exp(mean), "interval95": interval,
                         "fasterPairs": sum(point["ratio"] < 1 for point in points), "points": points})
    assert len(rows) == len(data["summary"])
    for actual, expected in zip(data["summary"], rows):
        assert set(actual) == set(expected)
        for key in ["runtime", "name", "role", "fasterPairs"]:
            assert actual[key] == expected[key]
        for key in ["beforeMs", "afterMs", "pairedRatio"]:
            close(actual[key], expected[key])
        assert len(actual["points"]) == pairs
        for actual_point, expected_point in zip(actual["points"], expected["points"]):
            assert set(actual_point) == set(expected_point)
            assert actual_point["pair"] == expected_point["pair"]
            for key in ["before", "after", "ratio"]:
                close(actual_point[key], expected_point[key])
        if expected["interval95"] is None:
            assert actual["interval95"] is None
        else:
            assert len(actual["interval95"]) == 2
            for observed, value in zip(actual["interval95"], expected["interval95"]):
                close(observed, value)
    return {"recording": str(path), "study": study["id"], "mode": mode,
            "processes": len(data["runs"]), "measuredBatches": len(data["runs"]) * 9, "rows": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recordings", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    results = [verify(path.resolve()) for path in args.recordings]
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for result in results:
            print(f"Verified {Path(result['recording']).name}: {result['processes']} processes, "
                  f"{result['measuredBatches']} measured batches, {len(result['rows'])} independent paired estimates")
