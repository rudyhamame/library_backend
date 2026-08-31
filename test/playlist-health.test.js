import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlaylistSources, summarizePlaylistHealth } from '../playlist-health.js';

test('playlist health distinguishes setup, connected, degraded, and offline states', () => {
  assert.equal(summarizePlaylistHealth([]).status, 'not_saved');
  assert.equal(summarizePlaylistHealth([{ ok: true }]).status, 'online');
  assert.equal(summarizePlaylistHealth([{ ok: true }, { ok: false }]).status, 'degraded');
  assert.equal(summarizePlaylistHealth([{ ok: false }]).status, 'offline');
});

test('playlist health checks the provider instead of treating a saved record as online', async () => {
  const health = await checkPlaylistSources(
    [{ _id: 'good' }, { _id: 'bad' }],
    async source => { if (source._id === 'bad') throw new Error('credentials rejected'); },
  );
  assert.deepEqual({ status: health.status, total: health.total, online: health.online, failed: health.failed }, {
    status: 'degraded', total: 2, online: 1, failed: 1,
  });
  assert.equal(health.results[1].error, 'credentials rejected');
});
