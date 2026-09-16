// Arabic-aware search normalization. Providers, viewers and the Roku keyboard
// all spell the same title slightly differently - hamza seats, ta marbuta vs
// haa, alef maksura vs yaa, diacritics, tatweel, Arabic-Indic digits, and the
// Unicode presentation forms Roku sends back. Folding both the query and the
// stored title to one canonical form - or matching with a variant-tolerant
// regex - makes those spellings equivalent for search.

import { PRESENTATION_TO_BASE } from './arabic-shaper.js';

// Marks that never change a word's identity: harakat, superscript alef, Quran
// annotation marks, and the tatweel (U+0640) elongation dash. Built from real
// characters (not \u escapes) so the class body works in both a JS RegExp and
// MongoDB's PCRE $regex engine.
const MARK_RANGES = [[0x0610, 0x061A], [0x064B, 0x065F], [0x0670, 0x0670], [0x06D6, 0x06ED], [0x06DF, 0x06DF], [0x0640, 0x0640]];
const MARK_CLASS = MARK_RANGES
  .map(([a, b]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`))
  .join('');
const STRIP_MARKS = new RegExp(`[${MARK_CLASS}]`, 'g');

// Letter folding: each key -> its canonical form.
const LETTER_FOLD = {
  'آ': 'ا', // آ  -> ا
  'أ': 'ا', // أ  -> ا
  'إ': 'ا', // إ  -> ا
  'ٱ': 'ا', // ٱ  -> ا
  'ى': 'ي', // ى  -> ي
  'ی': 'ي', // ی  (Farsi yeh) -> ي
  'ئ': 'ي', // ئ  -> ي
  'ؤ': 'و', // ؤ  -> و
  'ة': 'ه', // ة  -> ه
  'ہ': 'ه', // ہ  -> ه
  'ک': 'ك', // ک  (Farsi keheh) -> ك
  'ء': '',       // ء  (standalone hamza) -> drop
};

// Arabic-Indic (U+0660..) and Extended Arabic-Indic (U+06F0..) digits -> ASCII.
const DIGIT_FOLD = {};
for (let i = 0; i <= 9; i += 1) {
  DIGIT_FOLD[String.fromCharCode(0x0660 + i)] = String(i);
  DIGIT_FOLD[String.fromCharCode(0x06F0 + i)] = String(i);
}

function deshape(value) {
  let out = '';
  for (const char of String(value || '')) out += PRESENTATION_TO_BASE[char] || char;
  return out;
}

// Canonical, mark-free, lower-cased form - use for equality / `includes`.
export function normalizeArabicSearch(value) {
  const base = deshape(value).normalize('NFKC').replace(STRIP_MARKS, '');
  let out = '';
  for (const char of base) {
    const folded = LETTER_FOLD[char];
    if (folded !== undefined) { out += folded; continue; }
    out += DIGIT_FOLD[char] || char;
  }
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Each canonical letter expands back to a class matching every real-world
// spelling, so the regex still matches un-folded stored titles.
const EXPAND = {
  'ا': '[اآأإٱ]',       // ا
  'ي': '[يىئی]',             // ي
  'و': '[وؤ]',                         // و
  'ه': '[هةہ]',                   // ه  (also matches ة)
  'ك': '[كک]',                         // ك
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex source (no anchors; use with the 'i' flag) matching a title that
// contains `term` regardless of Arabic letter variants, diacritics or tatweel.
// Non-Arabic text is matched literally. Returns '' when the term is empty.
// Valid in both JS RegExp and MongoDB's PCRE $regex.
export function arabicSearchRegexSource(term) {
  const normalized = normalizeArabicSearch(term);
  if (!normalized) return '';
  const optionalMarks = `[${MARK_CLASS}]*`;
  const parts = [];
  for (const char of normalized) {
    if (char === ' ') { parts.push('\\s+'); continue; }
    parts.push(EXPAND[char] || escapeRegex(char));
  }
  return parts.join(optionalMarks);
}
