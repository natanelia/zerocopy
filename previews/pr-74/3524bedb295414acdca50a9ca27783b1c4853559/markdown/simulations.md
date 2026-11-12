# Simulation and world-state tools

[All use cases](../../docs/use-cases.md) · [Memory and ownership](../../docs/architecture.md)

A simulation editor may need analysis, planning, and visual inspection of the same world state. The simulation can own the state and publish versions for readers. This is useful when the state is a large structured collection, not just a few numbers.

## Separate ownership from observation

The simulation thread is the allocating writer. Analysis workers and the UI read published entity and event collections. A reader can finish its work on one version while the simulation produces the next version.

Publish at a rate that the application can afford. Not every simulation tick needs a UI snapshot. Latest-state delivery can skip intermediate publications; use an explicit history design when every tick matters.

Readers that produce new collections allocate in their own arenas. Send commands to the state owner to change the world. The shared input does not grant concurrent write access.

## Do not confuse collections with a compute engine

Zerocopy does not supply a game engine, physics solver, GPU pipeline, deterministic scheduler, or hard real-time guarantee. Typed arrays and transferred buffers can be a better fit for dense numeric kernels, audio, video, and GPU-bound work.

Benchmark the whole pipeline, including immutable allocation, publication frequency, decoded values, and retained history. A rapidly changing frame can make a persistent collection model less suitable than a dedicated buffer representation.

This is an application design, not a production simulation shipped by zerocopy. Use the [log explorer](log-explorer.md) to see the ownership and stable-reader pattern in a smaller working application.
