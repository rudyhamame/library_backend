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
  profiles: process.env.MONGODB_ACCOUNT_PROFILE_COLLECTION || 'account_profiles',
  providers: process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources',
  categories: process.env.MONGODB_LIBRARY_CATEGORY_COLLECTION || 'library_categories',
  favorites: process.env.MONGODB_FAVORITES_COLLECTION || 'favorites',
  playback: process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress',
  history: process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history',
  overrides: process.env.MONGODB_SERIES_WATCH_OVERRIDE_COLLECTION || 'series_watch_overrides',
  catalog: process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items',
  catalogSync: process.env.MONGODB_PROVIDER_CATALOG_SYNC_COLLECTION || 'provider_catalog_syncs',
  media: process.env.MONGODB_PROVIDER_MEDIA_METADATA_COLLECTION || 'provider_media_metadata',
  episodes: process.env.MONGODB_PROVIDER_SERIES_EPISODE_COLLECTION || 'provider_series_episodes',
};

async function ownerRows(collection, ownerId) {
  return collection.find({ ownerId }).toArray();
}

async function migrateAccount(db, account, roots) {
  const accountId = String(account._id);
  const ownerId = account.ownerId || accountOwnerId(account._id);
  const [profiles, providers, categories, favorites, playback, history, watchOverrides] = await Promise.all([
    db.collection(names.profiles).find({ accountId: new ObjectId(accountId) }).toArray(),
    ownerRows(db.collection(names.providers), ownerId),
    db.collection(names.categories).findOne({ ownerId }),
    ownerRows(db.collection(names.favorites), ownerId),
    ownerRows(db.collection(names.playback), ownerId),
    ownerRows(db.collection(names.history), ownerId),
    ownerRows(db.collection(names.overrides), ownerId),
  ]);
  const providerIds = providers.map(provider => provider._id);
  const [catalogRefs, syncRows, mediaRefs, episodeRefs] = await Promise.all([
    db.collection(names.catalog).aggregate([
      { $match: { ownerId, sourceId: { $in: providerIds.map(String) } } },
      { $group: { _id: { sourceId: '$sourceId', kind: '$kind' }, count: { $sum: 1 }, updatedAt: { $max: '$syncedAt' } } },
      { $project: { _id: 0, sourceId: '$_id.sourceId', kind: '$_id.kind', count: 1, updatedAt: 1, collection: names.catalog } },
    ]).toArray(),
    db.collection(names.catalogSync).aggregate([
      { $match: { ownerId } },
      { $project: { _id: 0, sourceId: 1, kinds: 1, updatedAt: 1, collection: { $literal: names.catalogSync } } },
    ]).toArray(),
    db.collection(names.media).aggregate([
      { $match: { ownerId } },
      { $group: { _id: { sourceId: '$sourceId', kind: '$kind' }, count: { $sum: 1 }, updatedAt: { $max: '$probedAt' } } },
      { $project: { _id: 0, sourceId: '$_id.sourceId', kind: '$_id.kind', count: 1, updatedAt: 1, collection: { $literal: names.media } } },
    ]).toArray(),
    db.collection(names.episodes).aggregate([
      { $match: { ownerId } },
      { $group: { _id: '$sourceId', seriesCount: { $sum: 1 }, updatedAt: { $max: '$updatedAt' } } },
      { $project: { _id: 0, sourceId: '$_id', seriesCount: 1, updatedAt: 1, collection: { $literal: names.episodes } } },
    ]).toArray(),
  ]);
  const root = buildAccountRoot({
    account: { ...account, ownerId, realm: 'roku' }, profiles, providers, categories,
    favorites, playback, history, watchOverrides,
    catalogRefs: [...catalogRefs, ...syncRows, ...mediaRefs, ...episodeRefs],
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