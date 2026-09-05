import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { deduplicateXtreamSources, moveXtreamSources } from './xtream-store.js';
import { accountOwnerId, canonicalSessionOwner } from './account-library-owner.js';
import { moveLibraryCategories } from './library-category-store.js';
import { movePlaybackOwners } from './playback-store.js';
import { moveFavoriteOwners } from './favorites-store.js';
import { moveStreamingHistoryOwners } from './streaming-history-store.js';
import { deleteAccountProfilesAndData, ensureDefaultProfile, getAccountProfile } from './account-profile-store.js';

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
const heartbeatIntervalMs = 10_000;
const runningWindowMs = 30_000;
const streamingWindowMs = 30_000;

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
  const payload = encode(JSON.stringify({ ownerId: canonicalSessionOwner(session), deviceId: session.deviceId, accountId: session.accountId || null, profileId: session.profileId || null, type, exp: Date.now() + tokenTtlMs }));
  return `${payload}.${sign(payload)}`;
}

async function consolidateAccountLibrary(accountId) {
  if (!ObjectId.isValid(accountId)) return null;
  const canonicalOwnerId = accountOwnerId(accountId);
  const linkedProfiles = await (await profiles()).find(
    { accountId: new ObjectId(accountId) },
    { projection: { ownerId: 1, weatherLocations: 1 } },
  ).toArray();
  const legacyWeather = linkedProfiles.find(profile => Array.isArray(profile.weatherLocations) && profile.weatherLocations.length)?.weatherLocations?.slice(0, 1);
  const accountUpdate = { ownerId: canonicalOwnerId, dataVersion: 2, updatedAt: new Date() };
  if (legacyWeather) accountUpdate.weatherLocations = legacyWeather;
  await (await accounts()).updateOne({ _id: new ObjectId(accountId) }, { $set: accountUpdate });
  await (await profiles()).updateMany(
    { accountId: new ObjectId(accountId) },
    { $set: { accountOwnerId: canonicalOwnerId, updatedAt: new Date() }, $unset: { weatherLocations: '' } },
  );
  const priorOwnerIds = linkedProfiles.map(profile => profile.ownerId).filter(Boolean);
  for (const ownerId of priorOwnerIds) await moveXtreamSources(ownerId, canonicalOwnerId);
  await deduplicateXtreamSources(canonicalOwnerId);
  await moveLibraryCategories(priorOwnerIds, canonicalOwnerId);
  await movePlaybackOwners(priorOwnerIds, canonicalOwnerId);
  await moveStreamingHistoryOwners(priorOwnerIds, canonicalOwnerId);
  await moveFavoriteOwners(priorOwnerIds, canonicalOwnerId);
  return canonicalOwnerId;
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

export async function createDeviceSession(deviceId, frontendUrl, deviceToken = '') {
  purge(true);
  const normalizedDeviceId = String(deviceId);
  const session = {
    code: randomBytes(18).toString('base64url'),
    deviceId: normalizedDeviceId,
    ownerId: ownerIdFor(normalizedDeviceId),
    expiresAt: Date.now() + pairingTtlMs,
  };
  // A previously activated Roku may authorize a short-lived automatic browser
  // login. Validate its local Roku token against the still-linked DB profile;
  // neither the token nor account credentials are ever placed in the QR URL.
  const authorization = resolveDeviceToken(deviceToken);
  if (authorization?.type === 'roku' && authorization.deviceId === normalizedDeviceId && ObjectId.isValid(authorization.accountId)) {
    const profile = await (await profiles()).findOne({ deviceId: normalizedDeviceId, accountId: new ObjectId(authorization.accountId) }, { projection: { accountId: 1 } });
    if (profile?.accountId) {
      session.accountId = String(profile.accountId);
      session.ownerId = accountOwnerId(profile.accountId);
      session.autoLogin = true;
    }
  }
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
  // Camera apps hand this Android intent URL to RH when it is installed. If
  // it is not installed, Chrome opens the existing web pairing page instead.
  // If the Android intent is unavailable, the scanner must still open the
  // actual pairing page. Falling back to an APK download strands users before
  // they can sign in, especially when scanning with a regular camera app.
  const appPairUrl = `intent://pair?pair=${encodeURIComponent(session.code)}#Intent;scheme=rhstream;package=com.rhstream.library;S.browser_fallback_url=${encodeURIComponent(pairUrl)};end`;
  return {
    code: session.code, deviceId: session.deviceId, expiresAt: session.expiresAt,
    pairUrl, appPairUrl,
    qrImageUrl: `https://quickchart.io/qr?size=190&text=${encodeURIComponent(appPairUrl)}`,
  };
}

export async function getRokuSourcePreference(accountId) {
  if (!accountId || !ObjectId.isValid(accountId)) return '';
  const account = await (await accounts()).findOne({ _id: new ObjectId(accountId) }, { projection: { rokuSourceId: 1 } });
  return String(account?.rokuSourceId || '');
}

export async function setRokuSourcePreference(accountId, sourceId) {
  if (!accountId || !ObjectId.isValid(accountId)) throw new Error('Account authentication is required');
  const value = String(sourceId || '').trim();
  await (await accounts()).updateOne({ _id: new ObjectId(accountId) }, { $set: { rokuSourceId: value, updatedAt: new Date() } });
  return value;
}

export async function getRokuSourcePreferenceByOwner(ownerId) {
  if (!ownerId) return '';
  const account = await (await accounts()).findOne({ ownerId: String(ownerId) }, { projection: { rokuSourceId: 1 } });
  return String(account?.rokuSourceId || '');
}

export async function getPartnerEmail(accountId) {
  if (!accountId || !ObjectId.isValid(accountId)) return '';
  const account = await (await accounts()).findOne({ _id: new ObjectId(accountId) }, { projection: { partnerEmail: 1 } });
  return String(account?.partnerEmail || '');
}

export async function setPartnerEmail(accountId, email) {
  if (!accountId || !ObjectId.isValid(accountId)) throw new Error('Account authentication is required');
  const value = normalizeEmail(email);
  if (value && !validEmail(value)) throw new Error('Enter a valid email address');
  await (await accounts()).updateOne({ _id: new ObjectId(accountId) }, { $set: { partnerEmail: value, updatedAt: new Date() } });
  return value;
}

// The inverse of resolveAccountByEmail - used to show the host's own name on
// the invite the partner receives.
export async function getAccountBasicInfo(accountId) {
  if (!accountId || !ObjectId.isValid(accountId)) return null;
  const account = await (await accounts()).findOne({ _id: new ObjectId(accountId) }, { projection: { email: 1, firstName: 1, lastName: 1 } });
  if (!account) return null;
  return { email: account.email, name: [account.firstName, account.lastName].filter(Boolean).join(' ').trim() };
}

// Read-only lookup used to route a Watch with Partner invite - no password
// check, unlike loginAccount. Returns null rather than throwing so callers
// can turn a missing/typo'd partner email into a clear user-facing error.
export async function resolveAccountByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return null;
  const account = await (await accounts()).findOne({ email: normalizedEmail }, { projection: { _id: 1, email: 1, firstName: 1, lastName: 1 } });
  if (!account) return null;
  return { accountId: String(account._id), ownerId: accountOwnerId(account._id), email: account.email, name: [account.firstName, account.lastName].filter(Boolean).join(' ').trim() };
}

// True when the account has at least one device (Roku / browser / Android)
// that checked in within the presence window - used for the Watch with Partner
// status indicator.
export async function isAccountOnline(accountId) {
  if (!accountId || !ObjectId.isValid(accountId)) return false;
  const since = new Date(Date.now() - runningWindowMs);
  const device = await (await profiles()).findOne(
    { accountId: new ObjectId(accountId), lastSeenAt: { $gte: since } },
    { projection: { _id: 1 } },
  );
  return Boolean(device);
}

export function getDeviceSession(code) { purge(); return sessions.get(String(code || '')); }

export async function getPairingInfo(code, token = '') {
  const session = getDeviceSession(code);
  if (!session) return null;
  const profile = await (await profiles()).findOne({ deviceId: session.deviceId }, { projection: { accountId: 1 } });
  const authorization = resolveDeviceToken(token);
  const authenticated = authorization?.deviceId === session.deviceId
    || (profile?.accountId && String(authorization?.accountId || '') === String(profile.accountId));
  return { deviceId: session.deviceId, expiresAt: session.expiresAt, needsSignup: !profile?.accountId, purpose: profile?.accountId ? 'manage-library' : 'activate-device', authenticated, canAutoLogin: Boolean(session.autoLogin && session.accountId && !session.claimedAt) };
}

export function claimAutomaticPairing(code) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  if (!session.autoLogin || !session.accountId) return { error: 'Sign in once before automatic QR login is available' };
  if (session.claimedAt) return { error: 'This automatic login link has already been used' };
  session.claimedAt = Date.now();
  const result = { token: issueToken(session, 'browser'), deviceId: session.deviceId };
  return result;
}

// Approve a Roku pairing with the account already authenticated on the phone.
// This never trusts the QR by itself: the caller must present a valid browser
// token for the same account, and a Roku owned by another account is rejected.
export async function authorizeDeviceSession(code, token) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  const authorization = resolveDeviceToken(token);
  if (authorization?.type !== 'browser' || !ObjectId.isValid(authorization.accountId)) return { error: 'Sign in to authorize this Roku' };
  const accountId = new ObjectId(authorization.accountId);
  const deviceCollection = await profiles();
  const deviceOwnerId = ownerIdFor(session.deviceId);
  const profile = await deviceCollection.findOne({ deviceId: session.deviceId }, { projection: { accountId: 1, profileId: 1 } });
  if (profile?.accountId && String(profile.accountId) !== String(accountId)) return { error: 'This Roku is linked to a different RH account' };
  session.accountId = String(accountId);
  const selectedProfile = authorization.profileId
    ? await getAccountProfile(accountId, authorization.profileId)
    : await ensureDefaultProfile(accountId);
  if (!selectedProfile) return { error: 'Profile not found' };
  const profileId = selectedProfile.id;
  await deviceCollection.updateOne(
    { deviceId: session.deviceId },
    { $setOnInsert: { ownerId: deviceOwnerId, deviceId: session.deviceId, createdAt: new Date() }, $set: { accountId, profileId, linkedAt: new Date(), updatedAt: new Date() } },
    { upsert: true },
  );
  session.profileId = profileId;
  session.ownerId = selectedProfile.isDefault ? await consolidateAccountLibrary(accountId) : selectedProfile.ownerId;
  session.approvedAt = Date.now();
  return { ok: true, deviceId: session.deviceId };
}

async function consumePairing(code, email, password, setup, firstName = '', lastName = '') {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  if (!validPassword(password)) return { error: 'Password must contain at least 8 characters' };
  const deviceCollection = await profiles();
  const accountCollection = await accounts();
  const deviceOwnerId = ownerIdFor(session.deviceId);
  const profile = await deviceCollection.findOne({ deviceId: session.deviceId });
  let account;
  if (setup) {
    if (profile?.accountId) return { error: 'This Roku is already activated. Sign in instead.' };
    if (await accountCollection.findOne({ email: normalizedEmail }, { projection: { _id: 1 } })) return { error: 'An account with this email already exists. Sign in instead.' };
    const created = await accountCollection.insertOne({ email: normalizedEmail, passwordHash: hashPassword(password), firstName: String(firstName || '').trim().slice(0, 60), lastName: String(lastName || '').trim().slice(0, 60), createdAt: new Date(), updatedAt: new Date() });
    account = { _id: created.insertedId };
    await ensureDefaultProfile(String(account._id), firstName || 'Main');
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
    { deviceId: session.deviceId },
    { $setOnInsert: { ownerId: deviceOwnerId, deviceId: session.deviceId, createdAt: new Date() }, $set: { accountId: account._id, linkedAt: new Date(), updatedAt: new Date() } },
    { upsert: true },
  );
  session.ownerId = await consolidateAccountLibrary(account._id);
  session.approvedAt = Date.now();
  return { token: issueToken(session, 'browser'), deviceId: session.deviceId };
}

export function setupDeviceSession(code, email, password, firstName, lastName) { return consumePairing(code, email, password, true, firstName, lastName); }
export function loginDeviceSession(code, email, password) { return consumePairing(code, email, password, false); }

export async function registerAccount(email, password, firstName = '', lastName = '') {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  if (!validPassword(password)) return { error: 'Password must contain at least 8 characters' };
  const collection = await accounts();
  if (await collection.findOne({ email: normalizedEmail }, { projection: { _id: 1 } })) return { error: 'An account with this email already exists. Sign in instead.' };
  try {
    const created = await collection.insertOne({ email: normalizedEmail, passwordHash: hashPassword(password), firstName: String(firstName || '').trim().slice(0, 60), lastName: String(lastName || '').trim().slice(0, 60), createdAt: new Date(), updatedAt: new Date() });
    await ensureDefaultProfile(String(created.insertedId), firstName || 'Main');
  } catch (error) {
    if (error?.code === 11000) return { error: 'An account with this email already exists. Sign in instead.' };
    throw error;
  }
  return { ok: true };
}

export async function getRokuDeviceSessionStatus(code) {
  const session = getDeviceSession(code);
  if (!session) return null;
  if (session.claimedAt) return { status: 'consumed', expiresAt: session.expiresAt };
  if (!session.approvedAt) return { status: 'pending', expiresAt: session.expiresAt };
  const profile = session.profileId && session.accountId
    ? await getAccountProfile(session.accountId, session.profileId)
    : null;
  return { status: 'approved', expiresAt: session.expiresAt, token: issueToken(session, 'roku'), profileName: profile?.name || '' };
}

async function accountProfileId(accountId, profileId = '') {
  const defaultProfile = await ensureDefaultProfile(accountId);
  if (profileId) {
    const selected = await getAccountProfile(accountId, profileId);
    if (selected) return selected.id;
  }
  return defaultProfile.id;
}

export async function getLinkedDevices(accountId, profileId = '') {
  if (!ObjectId.isValid(accountId)) return [];
  const defaultProfile = await ensureDefaultProfile(accountId);
  const selectedProfileId = await accountProfileId(accountId, profileId);
  const deviceCollection = await profiles();
  await deviceCollection.updateMany(
    { accountId: new ObjectId(accountId), profileId: { $exists: false } },
    { $set: { profileId: defaultProfile.id, updatedAt: new Date() } },
  );
  // The "Linked Roku devices" list (Android + browser Settings, Android welcome
  // page) is Roku-only and scoped to the profile the caller's token carries -
  // browser tabs and the Android app's own presence heartbeat (kind 'browser' /
  // 'android') do not belong here. The dashboard's Connected Devices page uses
  // listAllLinkedDevices() instead and still shows every kind.
  const rows = await (await profiles()).find(
    { accountId: new ObjectId(accountId), profileId: selectedProfileId, kind: { $nin: ['browser', 'android'] } },
    { projection: { deviceId: 1, profileId: 1, linkedAt: 1, updatedAt: 1, lastSeenAt: 1, lastStreamingSeenAt: 1, lastClientIp: 1, kind: 1, label: 1 } },
  ).sort({ linkedAt: 1 }).toArray();
  return rows.map(device => ({
    id: String(device._id),
    deviceId: device.deviceId,
    profileId: device.profileId,
    kind: 'roku',
    linkedAt: device.linkedAt || device.updatedAt || null,
    lastSeenAt: device.lastSeenAt || null,
    lastClientIp: device.lastClientIp || '',
    running: Boolean(device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() <= runningWindowMs),
    streaming: Boolean(device.lastStreamingSeenAt && Date.now() - new Date(device.lastStreamingSeenAt).getTime() <= streamingWindowMs),
    label: `Roku ${String(device.deviceId || '').replace(/^roku-/, '').slice(-8).toUpperCase()}`,
  }));
}

// A browser tab or the Android app is not paired like a Roku — it just carries
// a client-generated deviceId (persisted in localStorage / SharedPreferences)
// so its presence/streaming heartbeats have somewhere to land. Upserted on
// every heartbeat; linkedAt is set once.
export async function registerBrowserDevice(accountId, profileId, deviceId, label = '', kind = 'browser') {
  if (!ObjectId.isValid(accountId)) return;
  const normalizedDeviceId = String(deviceId || '').trim();
  if (!normalizedDeviceId) return;
  const normalizedKind = kind === 'android' ? 'android' : 'browser';
  const selectedProfileId = await accountProfileId(accountId, profileId);
  const deviceOwnerId = ownerIdFor(normalizedDeviceId);
  await (await profiles()).updateOne(
    { deviceId: normalizedDeviceId },
    {
      $setOnInsert: { ownerId: deviceOwnerId, deviceId: normalizedDeviceId, createdAt: new Date(), linkedAt: new Date() },
      $set: { accountId: new ObjectId(accountId), profileId: selectedProfileId, kind: normalizedKind, label: String(label || '').trim().slice(0, 120) || (normalizedKind === 'android' ? 'Android' : 'Browser'), updatedAt: new Date() },
    },
    { upsert: true },
  );
}

function linkedProfileFilter(ownerId, accountId = '', deviceId = '') {
  if (ObjectId.isValid(accountId)) return { accountId: new ObjectId(accountId) };
  if (deviceId) return { deviceId: String(deviceId) };
  return { ownerId: String(ownerId) };
}

export async function getDeviceWeatherLocations(ownerId, accountId = '', deviceId = '') {
  if (!ownerId) return [];
  if (ObjectId.isValid(accountId)) {
    const account = await (await accounts()).findOne(
      { _id: new ObjectId(accountId) },
      { projection: { weatherLocations: 1 } },
    );
    if (Array.isArray(account?.weatherLocations)) return account.weatherLocations.slice(0, 1);
  }
  const profile = await (await profiles()).findOne(
    linkedProfileFilter(ownerId, accountId, deviceId),
    { projection: { weatherLocations: 1 } },
  );
  return Array.isArray(profile?.weatherLocations) ? profile.weatherLocations.slice(0, 1) : [];
}

export async function saveDeviceWeatherLocations(ownerId, locations, accountId = '', deviceId = '') {
  if (!ownerId) return { error: 'Linked Roku authorization is required' };
  const supplied = Array.isArray(locations) ? locations.slice(0, 1) : [];
  const weatherLocations = supplied.map(location => location ? ({
    id: String(location.id || ''),
    label: String(location.label || '').trim().slice(0, 180),
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    timezone: String(location.timezone || 'auto').trim().slice(0, 120),
  }) : null);
  if (weatherLocations.some(location => location && (!location.label || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)))) {
    return { error: 'Select valid weather locations' };
  }
  const result = ObjectId.isValid(accountId)
    ? await (await accounts()).updateOne(
      { _id: new ObjectId(accountId) },
      { $set: { weatherLocations, updatedAt: new Date() } },
    )
    : await (await profiles()).updateMany(
      linkedProfileFilter(ownerId, accountId, deviceId),
      { $set: { weatherLocations, updatedAt: new Date() } },
    );
  return result.matchedCount ? { locations: weatherLocations } : { error: 'Linked Roku profile not found' };
}

export async function recordDeviceHeartbeat(deviceId, streaming = false, clientIp = '') {
  const normalized = String(deviceId || '').trim();
  if (!normalized) return;
  const now = Date.now();
  const ip = String(clientIp || '').replace(/^::ffff:/, '').trim();
  const previous = heartbeatCache.get(normalized) || { at: 0, streaming: false, ip: '' };
  if (now - previous.at < heartbeatIntervalMs && previous.streaming === Boolean(streaming) && previous.ip === ip) return;
  heartbeatCache.set(normalized, { at: now, streaming: Boolean(streaming), ip });
  try {
    const update = { $set: { lastSeenAt: new Date(now) } };
    if (ip) update.$set.lastClientIp = ip;
    if (streaming) update.$set.lastStreamingSeenAt = new Date(now);
    else update.$unset = { lastStreamingSeenAt: '' };
    await (await profiles()).updateOne({ deviceId: normalized }, update);
  } catch {
    heartbeatCache.delete(normalized);
  }
}

// Every linked device across all accounts, for the local operations dashboard.
export async function listAllLinkedDevices() {
  const [deviceRows, accountRows] = await Promise.all([
    (await profiles()).find({}, {
      projection: {
        deviceId: 1, accountId: 1, profileId: 1, linkedAt: 1, updatedAt: 1,
        lastSeenAt: 1, lastStreamingSeenAt: 1, lastClientIp: 1, kind: 1, label: 1,
      },
    }).sort({ lastSeenAt: -1 }).toArray(),
    (await accounts()).find({}, { projection: { email: 1, rokuSourceId: 1, ownerId: 1 } }).toArray(),
  ]);
  const accountById = new Map(accountRows.map(row => [String(row._id), row]));
  return deviceRows.map(row => {
    const account = accountById.get(String(row.accountId || '')) || null;
    return {
      deviceId: row.deviceId,
      accountId: String(row.accountId || ''),
      accountEmail: account?.email || '',
      accountOwnerId: account?.ownerId || (row.accountId ? accountOwnerId(row.accountId) : ''),
      rokuSourceId: account?.rokuSourceId || '',
      profileId: row.profileId || '',
      kind: row.kind === 'browser' || row.kind === 'android' ? row.kind : 'roku',
      label: row.kind === 'browser' || row.kind === 'android' ? (row.label || (row.kind === 'android' ? 'Android' : 'Browser')) : '',
      linkedAt: row.linkedAt || null,
      lastSeenAt: row.lastSeenAt || null,
      lastStreamingSeenAt: row.lastStreamingSeenAt || null,
      lastClientIp: row.lastClientIp || '',
    };
  });
}

export async function unlinkAccountDevice(accountId, deviceId, profileId = '') {
  if (!ObjectId.isValid(accountId) || !deviceId) return { error: 'Invalid device' };
  const selectedProfileId = await accountProfileId(accountId, profileId);
  const result = await (await profiles()).updateOne(
    { accountId: new ObjectId(accountId), deviceId: String(deviceId), profileId: selectedProfileId },
    { $unset: { accountId: '' }, $set: { updatedAt: new Date() } },
  );
  return result.modifiedCount ? { ok: true } : { error: 'Linked Roku device not found' };
}

export async function isRokuSessionLinked(session) {
  if (session?.type !== 'roku' || !session?.ownerId || !session?.deviceId || !ObjectId.isValid(session?.accountId)) return false;
  const selectedProfileId = await accountProfileId(session.accountId, session.profileId || '');
  const profile = await (await profiles()).findOne(
    { deviceId: String(session.deviceId), accountId: new ObjectId(session.accountId), profileId: selectedProfileId },
    { projection: { _id: 1 } },
  );
  return Boolean(profile);
}

export async function loginAccount(email, password, deviceId = '') {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail) || !validPassword(password)) return { error: 'Incorrect email or password' };
  const account = await (await accounts()).findOne({ email: normalizedEmail });
  if (!account || !verifyPassword(password, account.passwordHash)) return { error: 'Incorrect email or password' };
  await ensureDefaultProfile(String(account._id), account.firstName || 'Main');
  const linked = await (await profiles()).find({ accountId: account._id }).toArray();
  const ownerId = await consolidateAccountLibrary(account._id) || accountOwnerId(account._id);
  if (!linked.length) return { token: issueToken({ ownerId, accountId: String(account._id) }, 'browser'), devices: [] };
  const devices = linked.map(device => ({ id: String(device._id), deviceId: device.deviceId, label: `Roku ${String(device.deviceId || '').replace(/^roku-/, '').slice(-8).toUpperCase()}` }));
  const selected = linked.find(device => deviceId && device.deviceId === deviceId) || (linked.length === 1 ? linked[0] : null);
  if (deviceId && !selected) return { error: 'Select a linked Roku device' };
  const session = { ownerId, deviceId: selected?.deviceId, accountId: String(account._id) };
  return { token: issueToken(session, 'browser'), devices };
}

export async function selectAccountProfile(accountId, profileId, authorization = {}) {
  if (!ObjectId.isValid(accountId)) return { error: 'Sign in to choose a profile' };
  const profile = await getAccountProfile(accountId, profileId);
  if (!profile) return { error: 'Profile not found' };
  const session = {
    ownerId: profile.ownerId,
    profileId: profile.id,
    accountId: String(accountId),
    deviceId: authorization.deviceId || undefined,
  };
  return {
    token: issueToken(session, authorization.type === 'roku' ? 'roku' : 'browser'),
    profile: { id: profile.id, name: profile.name, avatar: profile.avatar || 'lime', isDefault: profile.isDefault === true },
  };
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

export async function deleteAccount(accountId, currentPassword) {
  if (!ObjectId.isValid(accountId)) return { error: 'Sign in to delete your account' };
  if (!validPassword(currentPassword)) return { error: 'Enter your current password' };
  const collection = await accounts();
  const normalizedAccountId = new ObjectId(String(accountId));
  const account = await collection.findOne({ _id: normalizedAccountId });
  if (!account || !verifyPassword(currentPassword, account.passwordHash)) return { error: 'Current password is incorrect' };
  await deleteAccountProfilesAndData(accountId);
  await collection.deleteOne({ _id: normalizedAccountId });
  for (const [code, session] of sessions) if (String(session.accountId || '') === String(accountId)) sessions.delete(code);
  return { ok: true };
}

export function resolveDeviceToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.ownerId || data.exp <= Date.now()) return null;
    return { ...data, ownerId: canonicalSessionOwner(data) };
  } catch { return null; }
}
