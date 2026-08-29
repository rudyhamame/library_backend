export const PlaybackStrategy = Object.freeze({ DIRECT: 'DIRECT', REMUX: 'REMUX', TRANSCODE: 'TRANSCODE' });

// Conservative by design: existing Roku HLS/remux behavior stays intact until
// reliable provider codec/container metadata proves a direct path is safe.
export function choosePlaybackStrategy({ purpose }) {
  if (purpose === 'direct-proxy') return PlaybackStrategy.DIRECT;
  if (purpose === 'preview') return PlaybackStrategy.TRANSCODE;
  return PlaybackStrategy.REMUX;
}
