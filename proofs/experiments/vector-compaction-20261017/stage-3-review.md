# Stage 3 source review

The new loop keeps adjacent physical spans together. It flushes a run before a disjoint, repeated, or backward source address. The input offset of the first queue leaf includes the consumed prefix. The existing source bounds check runs for every leaf. The empty input exits before the final flush. Target allocation completes before the source and target views are captured; the read-only leaf lookup does not allocate.

An independent automated review found no error in these boundaries or in the target view lifetime. This review does not establish speed or replace runtime checks.

The tests now include updated list forks whose leaf addresses go backward in logical order. Existing tests cover queue offsets, tree-depth boundaries, IEEE-754 values, source bytes, nested snapshots, target growth, and shared/copy attachments. Browser workers will run these contracts on the portable output.
