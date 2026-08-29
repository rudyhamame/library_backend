import { createHash } from 'node:crypto';

const cache = new Map();
const cacheTtl = 5 * 60 * 1000;
const cacheMaxEntries = Math.max(1, Number.parseInt(process.env.M3U_CACHE_MAX_ENTRIES || '2', 10) || 2);
const maxPlaylistBytes = Math.max(1024 * 1024, (Number.parseInt(process.env.M3U_MAX_MB || '8', 10) || 8) * 1024 * 1024);
const inFlight = new Map();
const maxInFlight = Math.max(1, Number.parseInt(process.env.M3U_MAX_IN_FLIGHT || '2', 10) || 2);

export function evictM3uCache(now = Date.now(), aggressive = false) {
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  if (aggressive) while (cache.size > 1) cache.delete(cache.keys().next().value);
  while (cache.size > cacheMaxEntries) cache.delete(cache.keys().next().value);
}

export function m3uCacheStats() { return { entries: cache.size, maxEntries: cacheMaxEntries, inFlight: inFlight.size, maxInFlight }; }

function attribute(line, name) {
  return line.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1]?.trim() || '';
}

function itemId(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 20);
}

function extension(url) {
  try { return new URL(url).pathname.split('.').pop()?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'm3u8'; }
  catch { return 'm3u8'; }
}

async function downloadM3u(source, key) {
  const response = await fetch(source.baseUrl, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`M3U server returned HTTP ${response.status}`);
  const items = [];
  let metadata = null;
  const consumeLine = rawLine => {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (line.startsWith('#EXTINF:')) {
      metadata = {
        title: line.slice(line.indexOf(',') + 1).trim() || 'Untitled channel',
        logo: attribute(line, 'tvg-logo'),
        category: attribute(line, 'group-title') || 'Other',
      };
      return;
    }
    if (!metadata || !line || line.startsWith('#')) return;
    let streamUrl;
    try { streamUrl = new URL(line, source.baseUrl).toString(); }
    catch { metadata = null; return; }
    const id = itemId(streamUrl);
    items.push({
      key: `channel:${id}`, id, kind: 'channel', title: metadata.title,
      categoryId: metadata.category, category: metadata.category,
      logo: metadata.logo, extension: extension(streamUrl), streamUrl,
      duration: '', rating: '', added: '',
    });
    metadata = null;
  };
  const reader = response.body?.getReader();
  if (!reader) throw new Error('M3U server returned an empty response');
  const decoder = new TextDecoder();
  let pending = '';
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxPlaylistBytes) { await reader.cancel(); throw new Error('M3U playlist is too large'); }
    pending += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      consumeLine(pending.slice(0, newline).replace(/\r$/, ''));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 64 * 1024) { await reader.cancel(); throw new Error('M3U playlist contains an invalid oversized line'); }
  }
  pending += decoder.decode();
  if (pending) consumeLine(pending);
  if (!items.length) throw new Error('This URL did not return a valid M3U playlist');
  cache.set(key, { items, expires: Date.now() + cacheTtl });
  evictM3uCache();
  return items;
}

async function loadM3u(source) {
  evictM3uCache();
  const key = `${source._id || 'validation'}:${source.baseUrl}`;
  const cached = cache.get(key);
  if (cached?.expires > Date.now()) return cached.items;
  if (inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= maxInFlight) throw new Error('M3U provider request capacity is full');
  const pending = downloadM3u(source, key);
  inFlight.set(key, pending);
  try { return await pending; }
  finally { inFlight.delete(key); }
}

export async function validateM3uConnection(source) {
  await loadM3u(source);
}

export async function getM3uCatalog(source, kind) {
  return kind === 'channel' ? loadM3u(source) : [];
}

export async function getM3uCategories(source, kind) {
  if (kind !== 'channel') return [];
  const items = await loadM3u(source);
  return [...new Set(items.map(item => item.category))].sort().map(name => ({ id: name, name }));
}

export async function m3uProviderUrl(source, kind, id) {
  if (kind !== 'channel') throw new Error('M3U sources currently contain live channels only');
  const item = (await loadM3u(source)).find(candidate => candidate.id === String(id));
  if (!item) throw new Error('M3U channel was not found');
  return item.streamUrl;
}
