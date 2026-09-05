export const HlsStrategy = Object.freeze({ REMUX: 'HLS_REMUX', PARTIAL_TRANSCODE: 'HLS_PARTIAL_TRANSCODE', FULL_TRANSCODE: 'HLS_FULL_TRANSCODE' });
export const PlaybackStrategy = Object.freeze({ REMUX: HlsStrategy.REMUX, PARTIAL_TRANSCODE: HlsStrategy.PARTIAL_TRANSCODE, TRANSCODE: HlsStrategy.FULL_TRANSCODE });

const compatibleVideoCodecs = new Set(['h264', 'avc', 'avc1', 'mpeg4']);
const compatibleAudioCodecs = new Set(['aac', 'mp3', 'mp2']);
const normalizedCodec = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export function determineHlsStrategy(sourceMetadata = {}, clientCapabilities = {}) {
  const videoCodec = normalizedCodec(sourceMetadata.videoCodec || sourceMetadata.codecVideo || sourceMetadata.codec);
  const audioCodec = normalizedCodec(sourceMetadata.audioCodec || sourceMetadata.codecAudio);
  const videoCompatible = !videoCodec || compatibleVideoCodecs.has(videoCodec);
  const audioCompatible = !audioCodec || compatibleAudioCodecs.has(audioCodec);
  const preferH264 = clientCapabilities.videoCodec ? normalizedCodec(clientCapabilities.videoCodec) === 'h264' : true;
  if (videoCompatible && audioCompatible && preferH264) return { videoMode: 'copy', audioMode: 'copy', reason: 'Source codecs are compatible or not yet probed', outputProtocol: 'hls', strategy: HlsStrategy.REMUX };
  if (videoCompatible && !audioCompatible) return { videoMode: 'copy', audioMode: 'transcode', reason: `Audio codec ${audioCodec || 'unknown'} is not compatible`, outputProtocol: 'hls', strategy: HlsStrategy.PARTIAL_TRANSCODE };
  if (!videoCompatible && audioCompatible) return { videoMode: 'transcode', audioMode: 'copy', reason: `Video codec ${videoCodec || 'unknown'} is not compatible`, outputProtocol: 'hls', strategy: HlsStrategy.PARTIAL_TRANSCODE };
  return { videoMode: 'transcode', audioMode: 'transcode', reason: 'Video and audio codecs require conversion', outputProtocol: 'hls', strategy: HlsStrategy.FULL_TRANSCODE };
}

// qualityPreset (optional): {height, videoBitrate, maxrate, bufsize} - forces a
// real re-encode at that resolution/bitrate instead of the default CRF pass.
export function hlsCodecArgs(decision, qualityPreset = null) {
  const args = decision.videoMode === 'copy'
    ? ['-c:v', 'copy']
    : qualityPreset
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-vf', `scale=-2:${qualityPreset.height}`,
          '-b:v', qualityPreset.videoBitrate, '-maxrate', qualityPreset.maxrate, '-bufsize', qualityPreset.bufsize,
          '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0'];
  args.push(...(decision.audioMode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']));
  return args;
}

export function choosePlaybackStrategy({ purpose } = {}) {
  return HlsStrategy.REMUX;
}
