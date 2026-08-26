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

export async function getXtreamSources() {
  const sources = await (await sourceCollection()).find({}).sort({ name: 1, updatedAt: -1 }).toArray();
  return sources.map(publicXtreamSource);
}

export async function getXtreamSource(id) {
  return (await sourceCollection()).findOne({ _id: id });
}

export async function getAllXtreamSources() {
  return (await sourceCollection()).find({}).sort({ name: 1, updatedAt: -1 }).toArray();
}

export async function createXtreamSource({ name, baseUrl, username, password }) {
  const source = {
    _id: randomUUID(), name, baseUrl, username, password,
    enabledKeys: [], enabledItems: [], archivedKeys: [], archivedItems: [], createdAt: new Date(), updatedAt: new Date(),
  };
  await (await sourceCollection()).insertOne(source);
  return publicXtreamSource(source);
}

export async function updateXtreamSource(id, changes) {
  const result = await (await sourceCollection()).findOneAndUpdate(
    { _id: id },
    { $set: { ...changes, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return publicXtreamSource(result?.value || result);
}

export async function updateXtreamSelection(id, enabledKeys, enabledItems = []) {
  return updateXtreamSource(id, {
    enabledKeys: [...new Set(enabledKeys.map(String))],
    enabledItems,
  });
}

export async function deleteXtreamSource(id) {
  const result = await (await sourceCollection()).deleteOne({ _id: id });
  return result.deletedCount === 1;
}
