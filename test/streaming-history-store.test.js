import test from 'node:test';
import assert from 'node:assert/strict';
import { isContinueWatchingItem } from '../streaming-history-store.js';

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
