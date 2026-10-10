"""Source-only preparation: strict reconciliation for one fixed portability screen.

This module has no import-time I/O. Its pure functions are also used by the
future, dependency-free synthetic protocol gate. It never imports the subject.
"""
from pathlib import Path
import hashlib
import json
import math
import statistics
import sys


class AuditError(ValueError):
    """Evidence did not satisfy the frozen protocol."""


ARMS = ("baseline", "candidate")
ORDER = ("baseline", "candidate", "candidate", "baseline",
         "candidate", "baseline", "baseline", "candidate")
PAIRS = ((0, 1), (3, 2), (5, 4), (6, 7))
GROUPS = {"arm": ("node", "bun"),
          "browsers": ("chromium", "firefox", "webkit")}
CASE_NAMES = ("mixed-128", "mixed-4", "changed-single", "reverted-one")
CASES = {
    "mixed-128": {"names": 128, "publishesPerCycle": 1,
                  "flushesPerCycle": 31, "maxCycles": 8192},
    "mixed-4": {"names": 4, "publishesPerCycle": 1,
                "flushesPerCycle": 31, "maxCycles": 32768},
    "changed-single": {"names": 0, "publishesPerCycle": 32,
                       "flushesPerCycle": 0, "maxCycles": 131072},
    "reverted-one": {"names": 1, "publishesPerCycle": 0,
                     "flushesPerCycle": 32, "maxCycles": 4194304},
}
CONTROLS = ("changed-single", "reverted-one")
TARGET_NS = 100000000
FLOOR_NS = 50000000
CEILING_NS = 1000000000
T_DF3 = 3.182446305284263
MAX_JSON_BYTES = 8 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise AuditError(message)


def integer(value, name, minimum=0, maximum=9007199254740991):
    require(type(value) is int and minimum <= value <= maximum,
            f"{name}: expected integer in [{minimum}, {maximum}]")
    return value


def number(value, name, minimum=0, maximum=float("inf"), exclusive_min=False):
    require(type(value) in (int, float) and math.isfinite(value),
            f"{name}: expected finite number")
    require((value > minimum if exclusive_min else value >= minimum) and
            value <= maximum, f"{name}: out of range")
    return value


def exact_keys(value, expected, name):
    require(type(value) is dict and set(value) == set(expected),
            f"{name}: missing or unexpected keys")


def same(left, right):
    """Structural equality that never treats a JSON boolean as a count."""
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(same(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
    return left == right


def digest(data):
    return hashlib.sha256(data).hexdigest()


def hash_value(value, name):
    require(type(value) is str and len(value) == 64 and
            all(char in "0123456789abcdef" for char in value),
            f"{name}: invalid SHA256")
    return value


def reject_constant(value):
    raise AuditError(f"Non-finite JSON constant: {value}")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def decode_json(data):
    require(len(data) <= MAX_JSON_BYTES, "JSON artifact exceeds audit limit")
    try:
        value = json.loads(data, object_pairs_hook=unique_object,
                           parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise AuditError(f"Invalid JSON: {error}") from error
    # JSON exponent overflow (1e999) is not parse_constant, so visit all values.
    def visit(item):
        if type(item) is float:
            require(math.isfinite(item), "Non-finite JSON numeric value")
        elif type(item) is list:
            for child in item:
                visit(child)
        elif type(item) is dict:
            for child in item.values():
                visit(child)
    visit(value)
    return value


def read_json(path):
    data = path.read_bytes()
    return decode_json(data), digest(data)


def safe_path(root, relative):
    require(type(relative) is str and relative and "\\" not in relative,
            "Invalid artifact-relative path")
    path = Path(relative)
    require(not path.is_absolute() and all(part not in ("..", ".", "")
                                          for part in relative.split("/")),
            "Artifact path is not clean and relative")
    resolved = (root / path).resolve()
    require(resolved.is_relative_to(root.resolve()), "Artifact path escapes root")
    return resolved


def fixture_for(case_name):
    require(case_name in CASES, "Unknown case")
    case = CASES[case_name]
    names = [f"lane{index:03d}" for index in range(case["names"])]
    return {"names": names, "initialValues": [0, 1],
            "changedName": names[-1] if names else None,
            "publishesPerCycle": case["publishesPerCycle"],
            "flushesPerCycle": case["flushesPerCycle"],
            "operationsPerCycle": 32,
            "setupVersion": 1 if case_name == "reverted-one" else 0,
            "changedThenReverted": case_name == "reverted-one"}


def fixture_hash(case_name):
    return digest(json.dumps(fixture_for(case_name), separators=(",", ":")).encode())


def checksum_for(case_name, cycles, version_before):
    integer(cycles, "cycles", 1, CASES[case_name]["maxCycles"])
    integer(version_before, "versionBefore")
    publications = cycles * CASES[case_name]["publishesPerCycle"]
    if publications:
        value = publications * version_before + publications * (publications + 1) // 2
        if case_name.startswith("mixed-"):
            value *= 32
    else:
        value = cycles * 32 * version_before
    return value & 0xffffffff


def next_cycles(cycles, elapsed_ns, ceiling):
    integer(cycles, "pilot cycles", 32, ceiling)
    number(elapsed_ns, "pilot duration", 0, CEILING_NS, exclusive_min=True)
    factor = min(16, max(2, 1.25 * TARGET_NS / elapsed_ns))
    return min(ceiling, math.ceil(cycles * factor))


def audit_calibration(case_name, rows, selected, capped, cap_reason):
    require(type(rows) is list and 3 <= len(rows) <= 9,
            "Calibration requires two seeds and one to seven pilots")
    require(type(capped) is bool, "Calibration capped is not boolean")
    integer(selected, "selected calibration cycles", 32, CASES[case_name]["maxCycles"])
    for row in rows:
        integer(row["index"], "calibration row index", 0, 6)
        integer(row["cycles"], "calibration row cycles", 32, CASES[case_name]["maxCycles"])
        number(row["ns"], "calibration duration", 0, CEILING_NS, exclusive_min=True)
    for index, row in enumerate(rows[:2]):
        require((row["phase"], row["index"], row["cycles"]) ==
                ("seed-warmup", index, 32), "Wrong seed warmup")
    pilots = rows[2:]
    count = 32
    ceiling = CASES[case_name]["maxCycles"]
    for index, row in enumerate(pilots):
        require((row["phase"], row["index"], row["cycles"]) ==
                ("pilot", index, count), "Pilot count/order differs from frozen rule")
        if index < len(pilots) - 1:
            require(row["ns"] < TARGET_NS and count < ceiling,
                    "Extra pilot after target or cycle ceiling")
            count = next_cycles(count, row["ns"], ceiling)
    require(selected == count, "Selected calibration count differs from final pilot")
    expected_capped = pilots[-1]["ns"] < TARGET_NS
    require(capped == expected_capped, "Calibration cap flag mismatch")
    expected_reason = None
    if expected_capped:
        require(count == ceiling or len(pilots) == 7,
                "Calibration stopped early below target")
        expected_reason = "count" if count == ceiling else "pilot-count"
    require(cap_reason == expected_reason, "Calibration cap reason mismatch")


def frozen_cycles(case_name, calibrations):
    exact_keys(calibrations, ARMS, "calibrations")
    selected = {arm: integer(calibrations[arm]["cycles"], "selected cycles", 32,
                             CASES[case_name]["maxCycles"]) for arm in ARMS}
    if case_name in CONTROLS:
        common = max(selected.values())
        return {arm: common for arm in ARMS}
    return selected


def expected_subjects(group):
    require(group in GROUPS, "Unknown runtime group")
    subjects = []
    # All calibrations for a group precede any measured subjects. Browser engines
    # finish their complete calibration/measurement screen one at a time.
    batches = [GROUPS[group]] if group == "arm" else [(engine,) for engine in GROUPS[group]]
    for engines in batches:
        for case_name in CASE_NAMES:
            for runtime in engines:
                for arm in ARMS:
                    subjects.append(("calibrate", runtime, case_name, arm, -1))
        for slot, arm in enumerate(ORDER):
            for case_name in CASE_NAMES:
                for runtime in engines:
                    subjects.append(("measure", runtime, case_name, arm, slot))
    return subjects


def subject_id(subject):
    mode, runtime, case_name, arm, slot = subject
    return (f"cal-{runtime}-{case_name}-{arm}" if mode == "calibrate" else
            f"measure-{runtime}-{case_name}-{slot}")


def audit_schedule(group, commands):
    require(type(commands) is list, "Screen commands must be an array")
    observed = []
    ids = set()
    for command in commands:
        identity = tuple(command[key] for key in ("mode", "runtime", "caseName", "arm", "slot"))
        require(command["id"] == subject_id(identity), "Subject ID does not match identity")
        require(command["id"] not in ids, "Duplicate subject")
        ids.add(command["id"])
        observed.append(identity)
    require(observed == expected_subjects(group), "Missing, extra, replaced or reordered subjects")


def evaluate_rules(ratios, interval, median_saved, aa_ratios, bb_ratios,
                   arm_ranges, spreads, short_warm=False, short_measured=False,
                   capped=False, is_control=False):
    require(len(ratios) == 4 and len(interval) == 2 and len(aa_ratios) == 2 and
            len(bb_ratios) == 2 and len(arm_ranges) == 2 and len(spreads) == 8,
            "Wrong statistic cardinality")
    for value in ratios + interval + aa_ratios + bb_ratios:
        number(value, "ratio", 0, exclusive_min=True)
    require(interval[0] <= interval[1], "Reversed interval")
    number(median_saved, "median saved", -float("inf"))
    for value in arm_ranges + spreads:
        number(value, "range", 0)
    for value in (short_warm, short_measured, capped, is_control):
        require(type(value) is bool, "Rule input must be boolean")
    # Compare ratio bounds directly to avoid 1.05 - 1 floating-point artifacts.
    noisy = (any(value > 1.05 or value < .95 for value in aa_ratios + bb_ratios)
             or any(1 + value > 1.05 for value in arm_ranges)
             or any(1 + value > 1.10 for value in spreads))
    adverse = [index for index, ratio in enumerate(ratios) if ratio >= 1.02]
    gain = (all(value < 1 for value in ratios) and interval[1] <= .95 and
            median_saved >= 10 and
            1 - statistics.median(ratios) > max(abs(value - 1) for value in aa_ratios)
            and not short_warm and not short_measured and not capped)
    regression = is_control and interval[0] > 1.02
    return {"pairedGainThresholdMet": gain,
            "controlRegressionBlocksAdvancement": regression,
            "noisy": noisy, "adversePairIndexesAtTwoPercent": adverse,
            "shortWarmBatch": short_warm, "shortMeasuredBatch": short_measured,
            "calibrationCapped": capped,
            "unresolvedUnderScreenRules": bool(adverse) or noisy or short_warm or
                short_measured or capped or interval[1] > 1.02}


def summarize_cell(runtime, case_name, processes, calibrations):
    require(len(processes) == 8, "A cell requires exactly eight subjects")
    times = [statistics.median(row["nsPerOperation"] for row in process["batches"][2:])
             for process in processes]
    ratios = [times[candidate] / times[baseline] for baseline, candidate in PAIRS]
    saved = [times[baseline] - times[candidate] for baseline, candidate in PAIRS]
    logs = [math.log(value) for value in ratios]
    center = statistics.mean(logs)
    half = T_DF3 * statistics.stdev(logs) / 2
    interval = [math.exp(center - half), math.exp(center + half)]
    aa_ratios = [times[3] / times[0], times[6] / times[5]]
    bb_ratios = [times[2] / times[1], times[7] / times[4]]
    baseline = [times[index] for index in (0, 3, 5, 6)]
    candidate = [times[index] for index in (1, 2, 4, 7)]
    arm_ranges = [max(values) / min(values) - 1 for values in (baseline, candidate)]
    spreads = [max(row["nsPerOperation"] for row in process["batches"][2:]) /
               min(row["nsPerOperation"] for row in process["batches"][2:]) - 1
               for process in processes]
    rules = evaluate_rules(ratios, interval, statistics.median(saved), aa_ratios,
                           bb_ratios, arm_ranges, spreads,
                           any(row["belowFloor"] for process in processes for row in process["batches"][:2]),
                           any(row["belowFloor"] for process in processes for row in process["batches"][2:]),
                           any(calibrations[arm]["capped"] for arm in ARMS),
                           case_name in CONTROLS)
    return {"runtime": runtime, "name": case_name,
            "role": "primary" if case_name == "mixed-128" else
                    "secondary" if case_name == "mixed-4" else "control",
            "independentPairCount": 4,
            "baselineNsPerOperation": baseline, "candidateNsPerOperation": candidate,
            "allProcessNsPerOperation": times,
            "allProcessNsPerCycle": [value * 32 for value in times],
            "pairedCandidateOverBaseline": ratios,
            "pairedMedianRatio": statistics.median(ratios),
            "geometricMeanRatio": math.exp(center),
            "descriptive95LogRatioInterval": interval,
            "pairedSavedNsPerOperation": saved,
            "medianSavedNsPerOperation": statistics.median(saved),
            "aaRatios": aa_ratios, "bbRatios": bb_ratios,
            "baselineRangeFraction": arm_ranges[0], "candidateRangeFraction": arm_ranges[1],
            "withinProcessRanges": spreads,
            "calibratedCyclesByArm": {arm: calibrations[arm]["cycles"] for arm in ARMS},
            "frozenCyclesByArm": {arm: next(process["cycles"] for process in processes
                                            if process["arm"] == arm) for arm in ARMS},
            "countsCommon": case_name in CONTROLS,
            "absoluteBatchNsByProcess": [[row["ns"] for row in process["batches"]]
                                         for process in processes], **rules}


IDENTITY_KEYS = ("mode", "runtime", "caseName", "arm", "slot")
RESULT_KEYS = ("schema", *IDENTITY_KEYS, "cycles", "capped", "capReason",
               "calibrationSHA256", "frozenCountsSHA256", "protocolSHA256",
               "inputPinsSHA256", "runtimeManifestSHA256", "fixture",
               "fixtureSHA256", "batches", "disposed", "passed", "operationsPerBatch")
BATCH_KEYS = ("event", *IDENTITY_KEYS, "phase", "index", "cycles", "operations",
              "publications", "explicitFlushes", "ns", "nsPerOperation", "nsPerCycle",
              "versionBefore", "versionAfter", "checksum", "expectedChecksum",
              "belowFloor", "overTimeCap", "fixtureSHA256")


def audit_protocol(protocol):
    expected = {
        "runtimeGroups": {group: list(engines) for group, engines in GROUPS.items()},
        "armOrder": list(ORDER), "pairIndexesBaselineCandidate": [list(pair) for pair in PAIRS],
        "seedCycles": 32, "calibrationSeedWarmups": 2, "maxPilots": 7,
        "targetNs": TARGET_NS, "growthMax": 16, "growthMin": 2,
        "growthHeadroom": 1.25, "warmups": 2, "samples": 3,
        "floorNs": FLOOR_NS, "batchCeilingNs": CEILING_NS,
        "logRatioTCriticalDf3": T_DF3,
    }
    require(type(protocol) is dict, "Protocol must be an object")
    require(type(protocol.get("schema")) is int and protocol["schema"] == 1 and
            protocol.get("noRerun") is True and
            same(protocol.get("versions"), {"node": "v22.23.3", "bun": "1.4.2", "playwright": "1.63.0"}),
            "Protocol schema/version/no-rerun rule changed")
    for key, value in expected.items():
        require(protocol.get(key) == value and
                (type(value) not in (int, float) or type(protocol[key]) in (int, float)),
                f"Protocol changed: {key}")
    require(type(protocol.get("cases")) is list and
            [item.get("name") for item in protocol["cases"]] == list(CASE_NAMES),
            "Protocol case set/order changed")
    for item in protocol["cases"]:
        for key, value in CASES[item["name"]].items():
            require(type(item.get(key)) is int and item[key] == value,
                    f"Protocol case field changed: {item['name']}/{key}")


def audit_batch(row, result, expected_version):
    exact_keys(row, BATCH_KEYS, "batch")
    require(row["event"] == "batch", "Missing completed batch event")
    for key in IDENTITY_KEYS:
        require(row[key] == result[key], f"Batch identity mismatch: {key}")
    integer(row["slot"], "batch slot", -1, 7)
    require(row["phase"] in ("seed-warmup", "pilot", "warmup", "measure"), "Unknown phase")
    integer(row["index"], "batch index", 0, 6)
    case_name = result["caseName"]
    case = CASES[case_name]
    cycles = integer(row["cycles"], "batch cycles", 1, case["maxCycles"])
    operations = cycles * 32
    publications = cycles * case["publishesPerCycle"]
    for key, value in (("operations", operations), ("publications", publications),
                       ("explicitFlushes", cycles * case["flushesPerCycle"]),
                       ("versionBefore", expected_version),
                       ("versionAfter", expected_version + publications)):
        require(integer(row[key], key) == value, f"Batch {key} mismatch")
    checksum = checksum_for(case_name, cycles, expected_version)
    for key in ("checksum", "expectedChecksum"):
        require(integer(row[key], key, 0, 0xffffffff) == checksum,
                f"Returned-version sum mismatch: {key}")
    ns = number(row["ns"], "batch ns", 0, CEILING_NS, exclusive_min=True)
    require(number(row["nsPerOperation"], "ns/op", 0, exclusive_min=True) == ns / operations,
            "Normalized ns/op mismatch")
    require(number(row["nsPerCycle"], "ns/cycle", 0, exclusive_min=True) == ns / cycles,
            "Normalized ns/cycle mismatch")
    require(type(row["belowFloor"]) is bool and row["belowFloor"] == (ns < FLOOR_NS),
            "Short-batch flag mismatch")
    require(row["overTimeCap"] is False, "Completed batch exceeded time cap")
    require(row["fixtureSHA256"] == result["fixtureSHA256"], "Batch fixture mismatch")
    return expected_version + publications


def audit_result(result, identity, hashes):
    browser = identity[1] in GROUPS["browsers"]
    exact_keys(result, (*RESULT_KEYS, "browser") if browser else RESULT_KEYS, "subject result")
    require(type(result["schema"]) is int and result["schema"] == 1, "Unknown result schema")
    require(tuple(result[key] for key in IDENTITY_KEYS) == identity, "Result identity mismatch")
    mode, runtime, case_name, arm, slot = identity
    require(case_name in CASES and arm in ARMS and runtime in sum(GROUPS.values(), ()),
            "Invalid subject identity")
    integer(slot, "slot", -1, 7)
    integer(result["slot"], "result slot", -1, 7)
    require((mode == "calibrate" and slot == -1) or
            (mode == "measure" and 0 <= slot < 8 and arm == ORDER[slot]),
            "Invalid mode/slot/arm")
    for key in ("protocolSHA256", "inputPinsSHA256", "runtimeManifestSHA256"):
        require(hash_value(result[key], key) == hashes[key], f"Subject {key} changed")
    require(same(result["fixture"], fixture_for(case_name)) and
            result["fixtureSHA256"] == fixture_hash(case_name), "Fixture identity mismatch")
    require(result["passed"] is True and result["disposed"] is True,
            "Subject did not complete validation and disposal")
    cycles = integer(result["cycles"], "result cycles", 32, CASES[case_name]["maxCycles"])
    require(integer(result["operationsPerBatch"], "operationsPerBatch", 1) == cycles * 32,
            "Operations per batch mismatch")
    require(type(result["capped"]) is bool and result["capReason"] in (None, "count", "pilot-count"),
            "Invalid calibration cap metadata")
    rows = result["batches"]
    require(type(rows) is list, "Missing batches")
    expected_version = fixture_for(case_name)["setupVersion"]
    for row in rows:
        expected_version = audit_batch(row, result, expected_version)
    if mode == "calibrate":
        require(result["calibrationSHA256"] is None and result["frozenCountsSHA256"] is None,
                "Calibration unexpectedly references frozen counts")
        audit_calibration(case_name, rows, cycles, result["capped"], result["capReason"])
    else:
        require(len(rows) == 5 and
                [(row["phase"], row["index"]) for row in rows] ==
                [("warmup", 0), ("warmup", 1), ("measure", 0), ("measure", 1), ("measure", 2)],
                "Measured subject must contain two warmups and three measured batches")
        require(all(row["cycles"] == cycles for row in rows), "Frozen count changed within subject")
        exact_keys(result["calibrationSHA256"], ARMS, "calibration hashes")
        for arm_name in ARMS:
            hash_value(result["calibrationSHA256"][arm_name], "calibration hash")
        hash_value(result["frozenCountsSHA256"], "frozen-count hash")


def audit_log(events, result, result_hash):
    require(type(events) is list and len(events) == 6 + 3 * len(result["batches"]),
            "Incomplete or extra subject log events")
    identity = {key: result[key] for key in IDENTITY_KEYS}
    expected_start = {"event": "subject-start", **identity,
                      **{key: result[key] for key in
                         ("protocolSHA256", "inputPinsSHA256", "runtimeManifestSHA256",
                          "frozenCountsSHA256", "calibrationSHA256")}}
    require(same(events[0], expected_start), "Subject start does not match result")
    ready, verified = events[1:3]
    exact_keys(ready, ("event", "rootPids"), "containment-ready")
    exact_keys(verified, ("event", "roots", "method"), "containment-verified")
    require(ready["event"] == "containment-ready" and verified["event"] == "containment-verified" and
            verified["method"] == "linux-subreaper-descendant-census", "Containment was not verified")
    require(type(ready["rootPids"]) is list and ready["rootPids"], "No owned process roots")
    for pid in ready["rootPids"]:
        integer(pid, "owned root pid", 1)
    require(len(set(ready["rootPids"])) == len(ready["rootPids"]), "Duplicate owned root")
    require(type(verified["roots"]) is list and
            [row["pid"] for row in verified["roots"]] == ready["rootPids"],
            "Verified roots differ from launched roots")
    for row in verified["roots"]:
        exact_keys(row, ("pid", "starttime", "pgrp", "ppid"), "verified root")
        for key in ("pid", "pgrp", "ppid"):
            integer(row[key], key, 1 if key != "ppid" else 0)
        require((type(row["starttime"]) is int and row["starttime"] >= 0) or
                (type(row["starttime"]) is str and row["starttime"].isascii() and row["starttime"].isdigit()),
                "Invalid process start identity")
    require(same(events[3], {"event": "fixture", "fixture": result["fixture"],
                           "fixtureSHA256": result["fixtureSHA256"]}), "Fixture log mismatch")
    offset = 4
    for row in result["batches"]:
        start = {"event": "batch-start", **{key: row[key] for key in
                  (*IDENTITY_KEYS, "phase", "index", "cycles", "operations", "versionBefore")}}
        validation = {"event": "validation", **{key: row[key] for key in
                       ("phase", "index", "cycles", "checksum", "expectedChecksum")},
                      "version": row["versionAfter"], "passed": True,
                      "aliases": True, "retainedSnapshots": True, "errors": []}
        require(same(events[offset:offset + 3], [start, row, validation]),
                "Start/completed-row/post-batch-validation order or contents mismatch")
        offset += 3
    require(same(events[-2], {"event": "dispose", "closed": True, "errors": []}),
            "Successful disposal not recorded")
    require(same(events[-1], {"event": "complete", "resultSHA256": result_hash,
                           **identity, "cycles": result["cycles"], "capped": result["capped"],
                           "batchCount": len(result["batches"])}), "Completion hash/result mismatch")


def audit_frozen(runtime, frozen, calibrations, hashes):
    exact_keys(frozen, ("runtime", "protocolSHA256", "inputPinsSHA256",
                        "runtimeManifestSHA256", "cases"), "frozen-count file")
    require(frozen["runtime"] == runtime, "Frozen counts belong to another runtime")
    for key in ("protocolSHA256", "inputPinsSHA256", "runtimeManifestSHA256"):
        require(frozen[key] == hashes[key], "Frozen-count input identity changed")
    exact_keys(frozen["cases"], CASE_NAMES, "frozen cases")
    for case_name in CASE_NAMES:
        row = frozen["cases"][case_name]
        exact_keys(row, ("calibrations", "cycles", "common"), "frozen case")
        exact_keys(row["calibrations"], ARMS, "frozen calibrations")
        actual = {arm: calibrations[(runtime, case_name, arm)] for arm in ARMS}
        for arm in ARMS:
            result, result_hash = actual[arm]
            require(same(row["calibrations"][arm], {"sha256": result_hash,
                    **{key: result[key] for key in ("cycles", "capped", "capReason")}}),
                    "Frozen calibration differs from audited artifact")
        require(row["common"] is (case_name in CONTROLS), "Control common-count rule changed")
        require(same(row["cycles"], frozen_cycles(case_name, {arm: actual[arm][0] for arm in ARMS})),
                "Frozen count differs from prescribed arm-specific/common rule")


def audit_screen_events(group, events, commands, frozen_hashes, frozen_paths):
    require(type(events) is list, "Missing chronological screen events")
    freezes = set()
    calibrated = {runtime: set() for runtime in GROUPS[group]}
    launches = []
    pending = None
    command_map = {command["id"]: command for command in commands}
    for event in events:
        if event.get("event") == "freeze":
            exact_keys(event, ("event", "runtime", "sha256", "path"), "screen freeze event")
            runtime = event["runtime"]
            require(pending is None and runtime in GROUPS[group] and runtime not in freezes,
                    "Unknown, duplicate or overlapping freeze")
            require(calibrated[runtime] == {(case, arm) for case in CASE_NAMES for arm in ARMS},
                    "Counts froze before every calibration finished")
            require(event["sha256"] == frozen_hashes[runtime] and event["path"] == frozen_paths[runtime],
                    "Freeze-event path/hash mismatch")
            freezes.add(runtime)
        elif event.get("event") == "finish":
            exact_keys(event, ("event", "id", "resultSHA256", "receiptSHA256"), "screen finish event")
            require(pending is not None and event["id"] == pending["id"],
                    "Finish without matching active subject")
            require(event["resultSHA256"] == pending["resultSHA256"] and
                    event["receiptSHA256"] == pending["receiptSHA256"], "Finish hash mismatch")
            if pending["mode"] == "calibrate":
                calibrated[pending["runtime"]].add((pending["caseName"], pending["arm"]))
            pending = None
        else:
            exact_keys(event, ("event", "id", *IDENTITY_KEYS, "frozenCountsSHA256"), "screen launch event")
            require(event["event"] == "launch", "Unknown screen event")
            identity = tuple(event[key] for key in IDENTITY_KEYS)
            mode, runtime, case_name, arm, slot = identity
            require(runtime in GROUPS[group], "Launch belongs to another group")
            require(event["id"] == subject_id(identity), "Launch ID mismatch")
            require(pending is None and event["id"] in command_map, "Overlapping or unknown subject")
            pending = command_map[event["id"]]
            require(event["frozenCountsSHA256"] == pending["frozenCountsSHA256"],
                    "Command count-freeze hash differs from launch")
            if mode == "calibrate":
                require(runtime not in freezes and event["frozenCountsSHA256"] is None,
                        "Calibration after count freeze")
            else:
                require(runtime in freezes and event["frozenCountsSHA256"] == frozen_hashes[runtime],
                        "Measurement launched before verified count freeze")
            launches.append(identity)
    require(launches == expected_subjects(group) and len(launches) == len(commands),
            "Launch schedule is missing, extra or changed")
    require(pending is None, "Subject launch has no completion")
    require(freezes == set(GROUPS[group]), "Missing runtime count freeze")


def audit_pins(root, pins):
    require(type(pins) is dict and type(pins.get("files")) is list and pins["files"],
            "Missing input file pins")
    paths = set()
    pin_map = {}
    for row in pins["files"]:
        exact_keys(row, ("path", "bytes", "sha256"), "input pin")
        path = safe_path(root, row["path"])
        require(row["path"] not in paths, "Duplicate input pin")
        paths.add(row["path"])
        data = path.read_bytes()
        require(integer(row["bytes"], "pinned byte count", 0) == len(data) and
                hash_value(row["sha256"], "pinned hash") == digest(data), "Pinned file changed")
        pin_map[row["path"]] = row["sha256"]
    for required in ("PROTOCOL.json", "workload.mjs", "subject.mjs", "browser.mjs", "analyze.py",
                     "protocol-checks.py", "candidate.patch"):
        require(required in paths, f"Required scientific input is not pinned: {required}")
    for arm in ARMS:
        portable = [path for path in paths if path.startswith(f"arms/{arm}/dist/") and path.endswith(".js")]
        require(len(portable) == 12 and f"arms/{arm}/dist/shared.js" in portable and
                f"arms/{arm}/dist/worker.js" in portable, "Portable module set is not the fixed 12 per arm")
    return pin_map


def audit_capabilities(capabilities):
    exact_keys(capabilities, ("crossOriginIsolated", "sharedMemory", "timerResolutionMs",
                             "timerResolutionObservations", "userAgent"), "browser capabilities")
    require(capabilities["crossOriginIsolated"] is True and capabilities["sharedMemory"] is True,
            "Browser is unsupported: isolation/shared memory unavailable")
    number(capabilities["timerResolutionMs"], "observed timer resolution", 0, exclusive_min=True)
    integer(capabilities["timerResolutionObservations"], "timer observations", 1, 10000)
    require(type(capabilities["userAgent"]) is str and capabilities["userAgent"], "Missing user agent")


def audit_runtime(group, manifest, hashes):
    require(manifest.get("schema") == 1 and manifest.get("group") == group and
            manifest.get("arch") == ("arm64" if group == "arm" else "x64"),
            "Runtime manifest group/architecture mismatch")
    for key in ("protocolSHA256", "inputPinsSHA256"):
        require(manifest[key] == hashes[key], "Runtime manifest input identity changed")
    for key in ("platform", "kernel", "cpuinfo", "meminfo"):
        require(type(manifest.get(key)) is str and manifest[key], f"Missing host metadata: {key}")
    integer(manifest["cpuCount"], "CPU count", 1)
    runner = manifest["runner"]
    require(runner.get("GITHUB_RUN_ATTEMPT") == "1", "Forbidden rerun attempt")
    for key in ("GITHUB_RUN_ID", "ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH"):
        require(type(runner.get(key)) is str and runner[key], f"Missing runner metadata: {key}")
    require(runner["RUNNER_OS"] == "Linux" and
            runner["RUNNER_ARCH"] == ("ARM64" if group == "arm" else "X64"), "Runner mismatch")
    for runtime, version in (("node", "v22.23.3"), ("bun", "1.4.2")):
        row = manifest["executables"][runtime]
        require(row["version"] == version and type(row["path"]) is str and Path(row["path"]).is_absolute(),
                "Executable version/path mismatch")
        hash_value(row["sha256"], "executable hash")
        integer(row["bytes"], "executable bytes", 1)
    expected_packages = {"playwright": "1.63.0", "playwright-core": "1.63.0",
                         "vitest": "4.1.11", "@vitest/browser": "4.1.11",
                         "@vitest/browser-playwright": "4.1.11"}
    require(same(manifest["packages"], expected_packages), "Dependency package versions changed")
    require(type(manifest["dependencies"]) is list and manifest["dependencies"], "Missing dependency inventory")
    require(type(manifest["browserFiles"]) is list, "Missing browser inventory")
    inventories = set()
    inventory_hashes = {}
    for row in manifest["dependencies"] + manifest["browserFiles"]:
        require(type(row) is dict and type(row.get("path")) is str, "Invalid inventory row")
        require(row["path"] not in inventories and not Path(row["path"]).is_absolute() and
                ".." not in Path(row["path"]).parts, "Unsafe/duplicate inventory path")
        inventories.add(row["path"])
        if "symlink" in row:
            exact_keys(row, ("path", "symlink"), "inventory symlink")
            require(type(row["symlink"]) is str, "Invalid symlink target")
        else:
            exact_keys(row, ("path", "bytes", "sha256"), "inventory file")
            integer(row["bytes"], "inventory bytes", 0)
            hash_value(row["sha256"], "inventory hash")
            inventory_hashes[row["path"]] = row["sha256"]
    require(type(manifest.get("nativeELF")) is list, "Missing native binary architecture inventory")
    native_paths = set()
    for row in manifest["nativeELF"]:
        exact_keys(row, ("path", "elfClass", "machine", "sha256"), "native ELF inventory")
        require(row["path"] in inventory_hashes and row["path"] not in native_paths and
                row["sha256"] == inventory_hashes[row["path"]], "Native binary hash differs from installed inventory")
        native_paths.add(row["path"])
        integer(row["elfClass"], "ELF class", 1, 2)
        integer(row["machine"], "ELF machine", 0, 65535)
        if row["path"].endswith(".node"):
            require(row["machine"] == (183 if group == "arm" else 62), "Native dependency architecture mismatch")
    expected_versions = {"chromium": "153.0.8010.12", "firefox": "155.0", "webkit": "26.6"}
    exact_keys(manifest["browsers"], GROUPS["browsers"] if group == "browsers" else (), "browser manifest")
    for runtime, row in manifest["browsers"].items():
        require(row["runtime"] == runtime and row["version"] == expected_versions[runtime] and
                row["playwrightVersion"] == "1.63.0", "Browser version/revision mismatch")
        audit_capabilities(row["capabilities"])
        require(type(row["configuredExecutable"]) is str and row["configuredExecutable"],
                "Missing browser executable path")
        require(type(row["ownedProcessInventory"]) is list and row["ownedProcessInventory"],
                "Missing browser process executable inventory")
        require(manifest["browserFiles"], "Missing pinned installed browser bytes")


def audit_browser(result, manifest, pin_map):
    browser = result["browser"]
    exact_keys(browser, ("version", "capabilities", "servedSHA256"), "browser result")
    require(browser["version"] == manifest["browsers"][result["runtime"]]["version"],
            "Measured browser version differs from preflight")
    audit_capabilities(browser["capabilities"])
    served = browser["servedSHA256"]
    require(type(served) is dict and served, "Missing response-byte evidence")
    for url, value in served.items():
        require(type(url) is str and url.startswith("/") and
                (url == "/workload.mjs" or url.startswith(f"/arms/{result['arm']}/dist/")),
                "Browser served an unexpected arm/path")
        require(url[1:] in pin_map and hash_value(value, "served response hash") == pin_map[url[1:]],
                "Browser response differs from staged pinned bytes")
    for required in ("/workload.mjs", f"/arms/{result['arm']}/dist/shared.js",
                     f"/arms/{result['arm']}/dist/worker.js"):
        require(required in served, "Required imported response is missing")


def audit_receipt(receipt, command=None, max_seconds=None, rss_mib=None, handshake=None, install_debug=False, output_cap=8388608, require_process_inventory=True):
    require(type(receipt) is dict and receipt.get("state") == "passed" and
            type(receipt.get("exitCode")) is int and receipt["exitCode"] == 0 and
            receipt.get("limit", "missing") is None and receipt.get("error", "missing") is None,
            "Subject/preflight failed, was capped or has an incomplete receipt")
    require(type(receipt.get("command")) is list and receipt["command"] and
            all(type(part) is str for part in receipt["command"]), "Receipt missing actual command")
    require(type(receipt.get("cwd")) is str and Path(receipt["cwd"]).is_absolute(), "Receipt cwd missing")
    require(receipt.get("cleanup", {}).get("confirmedEmpty") is True,
            "Owned processes not confirmed terminated")
    require(receipt.get("signal", "missing") is None and
            receipt.get("stdoutEOF") is True and receipt.get("stderrEOF") is True and
            receipt.get("executableHashingComplete") is True and receipt.get("executableHashErrors") == [],
            "Interrupted/incomplete streams or executable identities")
    cleanup = receipt["cleanup"]
    require(cleanup.get("remainingBeforeCleanup") == [] and cleanup.get("remainingAfterCleanup") == [] and
            cleanup.get("interventionRequired") is False and cleanup.get("signals") == [] and cleanup.get("errors") == [],
            "Subject required cleanup intervention or left descendants")
    seconds = number(receipt["secondsCap"], "subject wall-time cap", 4, max_seconds or 90, exclusive_min=True)
    number(receipt["elapsedSeconds"], "subject elapsed time", 0, seconds)
    memory = number(receipt["rssMiBCap"], "subject RSS cap", 0, exclusive_min=True)
    if rss_mib is not None:
        require(memory == rss_mib, "RSS safety cap changed")
    integer(receipt["peakPolledRSS"], "peak polled process-group RSS", 0, int(memory * 1048576))
    require(receipt["rssUnits"] == "bytes" and receipt["rssSampleIntervalMs"] == 50 and
            receipt["cleanupReserveSeconds"] == 4, "Supervisor measurement metadata changed")
    exact_keys(receipt['output'],('stdout','stderr'),'stream output accounting')
    for name,row in receipt['output'].items():
        exact_keys(row,('capBytes','observedBytes','retainedBytes','discardedBytes','truncated'),'stream byte counters')
        require(integer(row['capBytes'],'stream cap')==output_cap,'Output cap changed')
        observed=integer(row['observedBytes'],'observed bytes',0,output_cap)
        require(integer(row['retainedBytes'],'retained bytes',0,output_cap)==observed and
          row['discardedBytes']==0 and type(row['discardedBytes']) is int and row['truncated'] is False,
          'Successful command lost/truncated output')
    environment = receipt["cleanEnvironment"]
    allowed_environment = {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "PLAYWRIGHT_BROWSERS_PATH",
                           "SCREEN_BROWSER", "SCREEN_ARM"}
    if install_debug:
        allowed_environment.add("DEBUG")
    require(type(environment) is dict and set(environment) <= allowed_environment,
            "Unexpected inherited runtime injection variable")
    if install_debug:
        require(environment.get("DEBUG") == "pw:install", "Browser installation provenance debug setting changed")
    require(type(receipt["observedProcesses"]) is list and (receipt["observedProcesses"] or not require_process_inventory),
            "Missing owned-process inventory")
    if handshake is True:
        require(type(receipt["handshake"]) is dict and
                receipt["handshake"].get("event") == "containment-verified" and
                receipt["handshake"].get("method") == "linux-subreaper-descendant-census",
                "Containment acknowledgment missing")
    elif handshake is False:
        require(receipt["handshake"] is None, "Unexpected preflight handshake")
    if command is not None:
        require(receipt["command"] == command, "Receipt command does not match frozen invocation")


def read_log(path):
    data = path.read_bytes()
    require(len(data) <= MAX_JSON_BYTES and data.endswith(b"\n"), "Incomplete/oversized subject log")
    lines = data.splitlines()
    require(lines and all(line for line in lines), "Blank or empty subject log")
    return [decode_json(line) for line in lines], digest(data)


def screen_summary(group, results, raw_batch_count, evidence):
    cells = []
    for runtime in GROUPS[group]:
        for case_name in CASE_NAMES:
            processes = [results[("measure", runtime, case_name, arm, slot)] for slot, arm in enumerate(ORDER)]
            calibrations = {arm: results[("calibrate", runtime, case_name, arm, -1)] for arm in ARMS}
            cells.append(summarize_cell(runtime, case_name, processes, calibrations))
    primary = {row["runtime"]: row["pairedGainThresholdMet"] for row in cells if row["name"] == "mixed-128"}
    blocking = [{"runtime": row["runtime"], "name": row["name"]} for row in cells
                if row["controlRegressionBlocksAdvancement"]]
    qualified = [runtime for runtime, passed in primary.items() if passed]
    return {"schema": 1, "group": group, "auditPassed": True,
            "status": "blocked-by-control-regression" if blocking else
                      "primary-reproduced-on-all-group-runtimes" if all(primary.values()) else
                      "primary-reproduced-on-listed-runtimes" if qualified else "park-no-resampling",
            "primaryQualifiedRuntimes": qualified, "primaryThresholdByRuntime": primary,
            "armSupport": all(primary.values()) if group == "arm" else None,
            "candidateAdvancementBlocked": bool(blocking), "blockingControls": blocking,
            "unresolvedCells": [{"runtime": row["runtime"], "name": row["name"]} for row in cells
                                if row["unresolvedUnderScreenRules"]],
            "calibrationSubjectCount": len(GROUPS[group]) * 8,
            "measurementSubjectCount": len(GROUPS[group]) * 32,
            "measuredBatchCount": len(GROUPS[group]) * 96, "rawBatchCount": raw_batch_count,
            "cells": cells, "evidenceSHA256": evidence,
            "scope": "One fixed warmed unconnected-public-session portability screen; no local x64 resampling.",
            "limits": "Four fresh-subject pairs per cell; batches are not independent samples. Log-t intervals are descriptive (df=3), vulnerable to host drift and serial dependence. Mixed cases retain unequal counts and different GC/tiering exposure. Common control counts reduce that count confound without proving equal GC/tiering. Noise remains visible when primary thresholds pass. No application-frequency, startup, worker-delivery, retained-memory, universal-equivalence or overall no-regression claim.",
            "fiveRuntimeRule": "A five-runtime claim requires independently audited mixed-128 qualification in all five runtimes; any control lower bound above 1.02 blocks advancement. A group result cannot establish that combined claim.",
            "stopping": "This fixed screen is terminal. Narrow or park unreproduced claims; no replacement subjects, noise-driven reruns or local x64 resampling."}


def audit_group(root, group, output):
    require(group in GROUPS, "Choose arm or browsers")
    protocol, protocol_hash = read_json(root / "PROTOCOL.json")
    audit_protocol(protocol)
    pins, pins_hash = read_json(root / "INPUT-PINS.json")
    pin_map = audit_pins(root, pins)
    manifest, runtime_hash = read_json(output / "RUNTIME.json")
    hashes = {"protocolSHA256": protocol_hash, "inputPinsSHA256": pins_hash,
              "runtimeManifestSHA256": runtime_hash}
    audit_runtime(group, manifest, hashes)
    intent,intent_hash=read_json(root/'ACTIVATION.json')
    require(intent.get('enabled') is True and intent.get('intentId')=='session-flush-portability-20261010','Dormant or changed intent')
    canonical_rows=sorted((row for row in pins['files'] if row['path'] not in {'ACTIVATION.json','workflow.yml','INPUT-PINS.json'}),key=lambda row:row['path'])
    canonical=digest(json.dumps(canonical_rows,sort_keys=True,separators=(',',':')).encode())
    activation=manifest['activation']
    exact_keys(activation,('intentId','expectedBefore','canonicalSourceSHA256','inputPinsSHA256','executionHead','executionGitTree'),'execution activation')
    require(activation['intentId']==intent['intentId'] and activation['expectedBefore']==intent['expectedBefore'] and
      activation['canonicalSourceSHA256']==canonical==intent['canonicalSourceSHA256'] and
      activation['inputPinsSHA256']==pins_hash and activation['executionHead']==manifest['runner']['GITHUB_SHA'],'Execution intent/tree/head mismatch')
    for key in ('expectedBefore','executionHead','executionGitTree'):
        require(type(activation[key]) is str and len(activation[key])==40 and all(c in '0123456789abcdef' for c in activation[key]),'Invalid Git execution identity')
    evidence = {"PROTOCOL.json": protocol_hash, "INPUT-PINS.json": pins_hash,
                "RUNTIME.json": runtime_hash}
    def artifact(relative):
        value, value_hash = read_json(safe_path(output, relative))
        evidence[relative] = value_hash
        return value, value_hash
    job,_=artifact('JOB.json')
    require(same(job['activation'],activation),'Execution binding changed after job launch')
    setup_names = ["dependencies"] + (["browsers"] if group == "browsers" else [])
    for name in setup_names:
        receipt, _ = artifact(f"setup/{name}.receipt.json")
        expected_command = (["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--registry=https://registry.npmjs.org"]
            if name == "dependencies" else ["node", "toolchain/node_modules/playwright/cli.js", "install", "--with-deps",
                                            "chromium", "firefox", "webkit"])
        audit_receipt(receipt, expected_command, 110 if name == "dependencies" else 230,
                      2048, False, name == "browsers",33554432)
        require(receipt["cwd"] == str(root / "toolchain" if name == "dependencies" else root),
                "Setup command cwd changed")
        require(not any(key.startswith("SCREEN_") for key in receipt["cleanEnvironment"]),
                "Unexpected correctness selectors during setup")
        for suffix in (".jsonl", ".stderr"):
            relative = f"setup/{name}{suffix}"
            data=(output / relative).read_bytes()
            require(len(data)==receipt['output']['stdout' if suffix=='.jsonl' else 'stderr']['retainedBytes'],'Setup output count mismatch')
            evidence[relative] = digest(data)
    preflight, _ = artifact("PREFLIGHT.json")
    require(preflight["state"] == "passed" and preflight["group"] == group and
            preflight["error"] is None and preflight["runtimeManifestSHA256"] == runtime_hash,
            "Correctness/preparation did not pass against this runtime manifest")
    require(same(preflight["commands"], manifest["preflightCommands"]), "Preflight command list changed")
    require(same(preflight['metadataCommands'],manifest['metadataReceipts']),'Metadata command ledger changed')
    require([row['id'] for row in preflight['metadataCommands']]==['metadata-node-version','metadata-bun-version','metadata-os-packages'],'Metadata attempts changed')
    expected_preflight = (["node-public-corpus", "bun-public-corpus", "baseline-worker-session", "candidate-worker-session"]
        if group == "arm" else [name for engine in GROUPS["browsers"] for name in
                                (engine + "-baseline-sessions", engine + "-candidate-sessions", engine + "-probe")])
    require([row["id"] for row in preflight["commands"]] == expected_preflight,
            "Correctness command count/order changed")
    number(preflight["elapsedSeconds"], "preflight elapsed seconds", 0, 240)
    for command in preflight["commands"]:
        require(command["receipt"] == "preflight/" + command["id"] + ".receipt.json", "Preflight receipt path mismatch")
        receipt, _ = artifact(command["receipt"])
        is_probe = command["id"].endswith("-probe")
        expected_cwd = root
        expected_selectors = {}
        if group == "arm" and command["id"].endswith("-public-corpus"):
            runtime = command["id"].split("-")[0]
            expected_command = [manifest["executables"][runtime]["path"], "public-corpus.mjs",
                                "arms/baseline", "arms/candidate", str(output / f"preflight/{runtime}-semantic.json")]
        elif group == "arm":
            arm = command["id"].split("-")[0]
            expected_command = [manifest["executables"]["node"]["path"], "proofs/worker-sessions.mjs"]
            expected_cwd = root / "arms" / arm
        elif is_probe:
            runtime = command["id"].split("-")[0]
            expected_command = [manifest["executables"]["node"]["path"], "browser.mjs", "probe", runtime,
                                str(output / f"preflight/{runtime}-probe.json")]
        else:
            runtime, arm, _ = command["id"].split("-")
            expected_command = [manifest["executables"]["bun"]["path"], "--bun", "node_modules/vitest/vitest.mjs",
                                "run", "--config", "browser.config.mjs", "demo/sessions.browser.test.ts"]
            expected_selectors = {"SCREEN_BROWSER": runtime, "SCREEN_ARM": arm}
        audit_receipt(receipt, expected_command, max_seconds=60 if group == "arm" else 90,
                      rss_mib=1024 if group == "arm" else 2048, handshake=is_probe)
        require(command['state']=='passed' and command['argv']==expected_command and command['cwd']==str(expected_cwd),'Preflight launch identity/state mismatch')
        require(receipt["cwd"] == str(expected_cwd), "Correctness command cwd changed")
        require({key: value for key, value in receipt["cleanEnvironment"].items()
                 if key.startswith("SCREEN_")} == expected_selectors, "Preflight case selectors changed")
        for suffix in (".jsonl", ".stderr", ".supervisor.jsonl"):
            relative = "preflight/" + command["id"] + suffix
            data=(output / relative).read_bytes()
            if suffix!='.supervisor.jsonl':require(len(data)==receipt['output']['stdout' if suffix=='.jsonl' else 'stderr']['retainedBytes'],'Preflight output count mismatch')
            evidence[relative] = digest(data)
        if is_probe:
            probe, _ = artifact(f"preflight/{runtime}-probe.json")
            browser_pin = manifest["browsers"][runtime]
            require(same(probe, {key: value for key, value in browser_pin.items() if key != "ownedProcessInventory"}) and
                    same(receipt["observedProcesses"], browser_pin["ownedProcessInventory"]),
                    "Browser probe differs from frozen manifest/process inventory")
    for command in preflight['metadataCommands']:
        require(command['state']=='passed','Metadata command did not complete')
        if command['id']=='metadata-os-packages':expected_metadata=['dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\n']
        else:
            metadata_runtime='node' if command['id']=='metadata-node-version' else 'bun'
            expected_metadata=[manifest['executables'][metadata_runtime]['path'],'--version']
        require(command['argv']==expected_metadata,'Metadata command changed')
        receipt,_=artifact(command['receipt'])
        audit_receipt(receipt,command['argv'],14,1024 if group=='arm' else 2048,False,require_process_inventory=False)
        require(receipt['cwd']==str(root) and command['cwd']==str(root),'Metadata cwd changed')
        for suffix,stream in [('.jsonl','stdout'),('.stderr','stderr')]:
            relative='preflight/'+command['id']+suffix;data=(output/relative).read_bytes()
            require(len(data)==receipt['output'][stream]['retainedBytes'],'Metadata output count mismatch');evidence[relative]=digest(data)
    launches,launches_hash=read_log(output/'preflight/launches.jsonl')
    all_preflight={row['id']:row for row in preflight['commands']+preflight['metadataCommands']}
    require(len(launches)==2*len(all_preflight),'Preflight launch/finish count mismatch')
    for index in range(0,len(launches),2):
        start,finish=launches[index:index+2];command=all_preflight.pop(start['id'])
        expected={'event':'launch','metadata':command['id'].startswith('metadata-'),**command,'state':'started'}
        require(same(start,expected) and same(finish,{'event':'finish','id':command['id'],'state':'passed'}),'Preflight attempt ledger mismatch')
    require(not all_preflight,'Missing preflight launches');evidence['preflight/launches.jsonl']=launches_hash
    os_packages = (output / "preflight/os-packages.txt").read_bytes()
    require(digest(os_packages) == manifest["osPackagesSHA256"], "OS package inventory changed")
    evidence["preflight/os-packages.txt"] = digest(os_packages)
    if group == "arm":
        for runtime in GROUPS[group]:
            semantic, _ = artifact(f"preflight/{runtime}-semantic.json")
            require(semantic["passed"] is True and semantic["engine"] == runtime and
                    semantic["casesPerArm"] == 9 and semantic["publicOutcomesEqual"] is True and
                    type(semantic["baseline"]) is list and len(semantic["baseline"]) == 9 and
                    same(semantic["baseline"], semantic["candidate"]), "Public-corpus preflight did not agree")
    screen, _ = artifact("SCREEN.json")
    require(screen["schema"] == 1 and screen["state"] == "passed" and screen["group"] == group and
            screen["error"] is None, "Screen is failed or incomplete; no favorable summary is allowed")
    for key, value in hashes.items():
        require(screen[key] == value, "Screen input/runtime identity changed")
    require(same(screen["runIdentity"], manifest["runner"]), "Screen run/no-rerun identity changed")
    seconds_cap = 360 if group == "arm" else 900
    require(screen["screenSecondsCap"] == seconds_cap, "Screen wall-time cap changed")
    number(screen["elapsedSeconds"], "screen elapsed seconds", 0, seconds_cap)
    commands = screen["commands"]
    audit_schedule(group, commands)
    exact_keys(screen["frozenCounts"], GROUPS[group], "runtime freezes")
    frozen, frozen_hashes = {}, {}
    for runtime in GROUPS[group]:
        relative = screen["frozenCounts"][runtime]
        require(relative == f"screen/frozen-{runtime}.json", "Frozen-count path changed")
        frozen[runtime], frozen_hashes[runtime] = artifact(relative)
    audit_screen_events(group, screen["events"], commands, frozen_hashes, screen["frozenCounts"])
    schedule, schedule_hash = read_log(output / "screen/schedule.jsonl")
    require(same(schedule, screen["events"]), "Durable launch/freeze/finish log differs from SCREEN")
    evidence["screen/schedule.jsonl"] = schedule_hash
    results, calibrations = {}, {}
    raw_batches = 0
    expected_screen_files = {"schedule.jsonl", *(f"frozen-{runtime}.json" for runtime in GROUPS[group])}
    for command in commands:
        exact_keys(command, ("id", *IDENTITY_KEYS, "argv", "cwd", "result", "receipt",
                             "frozenCountsSHA256", "resultSHA256", "receiptSHA256"), "screen command")
        identity = tuple(command[key] for key in IDENTITY_KEYS)
        mode, runtime, case_name, arm, slot = identity
        name = command["id"]
        require(command["result"] == f"screen/{name}.json" and
                command["receipt"] == f"screen/{name}.receipt.json", "Subject evidence path changed")
        result, result_hash = artifact(command["result"])
        receipt, receipt_hash = artifact(command["receipt"])
        require(result_hash == command["resultSHA256"] and receipt_hash == command["receiptSHA256"],
                "Completed result/receipt bytes differ from screen ledger")
        executable = manifest["executables"]["bun" if runtime == "bun" else "node"]["path"]
        expected_argv = [executable, "subject.mjs" if group == "arm" else "browser.mjs", mode,
                         runtime, arm, str(slot), case_name, str(output / command["result"]), str(output / "RUNTIME.json")]
        if mode == "measure":
            expected_argv.append(str(output / screen["frozenCounts"][runtime]))
        require(command["argv"] == expected_argv and command["cwd"] == str(root), "Subject invocation changed")
        audit_receipt(receipt, expected_argv, 15 if group == "arm" else 30,
                      512 if group == "arm" else 2048, True)
        require(receipt["cwd"] == command["cwd"], "Receipt cwd changed")
        audit_result(result, identity, hashes)
        if runtime in GROUPS["browsers"]:
            audit_browser(result, manifest, pin_map)
        log, log_hash = read_log(output / "screen" / (name + ".jsonl"))
        require((output/'screen'/(name+'.jsonl')).stat().st_size==receipt['output']['stdout']['retainedBytes'],'Subject stdout count mismatch')
        require((output/'screen'/(name+'.stderr')).stat().st_size==receipt['output']['stderr']['retainedBytes'],'Subject stderr count mismatch')
        audit_log(log, result, result_hash)
        require(same(receipt["handshake"], log[2]), "Supervisor acknowledgment differs from subject log")
        roots = receipt["handshake"]["roots"]
        require(len(roots) == (1 if group == "arm" else 2), "Wrong number of owned subject roots")
        for index, owned_root in enumerate(roots):
            matches = [row for row in receipt["observedProcesses"] if row["pid"] == owned_root["pid"] and
                       row["starttime"] == owned_root["starttime"]]
            require(len(matches) == 1, "Owned root identity absent/duplicated in process inventory")
            observed = matches[0]
            hash_value(observed["executableSHA256"], "owned-root executable hash")
            require(type(observed["cmdline"]) is list and observed["cmdline"], "Owned root argv missing")
            if index == 0:
                runtime_binary = manifest["executables"]["bun" if runtime == "bun" else "node"]
                require(observed["executableSHA256"] == runtime_binary["sha256"] and
                        observed["executable"] == runtime_binary["path"], "Controller executable pin mismatch")
            else:
                browser_pin = manifest["browsers"][runtime]
                matches = [row for row in browser_pin["ownedProcessInventory"]
                           if row["pid"] == browser_pin["browserRootPID"]]
                require(len(matches) == 1 and matches[0].get("executableSHA256") == observed["executableSHA256"] and
                        matches[0].get("executable") == observed["executable"],
                        "Browser root executable differs from frozen preflight identity")
        evidence[f"screen/{name}.jsonl"] = log_hash
        for suffix in (".stderr", ".supervisor.jsonl"):
            data = (output / "screen" / (name + suffix)).read_bytes()
            evidence[f"screen/{name}{suffix}"] = digest(data)
        expected_screen_files.update(name + suffix for suffix in
                                     (".json", ".jsonl", ".stderr", ".receipt.json", ".supervisor.jsonl"))
        if mode == "calibrate":
            calibrations[(runtime, case_name, arm)] = (result, result_hash)
        else:
            counts = frozen[runtime]["cases"][case_name]
            own_cal = counts["calibrations"][arm]
            require(result["cycles"] == counts["cycles"][arm] and
                    result["capped"] == own_cal["capped"] and result["capReason"] == own_cal["capReason"],
                    "Measured count or original cap status changed")
            require(result["frozenCountsSHA256"] == frozen_hashes[runtime] and
                    result["calibrationSHA256"] == {a: counts["calibrations"][a]["sha256"] for a in ARMS},
                    "Measured calibration/count references differ from frozen bytes")
        results[identity] = result
        raw_batches += len(result["batches"])
    for runtime in GROUPS[group]:
        audit_frozen(runtime, frozen[runtime], calibrations, hashes)
    actual_files = {path.name for path in (output / "screen").iterdir()}
    require(actual_files == expected_screen_files, "Unlisted, replacement or missing screen evidence files")
    # Catch mutations between the initial audit and summary computation.
    require(digest((root / "INPUT-PINS.json").read_bytes()) == pins_hash, "Input pin file changed during audit")
    audit_pins(root, pins)
    summary = screen_summary(group, results, raw_batches, evidence)
    summary["runIdentity"] = manifest["runner"]
    return summary


def main(argv):
    require(len(argv) == 2 and argv[0] in GROUPS, "Usage: python3 analyze.py arm|browsers results/<group>")
    group, output_text = argv
    root = Path(__file__).resolve().parent
    output = Path(output_text).resolve()
    require(output == root / "results" / group, "Analysis requires this packet's fixed group output directory")
    try:
        summary = audit_group(root, group, output)
    except Exception as error:
        failure = {"schema": 1, "group": group, "auditPassed": False,
                   "status": "failed-or-incomplete-no-performance-claim", "error": str(error),
                   "stopping": "Retain complete and partial raw evidence. No replacements or rerun."}
        with (output / "AUDIT-FAILURE.json").open("x") as stream:
            json.dump(failure, stream, indent=2, allow_nan=False)
            stream.write("\n")
        print(json.dumps(failure, allow_nan=False))
        return 1
    with (output / "SUMMARY.json").open("x") as stream:
        json.dump(summary, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps(summary, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
