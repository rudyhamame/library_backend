// Builds a short "living wallpaper" video for the RH browser Welcome page by
// grabbing a few seconds of real footage from the NEWEST Series & Movies in the
// catalog (adult / 18+ categories excluded) and splicing the clips into one
// muted montage. Runs entirely in the background; the Welcome page polls for it
// and loops it. Provider blocks every stream (no clips) -> nothing, retry later.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getXtreamSeriesEpisodes, xtreamProviderUrl } from './xtream.js';
import { ADULT_RE, getProviderCatalogCategories, getProviderCatalogRails } from './provider-catalog-store.js';

const BACKDROP_VERSION = 4; // v4 = 10 items x 10s from the middle
const ROOT = path.join(os.tmpdir(), 'rh-stream-backdrop');
const MAX_ITEMS = 10;
const CLIP_SECONDS = 10;
// These lines 302-redirect every request to a short-lived token URL. The token
// URL (82.115.12.250/...) IS byte-range capable, so once we resolve the redirect
// in Node an input `-ss` seek to the middle works cleanly and only downloads the
// clip's worth of bytes - the raw provider URL with `-ss` before it does not.
const GRAB_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 20_000;
const ENCODE_TIMEOUT_MS = 180_000;
const BUILD_DEADLINE_MS = 7 * 60 * 1000;
const FAIL_RETRY_MS = 30 * 60 * 1000;
const XFADE_SECONDS = 0.9; // black fade-in at start and fade-out at the end/loop seam

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

// Every built backdrop currently on disk, for the ops dashboard's preview
// page - reads the meta sidecars directly rather than needing an ownerId, so
// it works across every account without looping getAllXtreamSources per one.
export async function listBackdrops() {
  const names = await fs.readdir(ROOT).catch(() => []);
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const match = name.match(/^(.+)__([a-f0-9]{24})\.mp4\.json$/);
    if (!match) continue;
    const [, ownerId, hash] = match;
    const meta = await fs.readFile(path.join(ROOT, name), 'utf8').then(JSON.parse).catch(() => null);
    if (!meta) continue;
    out.push({ ownerId, hash, createdAt: meta.createdAt || null, clips: meta.clips || 0, items: meta.items || [], url: `/internal/backdrop.mp4?owner=${encodeURIComponent(ownerId)}&h=${hash}` });
  }
  out.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return out;
}

function itemsHash(items, scope = '') {
  const ids = items.slice(0, MAX_ITEMS)
    .map(item => `${item.sourceId}:${item.kind || item.type}:${item.id}`)
    .sort();
  return createHash('sha256').update(`v${BACKDROP_VERSION}\n${scope}\n${ids.join('\n')}`).digest('hex').slice(0, 24);
}

// The provider line allows exactly ONE concurrent connection. This montage is a
// throwaway nicety - it must never open a second stream. It takes the SAME
// server-level provider lease that real playback uses (`acquireLease`), so a
// clip grab simply cannot run while anyone is streaming. `providerBusy()` is a
// fast pre-check and `activeGrab` stops two builds overlapping.
let activeGrab = false;

// Newest non-adult Series & Movies across every source, best-first, capped.
async function latestBackdropItems(ownerId, sources) {
  const picks = [];
  for (const source of sources) {
    const sid = String(source._id);
    let rails;
    try { rails = await getProviderCatalogRails(ownerId, sid, 24); } catch { continue; }
    const nameById = new Map();
    for (const kind of ['series', 'movie']) {
      try {
        for (const category of await getProviderCatalogCategories(ownerId, sid, kind)) {
          nameById.set(`${kind}:${category.id}`, category.name);
        }
      } catch { /* names optional - fall back to the row's own category */ }
    }
    for (const kind of ['series', 'movie']) {
      let taken = 0;
      for (const item of (rails?.[kind] || [])) {
        if (taken >= 8) break;
        const categoryName = item.category || nameById.get(`${kind}:${item.categoryId}`) || '';
        if (ADULT_RE.test(categoryName) || ADULT_RE.test(item.title || '')) continue;
        picks.push({ id: String(item.id), kind, title: item.title, extension: item.extension, sourceId: sid });
        taken += 1;
      }
    }
  }
  // Interleave series/movies so the montage is not all one kind.
  const series = picks.filter(item => item.kind === 'series');
  const movies = picks.filter(item => item.kind === 'movie');
  const merged = [];
  for (let i = 0; i < Math.max(series.length, movies.length); i += 1) {
    if (series[i]) merged.push(series[i]);
    if (movies[i]) merged.push(movies[i]);
  }
  return merged.slice(0, MAX_ITEMS);
}

// sourceId narrows the montage to ONE playlist provider (the one the Welcome
// page currently has selected); empty = the newest across every provider.
export async function getRecommendationBackdrop(ownerId, sourceId, sources, { providerBusy, acquireLease } = {}) {
  if (!ownerId || !Array.isArray(sources) || sources.length === 0) return { ready: false, building: false, hash: '', url: null, updatedAt: null };
  const scoped = sourceId ? sources.filter(source => String(source._id) === String(sourceId)) : sources;
  const useSources = scoped.length ? scoped : sources;
  const list = await latestBackdropItems(ownerId, useSources).catch(() => []);
  if (list.length === 0) return { ready: false, building: false, hash: '', url: null, updatedAt: null };
  const hash = itemsHash(list, scoped.length ? String(sourceId) : 'all');
  const video = videoPath(ownerId, hash);
  if (await pathExists(video)) {
    const stat = await fs.stat(video).catch(() => null);
    return { ready: true, building: false, hash, url: `/api/recommendations/ai/backdrop.mp4?h=${hash}`, updatedAt: stat ? stat.mtime.toISOString() : null };
  }
  if (!building.has(hash) && !activeGrab && useSources.length) {
    const failedAt = await fs.readFile(failPath(ownerId, hash), 'utf8').then(value => Number(value) || 0).catch(() => 0);
    const busy = typeof providerBusy === 'function' ? await providerBusy().catch(() => true) : false;
    if (!busy && Date.now() - failedAt > FAIL_RETRY_MS) {
      const job = buildBackdrop(ownerId, hash, list, useSources, { providerBusy, acquireLease }).finally(() => building.delete(hash));
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

// Follow the provider's 302 to the range-capable direct URL. Every request gets
// a fresh token, and the token allows the couple of sequential opens (probe +
// grab) we need. Returns the original url on any failure / no redirect.
async function resolveDirect(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const location = res.headers.get('location');
    return (res.status >= 300 && res.status < 400 && location) ? location : url;
  } catch { return url; }
}

// Container duration in seconds, or 0 if unknown (e.g. a live-style TS stream).
function probeDuration(url) {
  return new Promise(resolve => {
    const child = spawn('ffprobe', ['-v', 'error', '-rw_timeout', '12000000',
      '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(0); }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(0); });
    child.on('close', () => { clearTimeout(timer); resolve(Number.parseFloat(out) || 0); });
  });
}

// Pull CLIP_SECONDS of footage starting at `seekSeconds` (input seek) and
// normalise it to a 1920x1080 30fps H.264 clip with no audio.
function grabClip(url, seekSeconds, outFile) {
  return new Promise(resolve => {
    const args = ['-y', '-nostdin', '-loglevel', 'error', '-rw_timeout', '15000000',
      '-analyzeduration', '4000000', '-probesize', '4000000'];
    if (seekSeconds > 0) args.push('-ss', String(Math.round(seekSeconds)));
    args.push('-i', url,
      '-t', String(CLIP_SECONDS),
      '-an', '-map', '0:v:0',
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
      '-g', '60', '-movflags', '+faststart', outFile);
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, GRAB_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', async code => {
      clearTimeout(timer);
      if (code !== 0) return resolve(false);
      // A real 10s 1080p clip is comfortably over 300 KB and ~CLIP_SECONDS long;
      // anything tiny/short is a seek-past-the-end or a broken stream.
      const stat = await fs.stat(outFile).catch(() => null);
      if (!stat || stat.size < 300_000) return resolve(false);
      const seconds = await probeDuration(outFile);
      resolve(seconds === 0 || seconds >= CLIP_SECONDS * 0.6);
    });
  });
}

// Splice the normalised clips end-to-end (concat demuxer - same codec/res/fps),
// re-encoding once to add a black fade-in at the start and fade-out at the end
// so the client's `loop` seam is not a hard cut.
async function spliceClips(dir, clipNames, outFile) {
  const listFile = path.join(dir, 'clips.txt');
  await fs.writeFile(listFile, clipNames.map(name => `file '${name}'`).join('\n'));
  return new Promise((resolve, reject) => {
    const total = clipNames.length * CLIP_SECONDS;
    const fadeOutStart = Math.max(0, total - XFADE_SECONDS).toFixed(2);
    const args = ['-y', '-nostdin', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', [
        'fps=30', 'format=yuv420p',
        `fade=t=in:st=0:d=${XFADE_SECONDS}`,
        `fade=t=out:st=${fadeOutStart}:d=${XFADE_SECONDS}`,
      ].join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an', outFile];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, ENCODE_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg splice exit ${code}: ${stderr}`));
    });
  });
}

// Backdrops are per playlist provider now (one hash each), so we cannot delete
// "everything but keepHash" - that would wipe the other providers' montages and
// force a rebuild on every provider switch. Drop only files older than a day
// (their item set changed so the hash is dead, or the provider is gone); an
// idle-but-still-current provider just rebuilds once/day.
const STALE_BACKDROP_MS = 24 * 60 * 60 * 1000;
async function cleanupOldBackdrops(ownerId) {
  const prefix = `${ownerSlug(ownerId)}__`;
  const now = Date.now();
  for (const name of await fs.readdir(ROOT).catch(() => [])) {
    if (!name.startsWith(prefix)) continue;
    const target = path.join(ROOT, name);
    const stat = await fs.stat(target).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_BACKDROP_MS) await fs.rm(target, { force: true }).catch(() => {});
  }
}

async function buildBackdrop(ownerId, hash, items, sources, { providerBusy, acquireLease } = {}) {
  if (activeGrab) return;
  activeGrab = true;
  await ensureBackdropRoot();
  const work = path.join(ROOT, `build-${hash}-${Date.now()}`);
  await fs.mkdir(work, { recursive: true });
  const sourceById = new Map(sources.map(source => [String(source._id), source]));
  const clips = [];
  const usedItems = [];
  const startedAt = Date.now();
  let yielded = false;
  const busyNow = async () => (typeof providerBusy === 'function' ? Boolean(await providerBusy().catch(() => true)) : false);
  try {
    for (const item of items.slice(0, MAX_ITEMS)) {
      if (Date.now() - startedAt > BUILD_DEADLINE_MS) break;
      // Never touch the provider while a real stream is playing.
      if (await busyNow()) { yielded = true; break; }
      const source = sourceById.get(String(item.sourceId));
      if (!source) continue;
      const resolved = await resolveProviderUrl(item, source).catch(() => null);
      if (!resolved) continue;
      // Take the ONE provider slot, grab this single clip, release immediately -
      // a viewer is never locked out for longer than one clip grab, and the
      // loop's busyNow() check above stops the next clip if they start.
      const release = typeof acquireLease === 'function'
        ? await acquireLease(String(item.sourceId)).catch(() => null)
        : async () => {};
      if (!release) { yielded = true; break; }
      const outFile = path.join(work, `c${String(clips.length).padStart(2, '0')}.mp4`);
      try {
        const direct = await resolveDirect(resolved.url);
        const duration = resolved.live ? 0 : await probeDuration(direct);
        // Middle of the runtime, leaving room for the full CLIP_SECONDS. Falls
        // back to a quarter-in, then the start, if the provider truncates.
        const mid = duration > CLIP_SECONDS * 3 ? Math.min(duration / 2, duration - CLIP_SECONDS - 15) : 0;
        const seeks = [...new Set([Math.round(mid), Math.round(mid / 2), 0])];
        for (const seek of seeks) {
          if (await grabClip(direct, seek, outFile)) { clips.push(path.basename(outFile)); usedItems.push({ title: item.title || '', kind: item.kind, id: item.id, sourceId: item.sourceId }); break; }
        }
      } finally {
        await Promise.resolve(release()).catch(() => {});
      }
    }
    if (yielded) {
      console.info(`[Backdrop] owner=${short(ownerId)} yielded - provider slot in use (clips so far=${clips.length})`);
      return;
    }
    if (clips.length === 0) {
      await fs.writeFile(failPath(ownerId, hash), String(Date.now())).catch(() => {});
      console.info(`[Backdrop] owner=${short(ownerId)} no clips available`);
      return;
    }
    const tmpVideo = path.join(work, 'backdrop.mp4');
    await spliceClips(work, clips, tmpVideo);
    await fs.rename(tmpVideo, videoPath(ownerId, hash));
    await fs.writeFile(metaPath(ownerId, hash), JSON.stringify({ hash, createdAt: new Date().toISOString(), clips: clips.length, items: usedItems })).catch(() => {});
    await fs.rm(failPath(ownerId, hash), { force: true }).catch(() => {});
    // Touch this build so cleanup keeps it, then GC only genuinely stale files.
    await fs.utimes(videoPath(ownerId, hash), new Date(), new Date()).catch(() => {});
    await cleanupOldBackdrops(ownerId);
    console.info(`[Backdrop] owner=${short(ownerId)} built clips=${clips.length}`);
  } finally {
    activeGrab = false;
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
