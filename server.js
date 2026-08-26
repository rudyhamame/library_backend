import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { shapeArabicForRoku } from './arabic-shaper.js';
import { createXtreamSource, deleteXtreamSource, getAllXtreamSources, getXtreamSource, getXtreamSources, publicXtreamSource, updateXtreamSelection, updateXtreamSource } from './xtream-store.js';
import { getXtreamCatalog, getXtreamCategories, getXtreamSeriesEpisodes, validateXtreamConnection, xtreamPlaybackPath, xtreamProviderUrl } from './xtream.js';
import { getPlayback, getPlaybackHistory, savePlayback } from './playback-store.js';
import { getFavorites, toggleFavorite } from './favorites-store.js';

const app = express();
const port = process.env.PORT || 8787;
let dashboardCache = { expires: 0, data: null };
const previewCache = new Map();
const arabicText = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const rokuText = (value) => arabicText.test(String(value || '')) ? shapeArabicForRoku(value) : String(value || '');
// Roku cannot reliably receive a JSON document containing a provider's entire
// catalog (this source alone has 44,995 series). Keep the initial screen fast;
// additional catalog pages are loaded separately by the Roku client.
const rokuInitialMovieLimit = Math.max(20, Number.parseInt(process.env.ROKU_INITIAL_MOVIE_LIMIT || '100', 10));
const rokuInitialChannelLimit = Math.max(20, Number.parseInt(process.env.ROKU_INITIAL_CHANNEL_LIMIT || '150', 10));
const rokuInitialSeriesLimit = Math.max(1, Number.parseInt(process.env.ROKU_INITIAL_SERIES_LIMIT || '12', 10));

function detectXtreamLanguage(item, category) {
  const text = `${category || ''} ${item.title || ''}`;
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

async function getAllXtreamItems(kind) {
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
}

function directXtreamItem(item) {
  const playbackUrl = xtreamPlaybackPath(item.sourceId, item.kind, item.id, item.extension);
  return {
    ...item,
    source: 'xtream',
    favoriteId: `xtream:${item.sourceId}:${item.kind}:${item.id}`,
    url: playbackUrl,
    playbackUrl,
    rokuTitle: rokuText(item.title),
    rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
    streamFormat: item.kind === 'channel' ? 'hls' : (item.extension === 'mp4' ? 'mp4' : 'hls'),
  };
}
app.use(cors());
app.use(express.json());

app.get('/api/health', async (_, res) => {
  try {
    const xtreamSources = await getXtreamSources();
    res.json({ ok: true, source: 'xtream', storage: { type: 'mongodb', xtreamSources: xtreamSources.length } });
  } catch (error) {
    res.status(503).json({ ok: false, source: 'catalog', storage: { type: 'mongodb', error: error.message } });
  }
});

// Roku must not try to build the full Xtream catalog during application
// startup. A complete series catalog requires one provider request per
// series, which can outlive Roku's HTTP request window. The Roku client uses
// this endpoint only to verify that Render is reachable; each catalog page is
// fetched separately when the user opens it.
app.get('/api/roku/bootstrap', (_, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ items: [] });
});

async function buildXtreamMoviesPayload({ limit } = {}) {
  let movies = (await getAllXtreamItems('movie')).sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
  if (Number.isFinite(limit) && limit > 0) movies = movies.slice(0, limit);
  // The stream catalog already carries duration for most providers. Avoid one
  // extra provider request per movie now that Roku receives the full catalog.
  return movies.map(item => ({ ...directXtreamItem(item), duration: item.duration || '', kind: 'movie', contentKind: 'movie', rokuEnabled: true }));
}

function buildXtreamChannelsPayload(items) {
  return items.map(item => ({
    ...directXtreamItem(item),
    kind: 'channel', contentKind: 'channel',
    group: item.category || item.sourceName,
    rokuGroup: item.rokuCategory || rokuText(item.sourceName),
  }));
}

app.get('/api/roku/movies', async (_, res) => {
  try { res.json({ items: await buildXtreamMoviesPayload({ limit: rokuInitialMovieLimit }) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/playback/history', async (_, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ items: await getPlaybackHistory() });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

function parseXtreamPlaybackItem(itemId) {
  const parsed = new URL(String(itemId || ''), 'http://rh-stream.internal');
  const match = parsed.pathname.match(/^\/api\/xtream\/play\/([^/]+)\/(movie|series)\/([^/]+)$/);
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
app.put('/api/favorites/toggle', async (req, res) => {
  try {
    const id = String(req.query?.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    res.json(await toggleFavorite({ id, title: req.query?.title || req.body?.title, kind: req.query?.kind || req.body?.kind }));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
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
    if (dashboardCache.expires > Date.now()) return res.json(dashboardCache.data);
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
    res.json(dashboardCache.data);
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

app.get('/api/xtream/sources', async (_, res) => {
  try { res.json({ items: await getXtreamSources() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/xtream/sources', async (req, res) => {
  try {
    const source = parseXtreamInput(req.body);
    await validateXtreamConnection({ ...source, _id: 'validation' });
    res.status(201).json(await createXtreamSource(source));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id', async (req, res) => {
  try {
    const existing = await getXtreamSource(req.params.id);
    if (!existing) return res.sendStatus(404);
    const changes = parseXtreamInput(req.body, existing);
    if (changes.baseUrl) await validateXtreamConnection({ ...existing, ...changes });
    res.json(await updateXtreamSource(req.params.id, changes));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/xtream/sources/:id', async (req, res) => {
  try {
    if (!await deleteXtreamSource(req.params.id)) return res.sendStatus(404);
    res.sendStatus(204);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/catalog', async (req, res) => {
  try {
    const source = await getXtreamSource(String(req.query.sourceId || ''));
    if (!source) return res.status(404).json({ error: 'Xtream source not found' });
    const aliases = { live: 'channel', channel: 'channel', movie: 'movie', vod: 'movie', series: 'series' };
    const kind = aliases[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be channel, movie, or series' });
    const [allItems, categories] = await Promise.all([getXtreamCatalog(source, kind), getXtreamCategories(source, kind)]);
    const enabled = new Set(source.enabledKeys || []);
    const query = String(req.query.q || '').trim().toLocaleLowerCase();
    const category = String(req.query.category || 'all');
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(req.query.limit, 10) || 50));
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const filtered = allItems.filter(item =>
      (category === 'all' || item.categoryId === category)
      && (!query || item.title.toLocaleLowerCase().includes(query))
    );
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const start = (page - 1) * pageSize;
    res.json({
      source: publicXtreamSource(source), categories,
      items: filtered.slice(start, start + pageSize).map(item => ({ ...item, enabled: enabled.has(item.key) })),
      pagination: { page, pageSize, pageCount, total: filtered.length },
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

async function resolveXtreamEnabledItems(source, enabledKeys) {
    const allowed = enabledKeys.map(String).filter(key => /^(channel|movie|series):[^:]+$/.test(key));
    const allowedSet = new Set(allowed);
    const kinds = [...new Set(allowed.map(key => key.split(':', 1)[0]))];
    const catalogs = await Promise.all(kinds.map(kind => getXtreamCatalog(source, kind)));
    const resolved = catalogs.flat().filter(item => allowedSet.has(item.key));
    const byKey = new Map(resolved.map(item => [item.key, item]));
    return allowed.map(key => byKey.get(key)).filter(Boolean).map(item => ({
      key: item.key,
      id: item.id,
      kind: item.kind,
      title: item.title,
      logo: item.logo,
      categoryId: item.categoryId,
      extension: item.extension,
    }));
}

app.get('/api/xtream/sources/:id/enabled', async (req, res) => {
  try {
    const source = await getXtreamSource(req.params.id);
    if (!source) return res.sendStatus(404);
    const enabledKeys = Array.isArray(source.enabledKeys) ? source.enabledKeys : [];
    let enabledItems = Array.isArray(source.enabledItems) ? source.enabledItems : [];
    const itemKeys = new Set(enabledItems.map(item => item.key));
    const needsBackfill = enabledItems.length !== enabledKeys.length || enabledKeys.some(key => !itemKeys.has(key));
    if (needsBackfill && enabledKeys.length) {
      enabledItems = await resolveXtreamEnabledItems(source, enabledKeys);
      const updated = await updateXtreamSelection(source._id, enabledItems.map(item => item.key), enabledItems);
      return res.json({ source: updated, items: updated.enabledItems });
    }
    res.json({ source: publicXtreamSource(source), items: enabledItems });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id/selection', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.enabledKeys)) return res.status(400).json({ error: 'enabledKeys must be an array' });
    const source = await getXtreamSource(req.params.id);
    if (!source) return res.sendStatus(404);
    const enabledItems = await resolveXtreamEnabledItems(source, req.body.enabledKeys);
    const updated = await updateXtreamSelection(req.params.id, enabledItems.map(item => item.key), enabledItems);
    if (!updated) return res.sendStatus(404);
    res.json(updated);
  } catch (error) { res.status(400).json({ error: error.message }); }
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
async function buildXtreamSeriesPayload({ limit } = {}) {
  let selected = (await getAllXtreamItems('series')).sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
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
          const playbackUrl = xtreamPlaybackPath(source._id, 'series', episode.id, episode.extension);
          const title = episode.title || `${details.title} · ${episode.episodeNumber}`;
          items.push({
            id: `xtream:${source._id}:series:${episode.id}`,
            source: 'xtream', kind: 'episode', contentKind: 'episode',
            title, rokuTitle: rokuText(title), rokuTextKind: /[A-Za-z]/.test(title) ? 'latin' : 'arabic',
            seriesTitle: details.title, rokuSeriesTitle: rokuText(details.title),
            seasonTitle: episode.seasonTitle, rokuSeasonTitle: rokuText(episode.seasonTitle),
            seasonSort: episode.seasonNumber, episodeNumber: episode.episodeNumber,
            duration: episode.duration, thumbnail: episode.thumbnail,
            added: seriesItem.added,
            url: playbackUrl, playbackUrl, streamFormat: episode.extension === 'mp4' ? 'mp4' : 'hls',
          });
        }
      } catch (error) {
        console.warn(`[Xtream] Could not expand series ${seriesItem.title}: ${error.message}`);
      }
      groups[index] = items;
    }
  }
  const concurrency = Math.min(6, Math.max(1, selected.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return groups.flat();
}
app.get('/api/roku/library', async (_, res) => {
  try {
    // Compatibility for Roku packages installed before the bootstrap/page
    // split. Never expand the complete Xtream library here: a provider may
    // have tens of thousands of series and the Render instance has 256 MB.
    // Returning the same bounded initial catalog keeps an older package
    // usable instead of crashing the API process.
    const [series, movies, channels] = await Promise.all([
      buildXtreamSeriesPayload({ limit: rokuInitialSeriesLimit }),
      buildXtreamMoviesPayload({ limit: rokuInitialMovieLimit }),
      getAllXtreamItems('channel').then(items => buildXtreamChannelsPayload(items.slice(0, rokuInitialChannelLimit))),
    ]);
    res.json({ items: [...series, ...movies, ...channels] });
  }
  catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/roku/series', async (_, res) => {
  try {
    const items = await buildXtreamSeriesPayload({ limit: rokuInitialSeriesLimit });
    console.log(`[Roku] Series catalog ready: ${items.length} Xtream episodes`);
    res.json({ items });
  } catch (error) {
    console.error('[Roku] Series catalog failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});
app.get('/api/roku/channels', async (_, res) => {
  try {
    const items = buildXtreamChannelsPayload((await getAllXtreamItems('channel')).slice(0, rokuInitialChannelLimit));
    res.json({ items });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.listen(port, '0.0.0.0', () => {
  console.log(`RH Stream API listening on http://0.0.0.0:${port}`);
});
