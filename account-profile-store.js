import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { accountOwnerId, profileOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_ACCOUNT_PROFILE_COLLECTION || 'account_profiles';
const maxProfiles = Math.max(2, Math.min(8, Number.parseInt(process.env.MAX_ACCOUNT_PROFILES || '5', 10) || 5));
const avatars = new Set(['lime', 'teal', 'amber', 'violet', 'rose', 'blue']);
let collectionPromise;
let clientPromise;

async function profileCollection() {
  if (!collectionPromise) {
    clientPromise = clientPromise || new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect();
    collectionPromise = clientPromise
      .then(async client => {
        const collection = client.db(databaseName).collection(collectionName);
        await Promise.all([
          collection.createIndex({ accountId: 1, id: 1 }, { unique: true }),
          collection.createIndex({ accountId: 1, position: 1 }),
          collection.createIndex({ accountId: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } }),
        ]);
        return collection;
      })
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export function normalizeProfileName(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 30);
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar || 'lime',
    avatarImage: typeof profile.avatarImage === 'string' ? profile.avatarImage : '',
    isDefault: profile.isDefault === true,
    position: Number(profile.position) || 0,
  };
}

async function ensureDefaultProfileRecord(accountId, preferredName = 'Main') {
  if (!ObjectId.isValid(accountId)) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const normalizedAccountId = new ObjectId(String(accountId));
  const collection = await profileCollection();
  let profile = await collection.findOne({ accountId: normalizedAccountId, isDefault: true });
  if (profile) return profile;
  profile = {
    accountId: normalizedAccountId,
    id: randomUUID(),
    ownerId: accountOwnerId(accountId),
    name: normalizeProfileName(preferredName) || 'Main',
    avatar: 'lime',
    isDefault: true,
    position: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  try { await collection.insertOne(profile); }
  catch (error) {
    if (error?.code !== 11000) throw error;
    profile = await collection.findOne({ accountId: normalizedAccountId, isDefault: true });
  }
  return profile;
}

export async function getAccountProfiles(accountId) {
  await ensureDefaultProfile(accountId);
  const rows = await (await profileCollection()).find({ accountId: new ObjectId(String(accountId)) }).sort({ position: 1, createdAt: 1 }).toArray();
  return rows.map(publicProfile);
}

export async function getAccountProfile(accountId, profileId) {
  await ensureDefaultProfile(accountId);
  return (await profileCollection()).findOne({ accountId: new ObjectId(String(accountId)), id: String(profileId || '') });
}

export async function createAccountProfile(accountId, input = {}) {
  await ensureDefaultProfile(accountId);
  const collection = await profileCollection();
  const normalizedAccountId = new ObjectId(String(accountId));
  const count = await collection.countDocuments({ accountId: normalizedAccountId });
  if (count >= maxProfiles) return { error: `An account can have up to ${maxProfiles} profiles` };
  const name = normalizeProfileName(input.name);
  if (!name) return { error: 'Enter a profile name' };
  const avatarImage = String(input.avatarImage || '');
  if (avatarImage.length > 1_400_000 || (avatarImage && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarImage))) return { error: 'Upload a valid profile image' };
  const duplicate = await collection.findOne({ accountId: normalizedAccountId, name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }, { projection: { _id: 1 } });
  if (duplicate) return { error: 'Choose a different profile name' };
  const id = randomUUID();
  const profile = {
    accountId: normalizedAccountId,
    id,
    ownerId: profileOwnerId(accountId, id),
    name,
    avatar: avatars.has(input.avatar) ? input.avatar : [...avatars][count % avatars.size],
    avatarImage,
    isDefault: false,
    position: count,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await collection.insertOne(profile);
  return { profile: publicProfile(profile) };
}

export async function updateAccountProfile(accountId, profileId, input = {}) {
  const profile = await getAccountProfile(accountId, profileId);
  if (!profile) return { error: 'Profile not found' };
  const name = input.name === undefined ? profile.name : normalizeProfileName(input.name);
  if (!name) return { error: 'Enter a profile name' };
  const normalizedAccountId = new ObjectId(String(accountId));
  const duplicate = await (await profileCollection()).findOne({ accountId: normalizedAccountId, id: { $ne: String(profileId) }, name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }, { projection: { _id: 1 } });
  if (duplicate) return { error: 'Choose a different profile name' };
  const avatar = avatars.has(input.avatar) ? input.avatar : profile.avatar || 'lime';
  const avatarImage = input.avatarImage === undefined ? (profile.avatarImage || '') : String(input.avatarImage || '');
  if (avatarImage.length > 1_400_000 || (avatarImage && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarImage))) return { error: 'Upload a valid profile image' };
  await (await profileCollection()).updateOne(
    { accountId: normalizedAccountId, id: String(profileId) },
    { $set: { name, avatar, avatarImage, updatedAt: new Date() } },
  );
  return { profile: publicProfile({ ...profile, name, avatar, avatarImage }) };
}

export async function deleteAccountProfile(accountId, profileId) {
  const profile = await getAccountProfile(accountId, profileId);
  if (!profile) return { error: 'Profile not found' };
  if (profile.isDefault) return { error: 'The main profile cannot be deleted' };
  const client = await clientPromise;
  const database = client.db(databaseName);
  const ownerId = String(profile.ownerId || '');
  const collectionNames = [
    process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources',
    process.env.MONGODB_LIBRARY_CATEGORY_COLLECTION || 'library_categories',
    process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress',
    process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history',
    process.env.MONGODB_FAVORITES_COLLECTION || 'favorites',
    process.env.MONGODB_AI_RECOMMENDATIONS_COLLECTION || 'ai_recommendations',
    process.env.MONGODB_ANDROID_STARTUP_COLLECTION || 'android_startup_snapshots',
    process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items',
    process.env.MONGODB_PROVIDER_CATALOG_SYNC_COLLECTION || 'provider_catalog_syncs',
  ];
  await Promise.all(collectionNames.map(name => database.collection(name).deleteMany({ ownerId })));
  await database.collection(process.env.MONGODB_DEVICE_COLLECTION || 'device_profiles').updateMany(
    { accountId: new ObjectId(String(accountId)), profileId: String(profileId) },
    { $unset: { accountId: '', profileId: '' }, $set: { updatedAt: new Date() } },
  );
  await (await profileCollection()).deleteOne({ accountId: new ObjectId(String(accountId)), id: String(profileId) });
  return { ok: true };
}

export async function deleteAccountProfilesAndData(accountId) {
  if (!ObjectId.isValid(accountId)) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const normalizedAccountId = new ObjectId(String(accountId));
  const collection = await profileCollection();
  const rows = await collection.find({ accountId: normalizedAccountId }, { projection: { ownerId: 1 } }).toArray();
  const ownerIds = [...new Set([accountOwnerId(accountId), ...rows.map(row => String(row.ownerId || '')).filter(Boolean)])];
  const client = await clientPromise;
  const database = client.db(databaseName);
  const ownedCollections = [
    process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources',
    process.env.MONGODB_LIBRARY_CATEGORY_COLLECTION || 'library_categories',
    process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress',
    process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history',
    process.env.MONGODB_FAVORITES_COLLECTION || 'favorites',
    process.env.MONGODB_AI_RECOMMENDATIONS_COLLECTION || 'ai_recommendations',
    process.env.MONGODB_ANDROID_STARTUP_COLLECTION || 'android_startup_snapshots',
    process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items',
    process.env.MONGODB_PROVIDER_CATALOG_SYNC_COLLECTION || 'provider_catalog_syncs',
  ];
  await Promise.all(ownedCollections.map(name => database.collection(name).deleteMany({ ownerId: { $in: ownerIds } })));
  await database.collection(process.env.MONGODB_DEVICE_COLLECTION || 'device_profiles').updateMany(
    { accountId: normalizedAccountId },
    { $unset: { accountId: '', accountOwnerId: '', profileId: '' }, $set: { updatedAt: new Date() } },
  );
  await collection.deleteMany({ accountId: normalizedAccountId });
  return { ownerIds };
}

export async function ensureDefaultProfile(accountId, preferredName = 'Main') {
  return ensureDefaultProfileRecord(accountId, preferredName);
}

export { maxProfiles as MAX_ACCOUNT_PROFILES };
