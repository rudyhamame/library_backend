// Canonicalize favorites and savedSelections to the shared identity-only shape:
// { series: [{ providerIdentity: { sourceId, kind: 'series', seriesId } }],
//   movies: [{ providerIdentity: { itemId, kind: 'movie', sourceId } }],
//   live: [{ providerIdentity: { itemId, kind: 'channel', sourceId } }] }
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { normalizeIdentityBuckets } from '../library-identity.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databases = [process.env.MONGODB_DB || 'rh_roku', process.env.MONGODB_GENERAL_DB || 'rh_general'];

const client = await MongoClient.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
try {
  for (const databaseName of databases) {
    const collection = client.db(databaseName).collection('identity');
    let changed = 0;
    for (const account of await collection.find({ profiles: { $exists: true } }).toArray()) {
      let accountChanged = false;
      const profiles = (account.profiles || []).map(profile => {
        if (!profile.library) return profile;
        const favorites = normalizeIdentityBuckets(profile.library.favorites);
        const savedSelections = normalizeIdentityBuckets(profile.library.savedSelections);
        const before = JSON.stringify({ favorites: profile.library.favorites || [], savedSelections: profile.library.savedSelections || {} });
        const after = JSON.stringify({ favorites, savedSelections });
        if (before === after) return profile;
        accountChanged = true;
        return { ...profile, library: { ...profile.library, favorites, savedSelections } };
      });
      if (accountChanged) {
        await collection.updateOne({ _id: account._id }, { $set: { profiles, updatedAt: new Date() } });
        changed++;
      }
    }
    console.log(`[${databaseName}] canonical identity profiles changed=${changed}`);
  }
} finally {
  await client.close();
}
