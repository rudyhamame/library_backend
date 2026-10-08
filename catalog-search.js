import { normalizeArabicSearch } from './arabic-search.js';

export const searchText = value => normalizeArabicSearch(value).normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

// One insertion/deletion/substitution or adjacent transposition, only for
// words with at least four letters. Short names and numeric IDs stay exact.
function nearWord(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || /\d/.test(a + b) || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; }
    else if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function titleText(value) {
  // Provider language tags and terminal quality tags are not title words.
  return searchText(String(value || '').replace(/^\s*[a-z]{2}\s*[:|]\s*/i, '')
    .replace(/\s+(?:4k|uhd|fhd|hd|sd)(?:\s*\([^)]*\))?\s*$/i, ''));
}

export function rankCatalogMatches(items, query, { limit = 60 } = {}) {
  const q = searchText(query);
  if (!q || q.length > 160) return [];
  const terms = [...new Set(q.split(' '))];
  if (terms.length > 12) return [];
  const matches = [];
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    const title = titleText(item.title || item.name);
    if (!title) continue;
    let score = 0;
    if (title === q) score = 10000;
    else if (title.startsWith(q + ' ')) score = 9000;
    else if ((' ' + title + ' ').includes(' ' + q + ' ')) score = 8000;
    else if (title.includes(q)) score = 7000;
    else {
      const words = title.split(' ');
      let fuzzy = 0, prefixes = 0;
      const matched = terms.every(term => {
        if (words.includes(term)) return true;
        if (term.length >= 2 && words.some(word => word.startsWith(term))) { prefixes++; return true; }
        if (words.some(word => nearWord(term, word))) { fuzzy++; return true; }
        return false;
      });
      if (matched && fuzzy <= 1) score = fuzzy ? 4000 : prefixes ? 5500 : 6500;
    }
    if (score) matches.push({ item, index, score: score - Math.min(500, Math.max(0, title.length - q.length)) });
  }
  matches.sort((a, b) => b.score - a.score || a.index - b.index);
  return matches.slice(0, Math.max(1, Math.min(60, Number(limit) || 60)))
    .map(({ item, score }) => ({ ...item, searchScore: score }));
}
