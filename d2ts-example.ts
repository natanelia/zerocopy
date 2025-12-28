/**
 * Worker-parallel d2ts pipeline example
 * 
 * Demonstrates running differential dataflow pipelines across workers
 * with shared state via SharedArrayBuffer.
 */

import { 
  SharedMultiSet, 
  SharedIndex,
  createSharedPipeline,
  getSharedPipelineState,
  initSharedPipelineState,
  D2,
  MultiSet,
  v,
  output,
  MessageType,
} from './d2ts-integration.ts';
import { map, filter, reduce, keyBy } from '@electric-sql/d2ts';

// ============================================================================
// Example 1: Basic pipeline with shared output
// ============================================================================

function example1_basicPipeline() {
  console.log('\n=== Example 1: Basic Pipeline ===');
  
  const { run } = createSharedPipeline<number, number>(
    (input) => input.pipe(
      map((x: number) => x + 5),
      filter((x: number) => x % 2 === 0)
    )
  );
  
  const results = run([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
  console.log('Input: [1, 2, 3, 4, 5]');
  console.log('Pipeline: map(x + 5) -> filter(even)');
  console.log('Results:', results.toArray());
}

// ============================================================================
// Example 2: Incremental updates
// ============================================================================

function example2_incrementalUpdates() {
  console.log('\n=== Example 2: Incremental Updates ===');
  
  const { graph, input, getResults } = createSharedPipeline<
    { id: string; value: number },
    { id: string; doubled: number }
  >(
    (inp) => inp.pipe(
      map((x) => ({ id: x.id, doubled: x.value * 2 }))
    )
  );
  
  // Initial data (version 0)
  input.sendData(0, new MultiSet([
    [{ id: 'a', value: 10 }, 1],
    [{ id: 'b', value: 20 }, 1],
  ]));
  input.sendFrontier(1);
  graph.run();
  
  console.log('After v0:', getResults().toArray());
  
  // Incremental update (version 1): add 'c', remove 'a'
  input.sendData(1, new MultiSet([
    [{ id: 'a', value: 10 }, -1],  // Delete
    [{ id: 'c', value: 30 }, 1],   // Insert
  ]));
  input.sendFrontier(2);
  graph.run();
  
  console.log('After v1 (add c, remove a):', getResults().toArray());
}

// ============================================================================
// Example 3: Aggregation with reduce
// ============================================================================

function example3_aggregation() {
  console.log('\n=== Example 3: Aggregation ===');
  
  type Sale = { product: string; amount: number };
  
  const { run } = createSharedPipeline<Sale, [string, number]>(
    (input) => input.pipe(
      keyBy((s: Sale) => s.product),
      reduce((vals: [Sale, number][]) => {
        let total = 0;
        for (const [sale, mult] of vals) {
          total += sale.amount * mult;
        }
        return [[total, 1]];
      }),
      map(([key, val]) => [key, val] as [string, number])
    )
  );
  
  const results = run([
    [{ product: 'apple', amount: 10 }, 1],
    [{ product: 'apple', amount: 20 }, 1],
    [{ product: 'banana', amount: 15 }, 1],
    [{ product: 'banana', amount: 25 }, 1],
  ]);
  
  console.log('Sales by product:', results.toArray());
}

// ============================================================================
// Example 4: State serialization for workers
// ============================================================================

function example4_stateSerialization() {
  console.log('\n=== Example 4: State Serialization ===');
  
  const { run } = createSharedPipeline<string, string>(
    (input) => input.pipe(
      map((s: string) => s.toUpperCase()),
      filter((s: string) => s.length > 2)
    )
  );
  
  const results = run([
    ['hello', 1],
    ['hi', 1],
    ['world', 1],
  ]);
  
  console.log('Main thread results:', results.toArray());
  
  // Serialize for worker transfer
  const sharedState = getSharedPipelineState(results);
  console.log('Serialized state has root:', sharedState.root);
  
  // Deserialize (simulating worker)
  const workerResults = initSharedPipelineState<string>(sharedState);
  console.log('Deserialized results:', workerResults.toArray());
  
  // Worker can continue processing
  const furtherProcessed = workerResults.filter(s => s.startsWith('H'));
  console.log('Further filtered:', furtherProcessed.toArray());
}

// ============================================================================
// Example 5: SharedIndex for stateful operations
// ============================================================================

function example5_sharedIndex() {
  console.log('\n=== Example 5: SharedIndex ===');
  
  const index = new SharedIndex<string, number>();
  
  // Add versioned data
  index.addValue('user:1', v(0), [100, 1]);
  index.addValue('user:1', v(1), [50, 1]);
  index.addValue('user:2', v(0), [200, 1]);
  
  console.log('User 1 at v0:', index.reconstructAt('user:1', v(0)));
  console.log('User 1 at v1:', index.reconstructAt('user:1', v(1)));
  console.log('User 2 at v0:', index.reconstructAt('user:2', v(0)));
  
  // Join example
  const scores = new SharedIndex<string, number>();
  scores.addValue('alice', v(0), [100, 1]);
  scores.addValue('bob', v(0), [200, 1]);
  
  const names = new SharedIndex<string, string>();
  names.addValue('alice', v(0), ['Alice Smith', 1]);
  names.addValue('bob', v(0), ['Bob Jones', 1]);
  
  const joined = scores.join(names);
  console.log('Joined scores with names:');
  for (const [version, multiset] of joined) {
    console.log('  Version:', version.toString(), 'Data:', multiset.getInner());
  }
}

// ============================================================================
// Example 6: Differential semantics
// ============================================================================

function example6_differentialSemantics() {
  console.log('\n=== Example 6: Differential Semantics ===');
  
  // Initial state
  let state = new SharedMultiSet<string>([
    ['alice', 1],
    ['bob', 1],
    ['charlie', 1],
  ]);
  console.log('Initial state:', state.toArray());
  
  // Change: remove bob, add dave
  const change1 = new SharedMultiSet<string>([
    ['bob', -1],     // Delete
    ['dave', 1],     // Insert
  ]);
  state = state.concat(change1);
  console.log('After change 1 (remove bob, add dave):', state.toArray());
  
  // Change: remove alice, add eve
  const change2 = new SharedMultiSet<string>([
    ['alice', -1],
    ['eve', 1],
  ]);
  state = state.concat(change2);
  console.log('After change 2 (remove alice, add eve):', state.toArray());
}

// ============================================================================
// Run all examples
// ============================================================================

example1_basicPipeline();
example2_incrementalUpdates();
example3_aggregation();
example4_stateSerialization();
example5_sharedIndex();
example6_differentialSemantics();

console.log('\n✓ All examples completed');
