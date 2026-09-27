/** One route registry for navigation, search, Markdown links, and the sitemap. */
export const pages = [
  { source: 'docs/getting-started.md', slug: 'getting-started', title: 'Get started', group: 'Start here', description: 'Share state with a worker. Read it directly on both threads.' },
  { source: 'website/content/mental-model.md', slug: 'mental-model', title: 'How sharing works', group: 'Start here', description: 'One writer, immutable snapshots, and local reads. A model you can reason about.' },
  { source: 'docs/api.md', slug: 'collections', title: 'Collections & types', group: 'Build with it', description: 'Maps, lists, sets, typed JSON, and nested collections.' },
  { source: 'docs/worker-sessions.md', slug: 'sessions', title: 'State & subscriptions', group: 'Build with it', description: 'Connect workers and publish new snapshots without a task system.' },
  { source: 'docs/worker-sharing.md', slug: 'transport', title: 'Your own transport', group: 'Build with it', description: 'Use shared snapshots with an existing message protocol.' },
  { source: 'docs/task-quickstart.md', slug: 'tasks', title: 'Optional tasks', group: 'Build with it', description: 'Schedule a whole calculation. Keep individual reads local.' },
  { source: 'docs/workers.md', slug: 'workers', title: 'Workers & pools', group: 'Build with it', description: 'Owned workers, existing workers, pools, MessagePorts, and SharedWorkers.' },
  { source: 'docs/redux.md', slug: 'redux', title: 'Redux', group: 'Integrations', description: 'Keep your store. Share selected collections with workers.' },
  { source: 'docs/tanstack.md', slug: 'tanstack', title: 'TanStack', group: 'Integrations', description: 'Collection wrappers and cache helpers, with their current limits.' },
  { source: 'docs/architecture.md', slug: 'memory', title: 'Memory & ownership', group: 'Go deeper', description: 'Understand storage, retained snapshots, and explicit compaction.' },
  { source: 'docs/benchmarks.md', slug: 'benchmarks', title: 'Recorded benchmarks', group: 'Go deeper', description: 'All recorded results, slower workloads, and methods. No selected-only results.' },
  { source: 'docs/migration.md', slug: 'migration', title: 'Migration', group: 'Go deeper', description: 'Format and lifetime changes for existing users.' },
  { source: 'website/content/analytics.md', slug: 'analytics', title: 'Product catalogs & filtering', group: 'Use cases', description: 'Read stock directly and filter a large catalog in workers.' },
  { source: 'website/content/maps.md', slug: 'maps', title: 'Maps & spatial tools', group: 'Use cases', description: 'Keep the map editable while workers inspect its data.' },
  { source: 'website/content/editors.md', slug: 'editors', title: 'Editors & history', group: 'Use cases', description: 'Read an earlier version without stopping new edits.' },
];
export const repository = 'https://github.com/natanelia/zerocopy';
/** Restrict a deployment prefix to clean URL path segments. */
export function basePath(value = '/') {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) throw new Error('SITE_BASE must be / or a path such as /zerocopy/');
  return value;
}
