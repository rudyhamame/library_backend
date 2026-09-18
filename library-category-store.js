import { randomUUID } from 'node:crypto';
import { cleanLibraryCategoryName, libraryItemKey, reconcileLibraryCategories, validLibraryKinds } from './library-category-core.js';
import { updateAccountLibrary } from './account-library-data.js';

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

function scopedDocument(library, ownerId) {
  return {
    categories: library.categories.filter(row => row.profileOwnerId === String(ownerId)),
    assignments: library.assignments.filter(row => row.profileOwnerId === String(ownerId)),
  };
}

function mergeScoped(library, ownerId, document) {
  const profileOwnerId = String(ownerId);
  library.categories = [
    ...library.categories.filter(row => row.profileOwnerId !== profileOwnerId),
    ...document.categories.map(row => ({ ...row, profileOwnerId })),
  ];
  library.assignments = [
    ...library.assignments.filter(row => row.profileOwnerId !== profileOwnerId),
    ...document.assignments.map(row => ({ ...row, profileOwnerId })),
  ];
  return library;
}

async function synchronizedDocument(ownerId, suppliedItems) {
  const result = await updateAccountLibrary(ownerId, library => {
    const next = reconcileLibraryCategories(scopedDocument(library, ownerId), suppliedItems);
    return mergeScoped(library, ownerId, next);
  });
  return scopedDocument(result.library, ownerId);
}

export async function moveLibraryCategories(fromOwnerIds, toOwnerId) {
  void fromOwnerIds;
  void toOwnerId;
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
  await updateAccountLibrary(ownerId, library => mergeScoped(library, ownerId, document));
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
  await updateAccountLibrary(ownerId, library => mergeScoped(library, ownerId, document));
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
  await updateAccountLibrary(ownerId, library => mergeScoped(library, ownerId, document));
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
  await updateAccountLibrary(ownerId, library => mergeScoped(library, ownerId, document));
  return publicLibrary(document, suppliedItems);
}
