import 'dotenv/config';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 8_000 });
try {
  await client.connect();
  const database = process.env.MONGODB_DB || 'rh_roku';
  const collection = process.env.MONGODB_ANDROID_BETA_TESTERS_COLLECTION || 'android_beta_testers';
  const rows = await client.db(database).collection(collection).find({}, { projection: { email: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray();
  const escapeCsv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  process.stdout.write('email,registered_at\n');
  for (const row of rows) process.stdout.write(`${escapeCsv(row.email)},${escapeCsv(row.createdAt?.toISOString?.() || '')}\n`);
} finally {
  await client.close();
}
