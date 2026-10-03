import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../device-sessions.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function changeRokuAccountPassword(');
const end = source.indexOf('export async function deleteAccount(', start);
const accountId = '0123456789abcdef01234567';

function harness(session, { linked = true, matchedCount = 1 } = {}) {
  const writes = [];
  class ObjectId {
    constructor(id) { this.id = id; }
    static isValid(id) { return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id); }
  }
  const context = vm.createContext({
    ObjectId, Date,
    resolveDeviceToken: token => token === 'signed-token' ? session : null,
    isRokuSessionLinked: async () => linked,
    validPassword: value => typeof value === 'string' && value.length >= 8 && value.length <= 256,
    hashPassword: value => `hashed:${value}`,
    accounts: async realm => {
      assert.equal(realm, 'roku');
      return { updateOne: async (filter, update) => { writes.push({ filter, update }); return { matchedCount }; } };
    },
  });
  vm.runInContext(source.slice(start, end).replace('export async', 'async'), context);
  return { change: context.changeRokuAccountPassword, writes };
}

const roku = { type: 'roku', realm: 'roku', accountId, deviceId: 'linked-device' };

test('linked Roku changes only its account password without the old password', async () => {
  const { change, writes } = harness(roku);
  assert.equal((await change('signed-token', 'new-password')).ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filter._id.id, accountId);
  assert.equal(writes[0].filter.rokuDeviceId, 'linked-device');
  assert.equal(writes[0].update.$set.passwordHash, 'hashed:new-password');
});

test('unsigned, wrong client/realm, and unlinked sessions cannot change passwords', async () => {
  for (const session of [null, { ...roku, type: 'browser' }, { ...roku, realm: 'general' }, { ...roku, accountId: 'invalid' }]) {
    const { change, writes } = harness(session);
    assert.match((await change('signed-token', 'new-password')).error, /^Sign in/);
    assert.equal(writes.length, 0);
  }
  const { change, writes } = harness(roku, { linked: false });
  assert.match((await change('signed-token', 'new-password')).error, /^Sign in/);
  assert.equal(writes.length, 0);
  const invalidToken = harness(roku);
  assert.match((await invalidToken.change('forged-token', 'new-password')).error, /^Sign in/);
  assert.equal(invalidToken.writes.length, 0);
});

test('invalid passwords cannot write and concurrent unlink cannot report success', async () => {
  const { change, writes } = harness(roku);
  for (const value of [undefined, '', 'short', 'x'.repeat(257)]) {
    assert.match((await change('signed-token', value)).error, /8 to 256/);
  }
  assert.equal(writes.length, 0);
  assert.match((await harness(roku, { matchedCount: 0 }).change('signed-token', 'new-password')).error, /^Sign in/);
});
