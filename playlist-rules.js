const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
};

export const defaultPlaylistRules = () => ({
  maxConcurrentStreams: { enabled: false, limit: 1 },
  streamStartCooldown: { enabled: false, seconds: 5 },
  streamStartRate: { enabled: false, limit: 6, windowSeconds: 60 },
  apiRequestRate: { enabled: false, limit: 30, windowSeconds: 60 },
  retryLimit: { enabled: false, attempts: 1 },
  suppressAutomaticHealthChecks: { enabled: false },
  suppressBackgroundRefresh: { enabled: false },
  forceServerProxy: { enabled: false },
});

export function normalizePlaylistRules(value = {}) {
  const rule = name => value?.[name] && typeof value[name] === 'object' ? value[name] : {};
  return {
    maxConcurrentStreams: { enabled: rule('maxConcurrentStreams').enabled === true, limit: boundedInteger(rule('maxConcurrentStreams').limit, 1, 1, 10) },
    streamStartCooldown: { enabled: rule('streamStartCooldown').enabled === true, seconds: boundedInteger(rule('streamStartCooldown').seconds, 5, 1, 300) },
    streamStartRate: { enabled: rule('streamStartRate').enabled === true, limit: boundedInteger(rule('streamStartRate').limit, 6, 1, 120), windowSeconds: boundedInteger(rule('streamStartRate').windowSeconds, 60, 10, 3600) },
    apiRequestRate: { enabled: rule('apiRequestRate').enabled === true, limit: boundedInteger(rule('apiRequestRate').limit, 30, 1, 600), windowSeconds: boundedInteger(rule('apiRequestRate').windowSeconds, 60, 10, 3600) },
    retryLimit: { enabled: rule('retryLimit').enabled === true, attempts: boundedInteger(rule('retryLimit').attempts, 1, 1, 3) },
    suppressAutomaticHealthChecks: { enabled: rule('suppressAutomaticHealthChecks').enabled === true },
    suppressBackgroundRefresh: { enabled: rule('suppressBackgroundRefresh').enabled === true },
    forceServerProxy: { enabled: rule('forceServerProxy').enabled === true },
  };
}

export const playlistRuleEnabled = (source, name) => normalizePlaylistRules(source?.rules)[name]?.enabled === true;

export class PlaylistRuleRuntime {
  constructor() { this.streamStarts = new Map(); this.apiRequests = new Map(); }
  checkStreamStart(source, now = Date.now()) {
    const rules = normalizePlaylistRules(source?.rules), key = String(source?._id || '');
    const starts = (this.streamStarts.get(key) || []).filter(time => time > now - rules.streamStartRate.windowSeconds * 1000);
    if (rules.streamStartCooldown.enabled && now - (starts.at(-1) || 0) < rules.streamStartCooldown.seconds * 1000) throw new Error(`Provider rule: wait ${rules.streamStartCooldown.seconds} seconds between stream starts`);
    if (rules.streamStartRate.enabled && starts.length >= rules.streamStartRate.limit) throw new Error(`Provider rule: maximum ${rules.streamStartRate.limit} stream starts per ${rules.streamStartRate.windowSeconds} seconds`);
    starts.push(now); this.streamStarts.set(key, starts);
  }
  checkApiRequest(source, now = Date.now()) {
    const rules = normalizePlaylistRules(source?.rules);
    if (!rules.apiRequestRate.enabled) return;
    const key = String(source?._id || '');
    const requests = (this.apiRequests.get(key) || []).filter(time => time > now - rules.apiRequestRate.windowSeconds * 1000);
    if (requests.length >= rules.apiRequestRate.limit) throw new Error(`Provider rule: maximum ${rules.apiRequestRate.limit} API requests per ${rules.apiRequestRate.windowSeconds} seconds`);
    requests.push(now); this.apiRequests.set(key, requests);
  }
}
