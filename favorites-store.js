import { getAccountLibrary, updateAccountLibrary } from './account-library-data.js';
import { flatIdentityRows, normalizeIdentityBuckets, providerIdentityOf } from './library-identity.js';

export async function getFavorites(ownerId, profileId) {
  if (!ownerId || !profileId) return [];
  const library = await getAccountLibrary(ownerId, profileId);
  return flatIdentityRows(library.favorites);
}

export async function toggleFavorite({ ownerId, profileId, id, title, kind, sourceId = '', logo = '', category = '', extension = '', favorite = undefined }) {
  if (!ownerId || !profileId || !id) throw new Error('Account, profile, and item ID are required');
  if (!sourceId || !kind) throw new Error('Provider and item kind are required');
  const bucket = kind === 'series' ? 'series' : kind === 'channel' ? 'live' : 'movies';
  const providerIdentity = providerIdentityOf({ sourceId, kind, id }, bucket);
  if (!providerIdentity) throw new Error('Provider identity is required');
  let response;
  await updateAccountLibrary(ownerId, library => {
    const favorites = normalizeIdentityBuckets(library.favorites);
    const index = favorites[bucket].findIndex(row => JSON.stringify(row.providerIdentity) === JSON.stringify(providerIdentity));
    const existing = index >= 0 ? favorites[bucket][index] : null;
    const desiredFavorite = typeof favorite === 'boolean' ? favorite : !existing;
    if (!desiredFavorite) {
      if (index >= 0) favorites[bucket].splice(index, 1);
      library.favorites = favorites;
      response = { id, providerIdentity, favorite: false };
      return library;
    }
    if (index < 0) favorites[bucket].push({ providerIdentity });
    library.favorites = favorites;
    response = { id, providerIdentity, favorite: true };
    return library;
  }, profileId);
  return response;
}

// Legacy device-owner favorites are migrated before the old collection is
// removed. New favorites are already inside the account and need no re-home.
export async function moveFavoriteOwners() {}
