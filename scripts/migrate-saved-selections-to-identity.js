// One-off migration: stop storing hardcoded provider URLs in saved/watched
// items. Converts:
//   - profile.library.savedSelections.{series,movies,live}: array of URL
//     strings -> array of {sourceId, kind, itemId}
//   - profile.library.last_kinds_watched.{episode,movie,live}: drops the
//     `providerURL` field (fully redundant - itemId/kind/sourceId/seriesId
//     already live top-level on these records)
//   - profile.library.series_last_watched[]: renames `providerURL` ->
//     `providerIdentity` and adds `kind: 'episode'` (this was the only
//     place these records' identity lived, just under a misleading name)
// Run once against each database: `node scripts/migrate-saved-selections-to-identity.js`
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';

const idFromUrl = value => String(value || '').match(/\/(?:series|movie|live)\/[^/]+\/[^/]+\/([^/?#]+)/i)?.[1]?.replace(/\.[a-z0-9]+$/i, '') || '';
const identityKindFor = bucket => bucket === 'live' ? 'channel' : bucket === 'movies' ? 'movie' : 'series';

function migrateSavedSelectionBucket(entries, bucket, providers) {
  if (!Array.isArray(entries)) return { items: [], changed: false };
  let changed = false;
  const items = [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && entry.itemId != null && entry.sourceId != null) {
      items.push({ sourceId: String(entry.sourceId), kind: String(entry.kind || identityKindFor(bucket)), itemId: String(entry.itemId) });
      continue;
    }
    if (typeof entry === 'string' && entry) {
      const itemId = idFromUrl(entry);
      const source = providers.find(item => entry.startsWith(String(item.baseUrl || '').replace(/\/$/, '') + '/'));
      if (itemId && source) {
        items.push({ sourceId: String(source._id), kind: identityKindFor(bucket), itemId });
        changed = true;
        continue;
      }
    }
    changed = true; // unrecognized/unmatched entry: dropped
  }
  return { items, changed };
}

// bucketKey is the last_kinds_watched object key ('episode'/'movie'/'live'),
// which is the source of truth for kind - not any stale identity.kind value,
// since saveStreamingHistory's own convention is 'series'/'movie'/'channel'.
const kindForBucketKey = bucketKey => bucketKey === 'episode' ? 'series' : bucketKey === 'live' ? 'channel' : 'movie';

function migrateKindRecord(record, bucketKey) {
  if (!record) return { record, changed: false };
  const hasProviderUrl = Object.prototype.hasOwnProperty.call(record, 'providerURL');
  const identity = record.providerIdentity;
  const wrongKind = record.kind && record.kind !== kindForBucketKey(bucketKey);
  if (!hasProviderUrl && !identity && !wrongKind) return { record, changed: false }; // already flat/clean
  const { providerURL, providerIdentity, ...rest } = record;
  return {
    record: {
      ...rest,
      itemId: rest.itemId || identity?.itemId || '',
      kind: kindForBucketKey(bucketKey),
      sourceId: rest.sourceId || identity?.sourceId || '',
      seriesId: rest.seriesId || identity?.seriesId || '',
    },
    changed: true,
  };
}

function migrateSeriesRecord(record) {
  if (!record) return { record, changed: false };
  if (record.providerIdentity) return { record, changed: false };
  const legacy = record.providerURL && typeof record.providerURL === 'object' ? record.providerURL : {};
  const { providerURL, ...rest } = record;
  return {
    record: {
      ...rest,
      providerIdentity: {
        sourceId: legacy.sourceId || '',
        kind: 'episode',
        itemId: legacy.itemId || '',
        seriesId: legacy.seriesId || '',
        sessionId: legacy.sessionId || '',
      },
    },
    changed: true,
  };
}

async function migrateDatabase(client, databaseName) {
  const collection = client.db(databaseName).collection('identity');
  let accountsChanged = 0, selectionsChanged = 0, watchedChanged = 0;
  for (const account of await collection.find({ profiles: { $exists: true } }).toArray()) {
    const providers = Array.isArray(account.providers) ? account.providers : [];
    let accountChanged = false;
    const profiles = (account.profiles || []).map(profile => {
      const library = profile.library;
      if (!library) return profile;
      let profileChanged = false;

      if (library.savedSelections) {
        const nextSaved = {};
        for (const bucket of ['series', 'movies', 'live']) {
          const { items, changed } = migrateSavedSelectionBucket(library.savedSelections[bucket], bucket, providers);
          nextSaved[bucket] = items;
          if (changed) { profileChanged = true; selectionsChanged++; }
        }
        library.savedSelections = nextSaved;
      }

      if (Array.isArray(library.series_last_watched)) {
        library.series_last_watched = library.series_last_watched.map(record => {
          const { record: next, changed } = migrateSeriesRecord(record);
          if (changed) { profileChanged = true; watchedChanged++; }
          return next;
        });
      }

      if (library.last_kinds_watched) {
        for (const key of ['episode', 'movie', 'live']) {
          const { record: next, changed } = migrateKindRecord(library.last_kinds_watched[key], key);
          if (changed) { profileChanged = true; watchedChanged++; }
          library.last_kinds_watched[key] = next;
        }
      }

      if (profileChanged) accountChanged = true;
      return profile;
    });
    if (accountChanged) {
      await collection.updateOne({ _id: account._id }, { $set: { profiles, updatedAt: new Date() } });
      accountsChanged++;
    }
  }
  console.log(`[${databaseName}] accounts changed=${accountsChanged} savedSelections buckets changed=${selectionsChanged} watched records changed=${watchedChanged}`);
}

const client = await MongoClient.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
try {
  for (const databaseName of [rokuDb, generalDb]) await migrateDatabase(client, databaseName);
} finally {
  await client.close();
}
