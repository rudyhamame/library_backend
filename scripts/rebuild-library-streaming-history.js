// Rebuild the account/profile library's grouped streaming_history buckets from any
// legacy last_kinds_watched / series_last_watched fields and the old history
// collection. The migration is idempotent and deliberately keeps the old
// collection as a backup; it never deletes source history.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { accountOwnerId } from '../account-library-owner.js';
import { allAccountDocuments, closeAccountLibraryData, updateAccountLibrary } from '../account-library-data.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';
const historyCollectionName = process.env.MONGODB_STREAMING_HISTORY_COLLECTION || 'streaming_history';
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });

let profilesRebuilt = 0;
let legacyRowsImported = 0;
const unmappedOwners = [];

try {
  await client.connect();
  const seenProfiles = new Set();
  for (const { account } of await allAccountDocuments()) {
    const accountId = String(account._id || '');
    for (const profile of Array.isArray(account.profiles) ? account.profiles : []) {
      const ownerId = String(profile.ownerId || (profile.isDefault ? accountOwnerId(account._id) : ''));
      if (!ownerId) continue;
      const key = `${accountId}:${profile.id || ownerId}`;
      if (seenProfiles.has(key)) continue;
      seenProfiles.add(key);
      const rawLibrary = profile.library || {};
      const legacyRows = [
        ...(Array.isArray(rawLibrary.series_last_watched) ? rawLibrary.series_last_watched.map(row => ({ ...row, kind: row?.providerIdentity?.kind || row?.kind || 'series' })) : []),
        ...Object.entries(rawLibrary.last_kinds_watched || {}).filter(([, row]) => row).map(([bucket, row]) => ({
          ...row, kind: row?.providerIdentity?.kind || row?.kind || (bucket === 'episode' ? 'series' : bucket === 'live' ? 'channel' : 'movie'),
        })),
      ];
      await updateAccountLibrary(ownerId, library => {
        for (const row of legacyRows) {
          const identity = row.providerIdentity || {};
          const sourceId = String(identity.sourceId || row.sourceId || '');
          const itemId = String(identity.itemId || row.itemId || '');
          if (!sourceId || !itemId) continue;
          const rawKind = String(identity.kind || row.kind || 'movie').toLowerCase();
          const kind = ['channel', 'live'].includes(rawKind) ? 'channel' : (['series', 'episode'].includes(rawKind) ? 'series' : 'movie');
          const record = {
            ...row,
            providerIdentity: { sourceId, kind, itemId, seriesId: String(identity.seriesId || row.seriesId || '') },
          };
          delete record.sourceId; delete record.kind; delete record.itemId; delete record.seriesId; delete record.providerURL; delete record.providerUrl;
          const target = kind === 'channel' ? library.streaming_history.live : kind === 'series'
            ? (() => {
              const seriesId = record.providerIdentity.seriesId;
              let group = library.streaming_history.series.find(item => item.providerIdentity.sourceId === sourceId && item.providerIdentity.seriesId === seriesId);
              if (!group) { group = { providerIdentity: { sourceId, kind: 'series', seriesId }, episodes: [] }; library.streaming_history.series.push(group); }
              return group.episodes;
            })()
            : library.streaming_history.movies;
          const existingIndex = target.findIndex(item => item.providerIdentity?.itemId === itemId);
          const storedRecord = kind === 'series' ? { ...record, providerIdentity: { itemId } } : record;
          const existing = existingIndex >= 0 ? target[existingIndex] : null;
          if (!existing || new Date(storedRecord.updatedAt || 0) >= new Date(existing.updatedAt || 0)) {
            if (existingIndex >= 0) target[existingIndex] = storedRecord; else target.push(storedRecord);
          }
        }
        return library;
      }, String(profile.id || ''));
      profilesRebuilt++;
    }
  }

  const db = client.db(rokuDb);
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
  if (collections.has(historyCollectionName)) {
    for (const row of await db.collection(historyCollectionName).find({}).sort({ updatedAt: 1 }).toArray()) {
      const ownerId = String(row.ownerId || '');
      if (!ownerId) { unmappedOwners.push(String(row._id)); continue; }
      try {
        await updateAccountLibrary(ownerId, library => {
          const identity = row.providerIdentity || (row.providerURL && typeof row.providerURL === 'object' ? row.providerURL : {});
          const sourceId = String(identity.sourceId || row.sourceId || '');
          const itemId = String(identity.itemId || row.itemId || '');
          if (!sourceId || !itemId) return library;
          const rawKind = String(identity.kind || row.kind || 'movie').toLowerCase();
          const kind = ['channel', 'live'].includes(rawKind) ? 'channel' : (['series', 'episode'].includes(rawKind) ? 'series' : 'movie');
          const { _id, ownerId: _ownerId, itemId: _itemId, kind: _kind, sourceId: _sourceId, seriesId: _seriesId, providerIdentity: _providerIdentity, providerURL: _providerURL, providerUrl: _providerUrl, ...metadata } = row;
          const record = {
            ...metadata,
            ...(row.sessionId || identity.sessionId ? { sessionId: String(row.sessionId || identity.sessionId) } : {}),
            lastWatched: String(row.lastWatched || '00:00:00'),
            providerIdentity: { itemId, kind, sourceId, seriesId: String(identity.seriesId || row.seriesId || '') },
          };
          let records;
          if (kind === 'channel') records = library.streaming_history.live;
          else if (kind === 'movie') records = library.streaming_history.movies;
          else {
            const seriesId = record.providerIdentity.seriesId;
            let group = library.streaming_history.series.find(item => item.providerIdentity.sourceId === sourceId && item.providerIdentity.seriesId === seriesId);
            if (!group) { group = { providerIdentity: { sourceId, kind: 'series', seriesId }, episodes: [] }; library.streaming_history.series.push(group); }
            records = group.episodes;
          }
          const key = `${sourceId}:${kind}:${itemId}`;
          const index = records.findIndex(item => {
            const id = item.providerIdentity || {};
            if (kind === 'series') return String(id.itemId || '') === itemId;
            return `${id.sourceId || ''}:${id.kind || ''}:${id.itemId || ''}` === key;
          });
          const existing = index >= 0 ? records[index] : null;
          if (!existing || new Date(record.updatedAt || 0) >= new Date(existing.updatedAt || 0)) {
            const storedRecord = kind === 'series' ? { ...record, providerIdentity: { itemId } } : record;
            if (index >= 0) records[index] = storedRecord;
            else records.push(storedRecord);
          }
          return library;
        });
        legacyRowsImported++;
      } catch {
        unmappedOwners.push(ownerId);
      }
    }
  }

  console.log(JSON.stringify({ ok: unmappedOwners.length === 0, profilesRebuilt, legacyRowsImported, oldCollectionKept: collections.has(historyCollectionName), unmappedOwners }));
  if (unmappedOwners.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
} finally {
  await client.close();
  await closeAccountLibraryData();
}
