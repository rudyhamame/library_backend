import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { accountForLibraryOwner, closeAccountLibraryData, updateAccountLibrary } from '../account-library-data.js';
import { accountOwnerId } from '../account-library-owner.js';

const client = await new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 10_000 }).connect();
const db = client.db(process.env.MONGODB_DB || 'rh_roku');
const names = {
  favorites: process.env.MONGODB_FAVORITES_COLLECTION || 'favorites',
  history: process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history',
};

try {
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
  const rows = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([kind, name]) => [
    kind, collections.has(name) ? await db.collection(name).find({}).toArray() : [],
  ])));
  const unmapped = [];
  let migrated = 0;
  for (const [dbName, collectionName] of [[process.env.MONGODB_DB || 'rh_roku', 'identity'], [process.env.MONGODB_GENERAL_DB || 'rh_general', process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts']]) {
    const collection = client.db(dbName).collection(collectionName);
    for (const account of await collection.find({ library: { $exists: true } }).toArray()) {
      const root = account.library || {};
      const defaultOwner = accountOwnerId(account._id);
      for (const favorite of root.favorites || []) await updateAccountLibrary(defaultOwner, library => {
        if (!library.favorites.some(row => row.profileId === favorite.profileId && row.sourceId === favorite.sourceId && row.kind === favorite.kind && row.itemId === favorite.itemId)) library.favorites.push(favorite);
        return library;
      }, favorite.profileId);
      await collection.updateOne({ _id: account._id }, { $unset: { library: '' } });
    }
  }
  for (const row of rows.favorites) {
    try { await accountForLibraryOwner(row.ownerId); }
    catch { unmapped.push({ kind: 'favorites', ownerId: row.ownerId }); continue; }
    await updateAccountLibrary(row.ownerId, library => {
      const { _id, ownerId, ...favorite } = row;
      if (!library.favorites.some(item => item.profileId === favorite.profileId && item.sourceId === favorite.sourceId && item.kind === favorite.kind && item.itemId === favorite.itemId)) library.favorites.push(favorite);
      return library;
    }, row.profileId);
    migrated++;
  }
  for (const row of rows.history) {
    try { await accountForLibraryOwner(row.ownerId); }
    catch { unmapped.push({ kind: 'history', ownerId: row.ownerId }); continue; }
    const key = ['channel', 'live'].includes(String(row.kind || '').toLowerCase()) ? 'live' : (['series', 'episode'].includes(String(row.kind || '').toLowerCase()) ? 'episode' : 'movie');
    await updateAccountLibrary(row.ownerId, library => {
      const { _id, ownerId, ...item } = row;
      const oldIdentity = item.providerIdentity || (item.providerURL && typeof item.providerURL === 'object' ? item.providerURL : {});
      const identity = {
        itemId: String(oldIdentity.itemId || item.itemId || ''),
        kind: key === 'live' ? 'channel' : (key === 'episode' ? 'series' : 'movie'),
        sourceId: String(oldIdentity.sourceId || item.sourceId || ''),
        seriesId: String(oldIdentity.seriesId || item.seriesId || ''),
      };
      const { itemId, kind: _kind, sourceId, seriesId, providerIdentity, providerURL, providerUrl, ...metadata } = item;
      const migratedRecord = {
        ...metadata,
        ...(item.sessionId || oldIdentity.sessionId ? { sessionId: String(item.sessionId || oldIdentity.sessionId) } : {}),
        lastWatched: String(item.lastWatched || '00:00:00'), providerIdentity: identity,
      };
      const historyBucket = key === 'live' ? 'live' : (key === 'episode' ? 'episodes' : 'movies');
      const records = library.streaming_history[historyBucket];
      const historyIndex = records.findIndex(current => {
        const currentIdentity = current.providerIdentity || {};
        return currentIdentity.sourceId === identity.sourceId && currentIdentity.kind === identity.kind && currentIdentity.itemId === identity.itemId;
      });
      const oldHistory = historyIndex >= 0 ? records[historyIndex] : null;
      if (!oldHistory || new Date(migratedRecord.updatedAt || 0) >= new Date(oldHistory.updatedAt || 0)) {
        if (historyIndex >= 0) records[historyIndex] = migratedRecord;
        else records.push(migratedRecord);
      }
      const current = library.last_kinds_watched[key];
      if (!current || new Date(item.updatedAt || 0) >= new Date(current.updatedAt || 0)) library.last_kinds_watched[key] = migratedRecord;
      return library;
    });
    migrated++;
  }
  const sourceCollection = db.collection(process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources');
  const sourceRows = await sourceCollection.find({}).toArray();
  let sourcesMigrated = 0;
  for (const source of sourceRows) {
    let accountRecord;
    try { accountRecord = await accountForLibraryOwner(source.ownerId); }
    catch { unmapped.push({ kind: 'xtream_sources', ownerId: source.ownerId, sourceId: source._id }); continue; }
    const provider = { ...source };
    delete provider.ownerId;
    delete provider.selections;
    for (const field of ['enabledKeys', 'enabledItems', 'archivedKeys', 'archivedItems']) delete provider[field];
    const providers = Array.isArray(accountRecord.account.providers) ? accountRecord.account.providers : [];
    if (!providers.some(item => String(item._id) === String(provider._id))) {
      await accountRecord.collection.updateOne(
        { _id: accountRecord.account._id },
        { $push: { providers: provider }, $set: { updatedAt: new Date() } },
      );
    }
    const selections = { ...(source.selections || {}) };
    const fields = ['enabledKeys', 'enabledItems', 'archivedKeys', 'archivedItems'];
    if (fields.some(field => (source[field] || []).length)) selections[String(source.ownerId)] ||= Object.fromEntries(fields.map(field => [field, source[field] || []]));
    let resolved = true;
    for (const [ownerId, selection] of Object.entries(selections)) {
      try {
        await updateAccountLibrary(ownerId, library => {
          const saved = library.savedSelections || { series: [], movies: [], live: [] };
          const add = (kind, url) => {
            const value = String(url || '');
            if (value && !saved[kind].includes(value)) saved[kind].push(value);
          };
          for (const item of (selection.enabledItems || [])) {
            const url = item?.providerUrl || item?.url;
            if (!url) continue;
            const kind = String(item.kind || '').toLowerCase();
            add(kind === 'series' ? 'series' : (kind === 'live' || kind === 'channel' ? 'live' : 'movies'), url);
          }
          library.savedSelections = saved;
          return library;
        });
      } catch { unmapped.push({ kind: 'savedSelections', ownerId }); resolved = false; }
    }
    if (resolved) sourcesMigrated++;
  }
  if (!unmapped.some(row => row.kind === 'xtream_sources')) await sourceCollection.drop().catch(error => { if (error.codeName !== 'NamespaceNotFound') throw error; });
  const historyCollection = db.collection(names.history);
  if (!unmapped.some(row => row.kind === 'history')) await historyCollection.drop().catch(error => { if (error.codeName !== 'NamespaceNotFound') throw error; });
  console.log(JSON.stringify({ migrated, sourcesMigrated, counts: Object.fromEntries(Object.entries(rows).map(([kind, data]) => [kind, data.length])), unmapped }));
  if (unmapped.length) process.exitCode = 1;
} finally {
  await client.close();
  await closeAccountLibraryData();
}
