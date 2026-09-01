import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_LIMITS,
  getAiRecommendations,
  normalizeRecommendationLanguage,
  preferenceEvidence,
  recommendationInternals,
  representativeSavedSample,
  validateAndFillRecommendations,
} from '../ai-recommendations.js';

const candidate = (id, type = 'movie', language = 'en') => ({
  id: String(id), sourceId: 'source-1', type, kind: type, title: `Title ${id}`,
  category: language === 'ar' ? 'Arabic Drama' : 'English Drama', language,
  rating: '8.0', extension: 'mp4', localScore: 100 - Number(id),
});

test('normalizes recommendation language and defaults to both', () => {
  assert.equal(normalizeRecommendationLanguage('ARABIC'), 'arabic');
  assert.equal(normalizeRecommendationLanguage('english'), 'english');
  assert.equal(normalizeRecommendationLanguage('unsupported'), 'both');
});

test('representative sample is bounded and diverse across kind and language', () => {
  const saved = Array.from({ length: 60 }, (_, index) => ({
    ...candidate(index + 1, index % 3 ? 'series' : 'movie', index % 2 ? 'ar' : 'en'),
    added: 2_000_000_000 - index,
  }));
  const sample = representativeSavedSample(saved, 'both', 32);
  assert.equal(sample.length, 32);
  assert.deepEqual(new Set(sample.map(item => item.type)), new Set(['movie', 'series']));
  assert.deepEqual(new Set(sample.map(item => item.language)), new Set(['ar', 'en']));
});

test('preference evidence calculates category, language, and type signals', () => {
  const evidence = preferenceEvidence([
    candidate(1, 'series', 'ar'), candidate(2, 'series', 'ar'), candidate(3, 'movie', 'en'),
  ]);
  assert.equal(evidence.preferredLanguages.ar, 0.667);
  assert.equal(evidence.contentTypePreference.series, 0.667);
  assert.equal(evidence.topCategories[0][0], 'arabic drama');
});

test('invalid and duplicate Gemini IDs are rejected and locally filled to exactly ten', () => {
  const candidates = Array.from({ length: 12 }, (_, index) => candidate(index + 1, index % 2 ? 'series' : 'movie'));
  const aiOutput = { recommendations: [
    { id: '999999', sourceId: 'source-1', type: 'movie', score: 1, reason: 'invented' },
    { id: '1', sourceId: 'wrong-source', type: 'movie', score: 1, reason: 'wrong source' },
    { id: '1', sourceId: 'source-1', type: 'movie', score: .9, reason: 'valid' },
    { id: '1', sourceId: 'source-1', type: 'movie', score: .8, reason: 'duplicate' },
  ] };
  const result = validateAndFillRecommendations(aiOutput, candidates);
  assert.equal(result.length, AI_LIMITS.output);
  assert.equal(result[0].id, '1');
  assert.equal(new Set(result.map(item => `${item.sourceId}:${item.type}:${item.id}`)).size, 10);
  assert.equal(result.some(item => item.id === '999999'), false);
});

test('both mode returns five Arabic and five English recommendations when available', () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, index) => candidate(`ar-${index}`, index % 2 ? 'series' : 'movie', 'ar')),
    ...Array.from({ length: 10 }, (_, index) => candidate(`en-${index}`, index % 2 ? 'series' : 'movie', 'en')),
  ];
  const aiOutput = { recommendations: candidates.slice(0, 10).map(item => ({
    id: item.id, sourceId: item.sourceId, type: item.type, score: .9, reason: 'Arabic-only model output',
  })) };
  const result = validateAndFillRecommendations(aiOutput, candidates, 'both');
  assert.equal(result.length, 10);
  assert.equal(result.filter(item => item.language === 'ar').length, 5);
  assert.equal(result.filter(item => item.language === 'en').length, 5);
});

test('both mode uses available language items and fills shortages without reducing the rail', () => {
  const candidates = [
    ...Array.from({ length: 2 }, (_, index) => candidate(`ar-${index}`, 'series', 'ar')),
    ...Array.from({ length: 12 }, (_, index) => candidate(`en-${index}`, 'movie', 'en')),
  ];
  const result = validateAndFillRecommendations(null, candidates, 'both');
  assert.equal(result.length, 10);
  assert.equal(result.filter(item => item.language === 'ar').length, 2);
  assert.equal(result.filter(item => item.language === 'en').length, 8);
});

test('candidate generation keeps scanning categories until enough valid items exist', async () => {
  const source = { _id: 'source-1', enabledItems: [] };
  const categories = Array.from({ length: 9 }, (_, index) => ({ id: String(index + 1), name: `Category ${index + 1}` }));
  const catalog = async (_source, type, categoryId) => Number(categoryId) <= 6
    ? []
    : Array.from({ length: 4 }, (_, index) => candidate(`${categoryId}${index}`, type));
  const results = await recommendationInternals.candidatePool({
    sources: [source], savedItems: [], evidence: preferenceEvidence([]), language: 'both',
    getCategories: async () => categories, getCatalog: catalog,
  });
  assert.ok(results.length >= 10);
});

test('one operation serves 100 simultaneous requests and a reload uses cache', async () => {
  const source = { _id: 'source-1', updatedAt: new Date('2026-01-01'), enabledItems: [{ ...candidate('saved', 'series', 'en'), kind: 'series' }] };
  let rankerCalls = 0;
  let cachedEntry = null;
  const options = {
    ownerId: 'owner-concurrent', language: 'both', getSources: async () => [source],
    getCategories: async () => [{ id: 'drama', name: 'English Drama' }],
    getCatalog: async (_source, type) => Array.from({ length: 12 }, (_, index) => candidate(`${type}-${index}`, type)),
    ranker: async input => {
      rankerCalls += 1;
      return { preferenceProfile: { genres: ['drama'], themes: ['story'], contentTypePreference: 'mixed', languagePreference: 'both', summary: 'Drama.' }, recommendations: input.candidates.slice(0, 10).map(item => ({ id: item.id, sourceId: item.sourceId, type: item.type, score: .9, reason: 'Match' })) };
    },
    aiAvailable: true,
    cacheRead: async () => cachedEntry,
    cacheWrite: async entry => { cachedEntry = { ...entry, createdAt: new Date() }; },
  };
  const simultaneous = await Promise.all(Array.from({ length: 100 }, () => getAiRecommendations(options)));
  assert.equal(rankerCalls, 1);
  assert.ok(simultaneous.every(result => result.items.length === 10));
  const reload = await getAiRecommendations(options);
  assert.equal(reload.cached, true);
  assert.equal(rankerCalls, 1);
});

test('cold start returns ten local recommendations without calling Gemini', async () => {
  let rankerCalls = 0;
  const result = await getAiRecommendations({
    ownerId: 'owner-cold', language: 'both', getSources: async () => [{ _id: 'source-cold', enabledItems: [] }],
    getCategories: async () => [{ id: 'all', name: 'General' }],
    getCatalog: async (_source, type) => Array.from({ length: 6 }, (_, index) => ({ ...candidate(`${type}-${index}`, type), sourceId: 'source-cold' })),
    ranker: async () => { rankerCalls += 1; throw new Error('must not run'); },
    cacheRead: async () => null, cacheWrite: async () => {},
  });
  assert.equal(rankerCalls, 0);
  assert.equal(result.source, 'cold-start');
  assert.equal(result.items.length, 10);
});
