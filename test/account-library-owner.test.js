import test from 'node:test';
import assert from 'node:assert/strict';
import { accountOwnerId, canonicalSessionOwner, profileOwnerId } from '../account-library-owner.js';

const accountId = '64b64c50f0b7d15f02c8a001';

test('uses one deterministic library owner for every device on an account', () => {
  const expected = accountOwnerId(accountId);
  assert.equal(canonicalSessionOwner({ ownerId: 'roku-one', deviceId: 'one', accountId }), expected);
  assert.equal(canonicalSessionOwner({ ownerId: 'roku-two', deviceId: 'two', accountId }), expected);
  assert.equal(canonicalSessionOwner({ ownerId: 'browser', accountId }), expected);
});

test('keeps the device owner only before a device is linked to an account', () => {
  assert.equal(canonicalSessionOwner({ ownerId: 'unlinked-roku' }), 'unlinked-roku');
});

test('uses an isolated signed owner scope when a profile is selected', () => {
  const profileOwner = profileOwnerId(accountId, 'profile-two');
  assert.notEqual(profileOwner, accountOwnerId(accountId));
  assert.equal(canonicalSessionOwner({ accountId, profileId: 'profile-two', ownerId: profileOwner }), profileOwner);
});
