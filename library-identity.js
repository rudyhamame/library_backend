const buckets = ['series', 'movies', 'live'];

const bucketKind = bucket => bucket === 'series' ? 'series' : bucket === 'live' ? 'channel' : 'movie';

function providerIdentityOf(value, bucket = '') {
  if (!value || typeof value !== 'object') return null;
  const identity = value.providerIdentity && typeof value.providerIdentity === 'object' ? value.providerIdentity : value;
  const sourceId = String(identity.sourceId ?? value.sourceId ?? '').trim();
  const kind = bucketKind(bucket || String(identity.kind || value.kind || ''));
  if (!sourceId) return null;
  if (kind === 'series') {
    const seriesId = String(identity.seriesId ?? value.seriesId ?? identity.itemId ?? value.itemId ?? value.id ?? '').trim();
    return seriesId ? { sourceId, kind, seriesId } : null;
  }
  const itemId = String(identity.itemId ?? value.itemId ?? value.id ?? '').trim();
  return itemId ? { itemId, kind, sourceId } : null;
}

function entriesFor(value, bucket) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[bucket]) ? value[bucket] : [];
}

export function normalizeIdentityBuckets(value) {
  const result = Object.fromEntries(buckets.map(bucket => [bucket, []]));
  const seen = new Set();
  for (const bucket of buckets) {
    for (const entry of entriesFor(value, bucket)) {
      const providerIdentity = providerIdentityOf(entry, bucket);
      if (!providerIdentity) continue;
      const id = providerIdentity.seriesId || providerIdentity.itemId;
      const key = `${providerIdentity.sourceId}:${providerIdentity.kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result[bucket].push({ providerIdentity });
    }
  }
  return result;
}

export function flatIdentityRows(value) {
  const normalized = normalizeIdentityBuckets(value);
  return buckets.flatMap(bucket => normalized[bucket].map(row => ({
    id: row.providerIdentity.seriesId || row.providerIdentity.itemId,
    kind: row.providerIdentity.kind,
    sourceId: row.providerIdentity.sourceId,
    providerIdentity: row.providerIdentity,
  })));
}

export { buckets, bucketKind, providerIdentityOf };
