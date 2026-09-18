import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { accountOwnerId, profileOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const generalDatabaseName = process.env.MONGODB_GENERAL_DB || 'rh_general';
const maxProfiles = Math.max(2, Math.min(8, Number.parseInt(process.env.MAX_ACCOUNT_PROFILES || '5', 10) || 5));
const avatars = new Set(['lime', 'teal', 'amber', 'violet', 'rose', 'blue']);
let clientPromise;

async function databaseClient() {
  if (!clientPromise) clientPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect().catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}

async function accountRecord(accountId) {
  if (!ObjectId.isValid(accountId)) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const client = await databaseClient();
  const id = new ObjectId(String(accountId));
  for (const [dbName, name] of [[databaseName, 'identity'], [generalDatabaseName, process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts']]) {
    const database = client.db(dbName);
    const collection = database.collection(name);
    const account = await collection.findOne({ _id: id });
    if (account) return { account, collection, database, id };
  }
  throw Object.assign(new Error('Account not found'), { status: 404 });
}

function profilesOf(account) { return Array.isArray(account?.profiles) ? account.profiles : []; }

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
    id: profile.id, name: profile.name, code: profile.code || '',
    avatar: profile.avatar || 'lime',
    avatarImage: typeof profile.avatarImage === 'string' ? profile.avatarImage : '',
    hasPin: Boolean(profile.pinHash), isDefault: profile.isDefault === true,
    position: Number(profile.position) || 0,
  };
}

function profileCodeLetter(name) {
  const match = String(name || '').trim().match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : 'X';
}

function nextProfileCode(rows, name) {
  const letter = profileCodeLetter(name);
  let max = 0;
  for (const row of rows) {
    if (!new RegExp(`^${letter}\\d+$`).test(String(row.code || ''))) continue;
    max = Math.max(max, Number(String(row.code).slice(1)) || 0);
  }
  return `${letter}${max + 1}`;
}

async function backfillMissingCodes(record) {
  const rows = profilesOf(record.account);
  if (rows.every(row => row.code)) return rows;
  const counts = {};
  const updated = rows.map(row => {
    if (row.code) {
      const letter = row.code.charAt(0);
      counts[letter] = Math.max(counts[letter] || 0, Number(row.code.slice(1)) || 0);
      return row;
    }
    const letter = profileCodeLetter(row.name);
    const code = `${letter}${(counts[letter] || 0) + 1}`;
    counts[letter] = Number(code.slice(1));
    return { ...row, code };
  });
  const result = await record.collection.updateOne({ _id: record.id, profiles: rows }, { $set: { profiles: updated, updatedAt: new Date() } });
  if (!result.modifiedCount) return profilesOf(await record.collection.findOne({ _id: record.id }));
  return updated;
}

export async function getAccountProfiles(accountId) {
  const rows = await backfillMissingCodes(await accountRecord(accountId));
  return [...rows].sort((a, b) => (a.position || 0) - (b.position || 0)).map(publicProfile);
}

export async function getAccountProfile(accountId, profileId) {
  const rows = await backfillMissingCodes(await accountRecord(accountId));
  return rows.find(row => row.id === String(profileId || '')) || null;
}

export async function getProfileByCode(accountId, code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const rows = await backfillMissingCodes(await accountRecord(accountId));
  return rows.find(row => row.code === normalized) || null;
}

export async function getProfileRokuSourcePreferenceByOwner(ownerId) {
  if (!ownerId) return null;
  const client = await databaseClient();
  for (const [dbName, name] of [[databaseName, 'identity'], [generalDatabaseName, process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts']]) {
    const account = await client.db(dbName).collection(name).findOne({ 'profiles.ownerId': String(ownerId) }, { projection: { profiles: 1 } });
    const profile = profilesOf(account).find(row => row.ownerId === String(ownerId));
    if (profile) return String(profile.rokuSourceId || '');
  }
  return null;
}

async function updateProfileFields(accountId, profileId, fields, unset = {}) {
  const record = await accountRecord(accountId);
  const set = Object.fromEntries(Object.entries(fields).map(([key, value]) => [`profiles.$.${key}`, value]));
  set.updatedAt = new Date();
  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = Object.fromEntries(Object.keys(unset).map(key => [`profiles.$.${key}`, '']));
  return record.collection.updateOne({ _id: record.id, 'profiles.id': String(profileId) }, update);
}

export async function setProfileRokuSourcePreference(accountId, profileId, sourceId) {
  const profile = profileId ? await getAccountProfile(accountId, profileId) : null;
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const value = String(sourceId || '').trim();
  await updateProfileFields(accountId, profile.id, { rokuSourceId: value, updatedAt: new Date() });
  return value;
}

async function partnerField(accountId, profileId, field) {
  const profile = profileId ? await getAccountProfile(accountId, profileId) : null;
  if (profile?.[field] !== undefined) return String(profile[field] || '');
  if (profile?.isDefault) return String((await accountRecord(accountId)).account[field] || '');
  return '';
}
export function getProfilePartnerEmail(accountId, profileId) { return partnerField(accountId, profileId, 'partnerEmail'); }
export function getProfilePartnerCode(accountId, profileId) { return partnerField(accountId, profileId, 'partnerProfileCode'); }

export async function setProfilePartnerEmail(accountId, profileId, email, profileCode = '') {
  const value = String(email || '').trim().toLowerCase();
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address');
  const codeValue = String(profileCode || '').trim().toUpperCase();
  if (value && !codeValue) throw new Error("Enter your partner's profile code");
  if (codeValue && !/^[A-Z]\d+$/.test(codeValue)) throw new Error('Profile code should look like a letter and a number, e.g. R1');
  const profile = profileId ? await getAccountProfile(accountId, profileId) : null;
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  await updateProfileFields(accountId, profile.id, { partnerEmail: value, partnerProfileCode: value ? codeValue : '', updatedAt: new Date() });
  return value;
}

export async function createAccountProfile(accountId, input = {}) {
  const record = await accountRecord(accountId);
  const rows = await backfillMissingCodes(record);
  if (rows.length >= maxProfiles) return { error: `An account can have up to ${maxProfiles} profiles` };
  const name = normalizeProfileName(input.name);
  if (!name) return { error: 'Enter a profile name' };
  const avatarImage = String(input.avatarImage || '');
  const pin = String(input.pin || '');
  if (pin && !validProfilePin(pin)) return { error: 'Profile PIN must be exactly 4 digits' };
  if (avatarImage.length > 1_400_000 || (avatarImage && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarImage))) return { error: 'Upload a valid profile image' };
  if (rows.some(row => row.name.toLowerCase() === name.toLowerCase())) return { error: 'Choose a different profile name' };
  const id = randomUUID();
  const profile = {
    id, ownerId: profileOwnerId(accountId, id), name,
    code: nextProfileCode(rows, name),
    avatar: avatars.has(input.avatar) ? input.avatar : [...avatars][rows.length % avatars.size],
    avatarImage, ...(pin ? { pinHash: hashProfilePin(pin) } : {}),
    isDefault: false, position: rows.length,
    library: { categories: [], assignments: [], favorites: [], seriesWatchOverrides: [], savedSelections: {} },
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await record.collection.updateOne(
    { _id: record.id, [`profiles.${maxProfiles - 1}`]: { $exists: false }, 'profiles.name': { $ne: name } },
    { $push: { profiles: profile }, $set: { updatedAt: new Date() } },
  );
  if (!result.modifiedCount) return { error: 'Profile list changed. Please try again' };
  return { profile: publicProfile(profile) };
}

export async function updateAccountProfile(accountId, profileId, input = {}) {
  const record = await accountRecord(accountId);
  const profile = profilesOf(record.account).find(row => row.id === String(profileId));
  if (!profile) return { error: 'Profile not found' };
  const name = input.name === undefined ? profile.name : normalizeProfileName(input.name);
  if (!name) return { error: 'Enter a profile name' };
  if (profilesOf(record.account).some(row => row.id !== profile.id && row.name.toLowerCase() === name.toLowerCase())) return { error: 'Choose a different profile name' };
  const avatar = avatars.has(input.avatar) ? input.avatar : profile.avatar || 'lime';
  const avatarImage = input.avatarImage === undefined ? (profile.avatarImage || '') : String(input.avatarImage || '');
  if (avatarImage.length > 1_400_000 || (avatarImage && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarImage))) return { error: 'Upload a valid profile image' };
  const pinChanged = input.pin !== undefined;
  const pin = pinChanged ? String(input.pin || '') : '';
  if (pinChanged && pin && !validProfilePin(pin)) return { error: 'Profile PIN must be exactly 4 digits' };
  const pinHash = pinChanged && pin ? hashProfilePin(pin) : profile.pinHash;
  const fields = { name, avatar, avatarImage, updatedAt: new Date() };
  if (pinChanged && pin) fields.pinHash = pinHash;
  await updateProfileFields(accountId, profileId, fields, pinChanged && !pin ? { pinHash: '' } : {});
  return { profile: publicProfile({ ...profile, name, avatar, avatarImage, pinHash: pinChanged ? pinHash || '' : profile.pinHash }) };
}

export async function deleteAccountProfile(accountId, profileId) {
  const profile = await getAccountProfile(accountId, profileId);
  if (!profile) return { error: 'Profile not found' };
  if (profile.isDefault) return { error: 'The main profile cannot be deleted' };
  const record = await accountRecord(accountId);
  const ownerId = String(profile.ownerId || '');
  const names = [
    process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress',
    process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history',
    process.env.MONGODB_AI_RECOMMENDATIONS_COLLECTION || 'ai_recommendations',
    process.env.MONGODB_ANDROID_STARTUP_COLLECTION || 'android_startup_snapshots',
  ];
  await Promise.all(names.map(name => record.database.collection(name).deleteMany({ ownerId })));
  await record.database.collection(process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources').updateMany(
    { ownerId: accountOwnerId(accountId) }, { $unset: { [`selections.${ownerId}`]: '' } },
  );
  if (record.account.metadata?.devices?.some(device => device.profileId === String(profileId))) {
    await record.collection.updateOne(
      { _id: record.id },
      { $unset: { 'metadata.devices.$[device].profileId': '' }, $set: { updatedAt: new Date() } },
      { arrayFilters: [{ 'device.profileId': String(profileId) }] },
    );
  }
  await record.collection.updateOne({ _id: record.id }, { $pull: { profiles: { id: String(profileId) } }, $set: { updatedAt: new Date() } });
  return { ok: true };
}

export async function deleteAccountProfilesAndData(accountId) {
  const record = await accountRecord(accountId);
  const rows = profilesOf(record.account);
  const ownerIds = [...new Set([accountOwnerId(accountId), ...rows.map(row => String(row.ownerId || '')).filter(Boolean)])];
  const names = [
    process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources',
    process.env.MONGODB_PLAYBACK_COLLECTION || 'playback_progress',
    process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history',
    process.env.MONGODB_AI_RECOMMENDATIONS_COLLECTION || 'ai_recommendations',
    process.env.MONGODB_ANDROID_STARTUP_COLLECTION || 'android_startup_snapshots',
    process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items',
    process.env.MONGODB_PROVIDER_CATALOG_SYNC_COLLECTION || 'provider_catalog_syncs',
  ];
  await Promise.all(names.map(name => record.database.collection(name).deleteMany({ ownerId: { $in: ownerIds } })));
  return { ownerIds };
}

export { maxProfiles as MAX_ACCOUNT_PROFILES };
