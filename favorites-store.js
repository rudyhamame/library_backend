import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_FAVORITES_COLLECTION || 'favorites';
let collectionPromise;

async function favoritesCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(async client => {
        const collection = client.db(databaseName).collection(collectionName);
        await collection.createIndex({ ownerId: 1, itemId: 1 }, { unique: true });
        return collection;
      })
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export async function getFavorites(ownerId) {
  if (!ownerId) return [];
  return (await (await favoritesCollection()).find({ ownerId: String(ownerId) }).sort({ updatedAt: -1 }).toArray())
    .map(({ _id, ownerId: _ownerId, itemId, ...item }) => ({ id: itemId, ...item }));
}

export async function toggleFavorite({ ownerId, id, title, kind }) {
  if (!ownerId || !id) throw new Error('Account owner and item ID are required');
  const collection = await favoritesCollection();
  const key = { ownerId: String(ownerId), itemId: String(id) };
  const existing = await collection.findOne(key);
  if (existing) {
    await collection.deleteOne(key);
    return { id, favorite: false };
  }
  const item = { ...key, title: String(title || ''), kind: String(kind || ''), updatedAt: new Date() };
  await collection.insertOne(item);
  return { id, title: item.title, kind: item.kind, favorite: true };
}

export async function moveFavoriteOwners(fromOwnerIds, toOwnerId) {
  const owners = [...new Set((Array.isArray(fromOwnerIds) ? fromOwnerIds : [fromOwnerIds]).map(String).filter(Boolean))];
  if (!toOwnerId || owners.length === 0) return;
  await (await favoritesCollection()).updateMany({ ownerId: { $in: owners } }, { $set: { ownerId: String(toOwnerId) } });
}
