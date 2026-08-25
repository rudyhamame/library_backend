import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_IPTV_COLLECTION || 'iptv_sources';
let client;
let collectionPromise;

async function sourceCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      return client.db(databaseName).collection(collectionName);
    })().catch((error) => {
      collectionPromise = undefined;
      throw error;
    });
  }
  return collectionPromise;
}

function publicSource(source) {
  return { id: source._id, name: source.name, url: source.url, updatedAt: source.updatedAt };
}

export async function getIptvSources() {
  const collection = await sourceCollection();
  return (await collection.find({}).sort({ name: 1, updatedAt: -1 }).toArray()).map(publicSource);
}

export async function createIptvSource(name, url) {
  const collection = await sourceCollection();
  const source = { _id: randomUUID(), name, url, createdAt: new Date(), updatedAt: new Date() };
  await collection.insertOne(source);
  return publicSource(source);
}

export async function updateIptvSource(id, name, url) {
  const collection = await sourceCollection();
  const result = await collection.findOneAndUpdate(
    { _id: id },
    { $set: { name, url, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return result.value ? publicSource(result.value) : null;
}

export async function deleteIptvSource(id) {
  const collection = await sourceCollection();
  const result = await collection.deleteOne({ _id: id });
  return result.deletedCount === 1;
}

export async function getIptvSource(id) {
  const source = await (await sourceCollection()).findOne({ _id: id });
  return source ? publicSource(source) : null;
}
