import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const collectionName = process.env.MONGODB_ANDROID_BETA_TESTERS_COLLECTION || 'android_beta_testers';
let collectionPromise;

async function collection() {
  if (!collectionPromise) {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5, maxIdleTimeMS: 30_000 });
    collectionPromise = client.connect()
      .then(async () => {
        const target = client.db(databaseName).collection(collectionName);
        await target.createIndex({ email: 1 }, { unique: true, name: 'android_beta_tester_email' });
        return target;
      })
      .catch(error => { collectionPromise = undefined; client.close().catch(() => {}); throw error; });
  }
  return collectionPromise;
}

export function normalizeTesterEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

export async function registerAndroidBetaTester(email, source = 'download-page') {
  const normalizedEmail = normalizeTesterEmail(email);
  if (!normalizedEmail) return { error: 'Enter a valid email address.' };
  const result = await (await collection()).updateOne(
    { email: normalizedEmail },
    { $setOnInsert: { email: normalizedEmail, source, createdAt: new Date(), status: 'pending-invitation' } },
    { upsert: true },
  );
  return { ok: true, created: result.upsertedCount === 1 };
}
