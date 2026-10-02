import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientPresence } from '../client-presence.js';

test('presence matches the exact account and selected profile, including clients sharing an ID', () => {
  const presence = createClientPresence();
  presence.record('account-a', 'profile-a', 'browser-1');
  assert.equal(presence.online('account-a', 'profile-a'), true);
  assert.equal(presence.online('account-a'), true);
  assert.equal(presence.online('account-a', 'profile-b'), false);
  assert.equal(presence.online('account-b', 'profile-a'), false);
  presence.record('account-b', 'profile-b', 'browser-1');
  assert.equal(presence.online('account-a', 'profile-a'), true);
  assert.equal(presence.online('account-b', 'profile-b'), true);
});

test('heartbeats renew presence and closing the client allows it to expire', () => {
  let time = 0;
  const presence = createClientPresence({ now: () => time });
  presence.record('account', 'profile', 'android-1');
  time = 20_000;
  presence.record('account', 'profile', 'android-1');
  time = 40_000;
  assert.equal(presence.online('account', 'profile'), true);
  time = 50_001;
  assert.equal(presence.online('account', 'profile'), false);
});

test('unselected profiles do not report presence and the temporary cache is bounded', () => {
  const presence = createClientPresence({ maxEntries: 2 });
  presence.record('account', '', 'client');
  assert.equal(presence.online('account'), false);
  for (const id of ['one', 'two', 'three']) presence.record(id, 'profile', 'client');
  assert.equal(presence.online('one'), false);
  assert.equal(presence.online('two'), true);
  assert.equal(presence.online('three'), true);
});
