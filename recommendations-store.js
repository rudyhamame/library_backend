import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_AI_RECOMMENDATIONS_COLLECTION || 'ai_recommendations';
let collectionPromise;

async function collection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const value = client.db(databaseName).collection(collectionName);
        await Promise.all([
          value.createIndex({ key: 1 }, { unique: true }),
          value.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
          value.createIndex({ ownerId: 1, language: 1, createdAt: -1 }),
        ]);
        return value;
      })
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export async function getRecommendationCache(key) {
  if (!key) return null;
  return (await collection()).findOne({ key: String(key), expiresAt: { $gt: new Date() } });
}

export async function getLatestRecommendationCache(ownerId, language) {
  if (!ownerId) return null;
  return (await collection()).findOne(
    { ownerId: String(ownerId), language: String(language || 'both'), expiresAt: { $gt: new Date() } },
    { sort: { createdAt: -1 } },
  );
}

export async function saveRecommendationCache(entry) {
  const now = new Date();
  await (await collection()).updateOne(
    { key: String(entry.key) },
    { $set: { ...entry, key: String(entry.key), createdAt: now, updatedAt: now } },
    { upsert: true },
  );
  return entry;
}
