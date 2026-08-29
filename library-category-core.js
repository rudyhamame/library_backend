import { randomUUID } from 'node:crypto';

export const validLibraryKinds = new Set(['series', 'movie', 'channel']);
export const cleanLibraryCategoryName = value => String(value || '').trim().slice(0, 120);
const categorySourceKey = item => `${item.sourceId}:${item.kind}:${String(item.categoryId || item.category || 'Other').trim().toLocaleLowerCase()}`;
export const libraryItemKey = item => `${item.sourceId}:${item.key}`;

export function reconcileLibraryCategories(document, suppliedItems, now = new Date()) {
  const categories = Array.isArray(document?.categories) ? structuredClone(document.categories) : [];
  const priorAssignments = new Map((Array.isArray(document?.assignments) ? document.assignments : [])
    .map(entry => [String(entry.itemKey), entry.categoryId == null ? null : String(entry.categoryId)]));
  const items = suppliedItems.filter(item => validLibraryKinds.has(item.kind) && item.sourceId && item.key);
  const liveKeys = new Set(items.map(libraryItemKey));
  const assignments = new Map([...priorAssignments].filter(([itemKey]) => liveKeys.has(itemKey)));

  for (const item of items) {
    const sourceKey = categorySourceKey(item);
    let category = categories.find(entry => entry.kind === item.kind && Array.isArray(entry.sourceKeys) && entry.sourceKeys.includes(sourceKey));
    if (!category) {
      category = {
        id: randomUUID(), kind: item.kind, name: cleanLibraryCategoryName(item.category) || 'Other',
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
