import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { rankCatalogMatches } from '../catalog-search.js';
const source = readFileSync(process.env.SEARCH_TEST_SERVER_PATH || new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("app.get('/api/roku/search',");
const route = source.slice(start, source.indexOf("// Direct-to-Play", start));

test('real search handler keeps active provider/kind scope and relevance scores for every output type', async () => {
  for (const kind of ['series', 'movie', 'channel']) {
    let handler, response;
    const provider = { _id: 'active', enabledKeys: ['movie:2'] };
    const rows = [{ id: '1', title: 'The Dark Knight Rises', kind }, { id: '2', title: 'EN: The Dark Knight', kind }];
    vm.runInNewContext(route, {
      app: { get: (_, callback) => { handler = callback; } }, console: { log() {}, warn() {} },
      rankCatalogMatches, requestOwner: () => 'profile-owner', requestAccountOwner: () => 'account-owner',
      getRokuServerProvider: async (owner, account) => {
        assert.equal(owner, 'profile-owner'); assert.equal(account, 'account-owner'); return provider;
      },
      getSourceCatalog: async (p, k) => { assert.equal(p, provider); assert.equal(k, kind); return rows; },
      selectedXtreamItem: (p, item) => ({ ...item, sourceId: p._id }),
      directXtreamItem: item => ({ id: item.id, title: item.title, sourceId: item.sourceId }),
      buildXtreamChannelsPayload: items => items.map(item => ({ id: item.id, title: item.title, sourceId: item.sourceId })),
      rokuText: value => value,
    });
    const res = { json: body => { response = body; }, status: code => { assert.fail('unexpected HTTP ' + code); } };
    await handler({ query: { kind, q: 'the dark knight', librarySource: 'server' } }, res);
    assert.equal(response.items.length, 2);
    assert.equal(response.items[0].searchScore, 10000);
    assert.equal(response.items[0].sourceId, 'active');
    assert.ok(response.items[0].searchScore > response.items[1].searchScore);
    assert.equal(response.items[0].seriesId || response.items[0].id, '2');
    assert.deepEqual(Array.from(response.savedKeys), ['movie:2']);
  }
});
