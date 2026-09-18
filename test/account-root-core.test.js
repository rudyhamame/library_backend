import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountRoot } from '../account-root-core.js';

test('builds one canonical account tree with profile-specific favorites', () => {
  const root = buildAccountRoot({
    account: {
      _id: 'account-1', ownerId: 'owner-1', email: 'user@example.com',
      passwordHash: 'must-not-be-copied', firstName: 'User',
    },
    profiles: [{ id: 'profile-1', ownerId: 'profile-owner-1', name: 'Main', isDefault: true }],
    providers: [{
      _id: 'provider-1', name: 'Playlist', baseUrl: 'https://provider.example',
      username: 'user', password: 'secret', enabledItems: [
        { kind: 'movie', id: 'movie-1', title: 'Movie' },
        { kind: 'series', id: 'series-1', title: 'Series' },
      ],
    }],
    favorites: [{ ownerId: 'profile-owner-1', profileId: 'profile-1', sourceId: 'provider-1', kind: 'movie', itemId: 'movie-1', title: 'Movie' }],
    catalogRefs: [{ sourceId: 'provider-1', kind: 'movie', count: 100000, collection: 'provider_catalog_items' }],
    playback: [{ ownerId: 'owner-1', itemId: 'movie-1', position: 42 }],
    history: [{ ownerId: 'owner-1', kind: 'movie', itemId: 'movie-1' }],
  });

  assert.equal(root._id, 'owner-1');
  assert.equal(root.account.id, 'account-1');
  assert.equal(root.account.passwordHash, undefined);
  assert.deepEqual(root.providers[0].selection.enabledItems.movie.map(item => item.id), ['movie-1']);
  assert.deepEqual(root.providers[0].selection.enabledItems.series.map(item => item.id), ['series-1']);
  assert.equal(root.profiles[0].favorites.movie[0].itemId, 'movie-1');
  assert.equal(root.catalogRefs[0].count, 100000);
  assert.equal(root.catalogRefs[0].collection, 'provider_catalog_items');
  assert.equal(root.lastWatched.movie[0].itemId, 'movie-1');
});

test('does not embed provider catalog rows in the account root', () => {
  const root = buildAccountRoot({
    account: { _id: 'account-1', ownerId: 'owner-1' },
    providers: [{ _id: 'provider-1', enabledItems: [] }],
    catalogRefs: [{ sourceId: 'provider-1', kind: 'movie', count: 665960, collection: 'provider_catalog_items' }],
  });
  assert.equal(root.providers[0].catalogRefs[0].count, 665960);
  assert.equal(root.providers[0].catalogRefs[0].items, undefined);
});