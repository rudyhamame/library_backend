import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistRuleRuntime, defaultPlaylistRules, normalizePlaylistRules, providerLineIdentity } from '../playlist-rules.js';

test('playlist rules default to disabled (except the hard one-stream-per-provider rule) and clamp numeric values', () => {
  const defaults = defaultPlaylistRules();
  assert.ok(Object.entries(defaults).every(([name, rule]) => name === 'maxConcurrentStreams' || rule.enabled === false));
  // Server-level rule: a provider line permits one connection, enforced by a
  // cross-process lease, so this defaults ON (see PROVIDER_STREAM_LIMIT).
  assert.equal(defaults.maxConcurrentStreams.enabled, true);
  assert.equal(defaults.maxConcurrentStreams.limit, 1);
  // A per-source override can never exceed the global PROVIDER_STREAM_LIMIT
  // ceiling (1 by default) - that ceiling is the whole point of the rule.
  const rules = normalizePlaylistRules({
    maxConcurrentStreams: { enabled: true, limit: 99 },
    retryLimit: { enabled: true, attempts: 0 },
  });
  assert.equal(rules.maxConcurrentStreams.limit, 1);
  assert.equal(rules.retryLimit.attempts, 1);
});

test('stream rules are isolated by provider', () => {
  const runtime = new PlaylistRuleRuntime();
  const rules = { streamStartCooldown: { enabled: true, seconds: 10 } };
  runtime.checkStreamStart({ _id: 'one', rules }, 100_000);
  assert.throws(() => runtime.checkStreamStart({ _id: 'one', rules }, 101_000), /wait 10 seconds/);
  assert.doesNotThrow(() => runtime.checkStreamStart({ _id: 'two', rules }, 101_000));
});

test('strictSharedLine hard-forces maxConcurrentStreams to a single slot, overriding any configured limit', () => {
  const rules = normalizePlaylistRules({
    strictSharedLine: { enabled: true },
    maxConcurrentStreams: { enabled: false, limit: 99 },
  });
  assert.equal(rules.maxConcurrentStreams.enabled, true);
  assert.equal(rules.maxConcurrentStreams.limit, 1);
});

test('providerLineIdentity groups two source documents on the same provider line together', () => {
  const ownerA = { baseUrl: 'http://line.example.com/', username: 'Cea86e90Da' };
  const ownerB = { baseUrl: 'http://LINE.example.com', username: 'cea86e90da' };
  assert.equal(providerLineIdentity(ownerA), providerLineIdentity(ownerB));
});

test('API request rule blocks only after the configured provider limit', () => {
  const runtime = new PlaylistRuleRuntime();
  const source = { _id: 'one', rules: { apiRequestRate: { enabled: true, limit: 2, windowSeconds: 60 } } };
  runtime.checkApiRequest(source, 100_000);
  runtime.checkApiRequest(source, 101_000);
  assert.throws(() => runtime.checkApiRequest(source, 102_000), /maximum 2 API requests/);
});
