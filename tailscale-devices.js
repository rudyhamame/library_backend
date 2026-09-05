import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cacheTtlMs = 20_000;
let cache = null;
let cacheExpiresAt = 0;

// Maps every IP address on the tailnet (including this machine's own) to its
// Tailscale device identity, so a linked device's last-seen IP can be shown
// as a friendly machine name when it happens to be a tailnet address. Best
// effort: if the `tailscale` CLI is unavailable or errors, callers just see
// no matches rather than a failure.
export async function getTailscalePeersByIp() {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: 5_000 });
    const data = JSON.parse(stdout);
    const map = new Map();
    const addPeer = peer => {
      if (!peer) return;
      const identity = { hostName: String(peer.HostName || ''), os: String(peer.OS || ''), online: Boolean(peer.Online), self: Boolean(peer.Self) };
      for (const ip of Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : []) map.set(ip, identity);
    };
    addPeer({ ...data.Self, Self: true });
    for (const peer of Object.values(data.Peer || {})) addPeer(peer);
    cache = map;
    cacheExpiresAt = Date.now() + cacheTtlMs;
    return map;
  } catch {
    return cache || new Map();
  }
}
