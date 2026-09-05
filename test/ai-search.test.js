import test from 'node:test';
import assert from 'node:assert/strict';
import { aiSearchQueryVariants, combinedVariantRegex } from '../ai-search.js';

test('aiSearchQueryVariants never calls Gemini when it is unavailable', async () => {
  let called = false;
  const variants = await aiSearchQueryVariants({
    query: 'harry poter', kind: 'movie', uiLanguage: 'en',
    aiAvailable: false, caller: async () => { called = true; return { variants: ['Harry Potter'] }; },
  });
  assert.equal(called, false);
  assert.deepEqual(variants, []);
});

test('aiSearchQueryVariants never calls Gemini for an empty query', async () => {
  let called = false;
  const variants = await aiSearchQueryVariants({
    query: '   ', kind: 'movie', uiLanguage: 'en',
    aiAvailable: true, caller: async () => { called = true; return { variants: [] }; },
  });
  assert.equal(called, false);
  assert.deepEqual(variants, []);
});

test('aiSearchQueryVariants forwards the corrected/translated suggestions, deduped against the original query', async () => {
  const variants = await aiSearchQueryVariants({
    query: 'harry poter', kind: 'movie', uiLanguage: 'en',
    aiAvailable: true,
    caller: async () => ({ variants: ['Harry Potter', 'harry poter', '  Harry Potter  ', 'هاري بوتر'] }),
  });
  assert.deepEqual(variants, ['Harry Potter', 'هاري بوتر']);
});

test('aiSearchQueryVariants fails safe (empty list) when Gemini errors', async () => {
  const variants = await aiSearchQueryVariants({
    query: 'harry poter', kind: 'movie', uiLanguage: 'en',
    aiAvailable: true, caller: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(variants, []);
});

test('aiSearchQueryVariants caps suggestions at four', async () => {
  const variants = await aiSearchQueryVariants({
    query: 'x', kind: 'series', uiLanguage: 'en',
    aiAvailable: true, caller: async () => ({ variants: ['a', 'b', 'c', 'd', 'e', 'f'] }),
  });
  assert.equal(variants.length, 4);
});

test('combinedVariantRegex escapes regex metacharacters and joins as an alternation', () => {
  const pattern = combinedVariantRegex(['C++', 'The (Office)']);
  assert.equal(pattern, 'C\\+\\+|The \\(Office\\)');
});

test('combinedVariantRegex returns null for no usable variants', () => {
  assert.equal(combinedVariantRegex([]), null);
  assert.equal(combinedVariantRegex(['']), null);
});
