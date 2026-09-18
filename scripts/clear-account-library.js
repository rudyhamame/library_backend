import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error('MONGODB_URI is required');

const client = await new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8_000 }).connect();
try {
  const db = client.db(process.env.MONGODB_DB || 'rh_roku');
  const accounts = db.collection(process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts');
  const sources = db.collection(process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources');

  const email = String(process.env.ACCOUNT_EMAIL || '').trim().toLowerCase();
  let account;
  if (email) {
    account = await accounts.findOne({ email }, { projection: { _id: 1, metadata: 1 } });
  } else {
    const candidates = await accounts.find({}, { projection: { _id: 1, metadata: 1 } }).limit(2).toArray();
    if (candidates.length !== 1) throw new Error('Set ACCOUNT_EMAIL unless the database contains exactly one account');
    [account] = candidates;
  }
  if (!account) throw new Error('Account not found');

  const canonicalOwnerId = createHash('sha256').update(`account:${account._id}`).digest('hex');
  const linkedProfiles = Array.isArray(account.metadata?.devices) ? account.metadata.devices : [];
  const priorOwnerIds = [...new Set(linkedProfiles.map(profile => profile.ownerId).filter(Boolean))];
  if (priorOwnerIds.length) {
    await sources.updateMany(
      { ownerId: { $in: priorOwnerIds } },
      { $set: { ownerId: canonicalOwnerId, updatedAt: new Date() } },
    );
  }
  const cleared = await sources.updateMany(
    { ownerId: canonicalOwnerId },
    { $set: { enabledKeys: [], enabledItems: [], archivedKeys: [], archivedItems: [], updatedAt: new Date() } },
  );
  await accounts.updateOne({ _id: account._id }, { $set: { 'profiles.$[].library.categories': [], 'profiles.$[].library.assignments': [], updatedAt: new Date() } });

  const remaining = await sources.countDocuments({
    ownerId: canonicalOwnerId,
    $or: [
      { 'enabledKeys.0': { $exists: true } },
      { 'enabledItems.0': { $exists: true } },
      { 'archivedKeys.0': { $exists: true } },
      { 'archivedItems.0': { $exists: true } },
    ],
  });
  if (remaining !== 0) throw new Error('Library clear verification failed');
  console.log(JSON.stringify({ accountLibraries: 1, playlistSourcesRetained: cleared.matchedCount, selectedItems: 0, archivedItems: 0 }));
} finally {
  await client.close();
}
