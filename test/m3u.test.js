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

test('preserves playlist logos written with common attribute formats', async () => {
  const body = [
    '#EXTM3U',
    "#EXTINF:-1 tvg-logo='https://img.test/bein.png?size=4k&amp;theme=dark' group-title='Sports',beIN 4K",
    'https://stream.test/bein.m3u8',
    '#EXTINF:-1 tvg-logo=https://img.test/event.png group-title=Events,Event Channel',
    'https://stream.test/event.m3u8',
  ].join('\n');
  const source = { _id: 'm3u-logo-formats', baseUrl: `data:text/plain,${encodeURIComponent(body)}` };
  const items = await getM3uCatalog(source, 'channel');
  assert.equal(items[0].logo, 'https://img.test/bein.png?size=4k&theme=dark');
  assert.equal(items[1].logo, 'https://img.test/event.png');
});
