import test from 'node:test';
import assert from 'node:assert/strict';
import { HlsStrategy, PlaybackStrategy, choosePlaybackStrategy, determineHlsStrategy } from '../playback-strategy.js';

test('keeps all movie and series playback on HLS', () => {
  assert.equal(choosePlaybackStrategy({ purpose: 'direct-proxy' }), HlsStrategy.REMUX);
});

test('uses remux for compatibility HLS and transcode only for previews', () => {
  assert.equal(choosePlaybackStrategy({ purpose: 'roku-hls' }), HlsStrategy.REMUX);
  assert.equal(choosePlaybackStrategy({ purpose: 'preview' }), PlaybackStrategy.TRANSCODE);
});

test('transcodes only the incompatible stream when metadata is available', () => {
  assert.deepEqual(determineHlsStrategy({ videoCodec: 'h264', audioCodec: 'ac3' }), {
    videoMode: 'copy', audioMode: 'transcode', reason: 'Audio codec ac3 is not compatible', outputProtocol: 'hls', strategy: HlsStrategy.PARTIAL_TRANSCODE,
  });
});
