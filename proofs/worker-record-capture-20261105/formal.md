# Complete confirmation

One frozen confirmation; no source, count or workload changes after the pilot.

Before/after values are medians of process medians, in microseconds per complete operation. Paired ratios are geometric means of matching after/before process ratios; they need not equal the ratio of the displayed medians. Per-row intervals are unadjusted 95% Student-t intervals on six paired log ratios.

| Runtime | Case | Before µs | After µs | Paired ratio | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| node | publish-record-512 | 776.149 | 609.065 | 0.8290 | 0.7323–0.9384 | 6/6 |
| node | publish-record-128 | 152.847 | 127.251 | 0.8053 | 0.6599–0.9828 | 5/6 |
| node | publish-same-record-128 | 151.146 | 140.881 | 0.9547 | 0.8631–1.0560 | 4/6 |
| node | publish-frozen-record-128 | 144.012 | 138.766 | 0.9295 | 0.8348–1.0350 | 5/6 |
| node | create-record-128 | 164.646 | 131.248 | 0.7807 | 0.7091–0.8596 | 6/6 |
| node | update-key-record-128 | 188.299 | 161.485 | 0.8426 | 0.7519–0.9441 | 5/6 |
| node | publish-small-record-4 | 6.667 | 6.278 | 0.8425 | 0.7190–0.9873 | 5/6 |
| node | publish-empty-record | 1.118 | 1.043 | 0.9275 | 0.8235–1.0447 | 5/6 |
| node | publish-single | 2.305 | 2.441 | 1.0970 | 0.9395–1.2809 | 1/6 |
| node | worker-data-record-128 | 26.152 | 23.514 | 0.9191 | 0.7088–1.1918 | 5/6 |
| bun | publish-record-512 | 502.348 | 400.370 | 0.8141 | 0.6889–0.9619 | 5/6 |
| bun | publish-record-128 | 66.826 | 61.061 | 0.9424 | 0.6954–1.2770 | 2/6 |
| bun | publish-same-record-128 | 69.360 | 55.637 | 0.7643 | 0.6676–0.8749 | 6/6 |
| bun | publish-frozen-record-128 | 64.120 | 62.854 | 0.9416 | 0.7883–1.1246 | 4/6 |
| bun | create-record-128 | 65.318 | 65.272 | 0.9771 | 0.7817–1.2213 | 3/6 |
| bun | update-key-record-128 | 72.427 | 64.487 | 0.8405 | 0.6319–1.1179 | 5/6 |
| bun | publish-small-record-4 | 3.679 | 2.996 | 0.8534 | 0.6308–1.1546 | 5/6 |
| bun | publish-empty-record | 0.481 | 0.326 | 0.8355 | 0.5954–1.1724 | 5/6 |
| bun | publish-single | 1.363 | 1.192 | 0.9182 | 0.6564–1.2846 | 4/6 |
| bun | worker-data-record-128 | 30.423 | 27.311 | 0.9088 | 0.6981–1.1832 | 4/6 |

## Interpretation and limits

The changed 512-name record target improves on both Node and Bun. Node changed 128-name publication, state creation, named-key updates and the four-name boundary also improve in this confirmation. Bun unchanged 128-name publication improves. The other target rows remain inconclusive where their intervals cross parity.

The unchanged Node single-collection path remains a concern: the paired estimate is 9.7% slower and five of six pairs are slower. Its wide interval spans parity and therefore neither establishes a slowdown nor establishes equivalence. The earlier pilot estimated 10.2% slower for that case. Its same-baseline A/A estimate is 8.0% slower with a wide interval. These estimates remain separate; A/A is not subtracted from A/B, and source equality on a control path is not a no-regression proof.

## Raw pair ratios

- node publish-record-512: 0.859465, 0.680849, 0.965919, 0.835162, 0.876980, 0.783982.
- node publish-record-128: 0.602425, 0.740231, 0.921808, 1.048732, 0.784782, 0.806249.
- node publish-same-record-128: 1.041638, 0.886411, 1.085979, 0.840048, 0.948846, 0.947365.
- node publish-frozen-record-128: 0.927355, 0.846187, 0.951312, 1.122904, 0.893172, 0.861528.
- node create-record-128: 0.722129, 0.868686, 0.680442, 0.822157, 0.824433, 0.782865.
- node update-key-record-128: 1.021710, 0.796557, 0.882248, 0.756143, 0.787062, 0.837272.
- node publish-small-record-4: 0.735622, 0.931798, 0.682887, 0.846162, 1.028227, 0.878252.
- node publish-empty-record: 1.130046, 0.871617, 0.827076, 0.985649, 0.868446, 0.913125.
- node publish-single: 1.081604, 0.953054, 1.022117, 1.099635, 1.456655, 1.032687.
- node worker-data-record-128: 0.839921, 0.978613, 0.803065, 0.664162, 0.997617, 1.377989.
- bun publish-record-512: 0.801081, 1.056424, 0.875146, 0.784005, 0.653884, 0.766474.
- bun publish-record-128: 0.754044, 1.120201, 0.578338, 1.070150, 1.176679, 1.138705.
- bun publish-same-record-128: 0.689129, 0.772481, 0.676742, 0.867751, 0.915521, 0.696428.
- bun publish-frozen-record-128: 0.994721, 0.940972, 0.864702, 1.157018, 1.047228, 0.710498.
- bun create-record-128: 0.857043, 1.376675, 1.029830, 0.767916, 0.854202, 1.091942.
- bun update-key-record-128: 0.874854, 0.585107, 0.745420, 1.345854, 0.832029, 0.825023.
- bun publish-small-record-4: 0.575873, 1.390078, 0.768637, 0.875661, 0.909458, 0.788433.
- bun publish-empty-record: 0.995167, 0.531848, 1.276954, 0.615778, 0.882200, 0.926320.
- bun publish-single: 1.020427, 1.495811, 0.559140, 0.973198, 0.869089, 0.830430.
- bun worker-data-record-128: 0.906173, 0.644377, 0.823473, 1.222917, 0.792787, 1.208633.

## Resolution diagnostics

- node: minimum measured batch 2.681149 ms; 0 / 1080 measured batches below 2 ms; minimum actual timed warm-up 500.004758 ms.
- bun: minimum measured batch 1.741562 ms; 5 / 1080 measured batches below 2 ms; minimum actual timed warm-up 500.019735 ms.

All 240 subjects and 2160 measured batches are retained in the complete JSON recording. Independent output verification and source/build identity checks passed. The auxiliary console log stops after 219 subject lines; it is retained as captured and is not used to reconstruct or fill the raw recording.

[Raw confirmation](formal.json.gz) · [Process log](formal.log) · [A/A controls](aa.md) · [Pilot](pilot.md).
