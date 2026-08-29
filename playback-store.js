import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress';
let collectionPromise;
let client;

async function playbackCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      return client.db(databaseName).collection(collectionName);
    })().catch((error) => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export async function getPlayback(itemId) {
  return (await (await playbackCollection()).findOne({ _id: itemId })) || null;
}

export async function savePlayback({ itemId, title, kind, poster, source, url, position, duration, completed = false }) {
  const collection = await playbackCollection();
  const now = new Date();
  await collection.updateOne(
    { _id: itemId },
    { $set: { title: String(title || ''), kind: String(kind || ''), poster: String(poster || ''), source: String(source || ''), url: String(url || ''), position: Math.max(0, Number(position) || 0), duration: Math.max(0, Number(duration) || 0), completed: Boolean(completed), updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  return getPlayback(itemId);
}

export async function getPlaybackHistory(limit = 20) {
  return (await (await playbackCollection()).find({}).sort({ updatedAt: -1 }).limit(limit).toArray()).map(({ _id, ...item }) => ({ itemId: _id, ...item }));
}
