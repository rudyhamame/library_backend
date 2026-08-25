import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const legacyDataFile = resolve(moduleDirectory, 'data/playlists.json');
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_PLAYLIST_COLLECTION || 'playlists';

let client;
let collectionPromise;
let migrationPromise;

function emptyStructure() {
  return { series: [] };
}

function normalizeStructure(structure) {
  return structure && Array.isArray(structure.series) ? structure : emptyStructure();
}

async function playlistCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      return client.db(databaseName).collection(collectionName);
    })().catch(error => {
      collectionPromise = undefined;
      throw error;
    });
  }
  return collectionPromise;
}

async function readLegacyPlaylists() {
  try {
    const parsed = JSON.parse(await readFile(legacyDataFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function migrateLegacyPlaylists() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const collection = await playlistCollection();
      const legacy = await readLegacyPlaylists();
      const structures = legacy._structures && typeof legacy._structures === 'object' ? legacy._structures : {};
      const names = Object.keys(legacy).filter(name => name !== '_structures' && Array.isArray(legacy[name]));
      let imported = 0;

      for (const name of names) {
        const result = await collection.updateOne(
          { _id: name },
          {
            $setOnInsert: {
              items: legacy[name],
              structure: normalizeStructure(structures[name]),
              schemaVersion: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
              migratedFrom: 'data/playlists.json'
            }
          },
          { upsert: true }
        );
        if (result.upsertedCount === 1) imported += 1;
      }

      return { imported, discovered: names.length, database: databaseName, collection: collectionName };
    })().catch(error => {
      migrationPromise = undefined;
      throw error;
    });
  }
  return migrationPromise;
}

async function getPlaylistDocument(name) {
  await migrateLegacyPlaylists();
  return (await playlistCollection()).findOne({ _id: name });
}

export async function getPlaylist(name = 'default') {
  const document = await getPlaylistDocument(name);
  return Array.isArray(document?.items) ? document.items : [];
}

export async function getPlaylistStructure(name = 'default') {
  const document = await getPlaylistDocument(name);
  return normalizeStructure(document?.structure);
}

export async function savePlaylist(items, name = 'default', structure = undefined) {
  await migrateLegacyPlaylists();
  const collection = await playlistCollection();
  const update = {
    $set: { items, updatedAt: new Date(), schemaVersion: 1 },
    $setOnInsert: { createdAt: new Date() }
  };
  if (structure !== undefined) update.$set.structure = normalizeStructure(structure);
  else update.$setOnInsert.structure = emptyStructure();
  await collection.updateOne({ _id: name }, update, { upsert: true });
  return items;
}

export async function getPlaylistStoreStatus() {
  const collection = await playlistCollection();
  const documentCount = await collection.countDocuments();
  return { type: 'mongodb', database: databaseName, collection: collectionName, playlists: documentCount };
}

export async function closePlaylistStore() {
  if (client) await client.close();
  client = undefined;
  collectionPromise = undefined;
  migrationPromise = undefined;
}
