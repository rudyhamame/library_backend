import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { cleanLibraryCategoryName, libraryItemKey, reconcileLibraryCategories, validLibraryKinds } from './library-category-core.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_stream';
const collectionName = process.env.MONGODB_LIBRARY_CATEGORY_COLLECTION || 'library_categories';
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
  return publicLibrary(document, suppliedItems, validLibraryKinds.has(kind) ? kind : '');
}

export async function createLibraryCategory(ownerId, suppliedItems, { kind, name }) {
  if (!validLibraryKinds.has(kind)) throw new Error('kind must be series, movie, or channel');
  const categoryName = cleanLibraryCategoryName(name);
  if (!categoryName) throw new Error('Category name is required');
  const document = await synchronizedDocument(ownerId, suppliedItems);
  document.categories.push({ id: randomUUID(), kind, name: categoryName, sourceKeys: [], deleted: false, createdAt: new Date(), updatedAt: new Date() });
  document.updatedAt = new Date();
  await (await categoryCollection()).replaceOne({ ownerId }, document, { upsert: true });
  return publicLibrary(document, suppliedItems);
}

export async function renameLibraryCategory(ownerId, suppliedItems, categoryId, name) {
  const categoryName = cleanLibraryCategoryName(name);
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
