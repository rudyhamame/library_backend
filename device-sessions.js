import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { deduplicateXtreamSources, moveXtreamSources } from './xtream-store.js';
import { accountOwnerId, canonicalSessionOwner } from './account-library-owner.js';
import { moveLibraryCategories } from './library-category-store.js';
import { movePlaybackOwners } from './playback-store.js';
import { moveFavoriteOwners } from './favorites-store.js';
import { deleteAccountProfilesAndData, getAccountProfile, getProfileRokuSourcePreferenceByOwner, verifyProfilePin } from './account-profile-store.js';
import { sendAccountDeletionEmail, sendPasswordResetEmail, sendSignupVerificationEmail } from './email.js';
import { linkedDeviceStore } from './account-device-store.js';

const sessions = new Map();
const pairingTtlMs = 15 * 60 * 1000;
const maxPairingSessions = Math.max(50, Number.parseInt(process.env.MAX_PAIRING_SESSIONS || '500', 10) || 500);
const tokenTtlMs = 365 * 24 * 60 * 60 * 1000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const generalDatabaseName = process.env.MONGODB_GENERAL_DB || 'rh_general';
const accountCollectionName = process.env.MONGODB_ACCOUNT_COLLECTION || 'accounts';
const verifiedEmailCollectionName = process.env.MONGODB_VERIFIED_EMAIL_COLLECTION || 'verified_emails';
const signingSecret = process.env.DEVICE_AUTH_SECRET || 'local-development-secret-change-before-production';
const frontendUrl = process.env.FRONTEND_URL || 'http://127.0.0.1:8787';
let profilesPromise;
const accountsPromises = new Map();
const verifiedEmailPromises = new Map();
const signupVerificationPromises = new Map();
const heartbeatCache = new Map();
const heartbeatIntervalMs = 10_000;
const runningWindowMs = 30_000;
const streamingWindowMs = 30_000;

async function profiles() {
  if (!profilesPromise) profilesPromise = linkedDeviceStore().catch(error => { profilesPromise = undefined; throw error; });
  return profilesPromise;
}

function normalizeAccountRealm(realm) { return realm === 'general' ? 'general' : 'roku'; }
function metaRecordId(type, email) { return `${type}:${normalizeEmail(email)}`; }

async function accounts(realm = 'roku') {
  const normalizedRealm = normalizeAccountRealm(realm);
  let promise = accountsPromises.get(normalizedRealm);
  if (!promise) {
    promise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const dbName = normalizedRealm === 'general' ? generalDatabaseName : databaseName;
        const collection = client.db(dbName).collection(normalizedRealm === 'roku' ? 'identity' : accountCollectionName);
        const options = { unique: true };
        if (normalizedRealm === 'roku') options.name = 'identity_auth_email';
        await collection.createIndex({ email: 1 }, options);
        return collection;
      })
      .catch(error => { accountsPromises.delete(normalizedRealm); throw error; });
    accountsPromises.set(normalizedRealm, promise);
  }
  return promise;
}

async function verifiedEmails(realm = 'roku') {
  const normalizedRealm = normalizeAccountRealm(realm);
  let promise = verifiedEmailPromises.get(normalizedRealm);
  if (!promise) {
    promise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const dbName = normalizedRealm === 'general' ? generalDatabaseName : databaseName;
        const collection = client.db(dbName).collection(normalizedRealm === 'roku' ? 'meta' : verifiedEmailCollectionName);
        const options = { unique: true };
        if (normalizedRealm === 'roku') {
          options.name = 'meta_auth_email';
          options.partialFilterExpression = { type: { $in: ['verified-account', 'signup-verification'] } };
        }
        await collection.createIndex(normalizedRealm === 'roku' ? { type: 1, email: 1 } : { email: 1 }, options);
        return collection;
      })
      .catch(error => { verifiedEmailPromises.delete(normalizedRealm); throw error; });
    verifiedEmailPromises.set(normalizedRealm, promise);
  }
  return promise;
}

async function signupVerificationStore(realm = 'roku') {
  const normalizedRealm = normalizeAccountRealm(realm);
  let promise = signupVerificationPromises.get(normalizedRealm);
  if (!promise) {
    promise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const dbName = normalizedRealm === 'general' ? generalDatabaseName : databaseName;
        return client.db(dbName).collection(normalizedRealm === 'roku' ? 'meta' : (process.env.MONGODB_SIGNUP_VERIFICATION_COLLECTION || 'signup_verifications'));
      })
      .catch(error => { signupVerificationPromises.delete(normalizedRealm); throw error; });
    signupVerificationPromises.set(normalizedRealm, promise);
  }
  return promise;
}

const unverifiedAccountsId = 'unverified_accounts';
async function findUnverifiedAccount(email) {
  const normalizedEmail = normalizeEmail(email);
  const row = await (await signupVerificationStore('roku')).findOne({ _id: unverifiedAccountsId }, { projection: { unverified_accounts: 1 } });
  return (row?.unverified_accounts || []).find(item => item.email === normalizedEmail) || null;
}

async function saveUnverifiedAccount(email, changes) {
  const normalizedEmail = normalizeEmail(email);
  const collection = await signupVerificationStore('roku');
  const row = await collection.findOne({ _id: unverifiedAccountsId }, { projection: { unverified_accounts: 1 } });
  const entries = Array.isArray(row?.unverified_accounts) ? row.unverified_accounts.slice() : [];
  const index = entries.findIndex(item => item.email === normalizedEmail);
  const existing = index >= 0 ? entries[index] : null;
  const next = {
    _id: existing?._id || metaRecordId('signup-verification', normalizedEmail),
    email: normalizedEmail,
    code: changes.code ?? existing?.code ?? '',
    createdAt: existing?.createdAt || new Date(),
    updatedAt: changes.updatedAt || new Date(),
  };
  if (index >= 0) entries[index] = next; else entries.push(next);
  await collection.updateOne({ _id: unverifiedAccountsId }, { $set: { unverified_accounts: entries, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return next;
}

async function deleteUnverifiedAccount(email) {
  const collection = await signupVerificationStore('roku');
  await collection.updateOne({ _id: unverifiedAccountsId }, { $pull: { unverified_accounts: { email: normalizeEmail(email) } }, $set: { updatedAt: new Date() } });
}

async function isEmailVerified(email, realm) {
  // Verification is consumed by account creation. Do not persist a separate
  // verified-email marker in meta; the account document is the durable proof.
  void email; void realm;
  return false;
}

async function markEmailVerified(email, realm) {
  void email; void realm;
}

export async function initializeAccountDatabases() {
  await Promise.all([accounts('roku'), accounts('general'), verifiedEmails('roku'), verifiedEmails('general'), signupVerificationStore('roku'), signupVerificationStore('general')]);
  return { roku: databaseName, general: generalDatabaseName };
}

function purge(reserveSlot = false) {
  const now = Date.now();
  for (const [code, session] of sessions) if (session.expiresAt && session.expiresAt < now) sessions.delete(code);
  const target = reserveSlot ? maxPairingSessions - 1 : maxPairingSessions;
  while (sessions.size > target) sessions.delete(sessions.keys().next().value);
}

function ownerIdFor(deviceId) { return createHash('sha256').update(String(deviceId)).digest('hex'); }
function encode(value) { return Buffer.from(value).toString('base64url'); }
function sign(value) { return createHmac('sha256', signingSecret).update(value).digest('base64url'); }

function issueToken(session, type) {
  const payload = encode(JSON.stringify({ ownerId: canonicalSessionOwner(session), deviceId: session.deviceId, accountId: session.accountId || null, profileId: session.profileId || null, realm: normalizeAccountRealm(session.realm), type, exp: Date.now() + tokenTtlMs }));
  return `${payload}.${sign(payload)}`;
}

async function consolidateAccountLibrary(accountId, realm = 'roku') {
  if (!ObjectId.isValid(accountId)) return null;
  const canonicalOwnerId = accountOwnerId(accountId);
  const linkedProfiles = await (await profiles()).find(
    { accountId: new ObjectId(accountId) },
    { projection: { ownerId: 1, weatherLocations: 1 } },
  ).toArray();
  const legacyWeather = linkedProfiles.find(profile => Array.isArray(profile.weatherLocations) && profile.weatherLocations.length)?.weatherLocations?.slice(0, 1);
  const accountUpdate = { ownerId: canonicalOwnerId, dataVersion: 2, updatedAt: new Date() };
  if (legacyWeather) accountUpdate.weatherLocations = legacyWeather;
  await (await accounts(realm)).updateOne({ _id: new ObjectId(accountId) }, { $set: accountUpdate });
  await (await profiles()).updateMany(
    { accountId: new ObjectId(accountId) },
    { $set: { accountOwnerId: canonicalOwnerId, updatedAt: new Date() }, $unset: { weatherLocations: '' } },
  );
  const priorOwnerIds = linkedProfiles.map(profile => profile.ownerId).filter(Boolean);
  for (const ownerId of priorOwnerIds) await moveXtreamSources(ownerId, canonicalOwnerId);
  await deduplicateXtreamSources(canonicalOwnerId);
  await moveLibraryCategories(priorOwnerIds, canonicalOwnerId);
  await movePlaybackOwners(priorOwnerIds, canonicalOwnerId);
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

function identityAccountDocument({ email, passwordHash, createdAt = new Date(), updatedAt = new Date() }) {
  return {
    email, passwordHash, createdAt, updatedAt,
    providers: [], profiles: [], devices: [],
    realm: 'roku',
  };
}

function accountPasswordHash(account) { return account?.passwordHash || ''; }

async function linkAccountDevice(accountCollection, accountId, session) {
  const now = new Date();
  const device = { deviceId: String(session.deviceId), kind: 'roku', profileId: session.profileId || null, linkedAt: now, updatedAt: now };
  const replaced = await accountCollection.updateOne({ _id: accountId, 'devices.deviceId': device.deviceId }, { $set: { 'devices.$': device, updatedAt: now } });
  if (!replaced.matchedCount) await accountCollection.updateOne({ _id: accountId }, { $push: { devices: device }, $set: { updatedAt: now } });
}

const resetCodes = new Map();
const resetCodeTtlMs = 15 * 60 * 1000;
const signupVerifications = new Map();
const accountSignupVerifications = new Map();
function purgeResetCodes() {
  const now = Date.now();
  for (const [code, entry] of resetCodes) if (entry.expiresAt < now) resetCodes.delete(code);
}

// Always returns { ok: true } regardless of whether the email has an
// account, so the response can never be used to discover which emails are
// registered. The Roku login page just tells the user to check their inbox.
export async function requestPasswordReset(email, realm = 'roku') {
  purgeResetCodes();
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  const account = await (await accounts(realm)).findOne({ email: normalizedEmail }, { projection: { _id: 1 } });
  if (account) {
    const code = randomBytes(4).toString('hex').toUpperCase();
    resetCodes.set(code, { email: normalizedEmail, realm: normalizeAccountRealm(realm), accountId: String(account._id), expiresAt: Date.now() + resetCodeTtlMs });
    try { await sendPasswordResetEmail(normalizedEmail, code); }
    catch (error) { console.error('[password reset] email send failed:', error.message); }
  }
  return { ok: true };
}

export async function confirmPasswordReset(code, newPassword) {
  purgeResetCodes();
  const normalizedCode = String(code || '').trim().toUpperCase();
  const entry = resetCodes.get(normalizedCode);
  if (!entry) return { error: 'Reset code expired or invalid' };
  if (!validPassword(newPassword)) return { error: 'Password must contain at least 8 characters' };
  const passwordHash = hashPassword(newPassword);
  await (await accounts(entry.realm)).updateOne(
    { _id: new ObjectId(entry.accountId) },
    { $set: { passwordHash, updatedAt: new Date() }, $unset: { account: '', credentials: '', firstName: '', lastName: '' } },
  );
  resetCodes.delete(normalizedCode);
  return { ok: true };
}

export async function createDeviceSession(deviceId, deviceToken = '') {
  purge(true);
  const normalizedDeviceId = String(deviceId);
  const session = {
    code: randomBytes(18).toString('base64url'),
    deviceId: normalizedDeviceId,
    ownerId: ownerIdFor(normalizedDeviceId),
    // On-device signup remains available until the account is created.
    expiresAt: null,
    purpose: 'on-device-auth',
    realm: 'roku',
  };
  // Only an already-authenticated Roku may display an Android-remote QR. The
  // QR can connect Android to the Roku's existing account; it can never sign
  // the Roku in or create an account away from the TV.
  const authorization = resolveDeviceToken(deviceToken);
  if (authorization?.type === 'roku' && normalizeAccountRealm(authorization.realm) === 'roku' && authorization.deviceId === normalizedDeviceId && ObjectId.isValid(authorization.accountId)) {
    const profile = await (await profiles()).findOne({ deviceId: normalizedDeviceId, accountId: new ObjectId(authorization.accountId) }, { projection: { accountId: 1 } });
    if (profile?.accountId) {
      session.accountId = String(profile.accountId);
      session.ownerId = accountOwnerId(profile.accountId);
      session.profileId = authorization.profileId || null;
      session.purpose = 'android-remote';
      session.realm = 'roku';
      session.expiresAt = Date.now() + pairingTtlMs;
    }
  }
  sessions.set(session.code, session);
  const result = {
    code: session.code, deviceId: session.deviceId, expiresAt: session.expiresAt,
    purpose: session.purpose,
  };
  if (session.purpose === 'android-remote') {
    // Android intent only: deliberately omit browser_fallback_url. A camera
    // scan opens RH when installed and has no browser authentication path.
    const appPairUrl = `intent://pair?pair=${encodeURIComponent(session.code)}#Intent;scheme=rhstream;package=com.rhstream.library;end`;
    result.appPairUrl = appPairUrl;
    result.qrImageUrl = `https://quickchart.io/qr?size=190&text=${encodeURIComponent(appPairUrl)}`;
    // Separate QR for the browser auto-login card in Roku Settings: a plain
    // web URL (not an app intent) that opens the pairing page directly.
    const browserPairUrlObject = new URL(frontendUrl);
    browserPairUrlObject.search = '';
    browserPairUrlObject.hash = '';
    browserPairUrlObject.pathname = `${browserPairUrlObject.pathname.replace(/\/$/, '')}/`;
    browserPairUrlObject.searchParams.set('pair', session.code);
    result.pairUrl = browserPairUrlObject.toString();
    result.browserQrImageUrl = `https://quickchart.io/qr?size=190&text=${encodeURIComponent(result.pairUrl)}`;
  }
  return result;
}

export async function getRokuSourcePreference(accountId) {
  if (!accountId || !ObjectId.isValid(accountId)) return '';
  const account = await (await accounts()).findOne({ _id: new ObjectId(accountId) }, { projection: { rokuSourceId: 1 } });
  return String(account?.rokuSourceId || '');
}

export async function setRokuSourcePreference(accountId, sourceId) {
  if (!accountId || !ObjectId.isValid(accountId)) throw new Error('Account authentication is required');
  const value = String(sourceId || '').trim();
  const account = await (await accounts()).findOne({ _id: new ObjectId(accountId) }, { projection: { rokuSourceId: 1, ownerId: 1 } });
  await (await accounts()).updateOne({ _id: new ObjectId(accountId) }, { $set: { rokuSourceId: value, updatedAt: new Date() }, $unset: { selectedProviderId: '', preferences: '' } });
  // Same staleness fix as setProfileRokuSourcePreference, for accounts still
  // on the pre-profile source preference (see getRokuSourcePreferenceByOwner).
  if (account?.ownerId && value !== String(account.rokuSourceId || '')) {
  }
  return value;
}

export async function getRokuSourcePreferenceByOwner(ownerId) {
  if (!ownerId) return '';
  const profileSourceId = await getProfileRokuSourcePreferenceByOwner(ownerId);
  if (profileSourceId !== null) return profileSourceId;
  // Compatibility for an account created before provider choice moved onto
  // profiles. Only an owner with no profile record can reach this fallback.
  const account = await (await accounts()).findOne({ ownerId: String(ownerId) }, { projection: { rokuSourceId: 1 } });
  return String(account?.rokuSourceId || '');
}

// The inverse of resolveAccountByEmail - used to show the host's own name on
// the invite the partner receives.
export async function getAccountBasicInfo(accountId, realm = 'roku') {
  if (!accountId || !ObjectId.isValid(accountId)) return null;
  const account = await (await accounts(realm)).findOne({ _id: new ObjectId(accountId) }, { projection: { email: 1 } });
  if (!account) return null;
  return { email: account.email, name: '' };
}

// Read-only lookup used to route a Watch with Partner invite - no password
// check, unlike loginAccount. Returns null rather than throwing so callers
// can turn a missing/typo'd partner email into a clear user-facing error.
export async function resolveAccountByEmail(email, realm = 'roku') {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return null;
  const account = await (await accounts(realm)).findOne({ email: normalizedEmail }, { projection: { _id: 1, email: 1 } });
  if (!account) return null;
  return { accountId: String(account._id), ownerId: accountOwnerId(account._id), email: account.email, name: '' };
}

// Every account's ownerId, for the ops dashboard to join against
// getAllXtreamSources() (whose docs only carry ownerId, not accountId/email).
export async function listAllAccountsBasic() {
  const [rokuRows, generalRows] = await Promise.all([
    (await accounts('roku')).find({}, { projection: { email: 1 } }).toArray(),
    (await accounts('general')).find({}, { projection: { email: 1 } }).toArray(),
  ]);
  return [...rokuRows.map(account => ({ ...account, realm: 'roku' })), ...generalRows.map(account => ({ ...account, realm: 'general' }))].map(account => ({
    accountId: String(account._id),
    ownerId: accountOwnerId(account._id),
    email: account.email || '',
    realm: account.realm,
  }));
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

export async function isProfileOnline(accountId, profileId) {
  if (!accountId || !ObjectId.isValid(accountId) || !profileId) return false;
  const since = new Date(Date.now() - runningWindowMs);
  const device = await (await profiles()).findOne(
    { accountId: new ObjectId(accountId), profileId: String(profileId), lastSeenAt: { $gte: since } },
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
  return { deviceId: session.deviceId, expiresAt: session.expiresAt, needsSignup: false, purpose: session.purpose, authenticated, canAutoLogin: session.purpose === 'android-remote' && Boolean(session.accountId) && !session.approvedAt };
}

// Passwordless browser login: same trust model as autoLoginDeviceSession
// below - the Roku that generated this code already proved it owns the
// account (createDeviceSession only mints purpose:'android-remote' codes
// from an authenticated Roku session), so scanning it is sufficient proof.
export async function claimAutomaticPairing(code) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  if (session.purpose !== 'android-remote' || !session.accountId) return { error: 'Sign in on the Roku before scanning' };
  session.approvedAt = Date.now();
  return { token: issueToken(session, 'browser'), deviceId: session.deviceId };
}

// Approve a Roku pairing with the account already authenticated on the phone.
// This never trusts the QR by itself: the caller must present a valid browser
// token for the same account, and a Roku owned by another account is rejected.
export async function authorizeDeviceSession(code, token) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  const authorization = resolveDeviceToken(token);
  if (session.purpose !== 'android-remote' || !session.accountId) return { error: 'Sign in on the Roku before pairing Android' };
  if (authorization?.type !== 'browser' || !ObjectId.isValid(authorization.accountId)) return { error: 'Sign in to the RH Android app first' };
  if (normalizeAccountRealm(authorization.realm) !== 'roku') return { error: 'Select Roku User and sign in with the Roku RH account' };
  if (String(authorization.accountId) !== String(session.accountId)) return { error: 'Sign in with the RH account already connected to this Roku' };
  session.approvedAt = Date.now();
  return { ok: true, deviceId: session.deviceId, purpose: 'android-remote' };
}

// Passwordless login: the Roku that generated this code already proved it
// owns the account (createDeviceSession only mints purpose:'android-remote'
// codes from an authenticated Roku session), so scanning it is treated as
// sufficient proof for Android too - no email/password re-entry.
export async function autoLoginDeviceSession(code) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  if (session.purpose !== 'android-remote' || !session.accountId) return { error: 'Sign in on the Roku before scanning' };
  session.approvedAt = Date.now();
  return { token: issueToken(session, 'browser'), deviceId: session.deviceId };
}

export async function verifyDeviceSignupCode(code, email, verificationCode) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  if (session.purpose === 'android-remote') return { error: 'Sign in through the RH Android app, then scan again' };
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  const pending = await findUnverifiedAccount(normalizedEmail);
  if (!pending) return { error: 'Verification code not found' };
  if (pending.email !== normalizedEmail || pending.code !== String(verificationCode || '').trim()) {
    return { error: 'Incorrect verification code', verificationInvalid: true };
  }
  // Roku collects the password after this verification screen. Keep the
  // verified code in the unverified_accounts array until setupDeviceSession
  // creates the account with the password the viewer enters next.
  session.signupVerified = true;
  return { verificationValid: true };
}

async function approveSignupSession(code, accountId) {
  const session = getDeviceSession(code);
  if (!session) throw Object.assign(new Error('Pairing code expired or invalid'), { status: 404 });
  const deviceCollection = await profiles();
  const deviceOwnerId = ownerIdFor(session.deviceId);
  await consolidateAccountLibrary(accountId);
  session.accountId = String(accountId);
  session.profileId = null;
  session.ownerId = accountOwnerId(accountId);
  await deviceCollection.updateOne(
    { deviceId: session.deviceId },
    { $setOnInsert: { ownerId: deviceOwnerId, deviceId: session.deviceId, createdAt: new Date() }, $set: { accountId, profileId: null, linkedAt: new Date(), updatedAt: new Date() } },
    { upsert: true },
  );
  await linkAccountDevice(accountCollection, account._id, session);
  session.approvedAt = Date.now();
  return issueToken(session, 'roku');
}

async function getSignupSession(code, email) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  if (session.purpose === 'android-remote') return { error: 'Sign in through the RH Android app, then scan again' };
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  if (await (await accounts('roku')).findOne({ email: normalizedEmail }, { projection: { _id: 1 } })) {
    return { error: 'An account with this email already exists. Sign in instead.' };
  }
  return { session, normalizedEmail };
}

export async function requestDeviceSignupVerification(code, email, password, firstName = '', lastName = '') {
  const context = await getSignupSession(code, email);
  if (context.error) return context;
  const { normalizedEmail } = context;
  context.session.expiresAt = null;
  if (await isEmailVerified(normalizedEmail, 'roku')) return { verificationNotRequired: true };
  const pending = await findUnverifiedAccount(normalizedEmail);
  if (pending && pending.email === normalizedEmail) {
    {
      // Keep the current signup attempt authoritative if the viewer backed
      // out and started again with the same email.
      context.session.signupPasswordHash = validPassword(password) ? hashPassword(password) : context.session.signupPasswordHash || '';
      return { verificationRequired: true, verificationPending: true };
    }
  }
  const signupCode = String(randomInt(100000, 1000000));
  context.session.signupPasswordHash = validPassword(password) ? hashPassword(password) : '';
  await saveUnverifiedAccount(normalizedEmail, { code: signupCode, updatedAt: new Date() });
  try { await sendSignupVerificationEmail(normalizedEmail, signupCode); }
  catch (error) {
    await saveUnverifiedAccount(normalizedEmail, { updatedAt: new Date() });
    console.error('[signup verification] email send failed:', error.message);
    return { error: 'Verification email could not be sent. Please try again.' };
  }
  return { verificationRequired: true, verificationSent: true };
}

export async function resendDeviceSignupVerification(code, email) {
  const context = await getSignupSession(code, email);
  if (context.error) return context;
  const { normalizedEmail } = context;
  const pending = await findUnverifiedAccount(normalizedEmail);
  if (!pending || pending.email !== normalizedEmail) return { error: 'Verification session not found. Request a new code.' };
  const signupCode = String(randomInt(100000, 1000000));
  await saveUnverifiedAccount(normalizedEmail, { code: signupCode, updatedAt: new Date() });
  try { await sendSignupVerificationEmail(normalizedEmail, signupCode, true); }
  catch (error) {
    await saveUnverifiedAccount(normalizedEmail, { updatedAt: new Date() });
    console.error('[signup verification] email send failed:', error.message);
    return { error: 'Verification email could not be sent. Please try again.' };
  }
  return { verificationResent: true };
}

async function consumePairing(code, email, password, setup, firstName = '', lastName = '', verificationCode = '', verificationBypassed = false) {
  const session = getDeviceSession(code);
  if (!session) return { error: 'Pairing code expired or invalid' };
  if (session.purpose === 'android-remote') return { error: 'Sign in through the RH Android app, then scan again' };
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  if (!validPassword(password) && !(setup && !verificationCode)) return { error: 'Password must contain at least 8 characters' };
  const deviceCollection = await profiles();
  const accountCollection = await accounts('roku');
  const deviceOwnerId = ownerIdFor(session.deviceId);
  const profile = await deviceCollection.findOne({ deviceId: session.deviceId });
  let account;
  let createdAccount = false;
  if (setup) {
    if (profile?.accountId) return { error: 'This Roku is already activated. Sign in instead.' };
    if (await accountCollection.findOne({ email: normalizedEmail }, { projection: { _id: 1 } })) return { error: 'An account with this email already exists. Sign in instead.' };
    if (!verificationCode && !verificationBypassed) {
      return requestDeviceSignupVerification(code, normalizedEmail, password, firstName, lastName);
    }
    const pending = await findUnverifiedAccount(normalizedEmail);
    if (verificationBypassed) {
      if (!(await isEmailVerified(normalizedEmail, 'roku'))) return { error: 'Verification code expired or invalid' };
      await deleteUnverifiedAccount(normalizedEmail);
    } else if (!pending) {
      await deleteUnverifiedAccount(normalizedEmail);
      return { error: 'Verification code expired or invalid' };
    } else {
      if (pending.email !== normalizedEmail || pending.code !== String(verificationCode).trim()) return { error: 'Incorrect verification code' };
      await markEmailVerified(normalizedEmail, 'roku');
      if (!session.signupPasswordHash && !validPassword(password)) return { error: 'Password must contain at least 8 characters' };
      await deleteUnverifiedAccount(normalizedEmail);
    }
    let created;
    try {
      created = await accountCollection.insertOne(identityAccountDocument({ email: normalizedEmail, passwordHash: session.signupPasswordHash || hashPassword(password) }));
    } catch (error) {
      if (error?.code === 11000) return { error: 'An account with this email already exists. Sign in instead.' };
      throw error;
    }
    account = { _id: created.insertedId };
    createdAccount = true;
  } else {
    account = await accountCollection.findOne({ email: normalizedEmail });
    // A profile created by the earlier device-password implementation can be
    // adopted on its first successful sign-in without losing its library.
    if (!account && profile?.email === normalizedEmail && verifyPassword(password, profile.passwordHash)) {
      const created = await accountCollection.insertOne(identityAccountDocument({ email: normalizedEmail, passwordHash: profile.passwordHash, createdAt: profile.createdAt || new Date() }));
      account = { _id: created.insertedId };
    }
    if (!account || !verifyPassword(password, accountPasswordHash(account))) return { error: 'Incorrect email or password' };
  }
  session.accountId = String(account._id);
  const canonicalOwner = await consolidateAccountLibrary(account._id);
  let selectedProfile = null;
  if (profile?.accountId && String(profile.accountId) === String(account._id) && profile.profileId) {
    selectedProfile = await getAccountProfile(account._id, profile.profileId);
  }
  session.profileId = selectedProfile?.id || null;
  session.ownerId = selectedProfile?.isDefault ? canonicalOwner : selectedProfile?.ownerId || canonicalOwner;
  await deviceCollection.updateOne(
    { deviceId: session.deviceId },
    { $setOnInsert: { ownerId: deviceOwnerId, deviceId: session.deviceId, createdAt: new Date() }, $set: { accountId: account._id, profileId: session.profileId, linkedAt: new Date(), updatedAt: new Date() } },
    { upsert: true },
  );
  session.approvedAt = Date.now();
  return { token: issueToken(session, 'browser'), deviceId: session.deviceId };
}

export function setupDeviceSession(code, email, password, firstName, lastName, verificationCode, verificationBypassed = false) { return consumePairing(code, email, password, true, firstName, lastName, verificationCode, verificationBypassed); }
export function loginDeviceSession(code, email, password) { return consumePairing(code, email, password, false); }

export async function registerAccount(email, password, firstName = '', lastName = '', realm = 'general', verificationId = '', verificationCode = '') {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return { error: 'Enter a valid email address' };
  if (!validPassword(password)) return { error: 'Password must contain at least 8 characters' };
  const collection = await accounts(realm);
  if (await collection.findOne({ email: normalizedEmail }, { projection: { _id: 1 } })) return { error: 'An account with this email already exists. Sign in instead.' };
  let passwordHash = hashPassword(password);
  if (!verificationId) {
    if (await isEmailVerified(normalizedEmail, realm)) {
      const created = await collection.insertOne(identityAccountDocument({ email: normalizedEmail, passwordHash }));
      return { ok: true };
    }
    const id = randomBytes(18).toString('base64url');
    const code = String(randomInt(100000, 1000000));
    accountSignupVerifications.set(id, { email: normalizedEmail, passwordHash, firstName: String(firstName || '').trim().slice(0, 60), lastName: String(lastName || '').trim().slice(0, 60), realm: normalizeAccountRealm(realm), code });
    try { await sendSignupVerificationEmail(normalizedEmail, code); }
    catch (error) { console.error('[signup verification] email send failed:', error.message); }
    return { verificationRequired: true, verificationId: id };
  }
  const pending = accountSignupVerifications.get(String(verificationId));
  if (!pending || pending.email !== normalizedEmail || pending.realm !== normalizeAccountRealm(realm) || pending.code !== String(verificationCode).trim()) {
    accountSignupVerifications.delete(String(verificationId));
    return { error: 'Verification code expired or invalid' };
  }
  accountSignupVerifications.delete(String(verificationId));
  passwordHash = pending.passwordHash;
  await markEmailVerified(normalizedEmail, realm);
  try {
    const created = await collection.insertOne(identityAccountDocument({ email: normalizedEmail, passwordHash }));
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
  if (!profileId) return null;
  const selected = await getAccountProfile(accountId, profileId);
  return selected?.id || null;
}

export async function getLinkedDevices(accountId, profileId = '') {
  if (!ObjectId.isValid(accountId)) return [];
  const selectedProfileId = await accountProfileId(accountId, profileId);
  const deviceCollection = await profiles();
  // The "Linked Roku devices" list (Android + browser Settings, Android welcome
  // page) is Roku-only and ACCOUNT-scoped - every profile of an RH account sees
  // the same Roku devices (they belong to the account, not one profile).
  // Browser tabs and the Android app's own presence heartbeat (kind 'browser' /
  // 'android') do not belong here. The dashboard's Connected Devices page uses
  // listAllLinkedDevices() instead and still shows every kind.
  void selectedProfileId;
  const rows = await (await profiles()).find(
    { accountId: new ObjectId(accountId), kind: { $nin: ['browser', 'android'] } },
    { projection: { deviceId: 1, profileId: 1, linkedAt: 1, updatedAt: 1, lastSeenAt: 1, lastStreamingSeenAt: 1, lastClientIp: 1, lanIp: 1, ecpAppId: 1, kind: 1, label: 1 } },
  ).sort({ linkedAt: 1 }).toArray();
  return rows.map(device => ({
    id: String(device._id),
    deviceId: device.deviceId,
    profileId: device.profileId,
    kind: 'roku',
    linkedAt: device.linkedAt || device.updatedAt || null,
    lastSeenAt: device.lastSeenAt || null,
    lastClientIp: device.lastClientIp || '',
    lanIp: device.lanIp || device.lastClientIp || '',
    ecpAppId: device.ecpAppId || '',
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

export async function getDeviceWeatherLocations(ownerId, accountId = '', deviceId = '', realm = 'roku') {
  void deviceId;
  if (!ownerId) return [];
  if (ObjectId.isValid(accountId)) {
    const account = await (await accounts(realm)).findOne(
      { _id: new ObjectId(accountId) },
      { projection: { weatherLocations: 1 } },
    );
    if (Array.isArray(account?.weatherLocations)) return account.weatherLocations.slice(0, 1);
  }
  return [];
}

export async function saveDeviceWeatherLocations(ownerId, locations, accountId = '', deviceId = '', realm = 'roku') {
  void deviceId;
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
  if (!ObjectId.isValid(accountId)) return { error: 'Account authentication is required' };
  const result = await (await accounts(realm)).updateOne(
    { _id: new ObjectId(accountId) },
    { $set: { weatherLocations, updatedAt: new Date() } },
  );
  return result.matchedCount ? { locations: weatherLocations } : { error: 'Linked Roku profile not found' };
}

export async function recordDeviceHeartbeat(deviceId, streaming = false, clientIp = '', extra = {}) {
  const normalized = String(deviceId || '').trim();
  if (!normalized) return;
  const now = Date.now();
  const ip = String(clientIp || '').replace(/^::ffff:/, '').trim();
  const lanIp = String(extra.lanIp || '').trim();
  const ecpAppId = String(extra.ecpAppId || '').trim();
  const sourceId = String(extra.sourceId || '').trim();
  const previous = heartbeatCache.get(normalized) || { at: 0, streaming: false, ip: '', lanIp: '', ecpAppId: '', sourceId: '' };
  if (now - previous.at < heartbeatIntervalMs && previous.streaming === Boolean(streaming)
      && previous.ip === ip && previous.lanIp === lanIp && previous.ecpAppId === ecpAppId
      && previous.sourceId === sourceId) return;
  heartbeatCache.set(normalized, { at: now, streaming: Boolean(streaming), ip, lanIp, ecpAppId, sourceId });
  try {
    const update = { $set: { lastSeenAt: new Date(now) } };
    if (ip) update.$set.lastClientIp = ip;
    if (lanIp) update.$set.lanIp = lanIp;
    if (ecpAppId) update.$set.ecpAppId = ecpAppId;
    if (streaming) {
      update.$set.lastStreamingSeenAt = new Date(now);
      if (sourceId) update.$set.streamingSourceId = sourceId;
      else update.$unset = { streamingSourceId: '' };
    } else update.$unset = { lastStreamingSeenAt: '', streamingSourceId: '' };
    await (await profiles()).updateOne({ deviceId: normalized }, update);
  } catch {
    heartbeatCache.delete(normalized);
  }
}

// Every linked device across all accounts, for the local operations dashboard.
export async function listAllLinkedDevices() {
  const [deviceRows, rokuAccountRows, generalAccountRows] = await Promise.all([
    (await profiles()).find({}, {
      projection: {
        deviceId: 1, accountId: 1, profileId: 1, linkedAt: 1, updatedAt: 1,
        lastSeenAt: 1, lastStreamingSeenAt: 1, streamingSourceId: 1, lastClientIp: 1, lanIp: 1, ecpAppId: 1, kind: 1, label: 1,
      },
    }).sort({ lastSeenAt: -1 }).toArray(),
    (await accounts('roku')).find({}, { projection: { email: 1, rokuSourceId: 1, ownerId: 1 } }).toArray(),
    (await accounts('general')).find({}, { projection: { email: 1, rokuSourceId: 1, ownerId: 1 } }).toArray(),
  ]);
  const accountRows = [...rokuAccountRows, ...generalAccountRows];
  const accountById = new Map(accountRows.map(row => [String(row._id), row]));
  return Promise.all(deviceRows.map(async row => {
    const account = accountById.get(String(row.accountId || '')) || null;
    const selectedProfile = account && row.profileId
      ? await getAccountProfile(String(row.accountId), String(row.profileId)).catch(() => null)
      : null;
    return {
      deviceId: row.deviceId,
      accountId: String(row.accountId || ''),
      accountEmail: account?.email || '',
      accountOwnerId: account?.ownerId || (row.accountId ? accountOwnerId(row.accountId) : ''),
      // Provider selection is profile-specific. The account field is retained
      // only as a legacy fallback for devices not yet assigned a profile.
      rokuSourceId: selectedProfile?.rokuSourceId || account?.rokuSourceId || '',
      streamingProviderId: row.streamingSourceId || '',
      profileId: row.profileId || '',
      profileName: selectedProfile?.name || '',
      profileOwnerId: selectedProfile?.ownerId || (selectedProfile?.isDefault ? accountOwnerId(row.accountId) : ''),
      kind: row.kind === 'browser' || row.kind === 'android' ? row.kind : 'roku',
      label: row.kind === 'browser' || row.kind === 'android' ? (row.label || (row.kind === 'android' ? 'Android' : 'Browser')) : '',
      linkedAt: row.linkedAt || null,
      lastSeenAt: row.lastSeenAt || null,
      lastStreamingSeenAt: row.lastStreamingSeenAt || null,
      lastClientIp: row.lastClientIp || '',
      lanIp: row.lanIp || row.lastClientIp || '',
      ecpAppId: row.ecpAppId || '',
    };
  }));
}

export async function unlinkAccountDevice(accountId, deviceId, profileId = '') {
  if (!ObjectId.isValid(accountId) || !deviceId) return { error: 'Invalid device' };
  // Account-scoped: any profile can unlink any of the account's Roku devices.
  void profileId;
  const result = await (await profiles()).updateOne(
    { accountId: new ObjectId(accountId), deviceId: String(deviceId) },
    { $unset: { accountId: '', accountOwnerId: '', profileId: '' }, $set: { updatedAt: new Date() } },
  );
  return result.modifiedCount ? { ok: true } : { error: 'Linked Roku device not found' };
}

export async function isRokuSessionLinked(session) {
  if (session?.type !== 'roku' || !session?.ownerId || !session?.deviceId || !ObjectId.isValid(session?.accountId)) return false;
  // The profile is a sub-selection carried on the device row, not an auth gate.
  // A device still linked to this account stays authorized even when the
  // token's profile pointer differs from the row's last-selected profile
  // (e.g. a pairing token has no profileId, so it would otherwise resolve to
  // the default profile and 401 against a device linked under another profile).
  const profile = await (await profiles()).findOne(
    { deviceId: String(session.deviceId), accountId: new ObjectId(session.accountId) },
    { projection: { _id: 1 } },
  );
  return Boolean(profile);
}

export async function loginAccount(email, password, deviceId = '', realm = 'general') {
  const accountRealm = normalizeAccountRealm(realm);
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail) || !validPassword(password)) return { error: 'Incorrect email or password' };
  const account = await (await accounts(accountRealm)).findOne({ email: normalizedEmail });
  if (!account || !verifyPassword(password, accountPasswordHash(account))) return { error: 'Incorrect email or password' };
  const linked = await (await profiles()).find({ accountId: account._id }).toArray();
  const ownerId = await consolidateAccountLibrary(account._id, accountRealm) || accountOwnerId(account._id);
  if (!linked.length) return { token: issueToken({ ownerId, accountId: String(account._id), realm: accountRealm }, 'browser'), devices: [] };
  const devices = linked.map(device => ({ id: String(device._id), deviceId: device.deviceId, label: `Roku ${String(device.deviceId || '').replace(/^roku-/, '').slice(-8).toUpperCase()}` }));
  const selected = linked.find(device => deviceId && device.deviceId === deviceId) || (linked.length === 1 ? linked[0] : null);
  if (deviceId && !selected) return { error: 'Select a linked Roku device' };
  const session = { ownerId, deviceId: selected?.deviceId, accountId: String(account._id), realm: accountRealm };
  return { token: issueToken(session, 'browser'), devices };
}

export async function selectAccountProfile(accountId, profileId, authorization = {}, pin = '') {
  if (!ObjectId.isValid(accountId)) return { error: 'Sign in to choose a profile' };
  const profile = await getAccountProfile(accountId, profileId);
  if (!profile) return { error: 'Profile not found' };
  if (profile.pinHash && !verifyProfilePin(pin, profile.pinHash)) return { error: 'Incorrect profile PIN', code: 'PROFILE_PIN_REQUIRED' };
  const session = {
    ownerId: profile.ownerId,
    profileId: profile.id,
    accountId: String(accountId),
    realm: normalizeAccountRealm(authorization.realm),
    deviceId: authorization.deviceId || undefined,
  };
  // A Roku deep link must resume with the last non-child profile without
  // inserting a profile chooser. Persist the selection on the linked device,
  // not just inside the newly minted token.
  if (authorization.type === 'roku' && authorization.deviceId) {
    await (await profiles()).updateOne(
      { deviceId: String(authorization.deviceId), accountId: new ObjectId(String(accountId)) },
      { $set: { profileId: profile.id, updatedAt: new Date() } },
    );
  }
  return {
    token: issueToken(session, authorization.type === 'roku' ? 'roku' : 'browser'),
    profile: { id: profile.id, name: profile.name, avatar: profile.avatar || 'lime', avatarImage: profile.avatarImage || '', hasPin: Boolean(profile.pinHash), isDefault: profile.isDefault === true },
  };
}

export async function changeAccountPassword(accountId, currentPassword, newPassword, realm = 'roku') {
  if (!ObjectId.isValid(accountId)) return { error: 'Sign in to change your password' };
  if (!validPassword(currentPassword) || !validPassword(newPassword)) return { error: 'Passwords must contain at least 8 characters' };
  const collection = await accounts(realm);
  const account = await collection.findOne({ _id: new ObjectId(accountId) });
  if (!account || !verifyPassword(currentPassword, accountPasswordHash(account))) return { error: 'Current password is incorrect' };
  const passwordHash = hashPassword(newPassword);
  await collection.updateOne({ _id: account._id }, { $set: { passwordHash, updatedAt: new Date() }, $unset: { account: '', credentials: '', firstName: '', lastName: '' } });
  return { ok: true };
}

export async function deleteAccount(accountId, currentPassword, realm = 'roku') {
  if (!ObjectId.isValid(accountId)) return { error: 'Sign in to delete your account' };
  if (!validPassword(currentPassword)) return { error: 'Enter your current password' };
  const collection = await accounts(realm);
  const normalizedAccountId = new ObjectId(String(accountId));
  const account = await collection.findOne({ _id: normalizedAccountId });
  if (!account || !verifyPassword(currentPassword, accountPasswordHash(account))) return { error: 'Current password is incorrect' };
  await deleteAccountProfilesAndData(accountId);
  await collection.deleteOne({ _id: normalizedAccountId });
  for (const [code, session] of sessions) if (String(session.accountId || '') === String(accountId)) sessions.delete(code);
  try { await sendAccountDeletionEmail(account.email); }
  catch (error) { console.error('[account deletion] goodbye email failed:', error.message); }
  return { ok: true };
}

// Phone "Play on Roku" handoff: re-home the target Roku to the sender's
// account + profile and mint it a fresh Roku token. Mirrors the device-doc
// upsert in authorizeDeviceSession, minus the QR/browser-token check (the
// caller already verified the sender's account token and that this deviceId
// belongs to one of its linked devices).
export async function castHandoffLink(deviceId, accountId, profileId) {
  if (!deviceId || !ObjectId.isValid(accountId)) return { error: 'Invalid cast target' };
  const account = new ObjectId(accountId);
  const selectedProfile = profileId
    ? await getAccountProfile(account, profileId)
    : null;
  if (!selectedProfile) return { error: 'Profile not found' };
  const deviceCollection = await profiles();
  await deviceCollection.updateOne(
    { deviceId: String(deviceId) },
    { $setOnInsert: { ownerId: ownerIdFor(deviceId), deviceId: String(deviceId), createdAt: new Date() },
      $set: { accountId: account, profileId: selectedProfile.id, linkedAt: new Date(), updatedAt: new Date() } },
    { upsert: true },
  );
  const session = {
    deviceId: String(deviceId),
    accountId: String(account),
    profileId: selectedProfile.id,
    ownerId: selectedProfile.isDefault ? await consolidateAccountLibrary(account) : selectedProfile.ownerId,
  };
  return { token: issueToken(session, 'roku'), profileName: selectedProfile.name || '' };
}

export function resolveDeviceToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.ownerId || data.exp <= Date.now()) return null;
    return { ...data, realm: normalizeAccountRealm(data.realm), ownerId: canonicalSessionOwner(data) };
  } catch { return null; }
}
