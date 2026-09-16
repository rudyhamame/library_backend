const invalidLiteral = value => {
  const text = String(value ?? '').trim();
  return !text || /^(?:undefined|null|invalid|nan)$/i.test(text) ? '' : text;
};

export function resolveProviderMediaId(item = {}, kind = item.kind) {
  const mediaKind = kind === 'episode' ? 'series' : String(kind || item.kind || '');
  const candidates = [item.id, item.itemId];
  if (mediaKind === 'series') candidates.push(item.episodeId, item.episode_id, item.seriesId, item.series_id, item.streamId, item.stream_id);
  else candidates.push(item.streamId, item.stream_id);
  for (const candidate of candidates) {
    const id = invalidLiteral(candidate);
    if (id) return id;
  }
  const key = invalidLiteral(item.key);
  const prefix = `${mediaKind}:`;
  return key.startsWith(prefix) ? invalidLiteral(key.slice(prefix.length)) : '';
}

export function providerPlaybackUrlIsUsable(value) {
  const text = invalidLiteral(value);
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const parsed = new URL(text);
    return !parsed.pathname.split('/').some(segment => /^(?:undefined|null|invalid)$/i.test(decodeURIComponent(segment).replace(/\.[^.]*$/, '')));
  } catch {
    return false;
  }
}

export function resolveProviderTitle(item = {}, kind = item.kind, id = resolveProviderMediaId(item, kind)) {
  for (const candidate of [item.title, item.name]) {
    const title = invalidLiteral(candidate);
    if (title) return title;
  }
  const label = kind === 'channel' ? 'Channel' : kind === 'series' ? 'Series' : kind === 'episode' ? 'Episode' : 'Movie';
  return id ? `${label} ${id}` : label;
}
