"""Prospective packed ordered storage analysis; SOURCE PREPARATION ONLY.

Adapted from the accepted ordered-checkpoint analysis and synthetic checks.
Importing this module does not calculate critical values or analyze observations.
The entry point is analyze(data). Independent mathematical values are available;
exact-packet validation and synthetic execution remain pending. See
STATISTICS-PENDING.md.

An inferential endpoint always has eight complete adjacent process pairs.
Invalid observations remain in raw_processes and never produce subset inference.
Slow chunks, natural GC, order and sensitivity diagnostics cannot exclude data.
"""

import math


METHOD_SHA256 = "2ac7f4c1979eef5bf41cb798c4d9a1deb7f3312d987ada61d87b1ded13f65267"
SCHEMA = "packed-ordered-storage-analysis/v1"
ENGINES = ("node", "bun")
ARMS = ("baseline", "candidate")
CASES = ("P", "E0", "F128", "F513", "F100k", "D100k", "O32k")
MEMORY_CASES = ("E0", "N1", "N32", "N4096", "N4097", "N8192", "N8193", "P")
RAW_PAUSE_CASES = frozenset(("N4096", "N4097", "N8192", "N8193", "P"))
ITERATION_ENDPOINTS = tuple(case + ":" + kind for case in CASES for kind in ("first", "full")) + (
    "N4096:close", "N4097:close", "N8193:close", "P:close")
ENDPOINTS = ITERATION_ENDPOINTS + ("startup:import",)
ISOLATED_FIRST = frozenset(case + ":first" for case in ("P", "F100k", "D100k", "O32k"))
BUCKETS = ("heapUsed", "heapTotal", "external", "arrayBuffers", "rss",
           "arenaUsedBytes", "arenaCapacityBytes")
BUN_BUCKETS = ("heapSize", "heapCapacity", "extraMemorySize")
ARENA_BUCKETS = ("arenaUsedBytes", "arenaCapacityBytes")
RELEASE_LIMITS = {"E0": 512, "N1": 512, "N32": 512,
                  "N4096": 2048, "N4097": 2048, "N8192": 2048,
                  "N8193": 2048, "P": 65536}
MEMORY_MARGINS = {"E0": 1024, "N1": 1024, "N32": 1024,
                  "N4096": 4096, "N4097": 4096, "N8192": 4096,
                  "N8193": 4096, "startup:import": 4096}
MATERIALITY = {"baseline_increment": 512 * 1024,
               "retained_saving": 128 * 1024,
               "twenty_percent_reduction": 0}
QUANTILES = {"pointwise95": 1 - 0.05 / 2,
             "latency38": 1 - 0.05 / (2 * 38),
             "memory22": 1 - 0.05 / (2 * 22)}
CRITICAL_VALIDATION_STATUS = "independent_values_verified_exact_packet_validation_pending"
# SHA-256 of statistics/SHA256SUMS, binding the independent REVIEW.md and VALUES.json.
CRITICAL_PROVENANCE_SHA256 = "f7b3d7535e2f1887519e9867e07c585d920c04ffecb3cedd662ebb43885b6752"
CRITICAL_VALUES = {"pointwise95": 2.3646242515927853,
                   "memory22": 4.6755214023824,
                   "latency38": 5.155633357451718}
K_LADDER = (1, 4, 16, 64, 256, 1024, 4096, 16384, 65536)
EXTENDED_K_LADDER = K_LADDER + (262144, 1048576)


def fixed_critical_values():
    """Return prospectively fixed, independently derived two-sided df=7 values.

    Family sizes never shrink after invalid observations. The independent math
    audit used no scientific samples; exact-packet inert verification is pending.
    """
    return dict(CRITICAL_VALUES)


def _number(value, *, positive=False):
    return (type(value) in (int, float) and math.isfinite(value)
            and (value > 0 if positive else value >= 0))


def _sha256(value):
    return (isinstance(value, str) and len(value) == 64
            and all(character in "0123456789abcdef" for character in value))


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
    try:
        return math.exp(log_value)
    except OverflowError:
        return None


def _ratio_interval(interval):
    return {"geometric_mean": _ratio(interval["estimate"]),
            "lower": _ratio(interval["lower"]), "upper": _ratio(interval["upper"]),
            "log_interval": interval, "null_ratio_means_float_overflow": True}


def _reasons(record, label):
    reasons = record.get("invalid_reasons", [])
    return list(reasons) if isinstance(reasons, list) else ["Malformed " + label + " invalid_reasons"]


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
            index[key] = None
            errors.append("Duplicate process identity: " + repr(key))
        else:
            index[key] = process
    return index, errors


def _process_errors(process):
    if not isinstance(process, dict):
        return ["Missing or duplicate process"]
    errors = _reasons(process, "process")
    for field in ("eligible", "identity_ok", "oracle_ok", "backing_ok"):
        if process.get(field) is not True:
            errors.append("Process check failed: " + field)
    return errors


def _endpoint(process, name):
    errors = _process_errors(process)
    endpoints = process.get("endpoints", {}) if isinstance(process, dict) else {}
    endpoint = endpoints.get(name, {}) if isinstance(endpoints, dict) else {}
    if not isinstance(endpoint, dict):
        return None, errors + ["Malformed endpoint"]
    errors.extend(_reasons(endpoint, "endpoint"))
    for field in ("eligible", "clock_ok", "checksum_ok"):
        if endpoint.get(field) is not True:
            errors.append("Endpoint check failed: " + field)
    if endpoint.get("calibration_eligible") is False:
        errors.append("Baseline calibration eligibility failed for this endpoint")
    k = endpoint.get("k")
    warmup, measured = endpoint.get("warmup_ms", []), endpoint.get("measured_ms", [])
    importing = name == "startup:import"
    aggregate_lifecycle = name.endswith(":close") or name.split(":")[0] in ("E0", "F128", "F513")
    ladder = EXTENDED_K_LADDER if aggregate_lifecycle else K_LADDER
    if type(k) is not int or (k != 1 if importing else k not in ladder):
        errors.append("Import requires K=1" if importing else "Invalid fixed calibration K")
    warmup_count, measured_count = (0, 1) if importing else (4, 6)
    if (not isinstance(warmup, list) or len(warmup) != warmup_count
            or not all(_number(value, positive=True) for value in warmup)):
        errors.append("Expected " + str(warmup_count) + " finite positive warm-up durations")
    if (not isinstance(measured, list) or len(measured) != measured_count
            or not all(_number(value, positive=True) for value in measured)):
        errors.append("Expected " + str(measured_count) + " finite positive measured durations")
    overhead = endpoint.get("overhead_ms_per_call")
    if not _number(overhead):
        errors.append("Invalid independently recorded empty-bracket overhead")
    if not _number(endpoint.get("clock_resolution_ms"), positive=True):
        errors.append("Unresolved clock resolution")
    if errors:
        return None, errors
    chunks = [value / k for value in measured]
    mean = _mean(chunks)
    brackets = ([value / k for value in warmup + measured]
                if name in ISOLATED_FIRST else warmup + measured)
    if endpoint["clock_resolution_ms"] > 0.005 * min(brackets):
        return None, ["Clock resolution exceeds 0.5% of a relevant bracket duration"]
    # The subject applies both timer tests to every relevant bracket, including
    # aggregate warm-up/measured brackets and the single import observation.
    overhead_ratio = overhead / min(brackets)
    if overhead_ratio > 0.005:
        return None, ["Empty-bracket overhead exceeds 0.5% of a relevant bracket duration"]
    return {"k": k, "mean_ms": mean, "chunk_means_ms": chunks,
            "warmup_ms": warmup, "measured_ms": measured,
            "overhead_ratio": overhead_ratio, "overhead_rule_applied": True,
            "clock_resolution_ms": endpoint["clock_resolution_ms"],
            "diagnostics": endpoint.get("diagnostics", {})}, []


def _latency(index, engine, name, critical):
    pairs, errors = [], []
    for pair in range(8):
        rows = {}
        for arm in ARMS:
            row, row_errors = _endpoint(index.get((engine, pair, arm)), name)
            rows[arm] = row
            errors.extend({"pair": pair, "arm": arm, "reason": reason} for reason in row_errors)
        if all(rows[arm] is not None for arm in ARMS):
            if rows["baseline"]["k"] != rows["candidate"]["k"]:
                errors.append({"pair": pair, "reason": "Paired K differs"})
            pairs.append({"pair": pair, "arm_order": "AB" if pair % 2 == 0 else "BA", **rows})
    if len({row[arm]["k"] for row in pairs for arm in ARMS}) > 1:
        errors.append({"reason": "K was not frozen across all process pairs"})
    unit = ("ms per fresh-process public-module import" if name == "startup:import" else
            "ms per first next" if name in ISOLATED_FIRST else
            "ms per first-item-and-close cycle" if name.endswith((":first", ":close")) else
            "ms per complete traversal")
    output = {"engine": engine, "endpoint": name, "status": "unresolved",
              "valid": False, "pairs": pairs, "invalid_reasons": errors, "unit": unit}
    if errors or len(pairs) != 8 or critical is None:
        return output
    ratios = [row["candidate"]["mean_ms"] / row["baseline"]["mean_ms"] for row in pairs]
    if not all(_number(ratio, positive=True) for ratio in ratios):
        output["invalid_reasons"].append({"reason": "Nonfinite or nonpositive paired ratio"})
        return output
    logs = [math.log(ratio) for ratio in ratios]
    pointwise = _interval(logs, critical["pointwise95"])
    simultaneous = _interval(logs, critical["latency38"])
    if pointwise["lower"] > math.log(1.02):
        output["status"] = "adverse"
    elif simultaneous["upper"] <= math.log(1.02):
        output["status"] = "cleared"
    output.update({"valid": True, "paired_ratios": ratios, "paired_log_ratios": logs,
                   "pointwise_95": _ratio_interval(pointwise),
                   "bonferroni_95_across_38": _ratio_interval(simultaneous),
                   "leave_one_pair_out_geometric_means": [
                       {"omitted_pair": pair, "geometric_mean": _ratio(_mean(logs[:pair] + logs[pair + 1:]))}
                       for pair in range(8)],
                   "order_diagnostic_geometric_means": {
                       "AB": _ratio(_mean(logs[::2])), "BA": _ratio(_mean(logs[1::2]))},
                   "diagnostics_do_not_change_full_sample_decision": True})
    return output


def _buckets(engine):
    return BUCKETS + (BUN_BUCKETS if engine == "bun" else ())


def _retained_total(state, engine):
    # arrayBuffers is contained in Node external; Bun extra is in heapSize.
    return state["heapUsed"] + state["external"] if engine == "node" else state["heapSize"]


def _state_errors(state, engine, label):
    if not isinstance(state, dict):
        return ["Malformed memory state: " + label]
    return ["Missing/invalid memory counter: " + label + "/" + bucket
            for bucket in _buckets(engine) if not _number(state.get(bucket))]


def _memory_process(process, engine, case):
    errors = _process_errors(process)
    memory = process.get("memory", {}) if isinstance(process, dict) else {}
    if not isinstance(memory, dict):
        return None, errors + ["Malformed memory record"]
    errors.extend(_reasons(memory, "memory"))
    if memory.get("eligible") is not True:
        errors.append("Memory attribution/accounting not eligible")
    cases = memory.get("cases", {})
    record = cases.get(case, {}) if isinstance(cases, dict) else {}
    if not isinstance(record, dict):
        return None, errors + ["Malformed memory case"]
    errors.extend(_reasons(record, "memory case"))
    if record.get("eligible") is not True:
        errors.append("Case attribution/accounting not eligible")
    cycles = record.get("cycles", [])
    expected_count = 2 if case == "P" else 1
    if not isinstance(cycles, list) or len(cycles) != expected_count:
        return None, errors + ["Expected exactly " + str(expected_count) + " memory cycles"]
    for cycle in cycles:
        if not isinstance(cycle, dict):
            errors.append("Malformed memory cycle")
            continue
        if cycle.get("resumed_ok") is not True:
            errors.append("Same iterator resumption/completion not verified")
        for state in ("before", "paused", "released"):
            errors.extend(_state_errors(cycle.get(state), engine, state))
        if case in RAW_PAUSE_CASES:
            errors.extend(_state_errors(cycle.get("rawPaused"), engine, "rawPaused"))
        elif cycle.get("rawPaused") is not None:
            errors.append("Raw-pause row is outside the fixed diagnostic cases")
    high_water = process.get("terminal_high_water_rss_bytes") if isinstance(process, dict) else None
    if not _number(high_water, positive=True):
        errors.append("Missing terminal process high-water RSS")
    if errors:
        return None, errors
    guarded = ("heapUsed", "external") if engine == "node" else ("heapSize", "extraMemorySize")
    for cycle in cycles:
        before, released = cycle["before"], cycle["released"]
        if abs(_retained_total(released, engine) - _retained_total(before, engine)) > RELEASE_LIMITS[case]:
            errors.append("Retained endpoint release drift exceeds fixed case limit")
        for bucket in guarded:
            if abs(released[bucket] - before[bucket]) > RELEASE_LIMITS[case]:
                errors.append("Component release drift exceeds fixed case limit: " + bucket)
    states = ("before", "rawPaused", "paused", "released") if case in RAW_PAUSE_CASES else (
        "before", "paused", "released")
    for bucket in ARENA_BUCKETS:
        values = [cycle[state][bucket] for cycle in cycles for state in states]
        if any(value != values[0] for value in values):
            errors.append("Unique backing memory changed through iteration: " + bucket)
        # All fixtures are live before memory. A different arena snapshot in
        # any fixed case is a backing-integrity failure, never ordinary noise.
        for other in cases.values():
            if not isinstance(other, dict) or not isinstance(other.get("cycles"), list):
                continue
            for other_cycle in other["cycles"]:
                if not isinstance(other_cycle, dict):
                    continue
                for other_state in ("before", "rawPaused", "paused", "released"):
                    snapshot = other_cycle.get(other_state)
                    if isinstance(snapshot, dict) and _number(snapshot.get(bucket)) and snapshot[bucket] != values[0]:
                        errors.append("Unique backing memory changed across cases: " + bucket)
    if errors:
        return None, errors
    metrics = {state: {bucket: _mean([cycle[state][bucket] for cycle in cycles])
                       for bucket in _buckets(engine)} for state in states}
    metrics["increments"] = {bucket: _mean([cycle["paused"][bucket] - cycle["before"][bucket]
                                           for cycle in cycles]) for bucket in _buckets(engine)}
    metrics["release_deltas"] = {bucket: _mean([cycle["released"][bucket] - cycle["before"][bucket]
                                               for cycle in cycles]) for bucket in _buckets(engine)}
    return {"retained_increment": _mean([_retained_total(cycle["paused"], engine)
                                         - _retained_total(cycle["before"], engine) for cycle in cycles]),
            "endpoint_release_deltas": [_retained_total(cycle["released"], engine)
                                        - _retained_total(cycle["before"], engine) for cycle in cycles],
            **metrics, "cycles": cycles, "terminal_high_water_rss_bytes": high_water}, []


def _startup_process(process, engine):
    errors = _process_errors(process)
    record = process.get("startup", {}) if isinstance(process, dict) else {}
    if not isinstance(record, dict):
        return None, errors + ["Malformed startup record"]
    errors.extend(_reasons(record, "startup"))
    if record.get("eligible") is not True:
        errors.append("Startup import-footprint accounting not eligible")
    for state in ("before", "after"):
        errors.extend(_state_errors(record.get(state), engine, "startup/" + state))
    if errors:
        return None, errors
    for bucket in ARENA_BUCKETS:
        if record["before"][bucket] != record["after"][bucket]:
            errors.append("Arena allocation during module-only import: " + bucket)
    if errors:
        return None, errors
    increments = {bucket: record["after"][bucket] - record["before"][bucket] for bucket in _buckets(engine)}
    return {"retained_increment": _retained_total(record["after"], engine)
                                 - _retained_total(record["before"], engine),
            "before": record["before"], "after": record["after"], "increments": increments}, []


def _paired_memory(index, engine, case, critical):
    pairs, errors = [], []
    for pair in range(8):
        rows = {}
        for arm in ARMS:
            process = index.get((engine, pair, arm))
            row, row_errors = (_startup_process(process, engine) if case == "startup:import"
                               else _memory_process(process, engine, case))
            rows[arm] = row
            errors.extend({"pair": pair, "arm": arm, "reason": reason} for reason in row_errors)
        if all(rows[arm] is not None for arm in ARMS):
            pairs.append({"pair": pair, **rows})
    return {"engine": engine, "case": case, "valid": not errors and len(pairs) == 8 and critical is not None,
            "pairs": pairs, "invalid_reasons": errors}


def _contrast(observation, name, values, threshold, benefit, critical):
    output = {"engine": observation["engine"], "endpoint": observation["case"] + ":" + name,
              "case": observation["case"], "contrast": name, "status": "unresolved",
              "valid": observation["valid"], "threshold_bytes": threshold,
              "direction": "strictly_above" if benefit else "at_or_below",
              "invalid_reasons": observation["invalid_reasons"]}
    if not observation["valid"]:
        return output
    pointwise = _interval(values, critical["pointwise95"])
    simultaneous = _interval(values, critical["memory22"])
    if benefit:
        if simultaneous["lower"] > threshold:
            output["status"] = "cleared"
        elif simultaneous["upper"] <= threshold:
            output["status"] = "materiality_rejected"
    elif pointwise["lower"] > threshold:
        output["status"] = "adverse"
    elif simultaneous["upper"] <= threshold:
        output["status"] = "cleared"
    output.update({"paired_arithmetic_contrasts_bytes": values,
                   "pointwise_95": pointwise, "bonferroni_95_across_22": simultaneous,
                   "leave_one_pair_out_means_bytes": [
                       {"omitted_pair": pair, "mean": _mean(values[:pair] + values[pair + 1:])}
                       for pair in range(8)],
                   "diagnostics_do_not_change_full_sample_decision": True})
    return output


def _memory_diagnostics(observation, engine, critical):
    """Pointwise component diagnostics cannot upgrade the fixed 22 decisions."""
    if not observation["valid"]:
        return {}, []
    pairs, case = observation["pairs"], observation["case"]
    states = (("before", "after", "increments") if case == "startup:import" else
              ("before", "paused", "released", "increments", "release_deltas")
              + (("rawPaused",) if case in RAW_PAUSE_CASES else ()))
    diagnostics, signals = {}, []
    for bucket in _buckets(engine):
        diagnostics[bucket] = {}
        for state in states:
            b = [row["baseline"][state][bucket] for row in pairs]
            c = [row["candidate"][state][bucket] for row in pairs]
            delta = _interval([right - left for left, right in zip(b, c)], critical["pointwise95"])
            diagnostics[bucket][state] = {
                "baseline_pointwise_95": _interval(b, critical["pointwise95"]),
                "candidate_pointwise_95": _interval(c, critical["pointwise95"]),
                "candidate_minus_baseline_pointwise_95": delta}
            if bucket not in ARENA_BUCKETS and delta["lower"] > 0:
                signals.append(engine + ":" + case + ":" + bucket + ":" + state + ":positive_shift")
    return diagnostics, signals


def _memory(index, engine, critical):
    observations = [_paired_memory(index, engine, case, critical)
                    for case in MEMORY_CASES + ("startup:import",)]
    contrasts, signals = [], []
    for observation in observations:
        case = observation["case"]
        b = [row["baseline"]["retained_increment"] for row in observation["pairs"]]
        c = [row["candidate"]["retained_increment"] for row in observation["pairs"]]
        if case == "P":
            values = {"baseline_increment": b,
                      "retained_saving": [left - right for left, right in zip(b, c)],
                      "twenty_percent_reduction": [0.8 * left - right for left, right in zip(b, c)]}
            contrasts.extend(_contrast(observation, name, values[name], threshold, True, critical)
                             for name, threshold in MATERIALITY.items())
        else:
            contrasts.append(_contrast(observation, "candidate_minus_baseline",
                                       [right - left for left, right in zip(b, c)],
                                       MEMORY_MARGINS[case], False, critical))
        diagnostics, discovered = _memory_diagnostics(observation, engine, critical)
        observation["bucket_diagnostics_bytes"] = diagnostics
        signals.extend(discovered)
        if not observation["valid"]:
            # Invalid attribution has no inferred component intervals. Its raw
            # states must still be reviewed; absence of diagnostics is no pass.
            signals.append(engine + ":" + case + ":invalid_attribution_review_required")
    p = next(row for row in observations if row["case"] == "P")
    high_water = {}
    if p["valid"]:
        b = [row["baseline"]["terminal_high_water_rss_bytes"] for row in p["pairs"]]
        c = [row["candidate"]["terminal_high_water_rss_bytes"] for row in p["pairs"]]
        delta = _interval([right - left for left, right in zip(b, c)], critical["pointwise95"])
        high_water = {"baseline_pointwise_95": _interval(b, critical["pointwise95"]),
                      "candidate_pointwise_95": _interval(c, critical["pointwise95"]),
                      "candidate_minus_baseline_pointwise_95": delta}
        if delta["lower"] > 0:
            signals.append(engine + ":terminal_high_water_rss:positive_shift")
    benefit = all(row["status"] == "cleared" for row in contrasts if row["case"] == "P")
    all_clear = all(row["status"] == "cleared" for row in contrasts)
    return {"engine": engine, "primary": "heapUsed+external" if engine == "node" else "heapSize",
            "status": "conditions_satisfied" if all_clear else "unresolved",
            "material_primary_benefit": benefit, "all_11_contrasts_cleared": all_clear,
            "all_memory_attribution_valid": all(row["valid"] for row in observations),
            "cases": observations, "contrasts": contrasts,
            "terminal_high_water_rss_diagnostics_bytes": high_water,
            "accounting_review_required": sorted(set(signals)),
            "accounting": ("Node T=heapUsed+external is V8-used heap plus tracked external allocation; "
                           "arrayBuffers is already inside external. Bun J=heapSize already includes "
                           "extraMemorySize. No other buckets are added, and engines are never pooled.")}


def analyze(data):
    """Pure analysis of this candidate's fixed current study; no file/target access.

    The supervisor authenticates admissions, baseline calibration, identity,
    process/resource custody, correctness, raw preservation and terminal seals.
    Critical values need an independent exact-packet audit before any execution.
    A later failed job cannot erase an independently complete valid harm result.
    """
    issues = []
    critical = fixed_critical_values()
    if data.get("schema") != SCHEMA or data.get("method_sha256") != METHOD_SHA256:
        issues.append("Analysis schema or accepted method identity mismatch")
        critical = None
    if data.get("prior_adverse_evidence"):
        issues.append("Historical/prior-candidate evidence is outside this study and was not pooled")
    processes = data.get("processes", [])
    if not isinstance(processes, list):
        processes = []
        issues.append("Process records must be an array")
    index, index_errors = _index_processes(processes)
    issues.extend(index_errors)
    process_validity_failures = [
        {"engine": engine, "pair": pair, "arm": arm, "invalid_reasons": errors}
        for engine in ENGINES for pair in range(8) for arm in ARMS
        if (errors := _process_errors(index.get((engine, pair, arm))))]
    latency = [_latency(index, engine, endpoint, critical) for engine in ENGINES for endpoint in ENDPOINTS]
    memory = [_memory(index, engine, critical) for engine in ENGINES]
    contrasts = [row for engine in memory for row in engine["contrasts"]]
    adverse_latency = [{"engine": row["engine"], "endpoint": row["endpoint"]}
                       for row in latency if row["status"] == "adverse"]
    adverse_memory = [{"engine": row["engine"], "endpoint": row["endpoint"],
                       "margin_bytes": row["threshold_bytes"]}
                      for row in contrasts if row["status"] == "adverse"]
    veto = bool(adverse_latency or adverse_memory)
    all_signals = sorted({signal for engine in memory for signal in engine["accounting_review_required"]})
    reviews = data.get("accounting_shift_reviews", [])
    if not isinstance(reviews, list):
        reviews = []
        issues.append("Accounting-shift reviews must be an array")
    explained = {review.get("signal") for review in reviews if isinstance(review, dict)
                 and isinstance(review.get("signal"), str) and review.get("explained") is True
                 and isinstance(review.get("rationale"), str) and review["rationale"].strip()
                 and isinstance(review.get("source"), str) and review["source"].strip()}
    unexplained = [signal for signal in all_signals if signal not in explained]
    raw_review = data.get("raw_accounting_review")
    raw_evidence_sha256 = data.get("raw_evidence_sha256")
    raw_review_accepted = (
        isinstance(raw_review, dict) and raw_review.get("accepted") is True
        and raw_review.get("method_sha256") == METHOD_SHA256
        and _sha256(raw_evidence_sha256)
        and raw_review.get("raw_evidence_sha256") == raw_evidence_sha256
        and isinstance(raw_review.get("source"), str) and bool(raw_review["source"].strip())
        and isinstance(raw_review.get("rationale"), str) and bool(raw_review["rationale"].strip()))
    complete = (data.get("complete") is True and data.get("first_failure") is None
                and not issues and not process_validity_failures)
    all_attribution = all(row["all_memory_attribution_valid"] for row in memory)
    node_benefit, bun_benefit = (row["material_primary_benefit"] for row in memory)
    all_latency = all(row["status"] == "cleared" for row in latency)
    all_memory = all(row["status"] == "cleared" for row in contrasts)
    # A valid full-eight-pair Node P benefit is required. A reviewed invalid
    # nonprimary/Bun case stays invalid and uncleared but need not suppress a
    # strictly Node-only provisional lead. Raw accounting review is mandatory
    # even when diagnostics found no positive shifts. It grants no publication.
    scoped = complete and node_benefit and not veto and not unexplained and raw_review_accepted
    strong = scoped and all_attribution and all_memory and all_latency
    if veto:
        disposition = "material_adverse_control_veto"
    elif not complete:
        disposition = "inconclusive_or_incomplete"
    elif node_benefit and (unexplained or not raw_review_accepted):
        disposition = "node_benefit_accounting_review_required"
    elif strong:
        disposition = "strong_scoped_screen_clearance"
    elif scoped:
        disposition = "scoped_node_retained_memory_lead"
    else:
        disposition = "inconclusive_or_materiality_not_met"
    return {"schema": SCHEMA, "method_sha256": METHOD_SHA256, "disposition": disposition,
            "unchanged_candidate_advancement_veto": veto,
            "valid_adverse_latency_controls": adverse_latency,
            "valid_adverse_memory_controls": adverse_memory,
            "scoped_node_lead_eligible": scoped, "strong_scoped_screen_clearance": strong,
            "bun_material_benefit_corroborated": (complete and memory[1]["all_memory_attribution_valid"]
                                                 and bun_benefit and raw_review_accepted
                                                 and not unexplained and not veto),
            "all_38_latency_controls_cleared": complete and all_latency,
            "all_22_memory_contrasts_cleared": complete and all_memory,
            "complete": complete, "first_failure": data.get("first_failure"),
            "analysis_issues": issues, "process_validity_failures": process_validity_failures,
            "critical_values": critical, "critical_quantiles": dict(QUANTILES),
            "critical_values_validation_status": CRITICAL_VALIDATION_STATUS,
            "critical_values_provenance_sha256": CRITICAL_PROVENANCE_SHA256,
            "separate_95_percent_families": {"latency": 38, "memory": 22},
            "latency": latency, "memory": memory, "memory_contrasts": contrasts,
            "unresolved_latency_controls": [{"engine": row["engine"], "endpoint": row["endpoint"],
                                               "valid": row["valid"], "invalid_reasons": row["invalid_reasons"]}
                                              for row in latency if row["status"] == "unresolved"],
            "uncleared_memory_contrasts": [{"engine": row["engine"], "endpoint": row["endpoint"],
                                              "status": row["status"], "valid": row["valid"],
                                              "invalid_reasons": row["invalid_reasons"]}
                                             for row in contrasts if row["status"] != "cleared"],
            "accounting_shift_signals": all_signals, "accounting_shift_reviews": reviews,
            "unexplained_accounting_shifts": unexplained,
            "raw_evidence_sha256": raw_evidence_sha256,
            "raw_accounting_review": raw_review,
            "raw_accounting_review_accepted": raw_review_accepted,
            "accounting_explanation_required": bool(unexplained) or not raw_review_accepted,
            "raw_processes": processes,
            "historical_evidence_not_pooled": True,
            "assumptions": ["Eight independent process pairs per engine; paired Student-t model, df=7.",
                            "Memory22 and latency38 are separate 95% families, not a joint 95% guarantee.",
                            "Ordinary 95% adverse-control vetoes are not family-error controlled.",
                            "Slow/GC samples, order and leave-one-pair-out diagnostics cannot remove harm."],
            "limits": ["Source-only preparation; exact-packet statistical validation is pending.",
                       "No execution, publication, promotion or follow-on performance study is authorized.",
                       "Terminal integrity and scientific interpretation require independent audit.",
                       "Unresolved controls are not passes; invalid evidence supplies no positive support.",
                       "A scoped Node lead is provisional and must list every unresolved control and Bun limitation.",
                       "Node T and Bun J are bounded accounting scopes, neither complete process RAM nor pooled totals.",
                       "Raw-pause rows, sampled RSS and high-water RSS cannot establish conversion peak reduction.",
                       "Import endpoints measure fresh-process module import, not machine-cold application startup.",
                       "No resampling, replacement processes, reduced families or sample extension."]}
