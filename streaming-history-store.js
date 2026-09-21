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
const watchedSeriesKey = item => `${String(item?.providerIdentity?.sourceId || '')}:${String(item?.providerIdentity?.seriesId || '')}`;
const watchedPositionMs = value => {
  const parts = String(value || '').split(':').map(part => Number(part) || 0);
  if (parts.length !== 3) return 0;
  return ((parts[0] * 60 * 60) + (parts[1] * 60) + parts[2]) * 1000;
};
const seriesWatchedRecord = update => ({
  providerIdentity: {
    sourceId: update.sourceId,
    kind: 'episode',
    seriesId: update.seriesId,
    itemId: update.itemId,
  },
  sessionId: update.sessionId,
  lastWatched: update.lastMoment,
});
const seriesRecordHistory = record => record ? ({
  itemId: record.providerIdentity?.itemId || '',
  sourceId: record.providerIdentity?.sourceId || '',
  seriesId: record.providerIdentity?.seriesId || '',
  endPositionMs: watchedPositionMs(record.lastWatched),
  lastMoment: record.lastWatched || '00:00:00',
}) : null;
// Preserve display/playback metadata captured when playback starts so
// Continue Watching never degrades to "Movie 123" / "Series 456" merely
// because a later provider lookup is unavailable. The provider URL itself is
// deliberately excluded and is generated transiently when history is read.
export const kindRecord = update => ({
  providerIdentity: {
    itemId: String(update.itemId || ''),
    kind: update.kind,
    sourceId: String(update.sourceId || ''),
    seriesId: String(update.seriesId || ''),
  },
  title: update.title,
  seriesName: update.seriesName,
  extension: update.extension,
  poster: update.poster,
  category: update.category,
  seasonNumber: update.seasonNumber,
  episodeNumber: update.episodeNumber,
  endPositionMs: update.endPositionMs,
  mediaDurationMs: update.mediaDurationMs,
  completed: update.completed === true,
  sessionId: update.sessionId,
  updatedAt: update.updatedAt,
  lastWatched: update.lastMoment,
});
const kindRecordHistory = record => {
  if (!record) return null;
  const legacyIdentity = record.providerIdentity || (record.providerURL && typeof record.providerURL === 'object' ? record.providerURL : {});
  const sourceId = String(record.sourceId || legacyIdentity.sourceId || '');
  const itemId = String(record.itemId || legacyIdentity.itemId || '');
  const identityKind = String(record.kind || legacyIdentity.kind || '').toLowerCase();
  if (!sourceId || !itemId) return null;
  return {
    ...record,
    sourceId,
    itemId,
    seriesId: String(record.seriesId || legacyIdentity.seriesId || ''),
    kind: ['live', 'channel'].includes(identityKind) ? 'channel' : (['movie'].includes(identityKind) ? 'movie' : 'series'),
    endPositionMs: record.endPositionMs != null ? milliseconds(record.endPositionMs) : watchedPositionMs(record.lastWatched),
    lastMoment: record.lastWatched || '00:00:00',
  };
};

export async function saveStreamingHistory({ ownerId, sessionId, itemId, title, seriesName, kind, sourceId, seriesId, extension, poster, category, startedAt, endedAt, startPositionMs, endPositionMs, streamingDurationMs, mediaDurationMs, completed, seasonNumber, episodeNumber }) {
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
    category: String(category || ''),
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
    const identityKey = `${record.providerIdentity.sourceId}:${record.providerIdentity.kind}:${record.providerIdentity.itemId}`;
    const historyIndex = library.streaming_history.findIndex(item => {
      const identity = item?.providerIdentity || {};
      return `${identity.sourceId || ''}:${identity.kind || ''}:${identity.itemId || ''}` === identityKey;
    });
    if (historyIndex >= 0) library.streaming_history[historyIndex] = record;
    else library.streaming_history.push(record);
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
  return library.streaming_history.map(kindRecordHistory).find(item => item?.sessionId === String(sessionId)) || null;
}

export async function getStreamingHistory(ownerId) {
  const library = await getAccountLibrary(ownerId);
  return library.streaming_history.map(kindRecordHistory).filter(Boolean).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export async function deleteStreamingSession(ownerId, sessionId) {
  if (!ownerId || !sessionId) return { deleted: 0 };
  let deleted = 0;
  await updateAccountLibrary(ownerId, library => {
    const beforeHistory = library.streaming_history.length;
    library.streaming_history = library.streaming_history.filter(item => item?.sessionId !== String(sessionId));
    deleted += beforeHistory - library.streaming_history.length;
    for (const key of ['episode', 'movie', 'live']) {
      if (library.last_kinds_watched[key]?.sessionId === String(sessionId)) {
        library.last_kinds_watched[key] = null;
        deleted++;
      }
    }
    const before = library.series_last_watched.length;
    library.series_last_watched = library.series_last_watched.filter(item => item?.sessionId !== String(sessionId));
    deleted += before - library.series_last_watched.length;
    return library;
  });
  return { deleted };
}

export async function clearStreamingHistory(ownerId) {
  if (!ownerId) return { deleted: 0 };
  const before = await getAccountLibrary(ownerId);
  const deleted = before.streaming_history.length;
  await updateAccountLibrary(ownerId, library => {
    library.streaming_history = [];
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
  const current = library.streaming_history.find(item => {
    const identity = item?.providerIdentity || {};
    return String(identity.sourceId || '') === String(sourceId)
      && String(identity.itemId || '') === String(itemId)
      && historyKey(identity.kind) === key
      && (!seriesId || !identity.seriesId || String(identity.seriesId) === String(seriesId));
  });
  const item = kindRecordHistory(current || library.last_kinds_watched[key]);
  return item && item.sourceId === String(sourceId) && item.itemId === String(itemId) ? item : null;
}

export async function getSeriesLastWatched(ownerId, sourceId, seriesId) {
  if (!ownerId || !sourceId || !seriesId) return null;
  const library = await getAccountLibrary(ownerId);
  const keyed = library.streaming_history
    .filter(item => watchedSeriesKey(item) === seriesHistoryKey(sourceId, seriesId))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
  if (keyed) return seriesRecordHistory(keyed);
  const legacy = kindRecordHistory(library.last_kinds_watched.episode);
  if (!legacy || String(legacy.sourceId) !== String(sourceId) || String(legacy.seriesId) !== String(seriesId)) return null;
  // Preserve an older single-episode record until the next playback write.
  await updateAccountLibrary(ownerId, next => {
    if (!next.streaming_history.some(item => watchedSeriesKey(item) === seriesHistoryKey(sourceId, seriesId))) {
      next.streaming_history.push(seriesWatchedRecord(legacy));
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
  const legacyIdentity = item?.providerIdentity || (item?.providerURL && typeof item.providerURL === 'object' ? item.providerURL : {});
  if (!(item?.sourceId || legacyIdentity.sourceId) || !(item?.itemId || legacyIdentity.itemId)) return false;
  if (item.kind === 'channel') return true;
  if (item.completed === true) return false;
  const position = milliseconds(item.endPositionMs);
  const duration = milliseconds(item.mediaDurationMs);
  return duration <= 0 || position < Math.max(duration - 30000, duration * 0.95);
}

// Kept for old device-link callers; history is now nested under profiles.
export async function moveStreamingHistoryOwners() {}
