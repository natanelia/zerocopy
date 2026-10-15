# Independent packed-screen critical-value verification

2026-10-15. **Verified for df=7 and the two-sided 95% intervals fixed in the prospective method.** Use these binary64 literals consistently:

| Family size m | Upper-tail probability | Critical value |
| ---: | ---: | ---: |
| 1, ordinary harm interval | 1/40 | 2.3646242515927853 |
| 22, memory simultaneous intervals | 1/880 | 4.6755214023824 |
| 38, latency simultaneous intervals | 1/1520 | 5.155633357451718 |

For each family the quantile is `t(7, 1 - 0.05/(2m))`. The memory and latency families are separately controlled at 95%; these constants do not create one joint 95% claim across all 60 contrasts. They replace neither the ordinary harm criterion nor the fixed full-sample process-pair rules.

## Deterministic computation

The [NIST Student-t definition](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3664.htm), also recorded in the retained prior critical-value review, gives for seven degrees of freedom

`f(t) = 16/(5*pi*sqrt(7)) * (1 + t*t/7)^(-4)`.

The first calculation used only installed Python standard-library Decimal arithmetic, at 75-digit working precision. Pi was computed with Machin's identity `16*atan(1/5) - 4*atan(1/239)` and alternating arctangent series. For `z=7/(7+t*t)`, the positive upper-tail series was

`Q(t) = (8/(5*pi)) * z^(7/2) * sum(a_n*z^n/(n+7/2))`,

where `a_0=1` and `a_(n+1)=a_n*(2n+1)/(2n+2)`. The final bracket [2,10] was checked to bracket each exact rational tail target. Each root used 230 bisections. Terms stopped below 1e-73, with a hard maximum of 600 terms; the final calculation needed at most 353. The largest z in this bracket is 7/11, so the remaining positive series is bounded by a geometric tail. The earlier wider-bracket calculation stopped at its convergence guard at t=1.25; no value from that stopped calculation is used.

The independent numerical route transformed the density tail with `s=1/t` and integrated

`16/(5*pi*sqrt(7)) * 7^4*s^6/(1+7*s*s)^4`

from zero to `1/t`. This used binary64 math.pi and adaptive Simpson quadrature with 1e-17 absolute tolerance and depth bound 24, followed by 60 separate bisections. It did not evaluate or invert the Decimal series or the prior closed-form CDF.

The two root calculations differ by at most 8.881784197001252e-16. Quadrature tail residuals at the chosen literals are at most 2.168404344971009e-19. Both satisfy an absolute 1e-12 agreement check. `VALUES.json` retains roots, exact tail targets, bounds and residuals. Extra Decimal digits document the calculation; they are not a certification that every displayed digit is exact. The ordinary value independently reproduces the previously accepted constant.

Only bounded deterministic mathematics was executed. No package installation, target library/harness import, experiment, measurement, old-sample analysis, resampling or change to scientific thresholds occurred. These constants do not establish model adequacy or eligibility of any future observation.
