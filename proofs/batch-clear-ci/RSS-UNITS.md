# Pinned Linux resource labels

For Linux x64 Node 22.23.3 and Bun 1.4.2, the API used here is `process.resourceUsage().maxRSS`; its value is in KiB, with 1024 bytes per unit. Node 22.23.3 documents this mapping to `ru_maxrss`. The Linux getrusage interface defines that field in KiB. [Node 22.23.3 process documentation](https://nodejs.org/download/release/latest-jod/docs/api/process.html#processresourceusage), [Linux getrusage documentation](https://man7.org/linux/man-pages/man2/getrusage.2.html).

Passive probes used the exact pinned executables and loaded no candidate library. Initial `/proc/self/status` VmHWM observations are retained: Node maxRSS 53,672 versus a later VmHWM 54,348 KiB; Bun maxRSS 14,212 versus a later VmHWM 15,024 KiB. These were not simultaneous equal snapshots and are not claimed equal. They establish the expected scale but are supplemented by the native check below.

For Bun 1.4.2, a direct read-only libc getrusage call bracketed the Node-compatible API call: native ru_maxrss 15,708, process maxRSS 16,024, native ru_maxrss 16,208. The API value lies between the native observations at the same KiB scale. The exact command and result are preserved in `BUN-NATIVE-RSS-UNIT.json`. This verifies the API actually used; Bun subprocess resource reporting is a different API.

The subject retains raw maxRSS and labels it explicitly; `maxRSSBytes` is only an arithmetic conversion. Sampled subject/controller RSS, per-Arena backing capacity and reported high-water RSS remain distinct. The resource guards are unchanged. Linux resource statistics can carry execution history; none of these observations is a physical-memory saving measurement or an exact sum of live Arenas. See the Linux documentation's notes on preservation across exec.
