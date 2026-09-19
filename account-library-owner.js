import { createHash } from 'node:crypto';

export function accountOwnerId(accountId) {
  return createHash('sha256').update(`account:${String(accountId)}`).digest('hex');
}

export function profileOwnerId(accountId, profileId) {
  return createHash('sha256').update(`account:${String(accountId)}:profile:${String(profileId)}`).digest('hex');
}

export function canonicalSessionOwner(session) {
  const accountId = String(session?.accountId || '');
  if (!/^[a-f0-9]{24}$/i.test(accountId)) return session?.ownerId || null;
  // Never trust an owner embedded in an older token. Profile-scoped sessions
  // always resolve to the deterministic owner derived from account + profile,
  // so browser/Android/Roku sessions share the same account tree after a
  // device-owner migration.
  if (session?.profileId) return profileOwnerId(accountId, session.profileId);
  return accountOwnerId(accountId);
}
