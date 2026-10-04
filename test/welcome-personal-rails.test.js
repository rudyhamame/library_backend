import test from 'node:test';
import assert from 'node:assert/strict';
import { personalWelcomeRails } from '../welcome-personal-rails.js';

const card = (kind, id, sourceId = 'provider') => ({ kind, id, sourceId, title: `${kind} ${id}`, extension: 'mkv' });
const history = (kind, itemId, updatedAt, extra = {}) => ({
  providerIdentity: { kind, sourceId: 'provider', itemId, ...extra }, updatedAt,
});

test('personal rails preserve watched recency, completed titles, kind and provider identities', () => {
  const series = card('series', '7');
  const movie = card('movie', '7');
  const live = card('channel', '7');
  const records = [
    history('movie', '7', '2026-10-01'),
    history('episode', '100', '2026-10-03', { seriesId: '7' }),
    history('episode', '101', '2026-10-02', { seriesId: '7' }),
    { ...history('live', '7', '2026-10-02T12:00:00Z'), completed: true },
    history('movie', 'missing', '2026-10-04'),
    { providerIdentity: { kind: 'movie', sourceId: 'other', itemId: '7' }, updatedAt: '2026-10-04' },
  ];
  const result = personalWelcomeRails({ history: records, catalogItems: [series, movie, live, card('movie', '7', 'other')], sourceId: 'provider' });
  assert.deepEqual(result.lastWatched, [series, live, movie]);
  assert.equal(records.length, 6);
  assert.equal(result.lastWatched[0].extension, 'mkv');
});

test('saved cards resolve only persisted selections in the active provider catalog', () => {
  const a = card('series', '1');
  const b = card('movie', '2');
  const result = personalWelcomeRails({
    sourceId: 'provider', catalogItems: [a, b, card('channel', '3')],
    selectedItems: [a, a, card('movie', '2', 'other'), card('movie', 'missing'), b],
  });
  assert.deepEqual(result.savedItems, [a, b]);
  assert.deepEqual(result.lastWatched, []);
  assert.deepEqual(personalWelcomeRails({ sourceId: 'provider' }), { lastWatched: [], savedItems: [] });
});

test('each rail is independently bounded to ten even with a larger requested limit', () => {
  const items = Array.from({ length: 40 }, (_, i) => card('movie', String(i)));
  const records = items.map((item, i) => history('movie', item.id, new Date(i * 1000).toISOString()));
  const result = personalWelcomeRails({ sourceId: 'provider', catalogItems: items, selectedItems: items, history: records, limit: 100 });
  assert.equal(result.lastWatched.length, 10);
  assert.equal(result.lastWatched[0].id, '39');
  assert.equal(result.savedItems.length, 10);
  assert.equal(result.savedItems[0].id, '0');
});

test('bootstrap reads only authenticated scopes and returns bounded provider-specific personal rails', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/api/roku/bootstrap',");
  const end = source.indexOf("app.get('/api/roku/series/categories',", start);
  const media = Array.from({ length: 20 }, (_, i) => card('movie', String(i)));
  const selected = media.slice(5);
  const provider = { _id: 'provider', name: 'Active provider', enabledKeys: selected.map(item => `movie:${item.id}`) };
  let handler;
  let response;
  const context = vm.createContext({
    app: { get: (path, callback) => { handler = callback; } },
    requestOwner: () => 'canonical-owner', requestAccountOwner: () => 'canonical-account-owner',
    requestProfileOwner: () => 'canonical-profile-owner', requestProfile: () => 'active-profile',
    getRokuSelectedItems: async (kind, owner, account, requestedSource) => {
      assert.equal(owner, 'canonical-owner'); assert.equal(account, 'canonical-account-owner');
      assert.equal(requestedSource, '');
      return kind === 'movie' ? selected : [];
    },
    getAllXtreamSources: async owner => { assert.equal(owner, 'canonical-account-owner'); return [provider]; },
    getFavorites: async (owner, profile) => { assert.equal(owner, 'canonical-account-owner'); assert.equal(profile, 'active-profile'); return []; },
    getStreamingHistory: async owner => {
      assert.equal(owner, 'canonical-profile-owner');
      return media.map((item, i) => history('movie', item.id, new Date(i * 1000).toISOString()));
    },
    getRokuSourcePreferenceByOwner: async owner => { assert.equal(owner, 'canonical-owner'); return 'provider'; },
    pickRokuSourceId: preference => preference,
    flattenSelection: (sources, owner, account) => { assert.equal(owner, 'canonical-owner'); assert.equal(account, 'canonical-account-owner'); return sources; },
    getSourceCatalog: async (source, kind) => kind === 'movie' ? media : [],
    selectedXtreamItem: (source, item) => ({ ...item, sourceId: String(source._id) }),
    directXtreamItem: item => item, rokuDiscoveryItem: item => item, rokuText: text => text,
    personalWelcomeRails, welcomeRailLimit: 10,
  });
  vm.runInContext(source.slice(start, end), context);
  const res = { set: () => res, json: body => { response = body; }, status: code => { assert.fail(`bootstrap failed: ${code}`); } };
  await handler({ query: {} }, res);
  assert.equal(response.lastWatched.length, 10);
  assert.equal(response.lastWatched[0].id, '19');
  assert.equal(response.savedItems.length, 10);
  assert.equal(response.savedItems[0].id, '5');
  assert.equal(response.stats.selectedSourceId, 'provider');
});
