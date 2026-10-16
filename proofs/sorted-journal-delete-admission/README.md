# Sorted-delete admission diagnostic

This branch investigates the fixed-cap correctness failure in [run 38842133053](https://github.com/natanelia/zerocopy/actions/runs/38842133053). It preserves the production candidate and full four-thread test suite while adding bounded delivered-test, reporter-liveness, heap-snapshot and process observations to both arms.

[The fixed method](METHOD.md) explains the 4-GiB ceiling, 27-minute controller, 35-minute job, observation limits and interpretation. There is no performance study or automatic continuation. Passing means the failure did not reproduce under this instrumentation, not that its cause was resolved.

The controller authenticates all 502 baseline source files, the exact candidate overlay, supported runtimes, dependency tree, fresh native outputs and portable/native bindings. It runs the six existing admission commands once, stops at the first failure, preserves original logs, and records owned-process cleanup. Pure synthetic reporter/controller checks exercise only instrumentation and mocked observations.
