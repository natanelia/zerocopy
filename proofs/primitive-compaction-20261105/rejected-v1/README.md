# Rejected broad primitive-compaction variant

This version is not the proposed optimization. It copied every numeric/boolean list and queue. The full confirmation exposed a Node boolean-list regression in all six pairs. An unchanged Bun JSON control was also slower in all six pairs. Large numeric lists improved, but that does not clear the broader change.

Frozen local measurement commit: `972d07804f7c5224b10038c5e4adb050a44d652d`. These local commit IDs identify the experiment; use the archived source files and hashes to reproduce it from the public baseline. The exact seven source/driver/plan/test/CI files match [archive-manifest.json](archive-manifest.json).

## Complete confirmation

Six fresh balanced process pairs per case/runtime; nine measured batches, >=500 ms actual timed warm-up and >=8 warm-up batches. Ratios below one are faster. Intervals are unadjusted 95% Student-t intervals on six log ratios. All values are complete compaction latency in milliseconds.

| Runtime | Case | Before ms | After ms | Paired ratio | 95% interval | Every pair ratio |
| --- | --- | ---: | ---: | ---: | --- | --- |
| node | list-number-large | 3.481904 | 0.887549 | 0.2507 | [0.2004, 0.3136] | 0.2653, 0.3512, 0.2528, 0.2448, 0.1806, 0.2386 |
| node | list-number-small | 0.054666 | 0.048897 | 1.1071 | [0.7686, 1.5947] | 1.2608, 0.8587, 0.7765, 0.8439, 1.8634, 1.3926 |
| node | list-boolean | 0.511957 | 0.578328 | 1.2189 | [1.0114, 1.4690] | 1.0086, 1.3970, 1.1070, 1.6206, 1.0886, 1.1917 |
| node | queue-number | 0.660894 | 0.554118 | 0.8508 | [0.6548, 1.1056] | 0.5743, 0.8854, 0.8762, 1.1512, 0.7204, 1.0268 |
| node | queue-boolean | 0.126981 | 0.075636 | 0.5814 | [0.5354, 0.6315] | 0.5535, 0.5175, 0.6041, 0.6092, 0.5684, 0.6449 |
| node | list-empty | 0.039778 | 0.039534 | 1.0481 | [0.6436, 1.7068] | 1.7800, 0.7164, 0.5911, 1.8399, 0.9721, 0.9831 |
| node | list-string | 0.605947 | 0.655171 | 1.1421 | [0.9136, 1.4277] | 0.8991, 1.2644, 1.0595, 1.2771, 0.9259, 1.5581 |
| node | list-object | 0.129289 | 0.117578 | 0.9048 | [0.8039, 1.0185] | 1.0561, 0.9068, 0.9214, 0.7767, 0.9778, 0.8188 |
| bun | list-number-large | 3.304425 | 1.919069 | 0.5705 | [0.4866, 0.6689] | 0.6335, 0.5739, 0.6497, 0.4264, 0.5715, 0.5989 |
| bun | list-number-small | 0.956736 | 0.888064 | 0.9230 | [0.8501, 1.0021] | 0.8796, 0.8916, 1.0485, 0.8371, 0.9517, 0.9438 |
| bun | list-boolean | 1.123933 | 1.101025 | 0.9236 | [0.8208, 1.0392] | 1.0467, 0.9849, 0.8800, 0.7650, 0.9914, 0.9021 |
| bun | queue-number | 1.237246 | 1.098648 | 0.8761 | [0.7589, 1.0114] | 0.8236, 0.8741, 0.9445, 1.0770, 0.8636, 0.7150 |
| bun | queue-boolean | 0.991532 | 0.969645 | 1.0031 | [0.9399, 1.0707] | 0.9115, 0.9525, 1.0798, 1.0194, 1.0272, 1.0380 |
| bun | list-empty | 1.074355 | 0.945300 | 0.9297 | [0.8197, 1.0546] | 0.9768, 0.8263, 0.8548, 1.0624, 1.0625, 0.8293 |
| bun | list-string | 1.578879 | 1.632119 | 1.0064 | [0.8662, 1.1693] | 1.2848, 1.0414, 0.8499, 1.0387, 0.9093, 0.9674 |
| bun | list-object | 1.037233 | 1.164648 | 1.1045 | [1.0359, 1.1775] | 1.1654, 1.1806, 1.0166, 1.0949, 1.1383, 1.0413 |

## Complete pilot

Two process pairs per case/runtime, kept separate from confirmation.

| Runtime | Case | Before ms | After ms | Paired ratio | Both pair ratios |
| --- | --- | ---: | ---: | ---: | --- |
| node | list-number-large | 4.228342 | 0.975118 | 0.2328 | 0.2613, 0.2075 |
| node | list-number-small | 0.044209 | 0.062188 | 1.3613 | 1.0482, 1.7677 |
| node | list-boolean | 0.552754 | 0.631662 | 1.1281 | 0.8741, 1.4560 |
| node | queue-number | 0.535731 | 0.644997 | 1.3576 | 0.7173, 2.5693 |
| node | queue-boolean | 0.170908 | 0.085912 | 0.5019 | 0.4956, 0.5083 |
| node | list-empty | 0.034265 | 0.036061 | 1.0508 | 0.9809, 1.1257 |
| node | list-string | 0.588157 | 0.730953 | 1.2172 | 1.0058, 1.4730 |
| node | list-object | 0.125596 | 0.121085 | 0.9658 | 1.0103, 0.9232 |
| bun | list-number-large | 4.288204 | 2.228658 | 0.5148 | 0.4244, 0.6245 |
| bun | list-number-small | 0.927535 | 1.031756 | 1.1133 | 1.1938, 1.0382 |
| bun | list-boolean | 1.297275 | 1.058635 | 0.8132 | 0.7438, 0.8890 |
| bun | queue-number | 1.156592 | 1.283715 | 1.1124 | 0.9595, 1.2898 |
| bun | queue-boolean | 1.025546 | 1.142517 | 1.1164 | 1.3138, 0.9486 |
| bun | list-empty | 1.004675 | 0.978246 | 0.9790 | 1.0190, 0.9406 |
| bun | list-string | 1.635418 | 1.966713 | 1.1964 | 1.4635, 0.9780 |
| bun | list-object | 1.203881 | 1.094491 | 0.9093 | 0.9243, 0.8945 |

Both recordings are preserved losslessly in [results/pilot-01.json.gz](results/pilot-01.json.gz) and [results/formal-01.json.gz](results/formal-01.json.gz), with compressed/original hashes in [results/archive-manifest.json](results/archive-manifest.json). All original build, worker and focused-test logs remain in that directory. The first test attempt had an index/value fixture error; the next grouped too many large checks into a five-second test. The corrected split cases passed 76 focused tests without production changes or increased timeouts.

The root report describes the separately frozen V2 scope and its fresh measurements. No V1 and V2 measurements are pooled.
