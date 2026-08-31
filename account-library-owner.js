import { createHash } from 'node:crypto';

export function accountOwnerId(accountId) {
  return createHash('sha256').update(`account:${String(accountId)}`).digest('hex');
}

export function canonicalSessionOwner(session) {
  const accountId = String(session?.accountId || '');
  if (!/^[a-f0-9]{24}$/i.test(accountId)) return session?.ownerId || null;
  return accountOwnerId(accountId);
}
