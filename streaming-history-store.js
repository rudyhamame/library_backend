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
const emptyStreamingHistory = () => ({ series: [], movies: [], live: [] });
const historyRows = library => [
  ...(library.streaming_history?.series || []).flatMap(group => (group.episodes || []).map(episode => ({
    ...episode,
    providerIdentity: {
      ...group.providerIdentity,
      ...episode.providerIdentity,
      kind: 'series',
      seriesId: episode.providerIdentity?.seriesId || group.providerIdentity?.seriesId || '',
    },
  }))),
  ...(library.streaming_history?.movies || []),
  ...(library.streaming_history?.live || []),
];
const historyBucket = kind => {
  const key = historyKey(kind);
  return key === 'episode' ? 'series' : (key === 'live' ? 'live' : 'movies');
};
const watchedPositionMs = value => {
  const parts = String(value || '').split(':').map(part => Number(part) || 0);
  if (parts.length !== 3) return 0;
  return ((parts[0] * 60 * 60) + (parts[1] * 60) + parts[2]) * 1000;
};
// Movies and live channels intentionally store only the fields needed by
// their history contracts. Series episodes retain playback/display metadata.
// Provider URLs are always generated transiently when history is read.
export const kindRecord = update => {
  const providerIdentity = {
    itemId: String(update.itemId || ''),
    kind: update.kind,
    sourceId: String(update.sourceId || ''),
    ...(update.kind === 'series' && update.seriesId ? { seriesId: String(update.seriesId) } : {}),
  };
  const record = { updatedAt: update.updatedAt, providerIdentity };
  if (update.kind === 'channel') return record;
  if (update.kind === 'movie') return { ...record, lastWatched: update.lastMoment };
  return { ...record, lastWatched: update.lastMoment };
};
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

export async function saveStreamingHistory(input = {}) {
  const {
    ownerId, sessionId, title, seriesName, extension, poster, category,
    startedAt, endedAt, startPositionMs, endPositionMs, streamingDurationMs,
    mediaDurationMs, completed, seasonNumber, episodeNumber,
  } = input;
  // providerIdentity is the canonical wire/storage contract. Accept the old
  // flat fields as a compatibility bridge for Roku builds that are already in
  // the field, but never let an empty flat value shadow a populated identity.
  const identity = input.providerIdentity && typeof input.providerIdentity === 'object'
    ? input.providerIdentity
    : {};
  const itemId = identity.itemId || input.itemId;
  const kind = identity.kind || input.kind;
  const sourceId = identity.sourceId || input.sourceId;
  const seriesId = identity.seriesId || input.seriesId;
  if (!ownerId || !sessionId) throw new Error('Profile owner and streaming session ID are required');
  if (!itemId || !sourceId || !kind) throw new Error('Provider identity requires itemId, kind, and sourceId');
  const now = new Date();
  const startDate = startedAt ? new Date(startedAt) : now;
  const endDate = endedAt ? new Date(endedAt) : null;
  const key = historyKey(kind);
  const update = {
    itemId: String(itemId), title: String(title || ''), seriesName: String(seriesName || ''),
    kind: key === 'episode' ? 'series' : (key === 'live' ? 'channel' : 'movie'),
    sourceId: String(sourceId), seriesId: String(seriesId || ''),
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
    // An episode saved without its series id (older hand-offs) joins the series
    // group that already holds that episode instead of a blank-series group.
    if (update.kind === 'series' && !update.seriesId) {
      const known = (library.streaming_history?.series || []).find(group => group.providerIdentity?.seriesId
        && String(group.providerIdentity?.sourceId) === update.sourceId
        && (group.episodes || []).some(episode => String(episode.providerIdentity?.itemId) === update.itemId));
      if (known) update.seriesId = String(known.providerIdentity.seriesId);
    }
    const record = kindRecord(update);
    const identityKey = `${record.providerIdentity.sourceId}:${record.providerIdentity.kind}:${record.providerIdentity.itemId}`;
    const bucket = historyBucket(update.kind);
    let records;
    let seriesGroup = null;
    if (bucket === 'series') {
      const seriesKey = seriesHistoryKey(update.sourceId, update.seriesId);
      seriesGroup = library.streaming_history.series.find(item => seriesHistoryKey(item.providerIdentity?.sourceId, item.providerIdentity?.seriesId) === seriesKey);
      if (!seriesGroup) {
        seriesGroup = { providerIdentity: { sourceId: update.sourceId, kind: 'series', seriesId: update.seriesId }, episodes: [] };
        library.streaming_history.series.push(seriesGroup);
      }
      records = seriesGroup.episodes;
    } else records = library.streaming_history[bucket];
    const historyIndex = records.findIndex(item => {
      const identity = item?.providerIdentity || {};
      if (bucket === 'series') return String(identity.itemId || '') === String(record.providerIdentity.itemId);
      return `${identity.sourceId || ''}:${identity.kind || ''}:${identity.itemId || ''}` === identityKey;
    });
    const storedRecord = bucket === 'series'
      ? { ...record, providerIdentity: { itemId: record.providerIdentity.itemId } }
      : record;
    if (historyIndex >= 0) records[historyIndex] = storedRecord;
    else records.push(storedRecord);
    return library;
  });
  return update;
}

export async function getStreamingSession(ownerId, sessionId) {
  const library = await getAccountLibrary(ownerId);
  return historyRows(library).map(kindRecordHistory).find(item => item?.sessionId === String(sessionId)) || null;
}

export async function getStreamingHistory(ownerId) {
  const library = await getAccountLibrary(ownerId);
  return historyRows(library).map(kindRecordHistory).filter(Boolean).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export async function deleteStreamingSession(ownerId, sessionId) {
  if (!ownerId || !sessionId) return { deleted: 0 };
  let deleted = 0;
  await updateAccountLibrary(ownerId, library => {
    for (const bucket of ['movies', 'live']) {
      const beforeHistory = library.streaming_history[bucket].length;
      library.streaming_history[bucket] = library.streaming_history[bucket].filter(item => item?.sessionId !== String(sessionId));
      deleted += beforeHistory - library.streaming_history[bucket].length;
    }
    for (const group of library.streaming_history.series) {
      const beforeHistory = group.episodes.length;
      group.episodes = group.episodes.filter(item => item?.sessionId !== String(sessionId));
      deleted += beforeHistory - group.episodes.length;
    }
    library.streaming_history.series = library.streaming_history.series.filter(group => group.episodes.length > 0);
    return library;
  });
  return { deleted };
}

export async function clearStreamingHistory(ownerId) {
  if (!ownerId) return { deleted: 0 };
  const before = await getAccountLibrary(ownerId);
  const deleted = historyRows(before).length;
  await updateAccountLibrary(ownerId, library => {
    library.streaming_history = emptyStreamingHistory();
    return library;
  });
  return { deleted };
}

export async function getStreamingResume(ownerId, input = {}) {
  const identity = input.providerIdentity && typeof input.providerIdentity === 'object'
    ? input.providerIdentity
    : {};
  const sourceId = identity.sourceId || input.sourceId;
  const itemId = identity.itemId || input.itemId;
  const kind = identity.kind || input.kind;
  const seriesId = identity.seriesId || input.seriesId;
  if (!ownerId || !sourceId || !itemId) return null;
  const library = await getAccountLibrary(ownerId);
  const key = historyKey(kind);
  const current = historyRows(library).find(item => {
    const identity = item?.providerIdentity || {};
    return String(identity.sourceId || '') === String(sourceId)
      && String(identity.itemId || '') === String(itemId)
      && historyKey(identity.kind) === key
      && (!seriesId || !identity.seriesId || String(identity.seriesId) === String(seriesId));
  });
  const item = kindRecordHistory(current);
  return item && item.sourceId === String(sourceId) && item.itemId === String(itemId) ? item : null;
}

export async function getSeriesLastWatched(ownerId, sourceId, seriesId) {
  if (!ownerId || !sourceId || !seriesId) return null;
  const library = await getAccountLibrary(ownerId);
  const keyed = historyRows(library)
    .filter(item => item.providerIdentity?.kind === 'series'
      && String(item.providerIdentity?.sourceId || '') === String(sourceId)
      && String(item.providerIdentity?.seriesId || '') === String(seriesId))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
  const normalized = kindRecordHistory(keyed);
  if (!normalized) return null;
  return {
    itemId: normalized.providerIdentity?.itemId || '',
    sourceId: normalized.providerIdentity?.sourceId || '',
    seriesId: normalized.providerIdentity?.seriesId || '',
    endPositionMs: normalized.endPositionMs,
    lastMoment: normalized.lastMoment,
  };
}

export async function getSeriesWatchedEpisodes(ownerId, sourceId, seriesId) {
  if (!ownerId || !sourceId || !seriesId) return [];
  const library = await getAccountLibrary(ownerId);
  return historyRows(library)
    .filter(item => item.providerIdentity?.kind === 'series'
      && String(item.providerIdentity?.sourceId || '') === String(sourceId)
      && String(item.providerIdentity?.seriesId || '') === String(seriesId))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .map(kindRecordHistory)
    .filter(Boolean)
    .map(item => ({ itemId: item.providerIdentity.itemId, endPositionMs: item.endPositionMs, lastWatched: item.lastMoment }));
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
