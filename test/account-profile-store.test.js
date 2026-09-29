import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ACCOUNT_PROFILES, hashProfilePin, normalizeProfileName, verifyProfilePin } from '../account-profile-store.js';
import { isCloudinaryProfileUrl } from '../cloudinary-upload.js';

test('only a real Cloudinary profile-image URL is treated as already uploaded', () => {
  assert.equal(isCloudinaryProfileUrl('https://res.cloudinary.com/dtoxkii3q/image/upload/v123/rh-stream/profiles/abc.jpg'), true);
  assert.equal(isCloudinaryProfileUrl('data:image/jpeg;base64,abcd'), false);
  assert.equal(isCloudinaryProfileUrl('https://evil.example/res.cloudinary.com/x'), false);
  assert.equal(isCloudinaryProfileUrl(''), false);
});

test('profile names are normalized and bounded', () => {
  assert.equal(normalizeProfileName('  Family   Room  '), 'Family Room');
  assert.equal(normalizeProfileName('rudy'), 'Rudy');
  assert.equal(normalizeProfileName('x'.repeat(50)).length, 30);
  assert.equal(normalizeProfileName('   '), '');
});

test('profiles have no configured account-wide count limit', () => {
  assert.equal(MAX_ACCOUNT_PROFILES, Number.POSITIVE_INFINITY);
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
