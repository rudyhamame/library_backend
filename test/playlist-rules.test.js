import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistRuleRuntime, defaultPlaylistRules, normalizePlaylistRules } from '../playlist-rules.js';

test('playlist rules default to disabled and clamp numeric values', () => {
  assert.ok(Object.values(defaultPlaylistRules()).every(rule => rule.enabled === false));
  const rules = normalizePlaylistRules({
    maxConcurrentStreams: { enabled: true, limit: 99 },
    retryLimit: { enabled: true, attempts: 0 },
  });
  assert.equal(rules.maxConcurrentStreams.limit, 10);
  assert.equal(rules.retryLimit.attempts, 1);
});

test('stream rules are isolated by provider', () => {
  const runtime = new PlaylistRuleRuntime();
  const rules = { streamStartCooldown: { enabled: true, seconds: 10 } };
  runtime.checkStreamStart({ _id: 'one', rules }, 100_000);
  assert.throws(() => runtime.checkStreamStart({ _id: 'one', rules }, 101_000), /wait 10 seconds/);
  assert.doesNotThrow(() => runtime.checkStreamStart({ _id: 'two', rules }, 101_000));
});

test('API request rule blocks only after the configured provider limit', () => {
  const runtime = new PlaylistRuleRuntime();
  const source = { _id: 'one', rules: { apiRequestRate: { enabled: true, limit: 2, windowSeconds: 60 } } };
  runtime.checkApiRequest(source, 100_000);
  runtime.checkApiRequest(source, 101_000);
  assert.throws(() => runtime.checkApiRequest(source, 102_000), /maximum 2 API requests/);
});
