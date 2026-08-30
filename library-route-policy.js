const STREAMING_ONLY_PATHS = [
  /^\/api\/xtream\/play(?:\/|$)/,
  /^\/api\/xtream\/hls(?:\/|$)/,
  /^\/api\/xtream\/roku(?:\/|$)/,
  /^\/internal\/media-health$/,
];

export function isStreamingOnlyPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return STREAMING_ONLY_PATHS.some(pattern => pattern.test(path));
}

export function enforceLibraryOnly(req, res, next) {
  res.setHeader('X-Backend-Role', 'library');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (isStreamingOnlyPath(req.path)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

export const libraryRoutePolicy = Object.freeze({
  blockedPatterns: Object.freeze(STREAMING_ONLY_PATHS.map(pattern => pattern.source)),
});
