import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeArabicSearch, arabicSearchRegexSource } from '../arabic-search.js';

test('folds ta marbuta, hamza seats and alef variants to one form', () => {
  assert.equal(normalizeArabicSearch('الهيبة'), normalizeArabicSearch('الهيبه'));
  assert.equal(normalizeArabicSearch('أحمد'), normalizeArabicSearch('احمد'));
  assert.equal(normalizeArabicSearch('إسلام'), normalizeArabicSearch('اسلام'));
  assert.equal(normalizeArabicSearch('مصطفى'), normalizeArabicSearch('مصطفي'));
  assert.equal(normalizeArabicSearch('مسؤول'), normalizeArabicSearch('مسوول'));
});

test('strips diacritics and tatweel and Arabic-Indic digits', () => {
  assert.equal(normalizeArabicSearch('نَسَمَات'), 'نسمات');
  assert.equal(normalizeArabicSearch('الـهـيـبـة'), 'الهيبه');
  assert.equal(normalizeArabicSearch('موسم ٢'), 'موسم 2');
});

test('regex matches a differently spelled stored title', () => {
  const rx = new RegExp(arabicSearchRegexSource('الهيبة'), 'i');
  assert.ok(rx.test('مسلسل الهِيبه'));
  assert.ok(rx.test('الهيبة الجزء الثاني'));
});

test('non-Arabic queries still match literally', () => {
  const rx = new RegExp(arabicSearchRegexSource('harry potter'), 'i');
  assert.ok(rx.test('AR - Harry Potter and the Goblet of Fire (2005)'));
  assert.equal(arabicSearchRegexSource(''), '');
});

test('catalog search matches the full title after the query has been folded', () => {
  const titles = ['AR - مسلسل الهيبة', 'AR - مسلسل الهيبة رأس الجبل'];
  for (const query of ['الهيب', 'الهيبة', 'الهيبه']) {
    const foldedQuery = normalizeArabicSearch(query);
    const rx = new RegExp(arabicSearchRegexSource(foldedQuery), 'i');
    assert.deepEqual(titles.filter(title => rx.test(title)), titles);
    assert.equal(rx.test('AR - مسلسل سر إلهي'), false);
  }
});

test('catalog route expands normalized queries before matching raw stored titles', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('const query = normalizeSearchText(req.query.q)');
  assert.ok(start >= 0);
  const route = server.slice(start, server.indexOf("app.get('/api/xtream/categories'", start));
  assert.match(route, /\$regex: arabicSearchRegexSource\(query\)/);
  assert.doesNotMatch(route, /\$regex: query\.replace/);
});
