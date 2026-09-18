import { getAccountLibrary, updateAccountLibrary } from './account-library-data.js';

function matches(row, key) {
  return row.profileId === key.profileId && row.sourceId === key.sourceId
    && row.kind === key.kind && row.itemId === key.itemId;
}

export async function getFavorites(ownerId, profileId) {
  if (!ownerId || !profileId) return [];
  const library = await getAccountLibrary(ownerId, profileId);
  return library.favorites.filter(row => !row.profileId || row.profileId === String(profileId))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .map(({ ownerId: _ownerId, profileId: _profileId, itemId, ...item }) => ({ id: itemId, ...item }));
}

export async function toggleFavorite({ ownerId, profileId, id, title, kind, sourceId = '', logo = '', category = '', extension = '', favorite = undefined }) {
  if (!ownerId || !profileId || !id) throw new Error('Account, profile, and item ID are required');
  if (!sourceId || !kind) throw new Error('Provider and item kind are required');
  const key = { profileId: String(profileId), sourceId: String(sourceId), kind: String(kind), itemId: String(id) };
  let response;
  await updateAccountLibrary(ownerId, library => {
    const index = library.favorites.findIndex(row => matches(row, key));
    const existing = index >= 0 ? library.favorites[index] : null;
    const desiredFavorite = typeof favorite === 'boolean' ? favorite : !existing;
    if (!desiredFavorite) {
      if (index >= 0) library.favorites.splice(index, 1);
      response = { id, favorite: false };
      return library;
    }
    const item = {
      ...key,
      title: String(title || existing?.title || ''),
      logo: String(logo || existing?.logo || ''),
      category: String(category || existing?.category || ''),
      extension: String(extension || existing?.extension || ''),
      updatedAt: new Date(),
    };
    if (index >= 0) library.favorites[index] = item;
    else library.favorites.push(item);
    response = { id, title: item.title, kind: key.kind, sourceId: key.sourceId, favorite: true };
    return library;
  }, profileId);
  return response;
}

// Legacy device-owner favorites are migrated before the old collection is
// removed. New favorites are already inside the account and need no re-home.
export async function moveFavoriteOwners() {}
