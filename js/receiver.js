import {
  BLOCK_SIZE,
  MANIFEST_NAME,
  PEER_OPTIONS,
  SpeedMeter,
  describeRoute,
  peerIdForCode,
  randomCode,
  rootHash,
  safeSegments,
  sha256,
  toHex,
} from './protocol.js';

export class Receiver {
  constructor(onUpdate, { pickDirectory } = {}) {
    this.onUpdate = onUpdate;
    this.pickDirectory = pickDirectory || (() => window.showDirectoryPicker({ id: 'w2m-dest', mode: 'readwrite', startIn: 'downloads' }));
    this.phase = 'starting';
    this.message = '';
    this.code = '';
    this.peer = null;
    this.conn = null;
    this.dc = null;
    this.pending = null;
    this.session = null;
    this.device = '';
    this.files = [];
    this.dir = null;
    this.manifest = {};
    this.gen = 0;
    this.cur = null;
    this.queue = [];
    this.processing = false;
    this.route = null;
    this.meter = new SpeedMeter();
    this.startedAt = 0;
    this.finishedAt = 0;
  }

  get totalBytes() {
    return this.files.reduce((a, f) => a + f.size, 0);
  }

  get doneBytes() {
    return this.files.reduce((a, f) => a + (f.status === 'done' || f.status === 'skipped' ? f.size : f.written), 0);
  }

  get current() {
    return this.cur?.file || null;
  }

  emit() {
    this.onUpdate?.(this);
  }

  setPhase(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.emit();
  }

  start() {
    this.code = randomCode();
    this.setPhase('starting', 'Connecting to the pairing service…');
    const peer = new window.Peer(peerIdForCode(this.code), PEER_OPTIONS);
    this.peer = peer;
    peer.on('open', () => {
      if (this.phase === 'starting' || this.phase === 'error') this.setPhase('ready');
    });
    peer.on('connection', (conn) => this.onConnection(conn));
    peer.on('disconnected', () => {
      setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (err?.type === 'unavailable-id') {
        peer.destroy();
        return this.start();
      }
      if (err?.type === 'peer-unavailable') return;
      if (this.phase === 'starting') {
        this.setPhase('error', 'Could not reach the pairing service. Make sure this device has internet through the hotspot. Retrying…');
        setTimeout(() => {
          if (this.phase === 'error' && this.peer === peer) {
            peer.destroy();
            this.start();
          }
        }, 4000);
      }
    });
  }

  destroy() {
    this.peer?.destroy();
  }

  onConnection(conn) {
    conn.on('data', (data) => this.enqueue(conn, data));
    conn.on('close', () => this.enqueue(conn, { closed: true }));
  }

  enqueue(conn, data) {
    this.queue.push([conn, data]);
    if (!this.processing) this.process();
  }

  async process() {
    this.processing = true;
    try {
      while (this.queue.length) {
        const [conn, data] = this.queue.shift();
        try {
          await this.handle(conn, data);
        } catch (err) {
          console.error(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  send(obj, conn = this.conn) {
    const dc = conn?.dataChannel;
    if (dc?.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  async handle(conn, data) {
    if (data && data.closed) return this.onClose(conn);
    if (typeof data !== 'string') {
      if (conn === this.conn) await this.onChunk(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'hello') return this.onHello(conn, msg);
    if (conn !== this.conn) return;
    switch (msg.t) {
      case 'file':
        return this.onFile(msg);
      case 'block':
        return this.onBlock(msg);
      case 'end':
        return this.onEnd(msg);
      case 'abort-file':
        return this.onAbortFile(msg);
      case 'complete':
        return this.onComplete();
      case 'cancel':
        await this.abortCurrent();
        this.conn = null;
        return this.setPhase('cancelled', 'The sender cancelled the transfer.');
    }
  }

  onHello(conn, msg) {
    const live = this.conn && this.conn.open && this.conn !== conn;
    if (this.session && msg.session === this.session && this.files.length && this.phase !== 'cancelled') {
      this.conn = conn;
      this.dc = conn.dataChannel;
      if (this.cur) this.cur.block = null;
      this.gen++;
      this.send({
        t: 'accept',
        gen: this.gen,
        done: this.files.filter((f) => f.status === 'done').map((f) => f.id),
        skip: this.files.filter((f) => f.status === 'skipped').map((f) => f.id),
        failed: this.files.filter((f) => f.status === 'failed').map((f) => f.id),
        resume: this.cur ? { id: this.cur.file.id, offset: this.cur.position } : null,
      });
      if (this.phase !== 'done') this.setPhase('transferring');
      this.updateRoute(conn);
      return;
    }
    if (this.phase === 'incoming' || (this.phase === 'transferring' && live)) {
      this.send({ t: 'decline', reason: 'busy' }, conn);
      setTimeout(() => conn.close(), 500);
      return;
    }
    this.pending = { conn, msg };
    this.send({ t: 'wait' }, conn);
    this.setPhase('incoming');
  }

  async accept() {
    const pending = this.pending;
    if (!pending) return;
    let dir;
    try {
      dir = await this.pickDirectory();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this.message = `Could not use that folder: ${err?.message || err}`;
      return this.emit();
    }
    if (this.pending !== pending) return;
    if (!pending.conn.open) {
      this.pending = null;
      return this.setPhase('ready', 'The sender disconnected before you accepted.');
    }
    await this.abortCurrent();
    this.pending = null;
    this.dir = dir;
    this.manifest = await this.loadManifest();
    this.session = pending.msg.session;
    this.device = pending.msg.device || 'Sender';
    this.files = pending.msg.files.map((f) => ({ ...f, status: 'pending', written: 0, savedAs: '', error: '' }));
    const skip = [];
    for (const f of this.files) {
      if (await this.alreadyReceived(f)) {
        f.status = 'skipped';
        f.savedAs = this.manifest[f.path].savedAs;
        skip.push(f.id);
      }
    }
    this.conn = pending.conn;
    this.dc = pending.conn.dataChannel;
    this.gen = 1;
    this.startedAt = performance.now();
    this.finishedAt = 0;
    this.meter.reset();
    this.send({ t: 'accept', gen: this.gen, skip, done: [], failed: [], resume: null });
    this.setPhase('transferring');
    this.updateRoute(this.conn);
  }

  decline() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.send({ t: 'decline' }, pending.conn);
    setTimeout(() => pending.conn.close(), 500);
    this.setPhase(this.files.length && this.phase !== 'done' ? 'waiting-reconnect' : 'ready');
  }

  async cancel() {
    this.send({ t: 'cancel' });
    await this.abortCurrent();
    const conn = this.conn;
    this.conn = null;
    setTimeout(() => conn?.close(), 300);
    this.setPhase('cancelled', 'Transfer cancelled. Fully received files were kept.');
  }

  newTransfer() {
    this.files = [];
    this.session = null;
    this.cur = null;
    this.setPhase('ready');
  }

  updateRoute(conn) {
    setTimeout(async () => {
      this.route = await describeRoute(conn.peerConnection);
      this.emit();
    }, 1000);
  }

  onClose(conn) {
    if (this.pending?.conn === conn) {
      this.pending = null;
      return this.setPhase(this.files.length && this.phase !== 'done' ? 'waiting-reconnect' : 'ready');
    }
    if (conn !== this.conn) return;
    this.conn = null;
    if (this.cur) this.cur.block = null;
    if (this.phase === 'transferring') this.setPhase('waiting-reconnect', 'Connection lost. Waiting for the sender to reconnect…');
  }

  async alreadyReceived(f) {
    const entry = this.manifest[f.path];
    if (!entry || entry.size !== f.size || entry.lastModified !== f.lastModified) return false;
    try {
      const segs = safeSegments(entry.savedAs);
      let dir = this.dir;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
      const file = await (await dir.getFileHandle(segs[segs.length - 1])).getFile();
      return file.size === f.size;
    } catch {
      return false;
    }
  }

  async loadManifest() {
    try {
      const file = await (await this.dir.getFileHandle(MANIFEST_NAME)).getFile();
      const data = JSON.parse(await file.text());
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  async saveManifest() {
    try {
      const fh = await this.dir.getFileHandle(MANIFEST_NAME, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(this.manifest, null, 1));
      await w.close();
    } catch (err) {
      console.warn('Could not write manifest', err);
    }
  }

  async abortCurrent() {
    const cur = this.cur;
    this.cur = null;
    if (!cur) return;
    if (cur.file.status === 'receiving') cur.file.status = 'pending';
    cur.file.written = 0;
    try {
      await cur.writable.abort();
    } catch {}
  }

  async openTarget(path) {
    const segs = safeSegments(path);
    let dir = this.dir;
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
    let name = segs[segs.length - 1];
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      try {
        await dir.getFileHandle(name);
        name = `${base} (${n})${ext}`;
      } catch (err) {
        if (err?.name === 'NotFoundError') break;
        throw err;
      }
    }
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable({ keepExistingData: false });
    return { writable, savedAs: [...segs.slice(0, -1), name].join('/') };
  }

  requestSeek(id, offset) {
    this.gen++;
    if (this.cur) this.cur.block = null;
    this.send({ t: 'seek', id, gen: this.gen, offset });
  }

  async onFile(msg) {
    if (msg.gen !== this.gen) return;
    const file = this.files.find((f) => f.id === msg.id);
    if (!file) return;
    if (this.cur && this.cur.file.id === msg.id) {
      if (msg.offset !== this.cur.position) this.requestSeek(msg.id, this.cur.position);
      return;
    }
    if (msg.offset !== 0) return this.requestSeek(msg.id, 0);
    await this.abortCurrent();
    try {
      const { writable, savedAs } = await this.openTarget(file.path);
      file.savedAs = savedAs;
      file.status = 'receiving';
      file.written = 0;
      this.cur = { file, writable, position: 0, hashes: [], block: null };
    } catch (err) {
      file.status = 'failed';
      file.error = `Could not create file: ${err?.message || err}`;
      this.send({ t: 'fail', id: file.id, error: file.error });
    }
    this.emit();
  }

  onBlock(msg) {
    const cur = this.cur;
    if (msg.gen !== this.gen || !cur || cur.file.id !== msg.id) {
      if (cur) cur.block = null;
      return;
    }
    if (msg.offset !== cur.position || msg.size > BLOCK_SIZE) return this.requestSeek(msg.id, cur.position);
    cur.block = { offset: msg.offset, size: msg.size, hash: msg.hash, buf: new Uint8Array(msg.size), filled: 0 };
  }

  async onChunk(data) {
    const cur = this.cur;
    const block = cur?.block;
    if (!block) return;
    const bytes = new Uint8Array(data);
    if (block.filled + bytes.byteLength > block.size) return this.requestSeek(cur.file.id, cur.position);
    block.buf.set(bytes, block.filled);
    block.filled += bytes.byteLength;
    if (block.filled < block.size) return;
    cur.block = null;
    const hash = await sha256(block.buf);
    if (toHex(hash) !== block.hash) return this.requestSeek(cur.file.id, cur.position);
    try {
      await cur.writable.write(block.buf);
    } catch (err) {
      return this.failCurrent(`Disk write failed: ${err?.message || err}`);
    }
    cur.hashes.push(hash);
    cur.position += block.size;
    cur.file.written = cur.position;
    this.meter.push(this.doneBytes);
    this.send({ t: 'ack', id: cur.file.id, offset: cur.position });
    this.emit();
  }

  async failCurrent(error) {
    const cur = this.cur;
    if (!cur) return;
    this.cur = null;
    cur.file.status = 'failed';
    cur.file.error = error;
    try {
      await cur.writable.abort();
    } catch {}
    this.send({ t: 'fail', id: cur.file.id, error });
    this.emit();
  }

  async onEnd(msg) {
    if (msg.gen !== this.gen) return;
    const cur = this.cur;
    if (!cur || cur.file.id !== msg.id) {
      const f = this.files.find((x) => x.id === msg.id);
      if (f?.status === 'done') this.send({ t: 'done', id: f.id, ok: true });
      return;
    }
    if (cur.position !== msg.size || cur.file.size !== msg.size) return this.requestSeek(cur.file.id, cur.position);
    if (cur.hashes.length !== Math.ceil(msg.size / BLOCK_SIZE) || (await rootHash(cur.hashes)) !== msg.root) {
      return this.failCurrent('Final checksum mismatch');
    }
    this.send({ t: 'finalizing', id: cur.file.id });
    try {
      await cur.writable.close();
    } catch (err) {
      return this.failCurrent(`Could not finish saving: ${err?.message || err}`);
    }
    this.cur = null;
    const f = cur.file;
    f.status = 'done';
    f.written = f.size;
    this.manifest[f.path] = { savedAs: f.savedAs, size: f.size, lastModified: f.lastModified, sha256root: msg.root, at: new Date().toISOString() };
    await this.saveManifest();
    this.meter.push(this.doneBytes);
    this.send({ t: 'done', id: f.id, ok: true, root: msg.root });
    this.emit();
  }

  async onAbortFile(msg) {
    const f = this.files.find((x) => x.id === msg.id);
    if (!f) return;
    if (this.cur?.file === f) await this.abortCurrent();
    f.status = 'failed';
    f.error = 'The sender could not read this file';
    this.emit();
  }

  onComplete() {
    this.finishedAt = performance.now();
    const failed = this.files.filter((f) => f.status === 'failed').length;
    this.setPhase('done', failed ? `${failed} file(s) failed.` : 'All files received and verified.');
  }
}
