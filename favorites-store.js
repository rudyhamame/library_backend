import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_FAVORITES_COLLECTION || 'favorites';
let collectionPromise;

async function favoritesCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(client => client.db(databaseName).collection(collectionName))
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export async function getFavorites() {
  return (await (await favoritesCollection()).find({}).sort({ updatedAt: -1 }).toArray())
    .map(({ _id, ...item }) => ({ id: _id, ...item }));
}

export async function toggleFavorite({ id, title, kind }) {
  const collection = await favoritesCollection();
  const existing = await collection.findOne({ _id: id });
  if (existing) {
    await collection.deleteOne({ _id: id });
    return { id, favorite: false };
  }
  const item = { _id: id, title: String(title || ''), kind: String(kind || ''), updatedAt: new Date() };
  await collection.insertOne(item);
  return { id, title: item.title, kind: item.kind, favorite: true };
}
