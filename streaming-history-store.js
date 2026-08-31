import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history';
let collectionPromise;

async function streamingHistoryCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async (client) => {
        const collection = client.db(databaseName).collection(collectionName);
        await collection.createIndex({ ownerId: 1, sessionId: 1 }, { unique: true });
        await collection.createIndex({ ownerId: 1, startedAt: -1 });
        return collection;
      })
      .catch((error) => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

const milliseconds = value => Math.max(0, Math.round(Number(value) || 0));
const streamingKind = (value) => {
  const kind = String(value || '').toLowerCase();
  if (kind === 'channel' || kind === 'live') return 'channel';
  if (kind === 'series' || kind === 'episode') return 'series';
  return 'movie';
};

export async function saveStreamingHistory({ ownerId, sessionId, itemId, title, kind, sourceId, startedAt, endedAt, startPositionMs, endPositionMs, streamingDurationMs }) {
  if (!ownerId || !sessionId) throw new Error('Account owner and streaming session ID are required');
  const now = new Date();
  const startDate = startedAt ? new Date(startedAt) : now;
  const endDate = endedAt ? new Date(endedAt) : null;
  const update = {
    itemId: String(itemId || ''),
    title: String(title || ''),
    kind: streamingKind(kind),
    sourceId: String(sourceId || ''),
    startPositionMs: milliseconds(startPositionMs),
    endPositionMs: milliseconds(endPositionMs),
    streamingDurationMs: milliseconds(streamingDurationMs),
    startedAt: Number.isNaN(startDate.getTime()) ? now : startDate,
    updatedAt: now,
  };
  if (endDate && !Number.isNaN(endDate.getTime())) update.endedAt = endDate;
  await (await streamingHistoryCollection()).updateOne(
    { ownerId: String(ownerId), sessionId: String(sessionId) },
    { $set: update, $setOnInsert: { ownerId: String(ownerId), sessionId: String(sessionId), createdAt: now } },
    { upsert: true },
  );
  return getStreamingSession(ownerId, sessionId);
}

export async function getStreamingSession(ownerId, sessionId) {
  const item = await (await streamingHistoryCollection()).findOne({ ownerId: String(ownerId), sessionId: String(sessionId) });
  if (!item) return null;
  const { _id, ownerId: _ownerId, ...publicItem } = item;
  return publicItem;
}

export async function getStreamingHistory(ownerId, limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
  return (await (await streamingHistoryCollection()).find({ ownerId: String(ownerId) }).sort({ startedAt: -1 }).limit(safeLimit).toArray())
    .map(({ _id, ownerId: _ownerId, ...item }) => item);
}

export async function moveStreamingHistoryOwners(fromOwnerIds, toOwnerId) {
  const owners = [...new Set((Array.isArray(fromOwnerIds) ? fromOwnerIds : [fromOwnerIds]).map(String).filter(Boolean))];
  if (!toOwnerId || owners.length === 0) return;
  await (await streamingHistoryCollection()).updateMany(
    { ownerId: { $in: owners } },
    { $set: { ownerId: String(toOwnerId), updatedAt: new Date() } },
  );
}
