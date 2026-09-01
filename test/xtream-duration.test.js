import test from 'node:test';
import assert from 'node:assert/strict';
import { getXtreamSeriesEpisodes } from '../xtream.js';

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
