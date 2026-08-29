import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackStrategy, choosePlaybackStrategy } from '../playback-strategy.js';

test('keeps range-capable proxy playback on the direct path', () => {
  assert.equal(choosePlaybackStrategy({ purpose: 'direct-proxy' }), PlaybackStrategy.DIRECT);
});

test('uses remux for compatibility HLS and transcode only for previews', () => {
  assert.equal(choosePlaybackStrategy({ purpose: 'roku-hls' }), PlaybackStrategy.REMUX);
  assert.equal(choosePlaybackStrategy({ purpose: 'preview' }), PlaybackStrategy.TRANSCODE);
});
