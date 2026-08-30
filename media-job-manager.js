import os from 'node:os';

export class MediaCapacityError extends Error {
  constructor(message, retryAfterSeconds = 5) {
    super(message);
    this.name = 'MediaCapacityError';
    this.statusCode = 503;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const percent = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : fallback;
};

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function defaultMediaLimits(env = process.env) {
  const cpuCount = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
  const constrained = Number(process.constrainedMemory?.()) || os.totalmem();
  const lowMemory = constrained > 0 && constrained <= 600 * 1024 * 1024;
  const totalDefault = lowMemory || cpuCount <= 1 ? 2 : Math.min(4, cpuCount);
  return {
    maxTranscodes: positiveInt(env.MAX_ACTIVE_TRANSCODES, 1),
    maxRemuxJobs: positiveInt(env.MAX_ACTIVE_REMUX_JOBS, totalDefault),
    maxTotalJobs: positiveInt(env.MAX_TOTAL_FFMPEG_JOBS, totalDefault),
    maxJobsPerUser: positiveInt(env.MAX_JOBS_PER_USER, totalDefault),
    maxJobsPerDevice: positiveInt(env.MAX_JOBS_PER_DEVICE, 1),
    maxStartupQueue: positiveInt(env.MAX_STARTUP_QUEUE, totalDefault),
    maxViewersPerJob: positiveInt(env.MAX_VIEWERS_PER_MEDIA_JOB, 64),
    idleTimeoutMs: positiveInt(env.MEDIA_JOB_IDLE_TIMEOUT_MS, 45_000),
    softMemoryPercent: percent(env.MEMORY_SOFT_LIMIT_PERCENT, 75),
    hardMemoryPercent: percent(env.MEMORY_HARD_LIMIT_PERCENT, 88),
    maxLoadPerCpu: positiveNumber(env.MAX_LOAD_PER_CPU, 1.5),
  };
}

export function memoryPressure(limits = defaultMediaLimits()) {
  const memory = process.memoryUsage();
  const total = Number(process.constrainedMemory?.()) || os.totalmem();
  const usedPercent = total > 0 ? (memory.rss / total) * 100 : 0;
  const cpuCount = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
  const loadPerCpu = os.loadavg()[0] / cpuCount;
  return {
    totalBytes: total,
    rssBytes: memory.rss,
    usedPercent,
    soft: usedPercent >= limits.softMemoryPercent,
    hard: usedPercent >= limits.hardMemoryPercent,
    loadPerCpu,
    cpuHigh: loadPerCpu >= limits.maxLoadPerCpu,
  };
}

export class MediaJobManager {
  constructor({ limits = defaultMediaLimits(), now = () => Date.now(), pressure = () => memoryPressure(limits), debug = false } = {}) {
    this.limits = limits;
    this.now = now;
    this.pressure = pressure;
    this.debug = debug;
    this.jobs = new Map();
    this.starting = new Map();
    this.startingSpecs = new Map();
    this.accepting = true;
  }

  get(key) { return this.jobs.get(key); }
  entries() { return this.jobs.entries(); }
  values() { return this.jobs.values(); }

  counts() {
    let remux = 0;
    let transcode = 0;
    for (const job of this.jobs.values()) {
      if (job.mode === 'transcode') transcode += 1;
      else if (job.mode === 'remux') remux += 1;
    }
    return { total: this.jobs.size, remux, transcode, queued: this.starting.size };
  }

  assertCapacity({ mode, userId = '', deviceId = '', allowUnderLoad = false }) {
    if (!this.accepting) throw new MediaCapacityError('Media service is shutting down');
    const pressure = this.pressure();
    if (pressure.hard) throw new MediaCapacityError('Server memory pressure is too high for a new media job');
    if (mode === 'transcode' && !allowUnderLoad && (pressure.soft || pressure.cpuHigh)) throw new MediaCapacityError('Server is busy; transcoding is temporarily unavailable');
    const counts = this.counts();
    const starting = [...this.startingSpecs.values()];
    if (counts.total + counts.queued >= this.limits.maxTotalJobs) throw new MediaCapacityError('Media capacity is currently full');
    if (mode === 'transcode' && counts.transcode + starting.filter(spec => spec.mode === 'transcode').length >= this.limits.maxTranscodes) throw new MediaCapacityError('Transcoding capacity is currently full');
    if (mode === 'remux' && counts.remux + starting.filter(spec => spec.mode === 'remux').length >= this.limits.maxRemuxJobs) throw new MediaCapacityError('Remux capacity is currently full');
    if (this.starting.size >= this.limits.maxStartupQueue) throw new MediaCapacityError('Media startup queue is full');
    if (userId) {
      const count = [...this.jobs.values()].filter(job => job.userId === userId).length + starting.filter(spec => spec.userId === userId).length;
      if (count >= this.limits.maxJobsPerUser) throw new MediaCapacityError('User media-job limit reached');
    }
    if (deviceId) {
      const count = [...this.jobs.values()].filter(job => job.deviceId === deviceId).length + starting.filter(spec => spec.deviceId === deviceId).length;
      if (count >= this.limits.maxJobsPerDevice) throw new MediaCapacityError('Device media-job limit reached');
    }
  }

  async getOrCreate(spec, create) {
    const existing = this.jobs.get(spec.key);
    if (existing) { this.touch(existing, spec.viewerId); return { job: existing, reused: true }; }
    const pending = this.starting.get(spec.key);
    if (pending) return { job: await pending, reused: true };
    this.assertCapacity(spec);
    const startup = (async () => {
      const created = await create();
      if (!this.accepting) {
        await created.stop?.('shutdown-during-startup');
        throw new MediaCapacityError('Media service is shutting down');
      }
      const now = this.now();
      const job = {
        ...created, ...spec, createdAt: now, lastAccessAt: now,
        viewers: new Map(), state: 'running', error: created.error || '',
      };
      this.touch(job, spec.viewerId);
      this.jobs.set(spec.key, job);
      if (this.debug) console.log(`[Media] created ${spec.mode} ${spec.key}`);
      return job;
    })();
    this.starting.set(spec.key, startup);
    this.startingSpecs.set(spec.key, spec);
    try { return { job: await startup, reused: false }; }
    finally { this.starting.delete(spec.key); this.startingSpecs.delete(spec.key); }
  }

  touch(jobOrKey, viewerId = '') {
    const job = typeof jobOrKey === 'string' ? this.jobs.get(jobOrKey) : jobOrKey;
    if (!job) return null;
    const now = this.now();
    job.lastAccessAt = now;
    if (viewerId) job.viewers.set(viewerId, now);
    while (job.viewers.size > this.limits.maxViewersPerJob) job.viewers.delete(job.viewers.keys().next().value);
    return job;
  }

  async remove(key, reason = 'complete') {
    const job = this.jobs.get(key);
    if (!job) return false;
    this.jobs.delete(key);
    job.state = 'stopping';
    try { await job.stop?.(reason); }
    finally {
      job.state = 'stopped';
      job.viewers?.clear();
      if (this.debug) console.log(`[Media] stopped ${job.mode} ${key} (${reason})`);
    }
    return true;
  }

  async sweep({ aggressive = false } = {}) {
    const now = this.now();
    const cutoff = now - (aggressive ? Math.min(10_000, this.limits.idleTimeoutMs) : this.limits.idleTimeoutMs);
    const removals = [];
    for (const [key, job] of this.jobs) {
      for (const [viewerId, seenAt] of job.viewers || []) if (seenAt < cutoff) job.viewers.delete(viewerId);
      if (job.lastAccessAt >= cutoff) continue;
      removals.push(this.remove(key, job.finished ? 'complete' : 'idle'));
    }
    await Promise.allSettled(removals);
  }

  async shutdown() {
    this.accepting = false;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.jobs.keys()].map(key => this.remove(key, 'shutdown')));
  }
}
