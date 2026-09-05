import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_SERIES_WATCH_OVERRIDE_COLLECTION || 'series_watch_overrides';
let collectionPromise;

async function overridesCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(async client => {
        const collection = client.db(databaseName).collection(collectionName);
        await collection.createIndex({ ownerId: 1, sourceId: 1, seriesId: 1 }, { unique: true });
        return collection;
      })
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

const key = (ownerId, sourceId, seriesId) => ({ ownerId: String(ownerId), sourceId: String(sourceId), seriesId: String(seriesId) });

export async function getSeriesWatchOverride(ownerId, sourceId, seriesId) {
  if (!ownerId || !sourceId || !seriesId) return null;
  const { ownerId: _ownerId, ...doc } = (await (await overridesCollection()).findOne(key(ownerId, sourceId, seriesId))) || {};
  return doc.episodeId ? doc : null;
}

// Star toggle: pressing '*' on the already-marked episode clears the override
// (revert to automatic); pressing it on any other episode sets/replaces it.
export async function toggleSeriesWatchOverride({ ownerId, sourceId, seriesId, episodeId, episodeTitle = '', seasonNumber = 0, episodeNumber = 0 }) {
  if (!ownerId || !sourceId || !seriesId || !episodeId) throw new Error('sourceId, seriesId and episodeId are required');
  const collection = await overridesCollection();
  const filter = key(ownerId, sourceId, seriesId);
  const existing = await collection.findOne(filter);
  if (existing && String(existing.episodeId) === String(episodeId)) {
    await collection.deleteOne(filter);
    return { active: false, episodeId: '' };
  }
  await collection.updateOne(filter, {
    $set: {
      ...filter,
      episodeId: String(episodeId),
      episodeTitle: String(episodeTitle || ''),
      seasonNumber: Number(seasonNumber) || 0,
      episodeNumber: Number(episodeNumber) || 0,
      updatedAt: new Date(),
    },
  }, { upsert: true });
  return { active: true, episodeId: String(episodeId) };
}

export async function getSeriesWatchOverridesByOwner(ownerId) {
  if (!ownerId) return [];
  return (await overridesCollection()).find({ ownerId: String(ownerId) }).toArray();
}

export async function moveSeriesWatchOverrideOwners(fromOwnerIds, toOwnerId) {
  const owners = [...new Set((Array.isArray(fromOwnerIds) ? fromOwnerIds : [fromOwnerIds]).map(String).filter(Boolean))];
  if (!toOwnerId || owners.length === 0) return;
  await (await overridesCollection()).updateMany({ ownerId: { $in: owners } }, { $set: { ownerId: String(toOwnerId) } });
}
