import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources';
let collectionPromise;

async function sourceCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(client => client.db(databaseName).collection(collectionName))
      .catch(error => {
        collectionPromise = undefined;
        throw error;
      });
  }
  return collectionPromise;
}

export function publicXtreamSource(source) {
  if (!source) return null;
  return {
    id: source._id,
    name: source.name,
    endpoint: source.baseUrl,
    hasCredentials: Boolean(source.username && source.password),
    enabledKeys: Array.isArray(source.enabledKeys) ? source.enabledKeys : [],
    enabledItems: Array.isArray(source.enabledItems) ? source.enabledItems : [],
    archivedKeys: Array.isArray(source.archivedKeys) ? source.archivedKeys : [],
    archivedItems: Array.isArray(source.archivedItems) ? source.archivedItems : [],
    selectedCount: Array.isArray(source.enabledKeys) ? source.enabledKeys.length : 0,
    archivedCount: Array.isArray(source.archivedKeys) ? source.archivedKeys.length : 0,
    updatedAt: source.updatedAt,
  };
}

export async function getXtreamSources(ownerId) {
  const filter = ownerId ? { ownerId } : {};
  const sources = await (await sourceCollection()).find(filter).sort({ name: 1, updatedAt: -1 }).toArray();
  return sources.map(publicXtreamSource);
}

export async function getXtreamSource(id, ownerId) {
  return (await sourceCollection()).findOne({ _id: id, ...(ownerId ? { ownerId } : {}) });
}

export async function getAllXtreamSources(ownerId) {
  return (await sourceCollection()).find(ownerId ? { ownerId } : {}).sort({ name: 1, updatedAt: -1 }).toArray();
}

export async function createXtreamSource({ name, baseUrl, username, password, ownerId }) {
  const source = {
    _id: randomUUID(), name, baseUrl, username, password, ownerId,
    enabledKeys: [], enabledItems: [], archivedKeys: [], archivedItems: [], createdAt: new Date(), updatedAt: new Date(),
  };
  await (await sourceCollection()).insertOne(source);
  return publicXtreamSource(source);
}

export async function updateXtreamSource(id, changes, ownerId) {
  const result = await (await sourceCollection()).findOneAndUpdate(
    { _id: id, ...(ownerId ? { ownerId } : {}) },
    { $set: { ...changes, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return publicXtreamSource(result?.value || result);
}

export async function updateXtreamSelection(id, enabledKeys, enabledItems = [], ownerId) {
  return updateXtreamSource(id, {
    enabledKeys: [...new Set(enabledKeys.map(String))],
    enabledItems,
  }, ownerId);
}

export async function deleteXtreamSource(id, ownerId) {
  const result = await (await sourceCollection()).deleteOne({ _id: id, ...(ownerId ? { ownerId } : {}) });
  return result.deletedCount === 1;
}
