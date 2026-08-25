import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import os from 'node:os';
import { access, readFile } from 'node:fs/promises';
import { root as hlsRoot, ensureHls, hlsReady, hlsRunning, registerHls, startHls } from './hls.js';
import { getPlaylist, getPlaylistStoreStatus, getPlaylistStructure, savePlaylist } from './playlist-store.js';
import { getRokuJob, startRokuPrepare } from './roku-cache.js';
import { shapeArabicForRoku } from './arabic-shaper.js';
import { dlnaBrowse, dlnaDescription, dlnaRoot, getDlnaCacheJob, startDlnaCache, startSsdp } from './dlna.js';
import { beginTelegramAuth, getAllTelegramCatalog, getTelegramCatalog, getTelegramThumbnail, getTelegramVideoStream, resolveTelegramChannel, submitTelegramCode, submitTelegramPassword, telegramStatus } from './telegram.js';
import { createIptvSource, deleteIptvSource, getIptvSource, getIptvSources, updateIptvSource } from './iptv-store.js';
import { getPlayback, getPlaybackHistory, savePlayback } from './playback-store.js';
import { findLocalMovie, getLocalMoviesRoot, listLocalMovies, localMoviePath, localMovieSubtitlePath, setLocalMovieEnabled, setLocalMovieSubtitle, setLocalMovieTitle, setLocalMoviesRoot, uploadLocalMovieSubtitle } from './local-media.js';

const app = express();
const port = process.env.PORT || 8787;
const iptvCache = new Map();
let dashboardCache = { expires: 0, data: null };
const arabicText = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const rokuText = (value) => arabicText.test(String(value || '')) ? shapeArabicForRoku(value) : String(value || '');

function parseIptvM3u(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let info = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      const metadata = comma >= 0 ? line.slice(0, comma) : line;
      const title = comma >= 0 ? line.slice(comma + 1).trim() : 'Untitled channel';
      const attributes = {};
      for (const match of metadata.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
      info = { title, logo: attributes['tvg-logo'] || '', group: attributes['group-title'] || 'General', id: attributes['tvg-id'] || title };
    } else if (info && line && !line.startsWith('#')) {
      if (/^https?:\/\//i.test(line)) items.push({ ...info, rokuTitle: rokuText(info.title), rokuGroup: rokuText(info.group), id: `${info.id}:${items.length}`, url: line, playbackUrl: line, streamFormat: 'hls', source: 'iptv' });
      info = null;
    }
  }
  return items;
}

async function getIptvChannels(source) {
  const cached = iptvCache.get(source.id);
  if (cached?.expires > Date.now()) return cached.items;
  const response = await fetch(source.url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`IPTV playlist returned HTTP ${response.status}`);
  const items = parseIptvM3u(await response.text());
  iptvCache.set(source.id, { items, expires: Date.now() + 300_000 });
  return items;
}
function publicOrigin() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_HOSTNAME) return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  const interfaces = os.networkInterfaces();
  const addresses = Object.values(interfaces).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => item.address);
  const address = addresses.find(item => item.startsWith('192.168.')) || addresses.find(item => item.startsWith('10.')) || addresses.find(item => item.startsWith('172.')) || addresses[0];
  return `http://${address || 'localhost'}:${process.env.FRONTEND_PORT || 5173}`;
}
function arabicNumber(value) {
  const normalized = String(value || '').replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric)) return numeric;
  const words = { الأول: 1, الاول: 1, الأولى: 1, الاولى: 1, الثاني: 2, الثانية: 2, الثالث: 3, الثالثة: 3, الرابع: 4, الرابعة: 4, الخامس: 5, الخامسة: 5, السادس: 6, السادسة: 6 };
  return words[normalized] || 1;
}
function playlistGroupInfo(title) {
  const value = String(title || '').replace(/\s+/g, ' ').trim();
  const episodeMatch = value.match(/(?:الحلقة|حلقة)\s*([0-9٠-٩]+)/u) || value.match(/(?:episode|ep\.?)\s*([0-9]+)/iu);
  const withoutEpisode = value
    .replace(/\s+(?:الحلقة|حلقة)\s*[0-9٠-٩]+.*$/u, '')
    .replace(/\s+(?:episode|ep\.?)[\s_-]*[0-9]+.*$/iu, '')
    .trim();
  const seasonMatch = withoutEpisode.match(/(?:الجزء|الموسم)\s+([^\s.]+)/u) || withoutEpisode.match(/season\s*([0-9]+)/iu);
  const seasonTitle = seasonMatch ? seasonMatch[0].trim() : 'الموسم الأول';
  const seriesTitle = (seasonMatch ? withoutEpisode.replace(seasonMatch[0], '') : withoutEpisode).replace(/[.،,:-]+$/u, '').trim() || withoutEpisode || value || 'Telegram';
  return {
    seriesTitle,
    seasonTitle,
    seasonSort: arabicNumber(seasonMatch?.[1]),
    episodeNumber: arabicNumber(episodeMatch?.[1]),
    hasPart: Boolean(seasonMatch),
    contentKind: episodeMatch ? 'episode' : 'movie'
  };
}
function normalizedGroupTitle(value) {
  return String(value || '')
    .replace(/^مسلسل\s+/u, '')
    .replace(/[.،,:_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ar');
}
app.use(cors());
app.use(express.json());

app.get('/api/health', async (_, res) => {
  try { res.json({ ok: true, source: 'telegram', storage: await getPlaylistStoreStatus() }); }
  catch (error) { res.status(503).json({ ok: false, source: 'telegram', storage: { type: 'mongodb', error: error.message } }); }
});
const dlnaOrigin = () => publicOrigin().replace(/:\d+$/, `:${port}`);
app.post('/api/telegram/dlna/cache', async (req, res) => {
  try {
    const channel = String(req.body?.channel || '').trim();
    const message = Number.parseInt(req.body?.message, 10);
    if (!channel || !Number.isInteger(message)) return res.status(400).json({ error: 'channel and message are required' });
    res.status(202).json(startDlnaCache(channel, message, String(req.body?.title || `Telegram video ${message}`)));
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/telegram/dlna/cache/:id', (req, res) => { const job = getDlnaCacheJob(req.params.id); if (!job) return res.sendStatus(404); res.json(job); });
app.get('/dlna/description.xml', (_, res) => res.type('application/xml').send(dlnaDescription(dlnaOrigin())));
app.get('/dlna/content.xml', (_, res) => res.type('application/xml').send('<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList><action><name>Browse</name></action></actionList></scpd>'));
app.post('/dlna/content', express.text({ type: ['text/xml', 'application/soap+xml'] }), async (_, res) => { const result = await dlnaBrowse(dlnaOrigin()); res.type('text/xml').send(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${result.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}</Result><NumberReturned>1</NumberReturned><TotalMatches>1</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse></s:Body></s:Envelope>`); });
app.get('/dlna/media/:filename', (req, res) => { const filename = req.params.filename; if (!/^[a-f0-9]+\.mp4$/i.test(filename)) return res.sendStatus(404); res.sendFile(resolve(dlnaRoot, filename)); });
app.get('/api/network-origin', (_, res) => res.json({ origin: publicOrigin() }));
app.get('/api/local/movies', async (_, res) => {
  try { res.json({ items: await listLocalMovies() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/local/config', async (_, res) => {
  try { res.json({ path: await getLocalMoviesRoot() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/local/movies/:id', async (req, res) => {
  try {
    let movie;
    if (typeof req.body?.title === 'string') movie = await setLocalMovieTitle(req.params.id, req.body.title);
    if (typeof req.body?.subtitle === 'string') movie = await setLocalMovieSubtitle(req.params.id, req.body.subtitle);
    if (typeof req.body?.enabled === 'boolean') movie = await setLocalMovieEnabled(req.params.id, req.body.enabled);
    if (!movie) return res.status(400).json({ error: 'Provide a movie title or enabled state' });
    res.json(movie);
  }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/local/movies/:id/subtitle-upload', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    const movie = await uploadLocalMovieSubtitle(req.params.id, req.query.filename, req.body);
    res.json(movie);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/local/config', async (req, res) => {
  try { res.json({ path: await setLocalMoviesRoot(req.body?.path) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/local/movies/:id/master.m3u8', async (req, res) => {
  try {
    const movie = await findLocalMovie(req.params.id);
    if (!movie) return res.sendStatus(404);
    const filePath = await localMoviePath(movie);
    // Subtitle delivery is side-loaded by Roku and must not invalidate the
    // already-transcoded video cache whenever the selected track changes.
    const hls = await ensureHls(`local:${filePath}`, 0, filePath, { transcodeVideo: true });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await hlsReady(hls.key)) return res.redirect(`/api/telegram/hls/${hls.key}/master.m3u8`);
      if (!hlsRunning(hls.key)) return res.status(502).json({ error: 'Local movie could not be converted to HLS' });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    res.status(504).json({ error: 'Local movie HLS preparation timed out' });
  } catch (error) { res.status(404).json({ error: error.message }); }
});
app.get('/api/local/movies/:id/subtitle', async (req, res) => {
  try {
    const movie = await findLocalMovie(req.params.id);
    if (!movie) return res.sendStatus(404);
    const subtitlePath = await localMovieSubtitlePath(movie);
    const subtitle = await readFile(subtitlePath, 'utf8');
    if (subtitlePath.toLowerCase().endsWith('.srt')) {
      const webvtt = subtitle
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      res.type('text/vtt').send(`WEBVTT\n\n${webvtt}`);
    } else {
      res.type('application/ttml+xml').send(subtitle);
    }
  } catch (error) { res.status(404).json({ error: error.message }); }
});
app.get('/api/local/movies/:id/subtitle-cues', async (req, res) => {
  try {
    const movie = await findLocalMovie(req.params.id);
    if (!movie) return res.sendStatus(404);
    const subtitlePath = await localMovieSubtitlePath(movie);
    const subtitle = (await readFile(subtitlePath, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const cues = [];
    const toSeconds = (clock, milliseconds) => {
      const [hours, minutes, seconds] = clock.split(':').map(Number);
      return hours * 3600 + minutes * 60 + seconds + Number(milliseconds) / 1000;
    };
    for (const block of subtitle.split(/\n\s*\n/)) {
      const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex(line => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line));
      if (timingIndex < 0) continue;
      const timing = lines[timingIndex].match(/(\d{2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})[,.](\d{3})/);
      if (!timing) continue;
      const text = lines.slice(timingIndex + 1).join('\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
        .replace(/[\u061C\u200B-\u200D\u2060\u2066-\u2069\u0640]/g, '')
        .replace(/[\uFFF0-\uFFFF\uFFFD]/g, '')
        .replace(/[\u206A-\u206F]/g, '')
        // Remove Arabic harakat. Roku's custom text layer can render the
        // base Arabic glyphs, but some firmware/font combinations show
        // combining marks as square placeholders.
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .trim();
      // Preserve normal left-to-right ordering for English-only cues. Arabic
      // cues still use the Roku-specific shaping required by the TV font.
      if (text) cues.push({ start: toSeconds(timing[1], timing[2]), end: toSeconds(timing[3], timing[4]), text: rokuText(text) });
    }
    res.json({ cues });
  } catch (error) { res.status(404).json({ error: error.message }); }
});
app.get('/api/playback/history', async (_, res) => {
  try { res.json({ items: await getPlaybackHistory() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/playback/:itemId', async (req, res) => {
  try { res.json({ item: await getPlayback(String(req.params.itemId)) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
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
app.get('/api/iptv/sources', async (_, res) => {
  try { res.json({ items: await getIptvSources() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
function validateIptvSource(body) {
  const name = String(body?.name || '').trim();
  const url = String(body?.url || '').trim();
  if (!name || !url) throw new Error('Name and M3U URL are required');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Enter a valid playlist URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Playlist URL must use HTTP or HTTPS');
  return { name, url };
}
app.post('/api/iptv/sources', async (req, res) => {
  try { const source = validateIptvSource(req.body); res.status(201).json(await createIptvSource(source.name, source.url)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/iptv/sources/:id', async (req, res) => {
  try {
    const source = validateIptvSource(req.body);
    const updated = await updateIptvSource(req.params.id, source.name, source.url);
    if (!updated) return res.sendStatus(404);
    iptvCache.delete(req.params.id);
    res.json(updated);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/iptv/sources/:id', async (req, res) => {
  try {
    const deleted = await deleteIptvSource(req.params.id);
    if (!deleted) return res.sendStatus(404);
    iptvCache.delete(req.params.id);
    res.sendStatus(204);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/iptv/channels', async (req, res) => {
  try {
    const source = req.query.sourceId
      ? await getIptvSource(String(req.query.sourceId))
      : (await getIptvSources())[0];
    if (!source) return res.status(400).json({ error: 'Select an IPTV playlist first' });
    res.json({ source, items: await getIptvChannels(source) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/telegram/roku/prepare', async (req, res) => {
  try {
    const channel = String(req.query.channel || '').trim();
    const message = Number.parseInt(req.query.message, 10);
    if (!channel || !Number.isInteger(message)) return res.status(400).json({ error: 'channel and message are required' });
    const sourceUrl = `http://127.0.0.1:${port}/api/telegram/video?channel=${encodeURIComponent(channel)}&message=${encodeURIComponent(message)}`;
    const job = await startRokuPrepare(channel, message, String(req.query.title || ''), sourceUrl, publicOrigin());
    res.status(200).json({ ...job, url: job.url && `${publicOrigin()}${job.url}`, pollUrl: job.status === 'complete' ? null : `${publicOrigin()}/api/telegram/roku/prepare/${job.id}` });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/telegram/roku/prepare/:id', (req, res) => {
  const job = getRokuJob(req.params.id);
  if (!job) return res.sendStatus(404);
  res.json({ ...job, url: job.url && `${publicOrigin()}${job.url}`, pollUrl: null });
});
async function buildPlaylistPayload() {
    const [storedItems, structure] = await Promise.all([getPlaylist(), getPlaylistStructure()]);
    const items = storedItems.map(item => {
      const inferred = playlistGroupInfo(item.title);
      const explicitlyAssignedSeries = structure.series.find(entry => entry.id === item.seriesId);
      const series = explicitlyAssignedSeries;
      const explicitlyAssignedSeason = series?.seasons?.find(entry => entry.id === item.seasonId);
      const season = explicitlyAssignedSeason;
      const structuredEpisode = item.kind === 'episode' && series && season;
      const group = structuredEpisode ? {
        seriesTitle: series.title,
        seasonTitle: season.title || `Season ${season.number}`,
        seasonSort: Number(season.number) || 1,
        episodeNumber: Number(item.episodeNumber) || inferred.episodeNumber || 1,
        contentKind: 'episode',
        hasPart: true
      } : item.kind === 'movie'
        ? { ...inferred, contentKind: 'movie' }
        : { seriesTitle: '', seasonTitle: '', seasonSort: 0, episodeNumber: 0, contentKind: 'unassigned', hasPart: false };
      return {
        ...item,
        thumbnail: item.thumbnail ? `${item.thumbnail}${item.thumbnail.includes('?') ? '&' : '?'}v=2` : item.thumbnail,
        ...group,
        rokuTitle: shapeArabicForRoku(item.title),
        rokuTextKind: /[A-Za-z]/.test(String(item.title || '')) ? 'latin' : 'arabic',
        rokuSeriesTitle: shapeArabicForRoku(group.seriesTitle || ''),
        rokuSeasonTitle: shapeArabicForRoku(group.contentKind === 'movie' && !group.hasPart ? '' : (group.seasonTitle || ''))
      };
    }).sort((left, right) => left.seriesTitle.localeCompare(right.seriesTitle, 'ar') || left.seasonSort - right.seasonSort || left.episodeNumber - right.episodeNumber);
    return { items, structure };
}
app.get('/api/telegram/playlist', async (_, res) => {
  try {
    res.json(await buildPlaylistPayload());
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/telegram/roku/series', async (_, res) => {
  try {
    console.log('[Roku] Series opened: refreshing Telegram connection through GramJS');
    const [telegram, payload] = await Promise.all([telegramStatus(), buildPlaylistPayload()]);
    console.log(`[Roku] Series catalog ready: ${payload.items.length} items; Telegram authenticated=${telegram.authenticated}`);
    res.json(payload);
  } catch (error) {
    console.error('[Roku] Series catalog failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});
app.put('/api/telegram/playlist', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.items)) return res.status(400).json({ error: 'items must be an array' });
    const items = req.body.items.filter(item => item && item.channel && Number.isInteger(Number(item.telegramMessageId))).map(item => ({
      id: String(item.id || `${item.channel}:${item.telegramMessageId}`),
      channel: String(item.channel),
      title: String(item.title || `Telegram video ${item.telegramMessageId}`),
      duration: item.duration || null,
      thumbnail: item.thumbnail || null,
      telegramMessageId: Number(item.telegramMessageId),
      metadata: item.metadata || null,
      source: 'telegram',
      kind: ['episode', 'movie', 'unassigned'].includes(item.kind) ? item.kind : 'unassigned',
      seriesId: item.seriesId ? String(item.seriesId) : null,
      seasonId: item.seasonId ? String(item.seasonId) : null,
      episodeNumber: Number.isInteger(Number(item.episodeNumber)) ? Number(item.episodeNumber) : null
    }));
    const rawSeries = Array.isArray(req.body.structure?.series) ? req.body.structure.series : [];
    const structure = { series: rawSeries.map(series => ({
      id: String(series.id || ''),
      title: String(series.title || '').trim(),
      seasons: (Array.isArray(series.seasons) ? series.seasons : []).map(season => ({
        id: String(season.id || ''),
        title: String(season.title || '').trim(),
        number: Math.max(1, Number.parseInt(season.number, 10) || 1)
      })).filter(season => season.id && season.title)
    })).filter(series => series.id && series.title) };
    res.json({ items: await savePlaylist(items, 'default', structure), structure });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/telegram/status', async (_, res) => res.json(await telegramStatus()));
app.get('/api/telegram/channel', async (req, res) => {
  try { res.json(await resolveTelegramChannel(String(req.query.username || ''))); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/telegram/thumbnail', async (req, res) => {
  try {
    const thumbnail = await getTelegramThumbnail(String(req.query.channel || ''), req.query.message);
    if (!thumbnail) return res.sendStatus(404);
    res.type(thumbnail.type).set('Cache-Control', 'public, max-age=86400').send(thumbnail.data);
  } catch (error) { res.status(404).json({ error: error.message }); }
});
app.get('/api/telegram/video', async (req, res) => {
  try {
    const video = await getTelegramVideoStream(String(req.query.channel || ''), req.query.message, { offset: 0 });
    if (!video) return res.sendStatus(404);
    const internal = req.query.internal === '1';
    const range = internal ? '' : String(req.headers.range || '');
    if (!range && video.size && !internal) {
      return res.status(416)
        .set('Accept-Ranges', 'bytes')
        .set('Content-Range', `bytes */${video.size}`)
        .json({ error: 'Range header required for streaming playback' });
    }
    let start = 0, end = video.size ? video.size - 1 : null;
    if (range && video.size) {
      const match = range.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        start = Number(match[1]);
        // Open-ended HTTP ranges (for example, bytes=48-) must continue to
        // the real end of the file. FFmpeg relies on this when reading MP4.
        const requestedEnd = match[2] ? Number(match[2]) : video.size - 1;
        end = Math.min(requestedEnd, video.size - 1);
        if (start >= video.size || start > end) return res.status(416).set('Content-Range', `bytes */${video.size}`).end();
      }
    }
    const length = end === null ? null : end - start + 1;
    const stream = range && video.size ? await getTelegramVideoStream(String(req.query.channel || ''), req.query.message, { offset: start, limit: length }) : video;
    res.status(range && video.size ? 206 : 200).type(video.type).set('Cache-Control', 'private, max-age=3600').set('Accept-Ranges', internal ? 'none' : 'bytes');
    if (video.size && end !== null) res.set('Content-Length', String(length));
    if (range && video.size) res.set('Content-Range', `bytes ${start}-${end}/${video.size}`);
    res.flushHeaders();
    for await (const chunk of stream.chunks) {
      if (res.destroyed) break;
      res.write(chunk);
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    console.error(`[telegram-video] ${req.query.channel || ''}:${req.query.message || ''} ${error.stack || error.message}`);
    if (!res.headersSent) res.status(404).json({ error: error.message });
    else res.destroy(error);
  }
});
app.get('/api/telegram/hls/:key/master.m3u8', async (req, res) => {
  try {
    const key = req.params.key;
    if (!key || !hlsRoot) return res.sendStatus(404);
    await startHls(key);
    const file = `${hlsRoot}/${key}/master.m3u8`;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { await access(file); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
      if (attempt === 59) return res.sendStatus(404);
    }
    res.type('application/vnd.apple.mpegurl').send(await readFile(file, 'utf8'));
  } catch { res.sendStatus(404); }
});
app.use('/api/telegram/hls', (req, res, next) => {
  const key = req.path.split('/')[1];
  if (!key || req.path.endsWith('/master.m3u8')) return next();
  express.static(hlsRoot)(req, res, next);
});
app.get('/api/telegram/hls', async (req, res) => {
  try {
    const channel = String(req.query.channel || '');
    const message = req.query.message;
    const sourceUrl = `http://127.0.0.1:${port}/api/telegram/video?channel=${encodeURIComponent(channel)}&message=${encodeURIComponent(message)}&internal=1`;
    const job = await ensureHls(channel, message, sourceUrl);
    if (!job) return res.sendStatus(404);
    res.json({ playlist: `/api/telegram/hls/${job.key}/master.m3u8`, key: job.key });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/telegram/playlist.m3u', async (req, res) => {
  try {
    const channel = String(req.query.channel || '').trim();
    let selectedEntries = [];
    try { selectedEntries = JSON.parse(String(req.query.items || '[]')); } catch { selectedEntries = []; }
    selectedEntries = Array.isArray(selectedEntries) ? selectedEntries.filter(item => item?.channel && Number.isInteger(Number(item.message))) : [];
    const selectedMessages = String(req.query.messages || '').split(',').map(value => Number.parseInt(value, 10)).filter(Number.isInteger);
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    if (!selectedEntries.length && !selectedMessages.length && !channel) selectedEntries = (await getPlaylist()).map(item => ({ channel: item.channel, message: item.telegramMessageId, title: item.title, duration: item.duration }));
    const catalog = selectedEntries.length ? { items: selectedEntries.map(item => ({ channel: String(item.channel), telegramMessageId: Number(item.message), title: String(item.title || `Telegram video ${item.message}`), duration: item.duration || null })) } : selectedMessages.length ? { items: selectedMessages.map(messageId => ({ channel, telegramMessageId: messageId, title: `Telegram video ${messageId}` })) } : channel ? await getTelegramCatalog(channel, page, 10) : { items: [] };
    const lines = ['#EXTM3U'];
    for (const item of catalog.items) {
      const itemChannel = item.channel || channel;
      lines.push(`#EXTINF:-1 tvg-name="${item.title.replaceAll('"', '')}",${item.title}`);
      lines.push(`${publicOrigin()}/api/telegram/video?channel=${encodeURIComponent(itemChannel)}&message=${encodeURIComponent(item.telegramMessageId)}`);
    }
    if (req.query.download === '1') res.set('Content-Disposition', 'attachment; filename="telegram-playlist.m3u"');
    res.type('audio/x-mpegurl').send(`${lines.join('\n')}\n`);
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.post('/api/telegram/auth/start', async (req, res) => {
  try { res.json(await beginTelegramAuth(String(req.body.phone || '').trim())); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/telegram/auth/code', (req, res) => {
  try { res.json(submitTelegramCode(String(req.body.code || '').trim())); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/telegram/auth/password', (req, res) => {
  try { res.json(submitTelegramPassword(String(req.body.password || ''))); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/telegram/catalog', async (req, res) => {
  try {
    const channel = String(req.query.channel || '').trim();
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    if (!channel) return res.status(400).json({ error: 'channel is required' });
    res.json({ source: 'telegram', channel, metadataOnly: true, page, ...(req.query.all === '1' ? await getAllTelegramCatalog(channel) : await getTelegramCatalog(channel, page)) });
  } catch (error) { res.status(502).json({ error: 'Unable to read Telegram catalog', detail: error.message }); }
});
app.listen(port, '0.0.0.0', () => {
  console.log(`Telegram catalog API listening on http://0.0.0.0:${port}`);
  try { const host = new URL(dlnaOrigin()).hostname; startSsdp(port, host); console.log(`DLNA media server available at http://${host}:${port}/dlna/description.xml`); } catch (error) { console.error(`DLNA discovery unavailable: ${error.message}`); }
});
