import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items';
const syncCollectionName = process.env.MONGODB_PROVIDER_CATALOG_SYNC_COLLECTION || 'provider_catalog_syncs';
let collectionsPromise;

async function collections() {
  if (!collectionsPromise) {
    collectionsPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const database = client.db(databaseName);
        const items = database.collection(collectionName);
        const syncs = database.collection(syncCollectionName);
        await Promise.all([
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, key: 1 }, { unique: true }),
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, addedSort: -1, providerOrder: -1 }),
          syncs.createIndex({ ownerId: 1, sourceId: 1 }, { unique: true }),
        ]);
        return { items, syncs };
      })
      .catch(error => { collectionsPromise = undefined; throw error; });
  }
  return collectionsPromise;
}

const cleanItem = (item, sourceId, providerName) => ({
  key: String(item?.key || ''),
  id: String(item?.id || ''),
  kind: String(item?.kind || ''),
  title: String(item?.title || ''),
  categoryId: String(item?.categoryId || ''),
  category: String(item?.category || item?.categoryName || ''),
  logo: String(item?.logo || ''),
  extension: String(item?.extension || ''),
  duration: String(item?.duration || ''),
  rating: String(item?.rating || ''),
  added: String(item?.added || ''),
  sourceId: String(sourceId),
  providerName: String(providerName || 'Playlist'),
});

export function newestCatalogItems(items, limit = 10) {
  return [...(Array.isArray(items) ? items : [])]
    .sort((a, b) => Number(b?.added || 0) - Number(a?.added || 0)
      || Number(b?.providerOrder || 0) - Number(a?.providerOrder || 0))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

export async function replaceProviderCatalog(ownerId, sourceId, providerName, kind, catalog) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return 0;
  const { items, syncs } = await collections();
  const syncToken = randomUUID();
  const syncedAt = new Date();
  const rows = (Array.isArray(catalog) ? catalog : []).map((item, providerOrder) => ({
    ...cleanItem({ ...item, kind }, sourceId, providerName),
    ownerId: String(ownerId), kind, providerOrder,
    addedSort: Number(item?.added || 0) || 0,
    syncToken, syncedAt,
  })).filter(item => item.key && item.id);
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    await items.bulkWrite(batch.map(item => ({ updateOne: {
      filter: { ownerId: item.ownerId, sourceId: item.sourceId, kind, key: item.key },
      update: { $set: item }, upsert: true,
    } })), { ordered: false });
  }
  await items.deleteMany({ ownerId: String(ownerId), sourceId: String(sourceId), kind, syncToken: { $ne: syncToken } });
  await syncs.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { $set: { ownerId: String(ownerId), sourceId: String(sourceId), providerName: String(providerName || 'Playlist'), [`kinds.${kind}`]: { count: rows.length, syncedAt }, updatedAt: syncedAt } },
    { upsert: true },
  );
  return rows.length;
}

export async function getProviderCatalogRails(ownerId, sourceId, limit = 10) {
  const { items, syncs } = await collections();
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId) };
  const [series, movie, channel, sync] = await Promise.all([
    items.find({ ...filter, kind: 'series' }).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project({ _id: 0, ownerId: 0, syncToken: 0, addedSort: 0, providerOrder: 0, syncedAt: 0 }).toArray(),
    items.find({ ...filter, kind: 'movie' }).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project({ _id: 0, ownerId: 0, syncToken: 0, addedSort: 0, providerOrder: 0, syncedAt: 0 }).toArray(),
    items.find({ ...filter, kind: 'channel' }).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project({ _id: 0, ownerId: 0, syncToken: 0, addedSort: 0, providerOrder: 0, syncedAt: 0 }).toArray(),
    syncs.findOne(filter, { projection: { _id: 0 } }),
  ]);
  return { series, movie, channel, updatedAt: sync?.updatedAt || null, sync: sync?.kinds || {} };
}

export async function deleteProviderCatalog(ownerId, sourceId) {
  if (!ownerId || !sourceId) return;
  const { items, syncs } = await collections();
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId) };
  await Promise.all([items.deleteMany(filter), syncs.deleteOne(filter)]);
}
