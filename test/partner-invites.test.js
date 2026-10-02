import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const routes = source.slice(source.indexOf("app.post('/api/partner/invite'"), source.indexOf("app.post('/api/account/password'"));
function setup(linked = true) {
  const handlers = {}, invites = new Map();
  const c = vm.createContext({ app: { post: (path, fn) => handlers.post = fn, get: (path, fn) => handlers.get = fn },
    requestAccount: () => 'host-account', requestAccountRealm: () => 'general', requestOwner: () => 'host-owner',
    requestAccountOwner: () => 'guest-account-owner', requestProfile: () => 'guest-profile',
    getProfilePartnerEmail: async () => 'guest@example.com', getProfilePartnerCode: async () => 'G1',
    resolveAccountByEmail: async () => ({ accountId: 'guest-account', email: 'guest@example.com' }),
    getXtreamSource: async () => ({}), getAccountBasicInfo: async () => ({ email: 'host@example.com' }),
    getAccountProfiles: async () => [{ id: 'host-profile' }], getAccountProfile: async () => ({ code: 'H1' }),
    randomBytes: () => ({ toString: () => 'session' }), issueStreamTicket: () => 'ticket', wwpStreamTicketTtlMs: 10000,
    isCloudinaryProfileUrl: () => false, sourceProviderUrl: async () => 'https://provider.invalid/media',
    resolvePartnerProfile: async (...args) => { c.pairingArgs = args; return linked ? { partner: { accountId: 'guest-account' }, profile: { id: 'guest-profile' } } : null; },
    accountOwnerId: () => 'guest-account-owner', partnerInvites: invites,
    bumpPartnerInviteRevision: key => c.bumpedKey = key, waitForPartnerInvite: async key => { c.polledKey = key; return 2; } });
  vm.runInContext(routes, c);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set() {} };
  return { c, handlers, invites, res };
}
test('send resolves reciprocal email AND profile codes and delivers to that account/profile', async () => {
  const { c, handlers, res } = setup();
  await handlers.post({ body: { sourceId: 'source', kind: 'movie', id: '1', durationSeconds: 100 }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Array.from(c.pairingArgs), ['guest@example.com', 'G1', 'host@example.com', 'H1', 'general']);
  await handlers.get({ query: { client: 'browser' } }, res);
  assert.equal(c.polledKey, c.bumpedKey);
  assert.equal(res.body.invite.wwpSessionId, 'session');
  assert.equal(res.body.invite.providerURL, undefined);
});
test('non-reciprocal profile rejects the invite without delivering it', async () => {
  const { handlers, res, invites } = setup(false);
  await handlers.post({ body: { sourceId: 'source', kind: 'movie', id: '1', durationSeconds: 100 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(invites.size, 0);
});
