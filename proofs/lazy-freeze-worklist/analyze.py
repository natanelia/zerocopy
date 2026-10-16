"""Fixed, in-process analysis for the prospective lazy-freeze codec screen.

Call analyze(records, admission_complete=..., run_complete=...). Each record is
one measurement child/row with engine ("node" or "bun"), block (1..6), arm
("B", "C", "A"), order (global measurement-child launch index, 1..36), row,
calibrated, sourceValid, valueValid, and measurements. The last field contains
exactly nine {"elapsedNs": number, "count": positive integer} dictionaries.
The three validity/calibration fields must be actual booleans. Extra receipt
fields are ignored. Calibration/warm-up records belong in the retained raw
receipts, not this measurement input.

The controller authenticates records and source/value validation, including
untimed checks, and supplies admission/run completeness. This module neither
authenticates source bytes nor runs children. False or absent sourceValid or
valueValid prevents that observation from entering any interval. Failures in
other observations do not erase independent, full-six-block adverse evidence.

The returned dictionary is JSON-safe. An exponentially overflowing displayed
endpoint is None; its finite log endpoint remains authoritative. No rounding,
resampling, trimming, alternate baselines, or additional sampling is performed.
"""

import math


METHOD_SHA256 = "e8a454f20249783935629a09b49a85b458394df4b4a72c368c7a96ad6154af4c"
ENGINES = ("node", "bun")
ROWS = (
    "P-record", "P-array", "E-object", "E-array", "N-record", "D-array",
    "W-array", "C-string", "C-number", "C-boolean",
)
PRIMARIES = ROWS[:2]
CONTROLS = ROWS[2:]
PRIMITIVE_CONTROLS = ROWS[7:]
ARMS = ("B", "C", "A")
BLOCKS = tuple(range(1, 7))
PROCESS_ORDERS = (
    ("B", "C", "A"), ("A", "B", "C"), ("C", "A", "B"),
    ("B", "A", "C"), ("C", "B", "A"), ("A", "C", "B"),
)
T_CRITICAL = 2.570582
N_BLOCKS = 6
N_BATCHES = 9


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _positive_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _safe(value):
    """Retain malformed input for diagnosis without emitting JSON NaN/Infinity."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, dict):
        return {str(key): _safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe(item) for item in value]
    return str(value)


def _mean(values):
    return math.fsum(value / len(values) for value in values)


def _exp(value):
    try:
        return math.exp(value)
    except OverflowError:
        return None


def _interval(log_ratios):
    """Only the complete six-block interval is a study estimate."""
    if len(log_ratios) != N_BLOCKS or any(
        value is None or not math.isfinite(value) for value in log_ratios
    ):
        return None
    average = _mean(log_ratios)
    sd = math.sqrt(math.fsum((value - average) ** 2 for value in log_ratios) / 5)
    half_width = T_CRITICAL * sd / math.sqrt(N_BLOCKS)
    lower, upper = average - half_width, average + half_width
    return {
        "n": N_BLOCKS, "df": 5, "tCritical": T_CRITICAL,
        "ratio": _exp(average), "lower": _exp(lower), "upper": _exp(upper),
        "logMean": average, "logSD": sd, "logLower": lower, "logUpper": upper,
    }


def _bias(interval):
    if interval is None:
        return False
    return (interval["logLower"] > math.log(1.05)
            or interval["logUpper"] < math.log(0.95))


def _expected_order(engine, block, arm):
    first_engine = "node" if block % 2 else "bun"
    engine_offset = 0 if engine == first_engine else 3
    return (block - 1) * 6 + engine_offset + PROCESS_ORDERS[block - 1].index(arm) + 1


def _process(record, input_index):
    issues, flags, per_operation = [], [], []
    raw = record.get("measurements")
    result = {
        "inputIndex": input_index,
        **{key: record[key] for key in ("engine", "block", "arm", "row")},
        "order": _safe(record.get("order")),
        "calibrated": record.get("calibrated") is True,
        "sourceValid": record.get("sourceValid") is True,
        "valueValid": record.get("valueValid") is True,
        "measurements": _safe(raw), "nsPerOperation": [], "nsPerDecode": None,
        "batchSampleCV": None, "lastThreeOverFirstThree": None,
        "qualityFlags": flags, "issues": issues, "counts": [],
        "timingValid": False, "intervalEligible": False,
        "qualityQualified": False, "chronologyValid": False,
    }
    for name in ("calibrated", "sourceValid", "valueValid"):
        if not isinstance(record.get(name), bool):
            issues.append("missing-or-nonboolean-" + name)
    if not result["sourceValid"]:
        issues.append("source-invalid")
    if not result["valueValid"]:
        issues.append("value-invalid")
    order = record.get("order")
    if not _positive_integer(order) or order > 36:
        issues.append("missing-or-invalid-order")
    else:
        result["chronologyValid"] = True
        if order != _expected_order(record["engine"], record["block"], record["arm"]):
            issues.append("order-differs-from-fixed-schedule")
    if not isinstance(raw, (list, tuple)) or len(raw) != N_BATCHES:
        issues.append("requires-nine-measured-batches")
        flags.append("incomplete-measurements")
        return result
    operation_cap = 2 ** (24 if record["row"] in PRIMITIVE_CONTROLS else 20)
    for index, measurement in enumerate(raw):
        if not isinstance(measurement, dict):
            issues.append("invalid-measurement-" + str(index + 1))
            per_operation.append(None)
            continue
        elapsed = _number(measurement.get("elapsedNs"))
        count = measurement.get("count")
        if _positive_integer(count):
            result["counts"].append(count)
            if count > operation_cap:
                issues.append("operation-cap-exceeded-batch-" + str(index + 1))
        else:
            issues.append("invalid-count-batch-" + str(index + 1))
        if elapsed is None or elapsed <= 0:
            flags.append("nonpositive-or-nonfinite-duration-batch-" + str(index + 1))
            issues.append("invalid-duration-batch-" + str(index + 1))
        elif elapsed < 10_000_000:
            flags.append("below-10ms-batch-" + str(index + 1))
        value = None
        if elapsed is not None and elapsed > 0 and _positive_integer(count):
            try:
                value = elapsed / count
            except OverflowError:
                value = None
            if value is None or not math.isfinite(value) or value <= 0:
                issues.append("invalid-per-operation-value-batch-" + str(index + 1))
                value = None
        per_operation.append(value)
    result["nsPerOperation"] = per_operation
    if len(set(result["counts"])) > 1:
        issues.append("count-varies-within-process")
    if any(value is None for value in per_operation):
        flags.append("uncomputable-process-mean")
        return result
    average = _mean(per_operation)
    if average <= 0 or not math.isfinite(average):
        issues.append("invalid-process-mean")
        flags.append("uncomputable-process-mean")
        return result
    cv = math.sqrt(math.fsum((value / average - 1) ** 2 for value in per_operation) / 8)
    first, last = _mean(per_operation[:3]), _mean(per_operation[-3:])
    drift = last / first if first > 0 else math.inf
    if cv > 0.25:
        flags.append("sample-cv-above-25-percent")
    if not 0.85 <= drift <= 1.15:
        flags.append("last-three-over-first-three-outside-0.85-to-1.15")
    result.update({
        "nsPerDecode": average, "batchSampleCV": cv,
        "lastThreeOverFirstThree": drift if math.isfinite(drift) else None,
        "timingValid": True,
        "intervalEligible": result["sourceValid"] and result["valueValid"],
        "qualityQualified": not flags,
    })
    return result


def _log_ratio(numerator, denominator):
    if (numerator is None or denominator is None
            or not numerator["intervalEligible"] or not denominator["intervalEligible"]):
        return None
    return math.log(numerator["nsPerDecode"]) - math.log(denominator["nsPerDecode"])


def _row_result(index, engine, row):
    blocks, candidate_logs, ab_logs, chronological_logs, reasons = [], [], [], [], []
    for block in BLOCKS:
        arms = {arm: index.get((engine, block, arm, row)) for arm in ARMS}
        candidate = _log_ratio(arms["C"], arms["B"])
        ab = _log_ratio(arms["A"], arms["B"])
        chronological = None
        if (ab is not None and arms["A"]["chronologyValid"]
                and arms["B"]["chronologyValid"]
                and arms["A"]["order"] != arms["B"]["order"]):
            chronological = ab if arms["A"]["order"] > arms["B"]["order"] else -ab
        candidate_logs.append(candidate)
        ab_logs.append(ab)
        chronological_logs.append(chronological)
        blocks.append({
            "block": block,
            "meansNsPerDecode": {arm: item["nsPerDecode"] if item else None
                                 for arm, item in arms.items()},
            "order": {arm: item["order"] if item else None for arm, item in arms.items()},
            "COverB": _exp(candidate) if candidate is not None else None,
            "AOverB": _exp(ab) if ab is not None else None,
            "laterBaselineOverEarlier": _exp(chronological) if chronological is not None else None,
            "logCOverB": candidate, "logAOverB": ab,
            "logLaterBaselineOverEarlier": chronological,
        })
        for arm, item in arms.items():
            label = str(block) + "/" + arm + ":"
            if item is None:
                reasons.append(label + "missing-or-duplicate-observation")
                continue
            if not item["intervalEligible"]:
                reasons.append(label + "source-value-or-timing-invalid")
            if not item["calibrated"]:
                reasons.append(label + "uncalibrated")
            reasons.extend(label + flag for flag in item["qualityFlags"])
            reasons.extend(label + issue for issue in item["issues"])
    candidate_interval = _interval(candidate_logs)
    ab_interval = _interval(ab_logs)
    chronological_interval = _interval(chronological_logs)
    if candidate_interval is None:
        reasons.append("candidate-interval-requires-six-valid-blocks")
    if ab_interval is None:
        reasons.append("A-over-B-interval-requires-six-valid-blocks")
    if chronological_interval is None:
        reasons.append("chronological-baseline-interval-requires-six-valid-blocks")
    ab_bias, chronological_bias = _bias(ab_interval), _bias(chronological_interval)
    if ab_bias:
        reasons.append("major-A-over-B-bias")
    if chronological_bias:
        reasons.append("major-chronological-baseline-bias")
    return {
        "engine": engine, "row": row, "role": "primary" if row in PRIMARIES else "control",
        "blocks": blocks, "candidateInterval": candidate_interval,
        "AOverBInterval": ab_interval, "chronologicalBaselineInterval": chronological_interval,
        "majorAOverBBias": ab_bias, "majorChronologicalBias": chronological_bias,
        "favorablePrerequisitesMet": not reasons,
        "limitations": list(dict.fromkeys(reasons)),
        "adverseEvidence": (candidate_interval is not None
                            and candidate_interval["logLower"] > math.log(1.02)),
    }


def analyze(records, *, admission_complete, run_complete, incomplete_reasons=()):
    """Return the fixed full-sample report, including incomplete-run evidence.

    admission_complete covers the correctness gate, exact source/artifact/runtime
    seals, frozen calibration counts, environment and resource admission. The
    controller sets run_complete only after all prescribed calibration, warm-up,
    measurement, validation, resource, exit and cleanup receipts are complete.
    Neither boolean may be inferred solely from the presence of timing records.
    """
    problems = [str(reason) for reason in incomplete_reasons]
    if admission_complete is not True:
        problems.append("admission-incomplete")
    if run_complete is not True:
        problems.append("run-incomplete")
    processes, invalid_records, index, duplicates = [], [], {}, set()
    for input_index, record in enumerate(records):
        if not isinstance(record, dict):
            invalid_records.append({"inputIndex": input_index, "record": _safe(record)})
            problems.append("non-object-record-" + str(input_index))
            continue
        engine, block, arm, row = (record.get(key) for key in ("engine", "block", "arm", "row"))
        if (engine not in ENGINES or not _positive_integer(block) or block not in BLOCKS
                or arm not in ARMS or row not in ROWS):
            invalid_records.append({"inputIndex": input_index, "record": _safe(record)})
            problems.append("invalid-record-identity-" + str(input_index))
            continue
        key = (engine, block, arm, row)
        process = _process(record, input_index)
        processes.append(process)
        label = "/".join(str(part) for part in key)
        problems.extend(label + ":" + issue for issue in process["issues"])
        if key in index or key in duplicates:
            duplicates.add(key)
            index.pop(key, None)
            problems.append(label + ":duplicate-record-no-selection")
        else:
            index[key] = process
    for engine in ENGINES:
        for block in BLOCKS:
            for arm in ARMS:
                for row in ROWS:
                    key = (engine, block, arm, row)
                    if key not in index:
                        problems.append("/".join(str(part) for part in key) + ":missing-or-duplicate-record")

    # The same child has one launch index across all ten rows. A launch index
    # cannot belong to two children. Conflicts invalidate chronology, not C/B.
    child_orders, order_children = {}, {}
    for process in processes:
        child = (process["engine"], process["block"], process["arm"])
        if process["chronologyValid"]:
            child_orders.setdefault(child, set()).add(process["order"])
            order_children.setdefault(process["order"], set()).add(child)
    for process in processes:
        child = (process["engine"], process["block"], process["arm"])
        if (len(child_orders.get(child, ())) != 1
                or (process["chronologyValid"] and len(order_children[process["order"]]) != 1)):
            process["chronologyValid"] = False
            process["issues"].append("conflicting-child-chronology")
            problems.append("/".join(str(part) for part in child) + ":conflicting-child-chronology")

    for engine in ENGINES:
        for row in ROWS:
            matching = [process for process in processes
                        if process["engine"] == engine and process["row"] == row]
            counts = {count for process in matching for count in process["counts"]}
            calibration = {process["calibrated"] for process in matching}
            if len(counts) > 1:
                problems.append(engine + "/" + row + ":count-not-frozen-across-arms-and-blocks")
                for process in matching:
                    process["issues"].append("count-not-frozen-across-arms-and-blocks")
            if len(calibration) > 1:
                problems.append(engine + "/" + row + ":calibration-flags-disagree")
                for process in matching:
                    process["issues"].append("calibration-flags-disagree")
            if row in PRIMARIES and any(not process["calibrated"] for process in matching):
                problems.append(engine + "/" + row + ":primary-calibration-admission-failed")

    complete = not problems
    rows = {engine: {row: _row_result(index, engine, row) for row in ROWS} for engine in ENGINES}
    primitive_bias = [
        {"engine": engine, "row": row,
         "AOverB": rows[engine][row]["majorAOverBBias"],
         "chronological": rows[engine][row]["majorChronologicalBias"]}
        for engine in ENGINES for row in PRIMITIVE_CONTROLS
        if rows[engine][row]["majorAOverBBias"] or rows[engine][row]["majorChronologicalBias"]
    ]
    adverse = []
    for engine in ENGINES:
        for row in ROWS:
            result = rows[engine][row]
            if result["adverseEvidence"]:
                limitations = list(result["limitations"])
                if not complete:
                    limitations.append("study-incomplete")
                adverse.append({"engine": engine, "row": row,
                                "interval": result["candidateInterval"], "limitations": limitations})

    primary_decisions, qualified_primaries = {}, []
    for row in PRIMARIES:
        reasons = []
        if not complete:
            reasons.append("study-incomplete")
        if adverse:
            reasons.append("candidate-vetoed-by-valid-adverse-evidence")
        if primitive_bias:
            reasons.append("major-bias-on-unchanged-primitive-control")
        engine_checks = {}
        for engine in ENGINES:
            result = rows[engine][row]
            interval = result["candidateInterval"]
            threshold_met = interval is not None and interval["logUpper"] <= math.log(0.95)
            engine_checks[engine] = {
                "upperBoundAtMost0.95": threshold_met,
                "favorablePrerequisitesMet": result["favorablePrerequisitesMet"],
            }
            if not threshold_met:
                reasons.append(engine + ":upper-bound-not-at-most-0.95")
            if not result["favorablePrerequisitesMet"]:
                reasons.append(engine + ":calibration-quality-or-bias-unresolved")
        qualifies = not reasons
        primary_decisions[row] = {"qualifies": qualifies, "engineChecks": engine_checks, "reasons": reasons}
        if qualifies:
            qualified_primaries.append(row)

    unresolved_controls = []
    for engine in ENGINES:
        for row in CONTROLS:
            result = rows[engine][row]
            interval = result["candidateInterval"]
            reasons = list(result["limitations"])
            if not complete:
                reasons.append("study-incomplete")
            if interval is None or interval["logUpper"] > math.log(1.02):
                reasons.append("upper-bound-not-at-most-1.02")
            if result["adverseEvidence"]:
                result["controlStatus"] = "adverse-evidence"
            elif not reasons:
                result["controlStatus"] = "provisionally-clear"
            else:
                result["controlStatus"] = "unresolved"
                unresolved_controls.append({"engine": engine, "row": row, "reasons": reasons})
    if adverse:
        decision = "veto" if complete else "incomplete-with-adverse-evidence"
    elif not complete:
        decision = "incomplete"
    elif not qualified_primaries:
        decision = "no-lead"
    elif unresolved_controls:
        decision = "targeted-validation-only"
    else:
        decision = "promising-direct-codec-lead"
    return {
        "schemaVersion": 1, "methodSHA256": METHOD_SHA256,
        "complete": complete, "incompleteReasons": list(dict.fromkeys(problems)),
        "decision": decision, "candidateVetoed": bool(adverse), "adverseEvidence": adverse,
        "qualifiedPrimaries": qualified_primaries, "primaryDecisions": primary_decisions,
        "primitiveBiasBlocksAllGains": primitive_bias,
        "unresolvedControls": unresolved_controls, "rows": rows,
        "processes": processes, "invalidRecords": invalid_records,
        "inference": {
            "replicationUnit": "six paired blocks per engine; nine batches estimate a process mean",
            "interval": "ordinary two-sided 95% paired log-t interval, df=5, t=2.570582",
            "gainMultiplicity": "each upper bound is 97.5% one-sided; both engines per primary, Bonferroni across two primaries",
            "adverseRule": "unadjusted conservative veto, not familywise causal proof of regression",
            "scope": "direct-codec latency lead only; further correctness and integration validation required",
            "assumptions": "approximately independent, reasonably behaved block log-ratios; host confounding remains possible",
            "memory": "no physical-allocation, retained-memory, or comparative-memory conclusion",
            "compatibility": "candidate omits the initial dynamic Array.prototype.pop lookup/call; no universal equivalence claim",
            "resampling": "none; this screen ends without repeats or changed thresholds",
        },
    }
