import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { arabicSearchRegexSource, normalizeArabicSearch } from './arabic-search.js';
import { catalogFreshness, requireCatalogRows } from './catalog-freshness.js';

// MongoDB-backed snapshot of a provider's catalog. It exists to keep provider
// traffic low: a category is downloaded from the provider at most once per TTL
// window (see server.js), no matter how much the clients browse or scroll, and
// the last good snapshot keeps being served when the provider blocks or errors.
// There is no timer/cron - refreshes are only triggered lazily by a real
// client request for a stale kind.

// Category names / titles kept out of browsing, search and rails entirely -
// not just the Welcome backdrop - so the app never lists or surfaces adult
// content (Play Store policy: this is a general streaming app, not one whose
// purpose is adult material).
export const ADULT_RE = /adult|\bxxx\b|(?:^|\D)18\s*\+|\+\s*18|\bporn|erotic|\bsex\b|hentai|onlyfans|للكبار|للبالغين|إباح/i;

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_PROVIDER_CATALOG_COLLECTION || 'provider_catalog_items';
const metaCollectionName = process.env.MONGODB_PROVIDER_CATALOG_SYNC_COLLECTION || 'provider_catalog_syncs';
const mediaCollectionName = process.env.MONGODB_PROVIDER_MEDIA_METADATA_COLLECTION || 'provider_media_metadata';
const seriesEpisodeCollectionName = process.env.MONGODB_PROVIDER_SERIES_EPISODE_COLLECTION || 'provider_series_episodes';
let collectionsPromise;

async function collections() {
  if (!collectionsPromise) {
    collectionsPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
      .then(async client => {
        const database = client.db(databaseName);
        const items = database.collection(collectionName);
        const meta = database.collection(metaCollectionName);
        const media = database.collection(mediaCollectionName);
        const seriesEpisodes = database.collection(seriesEpisodeCollectionName);
        await Promise.all([
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, key: 1 }, { unique: true }),
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, addedSort: -1, providerOrder: -1 }),
          items.createIndex({ ownerId: 1, sourceId: 1, kind: 1, categoryId: 1, providerOrder: 1 }),
          meta.createIndex({ ownerId: 1, sourceId: 1 }, { unique: true }),
          media.createIndex({ ownerId: 1, sourceId: 1, kind: 1, id: 1 }, { unique: true }),
          seriesEpisodes.createIndex({ ownerId: 1, sourceId: 1, seriesId: 1 }, { unique: true }),
        ]);
        return { items, meta, media, seriesEpisodes };
      })
      .catch(error => { collectionsPromise = undefined; throw error; });
  }
  return collectionsPromise;
}

const cleanItem = (item, sourceId, providerName) => ({
  key: String(item?.key || ''),
  id: String(item?.id || ''),
  kind: String(item?.kind || ''),
  title: String(item?.title || ''),
  categoryId: String(item?.categoryId || ''),
  category: String(item?.category || item?.categoryName || ''),
  logo: String(item?.logo || ''),
  providerUrl: String(item?.providerUrl || ''),
  extension: String(item?.extension || ''),
  duration: String(item?.duration || ''),
  rating: String(item?.rating || ''),
  added: String(item?.added || ''),
  metadata: item?.metadata && typeof item.metadata === 'object' ? item.metadata : {},
  sourceId: String(sourceId),
  providerName: String(providerName || 'Playlist'),
});

// Replace the stored rows for one provider/kind with a fresh provider snapshot.
export async function replaceProviderCatalog(ownerId, sourceId, providerName, kind, catalog) {
  requireCatalogRows(catalog);
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return 0;
  const { items, meta } = await collections();
  const syncToken = randomUUID();
  const syncedAt = new Date();
  const rows = (Array.isArray(catalog) ? catalog : []).map((item, providerOrder) => ({
    ...cleanItem({ ...item, kind }, sourceId, providerName),
    ownerId: String(ownerId), kind, providerOrder,
    addedSort: Number(item?.added || 0) || 0,
    syncToken, syncedAt,
  })).filter(item => item.key && item.id);
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    await items.bulkWrite(batch.map(item => ({ updateOne: {
      filter: { ownerId: item.ownerId, sourceId: item.sourceId, kind, key: item.key },
      update: { $set: item }, upsert: true,
    } })), { ordered: false });
  }
  await items.deleteMany({ ownerId: String(ownerId), sourceId: String(sourceId), kind, syncToken: { $ne: syncToken } });
  await meta.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { $set: {
      ownerId: String(ownerId), sourceId: String(sourceId), providerName: String(providerName || 'Playlist'),
      [`kinds.${kind}`]: { count: rows.length, syncedAt }, updatedAt: syncedAt,
    } },
    { upsert: true },
  );
  return rows.length;
}

// Persist the provider's category list (id + name) for one kind. Catalog rows
// carry only a category id, so names must be stored from get_*_categories.
export async function replaceProviderCatalogCategories(ownerId, sourceId, kind, categories) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return 0;
  const { meta } = await collections();
  const list = (Array.isArray(categories) ? categories : [])
    .map(entry => ({ id: String(entry?.id ?? ''), name: String(entry?.name ?? '').trim() || 'Other' }))
    .filter(entry => entry.id);
  await meta.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { $set: { [`categories.${kind}`]: { list, syncedAt: new Date() } } },
    { upsert: true },
  );
  return list.length;
}

// { kinds: { series: {count, syncedAt}, ... }, categories: { series: {list, syncedAt} }, updatedAt }
export async function getProviderCatalogMeta(ownerId, sourceId) {
  if (!ownerId || !sourceId) return null;
  const { meta } = await collections();
  return meta.findOne({ ownerId: String(ownerId), sourceId: String(sourceId) }, { projection: { _id: 0 } });
}

export async function replaceProviderSeriesEpisodes(ownerId, sourceId, seriesId, title, episodes) {
  if (!ownerId || !sourceId || !seriesId) return 0;
  const { seriesEpisodes } = await collections();
  const rows = (Array.isArray(episodes) ? episodes : []).map(episode => ({
    ...episode,
    id: String(episode?.id || ''),
    providerUrl: String(episode?.providerUrl || ''),
  })).filter(episode => episode.id && episode.providerUrl);
  await seriesEpisodes.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId), seriesId: String(seriesId) },
    { $set: {
      ownerId: String(ownerId), sourceId: String(sourceId), seriesId: String(seriesId),
      title: String(title || ''), episodes: rows, updatedAt: new Date(),
    } },
    { upsert: true },
  );
  return rows.length;
}

export async function markProviderCatalogFailure(ownerId, sourceId, kind) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return;
  const { meta } = await collections();
  await meta.updateOne({ ownerId: String(ownerId), sourceId: String(sourceId) },
    { $set: { [`kinds.${kind}.lastErrorAt`]: new Date() } }, { upsert: true });
}

// The full stored row list for one provider/kind. The catalog endpoint keeps
// doing its own category/language/search filtering on this array.
export async function getProviderCatalogItems(ownerId, sourceId, kind) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items } = await collections();
  const blockedIds = await blockedCategoryIds(ownerId, sourceId, kind);
  const filter = excludeAdultContent({ ownerId: String(ownerId), sourceId: String(sourceId), kind }, blockedIds);
  return items
    .find(filter)
    .sort({ providerOrder: 1 })
    .project({ _id: 0, ownerId: 0, syncToken: 0, syncedAt: 0 })
    .toArray();
}

// Look a handful of stored items up by their provider ids, across kinds -
// used to re-hydrate favorites (which store only id/title) with the real
// logo/category from the snapshot at read time.
export async function getProviderCatalogItemsByIds(ownerId, sourceId, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!ownerId || !sourceId || wanted.length === 0) return [];
  const { items } = await collections();
  return items
    .find({ ownerId: String(ownerId), sourceId: String(sourceId), id: { $in: wanted } })
    .project({ _id: 0, ownerId: 0, syncToken: 0, syncedAt: 0 })
    .toArray();
}

// Streaming history identifies a played episode by its episode id, while the
// artwork in the provider catalog belongs to the parent series id. Hydrate the
// public Continue Watching payload from the catalog so every client receives
// the same canonical artwork instead of depending on whatever poster URL the
// player happened to save when playback started.
export const continueWatchingSeriesSearchTitle = value => String(value || '')
    .replace(/\s*\[E\s*\d+\]\s*$/i, '')
    .replace(/\s*\(\s*E?\s*\d+\s*\)\s*$/i, '')
    .replace(/\s*[•-]\s*S\d+\s*[._-]?\s*E\d+.*$/i, '')
    .replace(/^\s*[a-z0-9-]{1,12}\s*:\s*/i, '')
    .replace(/^\s*مسلسل\s+/u, '')
    .trim();
export const continueWatchingEpisodeNumber = item => {
  const explicit = Number.parseInt(String(item?.episodeNumber || ''), 10);
  if (explicit > 0) return explicit;
  const title = String(item?.title || '');
  const match = title.match(/(?:\[E\s*(\d+)\]|\(\s*E?\s*(\d+)\s*\)|[._-]E(\d+))/i);
  if (!match) return 0;
  return Number.parseInt(match[1] || match[2] || match[3] || '0', 10) || 0;
};
export async function hydrateContinueWatchingArtwork(ownerId, historyItems) {
  const history = Array.isArray(historyItems) ? historyItems : [];
  if (!ownerId || history.length === 0) return history;
  const seriesSearchTitle = continueWatchingSeriesSearchTitle;
  const seriesIdentity = value => normalizeArabicSearch(seriesSearchTitle(value));
  const references = history.map(item => {
    const isSeries = String(item?.kind || '') === 'series';
    const ref = {
      sourceId: String(item?.sourceId || ''),
      kind: isSeries ? 'series' : String(item?.kind || ''),
      // An episode id is not a series id. Using it here can silently select an
      // unrelated series whose id happens to equal the episode id.
      id: isSeries ? String(item?.seriesId || '') : String(item?.itemId || ''),
      title: isSeries && !item?.seriesId ? String(item?.title || '') : '',
    };
    return ref.sourceId && (ref.id || ref.title) && ['series', 'movie', 'channel'].includes(ref.kind) ? ref : null;
  });
  const validReferences = references.filter(Boolean);
  if (validReferences.length === 0) return history;
  const exactReferences = validReferences.filter(ref => ref.id);
  const titleReferences = validReferences.filter(ref => !ref.id && ref.kind === 'series' && ref.title);
  const exactQueries = [...new Map(exactReferences.map(ref => [`${ref.sourceId}:${ref.kind}:${ref.id}`, ref])).values()]
    .map(ref => ({ sourceId: ref.sourceId, kind: ref.kind, id: ref.id }));
  const titleQueries = [...new Map(titleReferences.map(ref => [`${ref.sourceId}:${seriesIdentity(ref.title)}`, ref])).values()]
    .map(ref => ({
      sourceId: ref.sourceId,
      kind: 'series',
      title: { $regex: arabicSearchRegexSource(seriesSearchTitle(ref.title)), $options: 'i' },
    }))
    .filter(query => query.title.$regex);
  const queries = [...exactQueries, ...titleQueries];
  if (queries.length === 0) return history;
  const { items, seriesEpisodes } = await collections();
  const rows = await items.find({ ownerId: String(ownerId), $or: queries }).project({ _id: 0, sourceId: 1, kind: 1, id: 1, title: 1, logo: 1 }).toArray();
  const catalogByItem = new Map(rows.map(row => [`${row.sourceId}:${row.kind}:${row.id}`, row]));
  const episodeRefs = history
    .filter(item => String(item?.kind || '') === 'series' && item?.sourceId && item?.seriesId && item?.itemId)
    .map(item => ({ sourceId: String(item.sourceId), seriesId: String(item.seriesId), itemId: String(item.itemId) }));
  const episodeDocs = episodeRefs.length > 0
    ? await seriesEpisodes.find({
      ownerId: String(ownerId),
      $or: [...new Map(episodeRefs.map(ref => [`${ref.sourceId}:${ref.seriesId}`, ref])).values()]
        .map(ref => ({ sourceId: ref.sourceId, seriesId: ref.seriesId })),
    }).project({ _id: 0, sourceId: 1, seriesId: 1, episodes: 1 }).toArray()
    : [];
  const episodeById = new Map();
  for (const doc of episodeDocs) {
    for (const episode of Array.isArray(doc.episodes) ? doc.episodes : []) {
      episodeById.set(`${doc.sourceId}:${doc.seriesId}:${String(episode.id || '')}`, episode);
    }
  }
  const unwrapSavedProxy = value => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, 'http://rh.local');
      if (parsed.pathname === '/api/xtream/logo' && parsed.searchParams.get('url')) return parsed.searchParams.get('url');
    } catch { /* keep the saved value */ }
    return raw;
  };
  return history.map((item, index) => {
    const ref = references[index];
    let catalog = ref?.id ? catalogByItem.get(`${ref.sourceId}:${ref.kind}:${ref.id}`) : null;
    if (!catalog && ref?.kind === 'series' && ref.title) {
      const wantedTitle = seriesIdentity(ref.title);
      const matches = rows.filter(row => row.sourceId === ref.sourceId && row.kind === 'series' && seriesIdentity(row.title) === wantedTitle);
      if (matches.length === 1) catalog = matches[0];
    }
    const catalogLogo = String(catalog?.logo || '').trim();
    const logo = catalogLogo || unwrapSavedProxy(item?.logo || item?.poster);
    const enriched = logo ? { ...item, logo, poster: logo } : { ...item };
    if (String(item?.kind || '') === 'series') {
      const episode = episodeById.get(`${item.sourceId}:${item.seriesId}:${item.itemId}`);
      if (episode) {
        const seasonNumber = Number.parseInt(String(episode.seasonNumber || ''), 10);
        const episodeNumber = Number.parseInt(String(episode.episodeNumber || ''), 10);
        if (seasonNumber > 0) enriched.seasonNumber = seasonNumber;
        if (episodeNumber > 0) enriched.episodeNumber = episodeNumber;
      }
    }
    if (String(item?.kind || '') === 'series' && catalog) {
      enriched.seriesId = String(catalog.id || item.seriesId || '');
      if (String(catalog.title || '').trim()) enriched.seriesTitle = String(catalog.title).trim();
      // Keep the parent artwork explicit so clients never have to guess
      // whether a generic history `poster` belongs to the episode or series.
      if (catalogLogo) enriched.seriesLogo = catalogLogo;
    }
    if (String(item?.kind || '') === 'series') {
      const episodeNumber = continueWatchingEpisodeNumber(item);
      if (episodeNumber > 0) enriched.episodeNumber = episodeNumber;
    }
    return enriched;
  });
}

// Resolve one provider item without loading a category (or the full snapshot)
// into application memory. Roku deep links carry provider IDs and must work
// even when the item has never been saved to the current profile's Library.
export async function getProviderCatalogItem(ownerId, sourceId, kind, id) {
  if (!ownerId || !sourceId || !id || !['series', 'movie', 'channel'].includes(kind)) return null;
  const { items } = await collections();
  return items.findOne(
    { ownerId: String(ownerId), sourceId: String(sourceId), kind, id: String(id) },
    { projection: { _id: 0, ownerId: 0, syncToken: 0, syncedAt: 0 } },
  );
}

// Write a resolved runtime back into the snapshot so it becomes the catalog of
// record - the next duration lookup for this title is then a plain read with no
// provider call. No-op when the title has no catalog row (e.g. a series episode).
export async function recordProviderCatalogDuration(ownerId, sourceId, kind, id, seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (!ownerId || !sourceId || !id || value <= 0) return;
  const h = Math.floor(value / 3600);
  const display = [h, Math.floor((value % 3600) / 60), value % 60].map(n => String(n).padStart(2, '0')).join(':');
  const { items } = await collections();
  await items.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId), kind: String(kind), id: String(id) },
    { $set: { duration: display } },
  );
}

// Persist codecs learned from a real media probe. Bulk Xtream catalog rows do
// not contain stream codec metadata, so the operations catalog fills these
// fields lazily and keeps the result across page loads/catalog refreshes.
export async function recordProviderCatalogCodecs(ownerId, sourceId, kind, id, videoCodec, audioCodec) {
  if (!ownerId || !sourceId || !id || !['movie', 'channel'].includes(String(kind))) return;
  const video = String(videoCodec || '').trim().toLowerCase();
  const audio = String(audioCodec || '').trim().toLowerCase();
  if (!video && !audio) return;
  const { items } = await collections();
  await items.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId), kind: String(kind), id: String(id) },
    { $set: { videoCodec: video, audioCodec: audio, codecsProbedAt: new Date() } },
  );
}

export async function getProviderMediaMetadata(ownerId, sourceId, kind, id) {
  if (!ownerId || !sourceId || !kind || !id) return null;
  const { media } = await collections();
  return media.findOne(
    { ownerId: String(ownerId), sourceId: String(sourceId), kind: String(kind), id: String(id) },
    { projection: { _id: 0, ownerId: 0 } },
  );
}

export async function getProviderMediaMetadataByIds(ownerId, sourceId, kind, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!ownerId || !sourceId || !kind || !wanted.length) return [];
  const { media } = await collections();
  return media.find({ ownerId: String(ownerId), sourceId: String(sourceId), kind: String(kind), id: { $in: wanted } })
    .project({ _id: 0, ownerId: 0 }).toArray();
}

export async function recordProviderMediaMetadata(ownerId, sourceId, kind, id, values = {}) {
  if (!ownerId || !sourceId || !kind || !id) return;
  const videoCodec = String(values.videoCodec || '').trim().toLowerCase();
  const audioCodec = String(values.audioCodec || '').trim().toLowerCase();
  const duration = String(values.duration || '').trim();
  if (!videoCodec && !audioCodec && !duration) return;
  const { media } = await collections();
  await media.updateOne(
    { ownerId: String(ownerId), sourceId: String(sourceId), kind: String(kind), id: String(id) },
    { $set: { videoCodec, audioCodec, duration, probedAt: new Date() } },
    { upsert: true },
  );
}

// Distinct two-letter title-prefix language codes ("DE - ...", "AR | ..."),
// computed entirely in MongoDB so the huge item set is never pulled into Node
// just to populate the language filter.
export async function getProviderCatalogLanguagePrefixes(ownerId, sourceId, kind) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items } = await collections();
  const rows = await items.aggregate([
    { $match: { ownerId: String(ownerId), sourceId: String(sourceId), kind } },
    { $project: { p: { $regexFind: { input: { $ifNull: ['$title', ''] }, regex: '^\\s*([A-Za-z]{2})\\s*[-|:]' } } } },
    { $group: { _id: { $arrayElemAt: ['$p.captures', 0] } } },
  ], { allowDiskUse: true }).toArray();
  return rows.map(row => (row._id ? String(row._id).toUpperCase() : 'OTHER'));
}

// Category ids whose stored name reads as adult/18+, for this owner/source/kind.
// Resolved from the category list (not the items) since that's where the
// human-readable name lives - items only carry the opaque categoryId.
async function blockedCategoryIds(ownerId, sourceId, kind) {
  const { meta } = await collections();
  const metaDoc = await meta.findOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { projection: { [`categories.${kind}`]: 1 } },
  );
  const stored = Array.isArray(metaDoc?.categories?.[kind]?.list) ? metaDoc.categories[kind].list : [];
  return stored.filter(entry => ADULT_RE.test(String(entry?.name || ''))).map(entry => String(entry.id || ''));
}

// Adds the adult-category and adult-title exclusions to a Mongo item filter.
// Title is also checked directly as a backstop for adult channels/titles that
// aren't neatly filed under a named adult category.
function excludeAdultContent(filter, blockedIds) {
  const clauses = [{ title: { $not: { $regex: ADULT_RE.source, $options: 'i' } } }];
  if (blockedIds.length) clauses.push({ categoryId: { $nin: blockedIds } });
  filter.$and = [...(filter.$and || []), ...clauses];
  return filter;
}

// Stored rows for one category (or 'all'), bounded so a huge provider never
// pulls hundreds of thousands of documents into the Roku response path.
export async function getProviderCatalogItemsForCategory(ownerId, sourceId, kind, categoryId, limit = 1500) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items } = await collections();
  const blockedIds = await blockedCategoryIds(ownerId, sourceId, kind);
  if (categoryId && String(categoryId) !== 'all' && blockedIds.includes(String(categoryId))) return [];
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId), kind };
  if (categoryId && String(categoryId) !== 'all') filter.categoryId = String(categoryId);
  excludeAdultContent(filter, blockedIds);
  const bounded = Math.max(1, Math.min(4000, Number(limit) || 1500));
  return items
    .find(filter)
    .sort({ providerOrder: 1 })
    .limit(bounded)
    .project({ _id: 0, ownerId: 0, syncToken: 0, syncedAt: 0 })
    .toArray();
}

// Newest N rows per kind for the Welcome rails, plus the sync/count metadata.
export async function getProviderCatalogRails(ownerId, sourceId, limit = 10) {
  const { items, meta } = await collections();
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId) };
  const projection = { _id: 0, ownerId: 0, syncToken: 0, addedSort: 0, providerOrder: 0, syncedAt: 0 };
  const [seriesBlocked, movieBlocked, channelBlocked, metaDoc] = await Promise.all([
    blockedCategoryIds(ownerId, sourceId, 'series'),
    blockedCategoryIds(ownerId, sourceId, 'movie'),
    blockedCategoryIds(ownerId, sourceId, 'channel'),
    meta.findOne(filter, { projection: { _id: 0 } }),
  ]);
  const [series, movie, channel] = await Promise.all([
    items.find(excludeAdultContent({ ...filter, kind: 'series' }, seriesBlocked)).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project(projection).toArray(),
    items.find(excludeAdultContent({ ...filter, kind: 'movie' }, movieBlocked)).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project(projection).toArray(),
    items.find(excludeAdultContent({ ...filter, kind: 'channel' }, channelBlocked)).sort({ addedSort: -1, providerOrder: -1 }).limit(boundedLimit).project(projection).toArray(),
  ]);
  return { series, movie, channel, updatedAt: metaDoc?.updatedAt || null, kinds: metaDoc?.kinds || {} };
}

// Stored category list joined with per-category item counts. [] until the
// provider's real category names have been persisted at least once. Adult
// categories are dropped here so they never appear as a browsable folder.
export async function getProviderCatalogCategories(ownerId, sourceId, kind) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) return [];
  const { items, meta } = await collections();
  const metaDoc = await meta.findOne(
    { ownerId: String(ownerId), sourceId: String(sourceId) },
    { projection: { [`categories.${kind}`]: 1 } },
  );
  const stored = Array.isArray(metaDoc?.categories?.[kind]?.list) ? metaDoc.categories[kind].list : [];
  if (!stored.length) return [];
  const counts = new Map((await items.aggregate([
    { $match: { ownerId: String(ownerId), sourceId: String(sourceId), kind } },
    { $group: { _id: '$categoryId', count: { $sum: 1 } } },
  ]).toArray()).map(row => [String(row._id || ''), row.count]));
  return stored
    .filter(entry => !ADULT_RE.test(String(entry?.name || '')))
    .map(entry => ({ id: String(entry.id || ''), name: String(entry.name || 'Other'), count: counts.get(String(entry.id || '')) || 0 }))
    .filter(entry => entry.id)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

// Every stored snapshot's metadata, across all owners/sources (dashboard use).
export async function listProviderCatalogMeta() {
  const { meta } = await collections();
  return meta.find({}, { projection: { _id: 0 } }).sort({ providerName: 1 }).toArray();
}

// Paginated stored rows for one owner/source/kind, optional category filter and
// title search - all done in MongoDB, sorted by title so page boundaries stay
// stable as the client loads more.
export async function queryProviderCatalogItems(ownerId, sourceId, kind, { q = '', categoryId = '', page = 1, limit = 50, extraFilters = [] } = {}) {
  if (!ownerId || !sourceId || !['series', 'movie', 'channel'].includes(kind)) {
    return { items: [], total: 0, page: 1, limit, pageCount: 1 };
  }
  const { items } = await collections();
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId), kind };
  const category = String(categoryId || '').trim();
  if (category && category !== 'all') filter.categoryId = category;
  const term = String(q || '').trim();
  if (term) {
    const source = arabicSearchRegexSource(term) || term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.title = { $regex: source, $options: 'i' };
  }
  const blockedIds = category && category !== 'all' ? [] : await blockedCategoryIds(ownerId, sourceId, kind);
  excludeAdultContent(filter, blockedIds);
  const fragments = (Array.isArray(extraFilters) ? extraFilters : []).filter(Boolean);
  if (fragments.length) filter.$and = [...filter.$and, ...fragments];
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const boundedPage = Math.max(1, Number(page) || 1);
  const total = await items.countDocuments(filter);
  const rows = await items.find(filter)
    .collation({ locale: 'en', numericOrdering: true })
    .sort({ title: 1, key: 1 })
    .skip((boundedPage - 1) * boundedLimit)
    .limit(boundedLimit)
    .project({ _id: 0, ownerId: 0, syncToken: 0, addedSort: 0, syncedAt: 0, providerOrder: 0 })
    .toArray();
  const metadata = await getProviderCatalogMeta(ownerId, sourceId);
  const ttl = Math.max(300000, Number.parseInt(process.env.CATALOG_SNAPSHOT_TTL_MS || '2700000', 10) || 2700000);
  return { items: rows, total, page: boundedPage, limit: boundedLimit, pageCount: Math.max(1, Math.ceil(total / boundedLimit)), ...catalogFreshness(metadata?.kinds?.[kind], ttl) };
}

export async function deleteProviderCatalog(ownerId, sourceId) {
  if (!ownerId || !sourceId) return;
  const { items, meta } = await collections();
  const filter = { ownerId: String(ownerId), sourceId: String(sourceId) };
  await Promise.all([items.deleteMany(filter), meta.deleteOne(filter)]);
}
