import 'dotenv/config';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databases = [...new Set([process.env.MONGODB_DB || 'rh_roku', process.env.MONGODB_GENERAL_DB || 'rh_general'])];
const apply = process.argv.includes('--apply');
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8_000 });

try {
  await client.connect();
  for (const databaseName of databases) {
    const collection = client.db(databaseName).collection('identity');
    let scanned = 0;
    let changed = 0;
    for await (const account of collection.find({ devices: { $type: 'array' } }, { projection: { devices: 1, rokuDeviceId: 1 } })) {
      scanned++;
      const rokuDevices = (account.devices || []).filter(device =>
        device?.kind === 'roku' || String(device?.deviceId || '') === String(account.rokuDeviceId || ''),
      );
      const keeperId = String(account.rokuDeviceId || rokuDevices[0]?.deviceId || '');
      const kept = keeperId ? rokuDevices.filter(device => String(device.deviceId || '') === keeperId).slice(0, 1) : [];
      if (JSON.stringify(kept) === JSON.stringify(account.devices || [])) continue;
      changed++;
      if (apply) await collection.updateOne({ _id: account._id }, { $set: { devices: kept, updatedAt: new Date() } });
    }
    console.log(`[${databaseName}] accounts scanned=${scanned} ${apply ? 'cleaned' : 'would clean'}=${changed}`);
  }
  if (!apply) console.log('Dry run only. Re-run with --apply to remove non-Roku and duplicate Roku device entries.');
} finally {
  await client.close();
}
