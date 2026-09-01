import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_ANDROID_STARTUP_COLLECTION || 'android_startup_snapshots';
let collectionPromise;

async function collection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const value = client.db(databaseName).collection(collectionName);
        await value.createIndex({ ownerId: 1 }, { unique: true });
        return value;
      })
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export async function getAndroidStartupSnapshot(ownerId) {
  if (!ownerId) return null;
  return (await collection()).findOne({ ownerId: String(ownerId) });
}

export async function saveAndroidStartupSnapshot(ownerId, payload) {
  if (!ownerId) return null;
  const updatedAt = new Date();
  await (await collection()).updateOne(
    { ownerId: String(ownerId) },
    { $set: { ownerId: String(ownerId), ...payload, updatedAt }, $setOnInsert: { createdAt: updatedAt } },
    { upsert: true },
  );
  return { ...payload, updatedAt };
}
