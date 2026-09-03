import test from 'node:test';
import assert from 'node:assert/strict';
import { newestCatalogItems } from '../provider-catalog-store.js';

test('newestCatalogItems returns only the newest requested provider rows', () => {
  const items = Array.from({ length: 15 }, (_, providerOrder) => ({ id: String(providerOrder), added: String(100 + providerOrder), providerOrder }));
  assert.deepEqual(newestCatalogItems(items, 10).map(item => item.id), ['14', '13', '12', '11', '10', '9', '8', '7', '6', '5']);
});

test('newestCatalogItems uses provider array order when timestamps are absent', () => {
  const items = Array.from({ length: 4 }, (_, providerOrder) => ({ id: String(providerOrder), providerOrder }));
  assert.deepEqual(newestCatalogItems(items, 2).map(item => item.id), ['3', '2']);
});
