export const PEER_PREFIX = 'w2m-xfer-v1-';
export const CHUNK_SIZE = 64 * 1024;
export const BLOCK_SIZE = 4 * 1024 * 1024;
// Max bytes sent but not yet verified + written by the receiver.
export const WINDOW_BYTES = 48 * 1024 * 1024;
export const BUFFER_HIGH = 4 * 1024 * 1024;
export const BUFFER_LOW = 1 * 1024 * 1024;
export const STALL_TIMEOUT_MS = 25000;
export const MANIFEST_NAME = '.w2m-transfer.json';

export const PEER_OPTIONS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

export function peerIdForCode(code) {
  return PEER_PREFIX + code;
}

export function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

export function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Root hash = SHA-256 over the concatenated per-block SHA-256 digests. */
export async function rootHash(blockHashes) {
  const all = new Uint8Array(blockHashes.length * 32);
  blockHashes.forEach((h, i) => all.set(h, i * 32));
  return toHex(await sha256(all));
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

const ILLEGAL = /[\u0000-\u001f<>:"\\|?*]/g;

/** Splits a sender-supplied relative path into safe path segments. */
export function safeSegments(path) {
  const segs = String(path)
    .split(/[\\/]+/)
    .map((s) => s.replace(ILLEGAL, '_').replace(/[. ]+$/, '').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return segs.length ? segs : ['unnamed'];
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows PC' : /Mac OS X/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux PC' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

/** Speed estimate over a sliding window of (time, bytes) samples. */
export class SpeedMeter {
  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
    this.samples = [];
  }
  push(totalBytes) {
    const now = performance.now();
    this.samples.push([now, totalBytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > this.windowMs) this.samples.shift();
  }
  reset() {
    this.samples = [];
  }
  get bytesPerSec() {
    if (this.samples.length < 2) return 0;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }
}

/** Describes the selected ICE candidate pair (local network vs. via internet). */
export async function describeRoute(pc) {
  if (!pc) return null;
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) {
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      });
    }
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const types = [local?.candidateType, remote?.candidateType];
    const relayed = types.includes('relay');
    const direct = types.every((t) => t === 'host' || t === 'prflx');
    return {
      label: relayed ? 'Relayed' : direct ? 'Direct · local network' : 'Direct · via NAT',
      local: local?.address || local?.ip,
      remote: remote?.address || remote?.ip,
      protocol: local?.protocol,
    };
  } catch {
    return null;
  }
}

export function onceEvent(target, name) {
  return new Promise((resolve) => target.addEventListener(name, resolve, { once: true }));
}
