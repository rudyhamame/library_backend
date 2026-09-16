export function catalogFreshness(kindMeta, ttlMs, now = Date.now()) {
  const syncedAt = kindMeta?.syncedAt || null;
  const stale = !syncedAt || Boolean(kindMeta?.lastErrorAt)
    || now - new Date(syncedAt).getTime() > ttlMs;
  return { stale, syncedAt, unavailable: !syncedAt };
}

export function requireCatalogRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Provider returned an invalid catalog; keeping the last saved catalog');
  return rows;
}
