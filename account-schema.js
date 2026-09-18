export const databaseName = process.env.MONGODB_DB || 'rh_roku';

export const collectionNames = {
  identity: 'identity',
  meta: 'meta',
};

export const identityValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'email', 'passwordHash', 'providers', 'profiles', 'devices'],
    properties: {
      _id: { bsonType: ['objectId', 'string'] },
      email: { bsonType: 'string' },
      passwordHash: { bsonType: 'string' },
      providers: { bsonType: 'array' },
      profiles: { bsonType: 'array' },
      library: { bsonType: 'object' },
      devices: { bsonType: 'array' },
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
      accountId: { bsonType: ['objectId', 'string', 'null'] },
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
