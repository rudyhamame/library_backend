import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accountOwnerId, profileOwnerId } from '../account-library-owner.js';
import { flattenSelection, selectionFor } from '../xtream-store.js';

const accountId = '64b64c50f0b7d15f02c8a001';
const accountOwner = accountOwnerId(accountId);
const kidsOwner = profileOwnerId(accountId, 'kids');
const source = {
  _id: 'provider-one',
  ownerId: accountOwner,
  enabledKeys: [],
  enabledItems: [],
  archivedKeys: [],
  archivedItems: [],
  selections: {
    [accountOwner]: {
      enabledKeys: ['movie:main'],
      enabledItems: [{ key: 'movie:main' }],
      archivedKeys: [],
      archivedItems: [],
    },
    [kidsOwner]: {
      enabledKeys: ['movie:kids'],
      enabledItems: [{ key: 'movie:kids' }],
      archivedKeys: ['series:kids-old'],
      archivedItems: [{ key: 'series:kids-old' }],
    },
  },
};

test('one account provider exposes a different saved playlist for each profile', () => {
  assert.deepEqual(selectionFor(source, accountOwner, accountOwner).enabledKeys, ['movie:main']);
  assert.deepEqual(selectionFor(source, kidsOwner, accountOwner).enabledKeys, ['movie:kids']);
  assert.deepEqual(flattenSelection([source], kidsOwner, accountOwner)[0].archivedKeys, ['series:kids-old']);
  assert.equal(flattenSelection([source], kidsOwner, accountOwner)[0].ownerId, accountOwner);
});

test('a new profile inherits the provider but starts with an empty saved playlist', () => {
  const newOwner = profileOwnerId(accountId, 'new-profile');
  const selected = flattenSelection([source], newOwner, accountOwner)[0];
  assert.equal(selected._id, source._id);
  assert.deepEqual(selected.enabledKeys, []);
  assert.deepEqual(selected.archivedKeys, []);
});

test('Roku selected-item routes always carry both profile and account owners', async () => {
  for (const path of ['../server.js', '../../roku_backend/server.js']) {
    const code = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /getRokuSelectedItems\([^\n]*requestOwner\(req\)\)/, path);
  }
});

test('Roku profile selection persists the last profile on the linked device', async () => {
  const sessions = await readFile(new URL('../device-sessions.js', import.meta.url), 'utf8');
  const selection = sessions.slice(sessions.indexOf('export async function selectAccountProfile'), sessions.indexOf('export async function changeAccountPassword'));
  assert.match(selection, /authorization\.type === 'roku'/);
  assert.match(selection, /deviceId: String\(authorization\.deviceId\)/);
  assert.match(selection, /\$set: \{ profileId: profile\.id, updatedAt: new Date\(\) \}/);
});

test('Android QR connects only to the account already authenticated on Roku', async () => {
  const sessions = await readFile(new URL('../device-sessions.js', import.meta.url), 'utf8');
  const pairing = sessions.slice(sessions.indexOf('export async function authorizeDeviceSession'), sessions.indexOf('export async function autoLoginDeviceSession'));
  assert.match(pairing, /session\.purpose !== 'android-remote'/);
  assert.match(pairing, /authorization\.accountId[\s\S]*session\.accountId/);
  assert.doesNotMatch(pairing, /updateOne|ensureDefaultProfile|consolidateAccountLibrary/);
  assert.doesNotMatch(sessions, /browser_fallback_url=/);
});

test('Roku Welcome content is selected by profile and constrained to its provider', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const favorites = await readFile(new URL('../favorites-store.js', import.meta.url), 'utf8');
  const sessions = await readFile(new URL('../device-sessions.js', import.meta.url), 'utf8');
  const scene = await readFile(new URL('../../roku/components/HomeScreenCatalog.brs', import.meta.url), 'utf8');
  assert.match(server, /getRokuSourcePreferenceByOwner\(ownerId\)/);
  assert.match(server, /const profileSources = flattenSelection\(sources, ownerId, accountOwner\)/);
  assert.match(server, /const providerFavorites = favorites\.filter\(favorite => String\(favorite\.providerIdentity\?\.sourceId \|\| favorite\.sourceId \|\| ''\) === selectedSourceId\)/);
  assert.match(server, /providerScope \|\| ''\) === 'roku'/);
  assert.match(sessions, /getProfileRokuSourcePreferenceByOwner\(ownerId\)/);
  assert.match(scene, /continue-watching\?providerScope=roku/);
  assert.match(server, /sourceId = pickRokuSourceId\(await getRokuSourcePreferenceByOwner\(ownerId\), sources\)/);
  assert.match(favorites, /updateAccountLibrary\(ownerId, library =>/);
  assert.match(favorites, /normalizeIdentityBuckets\(library\.favorites\)/);
  assert.match(favorites, /if \(!sourceId \|\| !kind\) throw new Error/);
  assert.match(favorites, /const desiredFavorite = typeof favorite === 'boolean' \? favorite : !existing/);
  assert.match(scene, /favorite: desiredFavorite/);
  const navigation = await readFile(new URL('../../roku/components/HomeScreenNavigation.brs', import.meta.url), 'utf8');
  assert.match(navigation, /railItemAt\(m\.welcomeDiscoveryRails, welcomeRailPosition\(\)\)/);
  assert.match(scene, /nearestWelcomeRailPosition\(discovery, focusPosition\)/);
  assert.match(server, /getFavorites\(accountOwner, requestProfile\(req\)\)/);
});

test('Roku Welcome counters use complete live provider catalog totals', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const content = await readFile(new URL('../../roku/components/HomeScreenContent.brs', import.meta.url), 'utf8');
  const bootstrap = server.slice(server.indexOf("app.get('/api/roku/bootstrap'"), server.indexOf("app.get('/api/roku/series/categories'"));
  assert.match(bootstrap, /getSourceCatalog\(selectedSource, 'series'\)/);
  assert.match(bootstrap, /getSourceCatalog\(selectedSource, 'movie'\)/);
  assert.match(bootstrap, /getSourceCatalog\(selectedSource, 'channel'\)/);
  assert.match(bootstrap, /series: liveCatalog\.series\.length/);
  assert.match(bootstrap, /movies: liveCatalog\.movie\.length/);
  assert.match(bootstrap, /channels: liveCatalog\.channel\.length/);
  assert.doesNotMatch(bootstrap, /ensureCatalogSnapshot|getProviderCatalog/);
  assert.doesNotMatch(bootstrap, /rokuSavedCount/);
  assert.match(content, /welcomeSeriesCount\.text = welcomeStatText\(m\.librarySeriesCount\)/);
});

test('Roku new-release rails do not repeat their kind beneath every card', async () => {
  const card = await readFile(new URL('../../roku/components/HomeRailCard.brs', import.meta.url), 'utf8');
  assert.match(card, /isNewRelease = item\.hasField\("rhNewRelease"\) and item\.rhNewRelease = true/);
  assert.match(card, /m\.meta\.visible = not isContinueWatching and not isNewRelease/);
  assert.match(card, /if isContinueWatching or isNewRelease[\s\S]*m\.meta\.text = ""/);
});

test('an unsaved Welcome series can open without bypassing the active provider', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /Authorize against this profile's active[\s\S]*const source = await getRokuServerProvider\(ownerId, accountOwner\)/);
  assert.match(server, /const series = saved \|\| \{/);
  assert.match(server, /String\(source\._id\) !== sourceId/);
});

test('Roku deep links resolve unsaved IDs from the active provider', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const scene = await readFile(new URL('../../roku/components/HomeScreenDeepLink.brs', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/roku/deep-link-item'"), server.indexOf("app.get('/api/roku/series/detail'"));
  assert.match(route, /getRokuServerProvider\(ownerId, accountOwner\)/);
  assert.match(route, /getSourceCatalog\(source, kind\)/);
  assert.match(route, /find\(item => String\(item\.id\) === contentId\)/);
  assert.doesNotMatch(route, /enabledItems|enabledKeys|getRokuSelectedItems/);
  assert.match(scene, /\/api\/roku\/deep-link-item/);
  assert.match(scene, /queryParams = \{ mediaType: request\.mediaType, contentId: request\.contentId \}/);
});

test('all Welcome item kinds open independently from saved state', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const events = await readFile(new URL('../../roku/components/HomeScreenEvents.brs', import.meta.url), 'utf8');
  const discovery = server.slice(server.indexOf('function rokuDiscoveryItem'), server.indexOf('function rokuXtreamStreamFormat'));
  assert.match(discovery, /if \(kind === 'series'\)/);
  assert.match(discovery, /const direct = directXtreamItem\(common\)/);
  assert.doesNotMatch(discovery, /enabledKeys|savedKeys/);
  assert.match(events, /if item\.rhKind = "series-search" or item\.rhKind = "series"[\s\S]*openWelcomeSeriesDetail\(item\)/);
  assert.match(events, /if item\.rhKind = "channel"[\s\S]*playContentItem\(item, m\.welcomeDiscoveryRails, "welcomeDiscovery"\)/);
  assert.match(events, /playContentItem\(item, m\.welcomeDiscoveryRails, "welcomeDiscovery"\)[\s\S]*end sub/);
});

test('a provider failure keeps an unsaved series on its episode page', async () => {
  const catalog = await readFile(new URL('../../roku/components/HomeScreenCatalog.brs', import.meta.url), 'utf8');
  assert.match(catalog, /The provider did not return episodes/);
  assert.match(catalog, /setContentFocus\(m\.top, "episodes"\)/);
  assert.doesNotMatch(catalog, /No episodes came back[\s\S]{0,300}showSection\(1\)/);
});

test('provider changes cannot retain a previous favorite title in Roku renderers', async () => {
  const catalog = await readFile(new URL('../../roku/components/HomeScreenCatalog.brs', import.meta.url), 'utf8');
  const card = await readFile(new URL('../../roku/components/HomeRailCard.brs', import.meta.url), 'utf8');
  assert.match(catalog, /ignoring stale provider bootstrap response/);
  assert.match(catalog, /ignoring stale provider history response/);
  assert.match(card, /if item = invalid[\s\S]*m\.title\.text = ""[\s\S]*m\.meta\.text = ""/);
});

test('partner status requires a reciprocal profile match', async () => {
  const code = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(code, /linked: Boolean\(resolved\)/);
  assert.match(code, /isProfileOnline\(resolved\.partner\.accountId, resolved\.profile\.id\)/);
  assert.doesNotMatch(code, /linked: Boolean\(partner\)/);
});

test('Roku player save persists the newly constructed saved item list', async () => {
  const code = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(code, /enabledKeys: nextKeys, enabledItems: nextItems/);
  assert.doesNotMatch(code, /enabledKeys: nextKeys, enabledItems, archivedKeys/);
});
