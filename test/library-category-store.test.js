import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryItemKey, reconcileLibraryCategories } from '../library-category-core.js';

const items = [
  { sourceId: 'source-1', key: 'series:1', kind: 'series', categoryId: '10', category: 'Drama' },
  { sourceId: 'source-1', key: 'series:2', kind: 'series', categoryId: '10', category: 'Drama' },
  { sourceId: 'source-1', key: 'movie:3', kind: 'movie', categoryId: '20', category: 'Movies' },
];

test('seeds Library categories from playlist metadata and assigns their items', () => {
  const result = reconcileLibraryCategories({ ownerId: 'owner', categories: [], assignments: [] }, items);
  assert.deepEqual(result.categories.map(category => [category.kind, category.name]), [['series', 'Drama'], ['movie', 'Movies']]);
  const drama = result.categories.find(category => category.name === 'Drama');
  assert.deepEqual(result.assignments.filter(entry => entry.categoryId === drama.id).map(entry => entry.itemKey), items.slice(0, 2).map(libraryItemKey));
});

test('does not restore a deleted category or overwrite explicit unassignment', () => {
  const seeded = reconcileLibraryCategories({ ownerId: 'owner', categories: [], assignments: [] }, items);
  const drama = seeded.categories.find(category => category.name === 'Drama');
  drama.deleted = true;
  seeded.assignments = seeded.assignments.map(entry => entry.categoryId === drama.id ? { ...entry, categoryId: null } : entry);
  const result = reconcileLibraryCategories(seeded, items);
  assert.equal(result.categories.find(category => category.id === drama.id).deleted, true);
  assert.equal(result.assignments.find(entry => entry.itemKey === libraryItemKey(items[0])).categoryId, null);
});
