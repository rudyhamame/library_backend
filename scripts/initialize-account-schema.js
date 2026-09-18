import { MongoClient } from 'mongodb';
import { catalogItemValidator, collectionNames, databaseName, identityValidator, metaValidator } from '../account-schema.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });

async function ensureCollection(db, name, validator) {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const exists = collections.some(collection => collection.name === name);
  if (!exists) await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
  else await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
}

try {
  await client.connect();
  const db = client.db(databaseName);
  await ensureCollection(db, collectionNames.identity, identityValidator);
  await ensureCollection(db, collectionNames.meta, metaValidator);
  await ensureCollection(db, collectionNames.catalogItems, catalogItemValidator);
  await ensureCollection(db, collectionNames.catalogSyncs, {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'accountId', 'providerId', 'updatedAt'],
      properties: { _id: { bsonType: 'string' }, accountId: { bsonType: 'string' }, providerId: { bsonType: 'string' }, updatedAt: { bsonType: 'date' } },
    },
  });
  await Promise.all([
    db.collection(collectionNames.identity).createIndex({ 'account.email': 1 }, { unique: true, name: 'identity_email' }),
    db.collection(collectionNames.meta).createIndex({ type: 1, accountId: 1, updatedAt: -1 }, { name: 'meta_type_account_updated' }),
    db.collection(collectionNames.catalogItems).createIndex({ accountId: 1, providerId: 1, kind: 1, itemId: 1 }, { unique: true, name: 'catalog_account_provider_item' }),
    db.collection(collectionNames.catalogItems).createIndex({ accountId: 1, providerId: 1, kind: 1, categoryId: 1, title: 1 }, { name: 'catalog_browse' }),
    db.collection(collectionNames.catalogSyncs).createIndex({ accountId: 1, providerId: 1 }, { unique: true, name: 'catalog_sync_account_provider' }),
  ]);
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name).sort();
  console.log(JSON.stringify({ ok: true, database: databaseName, collections }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close();
}