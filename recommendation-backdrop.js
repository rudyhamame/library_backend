// Builds a short "living wallpaper" video for the RH browser home screen by
// grabbing a single real frame from each of the ten AI-recommendation items and
// gluing them into one Ken-Burns montage. Runs entirely in the background; the
// home page polls for it and plays it once when it is ready. If the provider
// blocks every stream (no frames), nothing is produced and we retry later.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getXtreamSeriesEpisodes, xtreamProviderUrl } from './xtream.js';

const BACKDROP_VERSION = 1;
const ROOT = path.join(os.tmpdir(), 'rh-stream-backdrop');
const MAX_ITEMS = 10;
const FRAME_TIMESTAMPS = [90, 420];
const GRAB_TIMEOUT_MS = 20_000;
const ENCODE_TIMEOUT_MS = 90_000;
const BUILD_DEADLINE_MS = 4 * 60 * 1000;
const FAIL_RETRY_MS = 30 * 60 * 1000;
const PER_IMAGE_SECONDS = 2.6;

const building = new Map();
const short = value => String(value || '').slice(0, 8);
const ownerSlug = value => String(value || '').replace(/[^a-z0-9]/gi, '');
const videoPath = (ownerId, hash) => path.join(ROOT, `${ownerSlug(ownerId)}__${hash}.mp4`);
const failPath = (ownerId, hash) => `${videoPath(ownerId, hash)}.fail`;
const metaPath = (ownerId, hash) => `${videoPath(ownerId, hash)}.json`;

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

export async function ensureBackdropRoot() {
  await fs.mkdir(ROOT, { recursive: true });
}

export function backdropVideoFile(ownerId, hash) {
  if (!/^[a-f0-9]{24}$/.test(String(hash || ''))) return null;
  return videoPath(ownerId, hash);
}

function itemsHash(items) {
  const ids = items.slice(0, MAX_ITEMS)
    .map(item => `${item.sourceId}:${item.kind || item.type}:${item.id}`)
    .sort();
  return createHash('sha256').update(`v${BACKDROP_VERSION}\n${ids.join('\n')}`).digest('hex').slice(0, 24);
}

// The provider line allows exactly ONE concurrent connection. This montage is a
// throwaway nicety - it must never open a second stream. It takes the SAME
// server-level provider lease that real playback uses (`acquireLease`), so a
// frame grab simply cannot run while anyone is streaming. `providerBusy()` is a
// fast pre-check and `activeGrab` stops two builds overlapping.
let activeGrab = false;

export async function getRecommendationBackdrop(ownerId, items, sources, { providerBusy, acquireLease } = {}) {
  const list = Array.isArray(items) ? items.filter(item => item && item.id && item.sourceId) : [];
  if (!ownerId || list.length === 0) return { ready: false, building: false, hash: '', url: null, updatedAt: null };
  const hash = itemsHash(list);
  const video = videoPath(ownerId, hash);
  if (await pathExists(video)) {
    const stat = await fs.stat(video).catch(() => null);
    return { ready: true, building: false, hash, url: `/api/recommendations/ai/backdrop.mp4?h=${hash}`, updatedAt: stat ? stat.mtime.toISOString() : null };
  }
  if (!building.has(hash) && !activeGrab && Array.isArray(sources) && sources.length) {
    const failedAt = await fs.readFile(failPath(ownerId, hash), 'utf8').then(value => Number(value) || 0).catch(() => 0);
    const busy = typeof providerBusy === 'function' ? await providerBusy().catch(() => true) : false;
    if (!busy && Date.now() - failedAt > FAIL_RETRY_MS) {
      const job = buildBackdrop(ownerId, hash, list, sources, { providerBusy, acquireLease }).finally(() => building.delete(hash));
      job.catch(error => console.warn(`[Backdrop] owner=${short(ownerId)} build failed: ${error.message}`));
      building.set(hash, job);
    }
  }
  return { ready: false, building: building.has(hash), hash, url: null, updatedAt: null };
}

async function resolveProviderUrl(item, source) {
  const kind = item.kind || item.type;
  if (kind === 'series') {
    const detail = await getXtreamSeriesEpisodes(source, item.id).catch(() => null);
    const episode = detail?.episodes?.[0];
    if (!episode) return null;
    return { url: xtreamProviderUrl(source, 'series', episode.id, episode.extension || 'mp4'), live: false };
  }
  if (kind === 'channel') return { url: xtreamProviderUrl(source, 'channel', item.id), live: true };
  return { url: xtreamProviderUrl(source, 'movie', item.id, item.extension || 'mp4'), live: false };
}

function grabFrame(url, seconds, live, outFile) {
  return new Promise(resolve => {
    const args = ['-y', '-nostdin', '-loglevel', 'error', '-rw_timeout', '12000000', '-analyzeduration', '4000000', '-probesize', '4000000'];
    if (!live && seconds > 0) args.push('-ss', String(seconds));
    args.push('-i', url, '-map', '0:v:0', '-frames:v', '1', '-q:v', '4',
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1', outFile);
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, GRAB_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', async code => {
      clearTimeout(timer);
      if (code !== 0) return resolve(false);
      resolve(await fs.stat(outFile).then(stat => stat.size > 3072).catch(() => false));
    });
  });
}

function encodeMontage(dir, count, outFile) {
  return new Promise((resolve, reject) => {
    const duration = (count * PER_IMAGE_SECONDS).toFixed(2);
    const fadeOutStart = Math.max(0, count * PER_IMAGE_SECONDS - 1).toFixed(2);
    const args = ['-y', '-nostdin', '-loglevel', 'error',
      '-framerate', `1/${PER_IMAGE_SECONDS}`, '-i', path.join(dir, 'f%02d.jpg'),
      '-vf', [
        `zoompan=z='min(zoom+0.0015,1.2)':d=${Math.round(PER_IMAGE_SECONDS * 30)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30`,
        'format=yuv420p',
        'fade=t=in:st=0:d=1',
        `fade=t=out:st=${fadeOutStart}:d=1`,
      ].join(','),
      '-t', duration,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outFile];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, ENCODE_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg montage exit ${code}: ${stderr}`));
    });
  });
}

async function cleanupOldBackdrops(ownerId, keepHash) {
  const prefix = `${ownerSlug(ownerId)}__`;
  for (const name of await fs.readdir(ROOT).catch(() => [])) {
    if (!name.startsWith(prefix) || name.includes(keepHash)) continue;
    await fs.rm(path.join(ROOT, name), { force: true }).catch(() => {});
  }
}

async function buildBackdrop(ownerId, hash, items, sources, { providerBusy, acquireLease } = {}) {
  if (activeGrab) return;
  activeGrab = true;
  await ensureBackdropRoot();
  const work = path.join(ROOT, `build-${hash}-${Date.now()}`);
  await fs.mkdir(work, { recursive: true });
  const sourceById = new Map(sources.map(source => [String(source._id), source]));
  const frames = [];
  const startedAt = Date.now();
  let yielded = false;
  const leases = new Map();
  const busyNow = async () => (typeof providerBusy === 'function' ? Boolean(await providerBusy().catch(() => true)) : false);
  // Take the real server-level provider lease before touching a stream. If the
  // slot is held (someone is watching), we get null and stand down entirely.
  const claimSlot = async sourceId => {
    if (typeof acquireLease !== 'function') return true;
    if (leases.has(sourceId)) return leases.get(sourceId) !== null;
    const release = await acquireLease(sourceId).catch(() => null);
    leases.set(sourceId, release || null);
    return Boolean(release);
  };
  try {
    for (const item of items.slice(0, MAX_ITEMS)) {
      if (Date.now() - startedAt > BUILD_DEADLINE_MS) break;
      // Never hold a provider connection while a real stream is playing.
      if (await busyNow()) { yielded = true; break; }
      const source = sourceById.get(String(item.sourceId));
      if (!source) continue;
      if (!await claimSlot(String(item.sourceId))) { yielded = true; break; }
      const resolved = await resolveProviderUrl(item, source).catch(() => null);
      if (!resolved) continue;
      const timestamps = resolved.live ? [0] : FRAME_TIMESTAMPS;
      for (const seconds of timestamps) {
        const candidate = path.join(work, `raw-${frames.length}-${seconds}.jpg`);
        if (await grabFrame(resolved.url, seconds, resolved.live, candidate)) { frames.push(candidate); break; }
      }
    }
    if (yielded) {
      console.info(`[Backdrop] owner=${short(ownerId)} yielded - provider slot in use (frames so far=${frames.length})`);
      return;
    }
    if (frames.length === 0) {
      await fs.writeFile(failPath(ownerId, hash), String(Date.now())).catch(() => {});
      console.info(`[Backdrop] owner=${short(ownerId)} no frames available`);
      return;
    }
    for (let index = 0; index < frames.length; index += 1) {
      await fs.rename(frames[index], path.join(work, `f${String(index).padStart(2, '0')}.jpg`));
    }
    const tmpVideo = path.join(work, 'backdrop.mp4');
    await encodeMontage(work, frames.length, tmpVideo);
    await fs.rename(tmpVideo, videoPath(ownerId, hash));
    await fs.writeFile(metaPath(ownerId, hash), JSON.stringify({ hash, createdAt: new Date().toISOString(), frames: frames.length })).catch(() => {});
    await fs.rm(failPath(ownerId, hash), { force: true }).catch(() => {});
    await cleanupOldBackdrops(ownerId, hash);
    console.info(`[Backdrop] owner=${short(ownerId)} built frames=${frames.length}`);
  } finally {
    for (const release of leases.values()) await release?.().catch(() => {});
    activeGrab = false;
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
