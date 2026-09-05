import { createHash } from 'node:crypto';
import { getRecommendationCache, saveRecommendationCache } from './recommendations-store.js';

export const AI_LIMITS = Object.freeze({
  savedSample: Math.max(8, Number.parseInt(process.env.MAX_SAVED_AI_SAMPLE || '32', 10) || 32),
  candidates: Math.max(10, Number.parseInt(process.env.MAX_AI_CANDIDATES || '100', 10) || 100),
  description: Math.max(0, Number.parseInt(process.env.MAX_DESCRIPTION_LENGTH || '200', 10) || 200),
  output: 10,
  retries: Math.max(0, Math.min(2, Number.parseInt(process.env.MAX_GEMINI_RETRIES || '2', 10) || 0)),
});
export const AI_RECOMMENDATION_VERSION = 5;

const inFlight = new Map();
const arabicText = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/;
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const itemIdentity = item => `${item.sourceId}:${item.type}:${item.id}`;

export function normalizeRecommendationLanguage(value) {
  const language = normalize(value);
  return ['arabic', 'english', 'both'].includes(language) ? language : 'both';
}

export function inferItemLanguage(item) {
  const supplied = normalize(item?.language);
  if (supplied === 'arabic' || supplied === 'ar') return 'ar';
  if (supplied === 'english' || supplied === 'en') return 'en';
  const text = `${item?.category || item?.categoryName || ''} ${item?.title || ''}`;
  if (arabicText.test(text) || /\b(?:arabic|arab|ar)\b/i.test(text)) return 'ar';
  if (/^\s*EN\s*(?:[-|:]|$)|\b(?:english|eng)\b/i.test(text)) return 'en';
  return 'unknown';
}

function categoryGenres(item) {
  const supplied = Array.isArray(item?.genres) ? item.genres : String(item?.genre || '').split(/[,/|]/);
  const genres = supplied.map(normalize).filter(Boolean).slice(0, 4);
  if (genres.length) return genres;
  const category = normalize(item?.category || item?.categoryName);
  return category ? [category] : [];
}

function yearFrom(item) {
  const explicit = Number.parseInt(item?.year, 10);
  if (explicit >= 1900 && explicit <= 2100) return explicit;
  const titleYear = String(item?.title || '').match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)?.[1];
  return titleYear ? Number(titleYear) : null;
}

function compactItem(item) {
  const description = String(item?.description || item?.plot || '').trim().slice(0, AI_LIMITS.description);
  return {
    id: String(item.id), sourceId: String(item.sourceId), type: item.type,
    providerName: String(item.providerName || item.sourceName || 'Unknown provider'),
    title: String(item.title || 'Untitled'), genres: categoryGenres(item),
    category: String(item.category || item.categoryName || 'Other'),
    year: yearFrom(item), language: inferItemLanguage(item),
    rating: Number.parseFloat(item.rating) || 0,
    ...(description ? { description } : {}),
  };
}

function canonicalSavedItems(sources) {
  const items = [];
  for (const source of sources) for (const item of Array.isArray(source.enabledItems) ? source.enabledItems : []) {
    if (!item || !['movie', 'series'].includes(item.kind) || !item.id) continue;
    items.push({ ...item, id: String(item.id), sourceId: String(source._id), sourceName: source.name, providerName: source.name, type: item.kind, category: item.category || item.categoryName || 'Other' });
  }
  return items;
}

function languageCompatible(code, preference, allowUnknown = true) {
  if (preference === 'both') return true;
  if (code === 'unknown') return allowUnknown;
  return code === (preference === 'arabic' ? 'ar' : 'en');
}

export function representativeSavedSample(savedItems, language = 'both', maximum = AI_LIMITS.savedSample) {
  const preference = normalizeRecommendationLanguage(language);
  const preferred = savedItems.filter(item => languageCompatible(inferItemLanguage(item), preference, false));
  const pool = preferred.length >= Math.min(8, savedItems.length) ? preferred : savedItems.filter(item => languageCompatible(inferItemLanguage(item), preference));
  const sorted = [...pool].sort((a, b) => Number(b.added || 0) - Number(a.added || 0) || itemIdentity(a).localeCompare(itemIdentity(b)));
  const buckets = new Map();
  for (const item of sorted) {
    const key = `${item.type}|${inferItemLanguage(item)}|${normalize(item.category || item.categoryName || 'other')}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const selected = [];
  while (selected.length < maximum && [...buckets.values()].some(values => values.length)) {
    for (const values of buckets.values()) {
      if (values.length && selected.length < maximum) selected.push(values.shift());
    }
  }
  return selected.map(compactItem);
}

function frequency(items, extractor, limit = 8) {
  const counts = new Map();
  for (const item of items) for (const value of extractor(item)) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

export function preferenceEvidence(savedItems) {
  const valid = savedItems.filter(item => ['movie', 'series'].includes(item.type));
  const total = Math.max(1, valid.length);
  const languages = { ar: 0, en: 0, unknown: 0 };
  const types = { movie: 0, series: 0 };
  const years = [];
  for (const item of valid) {
    languages[inferItemLanguage(item)] += 1;
    types[item.type] += 1;
    const year = yearFrom(item); if (year) years.push(year);
  }
  return {
    topGenres: frequency(valid, categoryGenres),
    topCategories: frequency(valid, item => [normalize(item.category || item.categoryName || 'other')]),
    preferredLanguages: Object.fromEntries(Object.entries(languages).map(([key, count]) => [key, Number((count / total).toFixed(3))])),
    contentTypePreference: Object.fromEntries(Object.entries(types).map(([key, count]) => [key, Number((count / total).toFixed(3))])),
    averageYear: years.length ? Math.round(years.reduce((sum, year) => sum + year, 0) / years.length) : null,
  };
}

function categoryLanguage(name) { return inferItemLanguage({ category: name }); }

function categoryPriority(category, evidence, language) {
  const normalized = normalize(category.name);
  const categoryCount = new Map(evidence.topCategories || []).get(normalized) || 0;
  const genreCount = (evidence.topGenres || []).reduce((sum, [genre, count]) => sum + (normalized.includes(genre) || genre.includes(normalized) ? count : 0), 0);
  const code = categoryLanguage(category.name);
  const languageScore = language === 'both' ? (code === 'unknown' ? 0 : 1) : code === (language === 'arabic' ? 'ar' : 'en') ? 5 : code === 'unknown' ? 1 : -8;
  return categoryCount * 4 + genreCount * 2 + languageScore;
}

function candidateScore(item, evidence, language) {
  const category = normalize(item.category);
  const categoryScore = (evidence.topCategories || []).reduce((sum, [name, count]) => sum + (name === category ? count * 5 : 0), 0);
  const genreScore = (evidence.topGenres || []).reduce((sum, [genre, count]) => sum + (category.includes(genre) || genre.includes(category) ? count * 2 : 0), 0);
  const code = inferItemLanguage(item);
  const languageScore = language === 'both' ? ((evidence.preferredLanguages?.[code] || 0) * 5) : code === (language === 'arabic' ? 'ar' : 'en') ? 7 : code === 'unknown' ? 1 : -12;
  const typeScore = (evidence.contentTypePreference?.[item.type] || 0) * 4;
  const ratingScore = Math.min(10, Math.max(0, Number.parseFloat(item.rating) || 0)) * .35;
  const added = Number(item.added || 0); const ageDays = added ? Math.max(0, (Date.now() - added * (added < 1e12 ? 1000 : 1)) / 86_400_000) : 3650;
  const recencyScore = Math.max(0, 2 - ageDays / 730);
  return categoryScore + genreScore + languageScore + typeScore + ratingScore + recencyScore;
}

async function candidatePool({ sources, savedItems, evidence, language, getCatalog, getCategories }) {
  const saved = new Set(savedItems.map(itemIdentity));
  const candidates = new Map();
  for (const source of sources) for (const type of ['series', 'movie']) {
    let categories;
    try { categories = await getCategories(source, type); } catch { continue; }
    const rankedCategories = (Array.isArray(categories) ? categories : [])
      .map(category => ({ ...category, score: categoryPriority(category, evidence, language) }))
      .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
    for (const category of rankedCategories) {
      let rows;
      try { rows = await getCatalog(source, type, category.id); } catch { continue; }
      for (const row of Array.isArray(rows) ? rows : []) {
        const item = { ...row, id: String(row.id), sourceId: String(source._id), sourceName: source.name, providerName: source.name, type, category: category.name || row.category || 'Other' };
        const identity = itemIdentity(item);
        if (!item.id || saved.has(identity) || candidates.has(identity) || !languageCompatible(inferItemLanguage(item), language)) continue;
        item.localScore = candidateScore(item, evidence, language);
        candidates.set(identity, item);
      }
      const languageCounts = { ar: 0, en: 0 };
      if (language === 'both') for (const candidate of candidates.values()) {
        const code = inferItemLanguage(candidate); if (code === 'ar' || code === 'en') languageCounts[code] += 1;
      }
      const bilingualReady = languageCounts.ar >= AI_LIMITS.output * 2 && languageCounts.en >= AI_LIMITS.output * 2;
      if (language === 'both' ? bilingualReady : candidates.size >= AI_LIMITS.candidates * 6) break;
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.localScore - a.localScore || itemIdentity(a).localeCompare(itemIdentity(b)));
  if (language !== 'both') return ranked.slice(0, AI_LIMITS.candidates);
  const quota = Math.floor(AI_LIMITS.candidates / 2);
  const arabic = ranked.filter(item => inferItemLanguage(item) === 'ar').slice(0, quota);
  const english = ranked.filter(item => inferItemLanguage(item) === 'en').slice(0, quota);
  const selected = [...arabic, ...english];
  const selectedIds = new Set(selected.map(itemIdentity));
  for (const item of ranked) {
    if (selected.length >= AI_LIMITS.candidates) break;
    if (!selectedIds.has(itemIdentity(item))) { selected.push(item); selectedIds.add(itemIdentity(item)); }
  }
  return selected.sort((a, b) => b.localScore - a.localScore || itemIdentity(a).localeCompare(itemIdentity(b)));
}

const responseSchema = {
  type: 'object',
  properties: {
    preferenceProfile: {
      type: 'object',
      properties: {
        genres: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        themes: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        contentTypePreference: { type: 'string' }, languagePreference: { type: 'string' }, summary: { type: 'string' },
      }, required: ['genres', 'themes', 'contentTypePreference', 'languagePreference', 'summary'],
    },
    recommendations: {
      type: 'array', minItems: 10, maxItems: 10,
      items: { type: 'object', properties: {
        id: { type: 'string' }, sourceId: { type: 'string' }, type: { type: 'string', enum: ['movie', 'series'] },
        score: { type: 'number' }, reason: { type: 'string' },
      }, required: ['id', 'sourceId', 'type', 'score', 'reason'] },
    },
  }, required: ['preferenceProfile', 'recommendations'],
};

async function geminiRequest(input) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Gemini API key is unavailable'), { noRetry: true });
  const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
  const bilingualRule = input.languagePreference === 'both' ? ' For BOTH mode, select exactly 5 Arabic and 5 English items when at least five valid candidates exist in each language.' : '';
  const instruction = `You are a recommendation-ranking engine for an IPTV library. Study the supplied representative saved sample and local preference evidence. Infer broad genres, themes, tone, content type, language, cultural/origin, era and storytelling patterns without overfitting to titles. Rank ONLY the supplied candidates. Never invent an item. Preserve candidate id, sourceId and type exactly. The selected language mode is ${input.languagePreference.toUpperCase()}.${bilingualRule} Return exactly 10 recommendations when at least 10 candidates exist. Movies and series may appear in any ratio; do not force a split. Favor relevance with useful diversity. Return JSON only.`;
  const body = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: { temperature: .2, maxOutputTokens: 1800, responseMimeType: 'application/json', responseJsonSchema: responseSchema },
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError;
  for (let attempt = 0; attempt <= AI_LIMITS.retries; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
      if (!response.ok) {
        const error = new Error(`Gemini returned HTTP ${response.status}`); error.status = response.status;
        if (response.status < 500 && response.status !== 429) error.noRetry = true;
        throw error;
      }
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (error.noRetry || attempt >= AI_LIMITS.retries) break;
      await new Promise(resolve => setTimeout(resolve, 350 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('Gemini request failed');
}

export function validateAndFillRecommendations(aiOutput, candidates, language = 'both') {
  const byIdentity = new Map(candidates.map(item => [itemIdentity(item), item]));
  const ranked = [];
  for (const recommendation of Array.isArray(aiOutput?.recommendations) ? aiOutput.recommendations : []) {
    const identity = `${recommendation.sourceId}:${recommendation.type}:${recommendation.id}`;
    const item = byIdentity.get(identity);
    if (!item) {
      console.warn(`[AIRecommendations] invalid-candidate-removed id=${String(recommendation.id || '').slice(0, 80)}`);
      continue;
    }
    if (ranked.some(value => itemIdentity(value) === identity)) continue;
    ranked.push({ ...item, recommendationReason: String(recommendation.reason || '').slice(0, 180), recommendationScore: Math.max(0, Math.min(1, Number(recommendation.score) || 0)) });
  }
  for (const item of candidates) {
    if (!ranked.some(value => itemIdentity(value) === itemIdentity(item))) ranked.push({ ...item, recommendationReason: 'Strong match based on your saved library.', recommendationScore: 0 });
  }
  if (normalizeRecommendationLanguage(language) !== 'both') return ranked.slice(0, AI_LIMITS.output);
  const arabic = ranked.filter(item => inferItemLanguage(item) === 'ar');
  const english = ranked.filter(item => inferItemLanguage(item) === 'en');
  if (!arabic.length || !english.length) return ranked.slice(0, AI_LIMITS.output);
  const targetArabic = Math.min(AI_LIMITS.output / 2, arabic.length);
  const targetEnglish = Math.min(AI_LIMITS.output / 2, english.length);
  const primaryArabic = arabic.slice(0, targetArabic);
  const primaryEnglish = english.slice(0, targetEnglish);
  const selected = [];
  const startsArabic = ranked.find(item => ['ar', 'en'].includes(inferItemLanguage(item))) === arabic[0];
  for (let index = 0; index < Math.max(primaryArabic.length, primaryEnglish.length); index += 1) {
    const first = startsArabic ? primaryArabic[index] : primaryEnglish[index];
    const second = startsArabic ? primaryEnglish[index] : primaryArabic[index];
    if (first) selected.push(first);
    if (second) selected.push(second);
  }
  const selectedIds = new Set(selected.map(itemIdentity));
  for (const item of ranked) {
    if (selected.length === AI_LIMITS.output) break;
    if (!selectedIds.has(itemIdentity(item))) { selected.push(item); selectedIds.add(itemIdentity(item)); }
  }
  return selected.slice(0, AI_LIMITS.output);
}

function publicItem(item) {
  return {
    id: item.id, sourceId: item.sourceId, kind: item.type, type: item.type, key: item.key || `${item.type}:${item.id}`,
    providerName: item.providerName || item.sourceName || 'Unknown provider',
    title: item.title, logo: item.logo || '', categoryId: item.categoryId || '', category: item.category || 'Other',
    language: inferItemLanguage(item), extension: item.extension || 'mp4', duration: item.duration || '', rating: item.rating || '', added: item.added || '',
    recommendationReason: item.recommendationReason || '', recommendationScore: item.recommendationScore || 0,
  };
}

function cacheKey(ownerId, language) {
  // Recommendations are an explicit, durable snapshot. Changes to the library
  // must not replace them; only the profile's Refresh action may do that.
  return hash(`v${AI_RECOMMENDATION_VERSION}\n${ownerId}\n${language}`);
}

async function generate({ ownerId, language, forceRefresh, getSources, getCatalog, getCategories, ranker, cacheRead = getRecommendationCache, cacheWrite = saveRecommendationCache, aiAvailable = Boolean(process.env.GEMINI_API_KEY) }) {
  const key = cacheKey(ownerId, language);
  const cached = await cacheRead(key).catch(() => null);
  if (cached && !forceRefresh) {
    console.info(`[AIRecommendations] cache-hit language=${language}`);
    return { ...cached.payload, cached: true };
  }
  const sources = await getSources(ownerId);
  const savedItems = canonicalSavedItems(sources);
  console.info(`[AIRecommendations] cache-miss language=${language}`);
  const evidenceItems = savedItems.map(item => ({ ...item, type: item.type || item.kind }));
  const evidence = preferenceEvidence(evidenceItems);
  const sample = representativeSavedSample(evidenceItems, language);
  const candidates = await candidatePool({ sources, savedItems: evidenceItems, evidence, language, getCatalog, getCategories });
  console.info(`[AIRecommendations] savedSample=${sample.length} candidates=${candidates.length}`);
  if (!candidates.length) return { language, source: 'local-fallback', cached: false, preferenceProfile: null, items: [] };
  let aiOutput = null; let source = savedItems.length ? 'ai' : 'cold-start';
  if (savedItems.length && candidates.length >= AI_LIMITS.output && aiAvailable) {
    try {
      console.info('[AIRecommendations] gemini-start');
      aiOutput = await ranker({ languagePreference: language, savedPreferenceEvidence: evidence, savedSample: sample, candidates: candidates.map(compactItem) });
      console.info(`[AIRecommendations] gemini-success recommendations=${Array.isArray(aiOutput?.recommendations) ? aiOutput.recommendations.length : 0}`);
    } catch (error) {
      source = 'local-fallback';
      console.warn(`[AIRecommendations] gemini-${error?.status === 429 ? 'rate-limited' : 'failed'} fallback=local`);
    }
  } else if (savedItems.length) source = 'local-fallback';
  const items = validateAndFillRecommendations(aiOutput, candidates, language).map(publicItem);
  const payload = { language, source, cached: false, preferenceProfile: aiOutput?.preferenceProfile || null, items };
  console.info(`[AIRecommendations] ${source} recommendations=${items.length}`);
  await cacheWrite({ key, ownerId, language, algorithmVersion: AI_RECOMMENDATION_VERSION, expiresAt: new Date('9999-12-31T23:59:59.999Z'), payload }).catch(() => {});
  return payload;
}

export async function getAiRecommendations(options) {
  const language = normalizeRecommendationLanguage(options.language);
  const ownerId = String(options.ownerId || '');
  if (!ownerId) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const dedupeKey = `${ownerId}:${language}:${Boolean(options.forceRefresh)}`;
  if (inFlight.has(dedupeKey)) return inFlight.get(dedupeKey);
  const pending = generate({ ...options, ownerId, language, ranker: options.ranker || geminiRequest });
  inFlight.set(dedupeKey, pending);
  try { return await pending; } finally { inFlight.delete(dedupeKey); }
}

export const recommendationInternals = Object.freeze({ candidatePool, canonicalSavedItems, compactItem, itemIdentity });
