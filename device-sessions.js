import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoClient } from 'mongodb';

const sessions = new Map();
const pairingTtlMs = 15 * 60 * 1000;
const tokenTtlMs = 365 * 24 * 60 * 60 * 1000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_DEVICE_COLLECTION || 'device_profiles';
const signingSecret = process.env.DEVICE_AUTH_SECRET || 'local-development-secret-change-before-production';
let profilesPromise;

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

function purge() {
  const now = Date.now();
  for (const [code, session] of sessions) if (session.expiresAt < now) sessions.delete(code);
}

function ownerIdFor(deviceId) { return createHash('sha256').update(String(deviceId)).digest('hex'); }
function encode(value) { return Buffer.from(value).toString('base64url'); }
function sign(value) { return createHmac('sha256', signingSecret).update(value).digest('base64url'); }

function issueToken(session, type) {
  const payload = encode(JSON.stringify({ ownerId: session.ownerId, deviceId: session.deviceId, type, exp: Date.now() + tokenTtlMs }));
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
  purge();
  const normalizedDeviceId = String(deviceId);
  const session = {
    code: randomBytes(18).toString('base64url'),
    deviceId: normalizedDeviceId,
    ownerId: ownerIdFor(normalizedDeviceId),
    expiresAt: Date.now() + pairingTtlMs,
  };
  sessions.set(session.code, session);
  const pairUrl = `${String(frontendUrl).replace(/\/$/, '')}/?pair=${encodeURIComponent(session.code)}`;
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
  const profile = await (await profiles()).findOne({ ownerId: session.ownerId }, { projection: { email: 1 } });
  const authenticated = resolveDeviceToken(token)?.ownerId === session.ownerId;
  return { expiresAt: session.expiresAt, needsSignup: !profile?.email, purpose: profile?.email ? 'manage-library' : 'activate-device', authenticated };
}

async function consumePairing(code, email, password, setup) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  if (!validPassword(password)) return { error: 'Password must contain at least 8 characters' };
  const collection = await profiles();
  const profile = await collection.findOne({ ownerId: session.ownerId });
  if (setup) {
    if (profile?.email) return { error: 'This Roku is already activated. Sign in instead.' };
    await collection.updateOne(
      { ownerId: session.ownerId },
      { $setOnInsert: { ownerId: session.ownerId, deviceId: session.deviceId, createdAt: new Date() }, $set: { email: normalizedEmail, passwordHash: hashPassword(password), updatedAt: new Date() } },
      { upsert: true },
    );
  } else if (!profile?.email || profile.email !== normalizedEmail || !verifyPassword(password, profile.passwordHash)) {
    return { error: 'Incorrect email or password' };
  }
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
