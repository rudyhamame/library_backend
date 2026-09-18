import { getAccountLibrary, updateAccountLibrary } from './account-library-data.js';

const milliseconds = value => Math.max(0, Math.round(Number(value) || 0));
const formatLastMoment = value => {
  const totalSeconds = Math.floor(milliseconds(value) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':');
};
const historyKey = value => {
  const kind = String(value || '').toLowerCase();
  if (kind === 'channel' || kind === 'live') return 'live';
  if (kind === 'series' || kind === 'episode') return 'episode';
  return 'movie';
};
export const seriesHistoryKey = (sourceId, seriesId) => `${String(sourceId || '')}:${String(seriesId || '')}`;
const emptyLastKindsWatched = () => ({ episode: null, movie: null, live: null });

export async function saveStreamingHistory({ ownerId, sessionId, itemId, title, seriesName, kind, sourceId, seriesId, extension, poster, startedAt, endedAt, startPositionMs, endPositionMs, streamingDurationMs, mediaDurationMs, completed, seasonNumber, episodeNumber }) {
  if (!ownerId || !sessionId) throw new Error('Profile owner and streaming session ID are required');
  const now = new Date();
  const startDate = startedAt ? new Date(startedAt) : now;
  const endDate = endedAt ? new Date(endedAt) : null;
  const key = historyKey(kind);
  const update = {
    itemId: String(itemId || ''), title: String(title || ''), seriesName: String(seriesName || ''),
    kind: key === 'episode' ? 'series' : (key === 'live' ? 'channel' : 'movie'),
    sourceId: String(sourceId || ''), seriesId: String(seriesId || ''),
    extension: String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase(), poster: String(poster || ''),
    startPositionMs: milliseconds(startPositionMs), endPositionMs: milliseconds(endPositionMs),
    streamingDurationMs: milliseconds(streamingDurationMs), mediaDurationMs: milliseconds(mediaDurationMs),
    lastMoment: formatLastMoment(endPositionMs), updatedAt: now, sessionId: String(sessionId),
    startedAt: startedAt && !Number.isNaN(startDate.getTime()) ? startDate : now,
  };
  if (endDate && !Number.isNaN(endDate.getTime())) update.endedAt = endDate;
  if (key === 'episode' && seasonNumber != null && seasonNumber !== '') update.seasonNumber = Number.parseInt(seasonNumber, 10) || 0;
  if (key === 'episode' && episodeNumber != null && episodeNumber !== '') update.episodeNumber = Number.parseInt(episodeNumber, 10) || 0;
  if (completed === true || String(completed).toLowerCase() === 'true') update.completed = true;
  await updateAccountLibrary(ownerId, library => {
    library.last_kinds_watched[key] = update;
    if (key === 'episode' && update.sourceId && update.seriesId) {
      library.series_last_watched[seriesHistoryKey(update.sourceId, update.seriesId)] = update;
    }
    return library;
  });
  return update;
}

export async function getStreamingSession(ownerId, sessionId) {
  const library = await getAccountLibrary(ownerId);
  return [
    ...Object.values(library.last_kinds_watched),
    ...Object.values(library.series_last_watched),
  ].find(item => item?.sessionId === String(sessionId)) || null;
}

export async function getStreamingHistory(ownerId) {
  const library = await getAccountLibrary(ownerId);
  return Object.values(library.last_kinds_watched).filter(Boolean).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export async function deleteStreamingSession(ownerId, sessionId) {
  if (!ownerId || !sessionId) return { deleted: 0 };
  let deleted = 0;
  await updateAccountLibrary(ownerId, library => {
    for (const key of ['episode', 'movie', 'live']) {
      if (library.last_kinds_watched[key]?.sessionId === String(sessionId)) { library.last_kinds_watched[key] = null; deleted++; }
    }
    for (const key of Object.keys(library.series_last_watched)) {
      if (library.series_last_watched[key]?.sessionId === String(sessionId)) {
        delete library.series_last_watched[key];
        deleted++;
      }
    }
    return library;
  });
  return { deleted };
}

export async function clearStreamingHistory(ownerId) {
  if (!ownerId) return { deleted: 0 };
  const before = await getAccountLibrary(ownerId);
  const deleted = Object.values(before.last_kinds_watched).filter(Boolean).length + Object.values(before.series_last_watched).filter(Boolean).length;
  await updateAccountLibrary(ownerId, library => {
    library.last_kinds_watched = emptyLastKindsWatched();
    library.series_last_watched = {};
    return library;
  });
  return { deleted };
}

export async function getStreamingResume(ownerId, { sourceId, itemId, kind, seriesId }) {
  if (!ownerId || !sourceId || !itemId) return null;
  const library = await getAccountLibrary(ownerId);
  const key = historyKey(kind);
  const current = key === 'episode' && seriesId ? library.series_last_watched[seriesHistoryKey(sourceId, seriesId)] : null;
  const item = current || library.last_kinds_watched[key];
  return item && item.sourceId === String(sourceId) && item.itemId === String(itemId) ? item : null;
}

export async function getSeriesLastWatched(ownerId, sourceId, seriesId) {
  if (!ownerId || !sourceId || !seriesId) return null;
  const library = await getAccountLibrary(ownerId);
  const keyed = library.series_last_watched[seriesHistoryKey(sourceId, seriesId)];
  if (keyed) return keyed;
  const legacy = library.last_kinds_watched.episode;
  return legacy && String(legacy.sourceId) === String(sourceId) && String(legacy.seriesId) === String(seriesId) ? legacy : null;
}

export async function getStreamingContinueWatching(ownerId) {
  const filtered = (await getStreamingHistory(ownerId)).filter(isContinueWatchingItem);
  return filtered;
}

export function isContinueWatchingItem(item) {
  if (!item?.sourceId || !item?.itemId) return false;
  if (item.kind === 'channel') return true;
  if (item.completed === true) return false;
  const position = milliseconds(item.endPositionMs);
  const duration = milliseconds(item.mediaDurationMs);
  return duration <= 0 || position < Math.max(duration - 30000, duration * 0.95);
}

// Kept for old device-link callers; history is now nested under profiles.
export async function moveStreamingHistoryOwners() {}
