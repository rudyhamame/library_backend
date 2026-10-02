// Browser/Android presence is temporary session state, never a linked device.
export function createClientPresence({ windowMs = 30_000, now = Date.now, maxEntries = 10_000 } = {}) {
  const entries = new Map();
  function prune() {
    const cutoff = now() - windowMs;
    for (const [key, entry] of entries) if (entry.at < cutoff) entries.delete(key);
  }
  return {
    record(accountId, profileId, clientId) {
      if (!accountId || !profileId || !clientId) return;
      prune();
      const key = JSON.stringify([String(accountId), String(profileId), String(clientId)]);
      entries.delete(key);
      entries.set(key, { accountId: String(accountId), profileId: String(profileId), at: now() });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    online(accountId, profileId) {
      prune();
      return [...entries.values()].some(entry => entry.accountId === String(accountId)
        && (profileId === undefined || entry.profileId === String(profileId)));
    },
  };
}
