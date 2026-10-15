"""Pure prospective protocol arithmetic; no subject imports, clocks, or I/O.

JSON field names match protocol.mjs. Python call sites may use snake_case helper
names; camelCase aliases are provided for cross-language review.
"""

import hashlib
import json
import math


ENGINES = ["node", "bun"]
VARIANTS = ["baseline", "candidate"]
LIMITS = {
    "rounds": 16, "warmupBatches": 8, "measuredBatches": 4, "verificationBatches": 3,
    "countAlignment": 16_384, "minimumCount": 16_384, "maximumCount": 16_777_216,
    "pilotCounts": [262_144, 1_048_576, 4_194_304, 16_777_216],
    "pilotLadderCountSum": 22_282_240, "maximumPilotReads": 66_846_720, "pilotWarmupBatches": 8, "pilotSampleBatches": 3,
    "maximumCalibrationBatches": 55, "maximumCalibrationReads": 429_654_016, "pilotMinimumNs": 5_000_000,
    "pilotMaximumNs": 200_000_000, "targetNs": 20_000_000,
    "verificationMinimumNs": 16_000_000, "verificationMaximumNs": 40_000_000,
    "readMinimumNs": 8_000_000, "clockMultiplier": 1_000,
    "clockDeltaCount": 10_000, "clockPairCount": 1_000,
    "cvLimit": 0.05, "warmupDriftLimit": 0.03, "measuredDriftLimit": 0.05,
    "primaryUpperRatio": 0.95, "controlPointRatio": 1, "controlUpperRatio": 1.02,
    "t15": 2.131449545559323, "validationChildren": 4, "calibrationChildren": 12,
    "mainChildren": 384, "totalChildren": 400, "maximumEntries": 32_768,
    "maximumExtraQueryStrings": 4_096, "rssBytes": 1_073_741_824,
    "childSeconds": 10, "studySeconds": 600, "minimumSetupSeconds": 0.5,
    "feasibilityHeadroom": 1.5, "analysisSeconds": 30,
    "validationBufferBytes": 268_435_456, "validationInputEntries": 41_472,
    "validationWriterHandles": 30, "validationReaderHandles": 12,
    "validationStartupHandles": 2, "validationSnapshotHandles": 44,
    "validationPayloadBuffers": 24, "validationReaderBuffers": 12,
    "validationSetOperations": 12, "validationDeleteOperations": 6,
}

MISS_HASH = "637f3d4acc8590ffbafc3a6b4247e6e72a423aee4abccc1b3f8ead8d7307ede2"
SMALL_HASH = "4dbaddaae9a6652f48eac1be0d1f29f7516d6d4f6748c2ceb31052093c94b694"
_CASE_ROWS = [
    ("P1", "sole-primary", "get", 128, 100000, 104096, 0, SMALL_HASH, MISS_HASH, 4096),
    ("P2", "supporting-miss", "has", 256, 100000, 104096, 0,
     "cc389e4e6112337e00a2df4e3a88d398013a8d8c7dbc58a08057a6a257a677d5", MISS_HASH, 0),
    ("C1", "dense-nonzero-miss-control", "get", 8192, 100000, 104096, 0,
     "cf12e855c52cdda1e5d98f36102b3123e90f49dee0c6e058087a29b99bb8cdda", MISS_HASH, 4096),
    ("C2", "saturated-hit-control", "get", 32768, 16384, 32768, 16384,
     "d26d73428a9d9ddaa8327122e2b54645e275d05458b6ccf01d920bb73abde737",
     "9f2b8afd0d61bc16dda9da2bd49a821d43ceaf62e32b06ea2ce66c6b928f9076", 402661376),
    ("C3", "cached-hit-control", "get", 128, 0, 128, 128, SMALL_HASH,
     "c8345917d3d4671442cc10dfb0b3416bd439b0c71014536d0a5ad1f6d969ca56", 8256),
    ("C4", "empty-control", "get", 0, 100000, 104096, 0,
     "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", MISS_HASH, 4096),
]
_CASE_FIELDS = ("id", "role", "operation", "entryCount", "queryStart", "queryStop",
                "seedCount", "entryArraySha256", "queryArraySha256", "expectedChecksumPerPass")
CASES = [dict(zip(_CASE_FIELDS, row)) for row in _CASE_ROWS]
for _case in CASES:
    _case["queryCount"] = _case["queryStop"] - _case["queryStart"]
_CASE_BY_ID = {case["id"]: case for case in CASES}
_MISSING = object()


def _get(value, key, default=None):
    return value.get(key, default) if isinstance(value, dict) else default


def _finite(value):
    # JS Number.isFinite rejects booleans, null, and numeric strings.
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def positive(value):
    return _finite(value) and value > 0


def nonnegative(value):
    return _finite(value) and value >= 0


def count_valid(value):
    return (_finite(value) and value == math.trunc(value)
            and LIMITS["minimumCount"] <= value <= LIMITS["maximumCount"]
            and value % LIMITS["countAlignment"] == 0)


def average(values):
    # Centering preserves an exact repeated value and reduces cancellation.
    return values[0] + sum((value - values[0] for value in values), 0.0) / len(values)


def median(values):
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def _key_value(value):
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return str(int(value))
    return str(value)


def cell_key(value):
    return "/".join(_key_value(_get(value, key, _MISSING))
                    for key in ("round", "caseId", "engine", "variant"))


def group_key(value):
    return "/".join(_key_value(_get(value, key, _MISSING)) for key in ("caseId", "engine"))


def schedule():
    result = []
    for round_index in range(LIMITS["rounds"]):
        for visit in range(len(CASES)):
            case_index = (round_index + visit) % len(CASES)
            case_id = CASES[case_index]["id"]
            engines = ENGINES[::-1] if round_index % 2 else ENGINES
            for engine in engines:
                engine_index = ENGINES.index(engine)
                variants = VARIANTS[::-1] if (round_index + case_index + engine_index) % 2 else VARIANTS
                for variant in variants:
                    result.append({"round": round_index, "caseId": case_id,
                                   "engine": engine, "variant": variant})
    return result


def _sha256(value):
    serialized = json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def fixture(case_id, absent_queries=_MISSING):
    definition = _CASE_BY_ID.get(case_id)
    if definition is None:
        raise ValueError(f"Unknown case: {case_id}")
    entries = [[f"k{index:07d}", index + 1] for index in range(definition["entryCount"])]
    if absent_queries is not _MISSING:
        if (not isinstance(absent_queries, list) or len(absent_queries) != 4096
                or _sha256(absent_queries) != MISS_HASH):
            raise ValueError("Invalid shared absent-query array")
    if definition["queryStart"] == 100000 and absent_queries is not _MISSING:
        queries = absent_queries
    else:
        queries = [entries[index][0] if index < len(entries) else f"k{index:07d}"
                   for index in range(definition["queryStart"], definition["queryStop"])]
    seed_keys = [entry[0] for entry in entries[:definition["seedCount"]]]
    entry_hash, query_hash = _sha256(entries), _sha256(queries)
    if entry_hash != definition["entryArraySha256"] or query_hash != definition["queryArraySha256"]:
        raise ValueError(f"Fixture expansion hash mismatch: {case_id}")
    return {**definition, "entries": entries, "queries": queries, "seedKeys": seed_keys,
            "entryArraySha256": entry_hash, "queryArraySha256": query_hash}


def choose_count(stages, clock):
    def unresolved(reason, next_count=None):
        return {"resolved": False, "clear": False, "N": None, "reason": reason,
                "pending": next_count is not None, "nextCount": next_count}

    if _get(clock, "clear") is not True:
        return unresolved("invalid-calibration-clock")
    if not isinstance(stages, list) or len(stages) > len(LIMITS["pilotCounts"]):
        return unresolved("invalid-pilot-sequence")
    for index, stage in enumerate(stages):
        def valid_batch(batch):
            return (_get(batch, "count") == stage["count"] and positive(_get(batch, "ns"))
                    and _get(batch, "checksumValid") is True)
        if (_get(stage, "count") != LIMITS["pilotCounts"][index]
                or not isinstance(_get(stage, "warmup"), list)
                or len(stage["warmup"]) != LIMITS["pilotWarmupBatches"]
                or not all(valid_batch(batch) for batch in stage["warmup"])):
            return unresolved("invalid-pilot-sequence")
        if not readiness([batch["ns"] for batch in stage["warmup"]])["clear"]:
            return unresolved("pilot-warmup-unready")
        if (not isinstance(_get(stage, "pilots"), list)
                or len(stage["pilots"]) > LIMITS["pilotSampleBatches"]
                or not all(valid_batch(batch) for batch in stage["pilots"])):
            return unresolved("invalid-pilot-sequence")
        if any(batch["ns"] > LIMITS["pilotMaximumNs"] for batch in stage["pilots"]):
            return unresolved("pilot-exceeds-200ms")
        if len(stage["pilots"]) != LIMITS["pilotSampleBatches"]:
            return unresolved("invalid-pilot-sequence")
        pilot_median_ns = median([batch["ns"] for batch in stage["pilots"]])
        if pilot_median_ns >= LIMITS["pilotMinimumNs"]:
            if index != len(stages) - 1:
                return unresolved("pilots-after-first-usable-pilot")
            predicted = stage["count"] * LIMITS["targetNs"] / pilot_median_ns
            count = min(LIMITS["maximumCount"], max(LIMITS["minimumCount"],
                        math.ceil(predicted / LIMITS["countAlignment"]) * LIMITS["countAlignment"]))
            return {"resolved": True, "clear": True, "N": count, "reason": None,
                    "pending": False, "nextCount": None, "selectedPilotIndex": index,
                    "pilotMedianNs": pilot_median_ns, "predictedCount": predicted}
    return (unresolved("no-pilot-reaches-5ms") if len(stages) == len(LIMITS["pilotCounts"])
            else unresolved("awaiting-next-pilot", LIMITS["pilotCounts"][len(stages)]))


def describe(values):
    valid = isinstance(values, list) and all(_finite(value) for value in values)
    count = len(values) if isinstance(values, list) else 0
    if not valid or not count:
        return {"valid": valid, "count": count, "mean": None, "median": None,
                "sd": None, "cv": None, "min": None, "max": None}
    mean = average(values)
    sd = math.sqrt(sum(((value - mean) ** 2 for value in values), 0.0) / (count - 1)) if count > 1 else None
    return {"valid": True, "count": count, "mean": mean, "median": median(values),
            "sd": sd, "cv": None if sd is None or mean == 0 else sd / abs(mean),
            "min": min(values), "max": max(values)}


def readiness(batch_ns, measured=False):
    expected = LIMITS["measuredBatches"] if measured else LIMITS["warmupBatches"]
    if not isinstance(batch_ns, list) or len(batch_ns) != expected or not all(map(positive, batch_ns)):
        return {"clear": False, "reason": "invalid-batch-count-or-duration", "cv": None, "drift": None}
    last_four = batch_ns[-4:]
    statistics = describe(last_four)
    first_two_mean, last_two_mean = average(last_four[:2]), average(last_four[2:])
    drift = abs(last_two_mean - first_two_mean) / first_two_mean
    drift_limit = LIMITS["measuredDriftLimit"] if measured else LIMITS["warmupDriftLimit"]
    clear = statistics["cv"] <= LIMITS["cvLimit"] and drift <= drift_limit
    return {"clear": clear, "reason": None if clear else "batch-variation-or-drift",
            "cv": statistics["cv"], "drift": drift, "firstTwoMean": first_two_mean,
            "lastTwoMean": last_two_mean, "statistics": statistics,
            "cvLimit": LIMITS["cvLimit"], "driftLimit": drift_limit}


def clock_summary(deltas_ns, pairs_ns):
    valid = (isinstance(deltas_ns, list) and len(deltas_ns) == LIMITS["clockDeltaCount"]
             and all(map(nonnegative, deltas_ns)) and isinstance(pairs_ns, list)
             and len(pairs_ns) == LIMITS["clockPairCount"] and all(map(nonnegative, pairs_ns)))
    if not valid:
        return {"clear": False, "reason": "invalid-clock-sample-count-or-duration",
                "minPositiveNs": None, "medianDeltaNs": None, "p99DeltaNs": None, "medianPairNs": None}
    positives = list(filter(positive, deltas_ns))
    min_positive_ns = min(positives) if positives else None
    median_pair_ns = median(pairs_ns)
    clear = positive(min_positive_ns) and positive(median_pair_ns)
    return {"clear": clear, "reason": None if clear else "missing-positive-clock-estimate",
            "minPositiveNs": min_positive_ns, "medianDeltaNs": median(deltas_ns),
            "p99DeltaNs": sorted(deltas_ns)[math.ceil(len(deltas_ns) * 0.99) - 1],
            "medianPairNs": median_pair_ns, "deltaCount": len(deltas_ns), "pairCount": len(pairs_ns),
            "deltas": describe(deltas_ns), "pairs": describe(pairs_ns)}


def clock_floor(clock):
    if (_get(clock, "clear") is not False and positive(_get(clock, "minPositiveNs"))
            and positive(_get(clock, "medianPairNs"))):
        return LIMITS["clockMultiplier"] * max(clock["minPositiveNs"], clock["medianPairNs"])
    return None


def read_resolution(batch_ns, clock):
    clock_minimum_ns = clock_floor(clock)
    minimum_ns = None if clock_minimum_ns is None else max(LIMITS["readMinimumNs"], clock_minimum_ns)
    clear = (minimum_ns is not None and isinstance(batch_ns, list)
             and len(batch_ns) == LIMITS["measuredBatches"]
             and all(positive(ns) and ns >= minimum_ns for ns in batch_ns))
    return {"clear": clear, "reason": None if clear else "missing-clock-or-short-read-batch",
            "minimumNs": minimum_ns, "clockMinimumNs": clock_minimum_ns,
            "absoluteMinimumNs": LIMITS["readMinimumNs"]}


def startup_resolution(ns, clock):
    minimum_ns = clock_floor(clock)
    clear = minimum_ns is not None and positive(ns) and ns > minimum_ns
    return {"clear": clear, "reason": None if clear else "missing-clock-or-short-startup",
            "minimumNs": minimum_ns}


def feasibility(calibrations, elapsed_seconds):
    """Forecast all remaining main children from exactly 12 baseline calibrations."""
    errors, seen, cells = [], set(), []
    if not nonnegative(elapsed_seconds):
        errors.append("invalid-elapsed-seconds")
    if not isinstance(calibrations, list) or len(calibrations) != LIMITS["calibrationChildren"]:
        errors.append("expected-12-baseline-calibrations")
    for calibration in calibrations if isinstance(calibrations, list) else []:
        key = group_key(calibration)
        case_id, engine = _get(calibration, "caseId"), _get(calibration, "engine")
        if (_get(calibration, "variant") != "baseline" or case_id not in [case["id"] for case in CASES]
                or engine not in ENGINES or key in seen):
            errors.append("invalid-or-duplicate-baseline-calibration")
            continue
        seen.add(key)
        batches = calibration.get("verification")
        verification = [_get(batch, "ns") for batch in batches] if isinstance(batches, list) else []
        if (not nonnegative(calibration.get("launchStartupSetupNs"))
                or len(verification) != LIMITS["verificationBatches"] or not all(map(positive, verification))):
            errors.append(f"invalid-feasibility-observation:{key}")
            continue
        verification_median_ns = median(verification)
        setup_seconds = max(LIMITS["minimumSetupSeconds"], calibration["launchStartupSetupNs"] / 1e9)
        batch_seconds = max(LIMITS["targetNs"] / 1e9, verification_median_ns / 1e9)
        cells.append({"caseId": case_id, "engine": engine, "setupSeconds": setup_seconds,
                      "batchSeconds": batch_seconds, "verificationMedianNs": verification_median_ns})
    if len(seen) != LIMITS["calibrationChildren"]:
        errors.append("incomplete-calibration-grid")
    valid = not errors
    # Keep JS left-to-right accumulation, including its rounding at boundaries.
    total = 0.0
    for cell in cells:
        total = total + cell["setupSeconds"] + 12 * cell["batchSeconds"]
    forecast_seconds = 32 * total if valid else None
    reserved_main_seconds = LIMITS["feasibilityHeadroom"] * forecast_seconds if valid else None
    projected_total_seconds = elapsed_seconds + reserved_main_seconds + LIMITS["analysisSeconds"] if valid else None
    clear = valid and projected_total_seconds <= LIMITS["studySeconds"]
    return {"clear": clear, "reason": None if clear else "budget-infeasible" if valid else "invalid-calibration-input",
            "errors": errors, "cells": cells, "elapsedSeconds": elapsed_seconds,
            "forecastSeconds": forecast_seconds, "reservedMainSeconds": reserved_main_seconds,
            "analysisSeconds": LIMITS["analysisSeconds"], "projectedTotalSeconds": projected_total_seconds,
            "deadlineSeconds": LIMITS["studySeconds"]}


def fixed_interval(log_ratios, allow_inference):
    ready = allow_inference and len(log_ratios) == LIMITS["rounds"] and all(map(_finite, log_ratios))
    if not ready:
        return {"n": sum(map(_finite, log_ratios)), "df": None, "t": None,
                "logMean": None, "logSd": None,
                "ratio": {"point": None, "lower": None, "upper": None},
                "gain": {"point": None, "lower": None, "upper": None}}
    statistics = describe(log_ratios)
    half_width = LIMITS["t15"] * statistics["sd"] / math.sqrt(LIMITS["rounds"])
    ratio = {"point": math.exp(statistics["mean"]), "lower": math.exp(statistics["mean"] - half_width),
             "upper": math.exp(statistics["mean"] + half_width)}
    return {"n": LIMITS["rounds"], "df": 15, "t": LIMITS["t15"], "logMean": statistics["mean"],
            "logSd": statistics["sd"], "ratio": ratio,
            "gain": {"point": 1 - ratio["point"], "lower": 1 - ratio["upper"], "upper": 1 - ratio["lower"]}}


def batch_integrity(batches, count, definition, expected_length):
    if not count_valid(count) or not isinstance(batches, list) or len(batches) != expected_length:
        return False
    checksum = definition["expectedChecksumPerPass"] * (count / definition["queryCount"])
    return all(positive(_get(batch, "ns")) and _get(batch, "count") == count
               and _finite(_get(batch, "checksum")) and batch["checksum"] == checksum for batch in batches)


def read_observation(receipt, definition):
    if receipt is None:
        return None
    warmup_batches, measured_batches = _get(receipt, "warmup"), _get(receipt, "measured")
    warmup_ns = [_get(batch, "ns") for batch in warmup_batches] if isinstance(warmup_batches, list) else []
    measured_ns = [_get(batch, "ns") for batch in measured_batches] if isinstance(measured_batches, list) else []
    count = _get(receipt, "N")
    batch_clear = (batch_integrity(warmup_batches, count, definition, LIMITS["warmupBatches"])
                   and batch_integrity(measured_batches, count, definition, LIMITS["measuredBatches"]))
    warmup, measured = readiness(warmup_ns), readiness(measured_ns, True)
    resolution = read_resolution(measured_ns, _get(receipt, "clock"))
    usable_time = count_valid(count) and len(measured_ns) == LIMITS["measuredBatches"] and all(map(positive, measured_ns))
    total_ns = sum(measured_ns, 0.0) if usable_time else None
    return {"N": count, "batchNs": measured_ns, "totalNs": total_ns,
            "nsPerRead": None if total_ns is None else total_ns / (LIMITS["measuredBatches"] * count),
            "qualityClear": (_get(receipt, "complete") is not False and _get(receipt, "qualityClear") is True and batch_clear
                             and warmup["clear"] and measured["clear"] and resolution["clear"]),
            "batchClear": batch_clear, "warmup": warmup, "measured": measured, "resolution": resolution}


def outcome(interval, quality_clear, primary):
    point, lower, upper = (interval["ratio"][key] for key in ("point", "lower", "upper"))
    inferential = all(map(positive, (point, lower, upper)))
    confident_adverse = quality_clear and inferential and lower > LIMITS["controlUpperRatio"]
    qualifies = primary and quality_clear and inferential and upper <= LIMITS["primaryUpperRatio"]
    control_clear = (not primary and quality_clear and inferential
                     and point <= LIMITS["controlPointRatio"] and upper <= LIMITS["controlUpperRatio"])
    status = "blocked" if confident_adverse else "qualifying" if qualifies else "clear" if control_clear else "unresolved"
    return {"confidentAdverse": confident_adverse, "qualifies": qualifies,
            "controlClear": control_clear, "status": status}


def summarize(main_receipts):
    """Preserve launch order and every endpoint; never infer from a reduced n."""
    expected = schedule()
    receipts = main_receipts if isinstance(main_receipts, list) else []
    errors, by_key = [], {}
    if not isinstance(main_receipts, list) or len(receipts) != len(expected):
        errors.append("incomplete-or-extra-main-schedule")
    for index, receipt in enumerate(receipts):
        if receipt is None or index >= len(expected) or cell_key(receipt) != cell_key(expected[index]):
            errors.append(f"schedule-mismatch:{index}")
        if receipt is None:
            continue
        key = cell_key(receipt)
        if key in by_key:
            errors.append(f"duplicate-cell:{key}")
            by_key[key] = None  # Never silently select a duplicate observation.
        else:
            by_key[key] = receipt
    schedule_clear = not errors
    read_endpoints = []
    for definition in CASES:
        for engine in ENGINES:
            pairs = []
            for round_index in range(LIMITS["rounds"]):
                base = {"round": round_index, "caseId": definition["id"], "engine": engine}
                baseline, candidate = (read_observation(by_key.get(cell_key({**base, "variant": variant})), definition)
                                       for variant in VARIANTS)
                usable = (positive(_get(baseline, "nsPerRead")) and positive(_get(candidate, "nsPerRead"))
                          and baseline["N"] == candidate["N"])
                ratio = candidate["nsPerRead"] / baseline["nsPerRead"] if usable else None
                pairs.append({"round": round_index, "baseline": baseline, "candidate": candidate,
                              "ratio": ratio, "logRatio": math.log(ratio) if ratio is not None else None})
            counts = [_get(pair[variant], "N") for pair in pairs for variant in VARIANTS]
            count_clear = len(counts) == 32 and all(count_valid(count) and count == counts[0] for count in counts)
            quality_clear = (schedule_clear and count_clear
                             and all(_get(pair["baseline"], "qualityClear") and _get(pair["candidate"], "qualityClear")
                                     for pair in pairs))
            interval = fixed_interval([pair["logRatio"] for pair in pairs], schedule_clear)
            statistics = {}
            for variant in VARIANTS:
                observations = [pair[variant] for pair in pairs if pair[variant] is not None]
                batches = [ns for observation in observations for ns in observation["batchNs"] if positive(ns)]
                processes = [observation["totalNs"] for observation in observations if positive(observation["totalNs"])]
                ns_per_read = [observation["nsPerRead"] for observation in observations if positive(observation["nsPerRead"])]
                statistics[variant] = {"batchNs": describe(batches), "batchMs": describe([ns / 1e6 for ns in batches]),
                                       "processNs": describe(processes), "processMs": describe([ns / 1e6 for ns in processes]),
                                       "nsPerRead": describe(ns_per_read)}
            read_endpoints.append({"kind": "read", "caseId": definition["id"], "engine": engine,
                                   "role": definition["role"], "qualityClear": quality_clear,
                                   "countClear": count_clear, "pairs": pairs,
                                   "pairedRatios": [pair["ratio"] for pair in pairs],
                                   "pairedLogRatios": [pair["logRatio"] for pair in pairs],
                                   "statistics": statistics, **interval,
                                   **outcome(interval, quality_clear, definition["id"] == "P1")})
    startup_endpoints = []
    for engine in ENGINES:
        for metric in ("spawnToReadyNs", "importToReadyNs"):
            rounds = []
            for round_index in range(LIMITS["rounds"]):
                constituents = []
                for definition in CASES:
                    base = {"round": round_index, "caseId": definition["id"], "engine": engine}
                    observations = {}
                    for variant in VARIANTS:
                        receipt = by_key.get(cell_key({**base, "variant": variant}))
                        if receipt is None:
                            observations[variant] = None
                            continue
                        ns = _get(_get(receipt, "startup"), metric)
                        clock = _get(receipt, "supervisorClock" if metric == "spawnToReadyNs" else "clock")
                        resolution = startup_resolution(ns, clock)
                        observations[variant] = {"ns": ns if positive(ns) else None, "resolution": resolution,
                                                 "qualityClear": (_get(receipt, "complete") is not False and resolution["clear"])}
                    usable = positive(_get(observations["baseline"], "ns")) and positive(_get(observations["candidate"], "ns"))
                    ratio = observations["candidate"]["ns"] / observations["baseline"]["ns"] if usable else None
                    constituents.append({"caseId": definition["id"], **observations,
                                         "ratio": ratio, "logRatio": None if ratio is None else math.log(ratio)})
                logs = [constituent["logRatio"] for constituent in constituents]
                log_ratio = average(logs) if all(map(_finite, logs)) else None
                rounds.append({"round": round_index, "constituents": constituents, "logRatio": log_ratio,
                               "ratio": None if log_ratio is None else math.exp(log_ratio)})
            quality_clear = (schedule_clear and all(_get(c["baseline"], "qualityClear") and _get(c["candidate"], "qualityClear")
                                                   for row in rounds for c in row["constituents"]))
            interval = fixed_interval([row["logRatio"] for row in rounds], schedule_clear)
            statistics = {}
            for variant in VARIANTS:
                times = [_get(c[variant], "ns") for row in rounds for c in row["constituents"]
                         if positive(_get(c[variant], "ns"))]
                statistics[variant] = {"observationNs": describe(times), "observationMs": describe([ns / 1e6 for ns in times])}
            startup_endpoints.append({"kind": "startup", "engine": engine, "metric": metric,
                                      "qualityClear": quality_clear, "rounds": rounds, "statistics": statistics,
                                      "pairedRatios": [row["ratio"] for row in rounds],
                                      "pairedLogRatios": [row["logRatio"] for row in rounds],
                                      **interval, **outcome(interval, quality_clear, False)})
    endpoints = read_endpoints + startup_endpoints
    quality_clear = schedule_clear and all(endpoint["qualityClear"] for endpoint in endpoints)
    study_integrity_clear = (schedule_clear and all(_get(r, "complete") is not False for r in receipts)
        and all(e["countClear"] and all(_get(p["baseline"], "batchClear") and _get(p["candidate"], "batchClear")
                                       for p in e["pairs"]) for e in read_endpoints)
        and all(all(positive(_get(c["baseline"], "ns")) and positive(_get(c["candidate"], "ns"))
                    for r in e["rounds"] for c in r["constituents"]) for e in startup_endpoints))
    primary_qualified = study_integrity_clear and all(e["qualifies"] for e in read_endpoints if e["caseId"] == "P1")
    controls_cleared = study_integrity_clear and all(e["controlClear"] for e in endpoints
                         if not (e["kind"] == "read" and e["caseId"] == "P1"))
    material_harm_veto = study_integrity_clear and any(e["confidentAdverse"] for e in endpoints)
    promising_lead = primary_qualified and not material_harm_veto
    regression_clearance = promising_lead and controls_cleared
    status = ("blocked-by-confident-material-harm" if material_harm_veto else "regression-clearance" if regression_clearance
              else "promising-lead-with-unresolved-controls" if promising_lead else "no-qualifying-lead")
    return {"status": status, "eligible": regression_clearance,
            "scheduleClear": schedule_clear, "studyIntegrityClear": study_integrity_clear,
            "qualityClear": quality_clear, "primaryQualified": primary_qualified,
            "materialHarmVeto": material_harm_veto, "controlsCleared": controls_cleared,
            "promisingLead": promising_lead, "diagnosticFollowOnEligible": promising_lead,
            "regressionClearance": regression_clearance,
            "controlsClear": controls_cleared, "blocked": material_harm_veto, "expectedProcesses": LIMITS["mainChildren"],
            "receivedProcesses": len(receipts), "errors": errors, "readEndpoints": read_endpoints,
            "startupEndpoints": startup_endpoints, "endpoints": endpoints,
            "eligibilityScope": "Data-only; supervisor must additionally enforce source/correctness authentication and every late failure."}


chooseCount = choose_count
clockSummary = clock_summary
readResolution = read_resolution
startupResolution = startup_resolution
countValid = count_valid
fixedInterval = fixed_interval
