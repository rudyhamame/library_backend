import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeArabicForRoku } from './arabic-shaper.js';
import { createXtreamSource, deleteXtreamSource, getAllXtreamSources, getXtreamSource, getXtreamSources, publicXtreamSource, updateXtreamSelection, updateXtreamSource } from './xtream-store.js';
import { evictXtreamCache, getXtreamCatalog, getXtreamCategories, getXtreamMovieInfo, getXtreamSeriesEpisodes, validateXtreamConnection, xtreamCacheStats, xtreamProviderUrl } from './xtream.js';
import { evictM3uCache, getM3uCatalog, getM3uCategories, m3uCacheStats, m3uProviderUrl, validateM3uConnection } from './m3u.js';
import { MediaCapacityError, MediaJobManager, defaultMediaLimits, memoryPressure } from './media-job-manager.js';
import { HlsStrategy, PlaybackStrategy, choosePlaybackStrategy, determineHlsStrategy, hlsCodecArgs } from './playback-strategy.js';
import { getPlayback, getPlaybackHistory, savePlayback } from './playback-store.js';
import { getFavorites, toggleFavorite } from './favorites-store.js';
import { changeAccountPassword, createDeviceSession, getLinkedDevices, getPairingInfo, getRokuDeviceSessionStatus, loginAccount, loginDeviceSession, recordDeviceHeartbeat, resolveDeviceToken, setupDeviceSession, unlinkAccountDevice } from './device-sessions.js';

const app = express();
const port = process.env.PORT || 8787;
let dashboardCache = { expires: 0, data: null };
const dashboardTimeZones = { toronto: 'America/Toronto', latakia: 'Asia/Damascus' };
const previewCache = new Map();
const arabicText = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const rokuText = (value) => arabicText.test(String(value || '')) ? shapeArabicForRoku(value) : String(value || '');
// Roku cannot reliably receive a JSON document containing a provider's entire
// catalog (this source alone has 44,995 series). Keep the initial screen fast;
// additional catalog pages are loaded separately by the Roku client.
// Each series can contain hundreds of episode records. A small page is
// intentional on Render's 256 MB instance; Roku loads further pages only when
// the user reaches the end of the current series list.
const rokuInitialSeriesLimit = Math.min(4, Math.max(1, Number.parseInt(process.env.ROKU_INITIAL_SERIES_LIMIT || '4', 10)));
const rokuMoviePageLimit = 10;
const xtreamItemsInFlight = new Map();
const rokuHlsRoot = path.join(os.tmpdir(), 'rh-stream-hls');
const frontendUrl = process.env.FRONTEND_URL || 'https://rh-stream-frontend.onrender.com';
const mediaLimits = defaultMediaLimits();
const debugMediaLogging = String(process.env.DEBUG_MEDIA_LOGGING || 'false').toLowerCase() === 'true';
const mediaJobs = new MediaJobManager({ limits: mediaLimits, debug: debugMediaLogging });
const hlsMaxSegments = Math.max(12, Number.parseInt(process.env.HLS_MAX_SEGMENTS || '36', 10) || 36);
const previewCacheMaxEntries = Math.max(2, Number.parseInt(process.env.PREVIEW_CACHE_MAX_ENTRIES || '12', 10) || 12);
const previewCacheMaxBytes = Math.max(2, Number.parseInt(process.env.PREVIEW_CACHE_MAX_MB || '12', 10) || 12) * 1024 * 1024;
const previewCacheTtlMs = Math.max(60_000, Number.parseInt(process.env.PREVIEW_CACHE_TTL_MS || '3600000', 10) || 3_600_000);
const mediaStreamIdleTimeoutMs = Math.max(10_000, Number.parseInt(process.env.MEDIA_STREAM_IDLE_TIMEOUT_MS || '45000', 10) || 45_000);
let previewCacheBytes = 0;
let activeDirectStreams = 0;
let shuttingDown = false;
let mediaRequestSequence = 0;

const sourceType = source => source?.type === 'm3u' ? 'm3u' : 'xtream';
const getSourceCatalog = (source, kind) => sourceType(source) === 'm3u' ? getM3uCatalog(source, kind) : getXtreamCatalog(source, kind);
const getSourceCategories = (source, kind) => sourceType(source) === 'm3u' ? getM3uCategories(source, kind) : getXtreamCategories(source, kind);
const sourceProviderUrl = (source, kind, id, extension = '') => sourceType(source) === 'm3u' ? m3uProviderUrl(source, kind, id) : xtreamProviderUrl(source, kind, id, extension);

function mediaIdentity(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  const session = resolveDeviceToken(token);
  return {
    userId: String(session?.ownerId || ''),
    deviceId: String(session?.deviceId || ''),
    viewerId: String(session?.deviceId || session?.ownerId || req.ip || 'anonymous'),
  };
}

function appendTail(current, chunk, maxBytes = 8_000) {
  return `${current}${chunk}`.slice(-maxBytes);
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

function evictPreviewCache(now = Date.now(), aggressive = false) {
  for (const [key, entry] of previewCache) {
    if (entry.expires > now) continue;
    previewCache.delete(key);
    previewCacheBytes -= entry.bytes;
  }
  while (previewCache.size > previewCacheMaxEntries || previewCacheBytes > previewCacheMaxBytes) {
    const key = previewCache.keys().next().value;
    const entry = previewCache.get(key);
    previewCache.delete(key);
    previewCacheBytes -= entry?.bytes || 0;
  }
  if (aggressive) {
    while (previewCache.size > 2) {
      const key = previewCache.keys().next().value;
      const entry = previewCache.get(key);
      previewCache.delete(key);
      previewCacheBytes -= entry?.bytes || 0;
    }
  }
}

function cachePreview(key, frame) {
  const prior = previewCache.get(key);
  if (prior) previewCacheBytes -= prior.bytes;
  previewCache.delete(key);
  previewCache.set(key, { frame, bytes: frame.length, expires: Date.now() + previewCacheTtlMs });
  previewCacheBytes += frame.length;
  evictPreviewCache();
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

function freshDashboardTimes(data) {
  return { ...data, cities: (data?.cities || []).map(city => ({
    ...city,
    time: cityIsoMinute(dashboardTimeZones[city.id] || 'UTC'),
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

async function getRokuSelectedItems(kind, ownerId = null) {
  // Roku is fed only from the explicit frontend selection. This avoids
  // downloading and expanding a provider's whole catalog on the TV.
  if (!ownerId) return [];
  const sources = await getAllXtreamSources(ownerId);
  const groups = await Promise.all(sources.map(async source => {
    let categoryNames = new Map();
    try {
      categoryNames = new Map((await getSourceCategories(source, kind)).map(category => [String(category.id), category.name]));
    } catch (error) {
      console.warn(`[Xtream] Could not refresh ${kind} categories for Roku: ${error.message}`);
    }
    return (Array.isArray(source.enabledItems) ? source.enabledItems : [])
      .filter(item => item?.kind === kind)
      .map(item => selectedXtreamItem(source, {
        ...item,
        category: categoryNames.get(String(item.categoryId || '')) || item.category,
      }));
  }));
  return groups.flat();
}

function directXtreamItem(item) {
  const extension = String(item.extension || '').toLowerCase();
  // Every movie and series VOD item uses the seek-aware HLS pipeline,
  // regardless of its provider container.
  const playbackUrl = rokuXtreamPlaybackPath(item.sourceId, item.kind, item.id, extension);
  return {
    ...item,
    source: 'xtream',
    favoriteId: `xtream:${item.sourceId}:${item.kind}:${item.id}`,
    url: playbackUrl,
    playbackUrl,
    rokuTitle: rokuText(item.title),
    rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
    streamFormat: 'hls',
  };
}

function rokuXtreamPlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

app.use(cors());
app.use(express.json());

// The Roku displays a short-lived QR/device code. The phone signs up or signs
// in, then the Roku polls for approval and receives its token automatically.
app.post('/api/roku/device-session', (req, res) => {
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
  res.json(createDeviceSession(deviceId, frontendUrl));
});
app.get('/api/roku/device-session', (req, res) => {
  const deviceId = String(req.query.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
  res.json(createDeviceSession(deviceId, frontendUrl));
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
    const result = await unlinkAccountDevice(session.accountId, session.deviceId);
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
app.post('/api/device-session/setup', async (req, res) => {
  try {
    const result = await setupDeviceSession(req.body?.code, req.body?.email, req.body?.password);
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
    res.json({ items: await getLinkedDevices(accountId) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/roku/heartbeat', async (req, res) => {
  try {
    const session = resolveDeviceToken(String(req.get('x-device-token') || req.query.deviceToken || ''));
    if (!session?.deviceId) return res.status(401).json({ error: 'Valid Roku device authorization is required' });
    await recordDeviceHeartbeat(session.deviceId, req.body?.streaming === true);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/account/devices/:deviceId', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to unlink a Roku device' });
    const result = await unlinkAccountDevice(accountId, req.params.deviceId);
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
      previews: previewCache.size,
      previewMB: Number((previewCacheBytes / 1024 / 1024).toFixed(1)),
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
  if (!requestOwner(req)) return res.status(401).json({ error: 'Pair this browser with a Roku device first' });
  next();
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
    const [selectedSeries, selectedMovies] = await Promise.all([
      getRokuSelectedItems('series', requestOwner(req)), getRokuSelectedItems('movie', requestOwner(req)),
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
    }));
    const movies = newestFirst(selectedMovies).map((item) => ({
      ...directXtreamItem(item),
      thumbnail: item.logo,
      kind: 'movie',
      contentKind: 'movie',
      rokuEnabled: true,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ items: [...series, ...movies] });
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
  // Many Xtream VOD catalogs omit duration from get_vod_streams. Ask for
  // detailed metadata only for the small, explicitly-selected Roku library.
  let cursor = 0;
  const results = new Array(movies.length);
  async function worker() {
    while (cursor < movies.length) {
      const index = cursor++;
      const item = movies[index];
      let duration = displayDuration(item.duration);
      if (!duration) {
        try {
          const source = await getXtreamSource(item.sourceId);
          if (source) duration = displayDuration((await getXtreamMovieInfo(source, item.id)).duration);
        } catch (error) {
          console.warn(`[Xtream] Could not read movie duration for ${item.id}: ${error.message}`);
        }
      }
      results[index] = { ...directXtreamItem(item), duration, kind: 'movie', contentKind: 'movie', rokuEnabled: true };
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, movies.length) }, worker));
  return results;
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
app.get('/api/playback/history', async (_, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const items = await getPlaybackHistory();
    res.json({ items: items.map((item) => ({ ...item, rokuTitle: rokuText(item.title) })) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

function parseXtreamPlaybackItem(itemId) {
  const parsed = new URL(String(itemId || ''), 'http://rh-stream.internal');
  const match = parsed.pathname.match(/^\/api\/xtream\/(?:play|roku)\/([^/]+)\/(movie|series)\/([^/]+)$/);
  if (!match) return null;
  return {
    sourceId: decodeURIComponent(match[1]),
    kind: match[2],
    id: decodeURIComponent(match[3]),
    extension: parsed.searchParams.get('ext') || 'mp4',
  };
}

async function capturePreview(inputUrl, position, key, identity) {
  const { job } = await mediaJobs.getOrCreate({
    key,
    mode: choosePlaybackStrategy({ purpose: 'preview' }) === PlaybackStrategy.TRANSCODE ? 'transcode' : 'remux',
    persistent: false,
    // Preview captures are short-lived support work and must not consume the
    // device's one active playback slot while the user is scrubbing.
    ...identity, userId: '', deviceId: '',
  }, async () => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, position)), '-i', inputUrl,
      '-an', '-sn', '-frames:v', '1',
      '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
      '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const created = { child, error: '', stop: () => terminateChild(child) };
    created.result = new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
      timeout.unref?.();
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total <= 5 * 1024 * 1024) chunks.push(chunk);
        else child.kill('SIGKILL');
      });
      child.stderr.on('data', chunk => { created.error = appendTail(created.error, chunk); });
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timeout);
        created.finished = true;
        if (code === 0 && total > 0 && total <= 5 * 1024 * 1024) resolve(Buffer.concat(chunks));
        else reject(new Error(created.error.trim().slice(-300) || `ffmpeg exited with ${code}`));
      });
    });
    return created;
  });
  try { return await job.result; }
  finally { await mediaJobs.remove(key, 'preview-complete'); }
}

app.get('/api/playback/preview', async (req, res) => {
  let previewJobKey = '';
  const cancelPreview = () => { if (previewJobKey) mediaJobs.remove(previewJobKey, 'client-disconnect').catch(() => {}); };
  res.once('close', cancelPreview);
  try {
    const itemId = String(req.query?.itemId || '');
    const requestedSourceId = String(req.query?.sourceId || '');
    const requestedKind = String(req.query?.kind || '');
    const requestedId = String(req.query?.id || '');
    let playback = null;
    let target = requestedSourceId && ['movie', 'series'].includes(requestedKind) && requestedId
      ? { sourceId: requestedSourceId, kind: requestedKind, id: requestedId, extension: String(req.query?.ext || 'mp4') }
      : null;
    if (!target) {
      if (!itemId) return res.status(400).json({ error: 'itemId or playback target is required' });
      playback = await getPlayback(itemId);
      if (!playback) return res.sendStatus(404);
      target = parseXtreamPlaybackItem(playback.url || itemId);
    }
    if (!target) return res.status(404).json({ error: 'Preview is unavailable for this item' });
    const source = await getXtreamSource(target.sourceId, requestOwner(req));
    if (!source) return res.sendStatus(404);
    const position = Math.max(0, Math.floor(Number(req.query?.position ?? playback?.position) || 0));
    const cacheKey = `${target.sourceId}:${target.kind}:${target.id}:${target.extension}:${position}`;
    evictPreviewCache();
    let frame = previewCache.get(cacheKey)?.frame;
    if (!frame) {
      previewJobKey = `preview:${createHash('sha256').update(cacheKey).digest('hex').slice(0, 24)}`;
      frame = await capturePreview(await sourceProviderUrl(source, target.kind, target.id, target.extension), position, previewJobKey, mediaIdentity(req));
      cachePreview(cacheKey, frame);
    }
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Length': String(frame.length) });
    res.end(frame);
  } catch (error) {
    console.warn(`[Playback preview] ${error.message}`);
    if (!res.headersSent && !res.destroyed && !capacityResponse(res, error)) res.status(502).json({ error: 'Could not capture the saved playback frame' });
  } finally { res.off('close', cancelPreview); }
});
app.get('/api/favorites', async (_, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ items: await getFavorites() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
async function toggleFavoriteRequest(req, res) {
  try {
    const id = String(req.query?.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    res.json(await toggleFavorite({ id, title: req.query?.title || req.body?.title, kind: req.query?.kind || req.body?.kind }));
  } catch (error) { res.status(500).json({ error: error.message }); }
}
app.post('/api/favorites/toggle', toggleFavoriteRequest);
app.put('/api/favorites/toggle', toggleFavoriteRequest);
app.get('/api/favorites/toggle', toggleFavoriteRequest);
app.get('/api/playback/roku/get', async (req, res) => {
  try {
    const itemId = String(req.query?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    res.set('Cache-Control', 'no-store');
    res.json({ item: await getPlayback(itemId) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/playback/roku/save', async (req, res) => {
  try {
    const itemId = String(req.query?.itemId || req.body?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    const completedValue = String(req.query?.completed ?? req.body?.completed ?? 'false').toLowerCase();
    const payload = {
      itemId,
      title: String(req.query?.title ?? req.body?.title ?? ''),
      source: String(req.query?.source ?? req.body?.source ?? 'roku'),
      url: itemId,
      position: Number(req.query?.position ?? req.body?.position ?? 0),
      duration: Number(req.query?.duration ?? req.body?.duration ?? 0),
      completed: completedValue === 'true' || completedValue === '1',
    };
    const item = await savePlayback(payload);
    console.log(`[Roku playback] saved ${itemId} at ${item.position}s`);
    res.json({ item });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/playback/:itemId', async (req, res) => {
  try { res.json({ item: await getPlayback(String(req.params.itemId)) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/playback/get', async (req, res) => {
  try {
    const itemId = String(req.body?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    res.json({ item: await getPlayback(itemId) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/playback/:itemId', async (req, res) => {
  try {
    const item = await savePlayback({ itemId: String(req.params.itemId), ...req.body });
    res.json({ item });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/playback', async (req, res) => {
  try {
    const itemId = String(req.body?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    res.json({ item: await savePlayback({ itemId, ...req.body }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/dashboard', async (_, res) => {
  try {
    // Weather is cached, but clock values must be generated for every request
    // so the minute display never remains frozen for the cache lifetime.
    if (dashboardCache.expires > Date.now()) return res.json(freshDashboardTimes(dashboardCache.data));
    const locations = [
      { id: 'toronto', label: 'TORONTO, CANADA', latitude: 43.6532, longitude: -79.3832, timezone: 'America/Toronto' },
      { id: 'latakia', label: 'LATAKIA, SYRIA', latitude: 35.5317, longitude: 35.7917, timezone: 'Asia/Damascus' },
    ];
    const cities = await Promise.all(locations.map(async (location) => {
      const query = new URLSearchParams({
        latitude: location.latitude, longitude: location.longitude,
        current: 'temperature_2m,weather_code', timezone: location.timezone,
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
      const data = await response.json();
      return { id: location.id, label: location.label, time: data.current?.time || '', temperature: data.current?.temperature_2m, weatherCode: data.current?.weather_code };
    }));
    dashboardCache = { expires: Date.now() + 120_000, data: { backend: 'online', cities } };
    res.json(freshDashboardTimes(dashboardCache.data));
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
    const target = new URL(supplied);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported logo URL');
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(target.hostname)) throw new Error('Unsupported logo host');

    const response = await fetch(target, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) return res.sendStatus(response.status === 404 ? 404 : 502);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) return res.status(415).send('Logo is not an image');
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
    res.set('Content-Type', contentType.split(';', 1)[0]);
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
    if (!await deleteXtreamSource(req.params.id, requestOwner(req))) return res.sendStatus(404);
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
    const [allItems, categories] = await Promise.all([getSourceCatalog(source, kind), getSourceCategories(source, kind)]);
    const enabled = new Set(source.enabledKeys || []);
    const query = String(req.query.q || '').trim().toLocaleLowerCase();
    const category = String(req.query.category || 'all');
    const titleLanguage = String(req.query.titleLanguage || req.query.language || 'all').toUpperCase();
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(req.query.limit, 10) || 50));
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const languagePriority = { AR: 0, EN: 1 };
    const languageSet = new Set();
    const filtered = [];
    for (const item of allItems) {
      const languageCode = titleLanguageCode(item);
      languageSet.add(languageCode);
      if ((category === 'all' || item.categoryId === category)
        && (titleLanguage === 'ALL' || languageCode === titleLanguage)
        && (!query || item.title.toLocaleLowerCase().includes(query))) {
        filtered.push({ ...item, languageCode, titleLanguage: languageCode });
      }
    }
    const languages = [...languageSet]
      .sort((a, b) => (languagePriority[a] ?? 10) - (languagePriority[b] ?? 10) || a.localeCompare(b));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const start = (page - 1) * pageSize;
    res.json({
      source: publicXtreamSource(source), categories, languages,
      items: filtered.slice(start, start + pageSize).map(item => ({ ...item, enabled: enabled.has(item.key) })),
      pagination: { page, pageSize, pageCount, total: filtered.length },
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/xtream/movie/:sourceId/:id/duration', async (req, res) => {
  try {
    const source = await getXtreamSource(req.params.sourceId, requestOwner(req));
    if (!source) return res.sendStatus(404);
    const info = await getXtreamMovieInfo(source, req.params.id);
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ seconds: info.seconds, duration: info.duration });
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
    if (!Array.isArray(req.body?.enabledKeys)) return res.status(400).json({ error: 'enabledKeys must be an array' });
    const source = await getXtreamSource(req.params.id, requestOwner(req));
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
    }, requestOwner(req));
    if (!updated) return res.sendStatus(404);
    res.json(updated);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key', async (req, res) => {
  try {
    const source = await getXtreamSource(req.params.id, requestOwner(req));
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
    }, requestOwner(req));
    res.json(updated);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key/restore', async (req, res) => {
  try {
    const source = await getXtreamSource(req.params.id, requestOwner(req));
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
    }, requestOwner(req));
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
    mediaJobs.touch(existing, identity.viewerId);
    return existing;
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
                  '-re', '-i', inputUrl,
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
      if (code !== 0 && code !== null) console.warn(`[Media HLS] ${kind}:${id} exited ${code}: ${safeError.trim().slice(-240)}`);
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
  if (pressure.soft) { evictXtreamCache(Date.now(), true); evictM3uCache(Date.now(), true); evictPreviewCache(Date.now(), true); }
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
    if (job.userId && job.userId !== requestOwner(req)) return res.sendStatus(404);
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
            id: `xtream:${source._id}:series:${episode.id}`,
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
            url: playbackUrl, playbackUrl, streamFormat: 'hls',
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
    const pageInfo = rokuPage(req, rokuInitialSeriesLimit);
    pageInfo.limit = Math.min(4, pageInfo.limit);
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
    }));
    console.log(`[Roku] Series summary page ${pageInfo.page} ready: ${items.length} series`);
    res.json({ items, page: pageInfo.page, limit: pageInfo.limit, total: selected.length, hasMore: pageInfo.offset + sourcePage.length < selected.length });
  } catch (error) {
    console.error('[Roku] Series catalog failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});
app.get('/api/roku/channels', async (req, res) => {
  try {
    const items = buildXtreamChannelsPayload(await getRokuSelectedItems('channel', requestOwner(req)));
    res.json({ items, page: 0, limit: items.length, total: items.length, hasMore: false });
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
