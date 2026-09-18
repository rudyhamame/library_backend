import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { accountForLibraryOwner, updateAccountLibrary } from './account-library-data.js';
import { accountOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const collectionName = process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources';
let collectionPromise;

async function sourceCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(client => client.db(databaseName).collection(collectionName))
      .catch(error => {
        collectionPromise = undefined;
        throw error;
      });
  }
  return collectionPromise;
}

const selectionFields = ['enabledKeys', 'enabledItems', 'archivedKeys', 'archivedItems'];

export function selectionFor(source, ownerId, accountOwner) {
  void accountOwner;
  const selection = source?.selections?.[String(ownerId)];
  return Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection?.[field]) ? selection[field] : []]));
}

async function withProfileSelections(sources, accountOwner) {
  if (!accountOwner || !sources.length) return sources;
  const { account } = await accountForLibraryOwner(accountOwner);
  return sources.map(source => {
    const selections = {};
    for (const profile of account.profiles || []) {
      const owner = profile.isDefault ? accountOwnerId(account._id) : String(profile.ownerId);
      const selected = profile.library?.savedSelections?.[String(source._id)];
      if (selected) selections[owner] = selected;
    }
    return { ...source, selections };
  });
}

export function flattenSelection(sources, ownerId, accountOwner) {
  return (sources || []).map(source => ({ ...source, ...selectionFor(source, ownerId, accountOwner) }));
}

export function publicXtreamSource(source, ownerId, accountOwner) {
  if (!source) return null;
  const selected = selectionFor(source, ownerId, accountOwner);
  return {
    id: source._id,
    name: source.name,
    type: source.type || 'xtream',
    endpoint: source.baseUrl,
    hasCredentials: Boolean(source.username && source.password),
    enabledKeys: selected.enabledKeys,
    enabledItems: selected.enabledItems,
    archivedKeys: selected.archivedKeys,
    archivedItems: selected.archivedItems,
    selectedCount: selected.enabledKeys.length,
    archivedCount: selected.archivedKeys.length,
    connectionStatus: source.connectionStatus || 'unknown',
    connectionMessage: source.connectionMessage || '',
    updatedAt: source.updatedAt,
  };
}

export async function getXtreamSources(ownerId) {
  const filter = ownerId ? { ownerId } : {};
  const sources = await (await sourceCollection()).find(filter).sort({ name: 1, updatedAt: -1 }).toArray();
  return (await withProfileSelections(sources, ownerId)).map(source => publicXtreamSource(source, ownerId, ownerId));
}

export async function getXtreamSource(id, ownerId) {
  const source = await (await sourceCollection()).findOne({ _id: id, ...(ownerId ? { ownerId } : {}) });
  return source ? (await withProfileSelections([source], ownerId))[0] : null;
}

export async function getAllXtreamSources(ownerId) {
  const sources = await (await sourceCollection()).find(ownerId ? { ownerId } : {}).sort({ name: 1, updatedAt: -1 }).toArray();
  return withProfileSelections(sources, ownerId);
}

export async function createXtreamSource({ name, type = 'xtream', baseUrl, username = '', password = '', ownerId, connectionStatus = 'online', connectionMessage = '' }) {
  const source = {
    _id: randomUUID(), name, type, baseUrl, username, password, ownerId,
    connectionStatus, connectionMessage,
    enabledKeys: [], enabledItems: [], archivedKeys: [], archivedItems: [], createdAt: new Date(), updatedAt: new Date(),
  };
  await (await sourceCollection()).insertOne(source);
  return publicXtreamSource(source);
}

export async function updateXtreamSource(id, changes, ownerId) {
  const result = await (await sourceCollection()).findOneAndUpdate(
    { _id: id, ...(ownerId ? { ownerId } : {}) },
    { $set: { ...changes, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return publicXtreamSource(result?.value || result);
}

export async function updateXtreamSelection(id, selection, accountOwner, profileOwner = accountOwner) {
  if (profileOwner && String(profileOwner) !== String(accountOwner) && !/^[a-f0-9]{64}$/i.test(String(profileOwner))) return null;
  const fields = Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection?.[field]) ? selection[field] : []]));
  const source = await (await sourceCollection()).findOne({ _id: id, ownerId: accountOwner });
  if (!source) return null;
  await updateAccountLibrary(profileOwner, library => {
    library.savedSelections[String(id)] = fields;
    return library;
  });
  return publicXtreamSource({ ...source, selections: { [String(profileOwner)]: fields } }, profileOwner, accountOwner);
}

export async function deleteXtreamSource(id, ownerId) {
  const result = await (await sourceCollection()).deleteOne({ _id: id, ...(ownerId ? { ownerId } : {}) });
  return result.deletedCount === 1;
}

export async function moveXtreamSources(fromOwnerId, toOwnerId) {
  if (!fromOwnerId || !toOwnerId || fromOwnerId === toOwnerId) return;
  await (await sourceCollection()).updateMany({ ownerId: fromOwnerId }, { $set: { ownerId: toOwnerId, updatedAt: new Date() } });
}

export async function deduplicateXtreamSources(ownerId) {
  if (!ownerId) return;
  const collection = await sourceCollection();
  const sources = await collection.find({ ownerId }).sort({ updatedAt: -1 }).toArray();
  const groups = new Map();
  for (const source of sources) {
    const signature = `${source.type || 'xtream'}\u0000${source.baseUrl || ''}\u0000${source.username || ''}`;
    const group = groups.get(signature) || [];
    group.push(source);
    groups.set(signature, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keeper, ...duplicates] = group;
    const enabled = new Map();
    const archived = new Map();
    const selections = {};
    for (const source of group) {
      for (const item of source.enabledItems || []) enabled.set(item.key, item);
      for (const item of source.archivedItems || []) archived.set(item.key, item);
      for (const [profileId, selection] of Object.entries(source.selections || {})) {
        selections[profileId] ||= { enabledKeys: [], enabledItems: [], archivedKeys: [], archivedItems: [] };
        for (const field of selectionFields) {
          const values = Array.isArray(selection?.[field]) ? selection[field] : [];
          if (field.endsWith('Keys')) selections[profileId][field] = [...new Set([...(selections[profileId][field] || []), ...values.map(String)])];
          else selections[profileId][field] = [...(selections[profileId][field] || []), ...values];
        }
      }
    }
    for (const key of enabled.keys()) archived.delete(key);
    await collection.updateOne({ _id: keeper._id, ownerId }, { $set: {
      enabledKeys: [...enabled.keys()], enabledItems: [...enabled.values()],
      archivedKeys: [...archived.keys()], archivedItems: [...archived.values()], updatedAt: new Date(),
      selections,
    } });
    await collection.deleteMany({ _id: { $in: duplicates.map(source => source._id) }, ownerId });
  }
}
