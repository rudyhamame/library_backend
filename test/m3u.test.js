import test from 'node:test';
import assert from 'node:assert/strict';
import { getM3uCatalog, getM3uCategories, m3uProviderUrl } from '../m3u.js';

test('streams and parses M3U entries into bounded channel metadata', async () => {
  const body = '#EXTM3U\n#EXTINF:-1 tvg-logo="https://img.test/logo.png" group-title="News",Test News\nhttps://stream.test/live.m3u8';
  const source = { _id: 'm3u-test', baseUrl: `data:text/plain,${encodeURIComponent(body)}` };
  const items = await getM3uCatalog(source, 'channel');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Test News');
  assert.deepEqual(await getM3uCategories(source, 'channel'), [{ id: 'News', name: 'News' }]);
  assert.equal(await m3uProviderUrl(source, 'channel', items[0].id), 'https://stream.test/live.m3u8');
});
