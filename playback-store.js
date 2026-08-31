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
      const collection = client.db(databaseName).collection(collectionName);
      await collection.createIndex({ ownerId: 1, itemId: 1 }, { unique: true });
      await collection.createIndex({ ownerId: 1, updatedAt: -1 });
      return collection;
    })().catch((error) => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export async function getPlayback(ownerId, itemId) {
  if (!ownerId || !itemId) return null;
  const item = await (await playbackCollection()).findOne({ ownerId: String(ownerId), itemId: String(itemId) });
  if (!item) return null;
  const { _id, ownerId: _ownerId, ...publicItem } = item;
  return publicItem;
}

export async function savePlayback({ ownerId, itemId, title, kind, poster, source, url, position, duration, completed = false }) {
  if (!ownerId || !itemId) throw new Error('Account owner and item ID are required');
  const collection = await playbackCollection();
  const now = new Date();
  await collection.updateOne(
    { ownerId: String(ownerId), itemId: String(itemId) },
    { $set: { title: String(title || ''), kind: String(kind || ''), poster: String(poster || ''), source: String(source || ''), url: String(url || ''), position: Math.max(0, Number(position) || 0), duration: Math.max(0, Number(duration) || 0), completed: Boolean(completed), updatedAt: now }, $setOnInsert: { ownerId: String(ownerId), itemId: String(itemId), createdAt: now } },
    { upsert: true },
  );
  return getPlayback(ownerId, itemId);
}

export async function getPlaybackHistory(ownerId, limit = 20) {
  if (!ownerId) return [];
  return (await (await playbackCollection()).find({ ownerId: String(ownerId) }).sort({ updatedAt: -1 }).limit(limit).toArray())
    .map(({ _id, ownerId: _ownerId, ...item }) => item);
}

export async function movePlaybackOwners(fromOwnerIds, toOwnerId) {
  const owners = [...new Set((Array.isArray(fromOwnerIds) ? fromOwnerIds : [fromOwnerIds]).map(String).filter(Boolean))];
  if (!toOwnerId || owners.length === 0) return;
  await (await playbackCollection()).updateMany({ ownerId: { $in: owners } }, { $set: { ownerId: String(toOwnerId) } });
}
