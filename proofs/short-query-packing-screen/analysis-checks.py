"""Proposed pure synthetic checks. SOURCE ONLY: not run or imported in preparation.

After separate release, run_checks(analysis_module) exercises only fabricated
records and numerical quadrature; it imports no candidate, driver, or target.
There is no command-line entry point or automatic test execution.
"""

import copy
import math


def _records():
    return [{"engine": engine, "arm": arm, "round": round_number,
             "workloads": {case: {"K": 2, "operationsPerRepetition": 8,
                                   "warmupMs": [50.0] * 8,
                                   "measuredMs": [45.0 if arm == "candidate" and case == "P1" else 50.0] * 4,
                                   "checksums": [17] * 4, "expectedChecksum": 17}
                           for case in ("P1", "S1", "C1", "C2", "C3", "C4")}}
            for engine in ("node", "bun") for round_number in range(16)
            for arm in ("baseline", "candidate")]


def _endpoint(result, engine, case):
    return next(row for row in result["endpoints"] if row["engine"] == engine and row["case"] == case)


def _change(records, engine, arm, case, **fields):
    for record in records:
        if record["engine"] == engine and record["arm"] == arm:
            record["workloads"][case].update(copy.deepcopy(fields))


def _independent_tail(t):
    # Composite Simpson integration of the original density, independent of
    # analysis.py's transformed finite recurrence. Synthetic numerical work only.
    n = 16384
    h = t / n
    normalization = math.exp(math.lgamma(8) - math.lgamma(7.5)) / math.sqrt(15 * math.pi)
    def density(x):
        return normalization * (1 + x * x / 15) ** -8
    weighted = density(0) + density(t)
    weighted += math.fsum((4 if i % 2 else 2) * density(i * h) for i in range(1, n))
    return 0.5 - h * weighted / 3


def run_checks(analysis):
    critical = analysis.critical_values()
    assert abs(_independent_tail(critical["ordinary95"]) - 0.025) < 1e-9
    assert abs(_independent_tail(critical["simultaneous95Across12"]) - 0.05 / 12) < 1e-9
    assert critical["simultaneous95Across12"] > critical["ordinary95"]

    records = _records()
    untouched = copy.deepcopy(records)
    result = analysis.analyze(records)
    assert records == untouched, "Analysis must not alter raw observations"
    assert result["valid"] and result["promisingPrimary"] and result["regressionClear"]
    assert not result["harmVeto"] and len(result["endpoints"]) == 12
    assert all(row["n"] == 16 and row["df"] == 15 for row in result["endpoints"])

    # Three fast batches cannot erase the slow fourth batch: arithmetic mean
    # is 100 ms, not the 50 ms median. All 16 process pairs remain replicates.
    records = _records()
    _change(records, "node", "candidate", "C1", measuredMs=[50, 50, 50, 250])
    result = analysis.analyze(records)
    row = _endpoint(result, "node", "C1")
    assert math.isclose(row["geometricMeanRatio"], 2.0, rel_tol=1e-12)
    assert row["pairs"][0]["candidate"]["meanMeasuredMs"] == 100
    assert math.isclose(row["pairs"][0]["candidate"]["meanMsPerOperation"], 100 / 16)
    assert row["pairs"][0]["candidate"]["measuredMs"] == [50, 50, 50, 250]
    assert result["harmVeto"] and not result["promisingPrimary"]

    # Harm survives all quality defects together, including interval width.
    # Alternating ratios 1.1/3.0 yield a lower ordinary bound above 1.02.
    records = _records()
    _change(records, "node", "baseline", "C2", measuredMs=[10] * 4)
    for record in records:
        if record["engine"] == "node" and record["arm"] == "candidate":
            record["workloads"]["C2"]["measuredMs"] = [11 if record["round"] % 2 == 0 else 30] * 4
            record["workloads"]["C2"]["warmupMs"] = [50] * 6 + [80, 80]
    result = analysis.analyze(records)
    row = _endpoint(result, "node", "C2")
    assert row["valid"] and not row["qualityClear"] and row["harmVeto"]
    assert set(row["qualityFlags"]) == {"measured_batch_below_20ms", "ordinary_interval_width_above_1.20",
                                        "candidate_warmup_stable_children_below_14"}
    assert result["harmVeto"] and not result["promisingPrimary"] and not result["regressionClear"]

    # A small adverse point estimate is permitted by the stated 2% bound.
    records = _records()
    _change(records, "bun", "candidate", "C3", measuredMs=[50.5] * 4)
    result = analysis.analyze(records)
    row = _endpoint(result, "bun", "C3")
    assert 1 < row["geometricMeanRatio"] < 1.02
    assert row["simultaneousOneSided95Across12"]["upper"] <= 1.02
    assert result["promisingPrimary"] and result["regressionClear"] and not result["harmVeto"]

    # A successful secondary never rescues a failed primary in either engine.
    records = _records()
    _change(records, "bun", "candidate", "P1", measuredMs=[50] * 4)
    _change(records, "bun", "candidate", "S1", measuredMs=[30] * 4)
    assert not analysis.analyze(records)["promisingPrimary"]

    # At least 14 stable children per arm: exactly two failures are allowed.
    records = _records()
    for record in records:
        if record["engine"] == "node" and record["arm"] == "candidate" and record["round"] < 2:
            record["workloads"]["C4"]["warmupMs"] = [50] * 6 + [80, 80]
    assert _endpoint(analysis.analyze(records), "node", "C4")["qualityClear"]
    next(record for record in records if record["engine"] == "node" and record["arm"] == "candidate"
         and record["round"] == 2)["workloads"]["C4"]["warmupMs"] = [50] * 6 + [80, 80]
    assert not _endpoint(analysis.analyze(records), "node", "C4")["qualityClear"]

    # Missing and duplicate identities cannot be silently selected or dropped.
    records = _records()
    invalid_inputs = [records[:-1], records + [copy.deepcopy(records[0])],
                      records[:-1] + [copy.deepcopy(records[0])]]
    for invalid in invalid_inputs:
        result = analysis.analyze(invalid)
        assert not result["valid"] and not result["promisingPrimary"] and not result["regressionClear"]
    for field, value in (("checksums", [17, 17, 17, 18]), ("K", 4),
                         ("operationsPerRepetition", 9), ("measuredMs", [50, 50, 50])):
        records = _records()
        records[0]["workloads"]["C1"][field] = value
        result = analysis.analyze(records)
        assert not result["valid"] and not result["promisingPrimary"] and not result["regressionClear"]

    # Another invalid endpoint cannot erase a completed valid harm endpoint.
    records = _records()
    _change(records, "node", "candidate", "C1", measuredMs=[60] * 4)
    records[-1]["workloads"]["C4"]["checksums"] = [0] * 4
    result = analysis.analyze(records)
    assert not result["valid"] and result["harmVeto"]
    assert {"engine": "node", "case": "C1"} in result["adverseEndpoints"]
    return {"status": "passed", "scope": "synthetic records and numerical quadrature only"}
