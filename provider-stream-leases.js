import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_PROVIDER_LEASE_COLLECTION || 'provider_stream_leases';
const leaseTtlMs = 30_000;
let collectionPromise;

async function leaseCollection() {
  if (!collectionPromise) collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect().then(client => client.db(databaseName).collection(collectionName)).catch(error => { collectionPromise = undefined; throw error; });
  return collectionPromise;
}

export async function acquireProviderStreamLease(sourceId, limit) {
  const sourceKey = String(sourceId);
  const slotLimit = Math.max(1, Math.min(10, Number(limit) || 1));
  const token = randomUUID();
  const collection = await leaseCollection();
  for (let slot = 0; slot < slotLimit; slot += 1) {
    const now = new Date();
    const id = `${sourceKey}:${slot}`;
    try {
      const result = await collection.findOneAndUpdate(
        { _id: id, $or: [{ expiresAt: { $lte: now } }, { token }] },
        { $set: { sourceId: sourceKey, slot, token, expiresAt: new Date(now.getTime() + leaseTtlMs), updatedAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
      const document = result?.value || result;
      if (document?.token !== token) continue;
      let released = false;
      const heartbeat = setInterval(async () => {
        if (released) return;
        await collection.updateOne({ _id: id, token }, { $set: { expiresAt: new Date(Date.now() + leaseTtlMs), updatedAt: new Date() } }).catch(() => {});
      }, leaseTtlMs / 3);
      heartbeat.unref?.();
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        await collection.deleteOne({ _id: id, token }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  return null;
}
