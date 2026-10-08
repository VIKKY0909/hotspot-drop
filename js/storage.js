// Where the receiver writes incoming files.
//  - FolderStorage: Chrome/Edge. Writes straight into a folder the user picks.
//  - BrowserStorage: Safari (and any browser with OPFS). Streams to the browser's
//    private disk storage, then each finished file is handed to the normal
//    download flow so it lands in the Downloads folder.

export const STAGING_DIR = 'hotspot-drop-incoming';

export function supportsFolderPicker() {
  return typeof window.showDirectoryPicker === 'function';
}

export function supportsBrowserStorage() {
  return typeof navigator.storage?.getDirectory === 'function' && typeof Worker === 'function';
}

export class FolderStorage {
  constructor(pickDirectory) {
    this.kind = 'folder';
    this.pickDirectory = pickDirectory || (() => window.showDirectoryPicker({ id: 'w2m-dest', mode: 'readwrite', startIn: 'downloads' }));
  }

  pick() {
    return this.pickDirectory();
  }

  async openWriter(dir, dirSegs, name) {
    const fh = await dir.getFileHandle(name, { create: true });
    return fh.createWritable({ keepExistingData: false });
  }
}

export class BrowserStorage {
  constructor() {
    this.kind = 'browser';
    this.worker = new Worker(new URL('./opfs-worker.js', import.meta.url));
    this.pendingCalls = new Map();
    this.nextReq = 1;
    this.nextFile = 1;
    this.urls = new Map();
    this.worker.onmessage = (e) => {
      const p = this.pendingCalls.get(e.data.req);
      if (!p) return;
      this.pendingCalls.delete(e.data.req);
      e.data.ok ? p.resolve() : p.reject(new Error(e.data.error));
    };
  }

  call(op, data = {}, transfer = []) {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(req, { resolve, reject });
      this.worker.postMessage({ ...data, op, req }, transfer);
    });
  }

  probe() {
    return this.call('probe');
  }

  async root() {
    return (await navigator.storage.getDirectory()).getDirectoryHandle(STAGING_DIR, { create: true });
  }

  async pick() {
    await this.clear();
    return this.root();
  }

  async openWriter(dir, dirSegs, name) {
    const id = this.nextFile++;
    await this.call('open', { id, dirs: [STAGING_DIR, ...dirSegs], name });
    return {
      write: (u8) => {
        const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
        return this.call('write', { id, buf }, [buf]);
      },
      close: () => this.call('close', { id }),
      abort: () => this.call('abort', { id }),
    };
  }

  async fileFor(savedAs) {
    const segs = savedAs.split('/');
    let dir = await this.root();
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    return (await dir.getFileHandle(segs[segs.length - 1])).getFile();
  }

  /** Hands a received file to the browser's download flow (lands in Downloads). */
  async download(savedAs) {
    let url = this.urls.get(savedAs);
    if (!url) {
      url = URL.createObjectURL(await this.fileFor(savedAs));
      this.urls.set(savedAs, url);
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = savedAs.split('/').pop();
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }

  async clear() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    try {
      await (await navigator.storage.getDirectory()).removeEntry(STAGING_DIR, { recursive: true });
    } catch {}
  }

  async freeSpace() {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      return Number.isFinite(quota) ? quota - (usage || 0) : NaN;
    } catch {
      return NaN;
    }
  }
}
