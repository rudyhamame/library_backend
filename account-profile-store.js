import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { accountOwnerId, profileOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_ACCOUNT_PROFILE_COLLECTION || 'account_profiles';
const maxProfiles = Math.max(2, Math.min(8, Number.parseInt(process.env.MAX_ACCOUNT_PROFILES || '5', 10) || 5));
const avatars = new Set(['lime', 'teal', 'amber', 'violet', 'rose', 'blue']);
let collectionPromise;

async function profileCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
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
    isDefault: profile.isDefault === true,
    position: Number(profile.position) || 0,
  };
}

async function ensureDefaultProfile(accountId) {
  if (!ObjectId.isValid(accountId)) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const normalizedAccountId = new ObjectId(String(accountId));
  const collection = await profileCollection();
  let profile = await collection.findOne({ accountId: normalizedAccountId, isDefault: true });
  if (profile) return profile;
  profile = {
    accountId: normalizedAccountId,
    id: randomUUID(),
    ownerId: accountOwnerId(accountId),
    name: 'Main',
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
  const duplicate = await collection.findOne({ accountId: normalizedAccountId, name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }, { projection: { _id: 1 } });
  if (duplicate) return { error: 'Choose a different profile name' };
  const id = randomUUID();
  const profile = {
    accountId: normalizedAccountId,
    id,
    ownerId: profileOwnerId(accountId, id),
    name,
    avatar: avatars.has(input.avatar) ? input.avatar : [...avatars][count % avatars.size],
    isDefault: false,
    position: count,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await collection.insertOne(profile);
  return { profile: publicProfile(profile) };
}

export { maxProfiles as MAX_ACCOUNT_PROFILES };
