import { MongoClient } from 'mongodb';
import { getSeriesWatchOverridesByOwner } from './series-watch-overrides.js';

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

export async function saveStreamingHistory({ ownerId, sessionId, itemId, title, kind, sourceId, seriesId, extension, poster, startedAt, endedAt, startPositionMs, endPositionMs, streamingDurationMs, mediaDurationMs, completed }) {
  if (!ownerId || !sessionId) throw new Error('Account owner and streaming session ID are required');
  const now = new Date();
  const startDate = startedAt ? new Date(startedAt) : now;
  const endDate = endedAt ? new Date(endedAt) : null;
  const update = {
    itemId: String(itemId || ''),
    title: String(title || ''),
    kind: streamingKind(kind),
    sourceId: String(sourceId || ''),
    seriesId: String(seriesId || ''),
    extension: String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase(),
    poster: String(poster || ''),
    startPositionMs: milliseconds(startPositionMs),
    endPositionMs: milliseconds(endPositionMs),
    streamingDurationMs: milliseconds(streamingDurationMs),
    mediaDurationMs: milliseconds(mediaDurationMs),
    updatedAt: now,
  };
  const isCompleted = completed === true || String(completed).toLowerCase() === 'true';
  if (isCompleted) update.completed = true;
  if (startedAt) update.startedAt = Number.isNaN(startDate.getTime()) ? now : startDate;
  if (endDate && !Number.isNaN(endDate.getTime())) update.endedAt = endDate;
  const insert = { ownerId: String(ownerId), sessionId: String(sessionId), createdAt: now };
  if (!isCompleted) insert.completed = false;
  if (!startedAt) insert.startedAt = now;
  await (await streamingHistoryCollection()).updateOne(
    { ownerId: String(ownerId), sessionId: String(sessionId) },
    { $set: update, $setOnInsert: insert },
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

export async function getStreamingResume(ownerId, { sourceId, itemId, kind }) {
  if (!ownerId || !sourceId || !itemId) return null;
  const item = await (await streamingHistoryCollection()).findOne(
    {
      ownerId: String(ownerId),
      sourceId: String(sourceId),
      itemId: String(itemId),
      kind: streamingKind(kind),
    },
    { sort: { startedAt: -1, updatedAt: -1 } },
  );
  if (!item) return null;
  const { _id, ownerId: _ownerId, ...publicItem } = item;
  return publicItem;
}

export async function getStreamingContinueWatching(ownerId, limit = 20) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const [history, overrides] = await Promise.all([
    getStreamingHistory(ownerId, 500),
    getSeriesWatchOverridesByOwner(ownerId).catch(() => []),
  ]);
  const overrideBySeries = new Map(overrides.map(entry => [`${entry.sourceId}:${entry.seriesId}`, entry]));
  const latestByItem = new Map();
  for (const item of history) {
    if (!item.sourceId || !item.itemId) continue;
    const key = `${item.sourceId}:${item.kind}:${item.itemId}`;
    if (!latestByItem.has(key)) latestByItem.set(key, item);
  }
  const filtered = [...latestByItem.values()]
    .filter((item) => {
      if (milliseconds(item.endPositionMs) <= 5000) return false;
      // Live channels have no completion or run time - the most recent one
      // watched always belongs in Continue Watching.
      if (item.kind === 'channel') return true;
      if (item.completed === true) return false;
      const duration = milliseconds(item.mediaDurationMs);
      return duration <= 0 || milliseconds(item.endPositionMs) < Math.max(duration - 30000, duration * 0.95);
    });
  // A manually-marked "last watched" episode ('*' on Roku) overrides whichever
  // episode of that series would otherwise show here, and collapses multiple
  // recently-watched episodes of the same series down to that one row.
  const merged = [];
  const seenSeries = new Set();
  for (const item of filtered) {
    if (item.kind === 'series' && item.seriesId) {
      const seriesKey = `${item.sourceId}:${item.seriesId}`;
      if (seenSeries.has(seriesKey)) continue;
      seenSeries.add(seriesKey);
      const override = overrideBySeries.get(seriesKey);
      if (override) {
        merged.push({
          ...item,
          itemId: override.episodeId,
          title: override.episodeTitle || item.title,
          seasonNumber: override.seasonNumber || 0,
          episodeNumber: override.episodeNumber || 0,
          watchOverride: true,
        });
        continue;
      }
    }
    merged.push(item);
  }
  return merged.slice(0, safeLimit);
}

export async function moveStreamingHistoryOwners(fromOwnerIds, toOwnerId) {
  const owners = [...new Set((Array.isArray(fromOwnerIds) ? fromOwnerIds : [fromOwnerIds]).map(String).filter(Boolean))];
  if (!toOwnerId || owners.length === 0) return;
  await (await streamingHistoryCollection()).updateMany(
    { ownerId: { $in: owners } },
    { $set: { ownerId: String(toOwnerId), updatedAt: new Date() } },
  );
}
