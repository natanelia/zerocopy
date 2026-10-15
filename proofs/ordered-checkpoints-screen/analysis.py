"""Prospective ordered-checkpoint analysis. Importing this module performs no work.

Only analyze(data) is the supervisor entry point. See
INERT-CHECKS-PROPOSED.md for the pending inert-check gate.
All samples remain in the input artifact. Eligibility is about measurement
validity, never speed, GC, CV, drift, order effects, or sensitivity diagnostics.
"""

import math


METHOD_SHA256 = "25d6af75fb5f602805f05bde6ab7d30f6887fe36c4a84ff892cc6b8370f68f43"
SCHEMA = "ordered-checkpoint-analysis/v1"
ENGINES = ("node", "bun")
ARMS = ("baseline", "candidate")
CASES = ("P", "E0", "F128", "F513", "F100k", "D100k", "O32k")
ENDPOINTS = tuple(case + ":" + kind for case in CASES for kind in ("first", "full"))
ISOLATED_FIRST = frozenset(case + ":first" for case in ("P", "F100k", "D100k", "O32k"))
BUCKETS = ("heapUsed", "heapTotal", "external", "arrayBuffers", "rss",
           "arenaUsedBytes", "arenaCapacityBytes")
BUN_BUCKETS = ("heapSize", "heapCapacity", "extraMemorySize")
RELEASE_LIMIT = 64 * 1024
MATERIALITY = {"baseline_heap": 512 * 1024, "heap_saving": 256 * 1024,
               "half_baseline_minus_candidate": 0}
QUANTILES = {"pointwise95": 1 - 0.05 / 2,
             "latency28": 1 - 0.05 / (2 * 28),
             "memory10": 1 - 0.05 / (2 * 10)}
# NIST Student-t density: https://www.itl.nist.gov/div898/handbook/eda/section3/eda3664.htm
# For df=7, f(t)=16/(5*pi*sqrt(7))*(1+t*t/7)**(-4). Substitution
# t=sqrt(7)*tan(theta) gives F7(t)=1/2+[theta+3*sin(2theta)/4+
# 3*sin(4theta)/20+sin(6theta)/60]/pi. The specialization is our derivation.
# Independently verified 2026-10-15 by transformed-tail quadrature AND a
# 70-digit Decimal incomplete-beta series, not by this source writer.
# t-critical-values-v1/SEAL.json SHA256:
CRITICAL_PROVENANCE_SHA256 = "b02e40abb6dd0228c76f7e7e076d410ec306693f637d9680ed46507cf663e122"
CRITICAL_VALUES = {"pointwise95": 2.3646242515927853,
                   "latency28": 4.883865032805824,
                   "memory10": 4.029337177642485}
K_LADDER = (1, 4, 16, 64, 256, 1024, 4096, 16384, 65536)


def fixed_critical_values():
    """Return the same prospectively authenticated df=7 constants every time."""
    return dict(CRITICAL_VALUES)


def _number(value, *, positive=False):
    return (type(value) in (int, float) and math.isfinite(value)
            and (value > 0 if positive else value >= 0))


def _mean(values):
    return math.fsum(values) / len(values)


def _interval(values, critical):
    """Only full n=8 samples enter an inferential interval."""
    if len(values) != 8:
        raise ValueError("Inferential intervals require all eight process pairs")
    center = _mean(values)
    se = math.sqrt(math.fsum((value - center) ** 2 for value in values) / 56)
    return {"n": 8, "df": 7, "estimate": center, "standard_error": se,
            "lower": center - critical * se, "upper": center + critical * se}


def _ratio(log_value):
    # Extreme synthetic inputs must remain JSON-safe. Decisions use log bounds.
    try:
        return math.exp(log_value)
    except OverflowError:
        return None


def _ratio_interval(log_interval):
    return {"geometric_mean": _ratio(log_interval["estimate"]),
            "lower": _ratio(log_interval["lower"]),
            "upper": _ratio(log_interval["upper"]),
            "log_interval": log_interval,
            "null_ratio_means_float_overflow": True}


def _index_processes(processes):
    index, errors = {}, []
    for process in processes:
        if not isinstance(process, dict):
            errors.append("Malformed process record")
            continue
        key = (process.get("engine"), process.get("pair"), process.get("arm"))
        if (key[0] not in ENGINES or type(key[1]) is not int
                or key[1] not in range(8) or key[2] not in ARMS):
            errors.append("Invalid process identity")
        elif key in index:
            index[key] = None  # Ambiguous identity is never resolved by selection.
            errors.append("Duplicate process identity: " + repr(key))
        else:
            index[key] = process
    return index, errors


def _process_errors(process):
    if not isinstance(process, dict):
        return ["Missing or duplicate process"]
    reasons = process.get("invalid_reasons", [])
    errors = list(reasons) if isinstance(reasons, list) else ["Malformed process invalid_reasons"]
    for field in ("eligible", "identity_ok", "oracle_ok", "backing_ok"):
        if process.get(field) is not True:
            errors.append("Process check failed: " + field)
    return errors


def _endpoint(process, name):
    errors = _process_errors(process)
    endpoints = process.get("endpoints", {}) if process else {}
    endpoint = endpoints.get(name, {}) if isinstance(endpoints, dict) else {}
    if not isinstance(endpoint, dict):
        return None, errors + ["Malformed endpoint"]
    reasons = endpoint.get("invalid_reasons", [])
    errors.extend(reasons if isinstance(reasons, list) else ["Malformed endpoint invalid_reasons"])
    for field in ("eligible", "clock_ok", "checksum_ok"):
        if endpoint.get(field) is not True:
            errors.append("Endpoint check failed: " + field)
    k = endpoint.get("k")
    warmup, measured = endpoint.get("warmup_ms", []), endpoint.get("measured_ms", [])
    ladder = K_LADDER + ((262144, 1048576) if name.split(":")[0] in ("E0", "F128", "F513") else ())
    if type(k) is not int or k not in ladder:
        errors.append("Invalid fixed calibration K")
    if (not isinstance(warmup, list) or len(warmup) != 4
            or not all(_number(value, positive=True) for value in warmup)):
        errors.append("Exactly four finite positive warm-up durations required")
    if (not isinstance(measured, list) or len(measured) != 6
            or not all(_number(value, positive=True) for value in measured)):
        errors.append("Exactly six finite positive measured durations required")
    overhead = endpoint.get("overhead_ms_per_call")
    if not _number(overhead):
        errors.append("Invalid independently recorded empty-bracket overhead")
    if not _number(endpoint.get("clock_resolution_ms"), positive=True):
        errors.append("Unresolved clock resolution")
    if errors:
        return None, errors
    chunks = [value / k for value in measured]
    mean = _mean(chunks)
    observed_brackets = ([value / k for value in warmup + measured]
                         if name in ISOLATED_FIRST else warmup + measured)
    if endpoint["clock_resolution_ms"] > 0.005 * min(observed_brackets):
        return None, ["Clock resolution exceeds 0.5% of a relevant chunk duration"]
    timed_bracket_mean = mean if name in ISOLATED_FIRST else _mean(measured)
    overhead_ratio = overhead / timed_bracket_mean
    if name in ISOLATED_FIRST and overhead_ratio > 0.005:
        return None, ["Empty-bracket overhead exceeds 0.5% of observed bracket time"]
    return {"k": k, "mean_ms": mean, "chunk_means_ms": chunks,
            "warmup_ms": warmup, "measured_ms": measured,
            "overhead_ratio": overhead_ratio,
            "clock_resolution_ms": endpoint["clock_resolution_ms"],
            "diagnostics": endpoint.get("diagnostics", {})}, []


def _latency(index, engine, name, critical):
    pairs, errors = [], []
    for pair in range(8):
        rows = {}
        for arm in ARMS:
            row, row_errors = _endpoint(index.get((engine, pair, arm)), name)
            rows[arm] = row
            errors.extend({"pair": pair, "arm": arm, "reason": reason}
                          for reason in row_errors)
        if rows["baseline"] is not None and rows["candidate"] is not None:
            if rows["baseline"]["k"] != rows["candidate"]["k"]:
                errors.append({"pair": pair, "reason": "Paired K differs"})
            pairs.append({"pair": pair, "arm_order": "AB" if pair % 2 == 0 else "BA",
                          **rows})
    if len({row[arm]["k"] for row in pairs for arm in ARMS}) > 1:
        errors.append({"reason": "K was not frozen across all process pairs"})
    output = {"engine": engine, "endpoint": name, "status": "unresolved",
              "pairs": pairs, "invalid_reasons": errors,
              "unit": "ms per first next" if name in ISOLATED_FIRST else
                      ("ms per first-item-and-close cycle" if name.endswith(":first")
                       else "ms per complete traversal")}
    if errors or len(pairs) != 8 or critical is None:
        return output
    ratios = [row["candidate"]["mean_ms"] / row["baseline"]["mean_ms"] for row in pairs]
    if not all(_number(ratio, positive=True) for ratio in ratios):
        output["invalid_reasons"].append({"reason": "Nonfinite or nonpositive paired ratio"})
        return output
    logs = [math.log(ratio) for ratio in ratios]
    pointwise = _interval(logs, critical["pointwise95"])
    simultaneous = _interval(logs, critical["latency28"])
    if pointwise["lower"] > math.log(1.02):
        output["status"] = "adverse"
    elif simultaneous["upper"] <= math.log(1.02):
        output["status"] = "cleared"
    output.update({"paired_ratios": ratios, "paired_log_ratios": logs,
                   "pointwise_95": _ratio_interval(pointwise),
                   "bonferroni_95_across_28": _ratio_interval(simultaneous),
                   "leave_one_pair_out_geometric_means": [
                       {"omitted_pair": pair,
                        "geometric_mean": _ratio(_mean(logs[:pair] + logs[pair + 1:]))}
                       for pair in range(8)],
                   "order_diagnostic_geometric_means": {
                       "AB": _ratio(_mean(logs[::2])), "BA": _ratio(_mean(logs[1::2]))},
                   "diagnostics_do_not_change_full_sample_decision": True})
    return output


def _memory_process(process, engine):
    errors = _process_errors(process)
    memory = process.get("memory", {}) if process else {}
    if not isinstance(memory, dict):
        return None, errors + ["Malformed memory record"]
    reasons = memory.get("invalid_reasons", [])
    errors.extend(reasons if isinstance(reasons, list) else ["Malformed memory invalid_reasons"])
    if memory.get("eligible") is not True:
        errors.append("Memory attribution/accounting not eligible")
    cycles = memory.get("cycles", [])
    buckets = BUCKETS + (BUN_BUCKETS if engine == "bun" else ())
    primary = "heapUsed" if engine == "node" else "heapSize"
    if not isinstance(cycles, list) or len(cycles) != 2:
        return None, errors + ["Exactly two memory cycles required"]
    for cycle in cycles:
        if not isinstance(cycle, dict):
            errors.append("Malformed memory cycle")
            continue
        if cycle.get("resumed_ok") is not True:
            errors.append("Paused iterator resumability not verified")
        for state in ("before", "paused", "released"):
            if not isinstance(cycle.get(state), dict):
                errors.append("Malformed memory state: " + state)
                continue
            for bucket in buckets:
                if not _number(cycle.get(state, {}).get(bucket)):
                    errors.append("Missing/invalid memory counter: " + state + "/" + bucket)
    high_water = process.get("terminal_high_water_rss_bytes") if process else None
    if not _number(high_water, positive=True):
        errors.append("Missing terminal process high-water RSS")
    if errors:
        return None, errors
    for cycle in cycles:
        if abs(cycle["released"][primary] - cycle["before"][primary]) > RELEASE_LIMIT:
            errors.append("Primary heap release drift exceeds 64 KiB in one cycle")
    for bucket in ("arenaUsedBytes", "arenaCapacityBytes"):
        values = [cycle[state][bucket] for cycle in cycles
                  for state in ("before", "paused", "released")]
        if any(value != values[0] for value in values):
            errors.append("Backing memory changed through iteration: " + bucket)
    if errors:
        return None, errors
    increments = {bucket: _mean([cycle["paused"][bucket] - cycle["before"][bucket]
                                for cycle in cycles]) for bucket in buckets}
    return {"increments": increments,
            "paused": {bucket: _mean([cycle["paused"][bucket] for cycle in cycles])
                       for bucket in buckets},
            "cycles": cycles, "terminal_high_water_rss_bytes": high_water}, []


def _memory(index, engine, critical):
    primary = "heapUsed" if engine == "node" else "heapSize"
    pairs, errors = [], []
    for pair in range(8):
        rows = {}
        for arm in ARMS:
            row, row_errors = _memory_process(index.get((engine, pair, arm)), engine)
            rows[arm] = row
            errors.extend({"pair": pair, "arm": arm, "reason": reason}
                          for reason in row_errors)
        if all(rows[arm] is not None for arm in ARMS):
            pairs.append({"pair": pair, **rows})
    output = {"engine": engine, "primary": primary, "status": "unresolved",
              "pairs": pairs, "invalid_reasons": errors,
              "accounting": "Bun heapSize includes extraMemorySize; external and "
                            "arrayBuffers overlap. No buckets are added or pooled across engines.",
              "accounting_review_required": []}
    if errors or len(pairs) != 8 or critical is None:
        return output
    b = [row["baseline"]["increments"][primary] for row in pairs]
    c = [row["candidate"]["increments"][primary] for row in pairs]
    contrasts = {"baseline_heap": b,
                 "heap_saving": [left - right for left, right in zip(b, c)],
                 "half_baseline_minus_candidate": [0.5 * left - right for left, right in zip(b, c)]}
    for bucket in ("external", "arrayBuffers"):
        contrasts[bucket + "_increase"] = [row["candidate"]["increments"][bucket]
                                            - row["baseline"]["increments"][bucket] for row in pairs]
    intervals = {name: _interval(values, critical["memory10"])
                 for name, values in contrasts.items()}
    material = all(intervals[name]["lower"] > threshold
                   for name, threshold in MATERIALITY.items())
    guards = all(intervals[bucket + "_increase"]["upper"] <= RELEASE_LIMIT
                 for bucket in ("external", "arrayBuffers"))
    ruled_out = [name for name, threshold in MATERIALITY.items()
                 if intervals[name]["upper"] <= threshold]
    if ruled_out:
        output["status"] = "materiality_rejected"
    elif material and guards:
        output["status"] = "conditions_satisfied"
    output.update({"bonferroni_95_across_10": intervals,
                   "paired_arithmetic_contrasts_bytes": contrasts,
                   "materiality_ruled_out": ruled_out,
                   "guard_conditions_satisfied": guards})
    # These are explicitly pointwise diagnostics, outside the ten decision contrasts.
    # They neither exclude samples nor upgrade the prespecified memory/latency tests.
    diagnostics = {}
    buckets = BUCKETS + (BUN_BUCKETS if engine == "bun" else ())
    for bucket in buckets:
        metrics = {}
        for state in ("increments", "paused"):
            baseline = [row["baseline"][state][bucket] for row in pairs]
            candidate = [row["candidate"][state][bucket] for row in pairs]
            difference = _interval([right - left for left, right in zip(baseline, candidate)],
                                   critical["pointwise95"])
            metrics[state] = {"baseline_pointwise_95": _interval(baseline, critical["pointwise95"]),
                              "candidate_pointwise_95": _interval(candidate, critical["pointwise95"]),
                              "candidate_minus_baseline_pointwise_95": difference}
            if difference["lower"] > 0:
                output["accounting_review_required"].append(bucket + ":" + state + ":positive_shift")
        diagnostics[bucket] = metrics
    high_water_b = [row["baseline"]["terminal_high_water_rss_bytes"] for row in pairs]
    high_water_c = [row["candidate"]["terminal_high_water_rss_bytes"] for row in pairs]
    high_water_difference = _interval([right - left for left, right in zip(high_water_b, high_water_c)],
                                      critical["pointwise95"])
    diagnostics["terminal_high_water_rss_bytes"] = {
        "baseline_pointwise_95": _interval(high_water_b, critical["pointwise95"]),
        "candidate_pointwise_95": _interval(high_water_c, critical["pointwise95"]),
        "candidate_minus_baseline_pointwise_95": high_water_difference}
    if high_water_difference["lower"] > 0:
        output["accounting_review_required"].append("terminal_high_water_rss:positive_shift")
    output["bucket_diagnostics_bytes"] = diagnostics
    return output


def analyze(data):
    """Pure in-process analysis; no file access, subprocesses, or target imports.

    The supervisor owns receipt authenticity, calibration/probe checks, source
    identity, phase/resource limits, raw preservation and terminal evidence seals.
    A failed later job does not invalidate otherwise valid complete process pairs.
    """
    prior = data.get("prior_adverse_evidence", [])
    prior_vetoes = [item for item in prior if isinstance(item, dict)
                   and item.get("valid") is True and item.get("source")
                   and item.get("demonstrated_over_two_percent") is True]
    issues = []
    critical = fixed_critical_values()
    schema_ok = data.get("schema") == SCHEMA and data.get("method_sha256") == METHOD_SHA256
    if not schema_ok:
        issues.append("Analysis schema or accepted method identity mismatch")
        critical = None
    processes = data.get("processes", [])
    if not isinstance(processes, list):
        processes = []
        issues.append("Process records must be an array")
    index, index_errors = _index_processes(processes)
    issues.extend(index_errors)
    latency = [_latency(index, engine, endpoint, critical)
               for engine in ENGINES for endpoint in ENDPOINTS]
    memory = [_memory(index, engine, critical) for engine in ENGINES]
    adverse = [{"engine": row["engine"], "endpoint": row["endpoint"]}
               for row in latency if row["status"] == "adverse"]
    veto = bool(adverse or prior_vetoes)
    all_clear = all(row["status"] == "cleared" for row in latency)
    memory_pass = all(row["status"] == "conditions_satisfied" for row in memory)
    rejected = any(row["status"] == "materiality_rejected" for row in memory)
    accounting_review = any(row["accounting_review_required"] for row in memory)
    complete = data.get("complete") is True and data.get("first_failure") is None and not issues
    if veto:
        disposition = "adverse_latency_veto"
    elif rejected:
        disposition = "cross_engine_memory_materiality_rejected"
    elif memory_pass and complete:
        disposition = ("memory_conditions_met_accounting_review_required" if accounting_review
                       else "promising_temporary_heap_lead")
    else:
        disposition = "inconclusive_or_incomplete"
    return {"schema": SCHEMA, "method_sha256": METHOD_SHA256,
            "disposition": disposition, "unchanged_candidate_advancement_veto": veto,
            "valid_adverse_latency_controls": adverse,
            "prior_adverse_evidence": prior,
            "prior_adverse_evidence_vetoes": prior_vetoes,
            "all_28_iteration_controls_cleared": all_clear,
            "both_engine_memory_conditions_satisfied": memory_pass,
            "complete": complete, "first_failure": data.get("first_failure"),
            "analysis_issues": issues, "critical_values": critical,
            "critical_values_provenance_sha256": CRITICAL_PROVENANCE_SHA256,
            "latency": latency, "memory": memory,
            "accounting_explanation_required": accounting_review,
            "assumptions": ["Eight independent process pairs per engine; paired Student-t model.",
                            "The ordinary 95% latency harm veto is not family-error controlled.",
                            "Slow/GC samples, order and leave-one-pair-out diagnostics cannot remove harm."],
            "limits": ["Exploratory raw screen only; independent terminal audit is still required.",
                       "No production promotion or further performance execution is authorized.",
                       "Unresolved controls are not evidence of no regression.",
                       "Startup, import, initialization, descriptor creation and attachment latency are untested.",
                       "A temporary-heap lead is not a total-RAM saving or a cross-engine total-memory estimate.",
                       "RSS and bucket shifts require explanation before calling the lead useful.",
                       "No resampling, replacement processes, interval selection or sample extension."]}
