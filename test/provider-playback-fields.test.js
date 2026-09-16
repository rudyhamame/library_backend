import test from 'node:test';
import assert from 'node:assert/strict';
import { providerPlaybackUrlIsUsable, resolveProviderMediaId, resolveProviderTitle } from '../provider-playback-fields.js';
import { continueWatchingEpisodeNumber, continueWatchingSeriesSearchTitle } from '../provider-catalog-store.js';

test('recovers live, movie, series, and episode IDs from provider-shaped rows', () => {
  assert.equal(resolveProviderMediaId({ id: 'undefined', stream_id: 10836 }, 'channel'), '10836');
  assert.equal(resolveProviderMediaId({ itemId: 22 }, 'movie'), '22');
  assert.equal(resolveProviderMediaId({ series_id: 33 }, 'series'), '33');
  assert.equal(resolveProviderMediaId({ episode_id: 44, series_id: 33 }, 'episode'), '44');
  assert.equal(resolveProviderMediaId({ key: 'movie:55' }, 'movie'), '55');
});

test('rejects stale provider URLs containing undefined media IDs', () => {
  assert.equal(providerPlaybackUrlIsUsable('http://provider/live/user/pass/undefined.m3u8'), false);
  assert.equal(providerPlaybackUrlIsUsable('http://provider/movie/user/pass/null.mp4'), false);
  assert.equal(providerPlaybackUrlIsUsable('http://provider/series/user/pass/44.mp4'), true);
});

test('recovers missing provider names without displaying undefined', () => {
  assert.equal(resolveProviderTitle({ name: 'News' }, 'channel', '1'), 'News');
  assert.equal(resolveProviderTitle({ title: 'undefined' }, 'series', '33'), 'Series 33');
});

test('matches a Continue Watching episode title to its parent series artwork', () => {
  assert.equal(continueWatchingSeriesSearchTitle('The Series (E12)'), 'The Series');
  assert.equal(continueWatchingSeriesSearchTitle('The Series [E12]'), 'The Series');
  assert.equal(continueWatchingSeriesSearchTitle('The Series (12)'), 'The Series');
});

test('recovers the Continue Watching episode number for Roku badges', () => {
  assert.equal(continueWatchingEpisodeNumber({ title: 'The Series (E12)' }), 12);
  assert.equal(continueWatchingEpisodeNumber({ title: 'The Series [E7]' }), 7);
  assert.equal(continueWatchingEpisodeNumber({ title: 'The Series - S02.E04' }), 4);
});
