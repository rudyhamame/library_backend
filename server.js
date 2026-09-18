import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeArabicForRoku } from './arabic-shaper.js';
import { arabicSearchRegexSource, normalizeArabicSearch } from './arabic-search.js';
import { markProviderCatalogFailure } from './provider-catalog-store.js';
import { createXtreamSource, deleteXtreamSource, flattenSelection, getAllXtreamSources, getXtreamSource, getXtreamSources, publicXtreamSource, selectionFor, updateXtreamSelection, updateXtreamSource } from './xtream-store.js';
import { evictXtreamCache, getXtreamCatalog, getXtreamCategories, getXtreamSeriesEpisodes, validateXtreamConnection, xtreamCacheStats, xtreamProviderUrl } from './xtream.js';
import { evictM3uCache, getM3uCatalog, getM3uCategories, m3uCacheStats, m3uProviderUrl, validateM3uConnection } from './m3u.js';
import { MediaCapacityError, MediaJobManager, defaultMediaLimits, memoryPressure } from './media-job-manager.js';
import { HlsStrategy, PlaybackStrategy, choosePlaybackStrategy, determineHlsStrategy, hlsCodecArgs } from './playback-strategy.js';
import { clearStreamingHistory, deleteStreamingSession, getStreamingContinueWatching, getStreamingHistory, getStreamingResume, saveStreamingHistory } from './streaming-history-store.js';
import { getFavorites, toggleFavorite } from './favorites-store.js';
import { getSeriesWatchOverride, toggleSeriesWatchOverride } from './series-watch-overrides.js';
import { accountOwnerId, profileOwnerId } from './account-library-owner.js';
import { syncCatalogItems } from './catalog-store.js';
import { authorizeDeviceSession, autoLoginDeviceSession, castHandoffLink, changeAccountPassword, claimAutomaticPairing, confirmPasswordReset, createDeviceSession, deleteAccount, getAccountBasicInfo, getDeviceWeatherLocations, getLinkedDevices, getPairingInfo, getRokuDeviceSessionStatus, getRokuSourcePreferenceByOwner, initializeAccountDatabases, isProfileOnline, isRokuSessionLinked, listAllAccountsBasic, listAllLinkedDevices, loginAccount, loginDeviceSession, recordDeviceHeartbeat, registerAccount, registerBrowserDevice, requestDeviceSignupVerification, requestPasswordReset, resendDeviceSignupVerification, resolveAccountByEmail, resolveDeviceToken, saveDeviceWeatherLocations, selectAccountProfile, setupDeviceSession, unlinkAccountDevice, verifyDeviceSignupCode } from './device-sessions.js';
import { createAccountProfile, deleteAccountProfile, ensureDefaultProfile, getAccountProfile, getAccountProfiles, getProfileByCode, getProfilePartnerCode, getProfilePartnerEmail, setProfilePartnerEmail, setProfileRokuSourcePreference, updateAccountProfile } from './account-profile-store.js';
import { createLibraryCategory, deleteLibraryCategory, getManagedLibrary, renameLibraryCategory, replaceLibraryCategoryItems } from './library-category-store.js';
import { enforceLibraryOnly } from './library-route-policy.js';
import { checkPlaylistSources } from './playlist-health.js';
import { backdropVideoFile, ensureBackdropRoot, getRecommendationBackdrop, listBackdrops } from './recommendation-backdrop.js';
import { getAndroidStartupSnapshot, saveAndroidStartupSnapshot } from './android-startup-store.js';
import { providerPlaybackUrlIsUsable, resolveProviderMediaId, resolveProviderTitle } from './provider-playback-fields.js';
import { acquireProviderStreamLease } from './provider-stream-leases.js';
import { deleteProviderCatalog, getProviderCatalogCategories, getProviderCatalogItem, getProviderCatalogItems, getProviderCatalogItemsByIds, getProviderCatalogItemsForCategory, getProviderCatalogLanguagePrefixes, getProviderCatalogMeta, getProviderCatalogRails, getProviderMediaMetadataByIds, hydrateContinueWatchingArtwork, listProviderCatalogMeta, queryProviderCatalogItems, recordProviderCatalogDuration, replaceProviderCatalog, replaceProviderCatalogCategories, replaceProviderSeriesEpisodes } from './provider-catalog-store.js';

const app = express();
app.use(enforceLibraryOnly);
const port = process.env.PORT || 8787;
const dashboardCache = new Map();
const playlistHealthCache = new Map();
const playlistHealthInFlight = new Map();
const playlistHealthTtlMs = Math.max(10_000, Number.parseInt(process.env.PLAYLIST_HEALTH_TTL_MS || '30000', 10) || 30_000);
const arabicText = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const rokuText = (value) => arabicText.test(String(value || '')) ? shapeArabicForRoku(value) : String(value || '');
const forceRokuFullTranscode = String(process.env.ROKU_FORCE_FULL_TRANSCODE || 'false').toLowerCase() === 'true';
// Provider category names carry junk clients can't render: bidi control marks
// and dingbat/arrow/emoji prefixes (e.g. U+27A4 shows as an empty box).
const CATEGORY_JUNK = /[\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u2190-\u21FF\u2200-\u23FF\u2460-\u27BF\u2B00-\u2BFF\uFE00-\uFE0F]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const cleanCategoryName = (value) => String(value ?? '').replace(CATEGORY_JUNK, '').replace(/\s+/g, ' ').trim() || 'Other';
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
const welcomeRailLimit = 10;
const xtreamItemsInFlight = new Map();
// Self-hosted on a real machine now (not a 256 MB cloud box), so a few catalog
// downloads can run at once instead of strictly one.
const catalogMemoryConcurrency = Math.max(1, Number.parseInt(process.env.CATALOG_MEMORY_CONCURRENCY || '3', 10) || 3);
let catalogMemoryActive = 0;
const interactiveCatalogQueue = [];
const backgroundCatalogQueue = [];
function drainCatalogMemoryQueue() {
  while (catalogMemoryActive < catalogMemoryConcurrency) {
    const job = interactiveCatalogQueue.shift() || backgroundCatalogQueue.shift();
    if (!job) return;
    catalogMemoryActive += 1;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      catalogMemoryActive -= 1;
      setImmediate(drainCatalogMemoryQueue);
    });
  }
}
function withCatalogMemorySlot(task, priority = 'interactive') {
  return new Promise((resolve, reject) => {
    (priority === 'background' ? backgroundCatalogQueue : interactiveCatalogQueue).push({ task, resolve, reject });
    drainCatalogMemoryQueue();
  });
}
const rokuHlsRoot = path.join(os.tmpdir(), 'rh-stream-hls');
const frontendUrl = process.env.FRONTEND_URL || 'http://127.0.0.1:8787';
const mediaLimits = defaultMediaLimits();
const debugMediaLogging = String(process.env.DEBUG_MEDIA_LOGGING || 'false').toLowerCase() === 'true';
const mediaJobs = new MediaJobManager({ limits: mediaLimits, debug: debugMediaLogging });
const streamBackendPorts = String(process.env.STREAM_BACKEND_PORTS || '8788,8789').split(',').map(value => value.trim()).filter(Boolean);
// The provider line permits ONE concurrent connection. Anything optional (the
// recommendation backdrop) must check this and stand down while real playback
// is running - on this process and on the roku/android streamers.
async function providerStreamBusy() {
  try { if (mediaJobs.stats().total > 0 || mediaJobs.stats().queued > 0) return true; } catch { /* stats unavailable */ }
  for (const port of streamBackendPorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/active-streams`, { signal: AbortSignal.timeout(1500) });
      if (response.ok && Number((await response.json())?.count) > 0) return true;
    } catch { /* streamer down or unreachable - treat as idle */ }
  }
  return false;
}
// Ask the HLS streamers for a VOD runtime they learned while starting/serving
// this title. Used by resolveMediaDuration so the length is available even
// while playback holds the single provider stream slot.
async function streamerMediaDuration(sourceId, kind, id) {
  for (const port of streamBackendPorts) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/media-duration/${encodeURIComponent(sourceId)}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
        { signal: AbortSignal.timeout(1500) },
      );
      if (!response.ok) continue;
      const seconds = Math.max(0, Math.round(Number((await response.json())?.seconds) || 0));
      if (seconds > 0) return seconds;
    } catch { /* streamer down / unreachable */ }
  }
  return 0;
}
// Report the codec-matrix decision made by the streamer that is serving this
// exact Roku title. This reads the streamer's existing job only: it never
// probes the provider or opens a second media connection.
async function streamerPlaybackStrategy(sourceId, kind, id) {
  const results = await Promise.allSettled(streamBackendPorts.map(async port => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/active-streams`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return [];
    return (await response.json())?.streams || [];
  }));
  const matches = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    .filter(stream => String(stream.sourceId || '') === String(sourceId)
      && String(stream.kind || '') === String(kind)
      && String(stream.itemId || '') === String(id)
      && String(stream.client || '').toLowerCase() === 'roku')
    .sort((left, right) => Date.parse(right.lastAccessAt || right.startedAt || 0) - Date.parse(left.lastAccessAt || left.startedAt || 0));
  const active = matches[0];
  if (!active) return { playbackStrategy: '', videoMode: '', audioMode: '' };
  return {
    playbackStrategy: String(active.strategy || ''),
    videoMode: String(active.videoMode || ''),
    audioMode: String(active.audioMode || ''),
  };
}
const hlsMaxSegments = Math.max(12, Number.parseInt(process.env.HLS_MAX_SEGMENTS || '36', 10) || 36);
const mediaStreamIdleTimeoutMs = Math.max(10_000, Number.parseInt(process.env.MEDIA_STREAM_IDLE_TIMEOUT_MS || '45000', 10) || 45_000);
const libraryRevisions = new Map();
const libraryRevisionWaiters = new Map();
// Watch with Partner: a pending invite, keyed by the invited partner's
// accountOwnerId, plus the same revision/waiter long-poll trio used for
// library changes below - one invite in flight per partner at a time.
const partnerInvites = new Map();
const partnerInviteRevisions = new Map();
const partnerInviteWaiters = new Map();
const wwpStreamTicketTtlMs = 6 * 60 * 60 * 1000;
const androidStartupRefreshes = new Map();
const androidRecentRefreshes = new Map();
let activeDirectStreams = 0;
let shuttingDown = false;
let mediaRequestSequence = 0;
const mediaDurationCache = new Map();
const mediaDurationInFlight = new Map();
const mediaDurationCacheMaxEntries = 2_000;
const mediaDurationCacheTtlMs = 7 * 24 * 60 * 60 * 1000;
const streamTicketSecret = process.env.DEVICE_AUTH_SECRET || 'local-development-secret-change-before-production';

function issueStreamTicket(ownerId, accountOwner, sourceId, kind, id, ttlMs = 5 * 60_000) {
  const payload = Buffer.from(JSON.stringify({ ownerId, accountOwnerId: accountOwner, sourceId, kind, id, exp: Date.now() + ttlMs })).toString('base64url');
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

async function getIndexedXtreamSeriesEpisodes(source, seriesId) {
  const details = await getXtreamSeriesEpisodes(source, seriesId);
  const episodes = await Promise.all((details.episodes || []).map(async episode => ({
    ...episode,
    providerUrl: await sourceProviderUrl(source, 'series', episode.id, episode.extension),
  })));
  await replaceProviderSeriesEpisodes(source.ownerId, String(source._id), String(seriesId), details.title, episodes);
  return { ...details, episodes };
}

// A MongoDB snapshot of each provider/kind catalog keeps provider traffic low:
// a kind is downloaded from the provider at most once per TTL window no matter
// how much the clients browse, and the last good snapshot keeps serving when
// the provider blocks or errors. There is no timer - refreshes are triggered
// only by a real client request for a missing or stale kind.
const CATALOG_SNAPSHOT_TTL_MS = Math.max(5 * 60_000, Number.parseInt(process.env.CATALOG_SNAPSHOT_TTL_MS || '3600000', 10) || 60 * 60_000);
const catalogSnapshotJobs = new Map();

function refreshCatalogSnapshot(ownerId, source, kind) {
  const key = `${ownerId}:${source._id}:${kind}`;
  if (catalogSnapshotJobs.has(key)) return catalogSnapshotJobs.get(key);
  const job = (async () => {
    const [catalog, categories] = await Promise.all([
      withCatalogMemorySlot(() => getSourceCatalog(source, kind), 'interactive'),
      getSourceCategories(source, kind).catch(error => {
        console.warn(`[Catalog] category fetch failed source=${source._id} kind=${kind}: ${error.message} - items will save without category names`);
        return null;
      }),
    ]);
    const storedCatalog = await Promise.all(catalog.map(async item => ({
      ...item,
      // Mongo is the searchable index. Playable rows retain the provider URL
      // that Roku will use after finding/saving an item. A series row is a
      // show, not media; its episode URLs are added when details are expanded.
      providerUrl: kind === 'series' ? '' : await sourceProviderUrl(source, kind, item.id, item.extension),
    })));
    await syncCatalogItems({ accountId: ownerId, providerId: String(source._id), providerName: source.name, kind, items: storedCatalog });
    await replaceProviderCatalog(ownerId, String(source._id), source.name, kind, storedCatalog);
    if (Array.isArray(categories)) {
      await replaceProviderCatalogCategories(ownerId, String(source._id), kind,
        categories.map(entry => ({ id: String(entry.id), name: cleanCategoryName(entry.name) })));
    }
  })()
    .catch(async error => {
      await markProviderCatalogFailure(ownerId, String(source._id), kind).catch(() => {});
      console.warn(`[Catalog] snapshot refresh failed source=${source._id} kind=${kind}: ${error.message}`);
    })
    .finally(() => catalogSnapshotJobs.delete(key));
  catalogSnapshotJobs.set(key, job);
  return job;
}

// Block only on a first-ever fetch. A stale snapshot is served immediately
// while a single background refresh runs; a provider block never clears it.
async function ensureCatalogSnapshot(ownerId, source, kind) {
  const meta = await getProviderCatalogMeta(ownerId, String(source._id)).catch(() => null);
  const syncedAt = meta?.kinds?.[kind]?.syncedAt ? new Date(meta.kinds[kind].syncedAt).getTime() : 0;
  if (!syncedAt) { await refreshCatalogSnapshot(ownerId, source, kind); return; }
  if (Date.now() - syncedAt > CATALOG_SNAPSHOT_TTL_MS) void refreshCatalogSnapshot(ownerId, source, kind);
}

// Web app: serve strictly what MongoDB already holds.
// The playlist provider is never contacted on a browse/category/rails request -
// the snapshot is filled by the Roku bootstrap and the dashboard's catalog
// controls. When nothing is stored yet the endpoint just returns empty.
const catalogSnapshotHasKind = async (ownerId, sourceId, kind) => {
  const meta = await getProviderCatalogMeta(ownerId, String(sourceId)).catch(() => null);
  return Boolean(meta?.kinds?.[kind]?.syncedAt);
};

// The title-prefix language list only changes when a kind re-syncs. Compute it
// once per snapshot and reuse it for every browse/search request.
const catalogLanguageCache = new Map();
async function catalogLanguagesFor(ownerId, sourceId, kind) {
  const meta = await getProviderCatalogMeta(ownerId, String(sourceId)).catch(() => null);
  const syncedAt = String(meta?.kinds?.[kind]?.syncedAt || '');
  if (!syncedAt) return [];
  const cacheKey = `${ownerId}:${sourceId}:${kind}`;
  const cached = catalogLanguageCache.get(cacheKey);
  if (cached?.syncedAt === syncedAt) return cached.languages;
  const prefixes = await getProviderCatalogLanguagePrefixes(ownerId, String(sourceId), kind).catch(() => []);
  const priority = { AR: 0, EN: 1 };
  const languages = [...new Set(prefixes)].sort((a, b) => (priority[a] ?? 10) - (priority[b] ?? 10) || a.localeCompare(b));
  catalogLanguageCache.set(cacheKey, { syncedAt, languages });
  return languages;
}

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

function partnerInviteRevision(ownerId) {
  return partnerInviteRevisions.get(String(ownerId || '')) || 1;
}

function bumpPartnerInviteRevision(ownerId) {
  const key = String(ownerId || '');
  if (!key) return;
  const revision = partnerInviteRevision(key) + 1;
  partnerInviteRevisions.set(key, revision);
  const waiters = partnerInviteWaiters.get(key);
  if (!waiters) return;
  partnerInviteWaiters.delete(key);
  for (const waiter of waiters) waiter(revision);
}

function waitForPartnerInvite(ownerId, since, timeoutMs = 25_000) {
  const key = String(ownerId || '');
  const current = partnerInviteRevision(key);
  if (current !== since) return Promise.resolve(current);
  return new Promise(resolve => {
    const waiters = partnerInviteWaiters.get(key) || new Set();
    let timer;
    const finish = revision => {
      clearTimeout(timer);
      waiters.delete(finish);
      if (!waiters.size) partnerInviteWaiters.delete(key);
      resolve(revision);
    };
    waiters.add(finish);
    partnerInviteWaiters.set(key, waiters);
    timer = setTimeout(() => finish(partnerInviteRevision(key)), timeoutMs);
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
      reject(new Error('Media duration probe timed out'));
    }, 20_000);
    timeout.unref?.();
    child.stdout.on('data', chunk => { output = appendTail(output, chunk, 1024); });
    child.stderr.on('data', chunk => { errorOutput = appendTail(errorOutput, chunk, 2048); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      const seconds = Number.parseFloat(output.trim());
      if (code === 0 && Number.isFinite(seconds) && seconds > 0) resolve(Math.floor(seconds));
      else reject(new Error(errorOutput.trim() || 'Media duration is unavailable'));
    });
  });
}

async function resolveMediaDuration(source, kind, id, extension, seriesId = '') {
  // Never trust a catalog/snapshot-stored duration as authoritative - only a
  // live, bounded lookup against the provider itself (an already-running
  // streamer probe, or a fresh ffprobe) counts. Providers commonly store
  // placeholder/wrong durations in their catalog metadata.
  const cacheKey = `${source._id}:${kind}:${id}`;
  const cached = mediaDurationCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached;
  if (mediaDurationInFlight.has(cacheKey)) return mediaDurationInFlight.get(cacheKey);
  const pending = (async () => {
    let seconds = 0;
    let durationSource = 'probe';
    // The streamer probes the provider when it starts a title and remembers the
    // runtime - ask it. This resolves the length WHILE the title is playing (the
    // streamer holds the single provider slot, so our own probe would get "busy").
    if (seconds <= 0) {
      const fromStreamer = await streamerMediaDuration(String(source._id), kind, String(id));
      if (fromStreamer > 0) { seconds = fromStreamer; durationSource = 'stream-probe'; }
    }
    if (seconds <= 0) {
      // The ffprobe fallback opens a real provider connection, so optional
      // metadata work stands down while any playback is active.
      if (await providerStreamBusy()) return { seconds: 0, duration: '', source: 'busy' };
      const inputUrl = await sourceProviderUrl(source, kind, id, extension);
      seconds = await probeMediaDuration(inputUrl);
      durationSource = 'probe';
    }
    // Persist a freshly-probed runtime for browse/display purposes only (card
    // subtitles, etc.) - resolveMediaDuration itself never reads it back.
    if (seconds > 0) {
      recordProviderCatalogDuration(source.ownerId, String(source._id), kind, String(id), seconds).catch(() => {});
    }
    return cacheMediaDuration(cacheKey, seconds, durationSource);
  })().finally(() => mediaDurationInFlight.delete(cacheKey));
  mediaDurationInFlight.set(cacheKey, pending);
  return pending;
}

async function hydrateSeriesDurations(source, details) {
  const episodes = Array.isArray(details?.episodes) ? details.episodes : [];
  const storedMedia = await getProviderMediaMetadataByIds(source.ownerId, String(source._id), 'series', episodes.map(episode => episode.id)).catch(() => []);
  const storedById = new Map(storedMedia.map(item => [String(item.id), item]));
  const hydrated = episodes.map(episode => {
    const stored = storedById.get(String(episode.id));
    const knownSeconds = durationSeconds(episode.duration);
    if (knownSeconds > 0) return { ...episode, duration: displayDuration(knownSeconds), videoCodec: stored?.videoCodec || '', audioCodec: stored?.audioCodec || '' };
    const cached = mediaDurationCache.get(`${source._id}:series:${episode.id}`);
    if (cached?.expiresAt > Date.now() && cached.seconds > 0) return { ...episode, duration: cached.duration, videoCodec: stored?.videoCodec || '', audioCodec: stored?.audioCodec || '' };
    return { ...episode, duration: stored?.duration || '', videoCodec: stored?.videoCodec || '', audioCodec: stored?.audioCodec || '' };
  });
  return { ...details, episodes: hydrated };
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

function clientAddress(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return (forwarded || req.ip || '').replace(/^::ffff:/, '');
}

// Loopback-only gate for the local operations dashboard. The dashboard runs on
// the same host and calls 127.0.0.1; nothing off-box may read these.
function localRequest(req) {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
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

function requestAccountRealm(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  return resolveDeviceToken(token)?.realm === 'general' ? 'general' : 'roku';
}

function requestAccountOwner(req) {
  const accountId = requestAccount(req);
  return accountId && /^[a-f0-9]{24}$/i.test(accountId) ? accountOwnerId(accountId) : requestOwner(req);
}

function requestProfile(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  return resolveDeviceToken(token)?.profileId || null;
}

// Always profile-scoped, even for the default profile (whose token.ownerId is
// the account-wide owner). Streaming history uses this so every profile keeps
// its own watch history. Non-default profiles already resolve to the same value
// as requestOwner, so their existing history is unaffected.
function requestProfileOwner(req) {
  const session = resolveDeviceToken(String(req.get('x-device-token') || req.query.deviceToken || ''));
  if (session?.accountId && /^[a-f0-9]{24}$/i.test(String(session.accountId)) && session?.profileId) {
    return profileOwnerId(String(session.accountId), String(session.profileId));
  }
  return session?.ownerId || null;
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

function durationSeconds(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  if (/^\d+(?::\d{1,2}){1,2}$/.test(raw)) {
    const parts = raw.split(':').map(Number);
    const seconds = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

function cacheMediaDuration(key, seconds, source) {
  const duration = displayDuration(seconds);
  mediaDurationCache.delete(key);
  // A failed probe (seconds=0) is very often transient (provider hiccup,
  // timeout) - caching that miss for the same week-long TTL as a real
  // success would lock this title's playback out for a week over one bad
  // attempt. Retry it again soon instead.
  const ttl = seconds > 0 ? mediaDurationCacheTtlMs : 60_000;
  mediaDurationCache.set(key, {
    seconds, duration, source,
    expiresAt: Date.now() + ttl,
  });
  while (mediaDurationCache.size > mediaDurationCacheMaxEntries) mediaDurationCache.delete(mediaDurationCache.keys().next().value);
  return { seconds, duration, source };
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
  const kind = item.kind === 'episode' ? 'series' : String(item.kind || '');
  const id = resolveProviderMediaId(item, item.kind);
  const suppliedCategory = String(item.category || item.categoryName || '').trim();
  // "test" is the source display name, not a media category. Never expose it
  // as a Roku filter when an old saved item is missing category metadata.
  const category = /^test$/i.test(suppliedCategory) || !suppliedCategory ? 'Other' : suppliedCategory;
  const suppliedProviderUrl = providerPlaybackUrlIsUsable(item.providerUrl) ? String(item.providerUrl) : '';
  const providerUrl = suppliedProviderUrl || String(
    sourceType(source) === 'xtream' && kind !== 'series' && id
      ? sourceProviderUrl(source, kind, id, item.extension)
      : (providerPlaybackUrlIsUsable(item.url) ? item.url : '')
  );
  return {
    ...item,
    id,
    title: resolveProviderTitle(item, item.kind, id),
    kind: item.kind,
    sourceId: source._id,
    sourceName: source.name,
    category,
    language: item.language || detectXtreamLanguage(item, category),
    rokuCategory: item.rokuCategory || rokuText(category),
    providerUrl,
  };
}

async function attachProviderUrls(items, sources) {
  const byId = new Map((sources || []).map(source => [String(source._id), source]));
  return Promise.all((items || []).map(async item => {
    if (providerPlaybackUrlIsUsable(item.providerUrl)) return item;
    const source = byId.get(String(item.sourceId || ''));
    const id = resolveProviderMediaId(item, item.kind);
    const kind = item.kind === 'episode' ? 'series' : String(item.kind || '');
    if (!source || !id || !['series', 'movie', 'channel'].includes(kind)) return item;
    return { ...item, id, title: resolveProviderTitle(item, item.kind, id), providerUrl: await sourceProviderUrl(source, kind, id, item.extension) };
  }));
}

async function getLibrarySelectedItems(ownerId = null, requestedKind = '', accountOwner = ownerId) {
  if (!ownerId) return [];
  const sources = flattenSelection(await getAllXtreamSources(accountOwner), ownerId, accountOwner);
  const groups = sources.map(source => {
    const enabledItems = (Array.isArray(source.enabledItems) ? source.enabledItems : [])
      .filter(item => item?.kind && (!requestedKind || item.kind === requestedKind));
    // Roku catalog reads must only use the Library selection already stored in
    // MongoDB. Fetching a provider's entire catalog here to backfill one absent
    // logo made every page wait on an unrelated upstream request. Logo
    // enrichment belongs to the source import/update path, never this hot path.
    return enabledItems.map(item => selectedXtreamItem(source, item)).filter(item => item.id);
  });
  return groups.flat();
}

async function getRokuSelectedItems(kind, ownerId = null, accountOwner = ownerId, requestedSourceId = '') {
  // The managed Library is the category source of truth. Provider categories
  // only seed it; Roku never recomputes rails from the provider after that.
  if (!ownerId) return [];
  const suppliedItems = await getLibrarySelectedItems(ownerId, kind, accountOwner);
  const managed = await getManagedLibrary(ownerId, suppliedItems, kind);
  const selectedSourcePreference = String(requestedSourceId || '') || await getRokuSourcePreferenceByOwner(ownerId);
  const selectedSourceId = pickRokuSourceId(selectedSourcePreference, await getAllXtreamSources(accountOwner));
  return managed.categories.flatMap(category => category.items.map(item => ({
    ...item,
    category: category.name,
    rokuCategory: rokuText(category.name),
  }))).filter(item => !selectedSourceId || String(item.sourceId || '') === selectedSourceId);
}

function directXtreamItem(item) {
  const extension = String(item.extension || '').toLowerCase();
  const playbackUrl = rokuXtreamPlaybackPath(item.sourceId, item.kind, item.id, extension);
  const mediaDurationSeconds = durationSeconds(item.duration);
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
    durationSeconds: mediaDurationSeconds,
  };
}

function rokuDiscoveryItem(item) {
  const kind = item?.kind === 'movie' || item?.kind === 'channel' ? item.kind : 'series';
  const sourceId = String(item?.sourceId || '');
  const id = String(item?.id || '');
  if (!sourceId || !id) return null;
  const common = {
    ...item,
    id,
    sourceId,
    kind,
    title: String(item.title || 'Untitled'),
    thumbnail: item.logo || item.thumbnail || '',
    category: item.category || 'Other',
    rokuCategory: rokuText(item.category || 'Other'),
  };
  if (kind === 'series') {
    return {
      ...common,
      seriesId: id,
      contentKind: 'series-search',
      rokuTitle: rokuText(common.title),
      originalFormat: String(item.extension || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase(),
    };
  }
  const direct = directXtreamItem(common);
  return {
    ...direct,
    thumbnail: common.thumbnail,
    kind,
    contentKind: kind,
    group: kind === 'channel' ? common.category : undefined,
    rokuGroup: kind === 'channel' ? common.rokuCategory : undefined,
    rokuEnabled: true,
  };
}

function rokuXtreamStreamFormat(extension = '') {
  if (forceRokuFullTranscode) return 'hls';
  const ext = String(extension).toLowerCase();
  if (ext === 'mkv') return 'mkv';
  return ['mp4', 'm4v', 'mov'].includes(ext) ? 'mp4' : 'hls';
}

function rokuXtreamPlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (forceRokuFullTranscode) {
    const query = new URLSearchParams({ hlsFallback: 'full' });
    if (ext) query.set('ext', ext);
    return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8?${query}`;
  }
  if (rokuXtreamStreamFormat(ext) !== 'hls' && kind !== 'channel') {
    return `/api/xtream/play/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
  }
  return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

app.use(cors());
app.use(express.json({ limit: '2mb' })); // profile pictures + WWP host avatar are ~1MB data URIs

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
    const profile = session.profileId && session.accountId ? await getAccountProfile(session.accountId, session.profileId) : null;
    res.json({ ok: true, authenticated: true, profileName: profile?.name || '' });
  } catch (error) { res.status(503).json({ ok: false, authenticated: false, error: error.message }); }
});

async function ownerPlaylistHealth(ownerId, { force = false } = {}) {
  const cached = playlistHealthCache.get(ownerId);
  if (!force && cached?.expiresAt > Date.now()) return cached.payload;
  if (!force) {
    const sources = await getAllXtreamSources(ownerId);
    const results = sources.map(source => ({ sourceId: String(source._id), ok: source.connectionStatus === 'online', error: source.connectionMessage || '' }));
    const online = results.filter(result => result.ok).length;
    return { ok: sources.length > 0 && online === sources.length, status: sources.length === 0 ? 'not_saved' : online === sources.length ? 'online' : online ? 'degraded' : 'offline', total: sources.length, online, failed: sources.length - online, results, checkedAt: null };
  }
  if (playlistHealthInFlight.has(ownerId)) return playlistHealthInFlight.get(ownerId);
  const request = (async () => {
    const sources = await getAllXtreamSources(ownerId);
    const health = await checkPlaylistSources(sources, source => (
      sourceType(source) === 'm3u' ? validateM3uConnection(source) : validateXtreamConnection(source)
    ));
    const online = health.online;
    const status = sources.length === 0 ? 'not_saved' : health.failed > 0 ? (online > 0 ? 'degraded' : 'offline') : 'online';
    const payload = {
      ...health,
      ok: status === 'online', status, total: sources.length, online,
      results: health.results.map(({ sourceId, ok }) => ({ sourceId, ok })),
      checkedAt: new Date().toISOString(),
    };
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
    const healthOwner = session.accountId ? accountOwnerId(session.accountId) : session.ownerId;
    const { results: _results, ...summary } = await ownerPlaylistHealth(healthOwner);
    res.json(summary);
  } catch (error) {
    res.status(503).json({ ok: false, status: 'unavailable', error: error.message });
  }
});

app.get('/api/playlist-health', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ ok: false, status: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    res.json(await ownerPlaylistHealth(ownerId, { force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(503).json({ ok: false, status: 'unavailable', error: error.message });
  }
});


// Roku account authentication stays entirely on-TV. Once authenticated, the
// same endpoint returns an Android-app-only QR used strictly for remote pairing.
app.post('/api/roku/device-session', async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    res.json(await createDeviceSession(deviceId, token));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/device-session', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    res.json(await createDeviceSession(deviceId, token));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/device-session/status', async (req, res) => {
  try {
    const session = await getRokuDeviceSessionStatus(req.query.code);
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
app.post('/api/device-session/claim', async (req, res) => {
  try {
    const result = await claimAutomaticPairing(req.body?.code);
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
app.post('/api/device-session/auto-login', async (req, res) => {
  try {
    const result = await autoLoginDeviceSession(req.body?.code);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 401).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/setup', async (req, res) => {
  try {
    const result = await setupDeviceSession(rokuBodyField(req.body, 'code'), rokuBodyField(req.body, 'email'), rokuBodyField(req.body, 'password'), rokuBodyField(req.body, 'firstName'), rokuBodyField(req.body, 'lastName'), rokuBodyField(req.body, 'verificationCode'));
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

// Roku certification requires authentication to be completed on the TV. This
// endpoint keeps the existing short-lived, device-bound session model, but
// returns only the Roku token after credentials have been validated. It never
// returns the browser token produced by the shared account helper.
// BrightScript's FormatJson lowercases unquoted associative-array keys, so a
// Roku client's { verificationResend: true } arrives here as
// { verificationresend: true }. Read Roku request bodies through this so
// camelCase field names still match regardless of which casing sent them.
function rokuBodyField(body, name) {
  return body?.[name] ?? body?.[name.toLowerCase()];
}

app.post('/api/roku/device-session/on-device-auth', async (req, res) => {
  try {
    const body = req.body;
    const code = String(rokuBodyField(body, 'code') || '').trim();
    const mode = rokuBodyField(body, 'mode') === 'signup' ? 'signup' : 'signin';
    const email = rokuBodyField(body, 'email');
    const password = rokuBodyField(body, 'password');
    const firstName = rokuBodyField(body, 'firstName');
    const lastName = rokuBodyField(body, 'lastName');
    const verificationCode = rokuBodyField(body, 'verificationCode');
    const authPhase = mode === 'signup' && rokuBodyField(body, 'verificationResend')
      ? 'resend'
      : mode === 'signup' && rokuBodyField(body, 'verificationOnly')
        ? 'verify'
        : mode === 'signup' && rokuBodyField(body, 'verificationRequest')
          ? 'request'
          : mode === 'signup'
            ? 'finalize'
            : 'signin';
    const result = mode === 'signup' && rokuBodyField(body, 'verificationResend')
      ? await resendDeviceSignupVerification(code, email)
      : mode === 'signup' && rokuBodyField(body, 'verificationOnly')
        ? await verifyDeviceSignupCode(code, email, verificationCode)
        : mode === 'signup' && rokuBodyField(body, 'verificationRequest')
          ? await requestDeviceSignupVerification(code, email, password, firstName, lastName)
      : mode === 'signup'
        ? await setupDeviceSession(code, email, password, firstName, lastName, verificationCode, rokuBodyField(body, 'verificationBypassed'))
      : await loginDeviceSession(code, email, password);
    if (result.error) {
      console.log(`[roku on-device-auth] phase=${authPhase} outcome=error message=${result.error}`);
      return res.status(result.error.includes('expired') ? 404 : result.error.includes('Incorrect') ? 401 : 400).json(result);
    }
    console.log(`[roku on-device-auth] phase=${authPhase} outcome=${result.token ? 'token' : result.verificationValid ? 'verification-valid' : result.verificationResent ? 'resent' : result.verificationRequired ? 'verification-required' : result.verificationNotRequired ? 'verification-not-required' : 'ok'}`);
    if (result.verificationRequired || result.verificationNotRequired || result.verificationValid || result.verificationResent) return res.json(result);
    const rokuSession = await getRokuDeviceSessionStatus(code);
    if (!rokuSession || rokuSession.status !== 'approved' || !rokuSession.token) {
      return res.status(500).json({ error: 'Roku authorization could not be completed' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(rokuSession);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/account/devices', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to view linked devices' });
    const devices = await getLinkedDevices(accountId, resolveDeviceToken(String(req.get('x-device-token') || ''))?.profileId || '');
    res.json({ items: devices });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/roku/heartbeat', async (req, res) => {
  try {
    const session = resolveDeviceToken(String(req.get('x-device-token') || req.query.deviceToken || ''));
    if (!await isRokuSessionLinked(session)) return res.status(401).json({ error: 'Valid linked Roku authorization is required' });
    await recordDeviceHeartbeat(session.deviceId, req.body?.streaming === true, clientAddress(req), {
      // Roku's FormatJson lowercases keys.
      lanIp: req.body?.lanIp || req.body?.lanip || '',
      ecpAppId: req.body?.ecpAppId || req.body?.ecpappid || '',
      sourceId: req.body?.sourceId || req.body?.sourceid || '',
    });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
// A signed-in browser tab is not paired like a Roku, so it has no deviceId of
// its own — the client generates one (persisted in localStorage) and reports
// it here. This is the only path that makes a browser session show up at all
// in Connected Devices; without it, streaming from a browser is invisible.
app.post('/api/account/heartbeat', async (req, res) => {
  try {
    const authorization = resolveDeviceToken(String(req.get('x-device-token') || ''));
    if (!authorization || !authorization.accountId) return res.status(401).json({ error: 'Sign in required' });
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const kind = req.body?.kind === 'android' ? 'android' : 'browser';
    await registerBrowserDevice(authorization.accountId, authorization.profileId || '', deviceId, String(req.body?.label || ''), kind);
    await recordDeviceHeartbeat(deviceId, req.body?.streaming === true, clientAddress(req));
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
// "Play on Roku" hand-off. The phone queues a cast for one of its linked Roku
// devices; the Roku channel polls /pending and redeems the one-time code for a
// token bound to the *sender's* account + profile, then deep-links playback.
// ponytail: in-memory Map, lost on restart (like partnerInvites); a queued
// cast just needs to survive the ~seconds until the Roku polls.
const castQueue = new Map(); // deviceId -> { code, accountId, profileId, item, exp }
const CAST_TTL_MS = 2 * 60 * 1000;
function pruneCastQueue() { const now = Date.now(); for (const [id, e] of castQueue) if (e.exp < now) castQueue.delete(id); }

// Remote control for a cast already on screen (pause/play/seek), delivered
// through the same poll the Roku already runs during playback. One-shot:
// cleared the moment the Roku's next poll picks it up.
const castControlQueue = new Map(); // deviceId -> { action, value, exp }
const CAST_CONTROL_TTL_MS = 15 * 1000;
function pruneCastControlQueue() { const now = Date.now(); for (const [id, e] of castControlQueue) if (e.exp < now) castControlQueue.delete(id); }

async function releaseAndroidProviderForRoku(sourceId) {
  const host = String(process.env.ANDROID_STREAM_BACKEND_HOST || 'rh-stream-web').trim();
  const port = String(process.env.ANDROID_STREAM_BACKEND_PORT || '8788').trim();
  const response = await fetch(`http://${host}:${port}/internal/streams/android-handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Android streamer rejected handoff (HTTP ${response.status})`);
  const result = await response.json();
  console.log(`[Roku cast] released Android provider jobs source=${sourceId} stopped=${Number(result?.stopped) || 0}`);
}

function canonicalCastDisplay(kind, suppliedTitle) {
  const title = String(suppliedTitle || '').trim();
  if (kind !== 'series') return { title };
  // Android releases have used both "Series (12)" and "Series [E12]".
  // Normalize at the handoff boundary so Roku always receives one canonical
  // player title and structured fields, never a duplicated episode suffix.
  const match = title.match(/^(.*?)\s*(?:\[E\s*(\d+)\]|\(E?\s*(\d+)\))\s*$/i);
  if (!match) return { title, seriesTitle: title, episodeNumber: '' };
  const seriesTitle = String(match[1] || '').trim();
  const episodeNumber = String(match[2] || match[3] || '').trim();
  return {
    title: seriesTitle && episodeNumber ? `${seriesTitle} [E${episodeNumber}]` : title,
    seriesTitle,
    episodeNumber,
  };
}

app.post('/api/roku/cast', async (req, res) => {
  try {
    const auth = resolveDeviceToken(String(req.get('x-device-token') || ''));
    if (!auth?.accountId) return res.status(401).json({ error: 'Sign in to cast to Roku' });
    const deviceId = String(req.body?.deviceId || '').trim();
    const sourceId = String(req.body?.sourceId || '').trim();
    const kind = String(req.body?.kind || '').trim();
    const id = String(req.body?.id || '').trim();
    if (!deviceId || !sourceId || !id || !['channel', 'movie', 'series'].includes(kind)) {
      return res.status(400).json({ error: 'deviceId, sourceId, kind and id are required' });
    }
    const source = await getXtreamSource(sourceId, requestAccountOwner(req));
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const extension = String(req.body?.extension || '').trim();
    const providerUrl = await sourceProviderUrl(source, kind, id, extension);
    const display = canonicalCastDisplay(kind, req.body?.title);
    const linked = await getLinkedDevices(auth.accountId, auth.profileId || '');
    const targetDevice = linked.find(device => String(device.deviceId) === deviceId);
    if (!targetDevice) {
      return res.status(404).json({ error: 'That Roku is not linked to this account' });
    }
    // Finish every Android FFmpeg job holding this source before publishing
    // the one-time cast. This ordering prevents Roku from redeeming while a
    // stale phone job still owns the provider's single connection slot.
    await releaseAndroidProviderForRoku(sourceId);
    pruneCastQueue();
    const castCode = randomBytes(9).toString('base64url');
    castQueue.set(deviceId, {
      code: castCode,
      accountId: auth.accountId,
      profileId: auth.profileId || '',
      item: {
        sourceId, kind, id,
        extension,
        providerUrl,
        ...display,
        durationSeconds: Number(req.body?.durationSeconds) || 0,
      },
      exp: Date.now() + CAST_TTL_MS,
    });
    // The one-time code lets a LAN ECP launch redeem immediately. Roku still
    // polls the queue as a compatibility fallback when launch arguments are
    // unavailable or the channel was already transitioning.
    res.json({ ok: true, castCode });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/roku/cast/pending', (req, res) => {
  pruneCastQueue();
  pruneCastControlQueue();
  const deviceId = String(req.query.deviceId || '').trim();
  const entry = castQueue.get(deviceId);
  const control = castControlQueue.get(deviceId);
  if (control) castControlQueue.delete(deviceId);
  res.set('Cache-Control', 'no-store');
  if (entry?.stop) { castQueue.delete(deviceId); return res.json({ stop: true, ...(control ? { control } : {}) }); }
  // Polling is intentionally unauthenticated so a cold-started Roku can find
  // its handoff. Expose only the one-time redemption code and harmless display
  // identity here; the provider URL (which can contain credentials) is returned
  // only by the code-consuming /redeem request.
  res.json({
    ...(entry ? { cast: { code: entry.code, kind: entry.item.kind, id: entry.item.id, title: entry.item.title } } : {}),
    ...(control ? { control } : {}),
  });
});

// "Unsend" - the phone toggled Play-on-Roku off. Tell the Roku to stop and
// return to Welcome on its next poll (one-shot; cleared when served).
app.post('/api/roku/cast/stop', async (req, res) => {
  try {
    const auth = resolveDeviceToken(String(req.get('x-device-token') || ''));
    if (!auth?.accountId) return res.status(401).json({ error: 'Sign in to control Roku' });
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const linked = await getLinkedDevices(auth.accountId, auth.profileId || '');
    if (!linked.some(device => String(device.deviceId) === deviceId)) {
      return res.status(404).json({ error: 'That Roku is not linked to this account' });
    }
    pruneCastQueue();
    castQueue.set(deviceId, { stop: true, exp: Date.now() + CAST_TTL_MS });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Pause/play/seek a cast already on screen - delivered on the Roku's next
// poll (same channel /cast/pending uses for stop), so no new Roku poll loop.
app.post('/api/roku/cast/control', async (req, res) => {
  try {
    const auth = resolveDeviceToken(String(req.get('x-device-token') || ''));
    if (!auth?.accountId) return res.status(401).json({ error: 'Sign in to control Roku' });
    const deviceId = String(req.body?.deviceId || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!deviceId || !['pause', 'play', 'seek'].includes(action)) {
      return res.status(400).json({ error: 'deviceId and a valid action are required' });
    }
    const linked = await getLinkedDevices(auth.accountId, auth.profileId || '');
    if (!linked.some(device => String(device.deviceId) === deviceId)) {
      return res.status(404).json({ error: 'That Roku is not linked to this account' });
    }
    pruneCastControlQueue();
    const value = action === 'seek' ? Number(req.body?.value) || 0 : undefined;
    castControlQueue.set(deviceId, { action, value, exp: Date.now() + CAST_CONTROL_TTL_MS });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/roku/cast/redeem', async (req, res) => {
  try {
    pruneCastQueue();
    // Roku's FormatJson lowercases keys, so accept deviceid/deviceId both ways.
    const deviceId = String(req.body?.deviceId || req.body?.deviceid || '').trim();
    const code = String(req.body?.code || '');
    const entry = castQueue.get(deviceId);
    if (!entry || !code || code !== entry.code) return res.status(404).json({ error: 'Cast request expired' });
    const linked = await castHandoffLink(deviceId, entry.accountId, entry.profileId);
    if (linked.error) return res.status(400).json(linked);
    castQueue.delete(deviceId);
    await recordDeviceHeartbeat(deviceId, false, clientAddress(req));
    res.set('Cache-Control', 'no-store');
    res.json({ token: linked.token, profileName: linked.profileName, ...entry.item });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/account/login', async (req, res) => {
  try {
    const realm = req.body?.realm === 'roku' ? 'roku' : 'general';
    const result = await loginAccount(req.body?.email, req.body?.password, req.body?.deviceId, realm);
    if (result.error) return res.status(result.error.startsWith('Incorrect') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/signup', async (req, res) => {
  try {
    const result = await registerAccount(req.body?.email, req.body?.password, req.body?.firstName, req.body?.lastName, 'general', req.body?.verificationId, req.body?.verificationCode);
    if (result.error) return res.status(400).json(result);
    if (result.verificationRequired) return res.json(result);
    // Sign-up is also authentication. Return the same browser session payload
    // as sign-in so a newly created account can continue without a second
    // credential round-trip.
    const session = await loginAccount(req.body?.email, req.body?.password, req.body?.deviceId || '', 'general');
    if (session.error) return res.status(400).json(session);
    res.status(201).json(session);
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
// The Roku session token is already profile-scoped (see requestProfile), so
// a client like the Roku Settings PIN row - which only ever needs its own
// profile's id/hasPin, never the whole account's profile list - can resolve
// itself in one call instead of fetching every profile and filtering client-side.
app.get('/api/account/profile', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const profileId = requestProfile(req);
    if (!accountId || !profileId) return res.status(401).json({ error: 'Sign in to view this profile' });
    const profile = await getAccountProfile(accountId, profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.set('Cache-Control', 'no-store');
    res.json({ item: { id: profile.id, name: profile.name, hasPin: Boolean(profile.pinHash) } });
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
app.get('/api/account/profiles/:profileId/avatar', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to view profile images' });
    const profile = await getAccountProfile(accountId, req.params.profileId);
    const match = String(profile?.avatarImage || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.sendStatus(404);
    res.set('Content-Type', `image/${match[1]}`);
    res.set('Cache-Control', 'private, no-store');
    res.send(Buffer.from(match[2], 'base64'));
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
    const authorization = resolveDeviceToken(String(req.get('x-device-token') || req.query.deviceToken || ''));
    const accountId = authorization?.accountId;
    if (!accountId) return res.status(401).json({ error: 'Sign in to choose a profile' });
    const result = await selectAccountProfile(accountId, req.params.profileId, authorization, req.body?.pin);
    if (result.error) return res.status(result.code === 'PROFILE_PIN_REQUIRED' ? 403 : 404).json(result);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
app.get('/api/account/roku-source', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const ownerId = requestOwner(req);
    if (!accountId || !ownerId) return res.status(401).json({ error: 'Authentication required' });
    const sources = await getAllXtreamSources(accountOwnerId(accountId));
    const savedSourceId = await getRokuSourcePreferenceByOwner(ownerId);
    const sourceId = sources.some(source => String(source._id) === savedSourceId) ? savedSourceId : String(sources[0]?._id || '');
    res.set('Cache-Control', 'no-store');
    const items = await Promise.all(sources.map(async source => {
      let expiryDate = '';
      if ((source.type || 'xtream') === 'xtream') {
        try {
          const info = await validateXtreamConnection(source, { attempts: 1, timeoutMs: 8_000 });
          const expirySeconds = Number(info?.exp_date) || 0;
          if (expirySeconds > 0) expiryDate = new Date(expirySeconds * 1000).toISOString().slice(0, 10);
        } catch { /* Provider status is optional; keep the chooser responsive. */ }
      }
      // Include a lowercase alias because some Roku JSON bridges normalize
      // associative-array keys when crossing the Task boundary.
      return {
        id: source._id,
        name: source.name,
        type: source.type || 'xtream',
        expiryDate,
        expiry: expiryDate,
        connectionStatus: source.connectionStatus || 'unknown',
        connectionMessage: source.connectionMessage || '',
      };
    }));
    res.json({ sourceId, items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
async function saveRokuSourceRequest(req, res) {
  try {
    const accountId = requestAccount(req);
    const ownerId = requestAccountOwner(req);
    const profileId = requestProfile(req);
    // Roku sends this as a query parameter (its PUT body is not reliably
    // delivered); browsers send a JSON body. Accept either.
    const sourceId = String(req.body?.sourceId ?? req.query?.sourceId ?? '').trim();
    if (!accountId || !ownerId) return res.status(401).json({ error: 'Authentication required' });
    if (sourceId && !await getXtreamSource(sourceId, ownerId)) return res.status(404).json({ error: 'Playlist source not found' });
    res.json({ sourceId: await setProfileRokuSourcePreference(accountId, profileId, sourceId) });
  } catch (error) { res.status(500).json({ error: error.message }); }
}
app.put('/api/account/roku-source', saveRokuSourceRequest);
app.post('/api/account/roku-source', saveRokuSourceRequest);

// A partner's account email only names their account, which can hold several
// profiles - the profile code (see account-profile-store.js) pins down the
// exact one. Still requires reciprocity: that specific profile must itself
// list the host back as its partner, by email AND code, before this links.
async function resolvePartnerProfile(partnerEmail, partnerCode, hostEmail, hostCode, realm = 'roku') {
  if (!partnerEmail || !partnerCode || !hostEmail || !hostCode) return null;
  const partner = await resolveAccountByEmail(partnerEmail, realm);
  if (!partner) return null;
  const raw = await getProfileByCode(partner.accountId, partnerCode);
  if (!raw) return null;
  const reciprocalEmail = await getProfilePartnerEmail(partner.accountId, raw.id);
  const reciprocalCode = await getProfilePartnerCode(partner.accountId, raw.id);
  if (reciprocalEmail !== hostEmail || reciprocalCode !== hostCode) return null;
  return { partner, profile: raw };
}

app.get('/api/account/partner', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const realm = requestAccountRealm(req);
    if (realm !== 'general') return res.status(404).json({ error: 'Partner accounts are available only for General users' });
    if (!accountId) return res.status(401).json({ error: 'Authentication required' });
    const profileId = requestProfile(req);
    res.set('Cache-Control', 'no-store');
    const myProfile = profileId ? await getAccountProfile(accountId, profileId) : await ensureDefaultProfile(accountId);
    const myProfileCode = myProfile?.code || '';
    const partnerEmail = await getProfilePartnerEmail(accountId, profileId);
    const partnerProfileCode = await getProfilePartnerCode(accountId, profileId);
    if (!partnerEmail) return res.json({ partnerEmail: '', partnerProfileCode: '', myProfileCode, linked: false, online: false, name: '' });
    const hostAccount = await getAccountBasicInfo(accountId, realm);
    const resolved = await resolvePartnerProfile(partnerEmail, partnerProfileCode, hostAccount?.email || '', myProfileCode, realm);
    res.json({
      partnerEmail,
      partnerProfileCode,
      myProfileCode,
      linked: Boolean(resolved),
      online: resolved ? await isProfileOnline(resolved.partner.accountId, resolved.profile.id) : false,
      name: resolved?.profile.name || '',
      avatarImage: resolved?.profile.avatarImage || '',
      partnerProfileId: resolved?.profile.id || '',
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/account/partner', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const realm = requestAccountRealm(req);
    if (realm !== 'general') return res.status(404).json({ error: 'Partner accounts are available only for General users' });
    if (!accountId) return res.status(401).json({ error: 'Authentication required' });
    const email = String(req.body?.partnerEmail || '').trim();
    const code = String(req.body?.partnerProfileCode || '').trim().toUpperCase();
    if (email) {
      const partner = await resolveAccountByEmail(email, realm);
      if (!partner) throw new Error('No RH account uses that email address');
      const profile = await getProfileByCode(partner.accountId, code);
      if (!profile) throw new Error(`That account has no profile with code ${code || '?'}`);
    }
    const partnerEmail = await setProfilePartnerEmail(accountId, requestProfile(req), email, code);
    res.json({ partnerEmail, partnerProfileCode: partnerEmail ? code : '' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// Watch with Partner: send an invite for the exact title/position/quality the
// host is currently watching. The partner joins the SAME provider connection
// via a stream ticket (see /api/xtream/stream-ticket above) rather than
// opening a second one - the whole point of this feature.
app.post('/api/partner/invite', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const realm = requestAccountRealm(req);
    if (realm !== 'general') return res.status(404).json({ error: 'Partner accounts are available only for General users' });
    const ownerId = requestOwner(req);
    const accountOwner = requestAccountOwner(req);
    const profileId = requestProfile(req);
    if (!accountId || !ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    const { sourceId, kind, id, extension = '', title = '' } = req.body || {};
    if (!sourceId || !['channel', 'movie', 'series'].includes(kind) || !id) {
      return res.status(400).json({ error: 'sourceId, kind, and id are required' });
    }
    const partnerEmail = await getProfilePartnerEmail(accountId, profileId);
    if (!partnerEmail) return res.status(400).json({ error: 'Set a partner in Settings before inviting them' });
    const partner = await resolveAccountByEmail(partnerEmail, realm);
    if (!partner) return res.status(404).json({ error: `No RH account found for ${partnerEmail}` });
    const source = await getXtreamSource(sourceId, accountOwner);
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const hostAccount = await getAccountBasicInfo(accountId, realm);
    const hostProfiles = await getAccountProfiles(accountId);
    const selectedHostProfile = hostProfiles.find(profile => profile.id === profileId) || hostProfiles.find(profile => profile.isDefault) || hostProfiles[0];
    const hostProfile = selectedHostProfile ? await getAccountProfile(accountId, selectedHostProfile.id) : null;
    const wwpSessionId = randomBytes(12).toString('base64url');
    const streamTicket = issueStreamTicket(ownerId, accountOwner, String(sourceId), kind, String(id), wwpStreamTicketTtlMs);
    // The partner cannot resolve the VOD duration themselves (they do not own
    // this source), so carry it in the invite. Trust the host's player value;
    // fall back to a provider probe only when it did not send one.
    let durationSeconds = Math.max(0, Math.round(Number(req.body?.durationSeconds) || 0));
    if (!durationSeconds && kind !== 'channel') {
      try {
        const probed = await resolveMediaDuration(source, kind, String(id), extension);
        durationSeconds = Math.max(0, Math.round(Number(probed?.seconds) || 0));
      } catch { /* best effort - the partner's scrubber just stays open-ended */ }
    }
    const invite = {
      wwpSessionId,
      hostOwnerId: ownerId,
      hostName: hostProfile?.name || hostAccount?.name || hostAccount?.email || 'Your partner',
      hostAvatar: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(hostProfile?.avatarImage || req.body?.hostAvatar || '')) ? String(hostProfile?.avatarImage || req.body?.hostAvatar).slice(0, 1_500_000) : '',
      title: String(title || '').slice(0, 200),
      sourceId: String(sourceId),
      kind,
      id: String(id),
      extension: String(extension || ''),
      streamTicket,
      start: Math.max(0, Number(req.body?.start) || 0),
      durationSeconds,
      quality: String(req.body?.quality || ''),
      expiresAt: Date.now() + wwpStreamTicketTtlMs,
    };
    const hostEmail = hostAccount?.email || '';
    const matchedProfiles = await reciprocalPartnerProfiles(partner.accountId, hostEmail);
    if (matchedProfiles.length === 0) return res.status(409).json({ error: "Your partner hasn't added you on their end yet." });
    for (const matched of matchedProfiles) {
      partnerInvites.set(matched.raw.ownerId, invite);
      bumpPartnerInviteRevision(matched.raw.ownerId);
    }
    res.json({ ok: true, wwpSessionId, partnerEmail: partner.email });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/partner/invite', async (req, res) => {
  try {
    if (requestAccountRealm(req) !== 'general') return res.status(404).json({ error: 'Partner accounts are available only for General users' });
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const since = Number.parseInt(String(req.query.since || '0'), 10) || 0;
    const revision = await waitForPartnerInvite(ownerId, since);
    const invite = partnerInvites.get(ownerId) || null;
    if (invite && invite.expiresAt < Date.now()) partnerInvites.delete(ownerId);
    res.set('Cache-Control', 'no-store');
    res.json({ revision, invite: invite && invite.expiresAt >= Date.now() ? invite : null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/password', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const result = await changeAccountPassword(accountId, req.body?.currentPassword, req.body?.newPassword, requestAccountRealm(req));
    if (result.error) return res.status(result.error.startsWith('Sign in') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/password-reset/request', async (req, res) => {
  try {
    const realm = req.body?.realm === 'roku' ? 'roku' : 'general';
    const result = await requestPasswordReset(req.body?.email, realm);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/password-reset/confirm', async (req, res) => {
  try {
    const result = await confirmPasswordReset(req.body?.code, req.body?.newPassword);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/account', async (req, res) => {
  try {
    const result = await deleteAccount(requestAccount(req), req.body?.password, requestAccountRealm(req));
    if (result.error) return res.status(result.error.startsWith('Sign in') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});
// The Roku on-device DashboardTask only issues GET/POST/PUT requests, so the
// Roku channel's Settings "Delete Account" uses this POST alias instead of
// the DELETE route above (same deleteAccount() call, same requirements).
app.post('/api/account/delete', async (req, res) => {
  try {
    const result = await deleteAccount(requestAccount(req), req.body?.password, requestAccountRealm(req));
    if (result.error) return res.status(result.error.startsWith('Sign in') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(Number(error?.status) || 500).json({ error: error.message }); }
});

// Infrastructure probes must only verify that Express is accepting traffic.
// Database/provider checks belong to /api/health and must not keep Fly's proxy
// waiting when an external dependency is unavailable.
app.get('/healthz', (_, res) => res.json({ ok: true }));

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

// Every linked device + the playlist provider currently assigned to its
// account, for the dashboard's Connected Devices page. Loopback-only.
app.get('/internal/devices', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const devices = await listAllLinkedDevices();
    const sourceNameCache = new Map();
    const rows = await Promise.all(devices.map(async device => {
      const displayedSourceId = device.streamingProviderId || device.rokuSourceId;
      let providerName = '';
      if (displayedSourceId && device.accountOwnerId) {
        const cacheKey = `${device.accountOwnerId}:${displayedSourceId}`;
        if (!sourceNameCache.has(cacheKey)) {
          const source = await getXtreamSource(displayedSourceId, device.accountOwnerId).catch(() => null);
          sourceNameCache.set(cacheKey, source?.name || '');
        }
        providerName = sourceNameCache.get(cacheKey);
      }
      const seenAgoMs = device.lastSeenAt ? Date.now() - new Date(device.lastSeenAt).getTime() : null;
      const streamAgoMs = device.lastStreamingSeenAt ? Date.now() - new Date(device.lastStreamingSeenAt).getTime() : null;
      return {
        deviceId: device.deviceId,
        label: device.kind === 'browser' || device.kind === 'android' ? device.label : `Roku ${String(device.deviceId || '').replace(/^roku-/, '').slice(-8).toUpperCase()}`,
        kind: device.kind,
        accountEmail: device.accountEmail,
        profileId: device.profileId,
        profileName: device.profileName,
        profileOwnerId: device.profileOwnerId,
        providerId: device.rokuSourceId,
        streamingProviderId: device.streamingProviderId,
        providerName,
        lastSeenAt: device.lastSeenAt,
        lastStreamingSeenAt: device.lastStreamingSeenAt,
        lastClientIp: device.lastClientIp,
        lanIp: device.lanIp,
        ecpAppId: device.ecpAppId,
        online: seenAgoMs != null && seenAgoMs <= 90_000,
        streamingHeartbeat: streamAgoMs != null && streamAgoMs <= 15_000,
        linkedAt: device.linkedAt,
      };
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ devices: rows, now: new Date().toISOString() });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Read-only view of the signed-in account's stored MongoDB catalog snapshot,
// for the operations dashboard (:8790). Scoped to the caller's account token.
app.get('/api/xtream/catalog-snapshot', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const sources = await getAllXtreamSources(ownerId);
    res.set('Cache-Control', 'no-store');
    const rows = await Promise.all(sources.map(async source => {
      const meta = await getProviderCatalogMeta(ownerId, String(source._id)).catch(() => null);
      return {
        sourceId: String(source._id),
        name: source.name || 'Playlist',
        connectionStatus: source.connectionStatus || 'unknown',
        counts: {
          series: Number(meta?.kinds?.series?.count) || 0,
          movie: Number(meta?.kinds?.movie?.count) || 0,
          channel: Number(meta?.kinds?.channel?.count) || 0,
        },
        syncedAt: meta?.updatedAt || null,
        downloading: ['series', 'movie', 'channel'].some(kind => catalogSnapshotJobs.has(`${ownerId}:${source._id}:${kind}`)),
      };
    }));
    res.json({ sources: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Manual per-provider trigger for the operations dashboard: force a fresh
// download of this one provider's full catalog into the MongoDB snapshot,
// bypassing the TTL. Fire-and-forget — reuses the same dedup'd job as the
// lazy refresh, so this is a no-op if a refresh for this provider is already
// running. Progress is read back via the `downloading` flag above.
app.post('/api/xtream/sources/:id/download-catalog', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(req.params.id, ownerId);
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    for (const kind of ['series', 'movie', 'channel']) refreshCatalogSnapshot(ownerId, source, kind);
    res.json({ ok: true, started: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/catalog-snapshot/items', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const kind = { series: 'series', movie: 'movie', movies: 'movie', vod: 'movie', channel: 'channel', channels: 'channel', live: 'channel' }[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be series, movie, or channel' });
    const source = await getXtreamSource(String(req.query.sourceId || ''), ownerId);
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    res.set('Cache-Control', 'no-store');
    const result = await queryProviderCatalogItems(
      ownerId, String(source._id), kind,
      { q: String(req.query.q || ''), page: Number.parseInt(req.query.page, 10) || 1, limit: Number.parseInt(req.query.limit, 10) || 50 },
    );
    // The real, untouched provider URL for each item - computed here (not
    // stored in the snapshot) since it embeds this source's credentials.
    // Shown on the RH servers catalog page so a Direct-playback question can
    // be answered by looking at the exact URL a client would be given.
    result.items = (result.items || []).map(item => ({ ...item, providerUrl: sourceProviderUrl(source, kind, item.id, item.extension) }));
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// A "series" catalog row is the show, not a playable stream - only its
// episodes have a provider URL. The RH servers catalog page drills into one
// series at a time here (never all of them: a full series-to-episodes
// expansion is one live provider call per show, too expensive to do for an
// entire paginated series list).
app.get('/api/xtream/catalog-snapshot/episodes', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const seriesId = String(req.query.seriesId || '');
    if (!seriesId) return res.status(400).json({ error: 'seriesId is required' });
    const source = await getXtreamSource(String(req.query.sourceId || ''), ownerId);
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    res.set('Cache-Control', 'no-store');
    const details = await getIndexedXtreamSeriesEpisodes(source, seriesId);
    const items = (details.episodes || []).map(episode => {
      const extension = String(episode.extension || '').toLowerCase();
      return {
        id: episode.id,
        title: episode.title || `${details.title} - ${episode.episodeNumber}`,
        category: episode.seasonTitle || (episode.seasonNumber != null ? `Season ${episode.seasonNumber}` : ''),
        extension,
        providerUrl: sourceProviderUrl(source, 'series', episode.id, extension),
      };
    });
    res.json({ seriesTitle: details.title, items, total: items.length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/xtream/catalog-snapshot/codecs', async (req, res) => {
  return res.status(404).json({ error: 'Catalog media-info scanning has been removed' });
  /* legacy catalog scanner retained below only as dead source during rollout
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(String(req.body?.sourceId || ''), ownerId);
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const kind = String(req.body?.kind || '');
    const id = String(req.body?.id || '');
    if (!['movie', 'channel', 'series'].includes(kind) || !id) return res.status(400).json({ error: 'A movie, channel, or episode is required' });
    let item;
    if (kind === 'series') {
      const seriesId = String(req.body?.seriesId || '');
      if (!seriesId) return res.status(400).json({ error: 'seriesId is required for an episode' });
      const details = await getIndexedXtreamSeriesEpisodes(source, seriesId);
      item = details.episodes.find(episode => String(episode.id) === id);
      if (!item) return res.status(404).json({ error: 'Series episode not found' });
      const cached = await getProviderMediaMetadata(ownerId, String(source._id), 'series', id);
      if (cached?.videoCodec || cached?.audioCodec) {
        return res.json({ videoCodec: cached.videoCodec || '', audioCodec: cached.audioCodec || '', duration: cached.duration || displayDuration(durationSeconds(item.duration)), cached: true });
      }
    } else {
      item = await getProviderCatalogItem(ownerId, String(source._id), kind, id);
      if (!item) return res.status(404).json({ error: 'Catalog item not found' });
    }
    const storedDurationSeconds = durationSeconds(item.duration);
    if (kind !== 'series' && (item.videoCodec || item.audioCodec) && (kind === 'channel' || storedDurationSeconds > 0)) {
      return res.json({
        videoCodec: item.videoCodec || '', audioCodec: item.audioCodec || '',
        duration: kind === 'channel' ? 'Live' : displayDuration(storedDurationSeconds), cached: true,
      });
    }
    if (await providerStreamBusy()) return res.status(409).json({ error: 'Codec scan paused while playback is active' });
    const inputUrl = await sourceProviderUrl(source, kind, id, item.extension);
    const codecs = await probeMediaCodecs(inputUrl);
      if (kind === 'series') {
        await recordProviderMediaMetadata(ownerId, String(source._id), kind, id, {
          videoCodec: codecs.videoCodec, audioCodec: codecs.audioCodec,
          duration: displayDuration(codecs.durationSeconds || storedDurationSeconds),
        });
      } else {
        await recordProviderCatalogCodecs(ownerId, String(source._id), kind, id, codecs.videoCodec, codecs.audioCodec);
      }
      if (kind === 'movie' && codecs.durationSeconds > 0) {
        await recordProviderCatalogDuration(ownerId, String(source._id), kind, id, codecs.durationSeconds);
      }
    res.set('Cache-Control', 'no-store');
    res.json({
      videoCodec: codecs.videoCodec, audioCodec: codecs.audioCodec,
      duration: kind === 'channel' ? 'Live' : displayDuration(codecs.durationSeconds || storedDurationSeconds), cached: false,
    });
  } catch (error) {
    res.status(502).json({ error: String(error?.message || 'Codec probe failed').slice(0, 240) });
  }
});
  */
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
    const accountOwner = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    const source = await getXtreamSource(req.params.sourceId, accountOwner);
    if (!source) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store');
    res.json({ ticket: issueStreamTicket(ownerId, accountOwner, req.params.sourceId, req.params.kind, req.params.id) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/series/:sourceId/:id', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(req.params.sourceId, ownerId);
    if (!source) return res.sendStatus(404);
    // Catalog responses must never wait for FFprobe across a whole season.
    // Unknown durations are resolved through the dedicated media-duration API.
    const details = await hydrateSeriesDurations(source, await getIndexedXtreamSeriesEpisodes(source, req.params.id));
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
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const requestedSourceId = String(req.query.sourceId || '').trim();
    const [selectedSeries, selectedMovies, selectedChannels, sources, favorites] = await Promise.all([
      getRokuSelectedItems('series', ownerId, accountOwner, requestedSourceId),
      getRokuSelectedItems('movie', ownerId, accountOwner, requestedSourceId),
      getRokuSelectedItems('channel', ownerId, accountOwner, requestedSourceId),
      getAllXtreamSources(accountOwner),
      getFavorites(accountOwner, requestProfile(req)).catch(() => []),
    ]);
    const selectedSourcePreference = requestedSourceId || await getRokuSourcePreferenceByOwner(ownerId);
    const selectedSourceId = pickRokuSourceId(selectedSourcePreference, sources);
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
    const accountSourceIds = new Set(sources.map(source => String(source._id)));
    const discoveryItems = items => (Array.isArray(items) ? items : [])
      .filter(item => !selectedSourceId || String(item?.sourceId || '') === selectedSourceId)
      .filter(item => accountSourceIds.has(String(item?.sourceId || '')))
      .map(item => {
        const source = sources.find(candidate => String(candidate._id) === String(item?.sourceId || ''));
        return rokuDiscoveryItem(source ? selectedXtreamItem(source, item) : item);
      })
      .filter(Boolean)
      .slice(0, 10);
    // "New" rails come from the stored provider snapshot (newest per kind), not
    // the Android startup snapshot which is only built when the phone app runs.
    const profileSources = flattenSelection(sources, ownerId, accountOwner);
    const selectedSource = profileSources.find(source => String(source._id) === selectedSourceId) || null;
    let rails = { series: [], movie: [], channel: [] };
    let catalogMeta = null;
    if (selectedSource) {
      for (const kind of ['series', 'movie', 'channel']) void ensureCatalogSnapshot(accountOwner, selectedSource, kind);
      const r = await getProviderCatalogRails(accountOwner, selectedSourceId, welcomeRailLimit).catch(() => null);
      if (r) rails = { series: r.series || [], movie: r.movie || [], channel: r.channel || [] };
      catalogMeta = await getProviderCatalogMeta(accountOwner, selectedSourceId).catch(() => null);
    }
    const railItems = list => (Array.isArray(list) ? list : [])
      .map(item => rokuDiscoveryItem(selectedSource
        ? selectedXtreamItem(selectedSource, { ...item, sourceId: selectedSourceId })
        : { ...item, sourceId: selectedSourceId }))
      .filter(Boolean)
      .slice(0, welcomeRailLimit);
    // Favorites store only id/title/kind - re-hydrate each one against the
    // catalog snapshot for its real logo/category, and fall back to the
    // selected source when the saved favorite has no sourceId (that snapshot
    // has one implicit provider). Without the sourceId, rokuDiscoveryItem
    // drops the item and the whole Favorites rail silently disappears.
    // A favorite without a provider identity is legacy/ambiguous and must not
    // leak its old title into whichever provider happens to be active now.
    const providerFavorites = favorites.filter(favorite => String(favorite.sourceId || '') === selectedSourceId);
    const favoriteSnapshot = new Map();
    if (selectedSourceId && providerFavorites.length) {
      for (const row of await getProviderCatalogItemsByIds(accountOwner, selectedSourceId, providerFavorites.map(favorite => favorite.id)).catch(() => [])) {
        favoriteSnapshot.set(`${row.kind}:${row.id}`, row);
      }
    }
    const hydratedFavorites = providerFavorites.map(favorite => {
      const match = favoriteSnapshot.get(`${favorite.kind}:${favorite.id}`);
      return rokuDiscoveryItem({
        ...favorite,
        sourceId: favorite.sourceId || match?.sourceId || selectedSourceId,
        logo: favorite.logo || match?.logo || '',
        category: (favorite.category && favorite.category !== 'Other' ? favorite.category : match?.category) || favorite.category || 'Other',
        extension: favorite.extension || match?.extension || 'mp4',
      });
    }).filter(Boolean).slice(0, 30);
    res.set('Cache-Control', 'no-store');
    res.json({
      items: [...series, ...movies],
      favorites: hydratedFavorites,
      // Keys ("<kind>:<id>") the account has saved into its Library for the
      // active provider - the Roku marks matching cards with a saved badge.
      savedKeys: Array.isArray(selectedSource?.enabledKeys) ? selectedSource.enabledKeys.map(String) : [],
      newReleases: {
        series: railItems(rails.series),
        movies: railItems(rails.movie),
        channels: railItems(rails.channel),
      },
      stats: {
        // Welcome counters come from the complete provider catalog snapshot
        // already stored in MongoDB, not the profile's saved/enabled subset.
        series: Math.max(0, Number(catalogMeta?.kinds?.series?.count) || 0),
        movies: Math.max(0, Number(catalogMeta?.kinds?.movie?.count) || 0),
        channels: Math.max(0, Number(catalogMeta?.kinds?.channel?.count) || 0),
        selectedSourceId,
        selectedSourceName: selectedSource?.name || '',
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
    for (const series of await getRokuSelectedItems('series', requestOwner(req), requestAccountOwner(req))) {
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
    if (!['series', 'movie', 'channel'].includes(kind) || !query) {
      console.warn(`[Roku search] rejected kind="${kind}" q="${query}" librarySource="${String(req.query.librarySource || '')}" - kind and q are required`);
      return res.status(400).json({ error: 'kind and q are required' });
    }
    if (String(req.query.librarySource || '') === 'server') {
      const source = await getRokuServerProvider(requestOwner(req), requestAccountOwner(req));
      if (!source) {
        console.warn(`[Roku search] kind=${kind} q="${query}" -> no server provider for owner`);
        return res.json({ items: [] });
      }
      // Search must cover the WHOLE stored snapshot, not a category-bounded
      // slice: getRokuServerCatalog(...,'all') truncates at 1500 items, which
      // silently hid almost everything in a 200k+ item movie catalog. Query
      // Mongo directly, independent of any category filter.
      const regexSource = arabicSearchRegexSource(query) || query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const result = await queryProviderCatalogItems(requestAccountOwner(req), String(source._id), kind, {
        categoryId: '', page: 1, limit: 60, extraFilters: [{ title: { $regex: regexSource, $options: 'i' } }],
      });
      console.log(`[Roku search] kind=${kind} q="${query}" source=${String(source._id).slice(0, 8)} matches=${result.total}`);
      const matches = result.items.map(item => selectedXtreamItem(source, item));
      const savedKeys = Array.isArray(source.enabledKeys) ? source.enabledKeys.map(String) : [];
      if (kind === 'series') {
        return res.json({ savedKeys, items: matches.map(item => ({
          id: `series-search:${item.sourceId}:${item.id}`, title: item.title, rokuTitle: rokuText(item.title),
          category: item.category, rokuCategory: rokuText(item.category), sourceId: String(item.sourceId), seriesId: item.id,
          thumbnail: item.logo, contentKind: 'series-search',
          originalFormat: String(item.extension || 'mp4').replace(/[^a-z0-9]/gi, '').toUpperCase(),
        })) });
      }
      if (kind === 'movie') {
        return res.json({ savedKeys, items: matches.map(item => ({ ...directXtreamItem(item), thumbnail: item.logo, duration: item.duration || '', kind: 'movie', contentKind: 'movie', rokuEnabled: true })) });
      }
      return res.json({ savedKeys, items: buildXtreamChannelsPayload(matches) });
    }
    const normalizedQuery = normalizeArabicSearch(query);
    const matches = (await getRokuSelectedItems(kind, requestOwner(req), requestAccountOwner(req)))
      .filter(item => normalizeArabicSearch(item.title).includes(normalizedQuery))
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
    if (kind === 'channel') return res.json({ items: buildXtreamChannelsPayload(matches) });
    const items = matches.map(item => ({
      ...directXtreamItem(item),
      thumbnail: item.logo,
      duration: item.duration || '',
      kind: 'movie', contentKind: 'movie', rokuEnabled: true,
    }));
    res.json({ items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Direct-to-Play must resolve against the active provider snapshot, not the
// profile's saved Library or whichever ten cards happen to be mounted on the
// Roku. This keeps catalog deep links valid for unsaved titles.
app.get('/api/roku/deep-link-item', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    // SceneGraph associative-array keys may be serialized lowercase when a
    // task enumerates them, so accept both spellings at this HTTP boundary.
    const mediaType = String(req.query.mediaType ?? req.query.mediatype ?? '').toLowerCase();
    const contentId = String(req.query.contentId ?? req.query.contentid ?? '').trim();
    if (!contentId) return res.status(400).json({ error: 'contentId is required' });
    let kind = '';
    if (['movie', 'shortform', 'shortformvideo', 'tvspecial'].includes(mediaType)) kind = 'movie';
    else if (['channel', 'live', 'livefeed', 'sportsevent'].includes(mediaType)) kind = 'channel';
    else if (['series', 'season'].includes(mediaType)) kind = 'series';
    else if (mediaType !== 'episode') return res.status(400).json({ error: 'Unsupported mediaType' });

    const source = await getRokuServerProvider(ownerId, accountOwner);
    if (!source) {
      console.warn(`[Roku deep link] mediaType=${mediaType} id=${contentId} no active provider`);
      return res.status(404).json({ error: 'No active provider' });
    }
    const sourceId = String(source._id);
    if (kind) {
      await ensureCatalogSnapshot(accountOwner, source, kind);
      const row = await getProviderCatalogItem(accountOwner, sourceId, kind, contentId);
      if (!row) {
        console.warn(`[Roku deep link] mediaType=${mediaType} id=${contentId} source=${sourceId.slice(0, 8)} not found`);
        return res.status(404).json({ error: 'Content not found' });
      }
      console.log(`[Roku deep link] resolved mediaType=${mediaType} id=${contentId} source=${sourceId.slice(0, 8)}`);
      return res.json({ items: [rokuDiscoveryItem(selectedXtreamItem(source, row))] });
    }

    // Episode feed IDs use "seriesId:episodeId". A plain episode ID can also
    // resolve from this profile's watch history for old integrations.
    let seriesId = '', episodeId = contentId;
    const separator = contentId.match(/^([^:|/]+)[:|/]([^:|/]+)$/);
    if (separator) [, seriesId, episodeId] = separator;
    if (!seriesId) {
      const watched = (await getStreamingHistory(requestProfileOwner(req)))
        .find(item => item.kind === 'series' && String(item.sourceId) === sourceId && String(item.itemId) === episodeId && item.seriesId);
      if (watched) seriesId = String(watched.seriesId);
    }
    if (!seriesId) return res.status(404).json({ error: 'Episode requires a series-qualified contentId' });
    await ensureCatalogSnapshot(accountOwner, source, 'series');
    const seriesRow = await getProviderCatalogItem(accountOwner, sourceId, 'series', seriesId);
    if (!seriesRow) return res.status(404).json({ error: 'Series not found' });
    const episodes = await buildXtreamSeriesPayload({
      selected: [selectedXtreamItem(source, seriesRow)], accountOwner, strict: true,
    });
    const episode = episodes.find(item => String(item.id) === episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    return res.json({ items: [episode] });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/roku/series/detail', async (req, res) => {
  try {
    const sourceId = String(req.query.sourceId || '');
    const seriesId = String(req.query.seriesId || '');
    if (!sourceId || !seriesId) return res.status(400).json({ error: 'sourceId and seriesId are required' });
    const ownerId = requestOwner(req);
    const accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    // Welcome includes recommendations and new releases that are intentionally
    // not required to be saved. Authorize against this profile's active
    // provider, not its saved-item list, then let Xtream resolve the series.
    const source = await getRokuServerProvider(ownerId, accountOwner);
    if (!source || String(source._id) !== sourceId) return res.status(404).json({ error: 'Series not found for the active provider' });
    const saved = (await getRokuSelectedItems('series', ownerId, accountOwner))
      .find(item => String(item.sourceId) === sourceId && String(item.id) === seriesId);
    const series = saved || {
      id: seriesId,
      sourceId,
      title: String(req.query.title || 'Series'),
      category: String(req.query.category || 'Other'),
    };
    res.set('Cache-Control', 'no-store');
    res.json({ items: await buildXtreamSeriesPayload({ selected: [series], accountOwner, strict: true }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Roku '*' on an episode row: mark it as the "last watched" episode for that
// series. Pressing '*' again on the same episode clears it (reverts to the
// automatically-detected one). This is what the episode list highlights
// yellow, and what Continue Watching shows instead of the natural pick.
app.get('/api/roku/series/last-watched', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const sourceId = String(req.query.sourceId || '');
    const seriesId = String(req.query.seriesId || '');
    if (!sourceId || !seriesId) return res.status(400).json({ error: 'sourceId and seriesId are required' });
    const override = await getSeriesWatchOverride(ownerId, sourceId, seriesId);
    // When there is no manual '*' override, use the most recently played
    // episode for this series. Keep the saved absolute position with it so
    // the Roku episode grid can show where playback will resume.
    const watchedHistory = await getStreamingHistory(requestProfileOwner(req));
    const episodeId = override?.episodeId || watchedHistory.find(item => item.kind === 'series'
      && String(item.sourceId || '') === sourceId
      && String(item.seriesId || '') === seriesId
      && String(item.itemId || '') !== '')?.itemId || '';
    const watched = watchedHistory.find(item => item.kind === 'series'
      && String(item.sourceId || '') === sourceId
      && String(item.seriesId || '') === seriesId
      && String(item.itemId || '') === String(episodeId));
    res.set('Cache-Control', 'no-store');
    res.json({
      episodeId,
      positionMs: Math.max(0, Number(watched?.endPositionMs) || 0),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/roku/series/last-watched/toggle', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const pick = key => req.body?.[key] ?? req.query?.[key] ?? '';
    const result = await toggleSeriesWatchOverride({
      ownerId,
      sourceId: pick('sourceId'), seriesId: pick('seriesId'), episodeId: pick('episodeId'),
      episodeTitle: pick('episodeTitle'), seasonNumber: pick('seasonNumber'), episodeNumber: pick('episodeNumber'),
    });
    const resume = result.active
      ? await getStreamingResume(requestProfileOwner(req), {
        sourceId: pick('sourceId'), itemId: pick('episodeId'), kind: 'series',
      })
      : null;
    res.json({ ...result, positionMs: Math.max(0, Number(resume?.endPositionMs) || 0) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

async function buildXtreamMoviesPayload({ limit, selected } = {}) {
  let movies = (selected || await getRokuSelectedItems('movie')).slice().sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
  if (Number.isFinite(limit) && limit > 0) movies = movies.slice(0, limit);
  const hydrated = movies.map(item => {
    const knownSeconds = durationSeconds(item.duration);
    if (knownSeconds > 0) return { ...item, duration: displayDuration(knownSeconds) };
    const cached = mediaDurationCache.get(`${item.sourceId}:movie:${item.id}`);
    if (cached?.expiresAt > Date.now() && cached.seconds > 0) return { ...item, duration: cached.duration };
    return { ...item, duration: '' };
  });
  return hydrated.map(item => ({
    ...directXtreamItem(item),
    duration: displayDuration(item.duration),
    durationSeconds: durationSeconds(item.duration),
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

// The account's stored roku source id can dangle after that source is deleted
// or replaced. Resolve to a source that actually exists, preferring the stored
// one, else the first available.
function pickRokuSourceId(preferredId, sources) {
  const wanted = String(preferredId || '');
  if (wanted && sources.some(source => String(source._id) === wanted)) return wanted;
  return String(sources[0]?._id || '');
}

// The full saved-key list for a source ("<kind>:<id>"), for the Roku's
// saved-badge marking.
function rokuSourceSavedKeys(source) {
  return Array.isArray(source?.enabledKeys) ? source.enabledKeys.map(String) : [];
}

async function getRokuServerProvider(ownerId, accountOwner = ownerId) {
  const sources = flattenSelection(await getAllXtreamSources(accountOwner), ownerId, accountOwner);
  const preferredId = await getRokuSourcePreferenceByOwner(ownerId);
  return sources.find(source => String(source._id) === pickRokuSourceId(preferredId, sources)) || null;
}

// The Roku "server" library source reads the SAME MongoDB provider snapshot the
// web app uses — never a live provider call. A missing snapshot is fetched once;
// a stale one serves immediately and refreshes in the background.
async function getRokuServerCatalog(ownerId, kind, requestedCategory, accountOwner = ownerId) {
  const source = await getRokuServerProvider(ownerId, accountOwner);
  if (!source) return { source: null, category: '', items: [] };
  await ensureCatalogSnapshot(accountOwner, source, kind);
  const categories = await getProviderCatalogCategories(accountOwner, String(source._id), kind).catch(() => []);
  const category = String(requestedCategory || categories[0]?.id || 'all');
  const categoryName = categories.find(entry => String(entry.id) === category)?.name || 'Other';
  const stored = await getProviderCatalogItemsForCategory(accountOwner, String(source._id), kind, category).catch(() => []);
  const items = stored
    .map(item => selectedXtreamItem(source, { ...item, category: item.category || categoryName }))
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' }));
  return { source, category, items };
}

// The "SAVED" filter on a Roku server-catalog page: only the items the account
// has saved into its Library (the active provider's enabledItems) for this
// kind, across every category. Same item shape as getRokuServerCatalog.
async function getRokuServerSavedItems(ownerId, kind, accountOwner = ownerId) {
  const source = await getRokuServerProvider(ownerId, accountOwner);
  if (!source) return { source: null, category: 'all', items: [] };
  const items = (Array.isArray(source.enabledItems) ? source.enabledItems : [])
    .filter(item => item && item.kind === kind)
    .map(item => selectedXtreamItem(source, item))
    .filter(item => item.id)
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' }));
  return { source, category: 'all', items };
}

app.get('/api/roku/provider/categories', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    const kind = ['series', 'movie', 'channel'].includes(String(req.query.kind)) ? String(req.query.kind) : '';
    if (!kind) return res.status(400).json({ error: 'kind must be series, movie, or channel' });
    const source = await getRokuServerProvider(ownerId, accountOwner);
    if (!source) return res.json({ sourceId: '', categories: [] });
    await ensureCatalogSnapshot(accountOwner, source, kind);
    const categories = (await getProviderCatalogCategories(accountOwner, String(source._id), kind).catch(() => []))
      .map(entry => ({ id: String(entry.id), name: cleanCategoryName(entry.name), rokuName: rokuText(cleanCategoryName(entry.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    res.set('Cache-Control', 'private, no-store');
    res.json({ sourceId: String(source._id), sourceName: source.name, categories });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/roku/movies', async (req, res) => {
  const startedAt = Date.now();
  try {
    if (String(req.query.librarySource || '') === 'server') {
      const catalog = String(req.query.saved || '') === '1'
        ? await getRokuServerSavedItems(requestOwner(req), 'movie', requestAccountOwner(req))
        : await getRokuServerCatalog(requestOwner(req), 'movie', req.query.category, requestAccountOwner(req));
      const items = await buildXtreamMoviesPayload({ selected: catalog.items });
      return res.json({ items, page: 0, total: items.length, hasMore: false, savedKeys: rokuSourceSavedKeys(catalog.source) });
    }
    const pageInfo = rokuPage(req, rokuMoviePageLimit);
    // Roku movie pages are deliberately fixed at ten items per request.
    pageInfo.limit = rokuMoviePageLimit;
    pageInfo.offset = pageInfo.page * pageInfo.limit;
    const selected = (await getRokuSelectedItems('movie', requestOwner(req), requestAccountOwner(req)))
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
    const ownerId = requestProfileOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    let items = await getStreamingHistory(ownerId);
    if (String(req.query.providerScope || '') === 'roku') {
      const accountOwner = requestAccountOwner(req);
      const sources = await getAllXtreamSources(accountOwner);
      const selectedSourceId = pickRokuSourceId(await getRokuSourcePreferenceByOwner(requestOwner(req)), sources);
      const selectedSource = sources.find(source => String(source._id) === selectedSourceId);
      items = items.filter(item => String(item.sourceId || '') === selectedSourceId)
        .map(item => ({ ...item, providerName: item.providerName || selectedSource?.name || '' }));
      items = await attachProviderUrls(items, sources);
    }
    res.json({ items });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/streaming-history/continue-watching', async (req, res) => {
  try {
    const ownerId = requestProfileOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const accountOwner = requestAccountOwner(req);
    let items = await getStreamingContinueWatching(ownerId);
    // Roku's Welcome page is both profile- and provider-specific. Other
    // clients retain their existing cross-provider history unless they opt in.
    if (String(req.query.providerScope || '') === 'roku') {
      const sources = await getAllXtreamSources(accountOwner);
      const selectedSourceId = pickRokuSourceId(await getRokuSourcePreferenceByOwner(requestOwner(req)), sources);
      const selectedSource = sources.find(source => String(source._id) === selectedSourceId);
      items = items.filter(item => String(item.sourceId || '') === selectedSourceId)
        .map(item => ({ ...item, providerName: item.providerName || selectedSource?.name || '' }));
      items = await attachProviderUrls(items, sources);
    }
    items = await hydrateContinueWatchingArtwork(accountOwner, items);
    res.set('Cache-Control', 'no-store');
    res.json({ items });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/streaming-history/resume', async (req, res) => {
  try {
    const ownerId = requestProfileOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    const item = await getStreamingResume(ownerId, req.query);
    res.json({ item });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/streaming-history/:sessionId', async (req, res) => {
  try {
    const ownerId = requestProfileOwner(req);
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

app.delete('/api/streaming-history/:sessionId', async (req, res) => {
  try {
    const ownerId = requestProfileOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    res.json(await deleteStreamingSession(ownerId, String(req.params.sessionId || '').trim()));
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/streaming-history', async (req, res) => {
  try {
    const ownerId = requestProfileOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    res.json(await clearStreamingHistory(ownerId));
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/favorites', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req), profileId = requestProfile(req);
    if (!ownerId || !profileId) return res.status(401).json({ error: 'Profile authentication required' });
    res.set('Cache-Control', 'no-store'); res.json({ items: await getFavorites(ownerId, profileId) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});
async function toggleFavoriteRequest(req, res) {
  try {
    const id = String(req.query?.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const ownerId = requestAccountOwner(req), profileOwner = requestOwner(req), profileId = requestProfile(req);
    if (!ownerId || !profileOwner || !profileId) return res.status(401).json({ error: 'Profile authentication required' });
    const pick = key => req.query?.[key] || req.body?.[key] || '';
    const kind = String(pick('kind'));
    if (!['series', 'movie', 'channel'].includes(kind)) return res.status(400).json({ error: 'Valid item kind is required' });
    const sources = await getAllXtreamSources(ownerId);
    let sourceId = String(pick('sourceId')).trim();
    if (!sourceId) sourceId = pickRokuSourceId(await getRokuSourcePreferenceByOwner(profileOwner), sources);
    if (!sourceId || !sources.some(source => String(source._id) === sourceId)) {
      return res.status(400).json({ error: 'Favorite provider is required' });
    }
    const favoriteValue = pick('favorite');
    const favorite = favoriteValue === true || String(favoriteValue).toLowerCase() === 'true'
      ? true
      : favoriteValue === false || String(favoriteValue).toLowerCase() === 'false' ? false : undefined;
    res.json(await toggleFavorite({
      ownerId, profileId, id,
      title: pick('title'), kind, sourceId, logo: pick('logo'),
      category: pick('category'), extension: pick('extension'), favorite,
    }));
  } catch (error) { res.status(500).json({ error: error.message }); }
}
app.post('/api/favorites/toggle', toggleFavoriteRequest);
app.put('/api/favorites/toggle', toggleFavoriteRequest);
app.get('/api/favorites/toggle', toggleFavoriteRequest);

// Add / remove one catalog item from the account's saved Library selection
// (the source's enabledKeys/enabledItems) straight from the Roku player. This
// is the same "saved to my Library" state the web app manages, keyed per
// source as "<kind>:<id>".
async function toggleRokuLibraryRequest(req, res) {
  try {
    const ownerId = requestOwner(req);
    const accountOwner = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const pick = key => String(req.query?.[key] || req.body?.[key] || '').trim();
    const id = pick('id');
    let kind = pick('kind');
    if (kind === 'series-search' || kind === 'episode') kind = 'series';
    if (!id || !['movie', 'series', 'channel'].includes(kind)) {
      return res.status(400).json({ error: 'id and a valid kind are required' });
    }
    const sources = flattenSelection(await getAllXtreamSources(accountOwner), ownerId, accountOwner);
    let sourceId = pick('sourceId');
    if (!sourceId || !sources.some(source => String(source._id) === sourceId)) {
      sourceId = pickRokuSourceId(await getRokuSourcePreferenceByOwner(ownerId), sources);
    }
    const source = sources.find(candidate => String(candidate._id) === sourceId);
    if (!source) return res.status(404).json({ error: 'No playlist provider for this account' });
    const key = `${kind}:${id}`;
    const enabledKeys = Array.isArray(source.enabledKeys) ? source.enabledKeys.map(String) : [];
    const enabledItems = Array.isArray(source.enabledItems) ? source.enabledItems : [];
    const currentlySaved = enabledKeys.includes(key);
    let nextKeys;
    let nextItems;
    if (currentlySaved) {
      nextKeys = enabledKeys.filter(candidate => candidate !== key);
      nextItems = enabledItems.filter(candidate => candidate.key !== key);
    } else {
      // Resolve the item's real metadata from the stored catalog snapshot -
      // NEVER trust the client's title, which the Roku has already reshaped to
      // Arabic presentation-form glyphs (that would corrupt the web display).
      let snapshotRow = null;
      try {
        void await ensureCatalogSnapshot(accountOwner, source, kind);
        const rows = await getProviderCatalogItemsByIds(accountOwner, String(source._id), [id]);
        snapshotRow = (Array.isArray(rows) ? rows : []).find(row => String(row.id) === id && row.kind === kind) || null;
      } catch { snapshotRow = null; }
      const category = snapshotRow?.category || pick('category') || 'Other';
      const title = snapshotRow?.title || (pick('title') && !/[ﭐ-﷿ﹰ-﻿]/.test(pick('title')) ? pick('title') : `${kind} ${id}`);
      nextItems = [...enabledItems.filter(candidate => candidate.key !== key), {
        key, id, kind,
        title,
        logo: snapshotRow?.logo || pick('logo'),
        categoryId: snapshotRow?.categoryId || pick('categoryId'),
        category,
        language: snapshotRow?.language || detectXtreamLanguage({ title }, category),
        extension: snapshotRow?.extension || pick('extension') || (kind === 'channel' ? 'm3u8' : 'mp4'),
        duration: snapshotRow?.duration || pick('duration'),
        added: String(Math.floor(Date.now() / 1000)),
        providerUrl: kind === 'series' ? '' : await sourceProviderUrl(
          source, kind, id, snapshotRow?.extension || pick('extension') || (kind === 'channel' ? 'm3u8' : 'mp4'),
        ),
      }];
      nextKeys = nextItems.map(candidate => candidate.key);
    }
    await updateXtreamSelection(String(source._id), { enabledKeys: nextKeys, enabledItems: nextItems, archivedKeys: source.archivedKeys || [], archivedItems: source.archivedItems || [] }, accountOwner, ownerId);
    bumpLibraryRevision(ownerId);
    res.json({ saved: !currentlySaved, key, sourceId: String(source._id) });
  } catch (error) { res.status(500).json({ error: error.message }); }
}
app.get('/api/roku/library/toggle', toggleRokuLibraryRequest);
app.post('/api/roku/library/toggle', toggleRokuLibraryRequest);

// The saved-key list for the profile's active Roku provider, so cards can show
// a "saved" badge. Lightweight - keys only, no catalog expansion.
app.get('/api/roku/library/keys', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    const accountOwner = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const sources = flattenSelection(await getAllXtreamSources(accountOwner), ownerId, accountOwner);
    const sourceId = pickRokuSourceId(await getRokuSourcePreferenceByOwner(ownerId), sources);
    const source = sources.find(candidate => String(candidate._id) === sourceId);
    res.set('Cache-Control', 'no-store');
    res.json({ sourceId, keys: Array.isArray(source?.enabledKeys) ? source.enabledKeys.map(String) : [] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
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
    res.json({ locations: await getDeviceWeatherLocations(ownerId, requestAccount(req), requestDevice(req), requestAccountRealm(req)) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/account/weather-locations', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Sign in to manage weather locations' });
    const result = await saveDeviceWeatherLocations(ownerId, req.body?.locations, requestAccount(req), requestDevice(req), requestAccountRealm(req));
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
    const savedLocations = await getDeviceWeatherLocations(ownerId, requestAccount(req), requestDevice(req), requestAccountRealm(req));
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
  let type = body?.type === 'm3u' ? 'm3u' : body?.type === 'xtream' ? 'xtream' : sourceType(existing);
  const supplied = String(body?.url || '').trim();
  const suppliedName = String(body?.name || existing?.name || '').trim();
  if (!supplied && existing) {
    if (!suppliedName) throw new Error('Source name is required');
    return { name: suppliedName };
  }
  if (!supplied) throw new Error(`Paste the ${type === 'm3u' ? 'M3U playlist' : 'Xtream server'} URL`);
  let url;
  try { url = new URL(supplied); } catch { throw new Error('Enter a valid playlist URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Playlist URL must use HTTP or HTTPS');
  const name = suppliedName || url.hostname || (type === 'm3u' ? 'M3U Playlist' : 'Xtream Playlist');
  // Many providers label their Xtream get.php URL as an M3U link. Downloading
  // that generated file can take minutes for a large catalog and made Add
  // Source fail even though the account API was healthy. Detect the embedded
  // Xtream credentials and use player_api.php instead.
  if (type === 'm3u' && /\/(?:get|player_api)\.php\/?$/i.test(url.pathname)
    && url.searchParams.get('username') && url.searchParams.get('password')) type = 'xtream';
  if (type === 'm3u') return { name, type, baseUrl: url.toString(), username: '', password: '' };
  const username = String(body?.username || url.searchParams.get('username') || existing?.username || '').trim();
  const password = String(body?.password || url.searchParams.get('password') || existing?.password || '').trim();
  if (!username || !password) throw new Error('Xtream username and password are required');
  const pathname = url.pathname.replace(/\/(?:get|player_api)\.php\/?$/i, '').replace(/\/$/, '');
  return { name, type, baseUrl: `${url.protocol}//${url.host}${pathname}`, username, password };
}

app.get('/api/xtream/sources', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    res.json({ items: (await getAllXtreamSources(accountOwner)).map(source => publicXtreamSource(source, ownerId, accountOwner)) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

async function buildAndroidRecentSnapshot(ownerId, accountOwner = ownerId) {
  // Sources saved while their provider was unreachable must not turn a
  // background refresh into a minute-long chain of connection timeouts.
  const sources = (await getAllXtreamSources(accountOwner)).filter(source => source.connectionStatus !== 'offline');
  const recent = { series: [], movie: [], channel: [] };
  const counts = { series: 0, movie: 0, channel: 0 };
  for (const source of sources) {
    for (const kind of ['series', 'movie', 'channel']) {
      let catalog;
      try {
        catalog = await withCatalogMemorySlot(() => getSourceCatalog(source, kind), 'background');
      }
      catch (error) {
        console.warn(`[AndroidStartup] source-refresh-skipped source=${source._id} kind=${kind} error=${error.message}`);
        catalog = [];
      }
      counts[kind] += Array.isArray(catalog) ? catalog.length : 0;
      for (const item of catalog) {
        const candidate = {
          id: item.id, key: item.key, kind, title: item.title,
          categoryId: item.categoryId, logo: item.logo, rating: item.rating,
          duration: item.duration, extension: item.extension,
          added: item.added, sourceId: String(source._id), providerName: source.name,
        };
        const group = recent[kind];
        // Keep one provider-independent stream. The catalog's arrival order
        // is authoritative: first item encountered is first item shown.
        if (group.length < 10) group.push(candidate);
      }
    }
  }
  await saveAndroidStartupSnapshot(ownerId, { recent, catalogCounts: counts });
  return { counts, recent };
}

function refreshAndroidRecentSnapshot(ownerId, accountOwner = ownerId) {
  const key = String(ownerId);
  if (androidRecentRefreshes.has(key)) return androidRecentRefreshes.get(key);
  const pending = buildAndroidRecentSnapshot(ownerId, accountOwner)
    .finally(() => androidRecentRefreshes.delete(key));
  androidRecentRefreshes.set(key, pending);
  return pending;
}

function scheduleAndroidStartupRefresh(ownerId, language, accountOwner = ownerId) {
  const key = `${ownerId}`;
  if (androidStartupRefreshes.has(key)) return;
  const pending = (async () => {
    await refreshAndroidRecentSnapshot(ownerId, accountOwner);
  })().catch(error => console.warn(`[AndroidStartup] background-refresh-failed owner=${ownerId} error=${error.message}`))
    .finally(() => androidStartupRefreshes.delete(key));
  androidStartupRefreshes.set(key, pending);
}

// A full provider catalog can be hundreds of thousands of rows.  It is not a
// safe background operation on the small Fly machine and it is not required
// for opening Android: the app already receives its saved library counts,
// latest snapshot, and saved AI rail from MongoDB.  An administrator can opt
// in to provider refreshes on a larger server with this environment variable.
const androidProviderRefreshEnabled = process.env.ANDROID_PROVIDER_REFRESH === 'true';

function androidSavedCounts(sources) {
  const counts = { series: 0, movie: 0, channel: 0 };
  for (const source of sources) {
    for (const item of Array.isArray(source.enabledItems) ? source.enabledItems : []) {
      const kind = ['series', 'movie', 'channel'].includes(item.kind) ? item.kind : null;
      if (kind) counts[kind] += 1;
    }
  }
  return counts;
}

// Fast mobile startup payload sourced only from MongoDB. Provider catalogs and
// Gemini are refreshed after the response and never block Android navigation.
app.get('/api/android/bootstrap', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const authorization = resolveDeviceToken(String(req.get('x-device-token') || ''));
    const language = ['arabic', 'english', 'both'].includes(String(req.query.language)) ? String(req.query.language) : 'both';
    const [sources, snapshot, devices] = await Promise.all([
      getAllXtreamSources(accountOwner),
      getAndroidStartupSnapshot(ownerId),
      authorization?.accountId ? getLinkedDevices(authorization.accountId, authorization.profileId || '') : Promise.resolve([]),
    ]);
    const selectedSources = flattenSelection(sources, ownerId, accountOwner);
    const selectedSourceId = pickRokuSourceId(await getRokuSourcePreferenceByOwner(ownerId), sources);
    const selectedSource = sources.find(source => String(source._id) === selectedSourceId);
    const providerItems = items => (Array.isArray(items) ? items : [])
      .filter(item => String(item?.sourceId || '') === selectedSourceId)
      .map(item => ({ ...item, providerName: item.providerName || selectedSource?.name || '' }));
    const recent = snapshot?.recent || { series: [], movie: [], channel: [] };
    const counts = androidSavedCounts(selectedSources);
    res.set('Cache-Control', 'no-store');
    res.json({
      counts,
      recent: { series: providerItems(recent.series), movie: providerItems(recent.movie), channel: providerItems(recent.channel) },
      devices,
      sources: selectedSources.map(source => publicXtreamSource(source, ownerId, accountOwner)),
      snapshotUpdatedAt: snapshot?.updatedAt || null,
      recentRefreshAvailable: androidProviderRefreshEnabled,
    });
    const snapshotAge = snapshot?.updatedAt ? Date.now() - new Date(snapshot.updatedAt).getTime() : Number.POSITIVE_INFINITY;
    if (androidProviderRefreshEnabled && snapshotAge > 15 * 60 * 1000) {
      scheduleAndroidStartupRefresh(ownerId, language, accountOwner);
    }
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

/* AI recommendations removed. Endpoint intentionally returns 404. */
app.post('/api/recommendations/ai', (req, res) => res.sendStatus(404));
/*
app.post('/api/recommendations/ai', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    const allSources = await getAllXtreamSources(accountOwner);
    const selectedSourceId = pickRokuSourceId(await getRokuSourcePreferenceByOwner(ownerId), allSources);
    const scopedSources = flattenSelection(allSources, ownerId, accountOwner)
      .filter(source => String(req.body?.providerScope || '') !== 'roku' || String(source._id) === selectedSourceId);
    const payload = await getAiRecommendations({
      ownerId,
      language: req.body?.language,
      forceRefresh: req.body?.refresh === true,
      getSources: async () => scopedSources,
      getCatalog: getSourceCatalog,
      getCategories: getSourceCategories,
    });
    if (String(req.body?.providerScope || '') === 'roku') {
      payload.items = (payload.items || []).filter(item => String(item.sourceId || '') === selectedSourceId)
        .map(item => ({ ...item, providerName: item.providerName || allSources.find(source => String(source._id) === selectedSourceId)?.name || '' }));
    }
    res.set('Cache-Control', 'private, no-store');
    res.json(payload);
    // The Welcome page's own backdrop poll (per playlist provider) drives the
    // build now - no need to also kick an unscoped "all providers" one here
    // that the client never requests and that would just steal the build slot.
  } catch (error) {
    console.error(`[AIRecommendations] endpoint-failed status=${Number(error?.status) || 500}`);
    res.status(Number(error?.status) || 500).json({ error: 'Recommendations are temporarily unavailable' });
  }
});
*/

// The RH browser home screen polls this after its recommendations load, then
// plays the montage once when `ready` flips true. Building happens in the
// background off the AI-recommendation items; see recommendation-backdrop.js.
/*
app.get('/api/recommendations/ai/backdrop', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    const accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    const sources = await getAllXtreamSources(accountOwner);
    const status = await getRecommendationBackdrop(accountOwner, String(req.query.sourceId || ''), sources, { providerBusy: providerStreamBusy, acquireLease: sourceId => acquireProviderStreamLease(sourceId, 1) });
    res.set('Cache-Control', 'no-store');
    res.json(status);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
*/

// Ops dashboard: every playlist source across every account, loopback-only
// like the other /internal routes - no per-account sign-in needed to see who
// added what.
app.get('/internal/playlists', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const [sources, accountsList, catalogMeta] = await Promise.all([
      getAllXtreamSources(), listAllAccountsBasic(), listProviderCatalogMeta(),
    ]);
    const emailByOwner = new Map(accountsList.map(account => [account.ownerId, account.email]));
    const profilesByOwner = new Map(await Promise.all(accountsList.map(async account => {
      const profiles = await getAccountProfiles(account.accountId);
      return [account.ownerId, profiles.map(profile => ({
        id: profile.id,
        name: profile.name,
        code: profile.code || '',
        ownerId: profile.isDefault ? account.ownerId : profileOwnerId(account.accountId, profile.id),
        isDefault: profile.isDefault === true,
        hasPin: profile.hasPin === true,
      }))];
    })));
    const catalogBySource = new Map(catalogMeta.map(meta => [`${meta.ownerId}:${meta.sourceId}`, meta]));
    const kindLabels = { series: 'Series', movie: 'Movies', channel: 'Live' };
    const kindOrder = ['series', 'movie', 'channel'];
    // This dashboard endpoint is deliberately passive: it reads stored account,
    // catalog, and connection state and never authenticates against a provider.
    const rows = await Promise.all(sources.map(async source => {
      const meta = catalogBySource.get(`${source.ownerId}:${source._id}`);
      const kind = kindOrder
        .filter(value => Number(meta?.kinds?.[value]?.count) > 0)
        .map(value => kindLabels[value])
        .join(', ');
      const signedIn = source.connectionStatus === 'online' ? true : (source.connectionStatus === 'offline' ? false : null);
      const catalogItems = ['series', 'movie', 'channel'].reduce((n, k) => n + (Number(meta?.kinds?.[k]?.count) || 0), 0);
      const catalogSyncedAt = meta?.updatedAt ? new Date(meta.updatedAt).toISOString() : null;
      return {
        id: String(source._id),
        username: emailByOwner.get(String(source.ownerId || '')) || 'Unknown user',
        profiles: profilesByOwner.get(String(source.ownerId || '')) || [],
        providerUsername: source.username || '',
        name: source.name || 'Playlist',
        type: source.type || 'xtream',
        kind,
        signedIn,
        signInError: source.lastConnectionError || '',
        catalogItems,
        catalogSyncedAt,
        endpoint: source.baseUrl || '',
        connectionStatus: source.connectionStatus || 'unknown',
      };
    })).then(rows => rows.sort((a, b) => a.username.localeCompare(b.username) || a.name.localeCompare(b.name)));
    res.set('Cache-Control', 'no-store');
    res.json({ playlists: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Credential-free catalog viewer for the loopback-only operations dashboard.
// These routes deliberately resolve the source's stored owner server-side;
// the browser receives no RH account token and off-host callers get 404.
app.get('/internal/catalog-snapshot', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const [sources, accountsList] = await Promise.all([getAllXtreamSources(), listAllAccountsBasic()]);
    const emailByOwner = new Map(accountsList.map(account => [account.ownerId, account.email]));
    const rows = await Promise.all(sources.map(async source => {
      const ownerId = String(source.ownerId || '');
      const meta = await getProviderCatalogMeta(ownerId, String(source._id)).catch(() => null);
      return {
        sourceId: String(source._id),
        name: source.name || 'Playlist',
        account: emailByOwner.get(ownerId) || 'Local account',
        connectionStatus: source.connectionStatus || 'unknown',
        counts: {
          series: Number(meta?.kinds?.series?.count) || 0,
          movie: Number(meta?.kinds?.movie?.count) || 0,
          channel: Number(meta?.kinds?.channel?.count) || 0,
        },
        syncedAt: meta?.updatedAt || null,
        downloading: ['series', 'movie', 'channel'].some(kind => catalogSnapshotJobs.has(`${ownerId}:${source._id}:${kind}`)),
      };
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ sources: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/internal/catalog-snapshot/items', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const kind = { series: 'series', movie: 'movie', movies: 'movie', vod: 'movie', channel: 'channel', channels: 'channel', live: 'channel' }[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be series, movie, or channel' });
    const source = await getXtreamSource(String(req.query.sourceId || ''));
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const result = await queryProviderCatalogItems(
      String(source.ownerId), String(source._id), kind,
      { q: String(req.query.q || ''), page: Number.parseInt(req.query.page, 10) || 1, limit: Number.parseInt(req.query.limit, 10) || 50 },
    );
    result.items = (result.items || []).map(item => ({ ...item, providerUrl: sourceProviderUrl(source, kind, item.id, item.extension) }));
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/internal/catalog-snapshot/episodes', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const seriesId = String(req.query.seriesId || '');
    if (!seriesId) return res.status(400).json({ error: 'seriesId is required' });
    const source = await getXtreamSource(String(req.query.sourceId || ''));
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const details = await getIndexedXtreamSeriesEpisodes(source, seriesId);
    const items = (details.episodes || []).map(episode => {
      const extension = String(episode.extension || '').toLowerCase();
      return {
        id: episode.id,
        title: episode.title || `${details.title} - ${episode.episodeNumber}`,
        category: episode.seasonTitle || (episode.seasonNumber != null ? `Season ${episode.seasonNumber}` : ''),
        extension,
        providerUrl: sourceProviderUrl(source, 'series', episode.id, extension),
      };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ seriesTitle: details.title, items, total: items.length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/internal/catalog-snapshot/download', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const source = await getXtreamSource(String(req.body?.sourceId || ''));
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const ownerId = String(source.ownerId || '');
    for (const kind of ['series', 'movie', 'channel']) refreshCatalogSnapshot(ownerId, source, kind);
    res.json({ ok: true, started: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Ops dashboard: "log in again" to a set of provider rows - one row (an RH
// account's source), a whole credential line, or every line under a provider.
// Authenticates once per real credential (baseUrl+username) so a max_conns:1
// panel is not hit twice in parallel, then persists the result to every source
// that shares it and drops the cached provider lists. Loopback-only.
app.post('/internal/source-retry', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const ids = [...new Set((Array.isArray(req.body?.sourceIds) ? req.body.sourceIds
      : req.body?.sourceId ? [req.body.sourceId] : []).map(String).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'sourceId(s) required' });
    const targets = (await getAllXtreamSources()).filter(source => ids.includes(String(source._id)));
    if (!targets.length) return res.sendStatus(404);
    const byCredential = new Map();
    for (const source of targets) {
      const key = `${sourceType(source)}\u0000${source.baseUrl || ''}\u0000${source.username || ''}`;
      (byCredential.get(key) || byCredential.set(key, []).get(key)).push(source);
    }
    const results = [];
    for (const group of byCredential.values()) {
      let ok = true;
      let message = '';
      try {
        if (sourceType(group[0]) === 'm3u') await validateM3uConnection({ ...group[0] }, { attempts: 1, timeoutMs: 12_000 });
        else await validateXtreamConnection({ ...group[0] }, { attempts: 1, timeoutMs: 12_000 });
      } catch (error) {
        ok = false;
        message = String(error?.message || 'Playlist provider is unavailable').slice(0, 240);
      }
      for (const source of group) {
        await updateXtreamSource(String(source._id), ok
          ? { connectionStatus: 'online', connectionMessage: '' }
          : { connectionStatus: 'offline', connectionMessage: message }).catch(() => {});
        if (ok && sourceType(source) === 'm3u') {
          await refreshCatalogSnapshot(source.ownerId, source, 'channel').catch(error => {
            console.warn(`[Playlist] retry catalog refresh failed source=${source._id}: ${error.message}`);
          });
        }
        results.push({ id: String(source._id), ok, status: ok ? 'online' : 'offline', error: message });
      }
    }
    playlistHealthCache.clear();
    evictXtreamCache(Date.now(), true);
    evictM3uCache(Date.now(), true);
    res.set('Cache-Control', 'no-store');
    const online = results.filter(result => result.ok).length;
    res.json({ ok: online === results.length, online, total: results.length, results });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Ops dashboard preview: every built backdrop + the items it was spliced
// from, loopback-only like the other /internal routes.
app.get('/internal/backdrops', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try { res.set('Cache-Control', 'no-store'); res.json({ backdrops: await listBackdrops() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/internal/backdrop.mp4', async (req, res) => {
  if (!localRequest(req)) return res.sendStatus(404);
  try {
    const file = backdropVideoFile(String(req.query.owner || ''), String(req.query.h || ''));
    if (!file) return res.sendStatus(404);
    await fs.access(file);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(file);
  } catch { res.sendStatus(404); }
});

/*
app.get('/api/recommendations/ai/backdrop.mp4', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.sendStatus(401);
    const file = backdropVideoFile(ownerId, String(req.query.h || ''));
    if (!file) return res.sendStatus(404);
    await fs.access(file);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(file);
  } catch { res.sendStatus(404); }
});
*/

// Prepares the Welcome-page backdrop ahead of a login, off the playlist
// catalog each account already has synced - not off a live AI-recommendation
// call. getRecommendationBackdrop already no-ops once a matching build
// exists, so a periodic sweep only ever spends provider time on an account
// whose newest Series/Movies changed since its last build.
async function sweepBackdrops() {
  const sources = await getAllXtreamSources().catch(() => []);
  const byOwner = new Map();
  for (const source of sources) {
    const ownerId = String(source.ownerId || '');
    if (!ownerId) continue;
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, []);
    byOwner.get(ownerId).push(source);
  }
  for (const [ownerId, ownerSources] of byOwner) {
    // Warm one backdrop per provider (that is what the Welcome page shows now).
    for (const source of ownerSources) {
      await getRecommendationBackdrop(ownerId, String(source._id), ownerSources, { providerBusy: providerStreamBusy, acquireLease: sourceId => acquireProviderStreamLease(sourceId, 1) }).catch(() => {});
    }
  }
}
// AI recommendation backdrop generation removed.

// Periodic Android work must never download whole provider catalogs.  Return
// the same persisted snapshot used by bootstrap.  This keeps notifications
// useful without making a background worker exhaust the Fly VM.
app.get('/api/xtream/catalog-counts', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    if (androidProviderRefreshEnabled && req.query.refresh === 'true') {
      return res.json(await refreshAndroidRecentSnapshot(ownerId, accountOwner));
    }
    const [snapshot, sources] = await Promise.all([
      getAndroidStartupSnapshot(ownerId),
      getAllXtreamSources(accountOwner),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      counts: androidSavedCounts(flattenSelection(sources, ownerId, accountOwner)),
      recent: snapshot?.recent || { series: [], movie: [], channel: [] },
      snapshotUpdatedAt: snapshot?.updatedAt || null,
    });
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
    const prepareRokuLogoTarget = value => {
      if (req.query.roku !== '1') return value;
      const hostname = value.hostname.toLowerCase();
      if (hostname === 'www.themoviedb.org' || hostname === 'themoviedb.org') value.hostname = 'image.tmdb.org';
      if (value.hostname.toLowerCase() === 'image.tmdb.org') {
        value.pathname = value.pathname.replace(/^\/t\/p\/[^/]+\//, '/t/p/w342/');
      }
      if (/^i\d+\.wp\.com$/i.test(value.hostname)) value.searchParams.set('fit', '342,513');
      return value;
    };
    // Roku cards are roughly 160x240 at a 1280x720 UI resolution. Avoid
    // forwarding multi-megapixel TMDB originals to the device; TMDB provides
    // an image-size path specifically for this purpose. Keep the default proxy
    // behavior unchanged for the Library web frontend.
    target = prepareRokuLogoTarget(target);
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
      target = prepareRokuLogoTarget(new URL(location, target));
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

function validateSavedPlaylistSource(source, sourceId, ownerId) {
  setImmediate(async () => {
    try {
      const candidate = { ...source, _id: sourceId };
      if (source.type === 'm3u') await validateM3uConnection(candidate, { attempts: 3, timeoutMs: 12_000 });
      else await validateXtreamConnection(candidate, { attempts: 1, timeoutMs: 8_000 });
      await updateXtreamSource(sourceId, { connectionStatus: 'online', connectionMessage: '' }, ownerId);
      // The initial catalog request shares the validation download and fails
      // with it. Rebuild the M3U snapshot after a retry succeeds so Live TV
      // appears without making the user add the playlist again.
      if (source.type === 'm3u') {
        await refreshCatalogSnapshot(ownerId, candidate, 'channel').catch(error => {
          console.warn(`[Playlist] post-validation catalog refresh failed source=${sourceId}: ${error.message}`);
        });
      }
    } catch (error) {
      const connectionMessage = String(error?.message || error || 'Playlist provider is unavailable').slice(0, 240);
      await updateXtreamSource(sourceId, { connectionStatus: 'offline', connectionMessage }, ownerId).catch(() => {});
      console.warn(`[Playlist] background validation failed source=${sourceId}: ${connectionMessage}`);
    } finally {
      playlistHealthCache.delete(ownerId);
    }
  });
}

app.post('/api/xtream/sources', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const source = parsePlaylistInput(req.body);
    const saved = await createXtreamSource({
      ...source, ownerId, connectionStatus: 'checking', connectionMessage: 'Checking provider connection in the background.',
    });
    if (req.body?.selectForRoku === true || req.body?.selectforroku === true) {
      const accountId = requestAccount(req);
      if (accountId) await setProfileRokuSourcePreference(accountId, requestProfile(req), saved.id);
    }
    playlistHealthCache.delete(ownerId);
    res.status(202).json({
      ...saved,
      warning: 'Playlist saved. Provider connection and catalog download are running in the background.',
      catalogDownloadStarted: true,
    });
    validateSavedPlaylistSource(source, saved.id, ownerId);
    // Seed MongoDB immediately after the source is created. Catalog reads are
    // snapshot-only, so this makes the new playlist available without waiting
    // for a user to open each rail/category first. Jobs are deduplicated per
    // account/source/kind and failures retain the normal connection status.
    for (const kind of ['series', 'movie', 'channel']) void refreshCatalogSnapshot(ownerId, { ...source, _id: saved.id }, kind);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    const existing = await getXtreamSource(req.params.id, ownerId);
    if (!existing) return res.sendStatus(404);
    const changes = parsePlaylistInput(req.body, existing);
    // A URL/credential change is verified in the background, exactly like Add
    // Source. The edit is never rejected because the provider is briefly
    // unreachable or slow - only genuinely invalid input (handled above) fails.
    if (changes.baseUrl) {
      changes.connectionStatus = 'checking';
      changes.connectionMessage = 'Checking provider connection in the background.';
    }
    const saved = await updateXtreamSource(req.params.id, changes, ownerId);
    playlistHealthCache.delete(ownerId);
    res.json(saved);
    if (changes.baseUrl) validateSavedPlaylistSource({ ...existing, ...changes }, req.params.id, ownerId);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/xtream/sources/:id', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!await deleteXtreamSource(req.params.id, ownerId)) return res.sendStatus(404);
    playlistHealthCache.delete(ownerId);
    await deleteProviderCatalog(ownerId, String(req.params.id)).catch(() => {});
    bumpLibraryRevision(ownerId);
    res.sendStatus(204);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function checkDiagnosticStep(task) {
  const startedAt = Date.now();
  try { const result = await task(); return { ok: true, ms: Date.now() - startedAt, result }; }
  catch (error) { return { ok: false, ms: Date.now() - startedAt, error: String(error.message || error).slice(0, 200) }; }
}

// The category API can answer 200 while the provider's CDN blocks the actual
// /movie/ and /series/ stream paths (Cloudflare WAF, account flagged for VOD,
// live-only line, ...). "Connected" must mean a real stream opens, so the
// series/movie diagnostic also range-probes one playable URL.
async function probeXtreamStream(source, kind) {
  let id = '';
  let extension = 'mp4';
  const enabled = (Array.isArray(source.enabledItems) ? source.enabledItems : []).find(item => item.kind === kind);
  if (enabled) { id = String(enabled.id); extension = String(enabled.extension || (kind === 'movie' ? 'mkv' : 'mp4')); }
  if (!id) {
    const catalog = await withCatalogMemorySlot(() => getSourceCatalog(source, kind), 'interactive');
    const first = Array.isArray(catalog) ? catalog[0] : null;
    if (!first) throw new Error('Provider returned no ' + kind + ' items to test');
    id = String(first.id);
    extension = String(first.extension || (kind === 'movie' ? 'mkv' : 'mp4'));
  }
  if (kind === 'series') {
    const info = await getIndexedXtreamSeriesEpisodes(source, id).catch(() => ({ episodes: [] }));
    const episode = Array.isArray(info?.episodes) ? info.episodes[0] : null;
    if (!episode) throw new Error('No episodes returned for the sample series');
    id = String(episode.id);
    extension = String(episode.extension || extension);
  }
  const url = xtreamProviderUrl(source, kind, id, extension);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  // Follow redirects by hand so a blocked/403 CDN hop is reported clearly
  // rather than surfacing as a bare "fetch failed".
  let target = url;
  try {
    for (let hop = 0; hop < 4; hop += 1) {
      let response;
      try {
        response = await fetch(target, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Range: 'bytes=0-0', 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' },
        });
      } catch (error) {
        throw new Error(`Playback stream unreachable from the server (${String(error.cause?.code || error.message || 'connection failed')})`);
      }
      await response.body?.cancel().catch(() => {});
      if (response.status === 200 || response.status === 206) return;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Provider redirect with no target (HTTP ${response.status})`);
        target = new URL(location, target).toString();
        continue;
      }
      throw new Error(`Provider returned HTTP ${response.status} for playback — catalog works, streaming is blocked`);
    }
    throw new Error('Provider redirected too many times for playback');
  } finally { clearTimeout(timer); }
}

// Per-provider step breakdown for the operations dashboard: a single overall
// "online/offline" dot hides which stage actually failed (bad credentials vs.
// a provider that authenticates but has a broken VOD catalog, say). Category
// endpoints are used as the series/movie/channel probes instead of the full
// item lists — small and fast regardless of how large the provider's catalog
// is, so this stays safe to run interactively.
app.get('/api/xtream/sources/:id/diagnostics', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(req.params.id, ownerId);
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const isM3u = sourceType(source) === 'm3u';
    const auth = await checkDiagnosticStep(() => (isM3u ? validateM3uConnection : validateXtreamConnection)(source, { timeoutMs: 15_000 }));
    const skipped = { ok: false, skipped: true };
    const notApplicable = { ok: true, na: true };
    // series/movie: the catalog listing AND a real stream must both work.
    const vodStep = async kind => {
      const listing = await checkDiagnosticStep(() => getSourceCategories(source, kind));
      if (!listing.ok) return listing;
      const stream = await checkDiagnosticStep(() => probeXtreamStream(source, kind));
      return stream.ok
        ? { ok: true, ms: listing.ms + stream.ms }
        : { ok: false, ms: listing.ms + stream.ms, error: stream.error };
    };
    const [series, movie, channel] = await Promise.all([
      isM3u ? notApplicable : (auth.ok ? vodStep('series') : skipped),
      isM3u ? notApplicable : (auth.ok ? vodStep('movie') : skipped),
      auth.ok ? checkDiagnosticStep(() => getSourceCategories(source, 'channel')) : skipped,
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ sourceId: String(source._id), checkedAt: new Date().toISOString(), steps: { auth, series, movie, channel } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Welcome rails: newest few items per kind + per-kind totals, from the MongoDB
// provider snapshot. A stale/missing snapshot triggers one lazy refresh.
app.get('/api/xtream/sources/:id/rails', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.status(404).json({ error: 'Playlist source not found' });
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 10));
    // Stored snapshot only - never touch the playlist provider here.
    const rails = await getProviderCatalogRails(accountOwner, String(source._id), limit);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const enabled = new Set(selectedSource.enabledKeys);
    const mark = list => list.map(item => ({ ...item, sourceId: String(source._id), providerName: source.name, enabled: enabled.has(item.key) }));
    res.set('Cache-Control', 'private, no-store');
    res.json({
      source: publicXtreamSource(source, ownerId, accountOwner),
      series: mark(rails.series), movie: mark(rails.movie), channel: mark(rails.channel),
      updatedAt: rails.updatedAt || new Date().toISOString(),
      counts: {
        series: Number(rails.kinds?.series?.count) || 0,
        movie: Number(rails.kinds?.movie?.count) || 0,
        channel: Number(rails.kinds?.channel?.count) || 0,
      },
      syncing: false, ready: true,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/catalog', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId || !accountOwner) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(String(req.query.sourceId || ''), accountOwner);
    if (!source) return res.status(404).json({ error: 'Xtream source not found' });
    const aliases = { live: 'channel', channel: 'channel', movie: 'movie', vod: 'movie', series: 'series' };
    const kind = aliases[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be channel, movie, or series' });
    const category = String(req.query.category || '');
    const query = normalizeSearchText(req.query.q);
    if (!category) return res.status(400).json({ error: 'Select a playlist category first' });
    // Browsing respects the selected category. Searching must use the full
    // playlist catalog for this content type so matches in other categories
    // are not hidden by the category currently open in the UI.
    // Served strictly from the MongoDB provider snapshot - the playlist
    // provider is never contacted here. The snapshot is populated by the Roku
    // bootstrap and the dashboard's catalog controls.
    if (!await catalogSnapshotHasKind(accountOwner, source._id, kind)) {
      return res.json({ source: publicXtreamSource(source, ownerId, accountOwner), languages: [], items: [], pagination: { page: 1, pageSize: 0, pageCount: 1, total: 0 }, origin: 'unavailable' });
    }
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const enabled = new Set(selectedSource.enabledKeys);
    const titleLanguage = String(req.query.titleLanguage || req.query.language || 'all').toUpperCase();
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const requestedLimit = String(req.query.limit || '').trim().toLowerCase();
    const pageSize = requestedLimit === 'all' ? 200 : Math.min(200, Math.max(10, Number.parseInt(requestedLimit, 10) || 50));
    const languages = await catalogLanguagesFor(accountOwner, source._id, kind);
    // Every filter is applied in MongoDB - a search stays across the whole kind,
    // a browse stays inside the open category, and the title-prefix language
    // filter ("DE - ...", "AR | ...") folds into the same query.
    const filters = [];
    // The query is folded (e.g. ة -> ه), but snapshot titles retain their
    // original spelling. Expand variants when matching those stored titles.
    if (query) filters.push({ title: { $regex: arabicSearchRegexSource(query), $options: 'i' } });
    if (titleLanguage !== 'ALL') filters.push({ title: { $regex: `^\\s*${titleLanguage.replace(/[^A-Z]/gi, '')}\\s*[-|:]`, $options: 'i' } });
    const result = await queryProviderCatalogItems(accountOwner, String(source._id), kind, {
      categoryId: query ? '' : category,
      page: requestedPage,
      limit: pageSize,
      extraFilters: filters,
    });
    // Catalog rows carry only a category id - always resolve it to the real
    // provider category name so no id ever leaks into the UI.
    const categories = await getProviderCatalogCategories(accountOwner, String(source._id), kind).catch(() => []);
    const categoryNameById = new Map(categories.map(entry => [String(entry.id), entry.name]));
    res.json({
      source: publicXtreamSource(source, ownerId, accountOwner), languages, categories,
      stale: result.stale, syncedAt: result.syncedAt,
      items: result.items.map(item => ({ ...item, category: categoryNameById.get(String(item.categoryId)) || item.category || 'Uncategorized', languageCode: titleLanguageCode(item), titleLanguage: titleLanguageCode(item), enabled: enabled.has(item.key) })),
      pagination: { page: result.page, pageSize: result.limit, pageCount: result.pageCount, total: result.total },
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/xtream/categories', async (req, res) => {
  try {
    const ownerId = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const source = await getXtreamSource(String(req.query.sourceId || ''), ownerId);
    if (!source) return res.status(404).json({ error: 'Xtream source not found' });
    const aliases = { live: 'channel', channel: 'channel', movie: 'movie', vod: 'movie', series: 'series' };
    const kind = aliases[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be channel, movie, or series' });
    const sortByName = list => [...list].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
    // Stored snapshot only - this request never calls the provider. If the
    // snapshot has items but no category names (a prior category fetch failed
    // and was silently dropped, or hasn't run yet), kick one background retry
    // so a later request has a chance to succeed - still doesn't block this
    // response, and refreshCatalogSnapshot's own in-flight map keeps concurrent
    // requests from piling up retries.
    const stored = await getProviderCatalogCategories(ownerId, String(source._id), kind).catch(() => []);
    if (!stored.length && await catalogSnapshotHasKind(ownerId, source._id, kind)) {
      void refreshCatalogSnapshot(ownerId, source, kind);
    }
    res.json({ categories: sortByName(stored), origin: stored.length ? 'storage' : 'unavailable' });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// A Watch-with-Partner guest does not own the host's source, so let a valid
// stream ticket for this exact item resolve the source as the host instead.
function durationLookupOwner(req, kind) {
  const ticket = resolveStreamTicket(req.query.streamTicket, req.params.sourceId, kind, req.params.id);
  return ticket?.accountOwnerId || requestAccountOwner(req);
}

app.get('/api/xtream/movie/:sourceId/:id/duration', async (req, res) => {
  try {
    const source = await getXtreamSource(req.params.sourceId, durationLookupOwner(req, 'movie'));
    if (!source) return res.sendStatus(404);
    const { seconds, duration, source: durationSource } = await resolveMediaDuration(source, 'movie', req.params.id, req.query.ext);
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ seconds, duration, source: durationSource });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/xtream/media-duration/:sourceId/:kind/:id', async (req, res) => {
  try {
    if (!['movie', 'series', 'channel'].includes(req.params.kind)) return res.sendStatus(400);
    const source = await getXtreamSource(req.params.sourceId, durationLookupOwner(req, req.params.kind));
    if (!source) return res.sendStatus(404);
    // Live channels have no duration to probe - the Roku preview only asks
    // this endpoint for the active stream's codec-matrix strategy.
    if (req.params.kind === 'channel') {
      if (req.query.playbackStrategy !== '1') return res.sendStatus(400);
      const matrix = await streamerPlaybackStrategy(req.params.sourceId, req.params.kind, req.params.id);
      res.set('Cache-Control', 'no-store');
      return res.json(matrix);
    }
    const result = await resolveMediaDuration(source, req.params.kind, req.params.id, req.query.ext, req.query.seriesId);
    if (req.query.playbackStrategy === '1') {
      const matrix = await streamerPlaybackStrategy(req.params.sourceId, req.params.kind, req.params.id);
      res.set('Cache-Control', 'no-store');
      return res.json({ ...result, ...matrix });
    }
    res.set('Cache-Control', 'private, max-age=300');
    res.json(result);
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
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const enabledKeys = selectedSource.enabledKeys;
    let enabledItems = selectedSource.enabledItems;
    const itemKeys = new Set(enabledItems.map(item => item.key));
    const needsBackfill = enabledItems.length !== enabledKeys.length
      || enabledKeys.some(key => !itemKeys.has(key))
      || enabledItems.some(item => !item.category || !item.language
        || String(item.category).trim().toLowerCase() === String(selectedSource.name).trim().toLowerCase());
    if (needsBackfill && enabledKeys.length) {
      enabledItems = await resolveXtreamEnabledItems(source, enabledKeys);
      const updated = await updateXtreamSelection(source._id, { ...selectionFor(source, ownerId, accountOwner), enabledKeys: enabledItems.map(item => item.key), enabledItems }, accountOwner, ownerId);
      return res.json({ source: updated, items: updated.enabledItems });
    }
    res.json({ source: publicXtreamSource(source, ownerId, accountOwner), items: enabledItems });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id/selection', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    if (!Array.isArray(req.body?.enabledKeys)) return res.status(400).json({ error: 'enabledKeys must be an array' });
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    // The manager already has the selected catalog rows. Persist them directly
    // instead of downloading every Xtream list again merely to resolve keys.
    // Full provider catalog reloads here were causing browser "Failed to fetch"
    // after Render ran out of memory or timed out.
    // Selection rows already carry their own category metadata from the
    // catalog view, so no live category lookup is needed here.
    const enabledItems = suppliedXtreamEnabledItems(source, req.body.enabledKeys, req.body.enabledItems, new Map());
    if (enabledItems.length !== req.body.enabledKeys.length) {
      return res.status(400).json({ error: 'Selected item details are missing. Reload the catalog and try again.' });
    }
    const enabledKeys = enabledItems.map(item => item.key);
    const enabledSet = new Set(enabledKeys);
    const updated = await updateXtreamSelection(req.params.id, {
      enabledKeys,
      enabledItems,
      archivedKeys: selectedSource.archivedKeys.filter(key => !enabledSet.has(key)),
      archivedItems: selectedSource.archivedItems.filter(item => !enabledSet.has(item.key)),
    }, accountOwner, ownerId);
    if (!updated) return res.sendStatus(404);
    bumpLibraryRevision(ownerId);
    res.json(updated);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const key = String(req.params.key || '');
    const enabledItems = selectedSource.enabledItems;
    const item = enabledItems.find(candidate => candidate.key === key);
    if (!item) return res.status(404).json({ error: 'Saved Roku item not found' });
    const archiveItems = [...selectedSource.archivedItems.filter(candidate => candidate.key !== key), item];
    const updated = await updateXtreamSelection(source._id, {
      enabledKeys: selectedSource.enabledKeys.filter(candidate => candidate !== key),
      enabledItems: enabledItems.filter(candidate => candidate.key !== key),
      archivedKeys: archiveItems.map(candidate => candidate.key),
      archivedItems: archiveItems,
    }, accountOwner, ownerId);
    bumpLibraryRevision(ownerId);
    res.json(updated);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key/restore', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const key = String(req.params.key || '');
    const archivedItems = selectedSource.archivedItems;
    const item = archivedItems.find(candidate => candidate.key === key);
    if (!item) return res.status(404).json({ error: 'Archived item not found' });
    const enabledItems = [...selectedSource.enabledItems.filter(candidate => candidate.key !== key), item];
    const updated = await updateXtreamSelection(source._id, {
      enabledKeys: enabledItems.map(candidate => candidate.key),
      enabledItems,
      archivedKeys: selectedSource.archivedKeys.filter(candidate => candidate !== key),
      archivedItems: archivedItems.filter(candidate => candidate.key !== key),
    }, accountOwner, ownerId);
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
    const ticket = resolveStreamTicket(req.query.streamTicket, req.params.sourceId, req.params.kind, req.params.id);
    const source = await getXtreamSource(req.params.sourceId, ticket?.accountOwnerId || requestAccountOwner(req));
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

// Forced transcode ladder for client-chosen quality. Streams are otherwise
// copied as-is (whatever the provider sends); picking a quality here forces a
// real re-encode at that resolution/bitrate so it is an actual choice.
const HLS_QUALITY_PRESETS = {
  '1080': { height: 1080, videoBitrate: '5000k', maxrate: '5350k', bufsize: '10000k' },
  '720': { height: 720, videoBitrate: '2800k', maxrate: '3000k', bufsize: '5600k' },
  '480': { height: 480, videoBitrate: '1400k', maxrate: '1500k', bufsize: '2800k' },
  '360': { height: 360, videoBitrate: '800k', maxrate: '900k', bufsize: '1600k' },
};
function normalizeHlsQuality(value) {
  const key = String(value || 'auto').trim();
  return HLS_QUALITY_PRESETS[key] ? key : 'auto';
}

function rokuHlsKey(sourceId, kind, id, extension, startSeconds = 0, quality = 'auto') {
  // Segment URLs in an HLS manifest do not retain the manifest query string,
  // so every seek offset and quality choice must be carried onto segment URLs
  // and job identity - a different quality is a different ffmpeg job.
  return createHash('sha256').update(`${sourceId}:${kind}:${id}:${startSeconds}:${quality}`).digest('hex').slice(0, 24);
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

async function getOrStartRokuHls(source, kind, id, extension, requestedStart = 0, identity = {}, quality = 'auto') {
  const seekableVod = kind === 'movie' || kind === 'series';
  const startSeconds = seekableVod ? hlsStartSeconds(requestedStart) : 0;
  const normalizedQuality = normalizeHlsQuality(quality);
  const key = rokuHlsKey(source._id, kind, id, extension, startSeconds, normalizedQuality);
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
  const qualityPreset = HLS_QUALITY_PRESETS[normalizedQuality] || null;
  if (qualityPreset) decision.videoMode = 'transcode';
  const mode = decision.strategy === HlsStrategy.FULL_TRANSCODE || qualityPreset ? 'transcode' : 'remux';
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
    '-map', '0:v:0?', '-map', '0:a:0?', ...hlsCodecArgs(decision, qualityPreset), '-sn', '-dn',
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
    const manifestTicket = resolveStreamTicket(req.query.streamTicket, req.params.sourceId, req.params.kind, req.params.id);
    const source = await getXtreamSource(req.params.sourceId, manifestTicket?.accountOwnerId || requestAccountOwner(req));
    if (!source) return res.sendStatus(404);
    const seekableVod = req.params.kind === 'movie' || req.params.kind === 'series';
    const startSeconds = seekableVod ? hlsStartSeconds(req.query.start) : 0;
    const quality = normalizeHlsQuality(req.query.quality);
    const identity = mediaIdentity(req);
    const job = await getOrStartRokuHls(source, req.params.kind, req.params.id, req.query.ext, startSeconds, identity, quality);
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
    if (quality !== 'auto') segmentQuery.set('quality', quality);
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
    const quality = normalizeHlsQuality(req.query.quality);
    const key = rokuHlsKey(req.params.sourceId, req.params.kind, req.params.id, req.query.ext, startSeconds, quality);
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

// Explicit teardown when a client closes its player. Android has no stable
// per-device identity to key the "one active job per device" cleanup that
// runs when a *new* job starts, so a closed item's ffmpeg job/provider lease
// would otherwise sit alive for MEDIA_STREAM_IDLE_TIMEOUT_MS - long enough for
// the very next item's connection to be rejected by a single-connection
// provider. The client already knows exactly which item it is leaving.
app.post('/api/xtream/hls/:sourceId/:kind/:id/stop', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    for (const [key, job] of mediaJobs.entries()) {
      if (job.sourceId === req.params.sourceId && job.kind === req.params.kind && job.mediaId === req.params.id
        && (!job.userId || !ownerId || job.userId === ownerId)) {
        await mediaJobs.remove(key, 'client-stopped');
      }
    }
    res.sendStatus(204);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/roku/:sourceId/:kind/:id', async (req, res) => {
  return res.status(410).json({ error: 'Movie and series playback is HLS-only. Use /api/xtream/hls.' });
  let job;
  let jobKey = '';
  let outputStarted = false;
  let startupTimer;
  try {
    const source = await getXtreamSource(req.params.sourceId, requestAccountOwner(req));
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
async function buildXtreamSeriesPayload({ limit, selected: suppliedSelected, accountOwner, strict = false } = {}) {
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
        const source = await getXtreamSource(seriesItem.sourceId, accountOwner);
        if (!source) { groups[index] = items; continue; }
        // Opening a Roku series must be bounded by the provider metadata call,
        // not by one FFprobe process for every episode in the series.
        const details = await hydrateSeriesDurations(source, await getIndexedXtreamSeriesEpisodes(source, seriesItem.id));
        for (const episode of details.episodes) {
          const extension = String(episode.extension || '').toLowerCase();
          const playbackUrl = rokuXtreamPlaybackPath(source._id, 'series', episode.id, extension);
          const providerUrl = sourceProviderUrl(source, 'series', episode.id, extension);
          const title = episode.title || `${details.title} · ${episode.episodeNumber}`;
          items.push({
            id: episode.id,
            sourceId: String(source._id),
            seriesId: String(seriesItem.id),
            favoriteId: `xtream:${source._id}:series:${episode.id}`,
            source: 'xtream', kind: 'episode', contentKind: 'episode',
            title, rokuTitle: rokuText(title), rokuTextKind: /[A-Za-z]/.test(title) ? 'latin' : 'arabic',
            seriesTitle: details.title, rokuSeriesTitle: rokuText(details.title),
            seasonTitle: episode.seasonTitle, rokuSeasonTitle: rokuText(episode.seasonTitle),
            seasonSort: episode.seasonNumber, episodeNumber: episode.episodeNumber,
            duration: displayDuration(episode.duration), thumbnail: episode.thumbnail,
            durationSeconds: durationSeconds(episode.duration),
            category: seriesItem.category,
            rokuCategory: seriesItem.rokuCategory,
            language: seriesItem.language,
            added: seriesItem.added,
            url: playbackUrl, playbackUrl, providerUrl, streamFormat: rokuXtreamStreamFormat(extension),
            originalFormat: extension || 'mp4',
          });
        }
      } catch (error) {
        if (strict) throw new Error('Provider unavailable. Please retry loading episodes.');
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
      getRokuSelectedItems('series', requestOwner(req), requestAccountOwner(req)), getRokuSelectedItems('movie', requestOwner(req), requestAccountOwner(req)), getRokuSelectedItems('channel', requestOwner(req), requestAccountOwner(req)),
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
    if (String(req.query.librarySource || '') === 'server') {
      const catalog = String(req.query.saved || '') === '1'
        ? await getRokuServerSavedItems(requestOwner(req), 'series', requestAccountOwner(req))
        : await getRokuServerCatalog(requestOwner(req), 'series', req.query.category, requestAccountOwner(req));
      const items = catalog.items.map(item => ({
        id: `series-search:${item.sourceId}:${item.id}`,
        title: item.title, rokuTitle: rokuText(item.title), category: item.category,
        rokuCategory: rokuText(item.category), sourceId: String(item.sourceId), seriesId: item.id,
        thumbnail: item.logo, added: item.added, contentKind: 'series-search',
        originalFormat: String(item.extension || 'mp4').replace(/[^a-z0-9]/gi, '').toUpperCase(),
      }));
      return res.json({ items, page: 0, total: items.length, hasMore: false, savedKeys: rokuSourceSavedKeys(catalog.source) });
    }
    const pageInfo = rokuPage(req, rokuCatalogPageLimit);
    pageInfo.limit = rokuCatalogPageLimit;
    pageInfo.offset = pageInfo.page * pageInfo.limit;
    const category = String(req.query.category || '');
    const selected = (await getRokuSelectedItems('series', requestOwner(req), requestAccountOwner(req)))
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
    if (String(req.query.librarySource || '') === 'server') {
      const catalog = String(req.query.saved || '') === '1'
        ? await getRokuServerSavedItems(requestOwner(req), 'channel', requestAccountOwner(req))
        : await getRokuServerCatalog(requestOwner(req), 'channel', req.query.category, requestAccountOwner(req));
      const items = buildXtreamChannelsPayload(catalog.items);
      return res.json({ items, page: 0, total: items.length, hasMore: false, savedKeys: rokuSourceSavedKeys(catalog.source) });
    }
    const pageInfo = rokuPage(req, rokuCatalogPageLimit);
    pageInfo.limit = rokuCatalogPageLimit;
    pageInfo.offset = pageInfo.page * pageInfo.limit;
    const selected = (await getRokuSelectedItems('channel', requestOwner(req), requestAccountOwner(req)))
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
await ensureBackdropRoot().catch(error => console.warn(`[Backdrop] root init failed: ${error.message}`));
await initializeAccountDatabases();

const resourceLogIntervalMs = Math.max(60_000, Number.parseInt(process.env.MEDIA_RESOURCE_LOG_INTERVAL_MS || '300000', 10) || 300_000);
setInterval(async () => {
  try {
    const snapshot = await mediaHealthSnapshot();
    console.log(`[Media health] rss=${snapshot.rssMB}MB heap=${snapshot.heapUsedMB}MB direct=${snapshot.activeDirectStreams} remux=${snapshot.activeRemuxJobs} transcode=${snapshot.activeTranscodes} hls=${snapshot.hlsDiskUsageMB}MB`);
  } catch (error) { console.warn(`[Media health] snapshot failed: ${error.message}`); }
}, resourceLogIntervalMs).unref();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`RH Stream API listening on http://127.0.0.1:${port}`);
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
