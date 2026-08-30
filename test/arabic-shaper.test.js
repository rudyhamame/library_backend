import test from 'node:test';
import assert from 'node:assert/strict';

import { shapeArabicForRoku } from '../arabic-shaper.js';

test('shapes Arabic while preserving mixed Latin text and punctuation', () => {
  const shaped = shapeArabicForRoku('|AR| مسلسلات سورية لبنانية');
  assert.match(shaped, /[\uFE70-\uFEFC]/);
  assert.match(shaped, /\|AR\|$/);
});

test('combining marks do not disconnect neighbouring Arabic letters', () => {
  const shaped = shapeArabicForRoku('مُسَلْسَل');
  assert.ok(shaped.includes('ﻣ'));
  assert.ok(shaped.includes('ﺴ'));
  assert.ok(shaped.includes('ﻠ'));
});

test('does not alter English-only labels', () => {
  assert.equal(shapeArabicForRoku('Series (2026)'), 'Series (2026)');
});
