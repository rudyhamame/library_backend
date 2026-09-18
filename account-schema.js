export const databaseName = process.env.MONGODB_DB || 'rh_roku';

export const collectionNames = {
  identity: 'identity',
  meta: 'meta',
  catalogItems: 'catalog_items',
  catalogSyncs: 'catalog_syncs',
};

export const identityValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'email', 'passwordHash', 'account', 'credentials', 'preferences', 'providers', 'profiles', 'metadata'],
    properties: {
      _id: { bsonType: ['objectId', 'string'] },
      email: { bsonType: 'string' },
      passwordHash: { bsonType: 'string' },
      account: { bsonType: 'object', required: ['email'], properties: { email: { bsonType: 'string' } } },
      credentials: { bsonType: 'object' },
      preferences: { bsonType: 'object' },
      selectedProviderId: { bsonType: ['string', 'null'] },
      providers: { bsonType: 'array' },
      profiles: { bsonType: 'array' },
      metadata: { bsonType: 'object' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const metaValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'createdAt', 'updatedAt'],
    properties: {
      _id: { bsonType: 'string' },
      type: { bsonType: 'string', enum: ['verified-account', 'signup-verification', 'password-reset', 'roku-auth', 'system'] },
      accountId: { bsonType: ['string', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const catalogItemValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'accountId', 'providerId', 'kind', 'itemId', 'title'],
    properties: {
      _id: { bsonType: 'string' },
      accountId: { bsonType: 'string' },
      providerId: { bsonType: 'string' },
      kind: { bsonType: 'string', enum: ['movie', 'series', 'channel'] },
      itemId: { bsonType: 'string' },
      title: { bsonType: 'string' },
      categoryId: { bsonType: 'string' },
      metadata: { bsonType: 'object' },
      updatedAt: { bsonType: 'date' },
    },
  },
};