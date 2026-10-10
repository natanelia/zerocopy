"""Future synthetic gate, deliberately NOT run during source-only preparation.

Run later with: python3 protocol-checks.py
Only Python's standard library and import-safe analyze.py are imported. No
candidate modules, subprocesses, browser launches, host clocks or benchmarks.
"""
import copy
import unittest
import analyze as audit


HASHES = {key: "a" * 64 for key in
          ("protocolSHA256", "inputPinsSHA256", "runtimeManifestSHA256")}


def calibration_rows(case_name, durations):
    rows = [{"phase": "seed-warmup", "index": index, "cycles": 32, "ns": 1}
            for index in range(2)]
    count = 32
    for index, duration in enumerate(durations):
        rows.append({"phase": "pilot", "index": index, "cycles": count, "ns": duration})
        count = audit.next_cycles(count, duration, audit.CASES[case_name]["maxCycles"])
    return rows


def result_fixture():
    identity = ("measure", "node", "mixed-128", "baseline", 0)
    result = {"schema": 1, **dict(zip(audit.IDENTITY_KEYS, identity)), **HASHES,
              "cycles": 32, "operationsPerBatch": 1024, "capped": False, "capReason": None,
              "calibrationSHA256": {arm: "b" * 64 for arm in audit.ARMS},
              "frozenCountsSHA256": "c" * 64, "fixture": audit.fixture_for("mixed-128"),
              "fixtureSHA256": audit.fixture_hash("mixed-128"),
              "batches": [], "disposed": True, "passed": True}
    version = 0
    for phase, index in (("warmup", 0), ("warmup", 1), ("measure", 0), ("measure", 1), ("measure", 2)):
        checksum = audit.checksum_for("mixed-128", 32, version)
        row = {"event": "batch", **dict(zip(audit.IDENTITY_KEYS, identity)),
               "phase": phase, "index": index, "cycles": 32, "operations": 1024,
               "publications": 32, "explicitFlushes": 992, "ns": 100000000,
               "nsPerOperation": 100000000 / 1024, "nsPerCycle": 100000000 / 32,
               "versionBefore": version, "versionAfter": version + 32,
               "checksum": checksum, "expectedChecksum": checksum,
               "belowFloor": False, "overTimeCap": False,
               "fixtureSHA256": result["fixtureSHA256"]}
        result["batches"].append(row)
        version += 32
    return identity, result


def log_fixture(result):
    identity = {key: result[key] for key in audit.IDENTITY_KEYS}
    events = [{"event": "subject-start", **identity,
               **{key: result[key] for key in (*HASHES, "frozenCountsSHA256", "calibrationSHA256")}},
              {"event": "containment-ready", "rootPids": [123]},
              {"event": "containment-verified", "roots": [{"pid": 123, "pgrp": 123,
                 "ppid": 100, "starttime": "456"}], "method": "linux-subreaper-descendant-census"},
              {"event": "fixture", "fixture": result["fixture"], "fixtureSHA256": result["fixtureSHA256"]}]
    for row in result["batches"]:
        events.extend([
            {"event": "batch-start", **{key: row[key] for key in
                (*audit.IDENTITY_KEYS, "phase", "index", "cycles", "operations", "versionBefore")}},
            row,
            {"event": "validation", **{key: row[key] for key in
                ("phase", "index", "cycles", "checksum", "expectedChecksum")},
             "version": row["versionAfter"], "passed": True, "aliases": True,
             "retainedSnapshots": True, "errors": []}])
    events.extend([{"event": "dispose", "closed": True, "errors": []},
                   {"event": "complete", **identity, "resultSHA256": "d" * 64,
                    "cycles": 32, "capped": False, "batchCount": 5}])
    return events


def rule_fixture(**changes):
    values = {"ratios": [.90] * 4, "interval": [.85, .95], "median_saved": 10,
              "aa_ratios": [1, 1], "bb_ratios": [1, 1], "arm_ranges": [0, 0],
              "spreads": [0] * 8}
    values.update(changes)
    return audit.evaluate_rules(**values)


class ProtocolChecks(unittest.TestCase):
    def test_served_bytes_identity_and_tamper(self):
        paths=('workload.mjs','arms/baseline/dist/shared.js','arms/baseline/dist/worker.js')
        pins={path:str(index+1)*64 for index,path in enumerate(paths)}
        result={'runtime':'chromium','arm':'baseline','browser':{
          'version':'153.0.8010.12','capabilities':{'crossOriginIsolated':True,'sharedMemory':True,
            'timerResolutionMs':0.005,'timerResolutionObservations':10,'userAgent':'synthetic'},
          'servedSHA256':{'/'+path:value for path,value in pins.items()}}}
        manifest={'browsers':{'chromium':{'version':'153.0.8010.12'}}}
        audit.audit_browser(result,manifest,pins)
        changed=copy.deepcopy(result);changed['browser']['servedSHA256']['/workload.mjs']='f'*64
        wrong_arm=copy.deepcopy(result);wrong_arm['browser']['servedSHA256']['/arms/candidate/dist/shared.js']='2'*64
        missing=copy.deepcopy(result);del missing['browser']['servedSHA256']['/arms/baseline/dist/worker.js']
        for invalid in (changed,wrong_arm,missing):
            with self.assertRaises(audit.AuditError):audit.audit_browser(invalid,manifest,pins)

    def test_calibration_first_target_and_growth(self):
        self.assertEqual(audit.next_cycles(32, 1, 8192), 512)
        self.assertEqual(audit.next_cycles(8192, 1, 8192), 8192)
        self.assertEqual(audit.next_cycles(32, 99999999, 8192), 64)
        self.assertEqual(audit.next_cycles(32, 30000000, 8192), 134)
        rows = calibration_rows("mixed-128", [100000000])
        audit.audit_calibration("mixed-128", rows, 32, False, None)
        with self.assertRaises(audit.AuditError):
            audit.audit_calibration("mixed-128", calibration_rows("mixed-128", [100000000] * 2), 64, False, None)

    def test_calibration_caps_and_no_eighth_pilot(self):
        rows = calibration_rows("mixed-128", [1] * 3)
        audit.audit_calibration("mixed-128", rows, 8192, True, "count")
        rows = calibration_rows("reverted-one", [99999999] * 7)
        audit.audit_calibration("reverted-one", rows, 2048, True, "pilot-count")
        for bad in (rows[:-1], calibration_rows("reverted-one", [99999999] * 8)):
            with self.assertRaises(audit.AuditError):
                audit.audit_calibration("reverted-one", bad, bad[-1]["cycles"], True, "pilot-count")

    def test_common_controls_keep_original_cap_metadata(self):
        calibrations = {"baseline": {"cycles": 128, "capped": True},
                        "candidate": {"cycles": 256, "capped": False}}
        before = copy.deepcopy(calibrations)
        for case_name in audit.CONTROLS:
            self.assertEqual(audit.frozen_cycles(case_name, calibrations),
                             {"baseline": 256, "candidate": 256})
        self.assertEqual(audit.frozen_cycles("mixed-128", calibrations),
                         {"baseline": 128, "candidate": 256})
        self.assertEqual(calibrations, before)

    def test_schedule_cardinality_order_and_replacement_rejected(self):
        totals = {"calibrate": 0, "measure": 0}
        for group, expected in (("arm", (16, 64)), ("browsers", (24, 96))):
            identities = audit.expected_subjects(group)
            commands = [{"id": audit.subject_id(row), **dict(zip(audit.IDENTITY_KEYS, row))}
                        for row in identities]
            audit.audit_schedule(group, commands)
            for mode, count in zip(("calibrate", "measure"), expected):
                self.assertEqual(sum(row[0] == mode for row in identities), count)
                totals[mode] += count
            for bad in (commands[:-1], commands + [commands[-1]], [commands[1], commands[0]] + commands[2:]):
                with self.assertRaises(audit.AuditError):
                    audit.audit_schedule(group, bad)
        self.assertEqual(totals, {"calibrate": 40, "measure": 160})
        self.assertEqual(audit.PAIRS, ((0, 1), (3, 2), (5, 4), (6, 7)))

    def test_checksums_mixed_changed_reverted_and_uint32_wrap(self):
        self.assertEqual(audit.checksum_for("mixed-128", 2, 7), 32 * (8 + 9))
        self.assertEqual(audit.checksum_for("mixed-4", 2, 7), 32 * (8 + 9))
        self.assertEqual(audit.checksum_for("changed-single", 1, 7), sum(range(8, 40)))
        self.assertEqual(audit.checksum_for("reverted-one", 4194304, 1), 134217728)
        self.assertEqual(audit.checksum_for("mixed-128", 1, 0xffffffff), 0)

    def test_count_freeze_requires_completed_calibrations_before_measurements(self):
        group = "arm"
        hashes = {runtime: "c" * 64 for runtime in audit.GROUPS[group]}
        paths = {runtime: f"screen/frozen-{runtime}.json" for runtime in audit.GROUPS[group]}
        commands, events = [], []
        frozen = False
        for identity in audit.expected_subjects(group):
            mode, runtime, case_name, arm, slot = identity
            if mode == "measure" and not frozen:
                for engine in audit.GROUPS[group]:
                    events.append({"event": "freeze", "runtime": engine,
                                   "sha256": hashes[engine], "path": paths[engine]})
                frozen = True
            freeze_hash = hashes[runtime] if mode == "measure" else None
            command = {"id": audit.subject_id(identity), **dict(zip(audit.IDENTITY_KEYS, identity)),
                       "frozenCountsSHA256": freeze_hash,
                       "resultSHA256": "d" * 64, "receiptSHA256": "e" * 64}
            commands.append(command)
            events.extend([{"event": "launch", **{key: command[key] for key in
                              ("id", *audit.IDENTITY_KEYS, "frozenCountsSHA256")}},
                           {"event": "finish", **{key: command[key] for key in
                              ("id", "resultSHA256", "receiptSHA256")}}])
        audit.audit_screen_events(group, events, commands, hashes, paths)
        early_freeze = next(event for event in events if event["event"] == "freeze")
        for bad in ([early_freeze] + events, events[:-1], [events[0], events[2], events[1]] + events[3:]):
            with self.assertRaises(audit.AuditError):
                audit.audit_screen_events(group, bad, commands, hashes, paths)
        wrong_hash = copy.deepcopy(events)
        next(event for event in wrong_hash if event["event"] == "freeze")["sha256"] = "f" * 64
        with self.assertRaises(audit.AuditError):
            audit.audit_screen_events(group, wrong_hash, commands, hashes, paths)

    def test_raw_row_and_log_reconciliation(self):
        identity, result = result_fixture()
        audit.audit_result(result, identity, HASHES)
        events = log_fixture(result)
        audit.audit_log(events, result, "d" * 64)
        for key, value in (("cycles", True), ("ns", float("nan")), ("ns", 1000000001),
                           ("checksum", 0), ("versionAfter", 0), ("belowFloor", True),
                           ("nsPerOperation", 0), ("surprise", 1)):
            bad = copy.deepcopy(result)
            bad["batches"][0][key] = value
            with self.assertRaises(audit.AuditError):
                audit.audit_result(bad, identity, HASHES)
        for bad in (events[:-1], events + [events[-1]], events[:5] + [events[6], events[5]] + events[7:]):
            with self.assertRaises(audit.AuditError):
                audit.audit_log(bad, result, "d" * 64)
        with self.assertRaises(audit.AuditError):
            audit.audit_log(events, result, "e" * 64)
        with self.assertRaises(audit.AuditError):
            audit.audit_result({**result, "batches": result["batches"][:-1]}, identity, HASHES)

    def test_malicious_json_and_paths(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e999}', b'{'):
            with self.assertRaises(audit.AuditError):
                audit.decode_json(raw)
        for path in ("/outside", "../outside", "a/../b", "a//b", "a\\b"):
            with self.assertRaises(audit.AuditError):
                audit.safe_path(audit.Path("."), path)

    def test_gain_thresholds_and_short_capped_gating(self):
        self.assertTrue(rule_fixture()["pairedGainThresholdMet"])
        for change in ({"ratios": [.9, .9, .9, 1]}, {"interval": [.85, .9500001]},
                       {"median_saved": 9.999}, {"aa_ratios": [1.11, 1]},
                       {"short_warm": True}, {"short_measured": True}, {"capped": True}):
            self.assertFalse(rule_fixture(**change)["pairedGainThresholdMet"])
        # Noise remains reported even when all primary benefit conditions pass.
        self.assertTrue(rule_fixture(spreads=[.11] * 8)["pairedGainThresholdMet"])
        self.assertTrue(rule_fixture(spreads=[.11] * 8)["noisy"])

    def test_three_batches_are_one_subject_estimate(self):
        processes = []
        for slot, arm in enumerate(audit.ORDER):
            _, result = result_fixture()
            result["arm"], result["slot"] = arm, slot
            target = 100 if arm == "baseline" else 80
            for index, row in enumerate(result["batches"][2:]):
                row["nsPerOperation"] = target + [-1, 0, 1][index]
            processes.append(result)
        calibrations = {arm: {"cycles": 32, "capped": False} for arm in audit.ARMS}
        summary = audit.summarize_cell("node", "mixed-128", processes, calibrations)
        self.assertEqual(summary["independentPairCount"], 4)
        self.assertEqual(summary["pairedCandidateOverBaseline"], [.8] * 4)
        self.assertEqual(summary["pairedSavedNsPerOperation"], [20] * 4)
        self.assertTrue(summary["pairedGainThresholdMet"])
        self.assertAlmostEqual(summary["descriptive95LogRatioInterval"][0], .8)
        self.assertAlmostEqual(summary["descriptive95LogRatioInterval"][1], .8)

    def test_noise_adverse_and_control_boundary(self):
        self.assertFalse(rule_fixture(aa_ratios=[1.05, .95], arm_ranges=[.05, .05], spreads=[.10] * 8)["noisy"])
        for change in ({"aa_ratios": [1.050001, 1]}, {"bb_ratios": [.949999, 1]},
                       {"arm_ranges": [.050001, 0]}, {"spreads": [.100001] * 8}):
            self.assertTrue(rule_fixture(**change)["noisy"])
        self.assertEqual(rule_fixture(ratios=[1.0199, 1.02, 1.03, .9])["adversePairIndexesAtTwoPercent"], [1, 2])
        self.assertFalse(rule_fixture(interval=[1.02, 1.04], is_control=True)["controlRegressionBlocksAdvancement"])
        self.assertTrue(rule_fixture(interval=[1.020001, 1.04], is_control=True)["controlRegressionBlocksAdvancement"])
        self.assertFalse(rule_fixture(interval=[1.020001, 1.04], is_control=False)["controlRegressionBlocksAdvancement"])


if __name__ == "__main__":
    unittest.main()
