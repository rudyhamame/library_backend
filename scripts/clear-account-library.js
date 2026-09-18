import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error('MONGODB_URI is required');

const client = await new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8_000 }).connect();
try {
  const db = client.db(process.env.MONGODB_DB || 'rh_roku');
  const accounts = db.collection(process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts');

  const email = String(process.env.ACCOUNT_EMAIL || '').trim().toLowerCase();
  let account;
  if (email) {
    account = await accounts.findOne({ email }, { projection: { _id: 1, devices: 1 } });
  } else {
    const candidates = await accounts.find({}, { projection: { _id: 1, devices: 1 } }).limit(2).toArray();
    if (candidates.length !== 1) throw new Error('Set ACCOUNT_EMAIL unless the database contains exactly one account');
    [account] = candidates;
  }
  if (!account) throw new Error('Account not found');

  const canonicalOwnerId = createHash('sha256').update(`account:${account._id}`).digest('hex');
  const linkedProfiles = Array.isArray(account.devices) ? account.devices : [];
  const priorOwnerIds = [...new Set(linkedProfiles.map(profile => profile.ownerId).filter(Boolean))];
  await accounts.updateOne({ _id: account._id }, { $set: {
    'profiles.$[].library.categories': [], 'profiles.$[].library.assignments': [],
    'profiles.$[].library.favorites': [],
    'profiles.$[].library.savedSelections': {}, updatedAt: new Date(),
  } });
  console.log(JSON.stringify({ accountLibraries: 1, providersRetained: Array.isArray(account.providers) ? account.providers.length : 0, selectedItems: 0, archivedItems: 0 }));
} finally {
  await client.close();
}
