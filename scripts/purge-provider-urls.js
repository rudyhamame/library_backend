// Remove provider URLs from both account databases. Playback URLs are
// credentials-bearing and are never a durable identity; they are resolved
// from providerIdentity/sourceId at request time.
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databases = [...new Set([process.env.MONGODB_DB || 'rh_roku', process.env.MONGODB_GENERAL_DB || 'rh_general'])];

const client = await MongoClient.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
try {
  for (const name of databases) {
    const db = client.db(name);
    let changed = 0;
    const identities = db.collection('identity');
    const libraryFields = {};
    for (const path of [
      'profiles.$[].library.favorites.$[].providerURL', 'profiles.$[].library.favorites.$[].providerUrl',
      'profiles.$[].library.savedSelections.series.$[].providerURL', 'profiles.$[].library.savedSelections.series.$[].providerUrl',
      'profiles.$[].library.savedSelections.movies.$[].providerURL', 'profiles.$[].library.savedSelections.movies.$[].providerUrl',
      'profiles.$[].library.savedSelections.live.$[].providerURL', 'profiles.$[].library.savedSelections.live.$[].providerUrl',
      'profiles.$[].library.streaming_history.series.$[].episodes.$[].providerURL', 'profiles.$[].library.streaming_history.series.$[].episodes.$[].providerUrl',
      'profiles.$[].library.streaming_history.movies.$[].providerURL', 'profiles.$[].library.streaming_history.movies.$[].providerUrl',
      'profiles.$[].library.streaming_history.live.$[].providerURL', 'profiles.$[].library.streaming_history.live.$[].providerUrl',
      'providers.$[].providerURL', 'providers.$[].providerUrl',
    ]) libraryFields[path] = '';
    const libraryResult = await identities.updateMany({}, { $unset: libraryFields });
    changed += libraryResult.modifiedCount;
    for (const collectionName of ['playback_progress', process.env.MONGODB_PLAYBACK_COLLECTION].filter(Boolean)) {
      const result = await db.collection(collectionName).updateMany({}, { $unset: { url: '', providerURL: '', providerUrl: '' } });
      changed += result.modifiedCount;
    }
    const catalogResult = await db.collection('provider_catalog_items').updateMany({}, { $unset: { providerURL: '', providerUrl: '' } });
    const episodeResult = await db.collection('provider_catalog_items_episodes').updateMany({}, { $unset: { providerURL: '', providerUrl: '', 'episodes.$[].providerURL': '', 'episodes.$[].providerUrl': '' } });
    changed += catalogResult.modifiedCount + episodeResult.modifiedCount;
    console.log(`[${name}] provider URL fields removed from ${changed} document(s)`);
  }
} finally {
  await client.close();
}
