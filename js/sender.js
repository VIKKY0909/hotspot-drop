import {
  BLOCK_SIZE,
  BUFFER_HIGH,
  BUFFER_LOW,
  CHUNK_SIZE,
  PEER_OPTIONS,
  STALL_TIMEOUT_MS,
  WINDOW_BYTES,
  SpeedMeter,
  describeRoute,
  deviceLabel,
  peerIdForCode,
  randomId,
  rootHash,
  sha256,
  toHex,
} from './protocol.js';

const RECONNECT_DELAY_MS = 2500;
const CONNECT_TIMEOUT_MS = 20000;

export class Sender {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.files = [];
    this.phase = 'idle';
    this.message = '';
    this.session = randomId();
    this.peer = null;
    this.conn = null;
    this.dc = null;
    this.gen = 0;
    this.runToken = 0;
    this.wakers = new Set();
    this.everConnected = false;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.lastProgressAt = 0;
    this.current = null;
    this.route = null;
    this.meter = new SpeedMeter();
    this.startedAt = 0;
    this.finishedAt = 0;
    this.watchdog = null;
  }

  addFiles(entries) {
    if (this.phase !== 'idle' && this.phase !== 'error' && this.phase !== 'declined') return;
    const seen = new Set(this.files.map((f) => f.path));
    for (const { file, path } of entries) {
      if (seen.has(path)) continue;
      seen.add(path);
      this.files.push({
        id: String(this.files.length + 1),
        file,
        path,
        size: file.size,
        lastModified: file.lastModified,
        status: 'pending',
        acked: 0,
        sent: 0,
        hashes: [],
        error: '',
      });
    }
    this.emit();
  }

  removeFile(id) {
    if (this.phase !== 'idle' && this.phase !== 'error' && this.phase !== 'declined') return;
    this.files = this.files.filter((f) => f.id !== id);
    this.emit();
  }

  clearFiles() {
    if (this.phase !== 'idle' && this.phase !== 'error' && this.phase !== 'declined') return;
    this.files = [];
    this.emit();
  }

  get totalBytes() {
    return this.files.reduce((a, f) => a + f.size, 0);
  }

  get doneBytes() {
    return this.files.reduce((a, f) => a + (f.status === 'done' || f.status === 'skipped' ? f.size : f.acked), 0);
  }

  emit() {
    this.onUpdate?.(this);
  }

  setPhase(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.emit();
  }

  start(code) {
    if (!this.files.length) return;
    this.code = code;
    this.everConnected = false;
    for (const f of this.files) {
      if (f.status === 'failed') f.status = 'pending';
    }
    this.setPhase('connecting', 'Looking for the receiver…');
    this.ensurePeer(() => this.connect());
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkStall(), 3000);
  }

  ensurePeer(then) {
    if (this.peer && !this.peer.destroyed) {
      if (this.peer.open) then();
      else if (this.peer.disconnected) {
        this.peer.once('open', then);
        this.peer.reconnect();
      } else this.peer.once('open', then);
      return;
    }
    const peer = new window.Peer(PEER_OPTIONS);
    this.peer = peer;
    peer.once('open', then);
    peer.on('error', (err) => this.onPeerError(err));
    peer.on('disconnected', () => {
      if (!peer.destroyed && this.isActive()) setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500);
    });
  }

  isActive() {
    return ['connecting', 'waiting', 'transferring', 'reconnecting'].includes(this.phase);
  }

  onPeerError(err) {
    const type = err?.type;
    if (type === 'peer-unavailable') {
      if (this.everConnected) return this.scheduleReconnect();
      return this.fail('No receiver found with that code. Check the 6-digit code shown on your Mac.');
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(type)) {
      if (this.everConnected) return this.scheduleReconnect();
      return this.fail('Could not reach the pairing service. Make sure this device has internet through the hotspot.');
    }
    if (this.everConnected) return this.scheduleReconnect();
    this.fail(err?.message || String(err));
  }

  fail(message) {
    clearTimeout(this.connectTimer);
    this.closeConn();
    this.setPhase('error', message);
  }

  connect() {
    if (!this.isActive()) return;
    this.closeConn();
    const conn = this.peer.connect(peerIdForCode(this.code), {
      reliable: true,
      serialization: 'raw',
      metadata: { session: this.session, device: deviceLabel() },
    });
    this.conn = conn;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.conn !== conn || conn.open) return;
      if (this.everConnected) this.scheduleReconnect();
      else
        this.fail(
          'Found the receiver but could not open a direct connection. Make sure both devices are on the same hotspot, then try again.',
        );
    }, CONNECT_TIMEOUT_MS);

    conn.on('open', () => {
      if (this.conn !== conn) return;
      clearTimeout(this.connectTimer);
      this.dc = conn.dataChannel;
      this.dc.bufferedAmountLowThreshold = BUFFER_LOW;
      this.dc.addEventListener('bufferedamountlow', () => this.wake());
      this.lastProgressAt = performance.now();
      const pc = conn.peerConnection;
      let graceTimer = null;
      pc?.addEventListener('connectionstatechange', () => {
        if (this.conn !== conn) return;
        clearTimeout(graceTimer);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.onDisconnect();
        else if (pc.connectionState === 'disconnected') {
          graceTimer = setTimeout(() => this.conn === conn && pc.connectionState !== 'connected' && this.onDisconnect(), 6000);
        }
      });
      this.sendJson({
        t: 'hello',
        session: this.session,
        device: deviceLabel(),
        total: this.totalBytes,
        files: this.files.map(({ id, path, size, lastModified }) => ({ id, path, size, lastModified })),
      });
      if (this.phase === 'connecting') this.setPhase('connecting', 'Connected. Waiting for the receiver…');
      setTimeout(async () => {
        this.route = await describeRoute(conn.peerConnection);
        this.emit();
      }, 1000);
    });
    conn.on('data', (data) => {
      if (this.conn === conn) this.onMessage(data);
    });
    conn.on('close', () => {
      if (this.conn === conn) this.onDisconnect();
    });
    conn.on('error', () => {
      if (this.conn === conn && !conn.open) this.onDisconnect();
    });
  }

  closeConn() {
    const conn = this.conn;
    this.conn = null;
    this.dc = null;
    this.runToken++;
    this.wake();
    try {
      conn?.close();
    } catch {}
  }

  onDisconnect() {
    if (!this.isActive()) return;
    this.closeConn();
    if (!this.everConnected) {
      return this.fail('The connection closed before the transfer started.');
    }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (!this.isActive()) return;
    if (this.phase !== 'reconnecting') this.setPhase('reconnecting', 'Connection lost. Reconnecting automatically…');
    this.closeConn();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.phase === 'reconnecting') this.ensurePeer(() => this.connect());
    }, RECONNECT_DELAY_MS);
  }

  checkStall() {
    if ((this.phase === 'transferring' || this.phase === 'waiting') && this.dc && this.dc.readyState !== 'open') return this.onDisconnect();
    if (this.phase !== 'transferring' || !this.current || this.current.finalizing) return;
    if (performance.now() - this.lastProgressAt > STALL_TIMEOUT_MS) this.scheduleReconnect();
  }

  cancel() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    if (this.dc?.readyState === 'open') this.sendJson({ t: 'cancel' });
    setTimeout(() => this.closeConn(), 300);
    this.setPhase('error', 'Transfer cancelled.');
  }

  reset() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.watchdog);
    this.watchdog = null;
    this.closeConn();
    this.peer?.destroy();
    this.peer = null;
  }

  sendJson(obj) {
    this.dc.send(JSON.stringify(obj));
  }

  wake() {
    const w = this.wakers;
    this.wakers = new Set();
    for (const r of w) r();
  }

  alive(token) {
    return token === this.runToken && this.dc?.readyState === 'open';
  }

  /** Resolves true once predicate() holds, false if the run was superseded. */
  async waitFor(token, predicate) {
    for (;;) {
      if (!this.alive(token)) return false;
      if (predicate()) return true;
      await new Promise((r) => this.wakers.add(r));
    }
  }

  onMessage(data) {
    if (typeof data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    this.lastProgressAt = performance.now();
    const file = msg.id ? this.files.find((f) => f.id === msg.id) : null;
    switch (msg.t) {
      case 'wait':
        this.setPhase('waiting', 'Waiting for the receiver to accept…');
        break;
      case 'decline':
        clearTimeout(this.reconnectTimer);
        this.closeConn();
        this.setPhase('declined', msg.reason === 'busy' ? 'The receiver is busy with another transfer.' : 'The receiver declined the transfer.');
        break;
      case 'accept': {
        this.everConnected = true;
        this.gen = msg.gen;
        for (const id of msg.skip || []) {
          const f = this.files.find((x) => x.id === id);
          if (f) f.status = 'skipped';
        }
        for (const id of msg.done || []) {
          const f = this.files.find((x) => x.id === id);
          if (f && f.status !== 'skipped') f.status = 'done';
        }
        for (const id of msg.failed || []) {
          const f = this.files.find((x) => x.id === id);
          if (f) f.status = 'failed';
        }
        if (!this.startedAt) this.startedAt = performance.now();
        this.meter.reset();
        this.setPhase('transferring', '');
        this.run(msg.resume || null);
        break;
      }
      case 'ack':
        if (file && msg.offset > file.acked) {
          file.acked = msg.offset;
          this.meter.push(this.doneBytes);
          this.wake();
          this.emit();
        }
        break;
      case 'finalizing':
        if (file) file.finalizing = true;
        break;
      case 'seek':
        if (file) {
          this.gen = msg.gen;
          file.acked = Math.min(file.acked, msg.offset);
          this.run({ id: file.id, offset: msg.offset });
        }
        break;
      case 'done':
        if (file) {
          file.status = msg.ok ? 'done' : 'failed';
          file.error = msg.ok ? '' : msg.error || 'Verification failed';
          if (msg.ok) file.acked = file.size;
          this.meter.push(this.doneBytes);
          this.wake();
          this.emit();
        }
        break;
      case 'fail':
        if (file) {
          file.status = 'failed';
          file.error = msg.error || 'Receiver could not save this file';
          this.wake();
          this.emit();
        }
        break;
      case 'cancel':
        clearTimeout(this.reconnectTimer);
        this.closeConn();
        this.setPhase('error', 'The receiver cancelled the transfer.');
        break;
    }
  }

  async run(resume) {
    const token = ++this.runToken;
    this.wake();
    let startIdx = 0;
    let startOffset = 0;
    if (resume) {
      startIdx = Math.max(0, this.files.findIndex((f) => f.id === resume.id));
      startOffset = resume.offset;
    }
    try {
      for (let i = startIdx; i < this.files.length; i++) {
        const f = this.files[i];
        if (f.status === 'done' || f.status === 'skipped' || f.status === 'failed') continue;
        const offset = i === startIdx && resume && f.id === resume.id ? startOffset : 0;
        const ok = await this.sendFile(token, f, offset);
        if (!ok) return;
      }
      if (!this.alive(token)) return;
      this.current = null;
      this.sendJson({ t: 'complete' });
      this.finishedAt = performance.now();
      clearInterval(this.watchdog);
      this.watchdog = null;
      const failed = this.files.filter((f) => f.status === 'failed').length;
      this.setPhase('done', failed ? `${failed} file(s) failed.` : 'All files sent and verified.');
    } catch (err) {
      if (this.alive(token)) this.fail(err?.message || String(err));
    }
  }

  async sendFile(token, f, offset) {
    this.current = f;
    f.status = 'sending';
    f.finalizing = false;
    f.acked = offset;
    f.sent = offset;
    this.emit();
    this.sendJson({ t: 'file', id: f.id, gen: this.gen, offset, size: f.size, path: f.path });

    while (offset < f.size) {
      const len = Math.min(BLOCK_SIZE, f.size - offset);
      const start = offset;
      if (!(await this.waitFor(token, () => start + len - f.acked <= WINDOW_BYTES))) return false;
      let buf;
      try {
        buf = await f.file.slice(offset, offset + len).arrayBuffer();
        if (buf.byteLength !== len) throw new Error('short read');
      } catch {
        if (!this.alive(token)) return false;
        f.status = 'failed';
        f.error = 'Could not read this file (was it moved or changed?)';
        this.sendJson({ t: 'abort-file', id: f.id, gen: this.gen });
        this.emit();
        return true;
      }
      const hash = await sha256(buf);
      if (!this.alive(token)) return false;
      f.hashes[offset / BLOCK_SIZE] = hash;
      this.sendJson({ t: 'block', id: f.id, gen: this.gen, offset, size: len, hash: toHex(hash) });
      for (let p = 0; p < len; p += CHUNK_SIZE) {
        if (this.dc.bufferedAmount > BUFFER_HIGH) {
          if (!(await this.waitFor(token, () => this.dc.bufferedAmount <= BUFFER_LOW))) return false;
        }
        if (!this.alive(token)) return false;
        this.dc.send(new Uint8Array(buf, p, Math.min(CHUNK_SIZE, len - p)));
      }
      offset += len;
      f.sent = offset;
    }

    f.hashes.length = Math.ceil(f.size / BLOCK_SIZE);
    const root = await rootHash(f.hashes);
    if (!this.alive(token)) return false;
    this.sendJson({ t: 'end', id: f.id, gen: this.gen, size: f.size, root });
    if (!(await this.waitFor(token, () => f.status === 'done' || f.status === 'failed'))) return false;
    return true;
  }
}
