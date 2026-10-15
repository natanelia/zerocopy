"""Synthetic analysis checks, prepared as source and NOT EXECUTED.

Execution/import needs the separate bounded inert-check release. These checks
contain no target imports, fixtures, clocks, GC, subprocesses or scientific data.
The only local import is this packet's standard-library-only analysis module.
Independent exact-packet statistical validation remains a separate future step.
"""

import copy
import math
import unittest

import analysis


def snapshot(engine, *, startup=False):
    state = {"heapUsed": 10 * 1024 * 1024, "heapTotal": 20 * 1024 * 1024,
             "external": 4096, "arrayBuffers": 2048, "rss": 30 * 1024 * 1024,
             "arenaUsedBytes": 0 if startup else 4096,
             "arenaCapacityBytes": 0 if startup else 8192}
    if engine == "bun":
        state.update(heapSize=10 * 1024 * 1024,
                     heapCapacity=20 * 1024 * 1024, extraMemorySize=1024)
    return state


def change_owned_heap(state, engine, delta):
    state["heapUsed"] += delta
    if engine == "bun":
        state["heapSize"] += delta


def synthetic_study():
    processes = []
    for engine in analysis.ENGINES:
        for pair in range(8):
            for arm in analysis.ARMS:
                cases = {}
                for case in analysis.MEMORY_CASES:
                    increment = ((1024 * 1024 if arm == "baseline" else 512 * 1024)
                                 if case == "P" else 4096)
                    before = snapshot(engine)
                    paused = dict(before)
                    change_owned_heap(paused, engine, increment)
                    cycle = {"before": before, "paused": paused, "released": dict(before),
                             "rawPaused": dict(paused) if case in analysis.RAW_PAUSE_CASES else None,
                             "resumed_ok": True}
                    cases[case] = {"eligible": True, "invalid_reasons": [],
                                   "cycles": [copy.deepcopy(cycle) for unused in range(2 if case == "P" else 1)]}
                endpoint = {"eligible": True, "invalid_reasons": [], "k": 1,
                            "warmup_ms": [10.0] * 4, "measured_ms": [10.0] * 6,
                            "clock_ok": True, "checksum_ok": True,
                            "overhead_ms_per_call": 0.000001, "clock_resolution_ms": 0.000001}
                endpoints = {name: copy.deepcopy(endpoint) for name in analysis.ENDPOINTS}
                endpoints["startup:import"].update(k=1, warmup_ms=[], measured_ms=[1.0])
                before_import = snapshot(engine, startup=True)
                after_import = dict(before_import)
                change_owned_heap(after_import, engine, 128 * 1024)
                processes.append({"engine": engine, "pair": pair, "arm": arm,
                                  "eligible": True, "invalid_reasons": [],
                                  "identity_ok": True, "oracle_ok": True, "backing_ok": True,
                                  "endpoints": endpoints,
                                  "memory": {"eligible": True, "invalid_reasons": [], "cases": cases},
                                  "startup": {"before": before_import, "after": after_import,
                                              "eligible": True, "invalid_reasons": []},
                                  "terminal_high_water_rss_bytes": 40 * 1024 * 1024})
    return {"schema": analysis.SCHEMA, "method_sha256": analysis.METHOD_SHA256,
            "complete": True, "first_failure": None, "processes": processes,
            "accounting_shift_reviews": [], "raw_evidence_sha256": "a" * 64,
            "raw_accounting_review": {"accepted": True, "method_sha256": analysis.METHOD_SHA256,
                                      "raw_evidence_sha256": "a" * 64,
                                      "source": "synthetic:current-raw-accounting-review",
                                      "rationale": "Synthetic review fixture only; no real review is claimed"}}


def latency_result(result, engine="node", name="P:first"):
    return next(row for row in result["latency"] if row["engine"] == engine and row["endpoint"] == name)


def memory_result(result, engine="node", case="P"):
    engine_row = next(row for row in result["memory"] if row["engine"] == engine)
    return next(row for row in engine_row["cases"] if row["case"] == case)


def contrast_result(result, engine="node", name="P:retained_saving"):
    return next(row for row in result["memory_contrasts"]
                if row["engine"] == engine and row["endpoint"] == name)


def selected_processes(study, engine="node", arm="candidate"):
    return [row for row in study["processes"] if row["engine"] == engine and row["arm"] == arm]


def closed_form_critical_values():
    """Unexecuted secondary check, independent of the sealed values' derivation.

    The df=7 density substitution t=sqrt(7)*tan(theta) integrates cos(theta)**6.
    NIST: https://www.itl.nist.gov/div898/handbook/eda/section3/eda3664.htm
    This CDF inversion is synthetic-check source only, never production analysis.
    """
    values = {}
    for name, probability in analysis.QUANTILES.items():
        lower, upper = 0.0, 32.0
        for unused in range(96):
            middle = (lower + upper) / 2
            theta = math.atan(middle / math.sqrt(7))
            cdf = 0.5 + (theta + 0.75 * math.sin(2 * theta)
                         + 0.15 * math.sin(4 * theta)
                         + math.sin(6 * theta) / 60) / math.pi
            if cdf < probability:
                lower = middle
            else:
                upper = middle
        values[name] = (lower + upper) / 2
    return values


class AnalysisChecks(unittest.TestCase):
    def test_exact_two_sided_families_and_independent_density_integral(self):
        values = analysis.fixed_critical_values()
        self.assertEqual(analysis.QUANTILES["latency38"], 1 - 0.05 / 76)
        self.assertEqual(analysis.QUANTILES["memory22"], 1 - 0.05 / 44)
        self.assertAlmostEqual(values["pointwise95"], 2.3646242515927853, places=12)
        self.assertGreater(values["latency38"], values["memory22"])
        self.assertGreater(values["memory22"], values["pointwise95"])
        expected = {"pointwise95": 2.3646242515927853,
                    "memory22": 4.6755214023824, "latency38": 5.155633357451718}
        secondary = closed_form_critical_values()
        for name in expected:
            self.assertEqual(values[name], expected[name])
            self.assertLessEqual(abs(secondary[name] - expected[name]), 1e-11)
        # Composite Simpson integrates the density directly; it does not call
        # the closed-form CDF used to select the proposed critical values.
        for name, value in values.items():
            panels = 20000
            step = value / panels
            factor = 16 / (5 * math.pi * math.sqrt(7))
            terms = []
            for index in range(panels + 1):
                x = index * step
                weight = 1 if index in (0, panels) else (4 if index % 2 else 2)
                terms.append(weight * factor * (1 + x * x / 7) ** -4)
            cdf = 0.5 + step * math.fsum(terms) / 3
            self.assertLessEqual(abs(cdf - analysis.QUANTILES[name]), 1e-12)
        self.assertIn("pending", analysis.CRITICAL_VALIDATION_STATUS)
        self.assertEqual(analysis.CRITICAL_PROVENANCE_SHA256,
                         "f7b3d7535e2f1887519e9867e07c585d920c04ffecb3cedd662ebb43885b6752")

    def test_fixed_matrix_and_strong_scoped_clearance(self):
        study = synthetic_study()
        result = analysis.analyze(study)
        self.assertEqual(len(result["latency"]), 38)
        self.assertEqual(len(result["memory_contrasts"]), 22)
        self.assertEqual(len(analysis.ITERATION_ENDPOINTS), 18)
        self.assertNotIn("N8192:close", analysis.ENDPOINTS)
        self.assertEqual(result["separate_95_percent_families"], {"memory": 22, "latency": 38})
        self.assertEqual(result["disposition"], "strong_scoped_screen_clearance")
        self.assertTrue(result["scoped_node_lead_eligible"])
        self.assertTrue(result["all_38_latency_controls_cleared"])
        self.assertTrue(result["all_22_memory_contrasts_cleared"])
        self.assertEqual(result["raw_processes"], study["processes"])

    def test_scoped_node_lead_does_not_require_bun_benefit_or_full_clearance(self):
        study = synthetic_study()
        for process in selected_processes(study, engine="bun"):
            for cycle in process["memory"]["cases"]["P"]["cycles"]:
                change_owned_heap(cycle["paused"], "bun", 512 * 1024)
                change_owned_heap(cycle["rawPaused"], "bun", 512 * 1024)
        for process in selected_processes(study):
            log_ratio = 0.03 if process["pair"] % 2 else -0.03
            process["endpoints"]["N4097:close"]["measured_ms"] = [10 * math.exp(log_ratio)] * 6
        result = analysis.analyze(study)
        self.assertTrue(result["scoped_node_lead_eligible"])
        self.assertFalse(result["strong_scoped_screen_clearance"])
        self.assertFalse(result["bun_material_benefit_corroborated"])
        self.assertFalse(result["all_22_memory_contrasts_cleared"])
        self.assertEqual(result["disposition"], "scoped_node_retained_memory_lead")
        self.assertTrue(any(row["endpoint"] == "N4097:close" for row in result["unresolved_latency_controls"]))

    def test_pointwise_latency_harm_survives_simultaneous_overlap_and_failed_peer(self):
        study = synthetic_study()
        for process in selected_processes(study):
            log_ratio = 0.04 + (0.014 if process["pair"] % 2 else -0.014)
            process["endpoints"]["P:first"]["measured_ms"] = [10 * math.exp(log_ratio)] * 6
        selected_processes(study, engine="bun")[0]["endpoints"]["F128:full"]["eligible"] = False
        study.update(complete=False, first_failure="Synthetic unrelated later failure")
        result = analysis.analyze(study)
        endpoint = latency_result(result)
        self.assertGreater(endpoint["pointwise_95"]["lower"], 1.02)
        self.assertLess(endpoint["bonferroni_95_across_38"]["lower"], 1.02)
        self.assertTrue(result["unchanged_candidate_advancement_veto"])
        self.assertEqual(result["disposition"], "material_adverse_control_veto")
        self.assertFalse(result["scoped_node_lead_eligible"])

    def test_nonprimary_and_startup_memory_harms_veto_without_prior_pooling(self):
        for engine, case, delta in (("node", "N1", 2048), ("bun", "startup:import", 8192)):
            study = synthetic_study()
            for process in selected_processes(study, engine=engine):
                if case == "startup:import":
                    change_owned_heap(process["startup"]["after"], engine, delta)
                else:
                    change_owned_heap(process["memory"]["cases"][case]["cycles"][0]["paused"], engine, delta)
            result = analysis.analyze(study)
            self.assertEqual(contrast_result(result, engine, case + ":candidate_minus_baseline")["status"], "adverse")
            self.assertTrue(result["unchanged_candidate_advancement_veto"])
        study = synthetic_study()
        study["prior_adverse_evidence"] = [{"valid": True, "source": "synthetic:old-candidate",
                                             "demonstrated_over_two_percent": True}]
        result = analysis.analyze(study)
        self.assertFalse(result["unchanged_candidate_advancement_veto"])
        self.assertFalse(result["complete"])
        self.assertTrue(result["historical_evidence_not_pooled"])

    def test_all_chunks_equal_weight_and_k_precedes_log_ratio(self):
        study = synthetic_study()
        for process in selected_processes(study):
            endpoint = process["endpoints"]["P:first"]
            endpoint["measured_ms"] = [10, 10, 10, 10, 10, 70]
            endpoint["diagnostics"] = {"gc": True, "unstable": True, "slow_chunk": 5}
        endpoint = latency_result(analysis.analyze(study))
        self.assertEqual(endpoint["pairs"][0]["candidate"]["mean_ms"], 20)
        self.assertEqual(endpoint["status"], "adverse")
        self.assertAlmostEqual(endpoint["paired_log_ratios"][0], math.log(2))
        for process in study["processes"]:
            endpoint = process["endpoints"]["F513:full"]
            endpoint["k"] = 4
            endpoint["measured_ms"] = ([4, 8, 12, 16, 20, 24] if process["arm"] == "baseline"
                                        else [8, 16, 24, 32, 40, 48])
        endpoint = latency_result(analysis.analyze(study), name="F513:full")
        self.assertEqual(endpoint["pairs"][0]["baseline"]["mean_ms"], 3.5)
        self.assertEqual(endpoint["pairs"][0]["candidate"]["mean_ms"], 7)

    def test_any_bad_pair_or_chunk_invalidates_entire_endpoint_without_subset_inference(self):
        for failure in ("missing", "duplicate", "timer", "calibration", "k"):
            study = synthetic_study()
            process = selected_processes(study)[-1]
            if failure == "missing":
                study["processes"].remove(process)
            elif failure == "duplicate":
                study["processes"].append(copy.deepcopy(process))
            elif failure == "timer":
                process["endpoints"]["P:first"]["measured_ms"][-1] = 0
            elif failure == "calibration":
                process["endpoints"]["P:first"]["calibration_eligible"] = False
            else:
                process["endpoints"]["P:first"]["k"] = 4
            result = analysis.analyze(study)
            endpoint = latency_result(result)
            self.assertFalse(endpoint["valid"])
            self.assertEqual(endpoint["status"], "unresolved")
            self.assertNotIn("pointwise_95", endpoint)
            self.assertEqual(latency_result(result, engine="bun")["status"], "cleared")
            self.assertEqual(len(result["raw_processes"]), len(study["processes"]))

    def test_import_single_observation_no_warmup_no_five_ms_floor(self):
        study = synthetic_study()
        for process in study["processes"]:
            process["endpoints"]["startup:import"]["measured_ms"] = [0.01]
        result = analysis.analyze(study)
        self.assertEqual(latency_result(result, name="startup:import")["status"], "cleared")
        endpoint = selected_processes(study)[0]["endpoints"]["startup:import"]
        endpoint["warmup_ms"] = [0.01]
        self.assertFalse(latency_result(analysis.analyze(study), name="startup:import")["valid"])
        endpoint["warmup_ms"] = []
        endpoint["measured_ms"] = [0.01, 0.01]
        self.assertFalse(latency_result(analysis.analyze(study), name="startup:import")["valid"])
        endpoint["measured_ms"] = [0.01]
        endpoint["k"] = 4
        self.assertFalse(latency_result(analysis.analyze(study), name="startup:import")["valid"])

    def test_each_timer_bracket_resolution_and_overhead_limits(self):
        for name in ("P:first", "P:full", "N4097:close", "startup:import"):
            for timer_field in ("clock_resolution_ms", "overhead_ms_per_call"):
                study = synthetic_study()
                for process in study["processes"]:
                    endpoint = process["endpoints"][name]
                    endpoint["measured_ms"] = [10.0] * (1 if name == "startup:import" else 6)
                    endpoint[timer_field] = 0.05
                self.assertTrue(latency_result(analysis.analyze(study), name=name)["valid"])
                endpoint = selected_processes(study)[0]["endpoints"][name]
                endpoint["measured_ms"][-1] = 9.999
                self.assertFalse(latency_result(analysis.analyze(study), name=name)["valid"])
                self.assertEqual(endpoint["measured_ms"][-1], 9.999)
                endpoint["measured_ms"][-1] = 10
                if name != "startup:import":
                    endpoint["warmup_ms"][0] = 9.999
                    self.assertFalse(latency_result(analysis.analyze(study), name=name)["valid"])
        study = synthetic_study()
        for process in study["processes"]:
            process["endpoints"]["P:first"].update(k=4, clock_resolution_ms=0.02)
        self.assertFalse(latency_result(analysis.analyze(study))["valid"])

    def test_aggregate_extended_ladder_and_frozen_k(self):
        study = synthetic_study()
        for process in study["processes"]:
            process["endpoints"]["N4097:close"]["k"] = 1048576
        self.assertTrue(latency_result(analysis.analyze(study), name="N4097:close")["valid"])
        selected_processes(study)[0]["endpoints"]["N4097:close"]["k"] = 262144
        self.assertFalse(latency_result(analysis.analyze(study), name="N4097:close")["valid"])

    def test_node_moved_backing_charged_once_and_bun_extra_not_double_counted(self):
        study = synthetic_study()
        for process in selected_processes(study):
            for cycle in process["memory"]["cases"]["P"]["cycles"]:
                for state in ("paused", "rawPaused"):
                    cycle[state]["external"] += 409600
                    cycle[state]["arrayBuffers"] += 409600
        result = analysis.analyze(study)
        row = memory_result(result)["pairs"][0]["candidate"]
        self.assertEqual(row["retained_increment"], 512 * 1024 + 409600)
        self.assertEqual(contrast_result(result)["paired_arithmetic_contrasts_bytes"][0], 1024 * 1024 - 512 * 1024 - 409600)
        self.assertFalse(result["scoped_node_lead_eligible"])
        for process in selected_processes(study, engine="bun"):
            for cycle in process["memory"]["cases"]["P"]["cycles"]:
                cycle["paused"]["extraMemorySize"] += 409600
                cycle["rawPaused"]["extraMemorySize"] += 409600
        bun = memory_result(analysis.analyze(study), engine="bun")["pairs"][0]["candidate"]
        self.assertEqual(bun["retained_increment"], 512 * 1024)

    def test_per_component_release_guards_reject_cancelling_residue(self):
        for engine in analysis.ENGINES:
            study = synthetic_study()
            cycle = selected_processes(study, engine=engine)[0]["memory"]["cases"]["N1"]["cycles"][0]
            if engine == "node":
                cycle["released"]["heapUsed"] += 513
                cycle["released"]["external"] -= 513
            else:
                cycle["released"]["extraMemorySize"] += 513
            result = analysis.analyze(study)
            self.assertFalse(memory_result(result, engine, "N1")["valid"])
            self.assertTrue(memory_result(result, engine, "P")["valid"])
            self.assertNotIn("pointwise_95", contrast_result(result, engine, "N1:candidate_minus_baseline"))
            self.assertFalse(result["scoped_node_lead_eligible"])

    def test_release_guard_boundaries_and_raw_pause_requirements(self):
        for case, limit in analysis.RELEASE_LIMITS.items():
            study = synthetic_study()
            cycle = selected_processes(study)[0]["memory"]["cases"][case]["cycles"][0]
            cycle["released"]["heapUsed"] += limit
            self.assertTrue(memory_result(analysis.analyze(study), case=case)["valid"])
            cycle["released"]["heapUsed"] += 1
            self.assertFalse(memory_result(analysis.analyze(study), case=case)["valid"])
        study = synthetic_study()
        cycle = selected_processes(study)[0]["memory"]["cases"]["N4097"]["cycles"][0]
        cycle["rawPaused"] = None
        self.assertFalse(memory_result(analysis.analyze(study), case="N4097")["valid"])

    def test_signed_p_cycles_average_once_and_release_is_not_subtracted(self):
        study = synthetic_study()
        for process in selected_processes(study):
            for cycle, delta in zip(process["memory"]["cases"]["P"]["cycles"], (-131072, 0)):
                cycle["paused"]["heapUsed"] = cycle["before"]["heapUsed"] + delta
                cycle["released"]["heapUsed"] += 32768
        result = analysis.analyze(study)
        row = memory_result(result)["pairs"][0]["candidate"]
        self.assertEqual(row["retained_increment"], -65536)
        self.assertEqual(row["endpoint_release_deltas"], [32768, 32768])
        self.assertEqual(contrast_result(result)["bonferroni_95_across_22"]["n"], 8)

    def test_material_benefit_strict_and_control_margin_nonstrict(self):
        study = synthetic_study()
        for process in study["processes"]:
            for cycle in process["memory"]["cases"]["P"]["cycles"]:
                target = 512 * 1024 if process["arm"] == "baseline" else 256 * 1024
                cycle["paused"]["heapUsed"] = cycle["before"]["heapUsed"] + target
                if process["engine"] == "bun":
                    cycle["paused"]["heapSize"] = cycle["before"]["heapSize"] + target
        result = analysis.analyze(study)
        self.assertEqual(contrast_result(result, name="P:baseline_increment")["status"], "materiality_rejected")
        self.assertFalse(result["scoped_node_lead_eligible"])
        for case, margin in analysis.MEMORY_MARGINS.items():
            study = synthetic_study()
            for process in selected_processes(study):
                state = (process["startup"]["after"] if case == "startup:import"
                         else process["memory"]["cases"][case]["cycles"][0]["paused"])
                state["heapUsed"] += margin
            result = analysis.analyze(study)
            self.assertEqual(contrast_result(result, name=case + ":candidate_minus_baseline")["status"], "cleared")
            self.assertFalse(result["unchanged_candidate_advancement_veto"])

    def test_absolute_and_percentage_benefit_boundaries_are_strict(self):
        for baseline, candidate, contrast in (
                (1048576, 917504, "retained_saving"),
                (1310720, 1048576, "twenty_percent_reduction")):
            study = synthetic_study()
            for process in study["processes"]:
                target = baseline if process["arm"] == "baseline" else candidate
                for cycle in process["memory"]["cases"]["P"]["cycles"]:
                    for state in ("paused", "rawPaused"):
                        cycle[state]["heapUsed"] = cycle["before"]["heapUsed"] + target
                        if process["engine"] == "bun":
                            cycle[state]["heapSize"] = cycle["before"]["heapSize"] + target
            result = analysis.analyze(study)
            row = contrast_result(result, name="P:" + contrast)
            self.assertEqual(row["bonferroni_95_across_22"]["lower"], row["threshold_bytes"])
            self.assertEqual(row["status"], "materiality_rejected")
            self.assertFalse(result["scoped_node_lead_eligible"])

    def test_ordinary_memory_harm_survives_simultaneous_overlap(self):
        study = synthetic_study()
        for process in selected_processes(study):
            delta = 2048 + (1024 if process["pair"] % 2 else -1024)
            process["memory"]["cases"]["N1"]["cycles"][0]["paused"]["heapUsed"] += delta
        result = analysis.analyze(study)
        row = contrast_result(result, name="N1:candidate_minus_baseline")
        self.assertGreater(row["pointwise_95"]["lower"], 1024)
        self.assertLess(row["bonferroni_95_across_22"]["lower"], 1024)
        self.assertEqual(row["status"], "adverse")
        self.assertTrue(result["unchanged_candidate_advancement_veto"])

    def test_zero_variance_latency_boundary(self):
        study = synthetic_study()
        for baseline in (1.0, 2.0):
            for process in study["processes"]:
                value = baseline if process["arm"] == "baseline" else baseline * 1.02
                process["endpoints"]["P:first"]["measured_ms"] = [value] * 6
            endpoint = latency_result(analysis.analyze(study))
            self.assertEqual(endpoint["status"], "cleared")
            self.assertEqual(endpoint["paired_ratios"], [1.02] * 8)
            self.assertEqual(endpoint["pointwise_95"]["log_interval"]["standard_error"], 0)

    def test_unexplained_accounting_shifts_block_both_positive_terminal_results(self):
        study = synthetic_study()
        for process in selected_processes(study):
            for cycle in process["memory"]["cases"]["P"]["cycles"]:
                cycle["paused"]["rss"] += 1048576
        result = analysis.analyze(study)
        self.assertTrue(result["all_22_memory_contrasts_cleared"])
        self.assertTrue(result["accounting_explanation_required"])
        self.assertFalse(result["scoped_node_lead_eligible"])
        self.assertFalse(result["strong_scoped_screen_clearance"])
        self.assertEqual(result["disposition"], "node_benefit_accounting_review_required")
        study["accounting_shift_reviews"] = [
            {"signal": signal, "explained": True, "rationale": "Synthetic review fixture only",
             "source": "synthetic:independent-review"} for signal in result["accounting_shift_signals"]]
        self.assertTrue(analysis.analyze(study)["strong_scoped_screen_clearance"])

    def test_current_raw_accounting_review_required_even_without_shift_signals(self):
        for failure in ("missing", "stale_evidence", "wrong_method", "unaccepted", "missing_source"):
            study = synthetic_study()
            if failure == "missing":
                del study["raw_accounting_review"]
            elif failure == "stale_evidence":
                study["raw_accounting_review"]["raw_evidence_sha256"] = "b" * 64
            elif failure == "wrong_method":
                study["raw_accounting_review"]["method_sha256"] = "b" * 64
            elif failure == "unaccepted":
                study["raw_accounting_review"]["accepted"] = False
            else:
                study["raw_accounting_review"]["source"] = ""
            result = analysis.analyze(study)
            self.assertEqual(result["accounting_shift_signals"], [])
            self.assertTrue(result["all_22_memory_contrasts_cleared"])
            self.assertFalse(result["scoped_node_lead_eligible"])
            self.assertFalse(result["strong_scoped_screen_clearance"])
            self.assertEqual(result["disposition"], "node_benefit_accounting_review_required")

    def test_reviewed_invalid_bun_or_small_node_case_allows_only_node_provisional_lead(self):
        for engine in analysis.ENGINES:
            study = synthetic_study()
            case = "P" if engine == "bun" else "N1"
            selected_processes(study, engine=engine)[0]["memory"]["cases"][case]["eligible"] = False
            result = analysis.analyze(study)
            signal = engine + ":" + case + ":invalid_attribution_review_required"
            self.assertIn(signal, result["unexplained_accounting_shifts"])
            self.assertFalse(result["scoped_node_lead_eligible"])
            study["accounting_shift_reviews"] = [{"signal": signal, "explained": True,
                                                  "rationale": "Synthetic scoped limitation review",
                                                  "source": "synthetic:raw-case-review"}]
            reviewed = analysis.analyze(study)
            self.assertTrue(reviewed["scoped_node_lead_eligible"])
            self.assertFalse(reviewed["strong_scoped_screen_clearance"])
            self.assertFalse(memory_result(reviewed, engine, case)["valid"])
            if engine == "bun":
                self.assertFalse(reviewed["bun_material_benefit_corroborated"])
            self.assertEqual(reviewed["disposition"], "scoped_node_retained_memory_lead")

    def test_custody_failure_withholds_lead_without_erasing_valid_harm(self):
        study = synthetic_study()
        study.update(complete=False, first_failure="Synthetic custody failure")
        result = analysis.analyze(study)
        self.assertFalse(result["scoped_node_lead_eligible"])
        self.assertFalse(result["strong_scoped_screen_clearance"])
        self.assertEqual(result["disposition"], "inconclusive_or_incomplete")
        self.assertFalse(result["all_38_latency_controls_cleared"])
        self.assertFalse(result["all_22_memory_contrasts_cleared"])
        self.assertEqual(latency_result(result)["status"], "cleared")
        self.assertEqual(contrast_result(result)["status"], "cleared")
        for process in selected_processes(study):
            process["endpoints"]["startup:import"]["measured_ms"] = [2]
        result = analysis.analyze(study)
        self.assertTrue(result["unchanged_candidate_advancement_veto"])
        self.assertEqual(latency_result(result, name="startup:import")["status"], "adverse")

    def test_invalid_memory_case_cannot_erase_other_fixed_memory_harm(self):
        study = synthetic_study()
        selected_processes(study)[0]["memory"]["cases"]["N4097"]["eligible"] = False
        for process in selected_processes(study):
            process["memory"]["cases"]["N1"]["cycles"][0]["paused"]["heapUsed"] += 2048
        result = analysis.analyze(study)
        self.assertFalse(memory_result(result, case="N4097")["valid"])
        self.assertEqual(contrast_result(result, name="N1:candidate_minus_baseline")["status"], "adverse")
        self.assertTrue(result["unchanged_candidate_advancement_veto"])

    def test_backing_changes_and_method_mismatch_never_support_positive_inference(self):
        study = synthetic_study()
        selected_processes(study)[0]["memory"]["cases"]["N8193"]["cycles"][0]["paused"]["arenaUsedBytes"] += 1
        self.assertFalse(analysis.analyze(study)["scoped_node_lead_eligible"])
        study = synthetic_study()
        study["method_sha256"] = "synthetic:mismatched-method"
        result = analysis.analyze(study)
        self.assertFalse(result["complete"])
        self.assertNotIn("pointwise_95", latency_result(result))
        self.assertNotIn("pointwise_95", contrast_result(result))


if __name__ == "__main__":
    unittest.main()
