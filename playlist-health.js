const timeout = (milliseconds) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('Provider health check timed out')), milliseconds);
  timer.unref?.();
});

export function summarizePlaylistHealth(results = []) {
  const total = results.length;
  const online = results.filter(result => result.ok).length;
  const failed = total - online;
  const status = total === 0 ? 'not_saved' : online === total ? 'online' : online > 0 ? 'degraded' : 'offline';
  return { ok: status === 'online', status, total, online, failed };
}

export async function checkPlaylistSources(sources, validateSource, timeoutMs = 15_000) {
  const results = await Promise.all((sources || []).map(async source => {
    try {
      await Promise.race([validateSource(source), timeout(timeoutMs)]);
      return { sourceId: String(source._id || ''), ok: true };
    } catch (error) {
      return { sourceId: String(source._id || ''), ok: false, error: String(error.message || error).slice(0, 160) };
    }
  }));
  return { ...summarizePlaylistHealth(results), results };
}
