const baseUrl = String(process.env.MEDIA_TEST_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const diagnosticsToken = String(process.env.MEDIA_TEST_TOKEN || '');
const deviceToken = String(process.env.MEDIA_DEVICE_TOKEN || '');
const playbackPaths = String(process.env.MEDIA_TEST_PLAYBACK_PATHS || process.env.MEDIA_TEST_PLAYBACK_PATH || '').split(',').map(value => value.trim()).filter(Boolean);
const cycles = Math.max(1, Number.parseInt(process.env.MEDIA_TEST_CYCLES || '20', 10) || 20);
const concurrency = Math.max(1, Number.parseInt(process.env.MEDIA_TEST_CONCURRENCY || '1', 10) || 1);
const abortMs = Math.max(250, Number.parseInt(process.env.MEDIA_TEST_ABORT_MS || '2500', 10) || 2_500);
const settleMs = Math.max(1_000, Number.parseInt(process.env.MEDIA_TEST_SETTLE_MS || '55000', 10) || 55_000);

if (!diagnosticsToken || !playbackPaths.length) {
  console.error('Set MEDIA_TEST_TOKEN and MEDIA_TEST_PLAYBACK_PATH. Optionally set MEDIA_TEST_BASE_URL and MEDIA_DEVICE_TOKEN.');
  process.exit(2);
}

async function health() {
  const response = await fetch(`${baseUrl}/internal/media-health`, { headers: { 'x-internal-token': diagnosticsToken } });
  if (!response.ok) throw new Error(`media-health returned HTTP ${response.status}`);
  return response.json();
}

async function playAndStop(playbackPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), abortMs);
  try {
    const response = await fetch(`${baseUrl}${playbackPath}`, {
      headers: deviceToken ? { 'x-device-token': deviceToken } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`playback returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    while (reader) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally { clearTimeout(timer); }
}

const before = await health();
const samples = [];
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  await Promise.all(Array.from({ length: concurrency }, (_, index) => playAndStop(playbackPaths[index % playbackPaths.length])));
  if (cycle === 1 || cycle === cycles || cycle % 5 === 0) samples.push({ cycle, ...(await health()) });
}
await new Promise(resolve => setTimeout(resolve, settleMs));
const after = await health();
console.log(JSON.stringify({ config: { cycles, concurrency, pathCount: playbackPaths.length, abortMs, settleMs }, before, samples, after, retainedDelta: {
  rssMB: Number((after.rssMB - before.rssMB).toFixed(1)),
  heapUsedMB: Number((after.heapUsedMB - before.heapUsedMB).toFixed(1)),
  externalMB: Number((after.externalMB - before.externalMB).toFixed(1)),
  arrayBuffersMB: Number((after.arrayBuffersMB - before.arrayBuffersMB).toFixed(1)),
  hlsDiskUsageMB: Number((after.hlsDiskUsageMB - before.hlsDiskUsageMB).toFixed(1)),
  activeRemuxJobs: after.activeRemuxJobs,
  activeTranscodes: after.activeTranscodes,
} }, null, 2));
