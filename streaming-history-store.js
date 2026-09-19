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
const watchedSeriesKey = item => `${String(item?.providerURL?.sourceId || '')}:${String(item?.providerURL?.seriesId || '')}`;
const watchedPositionMs = value => {
  const parts = String(value || '').split(':').map(part => Number(part) || 0);
  if (parts.length !== 3) return 0;
  return ((parts[0] * 60 * 60) + (parts[1] * 60) + parts[2]) * 1000;
};
const seriesWatchedRecord = update => ({
  providerURL: {
    sourceId: update.sourceId,
    seriesId: update.seriesId,
    itemId: update.itemId,
    sessionId: update.sessionId,
  },
  lastWatched: update.lastMoment,
});
const seriesRecordHistory = record => record ? ({
  itemId: record.providerURL?.itemId || '',
  sourceId: record.providerURL?.sourceId || '',
  seriesId: record.providerURL?.seriesId || '',
  endPositionMs: watchedPositionMs(record.lastWatched),
  lastMoment: record.lastWatched || '00:00:00',
}) : null;
const kindRecord = update => ({
  itemId: update.itemId,
  kind: update.kind,
  sourceId: update.sourceId,
  seriesId: update.seriesId,
  endPositionMs: update.endPositionMs,
  mediaDurationMs: update.mediaDurationMs,
  completed: update.completed === true,
  sessionId: update.sessionId,
  updatedAt: update.updatedAt,
  providerURL: { sourceId: update.sourceId, itemId: update.itemId, seriesId: update.seriesId },
  lastWatched: update.lastMoment,
});
const kindRecordHistory = record => record?.providerURL ? ({
  ...record,
  endPositionMs: watchedPositionMs(record.lastWatched),
  lastMoment: record.lastWatched || '00:00:00',
}) : null;

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
    const record = kindRecord(update);
    library.last_kinds_watched[key] = record;
    if (key === 'episode' && update.sourceId && update.seriesId) {
      const record = seriesWatchedRecord(update);
      const index = library.series_last_watched.findIndex(item => watchedSeriesKey(item) === seriesHistoryKey(update.sourceId, update.seriesId));
      if (index >= 0) library.series_last_watched[index] = record;
      else library.series_last_watched.push(record);
    }
    return library;
  });
  return update;
}

export async function getStreamingSession(ownerId, sessionId) {
  const library = await getAccountLibrary(ownerId);
  return [
    ...Object.values(library.last_kinds_watched).map(kindRecordHistory),
  ].find(item => item?.sessionId === String(sessionId)) || null;
}

export async function getStreamingHistory(ownerId) {
  const library = await getAccountLibrary(ownerId);
  return Object.values(library.last_kinds_watched).map(kindRecordHistory).filter(Boolean).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export async function deleteStreamingSession(ownerId, sessionId) {
  if (!ownerId || !sessionId) return { deleted: 0 };
  let deleted = 0;
  await updateAccountLibrary(ownerId, library => {
    for (const key of ['episode', 'movie', 'live']) {
      if (library.last_kinds_watched[key]?.sessionId === String(sessionId)) {
        library.last_kinds_watched[key] = null;
        deleted++;
      }
    }
    const before = library.series_last_watched.length;
    library.series_last_watched = library.series_last_watched.filter(item => item?.providerURL?.sessionId !== String(sessionId));
    deleted += before - library.series_last_watched.length;
    return library;
  });
  return { deleted };
}

export async function clearStreamingHistory(ownerId) {
  if (!ownerId) return { deleted: 0 };
  const before = await getAccountLibrary(ownerId);
  const deleted = Object.values(before.last_kinds_watched).filter(Boolean).length + before.series_last_watched.length;
  await updateAccountLibrary(ownerId, library => {
    library.last_kinds_watched = emptyLastKindsWatched();
    library.series_last_watched = [];
    return library;
  });
  return { deleted };
}

export async function getStreamingResume(ownerId, { sourceId, itemId, kind, seriesId }) {
  if (!ownerId || !sourceId || !itemId) return null;
  const library = await getAccountLibrary(ownerId);
  const key = historyKey(kind);
  const current = key === 'episode' && seriesId
    ? library.series_last_watched.find(item => watchedSeriesKey(item) === seriesHistoryKey(sourceId, seriesId))
    : null;
  const item = current ? seriesRecordHistory(current) : kindRecordHistory(library.last_kinds_watched[key]);
  return item && item.sourceId === String(sourceId) && item.itemId === String(itemId) ? item : null;
}

export async function getSeriesLastWatched(ownerId, sourceId, seriesId) {
  if (!ownerId || !sourceId || !seriesId) return null;
  const library = await getAccountLibrary(ownerId);
  const keyed = library.series_last_watched.find(item => watchedSeriesKey(item) === seriesHistoryKey(sourceId, seriesId));
  if (keyed) return seriesRecordHistory(keyed);
  const legacy = kindRecordHistory(library.last_kinds_watched.episode);
  if (!legacy || String(legacy.sourceId) !== String(sourceId) || String(legacy.seriesId) !== String(seriesId)) return null;
  // Preserve an older single-episode record until the next playback write.
  await updateAccountLibrary(ownerId, next => {
    if (!next.series_last_watched.some(item => watchedSeriesKey(item) === seriesHistoryKey(sourceId, seriesId))) {
      next.series_last_watched.push(seriesWatchedRecord(legacy));
    }
    return next;
  });
  return legacy;
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
