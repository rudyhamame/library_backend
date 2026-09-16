import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ACCOUNT_PROFILES, hashProfilePin, normalizeProfileName, verifyProfilePin } from '../account-profile-store.js';

test('profile names are normalized and bounded', () => {
  assert.equal(normalizeProfileName('  Family   Room  '), 'Family Room');
  assert.equal(normalizeProfileName('x'.repeat(50)).length, 30);
  assert.equal(normalizeProfileName('   '), '');
});

test('profile limits remain suitable for a chooser grid', () => {
  assert.ok(MAX_ACCOUNT_PROFILES >= 2);
  assert.ok(MAX_ACCOUNT_PROFILES <= 8);
});

test('profile PINs are salted, hashed, and require exactly four digits', () => {
  const first = hashProfilePin('1234');
  const second = hashProfilePin('1234');
  assert.notEqual(first, second);
  assert.equal(verifyProfilePin('1234', first), true);
  assert.equal(verifyProfilePin('4321', first), false);
  assert.equal(verifyProfilePin('12345', first), false);
  assert.equal(verifyProfilePin('abcd', first), false);
});
