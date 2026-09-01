import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ACCOUNT_PROFILES, normalizeProfileName } from '../account-profile-store.js';

test('profile names are normalized and bounded', () => {
  assert.equal(normalizeProfileName('  Family   Room  '), 'Family Room');
  assert.equal(normalizeProfileName('x'.repeat(50)).length, 30);
  assert.equal(normalizeProfileName('   '), '');
});

test('profile limits remain suitable for a chooser grid', () => {
  assert.ok(MAX_ACCOUNT_PROFILES >= 2);
  assert.ok(MAX_ACCOUNT_PROFILES <= 8);
});
