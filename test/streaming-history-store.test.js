import test from 'node:test';
import assert from 'node:assert/strict';
import { isContinueWatchingItem, kindRecord, removeStreamingHistoryItemFromLibrary, seriesHistoryKey } from '../streaming-history-store.js';

test('streaming history stores provider identity in one nested object and never stores provider URLs', () => {
  const record = kindRecord({
    itemId: 'movie-1',
    sourceId: 'provider-1',
    seriesId: '',
    providerUrl: 'http://provider.example/movie/movie-1.mkv',
    sessionId: 'session-1',
    lastMoment: '00:22:00',
    completed: false,
    updatedAt: '2026-09-19T00:00:00.000Z',
    kind: 'movie',
    title: 'Real provider title',
    seriesName: '',
    extension: 'mkv',
    poster: 'https://example.invalid/poster.jpg',
    category: 'Drama',
    seasonNumber: '',
    episodeNumber: '',
    endPositionMs: 1_320_000,
    mediaDurationMs: 7_200_000,
  });
  assert.deepEqual(record, {
    updatedAt: '2026-09-19T00:00:00.000Z',
    sessionId: 'session-1',
    startedAt: undefined,
    startPositionMs: 0,
    endPositionMs: 1_320_000,
    streamingDurationMs: 0,
    lastWatched: '00:22:00',
    mediaDurationMs: 7_200_000,
    providerIdentity: { itemId: 'movie-1', kind: 'movie', sourceId: 'provider-1' },
  });
  assert.equal('providerURL' in record, false);
  assert.equal('providerUrl' in record, false);
  for (const field of ['itemId', 'kind', 'sourceId', 'seriesId']) assert.equal(field in record, false);
});

const episode = {
  kind: 'series', sourceId: 'provider-1', itemId: 'episode-1',
  endPositionMs: 2628, mediaDurationMs: 3_643_000,
};

test('Continue Watching includes a title as soon as playback has started', () => {
  assert.equal(isContinueWatchingItem(episode), true);
});

test('Continue Watching excludes completed and near-end VOD', () => {
  assert.equal(isContinueWatchingItem({ ...episode, completed: true }), false);
  assert.equal(isContinueWatchingItem({ ...episode, endPositionMs: 3_620_000 }), false);
});

test('Continue Watching keeps the last live channel', () => {
  assert.equal(isContinueWatchingItem({ kind: 'channel', sourceId: 'provider-1', itemId: 'channel-1', completed: true }), true);
});

test('Continue Watching accepts pivot-era providerURL-only episode and movie records', () => {
  assert.equal(isContinueWatchingItem({
    providerURL: { sourceId: 'provider-1', itemId: 'episode-1', seriesId: 'series-1' },
    lastWatched: '00:12:00',
    mediaDurationMs: 3_643_000,
  }), true);
  assert.equal(isContinueWatchingItem({
    providerURL: { sourceId: 'provider-1', itemId: 'movie-1' },
    lastWatched: '00:22:00',
    mediaDurationMs: 7_200_000,
  }), true);
});

test('last watched episode state is keyed independently for every provider series', () => {
  assert.notEqual(seriesHistoryKey('provider-1', 'series-1'), seriesHistoryKey('provider-1', 'series-2'));
  assert.notEqual(seriesHistoryKey('provider-1', 'series-1'), seriesHistoryKey('provider-2', 'series-1'));
});

test('removing a watched episode deletes only that provider episode, not its favorite series', () => {
  const library = { streaming_history: { series: [
    { providerIdentity: { sourceId: 'provider-1', kind: 'series', seriesId: 'series-1' }, episodes: [
      { providerIdentity: { itemId: 'episode-1' } },
      { providerIdentity: { itemId: 'episode-2' } },
    ] },
    { providerIdentity: { sourceId: 'provider-1', kind: 'series', seriesId: 'series-2' }, episodes: [
      { providerIdentity: { itemId: 'episode-1' } },
    ] },
    { providerIdentity: { sourceId: 'provider-2', kind: 'series', seriesId: 'series-1' }, episodes: [
      { providerIdentity: { itemId: 'episode-1' } },
    ] },
  ] } };
  assert.equal(removeStreamingHistoryItemFromLibrary(library, {
    sourceId: 'provider-1', seriesId: 'series-1', itemId: 'episode-1', kind: 'episode',
  }), 1);
  assert.deepEqual(library.streaming_history.series.map(group => group.episodes.map(row => row.providerIdentity.itemId)), [
    ['episode-2'], ['episode-1'], ['episode-1'],
  ]);
});

test('Watched movie and live deletion preserves other providers and unrelated records', () => {
  for (const [kind, bucket] of [['movie', 'movies'], ['channel', 'live']]) {
    const row = (sourceId, itemId) => ({ providerIdentity: { sourceId, itemId, kind } });
    const library = { streaming_history: { series: [], movies: [], live: [] } };
    library.streaming_history[bucket] = [row('provider-1', '161123'), row('provider-2', '161123'), row('provider-1', 'keep')];
    const identity = { sourceId: 'provider-1', itemId: '161123', kind };
    assert.equal(removeStreamingHistoryItemFromLibrary(library, identity), 1);
    assert.equal(removeStreamingHistoryItemFromLibrary(library, identity), 0);
    assert.deepEqual(library.streaming_history[bucket].map(x => x.providerIdentity), [row('provider-2', '161123').providerIdentity, row('provider-1', 'keep').providerIdentity]);
  }
});

test('a Watched series row removes its episodes only within the selected provider', () => {
  const group = (sourceId, seriesId) => ({ providerIdentity: { sourceId, seriesId, kind: 'series' }, episodes: [{ providerIdentity: { itemId: 'e1' } }, { providerIdentity: { itemId: 'e2' } }] });
  const library = { streaming_history: { movies: [], live: [], series: [group('p1', 's1'), group('p2', 's1'), group('p1', 's2')] } };
  assert.equal(removeStreamingHistoryItemFromLibrary(library, { kind: 'series-search', sourceId: 'p1', seriesId: 's1', itemId: 'series-search:p1:s1' }), 2);
  assert.deepEqual(library.streaming_history.series.map(x => [x.providerIdentity.sourceId, x.providerIdentity.seriesId]), [['p2', 's1'], ['p1', 's2']]);
});
