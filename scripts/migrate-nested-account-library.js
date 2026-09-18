import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { accountForLibraryOwner, closeAccountLibraryData, updateAccountLibrary } from '../account-library-data.js';
import { accountOwnerId } from '../account-library-owner.js';

const client = await new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 10_000 }).connect();
const db = client.db(process.env.MONGODB_DB || 'rh_roku');
const names = {
  categories: process.env.MONGODB_LIBRARY_CATEGORY_COLLECTION || 'library_categories',
  favorites: process.env.MONGODB_FAVORITES_COLLECTION || 'favorites',
  overrides: process.env.MONGODB_SERIES_WATCH_OVERRIDE_COLLECTION || 'series_watch_overrides',
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
      for (const category of root.categories || []) await updateAccountLibrary(category.profileOwnerId || defaultOwner, library => {
        if (!library.categories.some(row => row.id === category.id)) library.categories.push(category);
        return library;
      });
      for (const assignment of root.assignments || []) await updateAccountLibrary(assignment.profileOwnerId || defaultOwner, library => {
        if (!library.assignments.some(row => row.itemKey === assignment.itemKey)) library.assignments.push(assignment);
        return library;
      });
      for (const favorite of root.favorites || []) await updateAccountLibrary(defaultOwner, library => {
        if (!library.favorites.some(row => row.profileId === favorite.profileId && row.sourceId === favorite.sourceId && row.kind === favorite.kind && row.itemId === favorite.itemId)) library.favorites.push(favorite);
        return library;
      }, favorite.profileId);
      for (const override of root.seriesWatchOverrides || []) await updateAccountLibrary(override.profileOwnerId || defaultOwner, library => {
        if (!library.seriesWatchOverrides.some(row => row.sourceId === override.sourceId && row.seriesId === override.seriesId)) library.seriesWatchOverrides.push(override);
        return library;
      });
      await collection.updateOne({ _id: account._id }, { $unset: { library: '' } });
    }
  }
  for (const row of rows.categories) {
    try { await accountForLibraryOwner(row.ownerId); }
    catch {
      if ((row.categories || []).length || (row.assignments || []).length) unmapped.push({ kind: 'categories', ownerId: row.ownerId });
      continue;
    }
    await updateAccountLibrary(row.ownerId, library => {
      const categories = new Map([...library.categories, ...(row.categories || []).map(item => ({ ...item, profileOwnerId: String(row.ownerId) }))].map(item => [`${item.profileOwnerId}:${item.id}`, item]));
      const assignments = new Map([...library.assignments, ...(row.assignments || []).map(item => ({ ...item, profileOwnerId: String(row.ownerId) }))].map(item => [`${item.profileOwnerId}:${item.itemKey}`, item]));
      library.categories = [...categories.values()];
      library.assignments = [...assignments.values()];
      return library;
    });
    migrated++;
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
  for (const row of rows.overrides) {
    try { await accountForLibraryOwner(row.ownerId); }
    catch { unmapped.push({ kind: 'overrides', ownerId: row.ownerId }); continue; }
    await updateAccountLibrary(row.ownerId, library => {
      const { _id, ownerId, ...override } = row;
      override.profileOwnerId = String(ownerId);
      if (!library.seriesWatchOverrides.some(item => item.profileOwnerId === override.profileOwnerId && item.sourceId === override.sourceId && item.seriesId === override.seriesId)) library.seriesWatchOverrides.push(override);
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
          library.savedSelections[String(source._id)] ||= Object.fromEntries(fields.map(field => [field, selection[field] || []]));
          return library;
        });
      } catch { unmapped.push({ kind: 'savedSelections', ownerId }); resolved = false; }
    }
    if (resolved) sourcesMigrated++;
  }
  if (!unmapped.some(row => row.kind === 'xtream_sources')) await sourceCollection.drop().catch(error => { if (error.codeName !== 'NamespaceNotFound') throw error; });
  console.log(JSON.stringify({ migrated, sourcesMigrated, counts: Object.fromEntries(Object.entries(rows).map(([kind, data]) => [kind, data.length])), unmapped }));
  if (unmapped.length) process.exitCode = 1;
} finally {
  await client.close();
  await closeAccountLibraryData();
}
