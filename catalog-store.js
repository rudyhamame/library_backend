import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
let clientPromise;

async function database() {
  clientPromise ||= new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect();
  return (await clientPromise).db(databaseName);
}

const validKind = value => ['movie', 'series', 'channel'].includes(String(value)) ? String(value) : '';

export async function syncCatalogItems({ accountId, providerId, providerName = '', kind, items = [] }) {
  const account = String(accountId || '');
  const provider = String(providerId || '');
  const itemKind = validKind(kind);
  if (!account || !provider || !itemKind) throw new Error('Account, provider, and catalog kind are required');
  const db = await database();
  const collection = db.collection('catalog_items');
  const syncToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const updatedAt = new Date();
  const rows = (Array.isArray(items) ? items : []).map(item => {
    const itemId = String(item?.id || item?.itemId || '');
    return {
      _id: `${account}:${provider}:${itemKind}:${itemId}`,
      accountId: account, providerId: provider, providerName: String(providerName || ''),
      kind: itemKind, itemId, title: String(item?.title || ''),
      categoryId: String(item?.categoryId || ''), category: String(item?.category || item?.categoryName || ''),
      logo: String(item?.logo || ''), extension: String(item?.extension || ''), duration: String(item?.duration || ''),
      rating: String(item?.rating || ''), added: String(item?.added || ''),
      metadata: item?.metadata && typeof item.metadata === 'object' ? item.metadata : {},
      syncToken, updatedAt,
    };
  }).filter(item => item.itemId && item.title);
  if (rows.length) await collection.bulkWrite(rows.map(row => ({ updateOne: { filter: { _id: row._id }, update: { $set: row }, upsert: true } })), { ordered: false });
  await collection.deleteMany({ accountId: account, providerId: provider, kind: itemKind, syncToken: { $ne: syncToken } });
  await db.collection('catalog_syncs').updateOne(
    { _id: `${account}:${provider}` },
    { $set: { accountId: account, providerId: provider, providerName: String(providerName || ''), [`kinds.${itemKind}`]: { count: rows.length, syncedAt: updatedAt }, updatedAt }, $setOnInsert: { createdAt: updatedAt } },
    { upsert: true },
  );
  return { count: rows.length, kind: itemKind };
}