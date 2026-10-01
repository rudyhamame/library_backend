import test from 'node:test';
import assert from 'node:assert/strict';
import { cityClock, detectXtreamLanguage, displayDuration, durationSeconds, freshDashboardTimes, rokuPage, rokuPagePayload } from '../roku-catalog-format.js';

test('Roku catalog paging clamps malformed requests and preserves boundaries', () => {
  const req = { query: { page: '-3', limit: '9999' } };
  const page = rokuPage(req, 10);
  assert.deepEqual(page, { page: 0, limit: 200, offset: 0 });
  assert.deepEqual(rokuPagePayload([1, 2, 3], { page: 1, limit: 2, offset: 2 }), {
    items: [3], page: 1, limit: 2, total: 3, hasMore: false,
  });
});

test('Roku catalog formatting retains language and duration semantics', () => {
  assert.equal(detectXtreamLanguage({ title: 'Movie' }, 'AR | Films'), 'Arabic');
  assert.equal(detectXtreamLanguage({ title: 'فيلم' }, ''), 'Arabic');
  assert.equal(displayDuration('01:25'), '00:01:25');
  assert.equal(displayDuration(3661), '01:01:01');
  assert.equal(durationSeconds('01:01:01'), 3661);
});

test('dashboard clocks use one supplied instant', () => {
  const now = new Date('2026-09-30T20:00:05Z');
  const result = freshDashboardTimes({ cities: [{ timezone: 'UTC' }] }, now);
  assert.equal(result.cities[0].time, '2026-09-30T20:00');
  assert.deepEqual(cityClock('UTC', now), { year: 2026, month: 9, day: 30, hour: 20, minute: 0, second: 5, weekday: 3 });
});
