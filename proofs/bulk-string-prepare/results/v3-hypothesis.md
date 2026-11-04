# Final bulk-string preparation screen: V3 hypothesis

Recorded before implementation and measurement on 2026-11-04T19:32:58.631168+00:00.

V1 encoded each repeated Unicode value once by keying the preparation map by value. It saved work on repetition but charged every unique value a string hash; the fresh long unique Node control was 20.7% slower in its exploratory screen. V2 bounded value sampling and cache misses, but put the extra branches inside the normal preparation loop. Its screen still showed material unique/control costs in both engines. Both complete screens, including adverse cases, are preserved under `v1/` and `v2/`.

The final hypothesis is that separating the selection and pooled preparation from the normal preparation loop can retain the repeated-value benefit while preserving the unique loop's compiled shape. This is a hypothesis about overhead, not a proven attribution for the V2 losses.

V3 will skip preflight below 256 normalized entries. Above that size, a separate helper will visit at most 64 entries and 16 Unicode values, without hashing strings or encoding bytes. At least four repeated observations must appear in this bounded prefix to select a separate pooled preparation helper. The original key-indexed preparation loop remains unchanged for all other calls. The pooled helper retains a total 16-miss budget; cache state lives only during one call. Published leaf layout, allocation sizes, bytes, value validation, key normalization, and the existing copy pass remain unchanged.

The exploratory matrix and method remain the exact 16 cases from V2: the original 15 cases plus the predeclared fresh-long unique input with one early repeated pair. Both builds receive independently constructed fresh strings, equal setup and validation, and balanced order. Two fresh processes per case per runtime are only a screen, with no statistical confidence claim. A formal fixed-count study will follow only if this complete screen justifies it. No further variant will be attempted if control costs persist.

Expected limits: small batches, repetition first occurring outside the prefix, and reuse after the miss budget may receive no speedup. These decisions affect temporary preparation work only.

## Guard amendment before measurement

Recorded 2026-11-04T19:35:24.560343+00:00. Independent review identified that the prior one-repeat guard no longer selects the pooled helper. Keep all 16 cases and append one separately labeled guard, `fresh-unicode-long-cache-abandonment`: the first five values are equal (four repeated observations), followed by fresh long unique values. This activates pooled preparation and then exhausts its total miss budget. The screen now has 17 cases and 68 processes; all other settings and the original 16 cases are unchanged.
