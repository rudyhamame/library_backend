import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaCapacityError, MediaJobManager } from '../media-job-manager.js';

const limits = {
  maxTranscodes: 1,
  maxRemuxJobs: 2,
  maxTotalJobs: 2,
  maxJobsPerUser: 2,
  maxJobsPerDevice: 1,
  maxStartupQueue: 2,
  maxViewersPerJob: 64,
  idleTimeoutMs: 100,
  softMemoryPercent: 75,
  hardMemoryPercent: 88,
  maxLoadPerCpu: 1.5,
};

const noPressure = () => ({ soft: false, hard: false });

test('coalesces concurrent startup for an identical HLS job', async () => {
  const manager = new MediaJobManager({ limits, pressure: noPressure });
  let creates = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const create = async () => { creates += 1; await gate; return { stop() {} }; };
  const spec = { key: 'same', mode: 'remux', persistent: true, deviceId: 'roku-1' };
  const first = manager.getOrCreate(spec, create);
  const second = manager.getOrCreate(spec, create);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(creates, 1);
  assert.equal(a.job, b.job);
  assert.equal(b.reused, true);
  await manager.shutdown();
});

test('enforces per-device and transcode limits with controlled errors', async () => {
  const manager = new MediaJobManager({ limits, pressure: noPressure });
  await manager.getOrCreate({ key: 'one', mode: 'transcode', deviceId: 'roku-1' }, async () => ({ stop() {} }));
  await assert.rejects(
    manager.getOrCreate({ key: 'two', mode: 'transcode', deviceId: 'roku-2' }, async () => ({ stop() {} })),
    MediaCapacityError,
  );
  await assert.rejects(
    manager.getOrCreate({ key: 'three', mode: 'remux', deviceId: 'roku-1' }, async () => ({ stop() {} })),
    MediaCapacityError,
  );
  await manager.shutdown();
});

test('counts starting jobs against per-device limits', async () => {
  const manager = new MediaJobManager({ limits, pressure: noPressure });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = manager.getOrCreate({ key: 'starting', mode: 'remux', deviceId: 'roku-1' }, async () => {
    await gate;
    return { stop() {} };
  });
  await assert.rejects(
    manager.getOrCreate({ key: 'other', mode: 'remux', deviceId: 'roku-1' }, async () => ({ stop() {} })),
    /device media-job limit/i,
  );
  release();
  await first;
  await manager.shutdown();
});

test('idle sweep stops and removes abandoned jobs', async () => {
  let now = 1_000;
  let stopped = 0;
  const manager = new MediaJobManager({ limits, pressure: noPressure, now: () => now });
  await manager.getOrCreate({ key: 'idle', mode: 'remux', persistent: true }, async () => ({ stop() { stopped += 1; } }));
  now += 101;
  await manager.sweep();
  assert.equal(manager.get('idle'), undefined);
  assert.equal(stopped, 1);
});

test('hard memory pressure rejects all new FFmpeg jobs', async () => {
  const manager = new MediaJobManager({ limits, pressure: () => ({ soft: true, hard: true }) });
  await assert.rejects(
    manager.getOrCreate({ key: 'blocked', mode: 'remux' }, async () => ({ stop() {} })),
    /memory pressure/i,
  );
});
