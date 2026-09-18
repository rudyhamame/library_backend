import { MongoClient, ObjectId } from 'mongodb';
import { accountOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';
let clientPromise;

async function accountCollections() {
  if (!clientPromise) clientPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect().catch(error => { clientPromise = undefined; throw error; });
  const client = await clientPromise;
  return [client.db(rokuDb).collection('identity'), client.db(generalDb).collection(process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts')];
}

export async function allAccountDocuments() {
  const rows = [];
  for (const collection of await accountCollections()) {
    for (const account of await collection.find({}).toArray()) rows.push({ collection, account });
  }
  return rows;
}

export function normalizedAccountLibrary(library) {
  return {
    categories: Array.isArray(library?.categories) ? library.categories : [],
    assignments: Array.isArray(library?.assignments) ? library.assignments : [],
    favorites: Array.isArray(library?.favorites) ? library.favorites : [],
    savedSelections: library?.savedSelections && typeof library.savedSelections === 'object' ? library.savedSelections : {},
    series_last_watched: library?.series_last_watched && typeof library.series_last_watched === 'object' && !Array.isArray(library.series_last_watched)
      ? library.series_last_watched : {},
    last_kinds_watched: {
      episode: library?.last_kinds_watched?.episode || library?.lastKindsWatched?.episode || null,
      movie: library?.last_kinds_watched?.movie || library?.lastKindsWatched?.movie || null,
      live: library?.last_kinds_watched?.live || library?.lastKindsWatched?.live || null,
    },
  };
}

export async function accountForLibraryOwner(ownerId) {
  const key = String(ownerId || '');
  if (!key) throw new Error('Account library owner is required');
  for (const collection of await accountCollections()) {
    const account = await collection.findOne({ $or: [{ ownerId: key }, { 'profiles.ownerId': key }] });
    if (account) return { collection, account };
  }
  // Pre-migration accounts may not have an ownerId field yet. Resolve only
  // when their deterministic account owner matches; never choose another user.
  for (const collection of await accountCollections()) {
    const rows = await collection.find({}, { projection: { _id: 1 } }).toArray();
    const match = rows.find(row => accountOwnerId(row._id) === key);
    if (match) return { collection, account: await collection.findOne({ _id: match._id }) };
  }
  throw Object.assign(new Error('Account library not found'), { status: 404 });
}

function selectedProfile(account, ownerId, profileId = '') {
  const profiles = Array.isArray(account.profiles) ? account.profiles : [];
  if (profileId) return profiles.find(row => row.id === String(profileId));
  if (String(ownerId) === accountOwnerId(account._id)) return profiles.find(row => row.isDefault === true);
  return profiles.find(row => row.ownerId === String(ownerId));
}

export async function getAccountLibrary(ownerId, profileId = '') {
  const { account } = await accountForLibraryOwner(ownerId);
  const profile = selectedProfile(account, ownerId, profileId);
  if (!profile) throw Object.assign(new Error('Profile library not found'), { status: 404 });
  return normalizedAccountLibrary(profile.library);
}

export async function updateAccountLibrary(ownerId, change, profileId = '') {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { collection, account } = await accountForLibraryOwner(ownerId);
    const profile = selectedProfile(account, ownerId, profileId);
    if (!profile) throw Object.assign(new Error('Profile library not found'), { status: 404 });
    const before = normalizedAccountLibrary(profile.library);
    const next = await change(structuredClone(before));
    if (!next) return { library: before, changed: false };
    const filter = { _id: account._id, profiles: { $elemMatch: { id: profile.id, library: profile.library === undefined ? { $exists: false } : profile.library } } };
    const result = await collection.updateOne(filter, { $set: { 'profiles.$.library': normalizedAccountLibrary(next), 'profiles.$.updatedAt': new Date(), updatedAt: new Date() } });
    if (result.modifiedCount) return { library: normalizedAccountLibrary(next), changed: true };
  }
  throw new Error('Account library changed concurrently. Please try again.');
}

export async function closeAccountLibraryData() {
  if (clientPromise) await (await clientPromise).close();
  clientPromise = undefined;
}
