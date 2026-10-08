// Writes incoming files into the browser's private file system (OPFS) using
// synchronous access handles, which Safari only exposes inside workers.
const open = new Map();

async function dirFor(segs) {
  let dir = await navigator.storage.getDirectory();
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
  return dir;
}

const ops = {
  async probe() {
    const dir = await dirFor(['.probe']);
    const fh = await dir.getFileHandle('probe.bin', { create: true });
    const h = await fh.createSyncAccessHandle();
    h.write(new Uint8Array([1, 2, 3]), { at: 0 });
    await h.flush();
    await h.close();
    await (await navigator.storage.getDirectory()).removeEntry('.probe', { recursive: true });
  },
  async open({ id, dirs, name }) {
    const dir = await dirFor(dirs);
    const fh = await dir.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    await h.truncate(0);
    open.set(id, { h, pos: 0 });
  },
  async write({ id, buf }) {
    const s = open.get(id);
    if (!s) throw new Error('file is not open');
    const n = s.h.write(new Uint8Array(buf), { at: s.pos });
    if (n !== buf.byteLength) throw new Error(`short write (${n} of ${buf.byteLength} bytes): disk may be full`);
    s.pos += n;
  },
  async close({ id }) {
    const s = open.get(id);
    if (!s) return;
    open.delete(id);
    await s.h.flush();
    await s.h.close();
  },
  async abort({ id }) {
    const s = open.get(id);
    open.delete(id);
    if (s) await s.h.close();
  },
};

self.onmessage = async (e) => {
  const { req, op } = e.data;
  try {
    await ops[op](e.data);
    self.postMessage({ req, ok: true });
  } catch (err) {
    self.postMessage({ req, ok: false, error: err?.message || String(err) });
  }
};
