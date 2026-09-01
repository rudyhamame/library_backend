import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeArabicForRoku } from './arabic-shaper.js';
import { createXtreamSource, deleteXtreamSource, getAllXtreamSources, getXtreamSource, getXtreamSources, publicXtreamSource, updateXtreamSelection, updateXtreamSource } from './xtream-store.js';
import { evictXtreamCache, getXtreamCatalog, getXtreamCategories, getXtreamMovieInfo, getXtreamSeriesEpisodes, validateXtreamConnection, xtreamCacheStats, xtreamProviderUrl } from './xtream.js';
import { evictM3uCache, getM3uCatalog, getM3uCategories, m3uCacheStats, m3uProviderUrl, validateM3uConnection } from './m3u.js';
import { MediaCapacityError, MediaJobManager, defaultMediaLimits, memoryPressure } from './media-job-manager.js';
import { HlsStrategy, PlaybackStrategy, choosePlaybackStrategy, determineHlsStrategy, hlsCodecArgs } from './playback-strategy.js';
import { getStreamingContinueWatching, getStreamingHistory, getStreamingResume, saveStreamingHistory } from './streaming-history-store.js';
import { getFavorites, toggleFavorite } from './favorites-store.js';
import { authorizeDeviceSession, changeAccountPassword, claimAutomaticPairing, createDeviceSession, getDeviceWeatherLocations, getLinkedDevices, getPairingInfo, getRokuDeviceSessionStatus, isRokuSessionLinked, loginAccount, loginDeviceSession, recordDeviceHeartbeat, registerAccount, resolveDeviceToken, saveDeviceWeatherLocations, selectAccountProfile, setupDeviceSession, unlinkAccountDevice } from './device-sessions.js';
import { createAccountProfile, deleteAccountProfile, getAccountProfiles, updateAccountProfile } from './account-profile-store.js';
import { createLibraryCategory, deleteLibraryCategory, getManagedLibrary, renameLibraryCategory, replaceLibraryCategoryItems } from './library-category-store.js';
import { enforceLibraryOnly } from './library-route-policy.js';
import { checkPlaylistSources } from './playlist-health.js';
import { getAiRecommendations } from './ai-recommendations.js';

const app = express();
app.use(enforceLibraryOnly);
const port = process.env.PORT || 8787;
const dashboardCache = new Map();
const playlistHealthCache = new Map();
const playlistHealthInFlight = new Map();
const playlistHealthTtlMs = Math.max(10_000, Number.parseInt(process.env.PLAYLIST_HEALTH_TTL_MS || '30000', 10) || 30_000);
const arabicText = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const rokuText = (value) => arabicText.test(String(value || '')) ? shapeArabicForRoku(value) : String(value || '');
const normalizeSearchText = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
  .replace(/[\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/[ى]/g, 'ي')
  .replace(/[ة]/g, 'ه')
  .replace(/[ؤ]/g, 'و')
  .replace(/[ئ]/g, 'ي')
  .replace(/[پ]/g, 'ب')
  .replace(/[چ]/g, 'ج')
  .replace(/[ڤ]/g, 'ف')
  .replace(/[گ]/g, 'ك')
  .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06F0))
  .toLocaleLowerCase()
  .replace(/\s+/g, ' ')
  .trim();
// Roku cannot reliably receive a JSON document containing a provider's entire
// catalog (this source alone has 44,995 series). Keep the initial screen fast;
// additional catalog pages are loaded separately by the Roku client.
// Each series can contain hundreds of episode records. A small page is
// intentional on Render's 256 MB instance; Roku loads further pages only when
// the user reaches the end of the current series list.
const rokuInitialSeriesLimit = Math.min(4, Math.max(1, Number.parseInt(process.env.ROKU_INITIAL_SERIES_LIMIT || '4', 10)));
const rokuMoviePageLimit = 10;
const rokuCatalogPageLimit = 10;
const xtreamItemsInFlight = new Map();
const rokuHlsRoot = path.join(os.tmpdir(), 'rh-stream-hls');
const frontendUrl = process.env.FRONTEND_URL || 'https://rh-stream-frontend.onrender.com';
const mediaLimits = defaultMediaLimits();
const debugMediaLogging = String(process.env.DEBUG_MEDIA_LOGGING || 'false').toLowerCase() === 'true';
const mediaJobs = new MediaJobManager({ limits: mediaLimits, debug: debugMediaLogging });
const hlsMaxSegments = Math.max(12, Number.parseInt(process.env.HLS_MAX_SEGMENTS || '36', 10) || 36);
const mediaStreamIdleTimeoutMs = Math.max(10_000, Number.parseInt(process.env.MEDIA_STREAM_IDLE_TIMEOUT_MS || '45000', 10) || 45_000);
const libraryRevisions = new Map();
const libraryRevisionWaiters = new Map();
let activeDirectStreams = 0;
let shuttingDown = false;
let mediaRequestSequence = 0;
const movieDurationCache = new Map();
const movieDurationCacheMaxEntries = 100;
const movieDurationCacheTtlMs = 24 * 60 * 60 * 1000;
const streamTicketSecret = process.env.DEVICE_AUTH_SECRET || 'local-development-secret-change-before-production';

function issueStreamTicket(ownerId, sourceId, kind, id) {
  const payload = Buffer.from(JSON.stringify({ ownerId, sourceId, kind, id, exp: Date.now() + 5 * 60_000 })).toString('base64url');
  const signature = createHmac('sha256', streamTicketSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function resolveStreamTicket(token, sourceId, kind, id) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', streamTicketSecret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.ownerId && data.exp > Date.now() && data.sourceId === sourceId && data.kind === kind && data.id === id ? data : null;
  } catch { return null; }
}

const sourceType = source => source?.type === 'm3u' ? 'm3u' : 'xtream';
const getSourceCatalog = (source, kind, category = 'all') => sourceType(source) === 'm3u' ? getM3uCatalog(source, kind) : getXtreamCatalog(source, kind, category);
const getSourceCategories = (source, kind) => sourceType(source) === 'm3u' ? getM3uCategories(source, kind) : getXtreamCategories(source, kind);
const sourceProviderUrl = (source, kind, id, extension = '') => sourceType(source) === 'm3u' ? m3uProviderUrl(source, kind, id) : xtreamProviderUrl(source, kind, id, extension);

function libraryRevision(ownerId) {
  return libraryRevisions.get(String(ownerId || '')) || 1;
}

function bumpLibraryRevision(ownerId) {
  const key = String(ownerId || '');
  if (!key) return;
  const revision = libraryRevision(key) + 1;
  libraryRevisions.set(key, revision);
  const waiters = libraryRevisionWaiters.get(key);
  if (!waiters) return;
  libraryRevisionWaiters.delete(key);
  for (const waiter of waiters) waiter(revision);
}

function waitForLibraryRevision(ownerId, since, timeoutMs = 25_000) {
  const key = String(ownerId || '');
  const current = libraryRevision(key);
  if (current !== since) return Promise.resolve(current);
  return new Promise(resolve => {
    const waiters = libraryRevisionWaiters.get(key) || new Set();
    let timer;
    const finish = revision => {
      clearTimeout(timer);
      waiters.delete(finish);
      if (!waiters.size) libraryRevisionWaiters.delete(key);
      resolve(revision);
    };
    waiters.add(finish);
    libraryRevisionWaiters.set(key, waiters);
    timer = setTimeout(() => finish(libraryRevision(key)), timeoutMs);
    timer.unref?.();
  });
}

function mediaIdentity(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  const session = resolveDeviceToken(token);
  const ticket = resolveStreamTicket(req.query.streamTicket, req.params.sourceId, req.params.kind, req.params.id);
  return {
    userId: String(session?.ownerId || ticket?.ownerId || ''),
    deviceId: String(session?.deviceId || ''),
    viewerId: String(session?.deviceId || session?.ownerId || ticket?.ownerId || req.ip || 'anonymous'),
  };
}

function appendTail(current, chunk, maxBytes = 8_000) {
  return `${current}${chunk}`.slice(-maxBytes);
}

function redactSensitiveUrl(value) {
  const text = String(value || '');
  try {
    const parsed = new URL(text);
    for (const key of ['deviceToken', 'token', 'access_token']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return text.replace(/([?&](?:deviceToken|token|access_token)=)[^&\s]*/gi, '$1[redacted]');
  }
}

async function probeMediaDuration(inputUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-rw_timeout', '15000000',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', inputUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Movie duration probe timed out'));
    }, 20_000);
    timeout.unref?.();
    child.stdout.on('data', chunk => { output = appendTail(output, chunk, 1024); });
    child.stderr.on('data', chunk => { errorOutput = appendTail(errorOutput, chunk, 2048); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      const seconds = Number.parseFloat(output.trim());
      if (code === 0 && Number.isFinite(seconds) && seconds > 0) resolve(Math.floor(seconds));
      else reject(new Error(errorOutput.trim() || 'Movie duration is unavailable'));
    });
  });
}

function capacityResponse(res, error) {
  if (!(error instanceof MediaCapacityError)) return false;
  res.setHeader('Retry-After', String(error.retryAfterSeconds));
  res.status(error.statusCode).json({ error: error.message, code: 'MEDIA_CAPACITY_FULL' });
  return true;
}

function terminateChild(child, graceMs = 1_500) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    let forceTimer;
    const done = () => { if (finished) return; finished = true; clearTimeout(forceTimer); resolve(); };
    child.once('close', done);
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (!finished && child.exitCode === null) child.kill('SIGKILL');
      done();
    }, graceMs);
    forceTimer.unref?.();
  });
}

async function hlsDiskUsageBytes() {
  let total = 0;
  try {
    for (const directory of await fs.readdir(rokuHlsRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      for (const file of await fs.readdir(path.join(rokuHlsRoot, directory.name), { withFileTypes: true })) {
        if (!file.isFile()) continue;
        total += (await fs.stat(path.join(rokuHlsRoot, directory.name, file.name))).size;
      }
    }
  } catch { /* The HLS root may not exist during startup or shutdown. */ }
  return total;
}

async function enforceHlsFileBound(job) {
  if (!job?.directory) return;
  try {
    const segments = (await fs.readdir(job.directory))
      .filter(name => /^segment-\d{6}\.ts$/.test(name))
      .sort();
    const obsolete = segments.slice(0, Math.max(0, segments.length - hlsMaxSegments));
    await Promise.allSettled(obsolete.map(name => fs.rm(path.join(job.directory, name), { force: true })));
  } catch { /* Job cleanup may race this safety sweep. */ }
}

function requestOwner(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  const session = resolveDeviceToken(token);
  return session?.ownerId || null;
}

function requestDevice(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  return resolveDeviceToken(token)?.deviceId || null;
}

function mediaOwner(req) {
  return requestOwner(req) || resolveStreamTicket(
    req.query.streamTicket, req.params.sourceId, req.params.kind, req.params.id,
  )?.ownerId || null;
}

function requestAccount(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  return resolveDeviceToken(token)?.accountId || null;
}

function cityIsoMinute(timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function cityClock(timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return {
    year, month, day,
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function freshDashboardTimes(data) {
  return { ...data, cities: (data?.cities || []).map(city => ({
    ...city,
    time: cityIsoMinute(city.timezone || 'UTC'),
    clock: cityClock(city.timezone || 'UTC'),
  })) };
}

function rokuPage(req, defaultLimit) {
  const page = Math.max(0, Number.parseInt(req.query.page || '0', 10) || 0);
  const requestedLimit = Number.parseInt(req.query.limit || String(defaultLimit), 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : defaultLimit));
  return { page, limit, offset: page * limit };
}

function rokuPagePayload(items, pageInfo) {
  const total = items.length;
  const pageItems = items.slice(pageInfo.offset, pageInfo.offset + pageInfo.limit);
  return { items: pageItems, page: pageInfo.page, limit: pageInfo.limit, total, hasMore: pageInfo.offset + pageItems.length < total };
}

function detectXtreamLanguage(item, category) {
  const text = `${category || ''} ${item.title || ''}`;
  const categoryCode = String(category || '').match(/^\s*([A-Za-z]{2})\s*(?:[|:\-]|$)/)?.[1]?.toUpperCase();
  const categoryLanguages = {
    AR: 'Arabic', EN: 'English', AF: 'Afghan', AL: 'Albanian', BE: 'Belarusian', BG: 'Bulgarian',
    DE: 'German', ES: 'Spanish', FR: 'French', HI: 'Hindi', IT: 'Italian', KU: 'Kurdish',
    PT: 'Portuguese', RU: 'Russian', TR: 'Turkish', UR: 'Urdu', FA: 'Persian', NL: 'Dutch',
  };
  if (categoryCode) return categoryLanguages[categoryCode] || categoryCode;
  if (arabicText.test(text) || /\b(arabic|arab|ar)\b/i.test(text)) return 'Arabic';
  const rules = [
    ['English', /\b(english|eng|en)\b/i], ['French', /\b(french|francais|fr)\b/i],
    ['Turkish', /\b(turkish|turk|tr)\b/i], ['Spanish', /\b(spanish|espanol|es)\b/i],
    ['German', /\b(german|deutsch|de)\b/i], ['Italian', /\b(italian|italiano|it)\b/i],
    ['Portuguese', /\b(portuguese|portugues|pt)\b/i], ['Russian', /\b(russian|ru)\b/i],
    ['Hindi', /\b(hindi|hi)\b/i], ['Urdu', /\b(urdu|ur)\b/i],
    ['Persian', /\b(persian|farsi|fa)\b/i], ['Kurdish', /\b(kurdish|kurd|ku)\b/i],
  ];
  for (const [language, pattern] of rules) if (pattern.test(text)) return language;
  return 'Other';
}

function titleLanguageCode(item) {
  const match = String(item?.title || '').match(/^\s*([A-Za-z]{2})\s*(?:[-|:])/);
  return match ? match[1].toUpperCase() : 'OTHER';
}

function displayDuration(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return raw.length === 5 ? `00:${raw}` : raw;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return raw;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  return [hours, minutes, remaining].map(part => String(part).padStart(2, '0')).join(':');
}

async function getAllXtreamItems(kind) {
  // The Roku can issue overlapping page/category requests. Coalesce those
  // requests so only one full provider catalog is mapped at a time.
  if (xtreamItemsInFlight.has(kind)) return xtreamItemsInFlight.get(kind);
  const request = (async () => {
    const sources = await getAllXtreamSources();
    const groups = await Promise.all(sources.map(async source => {
      try {
        const [catalog, categories] = await Promise.all([getSourceCatalog(source, kind), getSourceCategories(source, kind)]);
        const categoryNames = new Map(categories.map(category => [category.id, category.name]));
        return catalog.map(item => {
          const category = categoryNames.get(item.categoryId) || source.name || 'Other';
          const language = detectXtreamLanguage(item, category);
          return { ...item, category, language, rokuCategory: rokuText(category), sourceId: source._id, sourceName: source.name };
        });
      } catch (error) {
        console.warn(`[Xtream] Could not refresh ${kind} catalog for ${source.name}: ${error.message}`);
        return [];
      }
    }));
    return groups.flat();
  })();
  xtreamItemsInFlight.set(kind, request);
  try {
    return await request;
  } finally {
    xtreamItemsInFlight.delete(kind);
  }
}

function selectedXtreamItem(source, item) {
  const suppliedCategory = String(item.category || item.categoryName || '').trim();
  // "test" is the source display name, not a media category. Never expose it
  // as a Roku filter when an old saved item is missing category metadata.
  const category = /^test$/i.test(suppliedCategory) || !suppliedCategory ? 'Other' : suppliedCategory;
  return {
    ...item,
    id: String(item.id),
    kind: item.kind,
    sourceId: source._id,
    sourceName: source.name,
    category,
    language: item.language || detectXtreamLanguage(item, category),
    rokuCategory: item.rokuCategory || rokuText(category),
  };
}

async function getLibrarySelectedItems(ownerId = null, requestedKind = '') {
  if (!ownerId) return [];
  const sources = await getAllXtreamSources(ownerId);
  const groups = sources.map(source => {
    const enabledItems = (Array.isArray(source.enabledItems) ? source.enabledItems : [])
      .filter(item => item?.kind && (!requestedKind || item.kind === requestedKind));
    // Roku catalog reads must only use the Library selection already stored in
    // MongoDB. Fetching a provider's entire catalog here to backfill one absent
    // logo made every page wait on an unrelated upstream request. Logo
    // enrichment belongs to the source import/update path, never this hot path.
    return enabledItems.map(item => selectedXtreamItem(source, item));
  });
  return groups.flat();
}

async function getRokuSelectedItems(kind, ownerId = null) {
  // The managed Library is the category source of truth. Provider categories
  // only seed it; Roku never recomputes rails from the provider after that.
  if (!ownerId) return [];
  const suppliedItems = await getLibrarySelectedItems(ownerId, kind);
  const managed = await getManagedLibrary(ownerId, suppliedItems, kind);
  return managed.categories.flatMap(category => category.items.map(item => ({
    ...item,
    category: category.name,
    rokuCategory: rokuText(category.name),
  })));
}

function directXtreamItem(item) {
  const extension = String(item.extension || '').toLowerCase();
  const playbackUrl = rokuXtreamPlaybackPath(item.sourceId, item.kind, item.id, extension);
  return {
    ...item,
    source: 'xtream',
    favoriteId: `xtream:${item.sourceId}:${item.kind}:${item.id}`,
    url: playbackUrl,
    playbackUrl,
    rokuTitle: rokuText(item.title),
    rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
    originalFormat: extension || 'mp4',
    streamFormat: rokuXtreamStreamFormat(extension),
  };
}

function rokuXtreamStreamFormat(extension = '') {
  return ['mp4', 'm4v', 'mov'].includes(String(extension).toLowerCase()) ? 'mp4' : 'hls';
}

function rokuXtreamPlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (rokuXtreamStreamFormat(ext) === 'mp4') {
    return `/api/xtream/play/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
  }
  return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

app.use(cors());
app.use(express.json());

// Verify the actual Roku credential, not merely process availability. This
// keeps the Library backend indicator from showing green when the saved token
// is expired, invalid, or signed with a different DEVICE_AUTH_SECRET.
app.get('/api/roku/auth-health', async (req, res) => {
  try {
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    const session = resolveDeviceToken(token);
    res.set('Cache-Control', 'no-store');
    if (!await isRokuSessionLinked(session)) {
      console.warn(`[Roku auth] health rejected token=${token ? 'present-invalid' : 'missing'}`);
      return res.status(401).json({ ok: false, authenticated: false });
    }
    res.json({ ok: true, authenticated: true });
  } catch (error) { res.status(503).json({ ok: false, authenticated: false, error: error.message }); }
});

async function ownerPlaylistHealth(ownerId) {
  const cached = playlistHealthCache.get(ownerId);
  if (cached?.expiresAt > Date.now()) return cached.payload;
  if (playlistHealthInFlight.has(ownerId)) return playlistHealthInFlight.get(ownerId);
  const request = (async () => {
    const sources = await getAllXtreamSources(ownerId);
    const health = await checkPlaylistSources(sources, source => (
      sourceType(source) === 'm3u' ? validateM3uConnection(source) : validateXtreamConnection(source)
    ));
    const { results: _results, ...summary } = health;
    const payload = { ...summary, checkedAt: new Date().toISOString() };
    playlistHealthCache.set(ownerId, { payload, expiresAt: Date.now() + playlistHealthTtlMs });
    return payload;
  })();
  playlistHealthInFlight.set(ownerId, request);
  try { return await request; }
  finally { playlistHealthInFlight.delete(ownerId); }
}

// This is intentionally stronger than /api/xtream/sources: a MongoDB record
// is "saved", not "online". The login page uses this provider-backed result.
app.get('/api/roku/playlist-health', async (req, res) => {
  try {
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    const session = resolveDeviceToken(token);
    if (!await isRokuSessionLinked(session)) return res.status(401).json({ ok: false, status: 'not_paired' });
    res.set('Cache-Control', 'no-store');
    res.json(await ownerPlaylistHealth(session.ownerId));
  } catch (error) {
    res.status(503).json({ ok: false, status: 'unavailable', error: error.message });
  }
});

// The Roku displays a short-lived QR/device code. The phone signs up or signs
// in, then the Roku polls for approval and receives its token automatically.
app.post('/api/roku/device-session', async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    res.json(await createDeviceSession(deviceId, frontendUrl, token));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/device-session', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    res.json(await createDeviceSession(deviceId, frontendUrl, token));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/device-session/status', async (req, res) => {
  try {
    const session = getRokuDeviceSessionStatus(req.query.code);
    if (!session) return res.status(404).json({ error: 'Pairing code expired' });
    res.json(session);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/roku/device-session/unlink', async (req, res) => {
  try {
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    const session = resolveDeviceToken(token);
    if (!session?.accountId || !session?.deviceId) return res.status(401).json({ error: 'Linked Roku authorization is required' });
    const result = await unlinkAccountDevice(session.accountId, session.deviceId, session.profileId || '');
    if (result.error) return res.status(404).json(result);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/info', async (req, res) => {
  try {
    const session = await getPairingInfo(req.body?.code, req.get('x-device-token'));
    if (!session) return res.status(404).json({ error: 'Pairing code expired or invalid' });
    res.json(session);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/claim', (req, res) => {
  try {
    const result = claimAutomaticPairing(req.body?.code);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 401).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/authorize', async (req, res) => {
  try {
    const result = await authorizeDeviceSession(req.body?.code, req.get('x-device-token'));
    if (result.error) return res.status(result.error.includes('expired') ? 404 : result.error.includes('different') ? 409 : 401).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/setup', async (req, res) => {
  try {
    const result = await setupDeviceSession(req.body?.code, req.body?.email, req.body?.password, req.body?.firstName, req.body?.lastName);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/login', async (req, res) => {
  try {
    const result = await loginDeviceSession(req.body?.code, req.body?.email, req.body?.password);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 401).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/account/devices', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to view linked devices' });
    res.json({ items: await getLinkedDevices(accountId, resolveDeviceToken(String(req.get('x-device-token') || ''))?.profileId || '') });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/roku/heartbeat', async (req, res) => {
  try {
    const session = resolveDeviceToken(String(req.get('x-device-token') || req.query.deviceToken || ''));
    if (!await isRokuSessionLinked(session)) return res.status(401).json({ error: 'Valid linked Roku authorization is required' });
    await recordDeviceHeartbeat(session.deviceId, req.body?.streaming === true);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/account/devices/:deviceId', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to unlink a Roku device' });
    const result = await unlinkAccountDevice(accountId, req.params.deviceId, resolveDeviceToken(String(req.get('x-device-token') || ''))?.profileId || '');
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/login', async (req, res) => {
  try {
    const result = await loginAccount(req.body?.email, req.body?.password, req.body?.deviceId);
    if (result.error) return res.status(result.error.startsWith('Incorrect') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/signup', async (req, res) => {
  try {
    const result = await registerAccount(req.body?.email, req.body?.password, req.body?.firstName, req.body?.lastName);
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/account/profiles', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to view profiles' });
    res.set('Cache-Control', 'no-store');
    res.json({ items: await getAccountProfiles(accountId) });
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
app.post('/api/account/profiles', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to create a profile' });
    const result = await createAccountProfile(accountId, req.body);
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
app.put('/api/account/profiles/:profileId', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to edit a profile' });
    const result = await updateAccountProfile(accountId, req.params.profileId, req.body);
    if (result.error) return res.status(result.error === 'Profile not found' ? 404 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
app.delete('/api/account/profiles/:profileId', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to delete a profile' });
    const result = await deleteAccountProfile(accountId, req.params.profileId);
    if (result.error) return res.status(result.error === 'Profile not found' ? 404 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
app.post('/api/account/profiles/:profileId/select', async (req, res) => {
  try {
    const authorization = resolveDeviceToken(String(req.get('x-device-token') || ''));
    const accountId = authorization?.accountId;
    if (!accountId) return res.status(401).json({ error: 'Sign in to choose a profile' });
    const result = await selectAccountProfile(accountId, req.params.profileId, authorization);
    if (result.error) return res.status(404).json(result);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
app.post('/api/account/password', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const result = await changeAccountPassword(accountId, req.body?.currentPassword, req.body?.newPassword);
    if (result.error) return res.status(result.error.startsWith('Sign in') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/health', async (_, res) => {
  try {
    const xtreamSources = await getXtreamSources();
    res.json({ ok: true, source: 'xtream', storage: { type: 'mongodb', xtreamSources: xtreamSources.length } });
  } catch (error) {
    res.status(503).json({ ok: false, source: 'catalog', storage: { type: 'mongodb', error: error.message } });
  }
});

function diagnosticsAuthorized(req) {
  const expected = String(process.env.INTERNAL_DIAGNOSTICS_TOKEN || '');
  if (!expected) return false;
  const supplied = String(req.get('x-internal-token') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function mediaHealthSnapshot() {
  const memory = process.memoryUsage();
  const counts = mediaJobs.counts();
  return {
    uptime: Math.floor(process.uptime()),
    rssMB: Number((memory.rss / 1024 / 1024).toFixed(1)),
    heapUsedMB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    externalMB: Number((memory.external / 1024 / 1024).toFixed(1)),
    arrayBuffersMB: Number((memory.arrayBuffers / 1024 / 1024).toFixed(1)),
    freeSystemMemoryMB: Number((os.freemem() / 1024 / 1024).toFixed(1)),
    loadAverage: os.loadavg().map(value => Number(value.toFixed(2))),
    cpuCount: os.availableParallelism?.() || os.cpus().length,
    activeDirectStreams,
    activeRemuxJobs: counts.remux,
    activeTranscodes: counts.transcode,
    queuedJobs: counts.queued,
    hlsDiskUsageMB: Number(((await hlsDiskUsageBytes()) / 1024 / 1024).toFixed(1)),
    cacheEntryCounts: {
      xtream: xtreamCacheStats().entries,
      xtreamRequestsInFlight: xtreamCacheStats().inFlight,
      m3u: m3uCacheStats().entries,
      m3uRequestsInFlight: m3uCacheStats().inFlight,
      catalogRequestsInFlight: xtreamItemsInFlight.size,
    },
  };
}

app.get('/internal/media-health', async (req, res) => {
  if (!diagnosticsAuthorized(req)) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.json(await mediaHealthSnapshot());
});

app.use('/api/xtream', (req, res, next) => {
  if (req.path === '/logo') return next();
  const hls = req.path.match(/^\/hls\/([^/]+)\/(channel|movie|series)\/([^/]+)\/(?:master\.m3u8|segment-\d{6}\.ts)$/);
  if (hls && resolveStreamTicket(req.query.streamTicket, decodeURIComponent(hls[1]), hls[2], decodeURIComponent(hls[3]))) return next();
  if (!requestOwner(req)) return res.status(401).json({ error: 'Pair this browser with a Roku device first' });
  next();
});

app.get('/api/xtream/stream-ticket/:sourceId/:kind/:id', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    const source = await getXtreamSource(req.params.sourceId, ownerId);
    if (!source) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store');
    res.json({ ticket: issueStreamTicket(ownerId, req.params.sourceId, req.params.kind, req.params.id) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/series/:sourceId/:id', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(req.params.sourceId, ownerId);
    if (!source) return res.sendStatus(404);
    const details = await getXtreamSeriesEpisodes(source, req.params.id);
    res.set('Cache-Control', 'no-store');
    res.json(details);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.use('/api/library', (req, res, next) => {
  if (!requestOwner(req)) return res.status(401).json({ error: 'Sign in to manage Library categories' });
  next();
});

async function managedLibraryForRequest(req, kind = '') {
  const ownerId = requestOwner(req);
  return getManagedLibrary(ownerId, await getLibrarySelectedItems(ownerId), kind);
}

app.get('/api/library/categories', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await managedLibraryForRequest(req, String(req.query.kind || '')));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get(['/api/library/revision', '/api/roku/library/revision'], async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const since = Number.parseInt(String(req.query.since || '0'), 10) || 0;
    res.set('Cache-Control', 'no-store');
    res.json({ revision: await waitForLibraryRevision(ownerId, since) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/library/categories', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    const result = await createLibraryCategory(ownerId, await getLibrarySelectedItems(ownerId), {
      kind: String(req.body?.kind || ''), name: req.body?.name,
    });
    bumpLibraryRevision(ownerId);
    res.status(201).json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/library/categories/:id', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    const result = await renameLibraryCategory(ownerId, await getLibrarySelectedItems(ownerId), req.params.id, req.body?.name);
    if (!result) return res.sendStatus(404);
    bumpLibraryRevision(ownerId);
    res.json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/library/categories/:id/items', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.itemKeys)) return res.status(400).json({ error: 'itemKeys must be an array' });
    const ownerId = requestOwner(req);
    const result = await replaceLibraryCategoryItems(ownerId, await getLibrarySelectedItems(ownerId), req.params.id, req.body.itemKeys);
    if (!result) return res.sendStatus(404);
    bumpLibraryRevision(ownerId);
    res.json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/library/categories/:id', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    const result = await deleteLibraryCategory(ownerId, await getLibrarySelectedItems(ownerId), req.params.id);
    if (!result) return res.sendStatus(404);
    bumpLibraryRevision(ownerId);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Roku must not try to build the full Xtream catalog during application
// startup. A complete series catalog requires one provider request per
// series, which can outlive Roku's HTTP request window. The Roku client uses
// this endpoint only to verify that Render is reachable; each catalog page is
// fetched separately when the user opens it.
app.get('/api/roku/bootstrap', async (req, res) => {
  try {
    // Home needs a very small, fast catalog only. Return the newest saved
    // Roku entries without expanding every series into episodes.
    const ownerId = requestOwner(req);
    const [selectedSeries, selectedMovies, selectedChannels] = await Promise.all([
      getRokuSelectedItems('series', ownerId),
      getRokuSelectedItems('movie', ownerId),
      getRokuSelectedItems('channel', ownerId),
    ]);
    const newestFirst = (items) => [...items]
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0))
      .slice(0, 3);
    const series = newestFirst(selectedSeries).map((item) => ({
      id: `series-search:${item.sourceId}:${item.id}`,
      title: item.title,
      rokuTitle: rokuText(item.title),
      rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
      category: item.category,
      sourceId: String(item.sourceId),
      seriesId: item.id,
      thumbnail: item.logo,
      added: item.added,
      contentKind: 'series-search',
      originalFormat: String(item.extension || 'mp4').replace(/[^a-z0-9]/gi, '').toUpperCase(),
    }));
    const movies = newestFirst(selectedMovies).map((item) => ({
      ...directXtreamItem(item),
      thumbnail: item.logo,
      kind: 'movie',
      contentKind: 'movie',
      rokuEnabled: true,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({
      items: [...series, ...movies],
      stats: {
        series: selectedSeries.length,
        movies: selectedMovies.length,
        channels: selectedChannels.length,
      },
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/roku/series/categories', async (req, res) => {
  try {
    const seen = new Set();
    const items = [];
    for (const series of await getRokuSelectedItems('series', requestOwner(req))) {
      const category = series.category || 'Other';
      if (seen.has(category)) continue;
      seen.add(category);
      items.push({
        id: `series-category:${series.sourceId}:${category}`,
        title: category,
        rokuTitle: series.rokuCategory || rokuText(category),
        category,
        language: detectXtreamLanguage({ title: '' }, category),
        contentKind: 'series-category',
      });
    }
    items.sort((a, b) => a.title.localeCompare(b.title));
    res.json({ items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/roku/search', async (req, res) => {
  try {
    const kind = String(req.query.kind || '');
    const query = String(req.query.q || '').trim().toLocaleLowerCase();
    if ((kind !== 'series' && kind !== 'movie') || !query) return res.status(400).json({ error: 'kind and q are required' });
    const matches = (await getRokuSelectedItems(kind, requestOwner(req)))
      .filter(item => item.title.toLocaleLowerCase().includes(query))
      .slice(0, 60);
    if (kind === 'series') {
      return res.json({ items: matches.map(item => ({
        id: `series-search:${item.sourceId}:${item.id}`,
        title: item.title,
        rokuTitle: rokuText(item.title),
        category: item.category,
        rokuCategory: item.rokuCategory,
        sourceId: String(item.sourceId),
        seriesId: item.id,
        contentKind: 'series-search',
        originalFormat: String(item.extension || 'mp4').replace(/[^a-z0-9]/gi, '').toUpperCase(),
      })) });
    }
    const items = matches.map(item => ({
      ...directXtreamItem(item),
      thumbnail: item.logo,
      duration: item.duration || '',
      kind: 'movie', contentKind: 'movie', rokuEnabled: true,
    }));
    res.json({ items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/roku/series/detail', async (req, res) => {
  try {
    const sourceId = String(req.query.sourceId || '');
    const seriesId = String(req.query.seriesId || '');
    if (!sourceId || !seriesId) return res.status(400).json({ error: 'sourceId and seriesId are required' });
    const series = (await getRokuSelectedItems('series', requestOwner(req))).find(item => String(item.sourceId) === sourceId && item.id === seriesId);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    res.json({ items: await buildXtreamSeriesPayload({ selected: [series] }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function buildXtreamMoviesPayload({ limit, selected } = {}) {
  let movies = (selected || await getRokuSelectedItems('movie')).slice().sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
  if (Number.isFinite(limit) && limit > 0) movies = movies.slice(0, limit);
  // Do not call get_vod_info while building a Roku rail. It opens one provider
  // request per movie and makes a three-item page take many seconds. Roku learns
  // the authoritative duration from the Video node once playback starts.
  return movies.map(item => ({
    ...directXtreamItem(item),
    duration: displayDuration(item.duration),
    kind: 'movie',
    contentKind: 'movie',
    rokuEnabled: true,
  }));
}

function buildXtreamChannelsPayload(items) {
  return items.map(item => ({
    ...directXtreamItem(item),
    kind: 'channel', contentKind: 'channel',
    group: item.category || item.sourceName,
    rokuGroup: item.rokuCategory || rokuText(item.sourceName),
  }));
}

app.get('/api/roku/movies', async (req, res) => {
  const startedAt = Date.now();
  try {
    const pageInfo = rokuPage(req, rokuMoviePageLimit);
    // Roku movie pages are deliberately fixed at ten items per request.
    pageInfo.limit = rokuMoviePageLimit;
    pageInfo.offset = pageInfo.page * pageInfo.limit;
    const selected = (await getRokuSelectedItems('movie', requestOwner(req)))
      .slice()
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
    const sourcePage = selected.slice(pageInfo.offset, pageInfo.offset + pageInfo.limit);
    const items = await buildXtreamMoviesPayload({ selected: sourcePage });
    const durationMs = Date.now() - startedAt;
    res.set('Server-Timing', `roku_movies;dur=${durationMs}`);
    console.log(`[Roku API] movies page=${pageInfo.page} items=${items.length} total=${selected.length} durationMs=${durationMs}`);
    res.json({
      items,
      page: pageInfo.page,
      limit: pageInfo.limit,
      total: selected.length,
      hasMore: pageInfo.offset + sourcePage.length < selected.length,
    });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/streaming-history', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    res.json({ items: await getStreamingHistory(ownerId, req.query.limit) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/streaming-history/continue-watching', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    res.json({ items: await getStreamingContinueWatching(ownerId, req.query.limit) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/streaming-history/resume', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    const item = await getStreamingResume(ownerId, req.query);
    res.json({ item });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/streaming-history/:sessionId', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'Streaming session ID is required' });
    res.set('Cache-Control', 'no-store');
    const update = { ...req.query, ...req.body };
    for (const field of ['startPosition', 'endPosition', 'mediaDuration', 'streamingDuration']) {
      const secondsField = `${field}Seconds`;
      const millisecondsField = `${field}Ms`;
      if (update[millisecondsField] == null && update[secondsField] != null) {
        update[millisecondsField] = Math.max(0, Number(update[secondsField]) || 0) * 1000;
      }
    }
    if ((update.ended === true || String(update.ended).toLowerCase() === 'true') && !update.endedAt) update.endedAt = new Date();
    res.json({ item: await saveStreamingHistory({ ownerId, sessionId, ...update }) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/favorites', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store'); res.json({ items: await getFavorites(ownerId) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});
async function toggleFavoriteRequest(req, res) {
  try {
    const id = String(req.query?.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.json(await toggleFavorite({ ownerId, id, title: req.query?.title || req.body?.title, kind: req.query?.kind || req.body?.kind }));
  } catch (error) { res.status(500).json({ error: error.message }); }
}
app.post('/api/favorites/toggle', toggleFavoriteRequest);
app.put('/api/favorites/toggle', toggleFavoriteRequest);
app.get('/api/favorites/toggle', toggleFavoriteRequest);
app.get('/api/roku/weather-locations/search', async (req, res) => {
  try {
    if (!requestOwner(req)) return res.status(401).json({ error: 'Sign in to search weather locations' });
    const name = String(req.query.q || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Enter at least two characters' });
    const language = String(req.query.language || 'en').toLowerCase() === 'ar' ? 'ar' : 'en';
    const query = new URLSearchParams({ name, count: '100', language, format: 'json' });
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${query}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
    const payload = await response.json();
    const locations = (payload.results || []).map(location => ({
      id: location.id,
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone || 'auto',
      label: [location.name, location.admin1, location.country].filter(Boolean).join(', '),
    }));
    res.json({ locations });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/account/weather-locations', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Sign in to manage weather locations' });
    res.json({ locations: await getDeviceWeatherLocations(ownerId, requestAccount(req), requestDevice(req)) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/account/weather-locations', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Sign in to manage weather locations' });
    const result = await saveDeviceWeatherLocations(ownerId, req.body?.locations, requestAccount(req), requestDevice(req));
    if (result.error) return res.status(result.error.includes('not found') ? 404 : 400).json(result);
    dashboardCache.clear();
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/roku/dashboard', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Valid device authorization is required' });
    // Weather is cached, but clock values must be generated for every request
    // so the minute display never remains frozen for the cache lifetime.
    const savedLocations = await getDeviceWeatherLocations(ownerId, requestAccount(req), requestDevice(req));
    const location = savedLocations[0];
    const locations = location ? [{ ...location, id: 'slot1' }] : [];
    const cacheKey = JSON.stringify(locations);
    const cached = dashboardCache.get(cacheKey);
    if (cached?.expires > Date.now()) return res.json(freshDashboardTimes(cached.data));
    const cities = await Promise.all(locations.map(async (location) => {
      const query = new URLSearchParams({
        latitude: location.latitude, longitude: location.longitude,
        current: 'temperature_2m,weather_code,wind_speed_10m', timezone: location.timezone,
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
      const data = await response.json();
      return {
        id: location.id, label: location.label, timezone: location.timezone,
        time: data.current?.time || '', temperature: data.current?.temperature_2m,
        weatherCode: data.current?.weather_code, windSpeed: data.current?.wind_speed_10m,
      };
    }));
    const entry = { expires: Date.now() + 120_000, data: { backend: 'online', cities } };
    dashboardCache.set(cacheKey, entry);
    res.json(freshDashboardTimes(entry.data));
  } catch (error) { res.status(502).json({ backend: 'online', error: error.message }); }
});
function parsePlaylistInput(body, existing = null) {
  const name = String(body?.name || existing?.name || '').trim();
  const type = body?.type === 'm3u' ? 'm3u' : body?.type === 'xtream' ? 'xtream' : sourceType(existing);
  const supplied = String(body?.url || '').trim();
  if (!name) throw new Error('Source name is required');
  if (!supplied && existing) return { name };
  if (!supplied) throw new Error(`Paste the ${type === 'm3u' ? 'M3U playlist' : 'Xtream server'} URL`);
  let url;
  try { url = new URL(supplied); } catch { throw new Error('Enter a valid playlist URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Playlist URL must use HTTP or HTTPS');
  if (type === 'm3u') return { name, type, baseUrl: url.toString(), username: '', password: '' };
  const username = String(body?.username || url.searchParams.get('username') || existing?.username || '').trim();
  const password = String(body?.password || url.searchParams.get('password') || existing?.password || '').trim();
  if (!username || !password) throw new Error('Xtream username and password are required');
  const pathname = url.pathname.replace(/\/(?:get|player_api)\.php\/?$/i, '').replace(/\/$/, '');
  return { name, type, baseUrl: `${url.protocol}//${url.host}${pathname}`, username, password };
}

app.get('/api/xtream/sources', async (req, res) => {
  try { res.json({ items: await getXtreamSources(requestOwner(req)) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// Fast mobile startup payload sourced only from the account's persisted
// library. Never contact playlist providers while Android is launching.
app.get('/api/android/bootstrap', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const sources = await getAllXtreamSources(ownerId);
    const counts = { series: 0, movie: 0, channel: 0 };
    for (const source of sources) {
      for (const item of Array.isArray(source.enabledItems) ? source.enabledItems : []) {
        const kind = ['series', 'movie', 'channel'].includes(item.kind) ? item.kind : null;
        if (!kind) continue;
        counts[kind] += 1;
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({ counts });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/recommendations/ai', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const payload = await getAiRecommendations({
      ownerId,
      language: req.body?.language,
      forceRefresh: req.body?.refresh === true,
      getSources: getAllXtreamSources,
      getCatalog: getSourceCatalog,
      getCategories: getSourceCategories,
    });
    res.set('Cache-Control', 'private, no-store');
    res.json(payload);
  } catch (error) {
    console.error(`[AIRecommendations] endpoint-failed status=${Number(error?.status) || 500}`);
    res.status(Number(error?.status) || 500).json({ error: 'Recommendations are temporarily unavailable' });
  }
});

// Return catalog sizes without sending or persisting provider catalogs on the
// mobile device. Provider rows exist only long enough to count them here.
app.get('/api/xtream/catalog-counts', async (req, res) => {
  try {
    const sources = await getAllXtreamSources(requestOwner(req));
    const counts = { series: 0, movie: 0, channel: 0 };
    const recent = { series: [], movie: [], channel: [] };
    const addedTime = item => {
      const numeric = Number(item.added);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = Date.parse(item.added);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    };
    for (const source of sources) {
      for (const kind of ['series', 'movie', 'channel']) {
        const catalog = await getSourceCatalog(source, kind);
        counts[kind] += Array.isArray(catalog) ? catalog.length : 0;
        for (const item of catalog) {
            const candidate = {
              id: item.id, key: item.key, kind, title: item.title,
              categoryId: item.categoryId, logo: item.logo, rating: item.rating,
              duration: item.duration, extension: item.extension,
              added: item.added, sourceId: String(source._id),
            };
            const group = recent[kind];
            if (group.length < 10) group.push(candidate);
            else {
              let oldest = 0;
              for (let i = 1; i < group.length; i += 1) {
                if (addedTime(group[i]) < addedTime(group[oldest])) oldest = i;
              }
              if (addedTime(candidate) > addedTime(group[oldest])) group[oldest] = candidate;
            }
          }
      }
    }
    for (const group of Object.values(recent)) group.sort((a, b) => addedTime(b) - addedTime(a)
      || String(a.title || '').localeCompare(String(b.title || '')));
    res.json({ counts, recent });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Provider channel logos are often published over HTTP.  The Render frontend
// is HTTPS, so browsers block those images as mixed content.  Serve the small
// logo through this HTTPS backend endpoint instead.
app.get('/api/xtream/logo', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Logo request timed out')), 10_000);
  timeout.unref?.();
  const abort = () => controller.abort(new Error('Logo client disconnected'));
  res.once('close', abort);
  try {
    const supplied = String(req.query.url || '').trim();
    const validateLogoTarget = target => {
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported logo URL');
      if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(target.hostname)) throw new Error('Unsupported logo host');
    };
    let target = new URL(supplied);
    // Roku cards are roughly 160x240 at a 1280x720 UI resolution. Avoid
    // forwarding multi-megapixel TMDB originals to the device; TMDB provides
    // an image-size path specifically for this purpose. Keep the default proxy
    // behavior unchanged for the Library web frontend.
    if (req.query.roku === '1' && target.hostname.toLowerCase() === 'image.tmdb.org') {
      target.pathname = target.pathname.replace(/^\/t\/p\/[^/]+\//, '/t/p/w342/');
    }
    if (req.query.roku === '1' && /^i\d+\.wp\.com$/i.test(target.hostname)) {
      // Jetpack's image CDN already accepts a fit transform. Override large
      // publisher dimensions for Roku cards instead of forwarding 819x1024+
      // artwork to a 1280x720 SceneGraph.
      target.searchParams.set('fit', '342,513');
    }
    let response;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      validateLogoTarget(target);
      response = await fetch(target, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 RH-Library/1.0' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('Logo redirected too many times');
      target = new URL(location, target);
    }
    if (!response.ok) return res.sendStatus(response.status === 404 ? 404 : 502);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/') && !contentType.toLowerCase().startsWith('application/octet-stream')) return res.status(415).send('Logo is not an image');
    const maxBytes = 5 * 1024 * 1024;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) { await response.body?.cancel(); return res.status(413).send('Logo is too large'); }
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes <= maxBytes ? null : new Error('Logo is too large'), chunk);
      },
    });
    res.set('Content-Type', contentType.toLowerCase().startsWith('application/octet-stream') ? 'image/jpeg' : contentType.split(';', 1)[0]);
    res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    if (!response.body) return res.end();
    await pipeline(Readable.fromWeb(response.body), limiter, res);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) res.status(error.message === 'Logo is too large' ? 413 : 400).send(error.message || 'Invalid logo URL');
  } finally {
    clearTimeout(timeout);
    res.off('close', abort);
  }
});

app.post('/api/xtream/sources', async (req, res) => {
  try {
    const source = parsePlaylistInput(req.body);
    if (source.type === 'm3u') await validateM3uConnection({ ...source, _id: 'validation' });
    else await validateXtreamConnection({ ...source, _id: 'validation' });
    res.status(201).json(await createXtreamSource({ ...source, ownerId: requestOwner(req) }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id', async (req, res) => {
  try {
    const existing = await getXtreamSource(req.params.id, requestOwner(req));
    if (!existing) return res.sendStatus(404);
    const changes = parsePlaylistInput(req.body, existing);
    if (changes.baseUrl) {
      const candidate = { ...existing, ...changes };
      if (sourceType(candidate) === 'm3u') await validateM3uConnection(candidate);
      else await validateXtreamConnection(candidate);
    }
    res.json(await updateXtreamSource(req.params.id, changes, requestOwner(req)));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/xtream/sources/:id', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!await deleteXtreamSource(req.params.id, ownerId)) return res.sendStatus(404);
    bumpLibraryRevision(ownerId);
    res.sendStatus(204);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/catalog', async (req, res) => {
  try {
    const source = await getXtreamSource(String(req.query.sourceId || ''), requestOwner(req));
    if (!source) return res.status(404).json({ error: 'Xtream source not found' });
    const aliases = { live: 'channel', channel: 'channel', movie: 'movie', vod: 'movie', series: 'series' };
    const kind = aliases[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be channel, movie, or series' });
    const category = String(req.query.category || '');
    const query = normalizeSearchText(req.query.q);
    if (!category) return res.status(400).json({ error: 'Select a playlist category first' });
    // Browsing respects the selected category. Searching must use the full
    // playlist catalog for this content type so matches in other categories
    // are not hidden by the category currently open in the Android UI.
    const catalogCategory = query ? 'all' : category;
    const allItems = await getSourceCatalog(source, kind, catalogCategory);
    const enabled = new Set(source.enabledKeys || []);
    const titleLanguage = String(req.query.titleLanguage || req.query.language || 'all').toUpperCase();
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const languagePriority = { AR: 0, EN: 1 };
    const languageSet = new Set();
    const filtered = [];
    for (const item of allItems) {
      const languageCode = titleLanguageCode(item);
      languageSet.add(languageCode);
      if ((query || category === 'all' || item.categoryId === category)
        && (titleLanguage === 'ALL' || languageCode === titleLanguage)
        && (!query || normalizeSearchText(`${item.title} ${item.categoryId || ''}`).includes(query))) {
        filtered.push({ ...item, languageCode, titleLanguage: languageCode });
      }
    }
    // Sort the complete filtered catalog before pagination. This keeps every
    // page boundary stable: loading 20 more items can never insert an earlier
    // title into the middle of the already-rendered list.
    filtered.sort((a, b) => String(a.title || '').trim().localeCompare(String(b.title || '').trim(), undefined, { numeric: true, sensitivity: 'base' })
      || String(a.key || '').localeCompare(String(b.key || '')));
    const requestedLimit = String(req.query.limit || '').trim().toLowerCase();
    const pageSize = requestedLimit === 'all'
      ? Math.max(1, filtered.length)
      : Math.min(200, Math.max(10, Number.parseInt(requestedLimit, 10) || 50));
    const languages = [...languageSet]
      .sort((a, b) => (languagePriority[a] ?? 10) - (languagePriority[b] ?? 10) || a.localeCompare(b));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const start = (page - 1) * pageSize;
    res.json({
      source: publicXtreamSource(source), languages,
      items: filtered.slice(start, start + pageSize).map(item => ({ ...item, enabled: enabled.has(item.key) })),
      pagination: { page, pageSize, pageCount, total: filtered.length },
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/xtream/categories', async (req, res) => {
  try {
    const source = await getXtreamSource(String(req.query.sourceId || ''), requestOwner(req));
    if (!source) return res.status(404).json({ error: 'Xtream source not found' });
    const aliases = { live: 'channel', channel: 'channel', movie: 'movie', vod: 'movie', series: 'series' };
    const kind = aliases[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be channel, movie, or series' });
    const categories = await getSourceCategories(source, kind);
    categories.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
    res.json({ categories });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/xtream/movie/:sourceId/:id/duration', async (req, res) => {
  try {
    const source = await getXtreamSource(req.params.sourceId, mediaOwner(req));
    if (!source) return res.sendStatus(404);
    const cacheKey = `${source._id}:movie:${req.params.id}`;
    const cached = movieDurationCache.get(cacheKey);
    if (cached?.expiresAt > Date.now()) {
      res.set('Cache-Control', 'private, max-age=300');
      return res.json({ seconds: cached.seconds, duration: cached.duration, source: cached.source });
    }
    const info = await getXtreamMovieInfo(source, req.params.id);
    let seconds = Number(info.seconds) || 0;
    let durationSource = 'xtream';
    if (seconds <= 0) {
      const inputUrl = await sourceProviderUrl(source, 'movie', req.params.id, req.query.ext);
      seconds = await probeMediaDuration(inputUrl);
      durationSource = 'probe';
    }
    const duration = seconds > 0
      ? [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), Math.floor(seconds % 60)].map(value => String(value).padStart(2, '0')).join(':')
      : info.duration;
    movieDurationCache.delete(cacheKey);
    movieDurationCache.set(cacheKey, { seconds, duration, source: durationSource, expiresAt: Date.now() + movieDurationCacheTtlMs });
    while (movieDurationCache.size > movieDurationCacheMaxEntries) movieDurationCache.delete(movieDurationCache.keys().next().value);
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ seconds, duration, source: durationSource });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

async function resolveXtreamEnabledItems(source, enabledKeys) {
    const allowed = enabledKeys.map(String).filter(key => /^(channel|movie|series):[^:]+$/.test(key));
    const allowedSet = new Set(allowed);
    const kinds = [...new Set(allowed.map(key => key.split(':', 1)[0]))];
    const [catalogs, categoryGroups] = await Promise.all([
      Promise.all(kinds.map(kind => getSourceCatalog(source, kind))),
      Promise.all(kinds.map(kind => getSourceCategories(source, kind))),
    ]);
    const categoryNamesByKind = new Map(kinds.map((kind, index) => [
      kind, new Map(categoryGroups[index].map(category => [category.id, category.name])),
    ]));
    const resolved = catalogs.flat().filter(item => allowedSet.has(item.key));
    const byKey = new Map(resolved.map(item => [item.key, item]));
    return allowed.map(key => byKey.get(key)).filter(Boolean).map(item => ({
      key: item.key,
      id: item.id,
      kind: item.kind,
      title: item.title,
      logo: item.logo,
      categoryId: item.categoryId,
      category: categoryNamesByKind.get(item.kind)?.get(item.categoryId) || 'Other',
      language: detectXtreamLanguage(item, categoryNamesByKind.get(item.kind)?.get(item.categoryId) || 'Other'),
      extension: item.extension,
      duration: item.duration,
      added: item.added,
    }));
}

function suppliedXtreamEnabledItems(source, enabledKeys, suppliedItems, categoryNamesByKind = new Map()) {
  if (!Array.isArray(suppliedItems)) return [];
  const allowed = enabledKeys.map(String).filter(key => /^(channel|movie|series):[^:]+$/.test(key));
  const suppliedByKey = new Map(suppliedItems
    .filter(item => item && typeof item === 'object' && allowed.includes(String(item.key)))
    .map(item => [String(item.key), item]));
  return allowed.map(key => {
    const item = suppliedByKey.get(key);
    if (!item) return null;
    const [kind, id] = key.split(':', 2);
    const category = categoryNamesByKind.get(kind)?.get(String(item.categoryId || ''))
      || (String(item.category || '').trim() && String(item.category).trim() !== source.name ? String(item.category).trim() : '')
      || 'Other';
    return {
      key,
      id: String(item.id || id),
      kind,
      title: String(item.title || `${kind} ${id}`),
      logo: String(item.logo || ''),
      categoryId: String(item.categoryId || ''),
      category,
      language: String(item.language || detectXtreamLanguage(item, category)),
      extension: String(item.extension || (kind === 'channel' ? 'm3u8' : 'mp4')),
      duration: String(item.duration || ''),
      added: String(item.added || ''),
    };
  }).filter(Boolean);
}

app.get('/api/xtream/sources/:id/enabled', async (req, res) => {
  try {
    const source = await getXtreamSource(req.params.id, requestOwner(req));
    if (!source) return res.sendStatus(404);
    const enabledKeys = Array.isArray(source.enabledKeys) ? source.enabledKeys : [];
    let enabledItems = Array.isArray(source.enabledItems) ? source.enabledItems : [];
    const itemKeys = new Set(enabledItems.map(item => item.key));
    const needsBackfill = enabledItems.length !== enabledKeys.length
      || enabledKeys.some(key => !itemKeys.has(key))
      || enabledItems.some(item => !item.category || !item.language
        || String(item.category).trim().toLowerCase() === String(source.name).trim().toLowerCase());
    if (needsBackfill && enabledKeys.length) {
      enabledItems = await resolveXtreamEnabledItems(source, enabledKeys);
      const updated = await updateXtreamSelection(source._id, enabledItems.map(item => item.key), enabledItems, requestOwner(req));
      return res.json({ source: updated, items: updated.enabledItems });
    }
    res.json({ source: publicXtreamSource(source), items: enabledItems });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id/selection', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!Array.isArray(req.body?.enabledKeys)) return res.status(400).json({ error: 'enabledKeys must be an array' });
    const source = await getXtreamSource(req.params.id, ownerId);
    if (!source) return res.sendStatus(404);
    // The manager already has the selected catalog rows. Persist them directly
    // instead of downloading every Xtream list again merely to resolve keys.
    // Full provider catalog reloads here were causing browser "Failed to fetch"
    // after Render ran out of memory or timed out.
    const kinds = [...new Set(req.body.enabledKeys.map(String)
      .map(key => key.split(':', 1)[0])
      .filter(kind => ['channel', 'movie', 'series'].includes(kind)))];
    const categoryGroups = await Promise.all(kinds.map(kind => getSourceCategories(source, kind)));
    const categoryNamesByKind = new Map(kinds.map((kind, index) => [
      kind,
      new Map(categoryGroups[index].map(category => [String(category.id), category.name])),
    ]));
    const enabledItems = suppliedXtreamEnabledItems(source, req.body.enabledKeys, req.body.enabledItems, categoryNamesByKind);
    if (enabledItems.length !== req.body.enabledKeys.length) {
      return res.status(400).json({ error: 'Selected item details are missing. Reload the catalog and try again.' });
    }
    const enabledKeys = enabledItems.map(item => item.key);
    const enabledSet = new Set(enabledKeys);
    const updated = await updateXtreamSource(req.params.id, {
      enabledKeys,
      enabledItems,
      archivedKeys: (source.archivedKeys || []).filter(key => !enabledSet.has(key)),
      archivedItems: (source.archivedItems || []).filter(item => !enabledSet.has(item.key)),
    }, ownerId);
    if (!updated) return res.sendStatus(404);
    bumpLibraryRevision(ownerId);
    res.json(updated);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    const source = await getXtreamSource(req.params.id, ownerId);
    if (!source) return res.sendStatus(404);
    const key = String(req.params.key || '');
    const enabledItems = Array.isArray(source.enabledItems) ? source.enabledItems : [];
    const item = enabledItems.find(candidate => candidate.key === key);
    if (!item) return res.status(404).json({ error: 'Saved Roku item not found' });
    const archiveItems = [...(Array.isArray(source.archivedItems) ? source.archivedItems : []).filter(candidate => candidate.key !== key), item];
    const updated = await updateXtreamSource(source._id, {
      enabledKeys: (source.enabledKeys || []).filter(candidate => candidate !== key),
      enabledItems: enabledItems.filter(candidate => candidate.key !== key),
      archivedKeys: archiveItems.map(candidate => candidate.key),
      archivedItems: archiveItems,
    }, ownerId);
    bumpLibraryRevision(ownerId);
    res.json(updated);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key/restore', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    const source = await getXtreamSource(req.params.id, ownerId);
    if (!source) return res.sendStatus(404);
    const key = String(req.params.key || '');
    const archivedItems = Array.isArray(source.archivedItems) ? source.archivedItems : [];
    const item = archivedItems.find(candidate => candidate.key === key);
    if (!item) return res.status(404).json({ error: 'Archived item not found' });
    const enabledItems = [...(Array.isArray(source.enabledItems) ? source.enabledItems : []).filter(candidate => candidate.key !== key), item];
    const updated = await updateXtreamSource(source._id, {
      enabledKeys: enabledItems.map(candidate => candidate.key),
      enabledItems,
      archivedKeys: (source.archivedKeys || []).filter(candidate => candidate !== key),
      archivedItems: archivedItems.filter(candidate => candidate.key !== key),
    }, ownerId);
    bumpLibraryRevision(ownerId);
    res.json(updated);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/play/:sourceId/:kind/:id', async (req, res) => {
  if (['movie', 'series'].includes(req.params.kind)) return res.status(410).json({ error: 'Movie and series playback is HLS-only. Use /api/xtream/hls.' });
  const controller = new AbortController();
  const connectionTimer = setTimeout(() => controller.abort(new Error('Provider connection timed out')), 15_000);
  connectionTimer.unref?.();
  const abortUpstream = () => controller.abort(new Error('Downstream client disconnected'));
  res.once('close', abortUpstream);
  try {
    const source = await getXtreamSource(req.params.sourceId, requestOwner(req));
    if (!source) return res.sendStatus(404);
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    if (req.params.kind === 'channel') return res.redirect(302, await sourceProviderUrl(source, req.params.kind, req.params.id, req.query.ext));
    const strategy = choosePlaybackStrategy({ purpose: 'direct-proxy', extension: req.query.ext });
    if (strategy !== PlaybackStrategy.DIRECT) throw new Error('Direct media strategy unavailable');
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    headers['user-agent'] = req.headers['user-agent'] || 'RH-Stream/1.0';
    const upstream = await fetch(await sourceProviderUrl(source, req.params.kind, req.params.id, req.query.ext), { headers, signal: controller.signal });
    clearTimeout(connectionTimer);
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(upstream.status || 502).json({ error: `Xtream media returned HTTP ${upstream.status}` });
    }
    for (const name of ['cache-control', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    // Some Xtream providers return the file's byte interval in Accept-Ranges
    // (for example "0-2385301832"). That is not valid HTTP: this header must
    // name the supported range unit. Roku's media parser rejects the malformed
    // response even though ffmpeg is lenient enough to accept it.
    res.setHeader('Accept-Ranges', 'bytes');
    res.status(upstream.status);
    if (!upstream.body) return res.end();
    activeDirectStreams += 1;
    let idleTimer;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('Provider media stream became idle')), mediaStreamIdleTimeoutMs);
      idleTimer.unref?.();
    };
    const idleWatchdog = new Transform({ transform(chunk, _encoding, callback) { resetIdleTimer(); callback(null, chunk); } });
    resetIdleTimer();
    try { await pipeline(Readable.fromWeb(upstream.body), idleWatchdog, res); }
    finally { clearTimeout(idleTimer); activeDirectStreams = Math.max(0, activeDirectStreams - 1); }
  } catch (error) {
    if (!res.headersSent && !res.destroyed) res.status(error.name === 'AbortError' ? 499 : 502).json({ error: error.message });
  } finally {
    clearTimeout(connectionTimer);
    res.off('close', abortUpstream);
  }
});

function rokuHlsKey(sourceId, kind, id, extension, startSeconds = 0) {
  // Segment URLs in an HLS manifest do not retain the manifest query string,
  // so every seek offset must be carried onto segment URLs and job identity.
  return createHash('sha256').update(`${sourceId}:${kind}:${id}:${startSeconds}`).digest('hex').slice(0, 24);
}

function hlsStartSeconds(value) {
  const parsed = Math.floor(Number(value) || 0);
  return Math.min(7 * 24 * 60 * 60, Math.max(0, parsed));
}

async function waitForHlsManifest(filename, timeoutMs = 15_000, signal) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw signal.reason || new Error('Manifest request cancelled');
    try {
      const stat = await fs.stat(filename);
      if (stat.size > 0) return true;
    } catch { /* ffmpeg has not produced the first segment yet */ }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  return false;
}

async function getOrStartRokuHls(source, kind, id, extension, requestedStart = 0, identity = {}) {
  const seekableVod = kind === 'movie' || kind === 'series';
  const startSeconds = seekableVod ? hlsStartSeconds(requestedStart) : 0;
  const key = rokuHlsKey(source._id, kind, id, extension, startSeconds);
  const existing = mediaJobs.get(key);
  if (existing) {
    if (existing.finished || existing.child?.exitCode !== null) {
      await mediaJobs.remove(key, 'restart-failed');
    } else {
    mediaJobs.touch(existing, identity.viewerId);
    return existing;
    }
  }

  // A device is limited to one active playback job. Release its previous
  // movie/channel before starting another one so normal navigation does not
  // return MEDIA_CAPACITY_FULL during the idle cleanup window.
  if (identity.deviceId) {
    for (const [otherKey, otherJob] of mediaJobs.entries()) {
      if (otherKey !== key && otherJob.persistent && otherJob.deviceId === identity.deviceId) {
        await mediaJobs.remove(otherKey, 'replaced-device-playback');
      }
    }
  }

  // Xtream accounts commonly allow only one live connection. Stop the prior
  // channel immediately when another channel is opened; otherwise the
  // provider responds with a tiny valid-but-completely-black placeholder.
  if (kind === 'channel') {
    for (const [otherKey, otherJob] of mediaJobs.entries()) {
      if (otherKey === key || !otherJob.persistent || otherJob.kind !== 'channel' || otherJob.sourceId !== String(source._id)) continue;
      await mediaJobs.remove(otherKey, 'replaced-channel');
    }
  }

  // A VOD seek replaces the prior stream for that item. Keeping both jobs
  // alive wastes Render CPU/disk and can exceed a provider's connection cap.
  if (seekableVod) {
    for (const [otherKey, otherJob] of mediaJobs.entries()) {
      if (otherKey === key || !otherJob.persistent || otherJob.kind !== kind || otherJob.sourceId !== String(source._id) || otherJob.mediaId !== String(id)) continue;
      await mediaJobs.remove(otherKey, 'replaced-seek');
    }
  }

  const decision = determineHlsStrategy();
  const mode = decision.strategy === HlsStrategy.FULL_TRANSCODE ? 'transcode' : 'remux';
  const { job } = await mediaJobs.getOrCreate({
    key, mode, hlsStrategy: decision.strategy, hlsVideoMode: decision.videoMode, hlsAudioMode: decision.audioMode, persistent: true, sourceId: String(source._id), mediaId: String(id), kind,
    startSeconds, userId: identity.userId, deviceId: identity.deviceId, viewerId: identity.viewerId,
  }, async () => {
    const inputUrl = await sourceProviderUrl(source, kind, id, extension);
    const directory = path.join(rokuHlsRoot, key);
    await fs.mkdir(directory, { recursive: true });
    const manifest = path.join(directory, 'master.m3u8');
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push(
    // Keep a live, rolling manifest. Do not mark it VOD or EVENT: VOD made Roku
    // freeze the first short manifest, while EVENT retains an unbounded history.
    // Keep ffmpeg near playback speed so it cannot run far ahead of Roku.
                  '-re', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', inputUrl,
    '-map', '0:v:0?', '-map', '0:a:0?', ...hlsCodecArgs(decision), '-sn', '-dn',
                  '-f', 'hls', '-hls_time', '2', '-hls_list_size', '30', '-hls_delete_threshold', '6',
                  '-hls_flags', 'independent_segments+temp_file+delete_segments',
    '-hls_segment_filename', path.join(directory, 'segment-%06d.ts'), manifest,
    );
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const created = {
      directory, manifest, child, inputUrl, error: '',
      stop: async () => { await terminateChild(child); await fs.rm(directory, { recursive: true, force: true }); },
    };
    child.stderr.on('data', chunk => {
      created.error = appendTail(created.error, chunk);
      const registered = mediaJobs.get(key);
      if (registered) registered.error = created.error;
    });
    child.on('error', error => {
      created.error = appendTail(created.error, error.message);
      const registered = mediaJobs.get(key);
      if (registered) registered.error = created.error;
    });
    child.on('close', code => {
      created.finished = true;
      const registered = mediaJobs.get(key);
      if (registered) registered.finished = true;
      const safeError = created.error.replaceAll(inputUrl, '[provider URL]');
      if (code !== 0 && code !== null) {
        console.warn(`[Media HLS] ${kind}:${id} exited ${code}: ${safeError.trim().slice(-240)}`);
        const active = mediaJobs.get(key);
        if (active?.child === child) mediaJobs.remove(key, 'ffmpeg-error').catch(() => {});
      }
    });
    return created;
  });
  return job;
}

// One centralized sweep owns idle FFmpeg jobs, cache pressure, and a second
// application-level segment bound in case a provider/ffmpeg edge case defeats
// the HLS delete flags.
let mediaHousekeepingRunning = false;
setInterval(async () => {
  if (mediaHousekeepingRunning) return;
  mediaHousekeepingRunning = true;
  try {
  const pressure = memoryPressure(mediaLimits);
  if (pressure.soft) { evictXtreamCache(Date.now(), true); evictM3uCache(Date.now(), true); }
  await mediaJobs.sweep({ aggressive: pressure.hard });
  await Promise.allSettled([...mediaJobs.values()].filter(job => job.persistent).map(enforceHlsFileBound));
  } finally { mediaHousekeepingRunning = false; }
}, 5_000).unref();

app.get('/api/xtream/hls/:sourceId/:kind/:id/master.m3u8', async (req, res) => {
  const requestAbort = new AbortController();
  res.once('close', () => requestAbort.abort(new Error('Manifest client disconnected')));
  try {
    // Channels use the same backend HLS pipeline as VOD. Redirecting Roku to
    // the provider's live manifest exposed malformed headers and provider
    // segment URLs directly to the TV.
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    const source = await getXtreamSource(req.params.sourceId, requestOwner(req));
    if (!source) return res.sendStatus(404);
    const seekableVod = req.params.kind === 'movie' || req.params.kind === 'series';
    const startSeconds = seekableVod ? hlsStartSeconds(req.query.start) : 0;
    const identity = mediaIdentity(req);
    const job = await getOrStartRokuHls(source, req.params.kind, req.params.id, req.query.ext, startSeconds, identity);
    if (!await waitForHlsManifest(job.manifest, 15_000, requestAbort.signal)) {
      return res.status(504).json({ error: job.error.trim().slice(-240) || 'HLS manifest is still being prepared' });
    }
    mediaJobs.touch(job, identity.viewerId);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    // Roku uses the device token on the manifest request, but relative HLS
    // segment URLs do not inherit that query string. Carry the token onto
    // each segment URL so the authenticated /api/xtream middleware accepts
    // the subsequent video requests instead of returning a JSON 401 body.
    let manifestText = await fs.readFile(job.manifest, 'utf8');
    const segmentQuery = new URLSearchParams();
    const deviceToken = String(req.query.deviceToken || '').trim();
    if (deviceToken) segmentQuery.set('deviceToken', deviceToken);
    const streamTicket = String(req.query.streamTicket || '').trim();
    if (streamTicket) segmentQuery.set('streamTicket', streamTicket);
    if (startSeconds > 0) segmentQuery.set('start', String(startSeconds));
    if ([...segmentQuery].length > 0) {
      const query = segmentQuery.toString();
      manifestText = manifestText.split('\n').map(line => (
        /^segment-\d{6}\.ts$/.test(line.trim()) ? `${line}?${query}` : line
      )).join('\n');
    }
    res.send(manifestText);
  } catch (error) {
    if (!res.headersSent && !res.destroyed && !capacityResponse(res, error)) res.status(502).json({ error: error.message });
  }
});

app.get('/api/xtream/hls/:sourceId/:kind/:id/:segment', async (req, res) => {
  try {
    if (!/^segment-\d{6}\.ts$/.test(req.params.segment)) return res.sendStatus(404);
    const seekableVod = req.params.kind === 'movie' || req.params.kind === 'series';
    const startSeconds = seekableVod ? hlsStartSeconds(req.query.start) : 0;
    const key = rokuHlsKey(req.params.sourceId, req.params.kind, req.params.id, req.query.ext, startSeconds);
    const job = mediaJobs.get(key);
    if (!job) return res.sendStatus(404);
    if (job.userId && job.userId !== mediaOwner(req)) return res.sendStatus(404);
    mediaJobs.touch(job, mediaIdentity(req).viewerId);
    const filename = path.join(job.directory, req.params.segment);
    await fs.access(filename);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filename);
  } catch { res.sendStatus(404); }
});

app.get('/api/xtream/roku/:sourceId/:kind/:id', async (req, res) => {
  return res.status(410).json({ error: 'Movie and series playback is HLS-only. Use /api/xtream/hls.' });
  let job;
  let jobKey = '';
  let outputStarted = false;
  let startupTimer;
  try {
    const source = await getXtreamSource(req.params.sourceId, requestOwner(req));
    if (!source) return res.sendStatus(404);
    if (!['movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);

    // Several Xtream providers send MPEG-TS even for URLs ending in .mp4.
    // Roku reports that mismatch as "malformed data (-5)". Fragmented MP4
    // keeps the original H.264/AAC tracks while giving Roku a valid MP4
    // streaming container without downloading the whole file first.
    const inputUrl = await sourceProviderUrl(source, req.params.kind, req.params.id, req.query.ext);
    const strategy = choosePlaybackStrategy({ purpose: 'roku-fragmented-mp4', extension: req.query.ext });
    const identity = mediaIdentity(req);
    jobKey = `roku-remux:${source._id}:${req.params.kind}:${req.params.id}:${Date.now()}:${mediaRequestSequence++}`;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputUrl,
      '-map', '0:v:0?', '-map', '0:a:0?',
      // Xtream's transport streams carry AAC in ADTS packets. MP4 does not
      // accept that packet format as-is: without this conversion ffmpeg emits
      // just the initial 6 KB header, exits, and Roku stays at 100% forever.
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-sn', '-dn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '2000000', '-flush_packets', '1',
      '-f', 'mp4', 'pipe:1',
    ];
    ({ job } = await mediaJobs.getOrCreate({
      key: jobKey,
      mode: strategy === PlaybackStrategy.TRANSCODE ? 'transcode' : 'remux',
      persistent: false,
      sourceId: String(source._id), mediaId: String(req.params.id), kind: req.params.kind,
      ...identity,
    }, async () => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      return { child, inputUrl, error: '', stop: () => terminateChild(child) };
    }));
    const { child } = job;
    child.stderr.on('data', chunk => { job.error = appendTail(job.error, chunk); });
    child.on('error', error => {
      console.error('[Xtream Roku remux] failed to start:', error.message);
      clearTimeout(startupTimer);
      job.finished = true;
      mediaJobs.remove(jobKey, 'spawn-error').catch(() => {});
      if (!res.headersSent) res.status(502).json({ error: 'Could not start Roku media remux' });
      else res.destroy(error);
    });
    child.on('close', code => {
      clearTimeout(startupTimer);
      job.finished = true;
      const safeErrorText = job.error.replaceAll(inputUrl, '[provider URL]');
      if (code !== 0 && code !== null) console.warn(`[Xtream Roku remux] ${req.params.kind}:${req.params.id} exited ${code}: ${safeErrorText.trim().slice(-240)}`);
      mediaJobs.remove(jobKey, 'complete').catch(() => {});
      if (outputStarted) {
        if (!res.writableEnded) res.end();
        return;
      }
      // Do not advertise an empty ffmpeg result as HTTP 200 video/mp4. Roku
      // interprets that response as malformed media (-5), hiding the actual
      // provider failure. Keep headers pending until media bytes exist.
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        const upstreamStatus = job.error.match(/Server returned (\d{3})/i)?.[1];
        const error = upstreamStatus
          ? `Movie source is unavailable (upstream HTTP ${upstreamStatus})`
          : 'Movie source did not return playable media';
        res.status(502).json({ error });
      }
    });
    res.once('close', () => { clearTimeout(startupTimer); mediaJobs.remove(jobKey, 'client-disconnect').catch(() => {}); });

    child.stdout.once('readable', () => {
      if (res.writableEnded || res.destroyed) return;
      outputStarted = true;
      clearTimeout(startupTimer);
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'none');
      pipeline(child.stdout, res).catch(error => {
        if (!res.destroyed) res.destroy(error);
        mediaJobs.remove(jobKey, 'stream-error').catch(() => {});
      });
    });
    startupTimer = setTimeout(() => {
      if (outputStarted || res.headersSent) return;
      mediaJobs.remove(jobKey, 'startup-timeout').catch(() => {});
      if (!res.destroyed && !res.writableEnded) res.status(504).json({ error: 'Movie source timed out before returning media' });
    }, 20_000);
    startupTimer.unref?.();
  } catch (error) {
    clearTimeout(startupTimer);
    if (jobKey) await mediaJobs.remove(jobKey, 'request-error').catch(() => {});
    if (!res.headersSent) {
      if (!capacityResponse(res, error)) res.status(502).json({ error: error.message });
    } else res.destroy(error);
  }
});
async function buildXtreamSeriesPayload({ limit, selected: suppliedSelected } = {}) {
  let selected = suppliedSelected || (await getAllXtreamItems('series')).slice().sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
  if (Number.isFinite(limit) && limit > 0) selected = selected.slice(0, limit);
  let cursor = 0;
  const groups = new Array(selected.length);
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor++;
      const seriesItem = selected[index];
      const items = [];
      try {
        const source = await getXtreamSource(seriesItem.sourceId);
        if (!source) { groups[index] = items; continue; }
        const details = await getXtreamSeriesEpisodes(source, seriesItem.id);
        for (const episode of details.episodes) {
          const extension = String(episode.extension || '').toLowerCase();
          const playbackUrl = rokuXtreamPlaybackPath(source._id, 'series', episode.id, extension);
          const title = episode.title || `${details.title} · ${episode.episodeNumber}`;
          items.push({
            id: episode.id,
            sourceId: String(source._id),
            favoriteId: `xtream:${source._id}:series:${episode.id}`,
            source: 'xtream', kind: 'episode', contentKind: 'episode',
            title, rokuTitle: rokuText(title), rokuTextKind: /[A-Za-z]/.test(title) ? 'latin' : 'arabic',
            seriesTitle: details.title, rokuSeriesTitle: rokuText(details.title),
            seasonTitle: episode.seasonTitle, rokuSeasonTitle: rokuText(episode.seasonTitle),
            seasonSort: episode.seasonNumber, episodeNumber: episode.episodeNumber,
            duration: displayDuration(episode.duration), thumbnail: episode.thumbnail,
            category: seriesItem.category,
            rokuCategory: seriesItem.rokuCategory,
            language: seriesItem.language,
            added: seriesItem.added,
            url: playbackUrl, playbackUrl, streamFormat: rokuXtreamStreamFormat(extension),
            originalFormat: extension || 'mp4',
          });
        }
      } catch (error) {
        console.warn(`[Xtream] Could not expand series ${seriesItem.title}: ${error.message}`);
      }
      groups[index] = items;
    }
  }
  // More than two concurrent get_series_info payloads can exhaust Render's
  // small heap for long-running series.
  const concurrency = Math.min(2, Math.max(1, selected.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return groups.flat();
}
app.get('/api/roku/library', async (req, res) => {
  try {
    // Compatibility for older Roku packages. This remains limited to the
    // saved frontend selection, never the provider's full catalog.
    const [selectedSeries, selectedMovies, selectedChannels] = await Promise.all([
      getRokuSelectedItems('series', requestOwner(req)), getRokuSelectedItems('movie', requestOwner(req)), getRokuSelectedItems('channel', requestOwner(req)),
    ]);
    const [series, movies, channels] = await Promise.all([
      buildXtreamSeriesPayload({ selected: selectedSeries.slice(0, rokuInitialSeriesLimit) }),
      buildXtreamMoviesPayload({ selected: selectedMovies }),
      Promise.resolve(buildXtreamChannelsPayload(selectedChannels)),
    ]);
    res.json({ items: [...series, ...movies, ...channels] });
  }
  catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/roku/series', async (req, res) => {
  try {
    const pageInfo = rokuPage(req, rokuCatalogPageLimit);
    pageInfo.limit = rokuCatalogPageLimit;
    pageInfo.offset = pageInfo.page * pageInfo.limit;
    const category = String(req.query.category || '');
    const selected = (await getRokuSelectedItems('series', requestOwner(req)))
      .filter(item => !category || item.category === category)
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
    const sourcePage = selected.slice(pageInfo.offset, pageInfo.offset + pageInfo.limit);
    const items = sourcePage.map(item => ({
      id: `series-search:${item.sourceId}:${item.id}`,
      title: item.title,
      rokuTitle: rokuText(item.title),
      rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
      category: item.category,
      language: item.language,
      sourceId: String(item.sourceId),
      seriesId: item.id,
      thumbnail: item.logo,
      added: item.added,
      contentKind: 'series-search',
      originalFormat: String(item.extension || 'mp4').replace(/[^a-z0-9]/gi, '').toUpperCase(),
    }));
    console.log(`[Roku] Series page ${pageInfo.page} ready: ${items.length}/${selected.length}`);
    res.json({
      items,
      page: pageInfo.page,
      limit: pageInfo.limit,
      total: selected.length,
      hasMore: pageInfo.offset + sourcePage.length < selected.length,
    });
  } catch (error) {
    console.error('[Roku] Series catalog failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});
app.get('/api/roku/channels', async (req, res) => {
  try {
    const pageInfo = rokuPage(req, rokuCatalogPageLimit);
    pageInfo.limit = rokuCatalogPageLimit;
    pageInfo.offset = pageInfo.page * pageInfo.limit;
    const selected = (await getRokuSelectedItems('channel', requestOwner(req)))
      .slice()
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
    const sourcePage = selected.slice(pageInfo.offset, pageInfo.offset + pageInfo.limit);
    const items = buildXtreamChannelsPayload(sourcePage);
    res.json({
      items,
      page: pageInfo.page,
      limit: pageInfo.limit,
      total: selected.length,
      hasMore: pageInfo.offset + sourcePage.length < selected.length,
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
// Render storage is ephemeral, but a process crash can leave the prior job
// directories behind for the lifetime of the container.
await fs.rm(rokuHlsRoot, { recursive: true, force: true });
await fs.mkdir(rokuHlsRoot, { recursive: true });

const resourceLogIntervalMs = Math.max(60_000, Number.parseInt(process.env.MEDIA_RESOURCE_LOG_INTERVAL_MS || '300000', 10) || 300_000);
setInterval(async () => {
  try {
    const snapshot = await mediaHealthSnapshot();
    console.log(`[Media health] rss=${snapshot.rssMB}MB heap=${snapshot.heapUsedMB}MB direct=${snapshot.activeDirectStreams} remux=${snapshot.activeRemuxJobs} transcode=${snapshot.activeTranscodes} hls=${snapshot.hlsDiskUsageMB}MB`);
  } catch (error) { console.warn(`[Media health] snapshot failed: ${error.message}`); }
}, resourceLogIntervalMs).unref();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`RH Stream API listening on http://0.0.0.0:${port}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal} received; draining media jobs`);
  const closeServer = new Promise(resolve => server.close(resolve));
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref?.();
  await Promise.allSettled([closeServer, mediaJobs.shutdown()]);
  await fs.rm(rokuHlsRoot, { recursive: true, force: true }).catch(error => console.warn(`[Media] HLS cleanup failed: ${error.message}`));
  clearTimeout(forceTimer);
  process.exit(0);
}

process.once('SIGTERM', () => { shutdown('SIGTERM').catch(error => { console.error(error); process.exit(1); }); });
process.once('SIGINT', () => { shutdown('SIGINT').catch(error => { console.error(error); process.exit(1); }); });
