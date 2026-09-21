// One-off migration: stop storing hardcoded provider URLs in saved/watched
// items. Converts:
//   - profile.library.savedSelections.{series,movies,live}: array of URL
//     strings -> array of {sourceId, kind, itemId}
//   - playback history is migrated separately by rebuild-library-streaming-history.js.
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

async function migrateDatabase(client, databaseName) {
  const collection = client.db(databaseName).collection('identity');
  let accountsChanged = 0, selectionsChanged = 0;
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

      if (profileChanged) accountChanged = true;
      return profile;
    });
    if (accountChanged) {
      await collection.updateOne({ _id: account._id }, { $set: { profiles, updatedAt: new Date() } });
      accountsChanged++;
    }
  }
  console.log(`[${databaseName}] accounts changed=${accountsChanged} savedSelections buckets changed=${selectionsChanged}`);
}

const client = await MongoClient.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
try {
  for (const databaseName of [rokuDb, generalDb]) await migrateDatabase(client, databaseName);
} finally {
  await client.close();
}
