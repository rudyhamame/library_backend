import { hlsFailure, hlsReady, hlsRunning, ensureHls, hlsKey } from './hls.js';
const jobs = new Map();

export async function startRokuPrepare(channel, message, title = '', sourceUrl) {
  const key = hlsKey(channel, message);
  const existing = jobs.get(key);
  if (existing && existing.status !== 'error') return existing;
  if (existing) jobs.delete(key);
  const hls = await ensureHls(channel, message, sourceUrl);
  const job = { id: key, status: 'buffering', progress: null, url: null, title, error: null, hlsKey: hls.key };
  jobs.set(key, job);
  waitForManifest(job).catch(error => { job.status = 'error'; job.error = error.message; });
  return job;
}

export function getRokuJob(id) { return jobs.get(id) || null; }
async function waitForManifest(job) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await hlsReady(job.hlsKey)) {
      job.status = 'complete'; job.progress = null; job.url = `/api/telegram/hls/${job.hlsKey}/master.m3u8`; return;
    }
    if (!hlsRunning(job.hlsKey)) {
      const failure = hlsFailure(job.hlsKey);
      throw new Error(failure ? `HLS input failed: ${failure.split('\n').slice(-2).join(' ')}` : 'HLS process stopped before producing a manifest');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('HLS manifest timed out');
}
