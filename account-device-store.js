import { MongoClient, ObjectId } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';
let clientPromise;

async function collections() {
  if (!clientPromise) clientPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, maxIdleTimeMS: 30_000 }).connect().catch(error => { clientPromise = undefined; throw error; });
  const client = await clientPromise;
  return [client.db(rokuDb).collection('identity'), client.db(generalDb).collection('identity')];
}

function matchesValue(value, expected) {
  if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
    if ('$exists' in expected) return (value !== undefined) === expected.$exists;
    if ('$gte' in expected) return value !== undefined && new Date(value).getTime() >= new Date(expected.$gte).getTime();
    if ('$nin' in expected) return !expected.$nin.includes(value);
  }
  return String(value ?? '') === String(expected ?? '');
}

function matches(row, filter) { return Object.entries(filter).every(([key, expected]) => matchesValue(row[key], expected)); }

async function locatedRows(filter = {}) {
  const result = [];
  for (const collection of await collections()) {
    const query = ObjectId.isValid(filter.accountId) ? { _id: new ObjectId(String(filter.accountId)) } : {};
    if (filter.deviceId && typeof filter.deviceId === 'string') query['devices.deviceId'] = filter.deviceId;
    const accounts = await collection.find(query, { projection: { devices: 1 } }).toArray();
    for (const account of accounts) {
      for (const device of Array.isArray(account.devices) ? account.devices : []) {
        const row = { ...device, _id: `device:${device.deviceId}`, accountId: account._id };
        if (matches(row, filter)) result.push({ row, collection, account });
      }
    }
  }
  return result;
}

async function locateAccount(accountId) {
  if (!ObjectId.isValid(accountId)) throw new Error('Account ID is required for a linked device');
  const id = new ObjectId(String(accountId));
  for (const collection of await collections()) {
    const account = await collection.findOne({ _id: id }, { projection: { _id: 1 } });
    if (account) return { collection, id };
  }
  throw new Error('Linked device account not found');
}

function deviceFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !['_id', 'type', 'accountId'].includes(key)));
}

async function updateOne(filter, update, options = {}) {
  if (options.upsert) {
    const accountId = update.$set?.accountId;
    const deviceId = String(filter.deviceId || update.$setOnInsert?.deviceId || '');
    if (!deviceId) throw new Error('Device ID is required');
    const target = await locateAccount(accountId);
    const existing = await locatedRows({ deviceId });
    for (const entry of existing) {
      if (String(entry.account._id) !== String(target.id)) {
        await entry.collection.updateOne({ _id: entry.account._id }, { $pull: { devices: { deviceId } }, $set: { updatedAt: new Date() } });
      }
    }
    const current = existing.find(entry => String(entry.account._id) === String(target.id));
    if (current) return updateOne({ accountId: target.id, deviceId }, update);
    const device = { ...deviceFields(update.$setOnInsert), ...deviceFields(update.$set), deviceId };
    const result = await target.collection.updateOne(
      { _id: target.id, 'devices.deviceId': { $ne: deviceId } },
      { $push: { devices: device }, $set: { updatedAt: new Date() } },
    );
    if (result.modifiedCount) return result;
    return updateOne({ accountId: target.id, deviceId }, update);
  }
  const [entry] = await locatedRows(filter);
  if (!entry) return { matchedCount: 0, modifiedCount: 0 };
  const { collection, account, row } = entry;
  if (Object.hasOwn(update.$unset || {}, 'accountId')) {
    return collection.updateOne({ _id: account._id }, { $pull: { devices: { deviceId: row.deviceId } }, $set: { updatedAt: new Date() } });
  }
  const set = Object.fromEntries(Object.entries(deviceFields(update.$set)).map(([key, value]) => [`devices.$.${key}`, value]));
  const unset = Object.fromEntries(Object.keys(update.$unset || {}).filter(key => key !== 'accountId').map(key => [`devices.$.${key}`, '']));
  const operation = {};
  if (Object.keys(set).length) operation.$set = set;
  if (Object.keys(unset).length) operation.$unset = unset;
  if (!Object.keys(operation).length) return { matchedCount: 1, modifiedCount: 0 };
  return collection.updateOne({ _id: account._id, 'devices.deviceId': row.deviceId }, operation);
}

export async function linkedDeviceStore() {
  return {
    findOne: async (filter, options) => (await locatedRows(filter))[0]?.row || null,
    find: (filter = {}, options) => {
      let order = null;
      return {
        sort(spec) { order = spec; return this; },
        async toArray() {
          const rows = (await locatedRows(filter)).map(entry => entry.row);
          if (order) {
            const [[field, direction]] = Object.entries(order);
            rows.sort((a, b) => (new Date(a[field] || 0).getTime() - new Date(b[field] || 0).getTime()) * direction);
          }
          return rows;
        },
      };
    },
    updateOne,
    updateMany: async (filter, update) => {
      let modifiedCount = 0;
      const rows = await locatedRows(filter);
      for (const entry of rows) modifiedCount += (await updateOne({ accountId: entry.account._id, deviceId: entry.row.deviceId }, update)).modifiedCount || 0;
      return { matchedCount: rows.length, modifiedCount };
    },
  };
}
