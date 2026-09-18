import { getAccountLibrary, updateAccountLibrary } from './account-library-data.js';

const matches = (row, ownerId, sourceId, seriesId) => row.profileOwnerId === String(ownerId)
  && row.sourceId === String(sourceId) && row.seriesId === String(seriesId);

export async function getSeriesWatchOverride(ownerId, sourceId, seriesId) {
  if (!ownerId || !sourceId || !seriesId) return null;
  const library = await getAccountLibrary(ownerId);
  return library.seriesWatchOverrides.find(row => matches(row, ownerId, sourceId, seriesId)) || null;
}

export async function toggleSeriesWatchOverride({ ownerId, sourceId, seriesId, episodeId, episodeTitle = '', seasonNumber = 0, episodeNumber = 0 }) {
  if (!ownerId || !sourceId || !seriesId || !episodeId) throw new Error('sourceId, seriesId and episodeId are required');
  let response;
  await updateAccountLibrary(ownerId, library => {
    const index = library.seriesWatchOverrides.findIndex(row => matches(row, ownerId, sourceId, seriesId));
    if (index >= 0 && String(library.seriesWatchOverrides[index].episodeId) === String(episodeId)) {
      library.seriesWatchOverrides.splice(index, 1);
      response = { active: false, episodeId: '' };
      return library;
    }
    const row = {
      profileOwnerId: String(ownerId), sourceId: String(sourceId), seriesId: String(seriesId), episodeId: String(episodeId),
      episodeTitle: String(episodeTitle || ''), seasonNumber: Number(seasonNumber) || 0,
      episodeNumber: Number(episodeNumber) || 0, updatedAt: new Date(),
    };
    if (index >= 0) library.seriesWatchOverrides[index] = row;
    else library.seriesWatchOverrides.push(row);
    response = { active: true, episodeId: String(episodeId) };
    return library;
  });
  return response;
}

export async function getSeriesWatchOverridesByOwner(ownerId) {
  if (!ownerId) return [];
  return (await getAccountLibrary(ownerId)).seriesWatchOverrides.filter(row => row.profileOwnerId === String(ownerId));
}

export async function moveSeriesWatchOverrideOwners() {}
