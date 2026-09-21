import { MongoClient, ObjectId } from 'mongodb';
import { accountOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';
let clientPromise;

async function accountCollections() {
  if (!clientPromise) clientPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect().catch(error => { clientPromise = undefined; throw error; });
  const client = await clientPromise;
  return [client.db(rokuDb).collection('identity'), client.db(generalDb).collection('identity')];
}

export async function allAccountDocuments() {
  const rows = [];
  for (const collection of await accountCollections()) {
    for (const account of await collection.find({}).toArray()) rows.push({ collection, account });
  }
  return rows;
}

export function normalizedAccountLibrary(library) {
  const withoutProviderUrls = value => {
    if (Array.isArray(value)) return value.map(withoutProviderUrls);
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date || value._bsontype) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['providerURL', 'providerUrl'].includes(key)).map(([key, child]) => [key, withoutProviderUrls(child)]));
  };
  const legacyHistory = [
    ...(Array.isArray(library?.series_last_watched) ? library.series_last_watched : []),
    ...Object.entries(library?.last_kinds_watched || {}).filter(([, row]) => Boolean(row)).map(([bucket, row]) => ({
      ...row,
      kind: row.kind || (bucket === 'episode' ? 'series' : bucket === 'live' ? 'channel' : 'movie'),
    })),
  ];
  const existingHistory = Array.isArray(library?.streaming_history)
    ? library.streaming_history
    : [
      ...(Array.isArray(library?.streaming_history?.episodes) ? library.streaming_history.episodes : []),
      ...(Array.isArray(library?.streaming_history?.movies) ? library.streaming_history.movies : []),
      ...(Array.isArray(library?.streaming_history?.live) ? library.streaming_history.live : []),
    ];
  const historyRows = [...legacyHistory, ...existingHistory];
  const normalizeHistoryRecord = row => {
    if (!row || typeof row !== 'object') return null;
    const identity = row?.providerIdentity || (row?.providerURL && typeof row.providerURL === 'object' ? row.providerURL : {});
    const sourceId = String(identity.sourceId || row?.sourceId || '');
    const itemId = String(identity.itemId || row?.itemId || '');
    if (!sourceId || !itemId) return null;
    const kind = String(identity.kind || row?.kind || 'movie').toLowerCase();
    const { itemId: _itemId, kind: _kind, sourceId: _sourceId, seriesId: _seriesId, providerIdentity: _providerIdentity, providerURL: _providerURL, providerUrl: _providerUrl, ...metadata } = row;
    return {
      ...withoutProviderUrls(metadata),
      lastWatched: String(row?.lastWatched || '00:00:00'),
      ...(row?.sessionId || identity.sessionId ? { sessionId: String(row?.sessionId || identity.sessionId) } : {}),
      providerIdentity: {
        itemId,
        kind: ['live', 'channel'].includes(kind) ? 'channel' : (['series', 'episode'].includes(kind) ? 'series' : 'movie'),
        sourceId,
        seriesId: String(identity.seriesId || row?.seriesId || ''),
      },
    };
  };
  const byIdentity = new Map();
  for (const raw of historyRows) {
    const row = normalizeHistoryRecord(raw);
    if (!row) continue;
    const identity = row.providerIdentity;
    const key = `${identity.sourceId}:${identity.kind}:${identity.itemId}`;
    const previous = byIdentity.get(key);
    if (!previous || new Date(row.updatedAt || 0) >= new Date(previous.updatedAt || 0)) byIdentity.set(key, row);
  }
  const streamingHistory = { episodes: [], movies: [], live: [] };
  for (const row of [...byIdentity.values()].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))) {
    const kind = row.providerIdentity.kind;
    const bucket = kind === 'channel' ? 'live' : (kind === 'series' ? 'episodes' : 'movies');
    streamingHistory[bucket].push(row);
  }
  return {
    favorites: Array.isArray(library?.favorites) ? withoutProviderUrls(library.favorites) : [],
    savedSelections: {
      series: Array.isArray(library?.savedSelections?.series) ? withoutProviderUrls(library.savedSelections.series) : [],
      movies: Array.isArray(library?.savedSelections?.movies) ? withoutProviderUrls(library.savedSelections.movies) : [],
      live: Array.isArray(library?.savedSelections?.live) ? withoutProviderUrls(library.savedSelections.live) : [],
    },
    series_last_watched: Array.isArray(library?.series_last_watched) ? library.series_last_watched.map(normalizeHistoryRecord).filter(Boolean) : [],
    streaming_history: streamingHistory,
    last_kinds_watched: {
      episode: normalizeHistoryRecord(library?.last_kinds_watched?.episode ? { ...library.last_kinds_watched.episode, kind: library.last_kinds_watched.episode.kind || 'series' } : null) || null,
      movie: normalizeHistoryRecord(library?.last_kinds_watched?.movie ? { ...library.last_kinds_watched.movie, kind: library.last_kinds_watched.movie.kind || 'movie' } : null) || null,
      live: normalizeHistoryRecord(library?.last_kinds_watched?.live ? { ...library.last_kinds_watched.live, kind: library.last_kinds_watched.live.kind || 'channel' } : null) || null,
    },
  };
}

export async function accountForLibraryOwner(ownerId) {
  const key = String(ownerId || '');
  if (!key) throw new Error('Account library owner is required');
  for (const collection of await accountCollections()) {
    const account = await collection.findOne({ $or: [{ ownerId: key }, { 'profiles.ownerId': key }] });
    if (account) return { collection, account };
  }
  // Pre-migration accounts may not have an ownerId field yet. Resolve only
  // when their deterministic account owner matches; never choose another user.
  for (const collection of await accountCollections()) {
    const rows = await collection.find({}, { projection: { _id: 1 } }).toArray();
    const match = rows.find(row => accountOwnerId(row._id) === key);
    if (match) return { collection, account: await collection.findOne({ _id: match._id }) };
  }
  throw Object.assign(new Error('Account library not found'), { status: 404 });
}

function selectedProfile(account, ownerId, profileId = '') {
  const profiles = Array.isArray(account.profiles) ? account.profiles : [];
  if (profileId) return profiles.find(row => row.id === String(profileId));
  if (String(ownerId) === accountOwnerId(account._id)) return profiles.find(row => row.isDefault === true);
  return profiles.find(row => row.ownerId === String(ownerId));
}

export async function getAccountLibrary(ownerId, profileId = '') {
  const { account } = await accountForLibraryOwner(ownerId);
  const profile = selectedProfile(account, ownerId, profileId);
  if (!profile) throw Object.assign(new Error('Profile library not found'), { status: 404 });
  return normalizedAccountLibrary(profile.library);
}

export async function updateAccountLibrary(ownerId, change, profileId = '') {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { collection, account } = await accountForLibraryOwner(ownerId);
    const profile = selectedProfile(account, ownerId, profileId);
    if (!profile) throw Object.assign(new Error('Profile library not found'), { status: 404 });
    const before = normalizedAccountLibrary(profile.library);
    const next = await change(structuredClone(before));
    if (!next) return { library: before, changed: false };
    const filter = { _id: account._id, profiles: { $elemMatch: { id: profile.id, library: profile.library === undefined ? { $exists: false } : profile.library } } };
    const result = await collection.updateOne(filter, { $set: { 'profiles.$.library': normalizedAccountLibrary(next), 'profiles.$.updatedAt': new Date(), updatedAt: new Date() } });
    if (result.modifiedCount) return { library: normalizedAccountLibrary(next), changed: true };
  }
  throw new Error('Account library changed concurrently. Please try again.');
}

export async function closeAccountLibraryData() {
  if (clientPromise) await (await clientPromise).close();
  clientPromise = undefined;
}
