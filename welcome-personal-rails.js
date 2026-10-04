// Welcome is a bounded summary of persisted library identities. Resolve cards
// from the current provider catalog, never from another account or provider.
export function personalWelcomeRails({ history = [], selectedItems = [], catalogItems = [], sourceId, limit = 10 }) {
  const provider = String(sourceId || '');
  const cap = Math.min(10, Math.max(0, Number(limit) || 0));
  const kindOf = value => ['series', 'episode', 'series-search'].includes(value)
    ? 'series' : (['live', 'channel'].includes(value) ? 'channel' : value);
  const identityOf = item => {
    const identity = item?.providerIdentity || item || {};
    const kind = kindOf(identity.kind || item?.kind || item?.contentKind);
    const id = kind === 'series'
      ? identity.seriesId || item?.seriesId || identity.itemId || item?.id
      : identity.itemId || item?.itemId || item?.id;
    const source = String(identity.sourceId || item?.sourceId || '');
    return source === provider && id && ['series', 'movie', 'channel'].includes(kind)
      ? `${kind}:${id}` : '';
  };
  const catalog = new Map(catalogItems.map(item => [identityOf(item), item]).filter(([key]) => key));
  const resolve = items => {
    const seen = new Set();
    const cards = [];
    for (const item of items) {
      const key = identityOf(item);
      const card = catalog.get(key);
      if (!card || seen.has(key)) continue;
      seen.add(key);
      cards.push(card);
      if (cards.length >= cap) break;
    }
    return cap ? cards : [];
  };
  return {
    lastWatched: resolve([...history].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))),
    savedItems: resolve(selectedItems),
  };
}
