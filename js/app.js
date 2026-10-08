import { Sender } from './sender.js';
import { Receiver } from './receiver.js';
import { formatBytes, formatDuration } from './protocol.js';
import { BrowserStorage, FolderStorage, supportsBrowserStorage, supportsFolderPicker } from './storage.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const TEST_MODE = params.get('test') === '1';
const MAX_ROWS = 200;
const ACTIVE = new Set(['connecting', 'waiting', 'transferring', 'reconnecting', 'waiting-reconnect']);

const useBrowserStorage = params.get('store') === 'browser' || (!supportsFolderPicker() && !TEST_MODE);
const canReceive = useBrowserStorage ? supportsBrowserStorage() : true;
const isMac = /Mac OS X/.test(navigator.userAgent);
const isWindows = /Windows/.test(navigator.userAgent);

let sender = null;
let receiver = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  window.scrollTo(0, 0);
}

/* ---------- wake lock: keep both machines awake during a transfer ---------- */

const wake = {
  lock: null,
  wanted: false,
  async set(on) {
    this.wanted = on;
    if (on && !this.lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      try {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => (this.lock = null));
      } catch {}
    } else if (!on && this.lock) {
      this.lock.release().catch(() => {});
      this.lock = null;
    }
  },
};
document.addEventListener('visibilitychange', () => wake.wanted && wake.set(true));

window.addEventListener('beforeunload', (e) => {
  if ((sender && ACTIVE.has(sender.phase)) || (receiver && ACTIVE.has(receiver.phase))) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ---------- shared rendering ---------- */

const STATUS_ICON = {
  pending: ['○', 'Waiting'],
  sending: ['◐', 'Sending'],
  receiving: ['◐', 'Receiving'],
  done: ['✓', 'Verified'],
  skipped: ['✓', 'Already there'],
  failed: ['✕', 'Failed'],
};

function fileRows(files, { activeId, saveable } = {}) {
  let list = files;
  if (files.length > MAX_ROWS) {
    const idx = Math.max(0, files.findIndex((f) => f.id === activeId));
    const start = Math.max(0, Math.min(idx - 20, files.length - MAX_ROWS));
    list = files.slice(start, start + MAX_ROWS);
  }
  const rows = list
    .map((f) => {
      const [icon, label] = STATUS_ICON[f.status] || STATUS_ICON.pending;
      const progress = f.status === 'sending' || f.status === 'receiving' ? Math.min(1, (f.acked ?? f.written) / (f.size || 1)) : null;
      return `<li class="file ${f.status}">
        <span class="file-icon" title="${label}">${icon}</span>
        <span class="file-name" title="${esc(f.path)}">${esc(f.savedAs || f.path)}</span>
        <span class="file-size">${progress !== null ? `${Math.floor(progress * 100)}% · ` : ''}${formatBytes(f.size)}${
          saveable && f.status === 'done' ? ` · <button type="button" class="link" data-action="save" data-id="${esc(f.id)}">${f.exported ? 'Save again' : 'Save'}</button>` : ''
        }</span>
        ${f.error ? `<span class="file-error">${esc(f.error)}</span>` : ''}
      </li>`;
    })
    .join('');
  const more = files.length > list.length ? `<li class="file more">Showing ${list.length} of ${files.length} files</li>` : '';
  return rows + more;
}

const TITLES = {
  connecting: 'Connecting',
  waiting: 'Waiting for the receiver to accept',
  transferring: null,
  reconnecting: 'Reconnecting…',
  'waiting-reconnect': 'Connection lost',
  done: 'Transfer complete',
  declined: 'Declined',
  error: 'Stopped',
  cancelled: 'Cancelled',
};

function renderProgress(el, m, role) {
  const total = m.totalBytes;
  const done = m.doneBytes;
  const pct = total ? (done / total) * 100 : m.phase === 'done' ? 100 : 0;
  const speed = m.meter.bytesPerSec;
  const transferring = m.phase === 'transferring';
  const eta = transferring && speed > 0 ? (total - done) / speed : NaN;
  const elapsedMs = m.startedAt ? (m.finishedAt || performance.now()) - m.startedAt : 0;
  const avg = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
  const title = TITLES[m.phase] ?? (role === 'send' ? 'Sending' : 'Receiving');
  const counts = m.files.reduce((a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a), {});
  const okCount = (counts.done || 0) + (counts.skipped || 0);
  const slow = transferring && speed > 0 && speed < 6 * 1024 * 1024 && elapsedMs > 8000;

  const actions = [];
  if (ACTIVE.has(m.phase)) actions.push(`<button type="button" class="btn danger" data-action="cancel">Cancel</button>`);
  if (role === 'send' && (m.phase === 'error' || m.phase === 'declined')) actions.push(`<button type="button" class="btn primary" data-action="retry">Try again</button>`);
  const browserStore = role === 'receive' && m.storage?.kind === 'browser';
  if (browserStore && m.phase === 'done') {
    actions.push(`<button type="button" class="btn" data-action="save-all">Save all again</button>`);
    actions.push(`<button type="button" class="btn" data-action="free">Free up space</button>`);
  }
  if (m.phase === 'done' || m.phase === 'cancelled') actions.push(`<button type="button" class="btn" data-action="again">${role === 'send' ? 'Send more files' : 'Receive more files'}</button>`);

  el.innerHTML = `
    <div class="progress-head">
      <div>
        <h2 class="phase ${m.phase}">${esc(title)}</h2>
        ${m.message ? `<p class="status-line">${esc(m.message)}</p>` : ''}
        ${role === 'receive' && m.device ? `<p class="status-line">From <strong>${esc(m.device)}</strong></p>` : ''}
      </div>
      ${m.route ? `<span class="route" title="${esc(`${m.route.local || ''} ⇄ ${m.route.remote || ''} (${m.route.protocol || ''})`)}">${esc(m.route.label)}</span>` : ''}
    </div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}">
      <div class="bar-fill ${m.phase}" style="width:${pct.toFixed(2)}%"></div>
    </div>
    <dl class="stats">
      <div><dt>Progress</dt><dd>${formatBytes(done)} / ${formatBytes(total)} <span class="muted">(${pct.toFixed(1)}%)</span></dd></div>
      <div><dt>${m.phase === 'done' ? 'Average speed' : 'Speed'}</dt><dd>${m.phase === 'done' ? formatBytes(avg) : formatBytes(speed)}/s</dd></div>
      <div><dt>${m.phase === 'done' ? 'Took' : 'Time left'}</dt><dd>${m.phase === 'done' ? formatDuration(elapsedMs / 1000) : formatDuration(eta)}</dd></div>
      <div><dt>Files</dt><dd>${okCount} / ${m.files.length} verified${counts.failed ? ` · <span class="bad">${counts.failed} failed</span>` : ''}</dd></div>
    </dl>
    ${slow ? `<p class="tip">Tip: transfers over a phone hotspot are much faster on <strong>5 GHz</strong>. On Samsung: Settings → Connections → Mobile Hotspot → Band → 5 GHz, then reconnect both devices. The transfer resumes by itself.</p>` : ''}
    ${role === 'receive' && !browserStore && m.phase === 'done' ? `<p class="hint">Files are in the folder you chose. Each one was checked block by block with SHA-256.</p>` : ''}
    ${browserStore && m.phase !== 'done' ? `<p class="hint">Each file is checked, then saved to your <strong>Downloads</strong> folder as soon as it finishes. If Safari asks whether to allow downloads from this site, choose <strong>Allow</strong>.</p>` : ''}
    ${
      browserStore && m.phase === 'done'
        ? `<p class="hint">Every file was checked block by block with SHA-256 and saved to your <strong>Downloads</strong> folder. If one is missing, press its <strong>Save</strong> link. Once the downloads have finished, press <strong>Free up space</strong> to delete Safari's temporary copy.</p>`
        : ''
    }
    ${m.freed ? `<p class="hint">Temporary copies deleted.</p>` : ''}
    ${actions.length ? `<div class="row">${actions.join('')}</div>` : ''}
    <ul class="file-list">${fileRows(m.files, { activeId: m.current?.id, saveable: browserStore && !m.freed })}</ul>
  `;
}

function throttledRenderer(fn) {
  let queued = false;
  let last = 0;
  return () => {
    if (queued) return;
    queued = true;
    const delay = Math.max(0, 200 - (performance.now() - last));
    setTimeout(() => {
      requestAnimationFrame(() => {
        queued = false;
        last = performance.now();
        fn();
      });
    }, delay);
  };
}

/* ---------- send ---------- */

const sendEls = {
  dropzone: $('#dropzone'),
  inputFiles: $('#input-files'),
  inputFolder: $('#input-folder'),
  selection: $('#selection'),
  summary: $('#selection-summary'),
  list: $('#selection-list'),
  form: $('#send-form'),
  code: $('#code-input'),
  btn: $('#send-btn'),
  progress: $('#send-progress'),
};

function codeDigits() {
  return sendEls.code.value.replace(/\D/g, '').slice(0, 6);
}

const renderSend = throttledRenderer(() => {
  const s = sender;
  const editable = s.phase === 'idle' || s.phase === 'error' || s.phase === 'declined';
  sendEls.selection.hidden = !s.files.length;
  sendEls.summary.textContent = `${s.files.length} file${s.files.length === 1 ? '' : 's'} · ${formatBytes(s.totalBytes)}`;
  sendEls.list.innerHTML = editable ? fileRows(s.files) : '';
  sendEls.selection.querySelector('#clear-files').hidden = !editable;
  sendEls.dropzone.classList.toggle('disabled', !editable);
  sendEls.code.disabled = !editable;
  sendEls.btn.disabled = !editable || !s.files.length || codeDigits().length !== 6;
  sendEls.progress.hidden = s.phase === 'idle';
  if (!sendEls.progress.hidden) renderProgress(sendEls.progress, s, 'send');
  wake.set(ACTIVE.has(s.phase));
});

function initSender() {
  if (sender) return;
  sender = new Sender(renderSend);
  if (TEST_MODE) (window.__w2m ||= {}).sender = sender;
  renderSend();
}

function filesFromInput(input) {
  return Array.from(input.files, (file) => ({ file, path: file.webkitRelativePath || file.name }));
}

async function readEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') || file.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await readEntry(e, out);
    }
  }
}

$('#add-files').addEventListener('click', () => sendEls.inputFiles.click());
$('#add-folder').addEventListener('click', () => sendEls.inputFolder.click());
for (const input of [sendEls.inputFiles, sendEls.inputFolder]) {
  input.addEventListener('change', () => {
    sender.addFiles(filesFromInput(input));
    input.value = '';
  });
}
$('#clear-files').addEventListener('click', () => sender.clearFiles());

sendEls.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  sendEls.dropzone.classList.add('over');
});
sendEls.dropzone.addEventListener('dragleave', () => sendEls.dropzone.classList.remove('over'));
sendEls.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  sendEls.dropzone.classList.remove('over');
  const entries = Array.from(e.dataTransfer.items || [])
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  const out = [];
  if (entries.length) for (const entry of entries) await readEntry(entry, out);
  else for (const file of e.dataTransfer.files) out.push({ file, path: file.name });
  sender.addFiles(out);
});

sendEls.code.addEventListener('input', () => {
  const d = codeDigits();
  sendEls.code.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
  renderSend();
});

sendEls.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = codeDigits();
  if (code.length !== 6 || !sender.files.length) return;
  sender.start(code);
});

sendEls.progress.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'cancel') sender.cancel();
  else if (action === 'retry') sender.start(codeDigits());
  else if (action === 'again') {
    sender.reset();
    sender = null;
    initSender();
  }
});

/* ---------- receive ---------- */

const recvEls = {
  card: $('#code-card'),
  code: $('#code-display'),
  status: $('#receive-status'),
  progress: $('#receive-progress'),
  dialog: $('#incoming-dialog'),
  desc: $('#incoming-desc'),
  list: $('#incoming-list'),
  error: $('#incoming-error'),
  acceptBtn: $('#accept-btn'),
  dialogHint: $('#incoming-hint'),
  saveStep: $('#save-step'),
};

const RECEIVE_STATUS = {
  starting: 'Connecting to the pairing service…',
  ready: 'Ready. Waiting for the sender…',
  incoming: 'Incoming request…',
  transferring: 'Connected',
  'waiting-reconnect': 'Waiting for the sender to reconnect…',
  done: 'Ready for another transfer with the same code.',
  cancelled: 'Ready for another transfer with the same code.',
};

let storageError = '';
let space = { pending: null, free: NaN };

const renderReceive = throttledRenderer(() => {
  const r = receiver;
  const browserStore = r.storage.kind === 'browser';
  recvEls.code.textContent = r.code ? `${r.code.slice(0, 3)} ${r.code.slice(3)}` : '––– –––';
  recvEls.status.textContent = storageError || (r.phase === 'error' ? r.message : RECEIVE_STATUS[r.phase] || '');
  recvEls.status.className = `status-line ${storageError ? 'error' : r.phase}`;
  recvEls.saveStep.textContent = browserStore ? 'Press Accept here. Files are saved to your Downloads folder.' : 'Press Accept here and choose a folder to save into.';
  recvEls.card.classList.toggle('compact', r.files.length > 0);
  recvEls.progress.hidden = !r.files.length;
  if (r.files.length) renderProgress(recvEls.progress, r, 'receive');

  if (r.phase === 'incoming' && r.pending) {
    const { msg } = r.pending;
    recvEls.desc.innerHTML = `<strong>${esc(msg.device || 'A device')}</strong> wants to send <strong>${msg.files.length} file${
      msg.files.length === 1 ? '' : 's'
    }</strong> (${formatBytes(msg.total)}).`;
    recvEls.list.innerHTML = fileRows(msg.files.map((f) => ({ ...f, status: 'pending' })));
    recvEls.acceptBtn.textContent = browserStore ? 'Accept' : 'Accept & choose folder';
    if (browserStore && space.pending !== r.pending) {
      space = { pending: r.pending, free: NaN };
      r.storage.freeSpace().then((free) => {
        space.free = free;
        renderReceive();
      });
    }
    const lowSpace = browserStore && space.free < msg.total * 2;
    recvEls.dialogHint.innerHTML = browserStore
      ? `Files go to your <strong>Downloads</strong> folder. While the transfer runs you need free disk space for about <strong>twice</strong> its size (${formatBytes(msg.total * 2)}). You can delete the temporary copy at the end.${
          lowSpace ? ` <span class="bad">Safari reports only ${formatBytes(space.free)} available for this site.</span>` : ''
        }`
      : 'Choose a folder with enough free space. Files already received into that folder are skipped.';
    recvEls.error.hidden = !r.message;
    recvEls.error.textContent = r.message;
    if (!recvEls.dialog.open) recvEls.dialog.showModal();
  } else if (recvEls.dialog.open) {
    recvEls.dialog.close();
  }
  wake.set(ACTIVE.has(r.phase));
});

function saveFile(f) {
  receiver.storage
    .download(f.savedAs)
    .then(() => {
      f.exported = true;
      renderReceive();
    })
    .catch((err) => {
      f.error = `Could not start the download: ${err?.message || err}`;
      renderReceive();
    });
}

async function initReceiver() {
  if (receiver) return;
  let storage;
  if (useBrowserStorage) storage = new BrowserStorage();
  else if (TEST_MODE) storage = new FolderStorage(async () => (await navigator.storage.getDirectory()).getDirectoryHandle('received', { create: true }));
  else storage = new FolderStorage();
  receiver = new Receiver(renderReceive, {
    storage,
    onFileSaved: (f) => storage.kind === 'browser' && saveFile(f),
  });
  if (TEST_MODE) (window.__w2m ||= {}).receiver = receiver;
  renderReceive();
  if (storage.kind === 'browser') {
    try {
      await storage.probe();
    } catch (err) {
      storageError = `This browser can't store incoming files (${err?.message || err}). Update Safari to the latest version, or open this page in Chrome or Edge.`;
      return renderReceive();
    }
  }
  receiver.start();
}

recvEls.acceptBtn.addEventListener('click', () => receiver.accept());
$('#decline-btn').addEventListener('click', () => receiver.decline());
recvEls.dialog.addEventListener('cancel', (e) => e.preventDefault());

recvEls.progress.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  const action = el?.dataset.action;
  if (action === 'cancel') receiver.cancel();
  else if (action === 'save') {
    const f = receiver.files.find((x) => x.id === el.dataset.id);
    if (f) saveFile(f);
  } else if (action === 'save-all') {
    for (const f of receiver.files.filter((x) => x.status === 'done')) saveFile(f);
  } else if (action === 'free') {
    await receiver.storage.clear();
    receiver.freed = true;
    renderReceive();
  } else if (action === 'again') {
    receiver.freed = false;
    receiver.newTransfer();
  }
});

/* ---------- navigation ---------- */

$('#page-url').textContent = location.origin + location.pathname;
$('#badge-send').hidden = !isWindows;
$('#badge-receive').hidden = !isMac;
$('#receive-support').hidden = canReceive;
if (!canReceive) $('#choose-receive').classList.add('unsupported');

$('#choose-send').addEventListener('click', () => {
  initSender();
  show('send');
  history.replaceState(null, '', '#send');
});
$('#choose-receive').addEventListener('click', () => {
  if (!canReceive) return;
  initReceiver();
  show('receive');
  history.replaceState(null, '', '#receive');
});
for (const b of document.querySelectorAll('[data-home]')) {
  b.addEventListener('click', () => {
    show('home');
    history.replaceState(null, '', location.pathname + location.search);
  });
}

if (location.hash === '#send') $('#choose-send').click();
else if (location.hash === '#receive') $('#choose-receive').click();

setInterval(() => {
  if (sender?.phase === 'transferring') renderSend();
  if (receiver?.phase === 'transferring') renderReceive();
}, 1000);
