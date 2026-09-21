const kinds = ['series', 'movie', 'channel'];

const text = value => String(value ?? '');

function withoutMongoId(document = {}) {
  const { _id, ownerId, accountOwnerId, ...publicDocument } = document;
  return publicDocument;
}

function groupByKind(rows = []) {
  return Object.fromEntries(kinds.map(kind => [kind, rows.filter(row => text(row.providerIdentity?.kind || row.kind) === kind).map(withoutMongoId)]));
}

function providerSelection(source) {
  return {
    enabledKeys: Array.isArray(source.enabledKeys) ? source.enabledKeys.map(text) : [],
    archivedKeys: Array.isArray(source.archivedKeys) ? source.archivedKeys.map(text) : [],
    enabledItems: groupByKind(Array.isArray(source.enabledItems) ? source.enabledItems : []),
    archivedItems: groupByKind(Array.isArray(source.archivedItems) ? source.archivedItems : []),
  };
}

export function buildAccountRoot({
  account,
  profiles = [],
  providers = [],
  favorites = [],
  playback = [],
  history = [],
  catalogRefs = [],
  generatedAt = new Date(),
}) {
  const accountId = text(account?._id || account?.accountId);
  const ownerId = text(account?.ownerId);
  if (!accountId || !ownerId) throw new Error('Account ID and canonical owner ID are required');

  const providerById = new Map(providers.map(source => [text(source._id || source.id), source]));
  const providerRoots = providers.map(source => {
    const providerId = text(source._id || source.id);
    const refs = catalogRefs.filter(ref => text(ref.sourceId) === providerId);
    return {
      id: providerId,
      name: text(source.name),
      type: text(source.type || 'xtream'),
      endpoint: text(source.baseUrl),
      credentials: { username: text(source.username), password: text(source.password) },
      connection: {
        status: text(source.connectionStatus || 'unknown'),
        message: text(source.connectionMessage),
      },
      selection: providerSelection(source),
      catalogRefs: refs.map(withoutMongoId),
      updatedAt: source.updatedAt || null,
    };
  });

  const profileRoots = profiles.map(profile => {
    const profileId = text(profile.id);
    const profileOwnerId = text(profile.ownerId);
    const profileFavorites = favorites.filter(item => text(item.profileId) === profileId || text(item.ownerId) === profileOwnerId);
    return {
      id: profileId,
      ownerId: profileOwnerId,
      name: text(profile.name),
      code: text(profile.code),
      avatar: text(profile.avatar),
      isDefault: profile.isDefault === true,
      position: Number(profile.position) || 0,
      rokuSourceId: text(profile.rokuSourceId),
      partner: {
        email: text(profile.partnerEmail),
        profileCode: text(profile.partnerProfileCode),
      },
      favorites: groupByKind(profileFavorites),
      savedSelections: profile.library?.savedSelections || {},
      updatedAt: profile.updatedAt || null,
    };
  });

  const accountFavorites = favorites.filter(item => !item.profileId);
  const accountPlayback = playback.map(withoutMongoId);
  const lastWatched = Object.fromEntries(kinds.map(kind => [kind, history.filter(item => text(item.kind) === kind).map(withoutMongoId)]));

  return {
    _id: ownerId,
    schemaVersion: 1,
    account: {
      id: accountId,
      email: text(account.email),
      realm: text(account.realm || 'roku'),
      createdAt: account.createdAt || null,
      updatedAt: account.updatedAt || null,
    },
    providers: providerRoots,
    profiles: profileRoots,
    savedItems: Object.fromEntries(providers.map(source => {
      const providerId = text(source._id || source.id);
      const selection = providerSelection(source);
      return [providerId, selection.enabledItems];
    })),
    favorites: groupByKind(accountFavorites),
    playback: accountPlayback,
    lastWatched,
    catalogRefs: catalogRefs.map(withoutMongoId),
    generatedAt,
  };
}

export { kinds };
