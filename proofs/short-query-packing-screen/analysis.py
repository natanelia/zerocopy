"""Source-only preparation for the accepted short-query screen; not yet executed.

analyze(records) is pure: no file, process, clock, target, or network access.
Rounds are 0..15; arms are baseline/candidate. The supervisor must separately
authenticate corpus, calibration, ordering, identities, limits, and receipts.
Statistical clearance here cannot override a failed terminal/supervisor gate.
"""

import math


METHOD_SHA256 = "f32eadded0fd6618754184f42339054c7efb8bdbef0709e512524043cc28df4d"
ENGINES = ("node", "bun")
ARMS = ("baseline", "candidate")
CASES = ("P1", "S1", "C1", "C2", "C3", "C4")
PAIRS = 16
DF = PAIRS - 1


def _mean(values):
    # Scaling prevents overflow without discarding or downweighting any batch.
    scale = max(abs(value) for value in values)
    return scale * (math.fsum(value / scale for value in values) / len(values)) if scale else 0.0


def _positive(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value > 0
    except OverflowError:
        return False


def _exp(value):
    try:
        return math.exp(value)
    except OverflowError:
        return None  # Decisions use log bounds, never this display conversion.


def _t15_upper_tail(t):
    """Student-t(df=15) upper tail, specialized to t >= 0.

    Provenance: the Student-t density cited in the reviewed earlier analysis,
    https://www.itl.nist.gov/div898/handbook/eda/section3/eda3664.htm .
    Substitution t=sqrt(15)*cot(a) makes the tail proportional to integral
    sin(a)^14 da. Integration by parts gives I_n(a)=((n-1)*I_(n-2)(a)
    -sin(a)^(n-1)*cos(a))/n, with I_0(a)=a. Normalize by 2*I_14(pi/2).
    This df=15 specialization requires its own source review and inert checks;
    the earlier df=7 constants are deliberately not reused.
    """
    angle = math.atan2(math.sqrt(15.0), t)
    integral, full = angle, math.pi / 2
    sine, cosine = math.sin(angle), math.cos(angle)
    for degree in range(2, 15, 2):
        integral = ((degree - 1) * integral - sine ** (degree - 1) * cosine) / degree
        full *= (degree - 1) / degree
    return integral / (2 * full)


def critical_values():
    """Fixed-tail bisection, computed only when explicitly called.

    Both required roots lie in [0, 8]. Sixty bisections and a 1e-10 upward
    numerical cushion are prospective; independent quadrature checks are in
    analysis-checks.py. No numerical validation has been run in preparation.
    """
    result = {}
    for name, tail in (("ordinary95", 0.05 / 2), ("simultaneous95Across12", 0.05 / 12)):
        low, high = 0.0, 8.0
        for _ in range(60):
            middle = (low + high) / 2
            if _t15_upper_tail(middle) > tail:
                low = middle
            else:
                high = middle
        result[name] = high + 1e-10
    return result


def _workload(record, case):
    if record is None:
        return None, ["Missing or duplicate process identity"]
    workloads = record.get("workloads")
    row = workloads.get(case) if isinstance(workloads, dict) else None
    if not isinstance(row, dict):
        return None, ["Missing or malformed workload"]
    issues = []
    k, operations = row.get("K"), row.get("operationsPerRepetition")
    if type(k) is not int or not (1 <= k <= 2 ** 20) or k & (k - 1):
        issues.append("K must be a calibration-ladder power of two from 1 through 2^20")
    if type(operations) is not int or operations <= 0:
        issues.append("operationsPerRepetition must be a positive integer")
    warmup, measured = row.get("warmupMs"), row.get("measuredMs")
    for label, values, count in (("warmupMs", warmup, 8), ("measuredMs", measured, 4)):
        if not isinstance(values, list) or len(values) != count or not all(_positive(x) for x in values):
            issues.append(label + " requires exactly " + str(count) + " finite positive durations")
    expected, checksums = row.get("expectedChecksum"), row.get("checksums")
    if type(expected) is not int or expected < 0:
        issues.append("expectedChecksum must be a nonnegative integer")
    if (not isinstance(checksums, list) or len(checksums) != 4
            or any(type(value) is not int or value != expected for value in checksums)):
        issues.append("All four measured checksums must equal expectedChecksum")
    if issues:
        return None, issues
    mean_ms = _mean(measured)
    tail_ratio = _mean(warmup[6:8]) / _mean(warmup[4:6])
    return {"K": k, "operationsPerRepetition": operations, "expectedChecksum": expected,
            "warmupMs": list(warmup), "measuredMs": list(measured), "checksums": list(checksums),
            "meanMeasuredMs": mean_ms,
            "meanMsPerOperation": _exp(math.log(mean_ms) - math.log(k) - math.log(operations)),
            "withinChildBatchSpread": {"minMs": min(measured), "maxMs": max(measured),
                                       "maxToMin": _exp(math.log(max(measured)) - math.log(min(measured)))},
            "warmupTailRatio": tail_ratio, "warmupStable": 0.90 <= tail_ratio <= 1.10}, []


def _endpoint(index, engine, case, critical):
    pairs, issues = [], []
    for round_number in range(PAIRS):
        pair = {"round": round_number}
        for arm in ARMS:
            row, errors = _workload(index.get((engine, arm, round_number)), case)
            pair[arm] = row
            issues.extend({"round": round_number, "arm": arm, "reason": error} for error in errors)
        pairs.append(pair)
    for field in ("K", "operationsPerRepetition", "expectedChecksum"):
        values = {pair[arm][field] for pair in pairs for arm in ARMS if pair[arm] is not None}
        if len(values) > 1:
            issues.append({"reason": field + " must be frozen across both arms and all rounds"})
    output = {"engine": engine, "case": case, "valid": not issues, "invalidReasons": issues,
              "pairs": pairs, "qualityClear": False, "harmVeto": False, "regressionBoundClear": False}
    if issues:
        return output
    # The shared K and operation count cancel in paired logs. Means include
    # every one of the four batches with equal weight, including slow/GC work.
    logs = [math.log(pair["candidate"]["meanMeasuredMs"]) - math.log(pair["baseline"]["meanMeasuredMs"])
            for pair in pairs]
    center = _mean(logs)
    sd = math.sqrt(math.fsum((value - center) ** 2 for value in logs) / DF)
    se = sd / math.sqrt(PAIRS)
    ordinary_low = center - critical["ordinary95"] * se
    ordinary_high = center + critical["ordinary95"] * se
    simultaneous_high = center + critical["simultaneous95Across12"] * se
    stable = {arm: sum(pair[arm]["warmupStable"] for pair in pairs) for arm in ARMS}
    min_batch = min(value for pair in pairs for arm in ARMS for value in pair[arm]["measuredMs"])
    width_log = ordinary_high - ordinary_low
    quality_flags = []
    if min_batch < 20:
        quality_flags.append("measured_batch_below_20ms")
    if width_log > math.log(1.20):
        quality_flags.append("ordinary_interval_width_above_1.20")
    for arm in ARMS:
        if stable[arm] < 14:
            quality_flags.append(arm + "_warmup_stable_children_below_14")
    output.update({"n": PAIRS, "df": DF, "pairedLogRatios": logs,
                   "geometricMeanRatio": _exp(center), "pairedLogStandardDeviation": sd,
                   "ordinary95": {"lower": _exp(ordinary_low), "upper": _exp(ordinary_high),
                                  "logLower": ordinary_low, "logUpper": ordinary_high},
                   "simultaneousOneSided95Across12": {"upper": _exp(simultaneous_high), "logUpper": simultaneous_high},
                   "quality": {"minimumMeasuredBatchMs": min_batch,
                               "ordinaryIntervalUpperToLower": _exp(width_log), "stableChildren": stable},
                   "qualityFlags": quality_flags, "qualityClear": not quality_flags,
                   "primaryBoundClear": ordinary_high <= math.log(0.95),
                   # Quality flags cannot suppress a valid material-harm result.
                   "harmVeto": ordinary_low > math.log(1.02),
                   # A point estimate above 1.00 is not an additional veto.
                   "regressionBoundClear": simultaneous_high <= math.log(1.02)})
    return output


def analyze(records):
    """Analyze exactly 64 records; report partial valid harm without promotion.

    Each record: {engine, arm, round, workloads: {P1/S1/C1/C2/C3/C4: {
      K, operationsPerRepetition, warmupMs:[8], measuredMs:[4],
      checksums:[4], expectedChecksum}}}. Checksums are scalar integers.
    Unknown/missing process identities, duplicates, incomplete endpoints,
    invalid checksums, or changed fixed counts block all favorable decisions.
    """
    issues, index = [], {}
    if not isinstance(records, list):
        records = []
        issues.append("records must be a list")
    if len(records) != 64:
        issues.append("Exactly 64 measured process records required")
    for position, record in enumerate(records):
        if not isinstance(record, dict):
            issues.append("Malformed process at position " + str(position))
            continue
        engine, arm, round_number = record.get("engine"), record.get("arm"), record.get("round")
        if (engine not in ENGINES or arm not in ARMS or type(round_number) is not int
                or round_number not in range(PAIRS)):
            issues.append("Invalid process identity at position " + str(position))
            continue
        key = (engine, arm, round_number)
        if key in index:
            index[key] = None  # Never select a favorable copy of an ambiguous process.
            issues.append("Duplicate process identity: " + repr(key))
        else:
            index[key] = record
        workloads = record.get("workloads")
        if not isinstance(workloads, dict) or set(workloads) != set(CASES):
            issues.append("Every process requires exactly the six named workloads: " + repr(key))
    critical = critical_values()
    endpoints = [_endpoint(index, engine, case, critical) for engine in ENGINES for case in CASES]
    valid = not issues and all(row["valid"] for row in endpoints)
    adverse = [{"engine": row["engine"], "case": row["case"]} for row in endpoints if row["harmVeto"]]
    primary = [row for row in endpoints if row["case"] == "P1"]
    promising = valid and not adverse and all(row["qualityClear"] and row["primaryBoundClear"] for row in primary)
    clear = valid and all(row["qualityClear"] and row["regressionBoundClear"] for row in endpoints)
    return {"schema": "short-query-paired-analysis/v1", "methodSha256": METHOD_SHA256,
            "valid": valid, "recordCount": len(records), "invalidReasons": issues,
            "criticalValues": critical, "endpoints": endpoints, "harmVeto": bool(adverse),
            "adverseEndpoints": adverse, "promisingPrimary": promising, "regressionClear": clear,
            "completeTerminalAuditRequired": True,
            "limits": ["Six aggregate endpoints per engine; no individual C3/C4-term clearance.",
                       "Independent process pairs and the paired-log Student-t model are assumptions.",
                       "Ordinary harm intervals are not familywise error controlled.",
                       "No samples omitted, no outlier removal, no pooling of engines.",
                       "No startup/import, heap, browser, or full-suite claim."]}
