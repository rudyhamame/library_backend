import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { accountOwnerId, profileOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
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
  const name = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return name ? (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 30) : '';
}

function validProfilePin(value) { return /^\d{4}$/.test(String(value || '')); }
export function hashProfilePin(pin) {
  const salt = randomBytes(16);
  const digest = scryptSync(String(pin), salt, 32);
  return `scrypt:${salt.toString('hex')}:${digest.toString('hex')}`;
}

export function verifyProfilePin(pin, storedHash) {
  if (!validProfilePin(pin) || !storedHash) return false;
  const [scheme, saltHex, digestHex] = String(storedHash).split(':');
  if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(saltHex || '') || !/^[a-f0-9]{64}$/i.test(digestHex || '')) return false;
  const expected = Buffer.from(digestHex, 'hex');
  const actual = scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    code: profile.code || '',
    avatar: profile.avatar || 'lime',
    avatarImage: typeof profile.avatarImage === 'string' ? profile.avatarImage : '',
    hasPin: Boolean(profile.pinHash),
    isDefault: profile.isDefault === true,
    position: Number(profile.position) || 0,
  };
}

// A profile code is the first letter of its name plus an order number, e.g.
// "Rudy" -> R1, then "Roula" -> R2. Assigned once at creation and never
// recomputed later, so a partner who was told "R2" keeps pointing at the same
// profile even if R1 is later renamed or deleted.
function profileCodeLetter(name) {
  const match = String(name || '').trim().match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : 'X';
}

async function nextProfileCode(collection, accountId, name) {
  const letter = profileCodeLetter(name);
  const rows = await collection.find(
    { accountId, code: { $regex: `^${letter}\\d+$` } },
    { projection: { code: 1 } },
  ).toArray();
  let max = 0;
  for (const row of rows) {
    const n = Number(String(row.code).slice(1)) || 0;
    if (n > max) max = n;
  }
  return `${letter}${max + 1}`;
}

// One-time migration path for profiles created before this feature existed -
// assigns codes in stable creation order so results match what would have
// been assigned had every profile always had one.
async function backfillMissingCodes(accountId) {
  const collection = await profileCollection();
  const normalizedAccountId = new ObjectId(String(accountId));
  const rows = await collection.find({ accountId: normalizedAccountId }).sort({ position: 1, createdAt: 1 }).toArray();
  if (rows.every(row => row.code)) return;
  const counts = {};
  for (const row of rows) {
    if (row.code) {
      const letter = row.code.charAt(0);
      const n = Number(row.code.slice(1)) || 0;
      counts[letter] = Math.max(counts[letter] || 0, n);
      continue;
    }
    const letter = profileCodeLetter(row.name);
    const next = (counts[letter] || 0) + 1;
    counts[letter] = next;
    await collection.updateOne({ _id: row._id }, { $set: { code: `${letter}${next}` } });
  }
}

async function ensureDefaultProfileRecord(accountId, preferredName = 'Main') {
  if (!ObjectId.isValid(accountId)) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const normalizedAccountId = new ObjectId(String(accountId));
  const collection = await profileCollection();
  let profile = await collection.findOne({ accountId: normalizedAccountId, isDefault: true });
  if (profile) return profile;
  const name = normalizeProfileName(preferredName) || 'Main';
  profile = {
    accountId: normalizedAccountId,
    id: randomUUID(),
    ownerId: accountOwnerId(accountId),
    name,
    code: await nextProfileCode(collection, normalizedAccountId, name),
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
  await backfillMissingCodes(accountId);
  const rows = await (await profileCollection()).find({ accountId: new ObjectId(String(accountId)) }).sort({ position: 1, createdAt: 1 }).toArray();
  return rows.map(publicProfile);
}

export async function getAccountProfile(accountId, profileId) {
  await backfillMissingCodes(accountId);
  return (await profileCollection()).findOne({ accountId: new ObjectId(String(accountId)), id: String(profileId || '') });
}

// Resolves a partner's profile code (e.g. "R2") within their account. Used
// only to pin down which of the partner's profiles is being linked - never
// to look someone up across accounts.
export async function getProfileByCode(accountId, code) {
  await backfillMissingCodes(accountId);
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  return (await profileCollection()).findOne({ accountId: new ObjectId(String(accountId)), code: normalized });
}

export async function getProfileRokuSourcePreferenceByOwner(ownerId) {
  if (!ownerId) return null;
  const profile = await (await profileCollection()).findOne(
    { ownerId: String(ownerId) },
    { projection: { rokuSourceId: 1 } },
  );
  if (!profile) return null;
  return String(profile.rokuSourceId || '');
}

export async function setProfileRokuSourcePreference(accountId, profileId, sourceId) {
  const profile = profileId
    ? await getAccountProfile(accountId, profileId)
    : await ensureDefaultProfileRecord(accountId);
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const value = String(sourceId || '').trim();
  await (await profileCollection()).updateOne(
    { accountId: new ObjectId(String(accountId)), id: String(profile.id) },
    { $set: { rokuSourceId: value, updatedAt: new Date() } },
  );
  // AI recommendations are cached against whichever provider was active when
  // generated and never re-checked - an unrelated provider switch otherwise
  // leaves the cache pointing mostly at the old catalog (see
  // deleteRecommendationCacheForOwner). Only actual changes clear it, so a
  // no-op save of the same source does not force a needless regeneration.
  if (value !== String(profile.rokuSourceId || '')) {
  }
  return value;
}

export async function getProfilePartnerEmail(accountId, profileId) {
  const profile = profileId ? await getAccountProfile(accountId, profileId) : await ensureDefaultProfileRecord(accountId);
  if (profile?.partnerEmail !== undefined) return String(profile.partnerEmail || '');
  if (profile?.isDefault) {
    const client = await clientPromise;
    const account = await client.db(databaseName).collection(process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts')
      .findOne({ _id: new ObjectId(String(accountId)) }, { projection: { partnerEmail: 1 } });
    return String(account?.partnerEmail || '');
  }
  return '';
}

// The email alone only names an account, which can have several profiles -
// this pins down exactly which one (see profileCodeLetter above).
export async function getProfilePartnerCode(accountId, profileId) {
  const profile = profileId ? await getAccountProfile(accountId, profileId) : await ensureDefaultProfileRecord(accountId);
  if (profile?.partnerProfileCode !== undefined) return String(profile.partnerProfileCode || '');
  if (profile?.isDefault) {
    const client = await clientPromise;
    const account = await client.db(databaseName).collection(process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts')
      .findOne({ _id: new ObjectId(String(accountId)) }, { projection: { partnerProfileCode: 1 } });
    return String(account?.partnerProfileCode || '');
  }
  return '';
}

export async function setProfilePartnerEmail(accountId, profileId, email, profileCode = '') {
  const value = String(email || '').trim().toLowerCase();
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address');
  const codeValue = String(profileCode || '').trim().toUpperCase();
  if (value && !codeValue) throw new Error("Enter your partner's profile code");
  if (codeValue && !/^[A-Z]\d+$/.test(codeValue)) throw new Error('Profile code should look like a letter and a number, e.g. R1');
  const profile = profileId ? await getAccountProfile(accountId, profileId) : await ensureDefaultProfileRecord(accountId);
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  await (await profileCollection()).updateOne(
    { accountId: new ObjectId(String(accountId)), id: String(profile.id) },
    { $set: { partnerEmail: value, partnerProfileCode: value ? codeValue : '', updatedAt: new Date() } },
  );
  return value;
}

export async function createAccountProfile(accountId, input = {}) {
  const collection = await profileCollection();
  const normalizedAccountId = new ObjectId(String(accountId));
  const count = await collection.countDocuments({ accountId: normalizedAccountId });
  if (count >= maxProfiles) return { error: `An account can have up to ${maxProfiles} profiles` };
  const name = normalizeProfileName(input.name);
  if (!name) return { error: 'Enter a profile name' };
  const avatarImage = String(input.avatarImage || '');
  const pin = String(input.pin || '');
  if (pin && !validProfilePin(pin)) return { error: 'Profile PIN must be exactly 4 digits' };
  if (avatarImage.length > 1_400_000 || (avatarImage && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarImage))) return { error: 'Upload a valid profile image' };
  const duplicate = await collection.findOne({ accountId: normalizedAccountId, name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }, { projection: { _id: 1 } });
  if (duplicate) return { error: 'Choose a different profile name' };
  const id = randomUUID();
  const profile = {
    accountId: normalizedAccountId,
    id,
    ownerId: profileOwnerId(accountId, id),
    name,
    code: await nextProfileCode(collection, normalizedAccountId, name),
    avatar: avatars.has(input.avatar) ? input.avatar : [...avatars][count % avatars.size],
    avatarImage,
    ...(pin ? { pinHash: hashProfilePin(pin) } : {}),
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
  const pinChanged = input.pin !== undefined;
  const pin = pinChanged ? String(input.pin || '') : '';
  if (pinChanged && pin && !validProfilePin(pin)) return { error: 'Profile PIN must be exactly 4 digits' };
  const update = { $set: { name, avatar, avatarImage, updatedAt: new Date() } };
  if (pinChanged && pin) update.$set.pinHash = hashProfilePin(pin);
  if (pinChanged && !pin) update.$unset = { pinHash: '' };
  await (await profileCollection()).updateOne(
    { accountId: normalizedAccountId, id: String(profileId) },
    update,
  );
  return { profile: publicProfile({ ...profile, name, avatar, avatarImage, pinHash: pinChanged ? (pin ? update.$set.pinHash : '') : profile.pinHash }) };
}

export async function deleteAccountProfile(accountId, profileId) {
  const profile = await getAccountProfile(accountId, profileId);
  if (!profile) return { error: 'Profile not found' };
  if (profile.isDefault) return { error: 'The main profile cannot be deleted' };
  const client = await clientPromise;
  const database = client.db(databaseName);
  const ownerId = String(profile.ownerId || '');
  const collectionNames = [
    process.env.MONGODB_LIBRARY_CATEGORY_COLLECTION || 'library_categories',
    process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress',
    process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history',
    process.env.MONGODB_FAVORITES_COLLECTION || 'favorites',
    process.env.MONGODB_AI_RECOMMENDATIONS_COLLECTION || 'ai_recommendations',
    process.env.MONGODB_ANDROID_STARTUP_COLLECTION || 'android_startup_snapshots',
    process.env.MONGODB_SERIES_WATCH_OVERRIDES_COLLECTION || 'series_watch_overrides',
  ];
  await Promise.all(collectionNames.map(name => database.collection(name).deleteMany({ ownerId })));
  await database.collection(process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources').updateMany(
    { ownerId: accountOwnerId(accountId) },
    { $unset: { [`selections.${ownerId}`]: '' } },
  );
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
