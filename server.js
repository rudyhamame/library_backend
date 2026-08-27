import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeArabicForRoku } from './arabic-shaper.js';
import { createXtreamSource, deleteXtreamSource, getAllXtreamSources, getXtreamSource, getXtreamSources, publicXtreamSource, updateXtreamSelection, updateXtreamSource } from './xtream-store.js';
import { getXtreamCatalog, getXtreamCategories, getXtreamMovieInfo, getXtreamSeriesEpisodes, validateXtreamConnection, xtreamPlaybackPath, xtreamProviderUrl } from './xtream.js';
import { getPlayback, getPlaybackHistory, savePlayback } from './playback-store.js';
import { getFavorites, toggleFavorite } from './favorites-store.js';
import { createDeviceSession, getPairingInfo, loginDeviceSession, resolveDeviceToken, setupDeviceSession } from './device-sessions.js';

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
const rokuHlsJobs = new Map();
const rokuHlsRoot = path.join(os.tmpdir(), 'rh-stream-hls');
const frontendUrl = process.env.FRONTEND_URL || 'https://rh-stream-frontend.onrender.com';

function requestOwner(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  return resolveDeviceToken(token)?.ownerId || null;
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
        const [catalog, categories] = await Promise.all([getXtreamCatalog(source, kind), getXtreamCategories(source, kind)]);
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
      categoryNames = new Map((await getXtreamCategories(source, kind)).map(category => [String(category.id), category.name]));
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
  // Use Roku's direct MP4 proxy when the provider explicitly supplies an MP4
  // stream. This keeps VOD playback to one authenticated request instead of
  // relying on HLS segment URL handling on the device.
  const useDirectMp4 = extension === 'mp4' && (item.kind === 'movie' || item.kind === 'series');
  let playbackUrl = rokuXtreamPlaybackPath(item.sourceId, item.kind, item.id, extension);
  if (useDirectMp4) playbackUrl = rokuDirectMp4PlaybackPath(item.sourceId, item.kind, item.id, extension);
  return {
    ...item,
    source: 'xtream',
    favoriteId: `xtream:${item.sourceId}:${item.kind}:${item.id}`,
    url: playbackUrl,
    playbackUrl,
    rokuTitle: rokuText(item.title),
    rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
    // Valid MP4 files support immediate ranged playback and avoid waiting for
    // an ffmpeg HLS cold start. Live/non-MP4 sources retain the HLS pipeline.
    streamFormat: useDirectMp4 ? 'mp4' : 'hls',
  };
}

function rokuXtreamPlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

function rokuDirectMp4PlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `/api/xtream/roku/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

app.use(cors());
app.use(express.json());

// Pairing is intentionally short-lived and device scoped. The Roku displays
// the pair URL as a QR code; the browser claims it and then uses the returned
// token on every manager request.
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
    const session = await getPairingInfo(req.query.code);
    if (!session) return res.status(404).json({ error: 'Pairing code expired' });
    res.json(session);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/info', async (req, res) => {
  try {
    const session = await getPairingInfo(req.body?.code);
    if (!session) return res.status(404).json({ error: 'Pairing code expired or invalid' });
    res.json(session);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/setup', async (req, res) => {
  try {
    const result = await setupDeviceSession(req.body?.code, req.body?.password);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/login', async (req, res) => {
  try {
    const result = await loginDeviceSession(req.body?.code, req.body?.password);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 401).json(result);
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

function capturePreview(inputUrl, position) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, position)), '-i', inputUrl,
      '-an', '-sn', '-frames:v', '1',
      '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
      '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let errorText = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.on('data', chunk => {
      total += chunk.length;
      if (total <= 5 * 1024 * 1024) chunks.push(chunk);
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { errorText += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0 && total > 0 && total <= 5 * 1024 * 1024) resolve(Buffer.concat(chunks));
      else reject(new Error(errorText.trim().slice(-300) || `ffmpeg exited with ${code}`));
    });
  });
}

app.get('/api/playback/preview', async (req, res) => {
  try {
    const itemId = String(req.query?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    const playback = await getPlayback(itemId);
    if (!playback) return res.sendStatus(404);
    const target = parseXtreamPlaybackItem(playback.url || itemId);
    if (!target) return res.status(404).json({ error: 'Preview is unavailable for this item' });
    const source = await getXtreamSource(target.sourceId);
    if (!source) return res.sendStatus(404);
    const position = Math.max(0, Math.floor(Number(playback.position) || 0));
    const cacheKey = `${itemId}:${position}`;
    let frame = previewCache.get(cacheKey);
    if (!frame) {
      frame = await capturePreview(xtreamProviderUrl(source, target.kind, target.id, target.extension), position);
      previewCache.set(cacheKey, frame);
      while (previewCache.size > 30) previewCache.delete(previewCache.keys().next().value);
    }
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Length': String(frame.length) });
    res.end(frame);
  } catch (error) {
    console.warn(`[Playback preview] ${error.message}`);
    res.status(502).json({ error: 'Could not capture the saved playback frame' });
  }
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
function parseXtreamInput(body, existing = null) {
  const name = String(body?.name || existing?.name || '').trim();
  const supplied = String(body?.url || '').trim();
  if (!name) throw new Error('Source name is required');
  if (!supplied && existing) return { name };
  if (!supplied) throw new Error('Paste the Xtream get.php URL');
  let url;
  try { url = new URL(supplied); } catch { throw new Error('Enter a valid Xtream URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Xtream URL must use HTTP or HTTPS');
  const username = String(url.searchParams.get('username') || body?.username || '').trim();
  const password = String(url.searchParams.get('password') || body?.password || '').trim();
  if (!username || !password) throw new Error('The Xtream URL must include username and password');
  const pathname = url.pathname.replace(/\/(?:get|player_api)\.php\/?$/i, '').replace(/\/$/, '');
  return { name, baseUrl: `${url.protocol}//${url.host}${pathname}`, username, password };
}

app.get('/api/xtream/sources', async (req, res) => {
  try { res.json({ items: await getXtreamSources(requestOwner(req)) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// Provider channel logos are often published over HTTP.  The Render frontend
// is HTTPS, so browsers block those images as mixed content.  Serve the small
// logo through this HTTPS backend endpoint instead.
app.get('/api/xtream/logo', async (req, res) => {
  try {
    const supplied = String(req.query.url || '').trim();
    const target = new URL(supplied);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported logo URL');
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(target.hostname)) throw new Error('Unsupported logo host');

    const response = await fetch(target, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) return res.sendStatus(response.status === 404 ? 404 : 502);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) return res.status(415).send('Logo is not an image');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024) return res.status(413).send('Logo is too large');
    res.set('Content-Type', contentType.split(';', 1)[0]);
    res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.send(bytes);
  } catch (error) {
    res.status(400).send(error.message || 'Invalid logo URL');
  }
});

app.post('/api/xtream/sources', async (req, res) => {
  try {
    const source = parseXtreamInput(req.body);
    await validateXtreamConnection({ ...source, _id: 'validation' });
    res.status(201).json(await createXtreamSource({ ...source, ownerId: requestOwner(req) }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id', async (req, res) => {
  try {
    const existing = await getXtreamSource(req.params.id, requestOwner(req));
    if (!existing) return res.sendStatus(404);
    const changes = parseXtreamInput(req.body, existing);
    if (changes.baseUrl) await validateXtreamConnection({ ...existing, ...changes });
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
    const [allItems, categories] = await Promise.all([getXtreamCatalog(source, kind), getXtreamCategories(source, kind)]);
    const enabled = new Set(source.enabledKeys || []);
    const query = String(req.query.q || '').trim().toLocaleLowerCase();
    const category = String(req.query.category || 'all');
    const titleLanguage = String(req.query.titleLanguage || req.query.language || 'all').toUpperCase();
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(req.query.limit, 10) || 50));
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const categoryNames = new Map(categories.map(item => [item.id, item.name]));
    const catalog = allItems.map(item => ({
      ...item,
      languageCode: titleLanguageCode(item),
      titleLanguage: titleLanguageCode(item),
    }));
    const languagePriority = { AR: 0, EN: 1 };
    const languages = [...new Set(catalog.map(item => item.languageCode))]
      .sort((a, b) => (languagePriority[a] ?? 10) - (languagePriority[b] ?? 10) || a.localeCompare(b));
    const filtered = catalog.filter(item =>
      (category === 'all' || item.categoryId === category)
      && (titleLanguage === 'ALL' || item.titleLanguage === titleLanguage)
      && (!query || item.title.toLocaleLowerCase().includes(query))
    );
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

async function resolveXtreamEnabledItems(source, enabledKeys) {
    const allowed = enabledKeys.map(String).filter(key => /^(channel|movie|series):[^:]+$/.test(key));
    const allowedSet = new Set(allowed);
    const kinds = [...new Set(allowed.map(key => key.split(':', 1)[0]))];
    const [catalogs, categoryGroups] = await Promise.all([
      Promise.all(kinds.map(kind => getXtreamCatalog(source, kind))),
      Promise.all(kinds.map(kind => getXtreamCategories(source, kind))),
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
      category: categoryNamesByKind.get(item.kind)?.get(item.categoryId) || source.name || 'Other',
      language: detectXtreamLanguage(item, categoryNamesByKind.get(item.kind)?.get(item.categoryId) || source.name || 'Other'),
      extension: item.extension,
      duration: item.duration,
      added: item.added,
    }));
}

function suppliedXtreamEnabledItems(source, enabledKeys, suppliedItems) {
  if (!Array.isArray(suppliedItems)) return [];
  const allowed = enabledKeys.map(String).filter(key => /^(channel|movie|series):[^:]+$/.test(key));
  const suppliedByKey = new Map(suppliedItems
    .filter(item => item && typeof item === 'object' && allowed.includes(String(item.key)))
    .map(item => [String(item.key), item]));
  return allowed.map(key => {
    const item = suppliedByKey.get(key);
    if (!item) return null;
    const [kind, id] = key.split(':', 2);
    const category = String(item.category || source.name || 'Other');
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
      || enabledItems.some(item => !item.category || !item.language);
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
    const enabledItems = suppliedXtreamEnabledItems(source, req.body.enabledKeys, req.body.enabledItems);
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
  try {
    const source = await getXtreamSource(req.params.sourceId);
    if (!source) return res.sendStatus(404);
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    if (req.params.kind === 'channel') return res.redirect(302, xtreamProviderUrl(source, req.params.kind, req.params.id, req.query.ext));
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    headers['user-agent'] = req.headers['user-agent'] || 'RH-Stream/1.0';
    const upstream = await fetch(xtreamProviderUrl(source, req.params.kind, req.params.id, req.query.ext), { headers });
    if (!upstream.ok && upstream.status !== 206) {
      const detail = await upstream.text().catch(() => '');
      return res.status(upstream.status || 502).json({ error: `Xtream media returned HTTP ${upstream.status}`, detail: detail.slice(0, 160) });
    }
    for (const name of ['cache-control', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified']) {
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
    Readable.fromWeb(upstream.body).on('error', error => {
      console.warn(`[Xtream] Media proxy interrupted: ${error.message}`);
      if (!res.headersSent) res.status(502).end(); else res.destroy(error);
    }).pipe(res);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

function rokuHlsKey(sourceId, kind, id, extension) {
  // Segment URLs in an HLS manifest do not retain the manifest query string,
  // so the identity cannot depend on `extension`.
  return createHash('sha256').update(`${sourceId}:${kind}:${id}`).digest('hex').slice(0, 24);
}

async function waitForHlsManifest(filename, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const stat = await fs.stat(filename);
      if (stat.size > 0) return true;
    } catch { /* ffmpeg has not produced the first segment yet */ }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  return false;
}

async function getOrStartRokuHls(source, kind, id, extension) {
  const key = rokuHlsKey(source._id, kind, id, extension);
  const existing = rokuHlsJobs.get(key);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  // Xtream accounts commonly allow only one live connection. Stop the prior
  // channel immediately when another channel is opened; otherwise the
  // provider responds with a tiny valid-but-completely-black placeholder.
  if (kind === 'channel') {
    for (const [otherKey, otherJob] of rokuHlsJobs) {
      if (otherKey === key || otherJob.kind !== 'channel' || otherJob.sourceId !== String(source._id)) continue;
      if (otherJob.child && !otherJob.child.killed) otherJob.child.kill('SIGKILL');
      rokuHlsJobs.delete(otherKey);
      fs.rm(otherJob.directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  const directory = path.join(rokuHlsRoot, key);
  await fs.mkdir(directory, { recursive: true });
  const manifest = path.join(directory, 'master.m3u8');
  const inputUrl = xtreamProviderUrl(source, kind, id, extension);
  const args = [
    // Keep every generated segment, but advertise the playlist as EVENT while
    // ffmpeg is still appending to it. Marking a growing playlist as VOD made
    // Roku treat the first short manifest as immutable: playback consumed
    // those initial segments, stalled near 13%, and never requested the
    // expanded manifest. ffmpeg adds ENDLIST when a finite source completes.
    '-hide_banner', '-loglevel', 'error', '-i', inputUrl,
    '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-sn', '-dn',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(directory, 'segment-%06d.ts'), manifest,
  ];
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const job = { key, sourceId: String(source._id), kind, directory, manifest, child, lastAccess: Date.now(), error: '' };
  rokuHlsJobs.set(key, job);
  child.stderr.on('data', chunk => { job.error += chunk.toString(); });
  child.on('error', error => { job.error += error.message; });
  child.on('close', code => {
    job.finished = true;
    if (code !== 0 && code !== null) console.warn(`[Xtream Roku HLS] ${kind}:${id} exited ${code}: ${job.error.trim().slice(-240)}`);
  });
  return job;
}

// Keep only actively watched HLS pipelines. Render's disk is ephemeral and
// this avoids retaining a whole film after playback stops.
setInterval(() => {
  const expiry = Date.now() - 45_000;
  for (const [key, job] of rokuHlsJobs) {
    if (job.lastAccess >= expiry) continue;
    if (job.child && !job.child.killed) job.child.kill('SIGKILL');
    rokuHlsJobs.delete(key);
    fs.rm(job.directory, { recursive: true, force: true }).catch(() => {});
  }
}, 5_000).unref();

app.get('/api/xtream/hls/:sourceId/:kind/:id/master.m3u8', async (req, res) => {
  try {
    // Channels use the same backend HLS pipeline as VOD. Redirecting Roku to
    // the provider's live manifest exposed malformed headers and provider
    // segment URLs directly to the TV.
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    const source = await getXtreamSource(req.params.sourceId);
    if (!source) return res.sendStatus(404);
    const job = await getOrStartRokuHls(source, req.params.kind, req.params.id, req.query.ext);
    if (!await waitForHlsManifest(job.manifest)) {
      return res.status(504).json({ error: job.error.trim().slice(-240) || 'HLS manifest is still being prepared' });
    }
    job.lastAccess = Date.now();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    // Roku uses the device token on the manifest request, but relative HLS
    // segment URLs do not inherit that query string. Carry the token onto
    // each segment URL so the authenticated /api/xtream middleware accepts
    // the subsequent video requests instead of returning a JSON 401 body.
    let manifestText = await fs.readFile(job.manifest, 'utf8');
    const deviceToken = String(req.query.deviceToken || '').trim();
    if (deviceToken) {
      const tokenQuery = `deviceToken=${encodeURIComponent(deviceToken)}`;
      manifestText = manifestText.split('\n').map(line => (
        /^segment-\d{6}\.ts$/.test(line.trim()) ? `${line}?${tokenQuery}` : line
      )).join('\n');
    }
    res.send(manifestText);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/xtream/hls/:sourceId/:kind/:id/:segment', async (req, res) => {
  try {
    if (!/^segment-\d{6}\.ts$/.test(req.params.segment)) return res.sendStatus(404);
    const key = rokuHlsKey(req.params.sourceId, req.params.kind, req.params.id, req.query.ext);
    const job = rokuHlsJobs.get(key);
    if (!job) return res.sendStatus(404);
    job.lastAccess = Date.now();
    const filename = path.join(job.directory, req.params.segment);
    await fs.access(filename);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filename);
  } catch { res.sendStatus(404); }
});

app.get('/api/xtream/roku/:sourceId/:kind/:id', async (req, res) => {
  let child;
  try {
    const source = await getXtreamSource(req.params.sourceId);
    if (!source) return res.sendStatus(404);
    if (!['movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);

    // Several Xtream providers send MPEG-TS even for URLs ending in .mp4.
    // Roku reports that mismatch as "malformed data (-5)". Fragmented MP4
    // keeps the original H.264/AAC tracks while giving Roku a valid MP4
    // streaming container without downloading the whole file first.
    const inputUrl = xtreamProviderUrl(source, req.params.kind, req.params.id, req.query.ext);
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
    child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk.toString(); });
    child.on('error', error => {
      console.error('[Xtream Roku remux] failed to start:', error.message);
      if (!res.headersSent) res.status(502).json({ error: 'Could not start Roku media remux' });
      else res.destroy(error);
    });
    child.on('close', code => {
      if (code !== 0 && code !== null) console.warn(`[Xtream Roku remux] ${req.params.kind}:${req.params.id} exited ${code}: ${errorText.trim().slice(-240)}`);
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => { if (child && !child.killed) child.kill('SIGKILL'); });

    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'none');
    child.stdout.pipe(res);
  } catch (error) {
    if (child && !child.killed) child.kill('SIGKILL');
    if (!res.headersSent) res.status(502).json({ error: error.message });
    else res.destroy(error);
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
          const useDirectMp4 = extension === 'mp4';
          const playbackUrl = useDirectMp4
            ? xtreamPlaybackPath(source._id, 'series', episode.id, extension)
            : rokuXtreamPlaybackPath(source._id, 'series', episode.id, extension);
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
            url: playbackUrl, playbackUrl, streamFormat: useDirectMp4 ? 'mp4' : 'hls',
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
app.listen(port, '0.0.0.0', () => {
  console.log(`RH Stream API listening on http://0.0.0.0:${port}`);
});
