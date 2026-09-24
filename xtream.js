import http from 'node:http';
import https from 'node:https';
import { requireCatalogRows } from './catalog-freshness.js';
const cache = new Map();
const cacheTtl = 5 * 60 * 1000;
const cacheMaxEntries = 6;
const inFlight = new Map();
const maxInFlight = Math.max(4, Number.parseInt(process.env.XTREAM_MAX_IN_FLIGHT || '12', 10) || 12);
const upstreamAttempts = Math.max(1, Math.min(3, Number.parseInt(process.env.XTREAM_REQUEST_ATTEMPTS || '3', 10) || 3));
const upstreamTimeoutMs = Math.max(5_000, Math.min(30_000, Number.parseInt(process.env.XTREAM_REQUEST_TIMEOUT_MS || '18000', 10) || 18_000));
// Bulk catalog lists (get_vod_streams/get_series/get_live_streams) scale with
// provider size, not user wait tolerance — some providers return well past
// 50MB/200k rows, which can take over a minute to download. These need a much
// longer allowance than the interactive default above, which stays tight so a
// truly dead provider fails fast on connection checks and single-item lookups.
const catalogTimeoutMs = Math.max(upstreamTimeoutMs, Math.min(120_000, Number.parseInt(process.env.XTREAM_CATALOG_TIMEOUT_MS || '120000', 10) || 120_000));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function evictXtreamCache(now = Date.now(), aggressive = false) {
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  if (aggressive) while (cache.size > 2) cache.delete(cache.keys().next().value);
  while (cache.size > cacheMaxEntries) cache.delete(cache.keys().next().value);
}

export function xtreamCacheStats() { return { entries: cache.size, maxEntries: cacheMaxEntries, inFlight: inFlight.size, maxInFlight }; }

function apiUrl(source, params = {}) {
  const url = new URL(`${source.baseUrl.replace(/\/$/, '')}/player_api.php`);
  url.searchParams.set('username', source.username);
  url.searchParams.set('password', source.password);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function requestXtreamHttp(url, timeoutMs) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: { 'accept-encoding': 'identity', connection: 'close' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode || 0,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('provider request timed out')));
    request.on('error', reject);
  });
}

async function fetchXtream(url, { attempts = upstreamAttempts, timeoutMs = upstreamTimeoutMs } = {}) {
  // Unit tests replace global fetch with a deterministic provider fixture.
  // Keep that seam while production requests use the native HTTP client,
  // which avoids an undici parser crash with this provider's responses.
  if (url.hostname === 'provider.test') return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  let lastError;
  const boundedAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
  const boundedTimeoutMs = Math.max(2_000, Math.min(120_000, Number(timeoutMs) || upstreamTimeoutMs));
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      return await requestXtreamHttp(url, boundedTimeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < boundedAttempts) await wait(attempt * 350);
    }
  }
  const cause = String(lastError?.cause?.code || lastError?.cause?.message || lastError?.message || 'network error');
  throw new Error(`Playlist provider could not be reached (${cause}). Check its server link and try again.`);
}

async function request(source, params, transform = value => value, options = {}) {
  const key = `${source._id}:${JSON.stringify(params)}`;
  const now = Date.now();
  evictXtreamCache(now);
  // Keep expanded series details in the short-lived in-memory cache. The
  // Series page needs the provider rating and episode/season totals, but
  // focus changes must never issue a new get_series_info request each time.
  // Catalog lists remain uncached here and are still handled by their normal
  // catalog-loading path.
  const cacheable = !['get_vod_info', 'get_series', 'get_vod_streams', 'get_live_streams', 'get_series_categories', 'get_vod_categories', 'get_live_categories'].includes(params?.action);
  const cached = cache.get(key);
  if (cacheable && cached?.expires > now) return cached.data;
  if (inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= maxInFlight) throw new Error('Xtream provider request capacity is full');
  const pending = (async () => {
    const response = await fetchXtream(apiUrl(source, params), options);
    if (!response.ok) throw new Error(`Xtream server returned HTTP ${response.status}`);
    const data = transform(await response.json());
    if (cacheable) {
      cache.delete(key);
      cache.set(key, { data, expires: Date.now() + cacheTtl });
      evictXtreamCache();
    }
    return data;
  })();
  inFlight.set(key, pending);
  try { return await pending; }
  finally { inFlight.delete(key); }
}

const stringId = value => String(value ?? '');

function positiveDurationValue(...values) {
  for (const value of values) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    if (/^\d+(?::\d{1,2}){1,2}$/.test(raw)) {
      const parts = raw.split(':').map(Number);
      const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      if (seconds > 0) return raw;
    } else if (Number(raw) > 0) return raw;
  }
  return '';
}

export async function validateXtreamConnection(source, options = {}) {
  const data = await request(source, {}, value => value, options);
  if (!data?.user_info) throw new Error('This URL did not return a valid Xtream account');
  if (String(data.user_info.auth) !== '1') throw new Error('Xtream authentication failed');
  return data.user_info;
}

export async function getXtreamCatalog(source, kind, categoryId = 'all') {
  const action = kind === 'channel' ? 'get_live_streams' : kind === 'movie' ? 'get_vod_streams' : 'get_series';
  const params = { action };
  if (categoryId && categoryId !== 'all') params.category_id = categoryId;
  return request(source, params, rows => requireCatalogRows(rows).map(row => {
    const id = stringId(kind === 'series' ? row.series_id : row.stream_id);
    return {
      key: `${kind}:${id}`,
      id,
      kind,
      // Keep the complete provider row in the server-side catalog snapshot.
      // The normalized fields below are for filtering/playback; metadata is
      // retained so future clients do not need another provider request just
      // to use a field Xtream returned that we do not currently know about.
      metadata: row,
      title: String(row.name || `${kind} ${id}`),
      categoryId: stringId(row.category_id),
      category: String(row.category_name || ''),
      logo: String(row.stream_icon || row.cover || ''),
      extension: String(row.container_extension || (kind === 'channel' ? 'm3u8' : 'mp4')),
      duration: String(row.duration || row.duration_secs || ''),
      rating: String(row.rating || ''),
      added: String(row.added || row.last_modified || ''),
    };
  }), { timeoutMs: catalogTimeoutMs });
}

export async function getXtreamMovieInfo(source, movieId) {
  const data = await request(source, { action: 'get_vod_info', vod_id: movieId });
  let duration = String(data?.info?.duration || data?.movie_data?.duration || '');
  const durationParts = duration.trim().split(':').map(Number);
  let parsedDuration = durationParts.length === 3
    ? durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]
    : durationParts.length === 2
      ? durationParts[0] * 60 + durationParts[1]
      : Number(duration) || 0;
  if (durationParts.length === 1 && parsedDuration > 0 && parsedDuration < 240) parsedDuration *= 60;
  // The HH:MM:SS `duration` string is the reliable field. Some panels mislabel
  // `duration_secs` - it actually holds the runtime in MINUTES (e.g. "122" for
  // a 2h movie). Always trust a valid duration value over duration_secs;
  // even a small disagreement can cut the visible end off a movie. With no duration, a tiny
  // duration_secs (<4 min) is treated as minutes.
  const rawSecs = Number(data?.info?.duration_secs || data?.movie_data?.duration_secs || 0) || 0;
  let seconds;
  if (parsedDuration > 0) {
    seconds = parsedDuration;
  } else {
    seconds = rawSecs > 0 && rawSecs < 240 ? rawSecs * 60 : rawSecs;
  }
  if (!duration && seconds > 0) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = Math.floor(seconds % 60);
    duration = [hours, minutes, remaining].map(value => String(value).padStart(2, '0')).join(':');
  }
  return { duration, seconds };
}

// Adult/18+ category names are dropped so they never appear as a browsable
// folder - Play Store policy: this is a general streaming app, not one whose
// purpose is adult material.
const ADULT_CATEGORY_RE = /adult|\bxxx\b|(?:^|\D)18\s*\+|\+\s*18|\bporn|erotic|\bsex\b|hentai|onlyfans|للكبار|للبالغين|إباح/i;

export async function getXtreamCategories(source, kind) {
  const action = kind === 'channel' ? 'get_live_categories' : kind === 'movie' ? 'get_vod_categories' : 'get_series_categories';
  return request(source, { action }, rows => (Array.isArray(rows) ? rows : [])
    .map(row => ({ id: stringId(row.category_id), name: String(row.category_name || 'Other') }))
    .filter(category => !ADULT_CATEGORY_RE.test(category.name)));
}

export async function getXtreamSeriesEpisodes(source, seriesId) {
  const data = await request(source, { action: 'get_series_info', series_id: seriesId });
  const seasons = new Map((Array.isArray(data?.seasons) ? data.seasons : []).map(season => [String(season.season_number), season]));
  const episodes = [];
  for (const [seasonNumber, rows] of Object.entries(data?.episodes || {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      episodes.push({
        id: stringId(row.id ?? row.episode_id ?? row.stream_id),
        title: String(row.title || `Episode ${row.episode_num || episodes.length + 1}`),
        episodeNumber: Number(row.episode_num) || episodes.length + 1,
        seasonNumber: Number(seasonNumber) || 1,
        seasonTitle: String(seasons.get(String(seasonNumber))?.name || `Season ${seasonNumber}`),
        extension: String(row.container_extension || 'mp4'),
        duration: positiveDurationValue(row.info?.duration, row.info?.duration_secs, row.duration, row.duration_secs),
        thumbnail: String(row.info?.movie_image || data?.info?.cover || ''),
      });
    }
  }
  return {
    title: String(data?.info?.name || `Series ${seriesId}`),
    rating: String(data?.info?.rating || ''),
    episodes,
  };
}

export function xtreamPlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `/api/xtream/play/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

export function xtreamProviderUrl(source, kind, id, extension = '') {
  const base = source.baseUrl.replace(/\/$/, '');
  if (kind === 'channel') return `${base}/live/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${encodeURIComponent(id)}.m3u8`;
  const folder = kind === 'series' ? 'series' : 'movie';
  const ext = String(extension || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
  return `${base}/${folder}/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${encodeURIComponent(id)}.${ext}`;
}
