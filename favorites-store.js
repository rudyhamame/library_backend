import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const collectionName = process.env.MONGODB_FAVORITES_COLLECTION || 'favorites';
let collectionPromise;

async function favoritesCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(async client => {
        const collection = client.db(databaseName).collection(collectionName);
        // Favorites belong to one profile *and* one provider. Provider catalogs
        // commonly reuse numeric item IDs, so ownerId + itemId incorrectly
        // treats two different providers' items as the same favorite.
        let indexes = [];
        try { indexes = await collection.indexes(); }
        catch (error) {
          if (error?.codeName !== 'NamespaceNotFound') throw error;
        }
        const legacyIndex = indexes.find(index =>
          index.unique === true
          && JSON.stringify(index.key) === JSON.stringify({ ownerId: 1, itemId: 1 }));
        if (legacyIndex) await collection.dropIndex(legacyIndex.name);
        await collection.createIndex(
          { ownerId: 1, profileId: 1, sourceId: 1, kind: 1, itemId: 1 },
          { unique: true, name: 'profile_provider_favorite' },
        );
        return collection;
      })
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

export async function getFavorites(ownerId, profileId) {
  if (!ownerId || !profileId) return [];
  return (await (await favoritesCollection()).find({ ownerId: String(ownerId), profileId: String(profileId) }).sort({ updatedAt: -1 }).toArray())
    .map(({ _id, ownerId: _ownerId, profileId: _profileId, itemId, ...item }) => ({ id: itemId, ...item }));
}

export async function toggleFavorite({ ownerId, profileId, id, title, kind, sourceId = '', logo = '', category = '', extension = '', favorite = undefined }) {
  if (!ownerId || !profileId || !id) throw new Error('Account, profile, and item ID are required');
  if (!sourceId || !kind) throw new Error('Provider and item kind are required');
  const collection = await favoritesCollection();
  const key = {
    ownerId: String(ownerId),
    profileId: String(profileId),
    sourceId: String(sourceId),
    kind: String(kind),
    itemId: String(id),
  };
  const existing = await collection.findOne(key);
  const desiredFavorite = typeof favorite === 'boolean' ? favorite : !existing;
  if (!desiredFavorite) {
    if (existing) await collection.deleteOne(key);
    return { id, favorite: false };
  }
  if (existing) {
    await collection.updateOne(key, { $set: {
      title: String(title || existing.title || ''),
      logo: String(logo || existing.logo || ''),
      category: String(category || existing.category || ''),
      extension: String(extension || existing.extension || ''),
      updatedAt: new Date(),
    } });
    return { id, title: String(title || existing.title || ''), kind: key.kind, sourceId: key.sourceId, favorite: true };
  }
  const item = {
    ...key,
    title: String(title || ''),
    logo: String(logo || ''),
    category: String(category || ''),
    extension: String(extension || ''),
    updatedAt: new Date(),
  };
  await collection.insertOne(item);
  return { id, title: item.title, kind: item.kind, sourceId: item.sourceId, favorite: true };
}

export async function moveFavoriteOwners(fromOwnerIds, toOwnerId) {
  const owners = [...new Set((Array.isArray(fromOwnerIds) ? fromOwnerIds : [fromOwnerIds]).map(String).filter(Boolean))];
  if (!toOwnerId || owners.length === 0) return;
  await (await favoritesCollection()).updateMany({ ownerId: { $in: owners } }, { $set: { ownerId: String(toOwnerId) } });
}
