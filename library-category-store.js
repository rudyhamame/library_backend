import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_LIBRARY_CATEGORY_COLLECTION || 'library_categories';
const validKinds = new Set(['series', 'movie', 'channel']);
let collectionPromise;

async function categoryCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(async client => {
        const collection = client.db(databaseName).collection(collectionName);
        await collection.createIndex({ ownerId: 1 }, { unique: true });
        return collection;
      })
      .catch(error => { collectionPromise = undefined; throw error; });
  }
  return collectionPromise;
}

const cleanName = value => String(value || '').trim().slice(0, 120);
const categorySourceKey = item => `${item.sourceId}:${item.kind}:${String(item.categoryId || item.category || 'Other').trim().toLocaleLowerCase()}`;
export const libraryItemKey = item => `${item.sourceId}:${item.key}`;

export function reconcileLibraryCategories(document, suppliedItems, now = new Date()) {
  const categories = Array.isArray(document?.categories) ? structuredClone(document.categories) : [];
  const priorAssignments = new Map((Array.isArray(document?.assignments) ? document.assignments : [])
    .map(entry => [String(entry.itemKey), entry.categoryId == null ? null : String(entry.categoryId)]));
  const items = suppliedItems.filter(item => validKinds.has(item.kind) && item.sourceId && item.key);
  const liveKeys = new Set(items.map(libraryItemKey));
  const assignments = new Map([...priorAssignments].filter(([itemKey]) => liveKeys.has(itemKey)));

  for (const item of items) {
    const sourceKey = categorySourceKey(item);
    let category = categories.find(entry => entry.kind === item.kind && Array.isArray(entry.sourceKeys) && entry.sourceKeys.includes(sourceKey));
    if (!category) {
      category = {
        id: randomUUID(), kind: item.kind, name: cleanName(item.category) || 'Other',
        sourceKeys: [sourceKey], deleted: false, createdAt: now, updatedAt: now,
      };
      categories.push(category);
    }
    const itemKey = libraryItemKey(item);
    if (!assignments.has(itemKey)) assignments.set(itemKey, category.id);
  }

  return {
    ownerId: document?.ownerId,
    categories,
    assignments: [...assignments].map(([itemKey, categoryId]) => ({ itemKey, categoryId })),
    createdAt: document?.createdAt || now,
    updatedAt: now,
  };
}

function publicLibrary(document, suppliedItems, kind = '') {
  const assignments = new Map(document.assignments.map(entry => [entry.itemKey, entry.categoryId]));
  const items = suppliedItems
    .filter(item => !kind || item.kind === kind)
    .map(item => ({ ...item, libraryKey: libraryItemKey(item), libraryCategoryId: assignments.get(libraryItemKey(item)) ?? null }));
  const byKey = new Map(items.map(item => [item.libraryKey, item]));
  const categories = document.categories
    .filter(category => !category.deleted && (!kind || category.kind === kind))
    .map(category => ({
      id: category.id,
      kind: category.kind,
      name: category.name,
      items: document.assignments
        .filter(entry => entry.categoryId === category.id && byKey.has(entry.itemKey))
        .map(entry => ({ ...byKey.get(entry.itemKey), category: category.name, rokuCategory: category.name })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { categories, items };
}

async function synchronizedDocument(ownerId, suppliedItems) {
  const collection = await categoryCollection();
  const current = await collection.findOne({ ownerId }) || { ownerId, categories: [], assignments: [] };
  const next = reconcileLibraryCategories(current, suppliedItems);
  next.ownerId = ownerId;
  await collection.replaceOne({ ownerId }, next, { upsert: true });
  return next;
}

export async function getManagedLibrary(ownerId, suppliedItems, kind = '') {
  const document = await synchronizedDocument(ownerId, suppliedItems);
  return publicLibrary(document, suppliedItems, validKinds.has(kind) ? kind : '');
}

export async function createLibraryCategory(ownerId, suppliedItems, { kind, name }) {
  if (!validKinds.has(kind)) throw new Error('kind must be series, movie, or channel');
  const categoryName = cleanName(name);
  if (!categoryName) throw new Error('Category name is required');
  const document = await synchronizedDocument(ownerId, suppliedItems);
  document.categories.push({ id: randomUUID(), kind, name: categoryName, sourceKeys: [], deleted: false, createdAt: new Date(), updatedAt: new Date() });
  document.updatedAt = new Date();
  await (await categoryCollection()).replaceOne({ ownerId }, document, { upsert: true });
  return publicLibrary(document, suppliedItems);
}

export async function renameLibraryCategory(ownerId, suppliedItems, categoryId, name) {
  const categoryName = cleanName(name);
  if (!categoryName) throw new Error('Category name is required');
  const document = await synchronizedDocument(ownerId, suppliedItems);
  const category = document.categories.find(entry => entry.id === categoryId && !entry.deleted);
  if (!category) return null;
  category.name = categoryName;
  category.updatedAt = new Date();
  document.updatedAt = new Date();
  await (await categoryCollection()).replaceOne({ ownerId }, document, { upsert: true });
  return publicLibrary(document, suppliedItems);
}

export async function replaceLibraryCategoryItems(ownerId, suppliedItems, categoryId, itemKeys) {
  const document = await synchronizedDocument(ownerId, suppliedItems);
  const category = document.categories.find(entry => entry.id === categoryId && !entry.deleted);
  if (!category) return null;
  const allowed = new Set(suppliedItems.filter(item => item.kind === category.kind).map(libraryItemKey));
  const selected = new Set((Array.isArray(itemKeys) ? itemKeys : []).map(String).filter(key => allowed.has(key)));
  document.assignments = document.assignments.map(entry => {
    if (entry.categoryId === categoryId && !selected.has(entry.itemKey)) return { ...entry, categoryId: null };
    if (selected.has(entry.itemKey)) return { ...entry, categoryId };
    return entry;
  });
  category.updatedAt = new Date();
  document.updatedAt = new Date();
  await (await categoryCollection()).replaceOne({ ownerId }, document, { upsert: true });
  return publicLibrary(document, suppliedItems);
}

export async function deleteLibraryCategory(ownerId, suppliedItems, categoryId) {
  const document = await synchronizedDocument(ownerId, suppliedItems);
  const category = document.categories.find(entry => entry.id === categoryId && !entry.deleted);
  if (!category) return null;
  category.deleted = true;
  category.updatedAt = new Date();
  document.assignments = document.assignments.map(entry => entry.categoryId === categoryId ? { ...entry, categoryId: null } : entry);
  document.updatedAt = new Date();
  await (await categoryCollection()).replaceOne({ ownerId }, document, { upsert: true });
  return publicLibrary(document, suppliedItems);
}
