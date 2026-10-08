import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCatalogMatches } from '../catalog-search.js';
const find = (titles, q) => rankCatalogMatches(titles.map((title, id) => ({ title, id })), q);

test('English exact titles beat prefix, phrase and reordered-word matches', () => {
  const result = find(['Dark Knight The', 'The Dark Knight Rises', 'EN: The Dark Knight', 'Behind The Dark Knight'], 'THE dark knight');
  assert.equal(result[0].title, 'EN: The Dark Knight');
  assert.equal(result[1].title, 'The Dark Knight Rises');
  assert.equal(find(['The Dark Knight'], 'knight dark')[0].id, 0);
});
test('English punctuation, accents, quality tags and conservative spelling tolerance', () => {
  assert.equal(find(['EN: Spider-Man FHD'], 'spider man')[0].searchScore, 10000);
  assert.equal(find(['Amélie'], 'amelie')[0].searchScore, 10000);
  assert.equal(find(['The Physician'], 'physican')[0].id, 0);
  assert.equal(find(['The Physician'], 'phyiscian')[0].id, 0);
  assert.equal(find(['The Physician'], 'physician')[0].searchScore > find(['The Physician'], 'physican')[0].searchScore, true);
  assert.deepEqual(find(['MBC 3', 'It'], 'MBC 4'), []);
  assert.deepEqual(find(['It'], 'at'), []);
});
test('Arabic spelling variants, marks, word order and digits use the same ranking', () => {
  assert.equal(find(['AR: إِسْماعيل'], 'اسماعيل')[0].searchScore, 10000);
  assert.equal(find(['شتي يا بيروت'], 'بيروت شتي')[0].id, 0);
  assert.equal(find(['شتي يا بيروت'], 'بيرت')[0].id, 0);
  assert.equal(find(['قناة ٣'], 'قناة 3')[0].searchScore, 10000);
  assert.deepEqual(find(['قناة ٣'], 'قناة 4'), []);
});
test('normalized empty queries do not match everything and output is bounded/immutable', () => {
  const items = Array.from({ length: 100 }, (_, id) => ({ id, title: 'Movie ' + id, providerIdentity: { sourceId: 'scope', itemId: String(id) } }));
  assert.deepEqual(rankCatalogMatches(items, '...'), []);
  assert.deepEqual(rankCatalogMatches(items, 'movie ' + 'x'.repeat(170)), []);
  const result = rankCatalogMatches(items, 'movie');
  assert.equal(result.length, 60);
  assert.equal(items[0].searchScore, undefined);
  assert.deepEqual(result[0].providerIdentity, items[0].providerIdentity);
});
