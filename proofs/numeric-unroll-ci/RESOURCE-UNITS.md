# Linux resource units

This packet calls the Node-compatible process.resourceUsage() API in Node 22.23.3 and Bun 1.4.2. Its maxRSS field is in **KiB (1024 bytes)** on Linux. The generated report and raw completion record label it explicitly. process.memoryUsage().rss, controller-polled RSS and Arena capacity are in bytes. The 512 MiB subject cap uses those byte-valued RSS checks.

Verified sources, read 2026-10-09:

- [Node 22.23.3 process.resourceUsage documentation](https://nodejs.org/download/release/latest-jod/docs/api/process.html#processresourceusage) states the maxRSS unit and its ru_maxrss mapping.
- [Bun 1.4.2 process implementation](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/jsc/bindings/BunProcess.cpp#L3498) puts maxRSS at offset 2; the resourceUsage implementation at lines 3566–3573 returns Linux ru_maxrss unchanged and normalizes the Darwin value separately. The matching [raw tagged source](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/src/jsc/bindings/BunProcess.cpp) was inspected.

This is a process-lifetime high-water observation, not measured-operation allocation or retained heap. No memory-saving claim follows from it. These source checks did not execute an arm, a workload subject or a performance clock.
