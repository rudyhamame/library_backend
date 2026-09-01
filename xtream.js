const cache = new Map();
const cacheTtl = 5 * 60 * 1000;
const cacheMaxEntries = 6;
const inFlight = new Map();
const maxInFlight = Math.max(4, Number.parseInt(process.env.XTREAM_MAX_IN_FLIGHT || '12', 10) || 12);
const upstreamAttempts = Math.max(1, Math.min(3, Number.parseInt(process.env.XTREAM_REQUEST_ATTEMPTS || '3', 10) || 3));
const upstreamTimeoutMs = Math.max(5_000, Math.min(30_000, Number.parseInt(process.env.XTREAM_REQUEST_TIMEOUT_MS || '18000', 10) || 18_000));
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

async function fetchXtream(url) {
  let lastError;
  for (let attempt = 1; attempt <= upstreamAttempts; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(upstreamTimeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt < upstreamAttempts) await wait(attempt * 350);
    }
  }
  const cause = String(lastError?.cause?.code || lastError?.cause?.message || lastError?.message || 'network error');
  throw new Error(`Playlist provider could not be reached (${cause}). Check its server link and try again.`);
}

async function request(source, params, transform = value => value) {
  const key = `${source._id}:${JSON.stringify(params)}`;
  const now = Date.now();
  evictXtreamCache(now);
  // A series-info response may carry hundreds of episodes and images. Keeping
  // every expanded series in the five-minute cache is what grows the Render
  // heap until Node is terminated. Catalog lists and details are intentionally
  // not retained here so the backend does not store the provider catalog.
  const cacheable = !['get_series_info', 'get_vod_info', 'get_series', 'get_vod_streams', 'get_live_streams', 'get_series_categories', 'get_vod_categories', 'get_live_categories'].includes(params?.action);
  const cached = cache.get(key);
  if (cacheable && cached?.expires > now) return cached.data;
  if (inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= maxInFlight) throw new Error('Xtream provider request capacity is full');
  const pending = (async () => {
    const response = await fetchXtream(apiUrl(source, params));
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

export async function validateXtreamConnection(source) {
  const data = await request(source, {});
  if (!data?.user_info) throw new Error('This URL did not return a valid Xtream account');
  if (String(data.user_info.auth) !== '1') throw new Error('Xtream authentication failed');
  return data.user_info;
}

export async function getXtreamCatalog(source, kind, categoryId = 'all') {
  const action = kind === 'channel' ? 'get_live_streams' : kind === 'movie' ? 'get_vod_streams' : 'get_series';
  const params = { action };
  if (categoryId && categoryId !== 'all') params.category_id = categoryId;
  return request(source, params, rows => (Array.isArray(rows) ? rows : []).map(row => {
    const id = stringId(kind === 'series' ? row.series_id : row.stream_id);
    return {
      key: `${kind}:${id}`,
      id,
      kind,
      title: String(row.name || `${kind} ${id}`),
      categoryId: stringId(row.category_id),
      logo: String(row.stream_icon || row.cover || ''),
      extension: String(row.container_extension || (kind === 'channel' ? 'm3u8' : 'mp4')),
      duration: String(row.duration || row.duration_secs || ''),
      rating: String(row.rating || ''),
      added: String(row.added || row.last_modified || ''),
    };
  }));
}

export async function getXtreamMovieInfo(source, movieId) {
  const data = await request(source, { action: 'get_vod_info', vod_id: movieId });
  let duration = String(data?.info?.duration || data?.movie_data?.duration || '');
  const durationParts = duration.trim().split(':').map(Number);
  const parsedDuration = durationParts.length === 3
    ? durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]
    : durationParts.length === 2
      ? durationParts[0] * 60 + durationParts[1]
      : Number(duration) || 0;
  const seconds = Number(data?.info?.duration_secs || data?.movie_data?.duration_secs || 0) || parsedDuration;
  if (!duration && seconds > 0) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = Math.floor(seconds % 60);
    duration = [hours, minutes, remaining].map(value => String(value).padStart(2, '0')).join(':');
  }
  return { duration, seconds };
}

export async function getXtreamCategories(source, kind) {
  const action = kind === 'channel' ? 'get_live_categories' : kind === 'movie' ? 'get_vod_categories' : 'get_series_categories';
  return request(source, { action }, rows => (Array.isArray(rows) ? rows : []).map(row => ({ id: stringId(row.category_id), name: String(row.category_name || 'Other') })));
}

export async function getXtreamSeriesEpisodes(source, seriesId) {
  const data = await request(source, { action: 'get_series_info', series_id: seriesId });
  const seasons = new Map((Array.isArray(data?.seasons) ? data.seasons : []).map(season => [String(season.season_number), season]));
  const episodes = [];
  for (const [seasonNumber, rows] of Object.entries(data?.episodes || {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      episodes.push({
        id: stringId(row.id),
        title: String(row.title || `Episode ${row.episode_num || episodes.length + 1}`),
        episodeNumber: Number(row.episode_num) || episodes.length + 1,
        seasonNumber: Number(seasonNumber) || 1,
        seasonTitle: String(seasons.get(String(seasonNumber))?.name || `Season ${seasonNumber}`),
        extension: String(row.container_extension || 'mp4'),
        duration: String(row.info?.duration || row.info?.duration_secs || ''),
        thumbnail: String(row.info?.movie_image || data?.info?.cover || ''),
      });
    }
  }
  return { title: String(data?.info?.name || `Series ${seriesId}`), episodes };
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
