import { randomUUID } from 'node:crypto';
import { accountForLibraryOwner, allAccountDocuments, updateAccountLibrary } from './account-library-data.js';
import { accountOwnerId } from './account-library-owner.js';

const selectionFields = ['enabledKeys', 'enabledItems', 'archivedKeys', 'archivedItems'];

function emptySelection() { return Object.fromEntries(selectionFields.map(field => [field, []])); }

export function selectionFor(source, ownerId, accountOwner) {
  void accountOwner;
  const selection = source?.selections?.[String(ownerId)] || {};
  return Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection[field]) ? selection[field] : []]));
}

export function flattenSelection(sources, ownerId, accountOwner) {
  return (sources || []).map(source => ({ ...source, ...selectionFor(source, ownerId, accountOwner) }));
}

export function publicXtreamSource(source, ownerId, accountOwner) {
  if (!source) return null;
  const selected = selectionFor(source, ownerId, accountOwner);
  return {
    id: source._id, name: source.name, type: source.type || 'xtream', endpoint: source.baseUrl,
    hasCredentials: Boolean(source.username && source.password), ...selected,
    selectedCount: selected.enabledKeys.length, archivedCount: selected.archivedKeys.length,
    connectionStatus: source.connectionStatus || 'unknown', connectionMessage: source.connectionMessage || '',
    updatedAt: source.updatedAt,
  };
}

function sourcesForAccount(account, ownerId) {
  const accountOwner = accountOwnerId(account._id);
  const sources = Array.isArray(account.providers) ? account.providers : [];
  return sources.map(source => {
    const selections = {};
    for (const profile of account.profiles || []) {
      const profileOwner = profile.isDefault ? accountOwner : String(profile.ownerId);
      const selection = profile.library?.savedSelections?.[String(source._id)];
      if (selection) selections[profileOwner] = selection;
    }
    return { ...source, ownerId: accountOwner, selections, _accountId: account._id };
  }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

async function sourcesForOwner(ownerId) {
  const { account } = await accountForLibraryOwner(ownerId);
  return sourcesForAccount(account, ownerId);
}

async function locateSource(id, ownerId = '') {
  const rows = ownerId ? [{ ...(await accountForLibraryOwner(ownerId)) }] : await allAccountDocuments();
  for (const row of rows) {
    const source = (Array.isArray(row.account.providers) ? row.account.providers : []).find(item => String(item._id) === String(id));
    if (source) return { ...row, source, accountOwner: accountOwnerId(row.account._id) };
  }
  return null;
}

export async function getXtreamSources(ownerId) {
  if (!ownerId) return (await allAccountDocuments()).flatMap(row => sourcesForAccount(row.account, '')).map(source => publicXtreamSource(source, source.ownerId, source.ownerId));
  return (await sourcesForOwner(ownerId)).map(source => publicXtreamSource(source, ownerId, ownerId));
}

export async function getXtreamSource(id, ownerId) {
  const located = await locateSource(id, ownerId);
  if (!located) return null;
  const source = sourcesForAccount(located.account, ownerId || located.accountOwner).find(item => String(item._id) === String(id));
  return source || null;
}

export async function getAllXtreamSources(ownerId) {
  if (ownerId) return sourcesForOwner(ownerId);
  return (await allAccountDocuments()).flatMap(row => sourcesForAccount(row.account, ''));
}

export async function createXtreamSource({ name, type = 'xtream', baseUrl, username = '', password = '', ownerId, connectionStatus = 'online', connectionMessage = '' }) {
  const { collection, account } = await accountForLibraryOwner(ownerId);
  const source = { _id: randomUUID(), name, type, baseUrl, username, password, connectionStatus, connectionMessage, createdAt: new Date(), updatedAt: new Date() };
  await collection.updateOne({ _id: account._id }, { $push: { providers: source }, $set: { updatedAt: new Date() } });
  return publicXtreamSource({ ...source, selections: {} }, ownerId, ownerId);
}

export async function updateXtreamSource(id, changes, ownerId) {
  const located = await locateSource(id, ownerId);
  if (!located) return null;
  const next = { ...located.source, ...changes, _id: located.source._id, updatedAt: new Date() };
  await located.collection.updateOne({ _id: located.account._id, 'providers._id': located.source._id }, { $set: { 'providers.$': next, updatedAt: new Date() } });
  return publicXtreamSource({ ...next, selections: {} }, ownerId || located.accountOwner, located.accountOwner);
}

export async function updateXtreamSelection(id, selection, accountOwner, profileOwner = accountOwner) {
  if (!accountOwner || !profileOwner) return null;
  const located = await locateSource(id, accountOwner);
  if (!located) return null;
  const fields = Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection?.[field]) ? selection[field] : []]));
  await updateAccountLibrary(profileOwner, library => { library.savedSelections[String(id)] = fields; return library; });
  return publicXtreamSource({ ...located.source, selections: { [String(profileOwner)]: fields } }, profileOwner, accountOwner);
}

export async function deleteXtreamSource(id, ownerId) {
  const located = await locateSource(id, ownerId);
  if (!located) return false;
  const result = await located.collection.updateOne({ _id: located.account._id }, { $pull: { providers: { _id: located.source._id } }, $set: { updatedAt: new Date() } });
  return result.modifiedCount === 1;
}

export async function moveXtreamSources(fromOwnerId, toOwnerId) {
  if (!fromOwnerId || !toOwnerId || fromOwnerId === toOwnerId) return;
  const from = await accountForLibraryOwner(fromOwnerId);
  const to = await accountForLibraryOwner(toOwnerId);
  const providers = [...(to.account.providers || [])];
  for (const source of from.account.providers || []) if (!providers.some(item => item._id === source._id)) providers.push(source);
  await to.collection.updateOne({ _id: to.account._id }, { $set: { providers, updatedAt: new Date() } });
  if (String(from.account._id) !== String(to.account._id)) await from.collection.updateOne({ _id: from.account._id }, { $set: { providers: [], updatedAt: new Date() } });
}

export async function deduplicateXtreamSources(ownerId) {
  const located = await accountForLibraryOwner(ownerId);
  const providers = Array.isArray(located.account.providers) ? located.account.providers : [];
  const groups = new Map();
  for (const source of providers) {
    const signature = `${source.type || 'xtream'}\u0000${source.baseUrl || ''}\u0000${source.username || ''}`;
    const group = groups.get(signature) || []; group.push(source); groups.set(signature, group);
  }
  const keep = [];
  for (const group of groups.values()) keep.push(group[0]);
  if (keep.length !== providers.length) await located.collection.updateOne({ _id: located.account._id }, { $set: { providers: keep, updatedAt: new Date() } });
}
