import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('General RH and Roku RH authenticate against separate account databases', async () => {
  const sessions = await readFile(new URL('../device-sessions.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(sessions, /MONGODB_GENERAL_DB \|\| 'rh_general'/);
  assert.match(sessions, /normalizedRealm === 'general' \? generalDatabaseName : databaseName/);
  assert.match(sessions, /realm: normalizeAccountRealm\(session\.realm\)/);
  assert.match(server, /req\.body\?\.realm === 'roku' \? 'roku' : 'general'/);
  assert.match(server, /registerAccount\([^\n]*'general'\)/);
});

test('Android General User has no Roku pairing or casting surface', async () => {
  const activity = await readFile(new URL('../../android-app/android/app/src/main/java/com/rhstream/library/MainActivity.java', import.meta.url), 'utf8');
  const player = await readFile(new URL('../../android-app/android/app/src/main/java/com/rhstream/library/PlayerActivity.java', import.meta.url), 'utf8');
  assert.match(activity, /put\("realm",rokuUser\?"roku":"general"\)/);
  assert.match(activity, /signup\.setVisibility\(roku\?View\.GONE:View\.VISIBLE\)/);
  assert.match(activity, /private void generalSignup\(\)[\s\S]*\/api\/account\/signup/);
  assert.match(activity, /if\(!isRokuUserMode\(\)\)\{if\(manageable\)addProfileSettingsSection\(\);return;\}/);
  assert.match(activity, /Roku pairing is available only in Roku User mode/);
  assert.match(player, /if \(isRokuUserMode\(\)\) \{[\s\S]*rokuButton = icon/);
  assert.match(activity, /if\(!isRokuUserMode\(\)\)addPartnerSection\(\)/);
  assert.match(activity, /private void addWelcomeProfileSwitcher\(\)[\s\S]*if\(!isRokuUserMode\(\)\)\{/);
  assert.match(activity, /startPartnerInvitePolling\(\)\{if\(isRokuUserMode\(\)/);
  assert.match(player, /if \(!isRokuUserMode\(\)\) \{[\s\S]*partnerButton = icon/);
  assert.match(activity, /if\(!isRokuUserMode\(\)\)\{[\s\S]*showChangePasswordDialog\(\)[\s\S]*showDeleteAccountDialog\(\)/);
  assert.match(await readFile(new URL('../server.js', import.meta.url), 'utf8'), /Partner accounts are available only for General users/);
});
