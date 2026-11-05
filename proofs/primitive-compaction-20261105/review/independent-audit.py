"""Independent saved-data audit; imports no benchmark/statistics helper.

Supply --baseline and --candidate only to check the original frozen worktrees.
The arithmetic audit also works on the final lossless gzip without live sources.
This is a historical review script, not a gate on future production hashes.
"""
import argparse
import gzip
import hashlib
import json
import math
import pathlib
import statistics
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument("data", type=pathlib.Path)
parser.add_argument("--baseline", type=pathlib.Path)
parser.add_argument("--candidate", type=pathlib.Path)
args = parser.parse_args()
stored = args.data.read_bytes()
raw = gzip.decompress(stored) if args.data.suffix == ".gz" else stored
data = json.loads(raw)
assert data["status"] == "complete"
assert data["mode"] == "formal"
assert data["before"]["head"] == "77599337867dbf785a5f0311d34637d0b36678fc"
print("UTC", datetime.now(timezone.utc).isoformat())
print("Raw bytes", len(raw), "SHA256", hashlib.sha256(raw).hexdigest())
print("Measured baseline", data["before"]["head"], "candidate", data["after"]["head"])
print("Using the driver's recorded rounded df5 critical value 2.570582.")
print("An initial cross-check with 2.570581835636314 differed only by rounding in CI endpoints; no conclusion changes.")

def near(actual, expected):
    assert abs(actual - expected) <= max(1e-12, abs(expected) * 1e-10), (actual, expected)

medians = {}
records = {}
batches = 0
for run in data["runs"]:
    assert len(run["records"]) == 1
    row = run["records"][0]
    values = [value / row["repetitions"] for value in row["sampleBatchMs"]]
    med = statistics.median(values)
    near(med, row["medianMs"])
    assert len(values) == 9
    assert len(row["warmupBatchMs"]) >= 8 and sum(row["warmupBatchMs"]) >= 500
    assert row["verifiedOutputs"] == (len(row["warmupBatchMs"]) + len(values)) * row["repetitions"]
    key = (run["runtime"], run["caseName"], run["pair"], run["variant"])
    assert key not in medians
    medians[key] = med
    records[key] = row
    batches += len(values)

pair_count = 0
for summary in data["summary"]:
    runtime, name = summary["runtime"], summary["name"]
    before = [medians[(runtime, name, i, "before")] for i in range(6)]
    after = [medians[(runtime, name, i, "after")] for i in range(6)]
    ratios = [a / b for a, b in zip(after, before)]
    logs = [math.log(value) for value in ratios]
    mean = statistics.mean(logs)
    half = 2.570582 * statistics.stdev(logs) / math.sqrt(6)
    for actual, expected in [
        (summary["beforeMs"], statistics.median(before)),
        (summary["afterMs"], statistics.median(after)),
        (summary["pairedRatio"], math.exp(mean)),
        (summary["interval95"][0], math.exp(mean - half)),
        (summary["interval95"][1], math.exp(mean + half)),
    ]:
        near(actual, expected)
    assert len(summary["points"]) == 6
    for i, point in enumerate(summary["points"]):
        for actual, expected in [(point["before"], before[i]), (point["after"], after[i]), (point["ratio"], ratios[i])]:
            near(actual, expected)
        a, b = records[(runtime, name, i, "after")], records[(runtime, name, i, "before")]
        for field in ["repetitions", "fixtureDigest", "sourceBytes", "sourceUsed", "targetUsed", "layoutDigest"]:
            assert a[field] == b[field], (runtime, name, i, field)
    pair_count += 6
    print(f'{runtime} {name}: {math.exp(mean):.9f} [{math.exp(mean-half):.9f}, {math.exp(mean+half):.9f}], '
          f'{sum(value > 1 for value in ratios)}/6 adverse; pairs ' + ', '.join(f'{value:.9f}' for value in ratios))

assert len(medians) == 216 and pair_count == 108 and batches == 1944 and len(data["summary"]) == 18
hashes = 0
if args.baseline is not None or args.candidate is not None:
    assert args.baseline is not None and args.candidate is not None
    for label, root in [("before", args.baseline), ("after", args.candidate)]:
        for section in ["source", "bundle"]:
            for name, expected in data[label][section].items():
                path = root / "dist" / name if section == "bundle" else root / name
                assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, (label, name)
                hashes += 1
    driver = args.candidate / "proofs/primitive-compaction-20261105/benchmark.mjs"
    assert hashlib.sha256(driver.read_bytes()).hexdigest() == data["driver"]
    hashes += 1
    assert hashes == 177

print("Main caveat remains Node boolean 1.2491 [0.8535,1.8281], 5/6 adverse; Bun numeric queue 1.0800 [0.9952,1.1721], 4/6 adverse. Strong two-target gains are exact; no arithmetic mismatch.")
print("Control intervals crossing parity do not establish equivalence or prove absence of a regression.")
print(json.dumps({"status": "passed", "subjectMedians": len(medians), "pairedRatios": pair_count,
                  "summaryRows": len(data["summary"]), "measuredBatches": batches, "liveIdentityChecks": hashes}))
