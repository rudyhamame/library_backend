import test from 'node:test';
import assert from 'node:assert/strict';
import { isContinueWatchingItem, kindRecord, seriesHistoryKey } from '../streaming-history-store.js';

test('last_kinds_watched stores provider identity and playback state only', () => {
  const record = kindRecord({
    itemId: 'movie-1',
    sourceId: 'provider-1',
    seriesId: '',
    providerUrl: 'http://provider.example/movie/movie-1.mkv',
    sessionId: 'session-1',
    lastMoment: '00:22:00',
    completed: false,
    updatedAt: '2026-09-19T00:00:00.000Z',
    title: 'Provider metadata must not be stored',
    poster: 'https://example.invalid/poster.jpg',
  });
  assert.deepEqual(record, {
    providerURL: 'http://provider.example/movie/movie-1.mkv',
    providerIdentity: { sourceId: 'provider-1', kind: 'movie', itemId: 'movie-1', seriesId: '' },
    lastWatched: '00:22:00',
  });
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
