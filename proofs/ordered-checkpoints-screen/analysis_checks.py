"""Inert synthetic checks. Execution requires the separate bounded-check release.

No target imports, fixtures, clocks, GC, subprocesses, network, or filesystem
mutation. The one import below is this packet's standard-library-only analysis.
"""

import copy
import math
import unittest

import analysis


def synthetic_study():
    processes = []
    for engine in analysis.ENGINES:
        for pair in range(8):
            for arm in analysis.ARMS:
                increment = 1024 * 1024 if arm == "baseline" else 128 * 1024
                before = {"heapUsed": 10 * 1024 * 1024, "heapTotal": 20 * 1024 * 1024,
                          "external": 4096, "arrayBuffers": 2048, "rss": 30 * 1024 * 1024,
                          "arenaUsedBytes": 4096, "arenaCapacityBytes": 8192}
                if engine == "bun":
                    before.update(heapSize=10 * 1024 * 1024,
                                  heapCapacity=20 * 1024 * 1024, extraMemorySize=1024)
                paused = dict(before)
                paused["heapUsed"] += increment
                if engine == "bun":
                    paused["heapSize"] += increment
                cycle = {"before": before, "paused": paused, "released": dict(before),
                         "resumed_ok": True}
                endpoint = {"eligible": True, "invalid_reasons": [], "k": 1,
                            "warmup_ms": [10.0] * 4, "measured_ms": [10.0] * 6,
                            "clock_ok": True, "checksum_ok": True,
                            "overhead_ms_per_call": 0.000001, "clock_resolution_ms": 0.000001}
                processes.append({"engine": engine, "pair": pair, "arm": arm,
                                  "eligible": True, "invalid_reasons": [],
                                  "identity_ok": True, "oracle_ok": True, "backing_ok": True,
                                  "endpoints": {name: copy.deepcopy(endpoint) for name in analysis.ENDPOINTS},
                                  "memory": {"eligible": True, "invalid_reasons": [],
                                             "cycles": [copy.deepcopy(cycle), copy.deepcopy(cycle)]},
                                  "terminal_high_water_rss_bytes": 40 * 1024 * 1024})
    return {"schema": analysis.SCHEMA, "method_sha256": analysis.METHOD_SHA256,
            "complete": True, "first_failure": None, "processes": processes,
            "prior_adverse_evidence": []}


def endpoint_result(result, engine="node", name="P:first"):
    return next(row for row in result["latency"] if row["engine"] == engine and row["endpoint"] == name)


class AnalysisChecks(unittest.TestCase):
    def test_fixed_critical_literals_and_independent_density_integral(self):
        expected = {"pointwise95": 2.3646242515927853,
                    "latency28": 4.883865032805824, "memory10": 4.029337177642485}
        for name, value in analysis.fixed_critical_values().items():
            self.assertLessEqual(abs(value - expected[name]), 1e-12)
            # Composite Simpson directly integrates NIST's density. This does not
            # use the closed-form CDF used to derive the original candidate values.
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

    def test_all_clear_is_only_narrow_lead(self):
        study = synthetic_study()
        result = analysis.analyze(study)
        self.assertEqual(result["disposition"], "promising_temporary_heap_lead")
        self.assertTrue(result["all_28_iteration_controls_cleared"])
        self.assertTrue(result["both_engine_memory_conditions_satisfied"])
        study["first_failure"] = "Synthetic terminal failure despite complete flag"
        failed = analysis.analyze(study)
        self.assertFalse(failed["complete"])
        self.assertEqual(failed["disposition"], "inconclusive_or_incomplete")
        study["first_failure"] = None
        for process in study["processes"]:
            if process["arm"] == "candidate":
                for cycle in process["memory"]["cycles"]:
                    cycle["paused"]["rss"] += 1048576
        shifted = analysis.analyze(study)
        self.assertTrue(shifted["both_engine_memory_conditions_satisfied"])
        self.assertTrue(shifted["accounting_explanation_required"])
        self.assertEqual(shifted["disposition"], "memory_conditions_met_accounting_review_required")

    def test_pointwise_harm_survives_simultaneous_overlap_and_failed_peer(self):
        study = synthetic_study()
        for process in study["processes"]:
            if process["engine"] == "node" and process["arm"] == "candidate":
                log_ratio = 0.04 + (0.014 if process["pair"] % 2 else -0.014)
                process["endpoints"]["P:first"]["measured_ms"] = [10 * math.exp(log_ratio)] * 6
            if process["engine"] == "bun" and process["pair"] == 0:
                process["endpoints"]["F128:full"]["eligible"] = False
        study["complete"] = False
        study["first_failure"] = "Synthetic unrelated endpoint failure"
        result = analysis.analyze(study)
        endpoint = endpoint_result(result)
        self.assertGreater(endpoint["pointwise_95"]["lower"], 1.02)
        self.assertLess(endpoint["bonferroni_95_across_28"]["lower"], 1.02)
        self.assertEqual(endpoint["status"], "adverse")
        self.assertTrue(result["unchanged_candidate_advancement_veto"])

    def test_all_six_chunks_have_equal_weight_and_gc_is_not_excluded(self):
        study = synthetic_study()
        for process in study["processes"]:
            if process["engine"] == "node" and process["arm"] == "candidate":
                endpoint = process["endpoints"]["P:first"]
                endpoint["measured_ms"] = [10, 10, 10, 10, 10, 70]
                endpoint["diagnostics"] = {"gc": True, "unstable": True, "slow_chunk": 5}
        endpoint = endpoint_result(analysis.analyze(study))
        self.assertEqual(endpoint["pairs"][0]["candidate"]["mean_ms"], 20)
        self.assertAlmostEqual(endpoint["paired_log_ratios"][0], math.log(2))
        self.assertEqual(endpoint["status"], "adverse")

    def test_mean_is_per_operation_before_paired_logs(self):
        study = synthetic_study()
        for process in study["processes"]:
            endpoint = process["endpoints"]["F513:full"]
            endpoint["k"] = 4
            endpoint["measured_ms"] = ([4, 8, 12, 16, 20, 24] if process["arm"] == "baseline"
                                        else [8, 16, 24, 32, 40, 48])
        endpoint = endpoint_result(analysis.analyze(study), name="F513:full")
        self.assertEqual(endpoint["pairs"][0]["baseline"]["mean_ms"], 3.5)
        self.assertEqual(endpoint["pairs"][0]["candidate"]["mean_ms"], 7)
        self.assertAlmostEqual(endpoint["paired_log_ratios"][0], math.log(2))

    def test_missing_pair_never_yields_subset_inference(self):
        study = synthetic_study()
        study["processes"] = [process for process in study["processes"]
                              if not (process["engine"] == "node" and process["pair"] == 7
                                      and process["arm"] == "candidate")]
        result = analysis.analyze(study)
        self.assertEqual(endpoint_result(result)["status"], "unresolved")
        self.assertNotIn("pointwise_95", endpoint_result(result))
        self.assertEqual(result["memory"][0]["status"], "unresolved")
        self.assertEqual(result["memory"][1]["status"], "conditions_satisfied")

    def test_release_boundary_and_failed_attribution(self):
        study = synthetic_study()
        process = study["processes"][0]
        process["memory"]["cycles"][0]["released"]["heapUsed"] += 65536
        self.assertEqual(analysis.analyze(study)["memory"][0]["status"], "conditions_satisfied")
        process["memory"]["cycles"][0]["released"]["heapUsed"] += 1
        memory = analysis.analyze(study)["memory"][0]
        self.assertEqual(memory["status"], "unresolved")
        self.assertNotIn("bonferroni_95_across_10", memory)

    def test_signed_cycles_are_averaged_not_clamped_or_replicated(self):
        study = synthetic_study()
        for process in study["processes"]:
            if process["engine"] == "node" and process["arm"] == "candidate":
                for cycle, delta in zip(process["memory"]["cycles"], (-131072, 0)):
                    cycle["paused"]["heapUsed"] = cycle["before"]["heapUsed"] + delta
        memory = analysis.analyze(study)["memory"][0]
        self.assertEqual(memory["pairs"][0]["candidate"]["increments"]["heapUsed"], -65536)
        self.assertEqual(memory["bonferroni_95_across_10"]["heap_saving"]["n"], 8)

    def test_zero_variance_strict_materiality_and_nonstrict_guard(self):
        study = synthetic_study()
        for process in study["processes"]:
            if process["engine"] == "node" and process["arm"] == "candidate":
                for cycle in process["memory"]["cycles"]:
                    cycle["paused"]["external"] += 65536
        self.assertEqual(analysis.analyze(study)["memory"][0]["status"], "conditions_satisfied")
        for process in study["processes"]:
            if process["engine"] == "node" and process["arm"] == "candidate":
                for cycle in process["memory"]["cycles"]:
                    cycle["paused"]["heapUsed"] = cycle["before"]["heapUsed"] + 524288
        memory = analysis.analyze(study)["memory"][0]
        self.assertEqual(memory["status"], "materiality_rejected")
        self.assertIn("half_baseline_minus_candidate", memory["materiality_ruled_out"])

    def test_zero_variance_latency_boundary(self):
        study = synthetic_study()
        for baseline in (1.0, 2.0):
            for process in study["processes"]:
                duration = baseline if process["arm"] == "baseline" else baseline * 1.02
                process["endpoints"]["P:first"]["measured_ms"] = [duration] * 6
            endpoint = endpoint_result(analysis.analyze(study))
            self.assertEqual(endpoint["status"], "cleared")
            self.assertEqual(endpoint["paired_ratios"], [1.02] * 8)
            self.assertEqual(endpoint["pointwise_95"]["log_interval"]["standard_error"], 0)

    def test_overhead_rule_only_applies_to_isolated_first(self):
        study = synthetic_study()
        for process in study["processes"]:
            for endpoint in process["endpoints"].values():
                endpoint["overhead_ms_per_call"] = 1
        result = analysis.analyze(study)
        self.assertEqual(endpoint_result(result)["status"], "unresolved")
        self.assertEqual(endpoint_result(result, name="P:full")["status"], "cleared")
        self.assertEqual(endpoint_result(result, name="F128:first")["status"], "cleared")

    def test_resolution_boundary_covers_each_chunk_and_correct_units(self):
        study = synthetic_study()
        for process in study["processes"]:
            process["endpoints"]["P:first"]["clock_resolution_ms"] = 0.05
            for name in ("P:full", "F128:first"):
                process["endpoints"][name]["k"] = 4
                process["endpoints"][name]["clock_resolution_ms"] = 0.05
        result = analysis.analyze(study)
        self.assertEqual(endpoint_result(result)["status"], "cleared")
        self.assertEqual(endpoint_result(result, name="P:full")["status"], "cleared")
        self.assertEqual(endpoint_result(result, name="F128:first")["status"], "cleared")
        endpoint = study["processes"][0]["endpoints"]["P:first"]
        for field in ("warmup_ms", "measured_ms"):
            endpoint[field][0] = 9.999
            self.assertEqual(endpoint_result(analysis.analyze(study))["status"], "unresolved")
            self.assertEqual(endpoint[field][0], 9.999)  # Invalid sample remains intact.
            endpoint[field][0] = 10
        for process in study["processes"]:
            process["endpoints"]["P:first"]["k"] = 4
        self.assertEqual(endpoint_result(analysis.analyze(study))["status"], "unresolved")
        for process in study["processes"]:
            process["endpoints"]["P:first"]["k"] = 1
        endpoint["clock_resolution_ms"] = 0
        self.assertEqual(endpoint_result(analysis.analyze(study))["status"], "unresolved")

    def test_prior_harm_survives_incomplete_or_mismatched_screen(self):
        study = synthetic_study()
        study["method_sha256"] = "synthetic-mismatch"
        study["processes"] = []
        study["prior_adverse_evidence"] = [{"valid": True, "source": "synthetic:authorized-prior",
                                             "demonstrated_over_two_percent": True}]
        result = analysis.analyze(study)
        self.assertTrue(result["unchanged_candidate_advancement_veto"])
        self.assertEqual(result["disposition"], "adverse_latency_veto")


if __name__ == "__main__":
    unittest.main()
