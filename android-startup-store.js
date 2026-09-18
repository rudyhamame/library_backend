const snapshots = new Map();

export async function getAndroidStartupSnapshot(ownerId) {
  if (!ownerId) return null;
  const snapshot = snapshots.get(String(ownerId));
  return snapshot ? { ...snapshot } : null;
}

export async function saveAndroidStartupSnapshot(ownerId, payload) {
  if (!ownerId) return null;
  const updatedAt = new Date();
  const snapshot = { ...(snapshots.get(String(ownerId)) || {}), ownerId: String(ownerId), ...payload, updatedAt };
  snapshots.set(String(ownerId), snapshot);
  return { ...snapshot };
}
