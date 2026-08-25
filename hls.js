import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const root = '/tmp/streaming-telegram-hls';
const jobs = new Map();
const registrations = new Map();
const failures = new Map();

export function hlsKey(channel, message) {
  return createHash('sha256').update(`hls-v11:${channel}:${message}`).digest('hex').slice(0, 20);
}

async function playablePlaylist(key) {
  try {
    const directory = `${root}/${key}`;
    const body = await readFile(`${directory}/master.m3u8`, 'utf8');
    const duration = body.match(/#EXTINF:([0-9.]+)/)?.[1];
    const segment = body.split(/\r?\n/).find(line => line && !line.startsWith('#'));
    if (!duration || Number(duration) <= 0 || !segment) return false;
    return (await stat(`${directory}/${segment}`)).size > 0;
  } catch {
    return false;
  }
}

export async function registerHls(channel, message, sourceUrl) {
  const key = hlsKey(channel, message);
  const directory = `${root}/${key}`;
  await mkdir(directory, { recursive: true });
  registrations.set(key, { channel, message, sourceUrl });
  return { key, directory, playlist: `${directory}/master.m3u8` };
}

export async function startHls(key) {
  const registration = registrations.get(key);
  if (!registration) return null;
  return ensureHls(registration.channel, registration.message, registration.sourceUrl);
}

export async function ensureHls(channel, message, sourceUrl, options = {}) {
  const key = hlsKey(channel, message);
  const directory = `${root}/${key}`;
  await mkdir(directory, { recursive: true });
  const playlist = `${directory}/master.m3u8`;
  if (jobs.has(key)) return { key, directory, playlist };
  if (await playablePlaylist(key)) return { key, directory, playlist };
  if (!sourceUrl) throw new Error('HLS source URL is required');
  // A failed FFmpeg run can leave a zero-duration playlist and a zero-byte
  // segment. Never serve that stale output as a completed stream.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  failures.delete(key);
  const ffmpegProcess = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    // Telegram may need to authorize and connect to another data center for
    // a particular file. Give that handoff time before treating it as I/O.
    '-rw_timeout', '60000000', '-fflags', '+genpts', '-i', sourceUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...(options.transcodeVideo ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_filename', `${directory}/seg_%05d.ts`, playlist
  ]);
  const job = { process: ffmpegProcess, key, directory, playlist, stderr: '' };
  jobs.set(key, job);
  ffmpegProcess.stderr.on('data', data => {
    const text = String(data);
    job.stderr = `${job.stderr}${text}`.slice(-2000);
    console.error(`[hls:${key}] ${text}`);
  });
  ffmpegProcess.on('close', code => {
    jobs.delete(key);
    if (code !== 0) failures.set(key, job.stderr.trim() || `FFmpeg exited with code ${code}`);
  });
  return { key, directory, playlist };
}

export { root };

export async function hlsReady(key) {
  return playablePlaylist(key);
}

export function hlsRunning(key) { return jobs.has(key); }
export function hlsFailure(key) { return failures.get(key) || null; }
