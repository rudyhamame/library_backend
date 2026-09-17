// One-time migration: the streaming_history collection used to keep one
// permanent document per playback session (unique on {ownerId, sessionId}),
// so every episode/movie/channel ever watched stayed in the collection
// forever. streaming-history-store.js now keeps only the latest document per
// {ownerId, kind}. That new unique index cannot be created while duplicate
// (ownerId, kind) rows still exist, so this script collapses each owner's
// rows down to the single most recent one per kind, drops the old
// {ownerId, sessionId} index, and creates the new {ownerId, kind} index.
//
// Run once, after stopping the backend and before deploying the updated
// streaming-history-store.js:
//   MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/dedupe-streaming-history.js
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error('MONGODB_URI is required');

const client = await new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8_000 }).connect();
try {
  const db = client.db(process.env.MONGODB_DB || 'rh_stream');
  const collection = db.collection(process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history');

  const all = await collection.find({}).sort({ updatedAt: -1, startedAt: -1 }).toArray();
  const seen = new Set();
  const staleIds = [];
  for (const doc of all) {
    const key = `${doc.ownerId}:${doc.kind}`;
    if (seen.has(key)) staleIds.push(doc._id);
    else seen.add(key);
  }

  console.log(`${all.length} total rows, ${seen.size} kept (latest per owner+kind), ${staleIds.length} stale rows to delete.`);
  if (staleIds.length) {
    const result = await collection.deleteMany({ _id: { $in: staleIds } });
    console.log(`Deleted ${result.deletedCount} stale rows.`);
  }

  const indexes = await collection.indexes();
  const oldIndex = indexes.find(index => index.key && index.key.ownerId === 1 && index.key.sessionId === 1);
  if (oldIndex) {
    await collection.dropIndex(oldIndex.name);
    console.log(`Dropped old index ${oldIndex.name}.`);
  }
  const oldSortIndex = indexes.find(index => index.key && index.key.ownerId === 1 && index.key.startedAt === -1 && Object.keys(index.key).length === 2);
  if (oldSortIndex) {
    await collection.dropIndex(oldSortIndex.name);
    console.log(`Dropped old index ${oldSortIndex.name}.`);
  }

  await collection.createIndex({ ownerId: 1, kind: 1 }, { unique: true });
  console.log('Created new unique index on {ownerId, kind}.');
} finally {
  await client.close();
}
