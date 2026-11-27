export function validateSearchIndex(value) {
  if (!Array.isArray(value) || !value.every(entry => entry &&
    ['title', 'heading', 'context', 'description', 'route', 'text'].every(key => typeof entry[key] === 'string') &&
    /^docs\/[a-z0-9-]+\/(?:#[\p{L}\p{N}\p{M}_-]*)?$/u.test(entry.route))) {
    throw new Error('Search index has an unsupported format');
  }
  return value;
}

/** Pure local ranking: queries are text, never regular expressions or HTML. */
export function findResults(entries, query, limit = 8) {
  const terms = [...new Set(query.trim().toLowerCase().slice(0, 150).split(/\s+/).filter(Boolean))];
  const matches = entries.map(entry => {
    const heading = entry.heading.toLowerCase(), title = entry.title.toLowerCase();
    const context = entry.context.toLowerCase();
    const text = `${title} ${heading} ${context} ${entry.text} ${entry.heading ? '' : entry.description}`.toLowerCase();
    const score = !terms.length ? (entry.heading ? -1 : 0) : terms.every(term => text.includes(term))
      ? terms.reduce((sum, term) => sum + (heading.includes(term) ? 30 : title.includes(term) ? 15 : context.includes(term) ? 8 : 1), 0) : -1;
    return { ...entry, score };
  }).filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score);
  return { results: matches.slice(0, limit), total: matches.length, terms };
}

export function resultSnippet(entry, terms, length = 190) {
  const text = (entry.text || entry.description).replace(/\s+/g, ' ').trim();
  const folded = text.toLowerCase();
  const hits = terms.map(term => folded.indexOf(term)).filter(index => index >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - 55) : 0;
  const end = Math.min(text.length, start + length);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
