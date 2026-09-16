import test from 'node:test';
import assert from 'node:assert/strict';
import { getXtreamMovieInfo, getXtreamSeriesEpisodes } from '../xtream.js';

test('movie duration trusts the complete runtime instead of a shortened duration_secs field', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ info: { duration: '02:00:00', duration_secs: 6600 } }), { status: 200 });
  try {
    assert.equal((await getXtreamMovieInfo({ _id: 'movie-duration', baseUrl: 'http://provider.test', username: 'u', password: 'p' }, '1')).seconds, 7200);
  } finally { global.fetch = originalFetch; }
});

test('movie duration treats a small bare provider runtime as minutes', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ info: { duration: '122' } }), { status: 200 });
  try {
    assert.equal((await getXtreamMovieInfo({ _id: 'movie-minutes', baseUrl: 'http://provider.test', username: 'u', password: 'p' }, '2')).seconds, 7320);
  } finally { global.fetch = originalFetch; }
});

test('episode duration skips zero placeholders and uses valid fallback fields', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    info: { name: 'Series' },
    episodes: {
      1: [
        { id: 1, episode_num: 1, info: { duration: '00:00:00', duration_secs: 2700 } },
        { id: 2, episode_num: 2, info: { duration: '' }, duration: '00:42:00' },
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const details = await getXtreamSeriesEpisodes({ _id: 'duration-test', baseUrl: 'http://provider.test', username: 'u', password: 'p' }, 'series-1');
    assert.deepEqual(details.episodes.map(episode => episode.duration), ['2700', '00:42:00']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('episode duration does not expose a provider zero placeholder', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ episodes: { 1: [
    { id: 3, episode_num: 3, info: { duration: '00:00:00', duration_secs: 0 } },
  ] } }), { status: 200 });
  try {
    const details = await getXtreamSeriesEpisodes({ _id: 'duration-zero-test', baseUrl: 'http://provider.test', username: 'u', password: 'p' }, 'series-2');
    assert.equal(details.episodes[0].duration, '');
  } finally { global.fetch = originalFetch; }
});
