import test from 'node:test';
import assert from 'node:assert/strict';
import { isStreamingOnlyPath } from '../library-route-policy.js';

test('keeps library, account, device, and catalog APIs on the library backend', () => {
  const allowed = [
    '/api/health',
    '/api/account/login',
    '/api/roku/bootstrap',
    '/api/roku/device-session',
    '/api/roku/dashboard',
    '/api/playback/history',
    '/api/favorites',
    '/api/library/categories',
    '/api/xtream/sources',
    '/api/xtream/catalog',
    '/api/xtream/stream-ticket/source/channel/42',
  ];
  for (const path of allowed) assert.equal(isStreamingOnlyPath(path), false, path);
});

test('rejects every media-delivery surface from the library backend', () => {
  const blocked = [
    '/api/xtream/play/source/channel/42',
    '/api/xtream/hls/source/movie/42/master.m3u8',
    '/api/xtream/hls/source/series/42/segment-000001.ts',
    '/api/xtream/roku/source/channel/42',
    '/internal/media-health',
  ];
  for (const path of blocked) assert.equal(isStreamingOnlyPath(path), true, path);
});

test('matches streaming prefixes without blocking similar control-plane paths', () => {
  assert.equal(isStreamingOnlyPath('/api/xtream/playback-settings'), false);
  assert.equal(isStreamingOnlyPath('/api/xtream/hls-settings'), false);
  assert.equal(isStreamingOnlyPath('/api/xtream/play/source/channel/42?token=redacted'), true);
});
