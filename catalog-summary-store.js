import { MongoClient } from 'mongodb';
import { accountOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const accountCollectionName = process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts';
const sourceCollectionName = process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources';
const catalogCollectionName = process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items';
let collectionsPromise;

async function collections() {
  if (!collectionsPromise) {
    collectionsPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(client => {
        const database = client.db(databaseName);
        return { accounts: database.collection(accountCollectionName), sources: database.collection(sourceCollectionName), catalog: database.collection(catalogCollectionName) };
      })
      .catch(error => { collectionsPromise = undefined; throw error; });
  }
  return collectionsPromise;
}

export async function getCatalogSummary() {
  const { accounts, sources, catalog } = await collections();
  const [accountRows, sourceRows, countRows] = await Promise.all([
    accounts.find({}, { projection: { _id: 1, email: 1, firstName: 1, lastName: 1, ownerId: 1 } }).toArray(),
    sources.find({}, { projection: { _id: 1, ownerId: 1, name: 1 } }).sort({ name: 1 }).toArray(),
    catalog.aggregate([{ $group: { _id: { ownerId: '$ownerId', sourceId: '$sourceId', kind: '$kind' }, count: { $sum: 1 } } }]).toArray(),
  ]);
  const accountByOwner = new Map();
  for (const account of accountRows) {
    const ownerId = String(account.ownerId || accountOwnerId(account._id));
    const name = [account.firstName, account.lastName].filter(Boolean).join(' ').trim();
    accountByOwner.set(ownerId, { ownerId, user: String(account.email || name || account._id) });
  }
  const counts = new Map();
  for (const row of countRows) {
    const key = `${String(row._id.ownerId)}:${String(row._id.sourceId)}`;
    const value = counts.get(key) || { series: 0, movies: 0, channels: 0 };
    if (row._id.kind === 'series') value.series = row.count;
    if (row._id.kind === 'movie') value.movies = row.count;
    if (row._id.kind === 'channel') value.channels = row.count;
    counts.set(key, value);
  }
  const rows = sourceRows.map(source => {
    const ownerId = String(source.ownerId || '');
    const values = counts.get(`${ownerId}:${String(source._id)}`) || { series: 0, movies: 0, channels: 0 };
    return { user: accountByOwner.get(ownerId)?.user || ownerId || 'Unknown user', provider: String(source.name || 'Playlist'), sourceId: String(source._id), ...values, total: values.series + values.movies + values.channels };
  });
  const ownersWithSources = new Set(sourceRows.map(source => String(source.ownerId || '')));
  for (const account of accountByOwner.values()) if (!ownersWithSources.has(account.ownerId)) rows.push({ user: account.user, provider: '—', series: 0, movies: 0, channels: 0, total: 0 });
  rows.sort((a, b) => a.user.localeCompare(b.user) || a.provider.localeCompare(b.provider));
  return { rows, updatedAt: new Date().toISOString() };
}
