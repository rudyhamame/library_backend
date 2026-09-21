import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { accountOwnerId } from '../account-library-owner.js';
import { buildAccountRoot } from '../account-root-core.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });

const names = {
  roots: process.env.MONGODB_ACCOUNT_ROOT_COLLECTION || 'account_roots',
  accounts: process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts',
  playback: process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress',
};

async function ownerRows(collection, ownerId) {
  return collection.find({ ownerId }).toArray();
}

async function migrateAccount(db, account, roots) {
  const accountId = String(account._id);
  const ownerId = account.ownerId || accountOwnerId(account._id);
  const [profiles, providers, favorites, playback, history] = await Promise.all([
    Promise.resolve(Array.isArray(account.profiles) ? account.profiles : []),
    Promise.resolve(Array.isArray(account.providers) ? account.providers : []),
    Promise.resolve((account.profiles || []).flatMap(profile => profile.library?.favorites || [])),
    ownerRows(db.collection(names.playback), ownerId),
    Promise.resolve((account.profiles || []).flatMap(profile => {
      const library = profile.library || {};
      const groupedHistory = library.streaming_history || {};
      const currentHistory = Array.isArray(groupedHistory)
        ? groupedHistory
        : ['episodes', 'movies', 'live'].flatMap(bucket => Array.isArray(groupedHistory[bucket]) ? groupedHistory[bucket] : []);
      const records = currentHistory.length
        ? currentHistory
        : [
          ...(Array.isArray(library.series_last_watched) ? library.series_last_watched : []),
          ...Object.values(library.last_kinds_watched || {}).filter(Boolean),
        ];
      return records.map(item => ({ ...item, ownerId: profile.ownerId }));
    })),
  ]);
  const root = buildAccountRoot({
    account: { ...account, ownerId, realm: 'roku' }, profiles, providers,
    favorites, playback, history,
  });
  await roots.replaceOne({ _id: ownerId }, root, { upsert: true });
  return { accountId, ownerId, providers: providers.length, profiles: profiles.length, playback: playback.length, history: history.length };
}

try {
  await client.connect();
  const db = client.db(databaseName);
  const roots = db.collection(names.roots);
  const accounts = await db.collection(names.accounts).find({}).toArray();
  const results = [];
  for (const account of accounts) results.push(await migrateAccount(db, account, roots));
  console.log(JSON.stringify({ ok: true, collection: names.roots, migrated: results.length, results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close();
}
