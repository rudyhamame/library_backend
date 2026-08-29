import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

const sessions = new Map();
const pairingTtlMs = 15 * 60 * 1000;
const maxPairingSessions = Math.max(50, Number.parseInt(process.env.MAX_PAIRING_SESSIONS || '500', 10) || 500);
const tokenTtlMs = 365 * 24 * 60 * 60 * 1000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_DEVICE_COLLECTION || 'device_profiles';
const accountCollectionName = process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts';
const signingSecret = process.env.DEVICE_AUTH_SECRET || 'local-development-secret-change-before-production';
let profilesPromise;
let accountsPromise;
const heartbeatCache = new Map();
const heartbeatIntervalMs = 30_000;
const runningWindowMs = 90_000;
const streamingWindowMs = 45_000;

async function profiles() {
  if (!profilesPromise) {
    profilesPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const collection = client.db(databaseName).collection(collectionName);
        await collection.createIndex({ ownerId: 1 }, { unique: true });
        return collection;
      })
      .catch(error => { profilesPromise = undefined; throw error; });
  }
  return profilesPromise;
}

async function accounts() {
  if (!accountsPromise) {
    accountsPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const collection = client.db(databaseName).collection(accountCollectionName);
        await collection.createIndex({ email: 1 }, { unique: true });
        return collection;
      })
      .catch(error => { accountsPromise = undefined; throw error; });
  }
  return accountsPromise;
}

function purge(reserveSlot = false) {
  const now = Date.now();
  for (const [code, session] of sessions) if (session.expiresAt < now) sessions.delete(code);
  const target = reserveSlot ? maxPairingSessions - 1 : maxPairingSessions;
  while (sessions.size > target) sessions.delete(sessions.keys().next().value);
}

function ownerIdFor(deviceId) { return createHash('sha256').update(String(deviceId)).digest('hex'); }
function encode(value) { return Buffer.from(value).toString('base64url'); }
function sign(value) { return createHmac('sha256', signingSecret).update(value).digest('base64url'); }

function issueToken(session, type) {
  const payload = encode(JSON.stringify({ ownerId: session.ownerId, deviceId: session.deviceId, accountId: session.accountId || null, type, exp: Date.now() + tokenTtlMs }));
  return `${payload}.${sign(payload)}`;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  return `${salt}.${scryptSync(password, salt, 64).toString('base64url')}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || '').split('.');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'base64url');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validPassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 256; }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }

export function createDeviceSession(deviceId, frontendUrl) {
  purge(true);
  const normalizedDeviceId = String(deviceId);
  const session = {
    code: randomBytes(18).toString('base64url'),
    deviceId: normalizedDeviceId,
    ownerId: ownerIdFor(normalizedDeviceId),
    expiresAt: Date.now() + pairingTtlMs,
  };
  sessions.set(session.code, session);
  // The QR payload is deliberately limited to the short-lived pairing code.
  // Build a clean URL instead of appending to frontendUrl, so credentials or
  // unrelated query parameters can never be copied into the QR contents.
  const pairUrlObject = new URL(String(frontendUrl));
  pairUrlObject.search = '';
  pairUrlObject.hash = '';
  pairUrlObject.pathname = `${pairUrlObject.pathname.replace(/\/$/, '')}/`;
  pairUrlObject.searchParams.set('pair', session.code);
  const pairUrl = pairUrlObject.toString();
  return {
    code: session.code, deviceId: session.deviceId, expiresAt: session.expiresAt,
    pairUrl,
    qrImageUrl: `https://quickchart.io/qr?size=190&text=${encodeURIComponent(pairUrl)}`,
  };
}

export function getDeviceSession(code) { purge(); return sessions.get(String(code || '')); }

export async function getPairingInfo(code, token = '') {
  const session = getDeviceSession(code);
  if (!session) return null;
  const profile = await (await profiles()).findOne({ ownerId: session.ownerId }, { projection: { accountId: 1 } });
  const authenticated = resolveDeviceToken(token)?.ownerId === session.ownerId;
  return { deviceId: session.deviceId, expiresAt: session.expiresAt, needsSignup: !profile?.accountId, purpose: profile?.accountId ? 'manage-library' : 'activate-device', authenticated };
}

async function consumePairing(code, email, password, setup) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  if (!validPassword(password)) return { error: 'Password must contain at least 8 characters' };
  const deviceCollection = await profiles();
  const accountCollection = await accounts();
  const profile = await deviceCollection.findOne({ ownerId: session.ownerId });
  let account;
  if (setup) {
    if (profile?.accountId) return { error: 'This Roku is already activated. Sign in instead.' };
    if (await accountCollection.findOne({ email: normalizedEmail }, { projection: { _id: 1 } })) return { error: 'An account with this email already exists. Sign in instead.' };
    const created = await accountCollection.insertOne({ email: normalizedEmail, passwordHash: hashPassword(password), createdAt: new Date(), updatedAt: new Date() });
    account = { _id: created.insertedId };
  } else {
    account = await accountCollection.findOne({ email: normalizedEmail });
    // A profile created by the earlier device-password implementation can be
    // adopted on its first successful sign-in without losing its library.
    if (!account && profile?.email === normalizedEmail && verifyPassword(password, profile.passwordHash)) {
      const created = await accountCollection.insertOne({ email: normalizedEmail, passwordHash: profile.passwordHash, createdAt: profile.createdAt || new Date(), updatedAt: new Date() });
      account = { _id: created.insertedId };
    }
    if (!account || !verifyPassword(password, account.passwordHash)) return { error: 'Incorrect email or password' };
  }
  session.accountId = String(account._id);
  await deviceCollection.updateOne(
    { ownerId: session.ownerId },
    { $setOnInsert: { ownerId: session.ownerId, deviceId: session.deviceId, createdAt: new Date() }, $set: { accountId: account._id, linkedAt: new Date(), updatedAt: new Date() } },
    { upsert: true },
  );
  session.approvedAt = Date.now();
  return { token: issueToken(session, 'browser'), deviceId: session.deviceId };
}

export function setupDeviceSession(code, email, password) { return consumePairing(code, email, password, true); }
export function loginDeviceSession(code, email, password) { return consumePairing(code, email, password, false); }

export function getRokuDeviceSessionStatus(code) {
  const session = getDeviceSession(code);
  if (!session) return null;
  if (!session.approvedAt) return { status: 'pending', expiresAt: session.expiresAt };
  return { status: 'approved', expiresAt: session.expiresAt, token: issueToken(session, 'roku') };
}

export async function getLinkedDevices(accountId) {
  if (!ObjectId.isValid(accountId)) return [];
  const rows = await (await profiles()).find(
    { accountId: new ObjectId(accountId) },
    { projection: { deviceId: 1, linkedAt: 1, updatedAt: 1, lastSeenAt: 1, lastStreamingSeenAt: 1 } },
  ).sort({ linkedAt: 1 }).toArray();
  return rows.map(device => ({
    id: String(device._id),
    deviceId: device.deviceId,
    linkedAt: device.linkedAt || device.updatedAt || null,
    lastSeenAt: device.lastSeenAt || null,
    running: Boolean(device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() <= runningWindowMs),
    streaming: Boolean(device.lastStreamingSeenAt && Date.now() - new Date(device.lastStreamingSeenAt).getTime() <= streamingWindowMs),
    label: `Roku ${String(device.deviceId || '').replace(/^roku-/, '').slice(-8).toUpperCase()}`,
  }));
}

export async function recordDeviceHeartbeat(deviceId, streaming = false) {
  const normalized = String(deviceId || '').trim();
  if (!normalized) return;
  const now = Date.now();
  const previous = heartbeatCache.get(normalized) || { at: 0, streaming: false };
  if (now - previous.at < heartbeatIntervalMs && previous.streaming === Boolean(streaming)) return;
  heartbeatCache.set(normalized, { at: now, streaming: Boolean(streaming) });
  try {
    const update = { $set: { lastSeenAt: new Date(now) } };
    if (streaming) update.$set.lastStreamingSeenAt = new Date(now);
    else update.$unset = { lastStreamingSeenAt: '' };
    await (await profiles()).updateOne({ deviceId: normalized }, update);
  } catch {
    heartbeatCache.delete(normalized);
  }
}

export async function unlinkAccountDevice(accountId, deviceId) {
  if (!ObjectId.isValid(accountId) || !deviceId) return { error: 'Invalid device' };
  const result = await (await profiles()).updateOne(
    { accountId: new ObjectId(accountId), deviceId: String(deviceId) },
    { $unset: { accountId: '' }, $set: { updatedAt: new Date() } },
  );
  return result.modifiedCount ? { ok: true } : { error: 'Linked Roku device not found' };
}

export async function loginAccount(email, password, deviceId = '') {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail) || !validPassword(password)) return { error: 'Incorrect email or password' };
  const account = await (await accounts()).findOne({ email: normalizedEmail });
  if (!account || !verifyPassword(password, account.passwordHash)) return { error: 'Incorrect email or password' };
  const linked = await (await profiles()).find({ accountId: account._id }).toArray();
  if (!linked.length) return { error: 'No Roku devices are linked to this account' };
  const devices = linked.map(device => ({ id: String(device._id), deviceId: device.deviceId, label: `Roku ${String(device.deviceId || '').replace(/^roku-/, '').slice(-8).toUpperCase()}` }));
  if (!deviceId && linked.length > 1) return { devices };
  const selected = linked.find(device => deviceId && device.deviceId === deviceId) || (linked.length === 1 ? linked[0] : null);
  if (!selected) return { error: 'Select a linked Roku device' };
  const session = { ownerId: selected.ownerId, deviceId: selected.deviceId, accountId: String(account._id) };
  return { token: issueToken(session, 'browser'), devices };
}

export async function changeAccountPassword(accountId, currentPassword, newPassword) {
  if (!ObjectId.isValid(accountId)) return { error: 'Sign in to change your password' };
  if (!validPassword(currentPassword) || !validPassword(newPassword)) return { error: 'Passwords must contain at least 8 characters' };
  const collection = await accounts();
  const account = await collection.findOne({ _id: new ObjectId(accountId) });
  if (!account || !verifyPassword(currentPassword, account.passwordHash)) return { error: 'Current password is incorrect' };
  await collection.updateOne({ _id: account._id }, { $set: { passwordHash: hashPassword(newPassword), updatedAt: new Date() } });
  return { ok: true };
}

export function resolveDeviceToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.ownerId && data.exp > Date.now() ? data : null;
  } catch { return null; }
}
