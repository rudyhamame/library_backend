import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

// MongoDB-backed snapshot of a provider's catalog. It exists to keep provider
// traffic low: a category is downloaded from the provider at most once per TTL
// window (see server.js), no matter how much the clients browse or scroll, and
// the last good snapshot keeps being served when the provider blocks or errors.
// There is no timer/cron - refreshes are only triggered lazily by a real
// client request for a stale kind.

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items';
const metaCollectionName = process.env.MONGODB_PROVIDER_CATALOG_SYNC_COLLECTION || 'provider_catalog_syncs';
let collectionsPromise;

async function collections() {
  if (!collectionsPromise) {
    collectionsPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const database = client.db(databaseName);
        const items = database.collection(collectionName);
        const meta = database.collection(metaCollectionName);
        await Promise.all([
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, key: 1 }, { unique: true }),
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, addedSort: -1, providerOrder: -1 }),
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, categoryId: 1, providerOrder: 1 }),
          meta.createIndex({ ownerId: 1, sourceId: 1 }, { unique: true }),
        ]);
        return { items, meta };
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
  metadata: item?.metadata && typeof item.metadata === 'object' ? item.metadata : {},
  sourceId: String(sourceId),
  providerName: String(providerName || 'Playlist'),
});

// Replace the stored rows for one provider/kind with a fresh provider snapshot.
export async function replaceProviderCatalog(ownerId, sourceId, providerName, kind, catalog) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return 0;
  const { items, meta } = await collections();
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
  await meta.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { $set: {
      ownerId: String(ownerId), sourceId: String(sourceId), providerName: String(providerName || 'Playlist'),
      [`kinds.${kind}`]: { count: rows.length, syncedAt }, updatedAt: syncedAt,
    } },
    { upsert: true },
  );
  return rows.length;
}

// Persist the provider's category list (id + name) for one kind. Catalog rows
// carry only a category id, so names must be stored from get_*_categories.
export async function replaceProviderCatalogCategories(ownerId, sourceId, kind, categories) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return 0;
  const { meta } = await collections();
  const list = (Array.isArray(categories) ? categories : [])
    .map(entry => ({ id: String(entry?.id ?? ''), name: String(entry?.name ?? '').trim() || 'Other' }))
    .filter(entry => entry.id);
  await meta.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { $set: { [`categories.${kind}`]: { list, syncedAt: new Date() } } },
    { upsert: true },
  );
  return list.length;
}

// { kinds: { series: {count, syncedAt}, ... }, categories: { series: {list, syncedAt} }, updatedAt }
export async function getProviderCatalogMeta(ownerId, sourceId) {
  if (!ownerId || !sourceId) return null;
  const { meta } = await collections();
  return meta.findOne({ ownerId: String(ownerId), sourceId: String(sourceId) }, { projection: { _id: 0 } });
}

// The full stored row list for one provider/kind. The catalog endpoint keeps
// doing its own category/language/search filtering on this array.
export async function getProviderCatalogItems(ownerId, sourceId, kind) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items } = await collections();
  return items
    .find({ ownerId: String(ownerId), sourceId: String(sourceId), kind })
    .sort({ providerOrder: 1 })
    .project({ _id: 0, ownerId: 0, syncToken: 0, syncedAt: 0 })
    .toArray();
}

// Distinct two-letter title-prefix language codes ("DE - ...", "AR | ..."),
// computed entirely in MongoDB so the huge item set is never pulled into Node
// just to populate the language filter.
export async function getProviderCatalogLanguagePrefixes(ownerId, sourceId, kind) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items } = await collections();
  const rows = await items.aggregate([
    { $match: { ownerId: String(ownerId), sourceId: String(sourceId), kind } },
    { $project: { p: { $regexFind: { input: { $ifNull: ['$title', ''] }, regex: '^\\s*([A-Za-z]{2})\\s*[-|:]' } } } },
    { $group: { _id: { $arrayElemAt: ['$p.captures', 0] } } },
  ], { allowDiskUse: true }).toArray();
  return rows.map(row => (row._id ? String(row._id).toUpperCase() : 'OTHER'));
}

// Stored rows for one category (or 'all'), bounded so a huge provider never
// pulls hundreds of thousands of documents into the Roku response path.
export async function getProviderCatalogItemsForCategory(ownerId, sourceId, kind, categoryId, limit = 1500) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items } = await collections();
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId), kind };
  if (categoryId && String(categoryId) !== 'all') filter.categoryId = String(categoryId);
  const bounded = Math.max(1, Math.min(4000, Number(limit) || 1500));
  return items
    .find(filter)
    .sort({ providerOrder: 1 })
    .limit(bounded)
    .project({ _id: 0, ownerId: 0, syncToken: 0, syncedAt: 0 })
    .toArray();
}

// Newest N rows per kind for the Welcome rails, plus the sync/count metadata.
export async function getProviderCatalogRails(ownerId, sourceId, limit = 10) {
  const { items, meta } = await collections();
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId) };
  const projection = { _id: 0, ownerId: 0, syncToken: 0, addedSort: 0, providerOrder: 0, syncedAt: 0 };
  const [series, movie, channel, metaDoc] = await Promise.all([
    items.find({ ...filter, kind: 'series' }).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project(projection).toArray(),
    items.find({ ...filter, kind: 'movie' }).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project(projection).toArray(),
    items.find({ ...filter, kind: 'channel' }).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project(projection).toArray(),
    meta.findOne(filter, { projection: { _id: 0 } }),
  ]);
  return { series, movie, channel, updatedAt: metaDoc?.updatedAt || null, kinds: metaDoc?.kinds || {} };
}

// Stored category list joined with per-category item counts. [] until the
// provider's real category names have been persisted at least once.
export async function getProviderCatalogCategories(ownerId, sourceId, kind) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items, meta } = await collections();
  const metaDoc = await meta.findOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { projection: { [`categories.${kind}`]: 1 } },
  );
  const stored = Array.isArray(metaDoc?.categories?.[kind]?.list) ? metaDoc.categories[kind].list : [];
  if (!stored.length) return [];
  const counts = new Map((await items.aggregate([
    { $match: { ownerId: String(ownerId), sourceId: String(sourceId), kind } },
    { $group: { _id: '$categoryId', count: { $sum: 1 } } },
  ]).toArray()).map(row => [String(row._id || ''), row.count]));
  return stored
    .map(entry => ({ id: String(entry.id || ''), name: String(entry.name || 'Other'), count: counts.get(String(entry.id || '')) || 0 }))
    .filter(entry => entry.id)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

// Every stored snapshot's metadata, across all owners/sources (dashboard use).
export async function listProviderCatalogMeta() {
  const { meta } = await collections();
  return meta.find({}, { projection: { _id: 0 } }).sort({ providerName: 1 }).toArray();
}

// Paginated stored rows for one owner/source/kind, optional category filter and
// title search - all done in MongoDB, sorted by title so page boundaries stay
// stable as the client loads more.
export async function queryProviderCatalogItems(ownerId, sourceId, kind, { q = '', categoryId = '', page = 1, limit = 50, extraFilters = [] } = {}) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) {
    return { items: [], total: 0, page: 1, limit, pageCount: 1 };
  }
  const { items } = await collections();
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId), kind };
  const category = String(categoryId || '').trim();
  if (category && category !== 'all') filter.categoryId = category;
  const term = String(q || '').trim();
  if (term) filter.title = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const fragments = (Array.isArray(extraFilters) ? extraFilters : []).filter(Boolean);
  if (fragments.length) filter.$and = fragments;
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const boundedPage = Math.max(1, Number(page) || 1);
  const total = await items.countDocuments(filter);
  const rows = await items.find(filter)
    .collation({ locale: 'en', numericOrdering: true })
    .sort({ title: 1, key: 1 })
    .skip((boundedPage - 1) * boundedLimit)
    .limit(boundedLimit)
    .project({ _id: 0, ownerId: 0, syncToken: 0, addedSort: 0, syncedAt: 0, providerOrder: 0 })
    .toArray();
  return { items: rows, total, page: boundedPage, limit: boundedLimit, pageCount: Math.max(1, Math.ceil(total / boundedLimit)) };
}

export async function deleteProviderCatalog(ownerId, sourceId) {
  if (!ownerId || !sourceId) return;
  const { items, meta } = await collections();
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId) };
  await Promise.all([items.deleteMany(filter), meta.deleteOne(filter)]);
}
