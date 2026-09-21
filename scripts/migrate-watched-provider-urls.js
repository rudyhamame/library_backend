import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { xtreamProviderUrl } from '../xtream.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';

const idFromUrl = value => String(value || '').match(/\/(?:series|movie|live)\/[^/]+\/[^/]+\/([^/?#]+)/i)?.[1]?.replace(/\.[a-z0-9]+$/i, '') || '';
const kindFolder = kind => kind === 'live' ? 'live' : kind === 'movie' ? 'movie' : 'series';

function providerUrl(record, kind, account) {
  if (typeof record?.providerURL === 'string' && record.providerURL) return record.providerURL;
  const reference = record?.providerIdentity || (record?.providerURL && typeof record.providerURL === 'object' ? record.providerURL : record);
  const source = (account.providers || []).find(item => String(item._id) === String(reference?.sourceId || ''));
  const itemId = String(reference?.itemId || '');
  if (!source || !itemId) return '';
  const saved = Object.values(account.profiles || []).flatMap(profile => [
    ...(profile.library?.savedSelections?.series || []),
    ...(profile.library?.savedSelections?.movies || []),
    ...(profile.library?.savedSelections?.live || []),
  ]);
  const exact = saved.find(url => idFromUrl(url) === itemId && String(url).toLowerCase().includes(`/${kindFolder(kind)}/`));
  if (exact) return String(exact);
  return xtreamProviderUrl(source, kind === 'live' ? 'channel' : kind, itemId, kind === 'live' ? '' : 'mp4');
}

function compactRecord(record, kind, account) {
  const url = providerUrl(record, kind, account);
  if (!record?.lastWatched) return null;
  const source = (account.providers || []).find(item => String(item._id) === String(record?.providerIdentity?.sourceId || record?.providerURL?.sourceId || record?.sourceId || ''))
    || (account.providers || []).find(item => url.startsWith(`${String(item.baseUrl || '').replace(/\/$/, '')}/`));
  const resolvedItemId = String(record?.providerIdentity?.itemId || record?.providerURL?.itemId || record?.itemId || idFromUrl(url));
  const resolvedSourceId = String(record?.providerIdentity?.sourceId || record?.providerURL?.sourceId || record?.sourceId || source?._id || '');
  if (!resolvedItemId || !resolvedSourceId) return null;
  const { providerURL, providerUrl, providerIdentity, itemId, sourceId, seriesId, kind: oldKind, ...metadata } = record;
  return {
    ...metadata,
    lastWatched: String(record.lastWatched),
    providerIdentity: {
      sourceId: resolvedSourceId,
      kind: kind === 'series' ? 'series' : kind === 'live' ? 'channel' : 'movie',
      itemId: resolvedItemId,
      seriesId: String(record?.providerIdentity?.seriesId || record?.providerURL?.seriesId || ''),
    },
    lastWatched: String(record.lastWatched),
  };
}

const client = await MongoClient.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
let migrated = 0;
try {
  for (const databaseName of [rokuDb, generalDb]) {
    const collection = client.db(databaseName).collection('identity');
    for (const account of await collection.find({ profiles: { $exists: true } }).toArray()) {
      let changed = false;
      const profiles = (account.profiles || []).map(profile => {
        const library = profile.library;
        if (!library) return profile;
        const nextSeries = (library.series_last_watched || [])
          .map(record => compactRecord(record, 'series', account)).filter(Boolean);
        const nextKinds = {
          episode: compactRecord(library.last_kinds_watched?.episode, 'series', account),
          movie: compactRecord(library.last_kinds_watched?.movie, 'movie', account),
          live: compactRecord(library.last_kinds_watched?.live, 'live', account),
        };
        const candidates = [
          ...(Array.isArray(library.streaming_history) ? library.streaming_history : []).map(record => compactRecord(record, record?.providerIdentity?.kind === 'channel' ? 'live' : record?.providerIdentity?.kind === 'series' ? 'series' : 'movie', account)),
          ...nextSeries,
          ...Object.values(nextKinds),
        ].filter(Boolean);
        const historyByIdentity = new Map();
        for (const record of candidates) {
          const identity = record.providerIdentity;
          const key = `${identity.sourceId}:${identity.kind}:${identity.itemId}`;
          const previous = historyByIdentity.get(key);
          if (!previous || new Date(record.updatedAt || 0) >= new Date(previous.updatedAt || 0)) historyByIdentity.set(key, record);
        }
        const nextHistory = [...historyByIdentity.values()].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        if (JSON.stringify(nextSeries) !== JSON.stringify(library.series_last_watched || [])
          || JSON.stringify(nextKinds) !== JSON.stringify(library.last_kinds_watched || {})
          || JSON.stringify(nextHistory) !== JSON.stringify(library.streaming_history || [])) changed = true;
        return { ...profile, library: { ...library, streaming_history: nextHistory, series_last_watched: nextSeries, last_kinds_watched: nextKinds } };
      });
      if (changed) {
        await collection.updateOne({ _id: account._id }, { $set: { profiles, updatedAt: new Date() } });
        migrated++;
      }
    }
  }
} finally {
  await client.close();
}
console.log(JSON.stringify({ migrated }));
