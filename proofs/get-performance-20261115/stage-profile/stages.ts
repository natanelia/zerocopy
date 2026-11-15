/** Diagnostic-only source instrumentation. Never include in a published build. */
type Stage = { calls: number; inclusiveMs: number };
type Snapshot = { stages: Record<string, Stage>; counters: Record<string, number> };
const state = {
  enabled: false,
  stages: Object.create(null) as Record<string, Stage>,
  counters: Object.create(null) as Record<string, number>,
  begin() {
    this.stages = Object.create(null);
    this.counters = Object.create(null);
    this.enabled = true;
  },
  stop(): Snapshot {
    this.enabled = false;
    return {
      stages: Object.fromEntries(Object.entries(this.stages).map(([key, value]) => [key, { ...value }])),
      counters: { ...this.counters },
    };
  },
};
(globalThis as any)[Symbol.for('zerocopy.get.profile.v1')] = state;

export function profileStart(): number { return state.enabled ? performance.now() : -1; }
export function profileEnd(name: string, start: number): void {
  if (start < 0) return;
  const elapsed = performance.now() - start;
  const stage = state.stages[name] ??= { calls: 0, inclusiveMs: 0 };
  stage.calls++;
  stage.inclusiveMs += elapsed;
}
export function profileCount(name: string, amount = 1): void {
  if (state.enabled) state.counters[name] = (state.counters[name] ?? 0) + amount;
}
