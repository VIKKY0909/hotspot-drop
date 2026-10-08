// End-to-end test: two isolated Chrome profiles act as sender and receiver.
// Covers block corruption recovery, a forced connection drop mid-file, byte-exact
// verification of every received file, and skip-on-resend.
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, writeSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { serve } from './serve.mjs';

const BIG_MB = Number(process.env.BIG_MB || 300);
const CHANNEL = process.env.CHANNEL || 'chrome';
const activePages = [];

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

function makeFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-'));
  const big = join(dir, 'big video.bin');
  const fd = openSync(big, 'w');
  for (let left = BIG_MB * 1024 * 1024; left > 0; ) {
    const n = Math.min(left, 16 * 1024 * 1024);
    writeSync(fd, randomBytes(n));
    left -= n;
  }
  // Odd tail so the last block is partial.
  writeSync(fd, randomBytes(12345));
  closeSync(fd);
  writeFileSync(join(dir, 'notes.txt'), 'hello from windows\n'.repeat(1000));
  writeFileSync(join(dir, 'empty.dat'), '');
  const folder = join(dir, 'Photos 2026');
  mkdirSync(join(folder, 'trip', 'day1'), { recursive: true });
  writeFileSync(join(folder, 'cover.jpg'), randomBytes(5 * 1024 * 1024 + 7));
  writeFileSync(join(folder, 'trip', 'day1', 'img001.raw'), randomBytes(9 * 1024 * 1024));
  writeFileSync(join(folder, 'trip', 'readme.md'), '# trip');
  return { dir, big, folder, loose: [big, join(dir, 'notes.txt'), join(dir, 'empty.dat')] };
}

function expectedHashes(fx) {
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const out = {};
  for (const p of fx.loose) out[basename(p)] = sha(p);
  const rel = ['cover.jpg', 'trip/day1/img001.raw', 'trip/readme.md'];
  for (const r of rel) out[`Photos 2026/${r}`] = sha(join(fx.folder, ...r.split('/')));
  return out;
}

async function waitPhase(page, who, phases, timeout = 600000) {
  await page.waitForFunction(
    ([w, ps]) => ps.includes(window.__w2m?.[w]?.phase),
    [who, phases],
    { timeout, polling: 250 },
  );
}

async function startSend(context, base, fx, code) {
  const page = await context.newPage();
  page.on('pageerror', (e) => log('SENDER PAGE ERROR', e.message));
  if (process.env.VERBOSE) page.on('console', (m) => log('sender console:', m.text()));
  activePages.push(['sender', page]);
  await page.goto(`${base}/?test=1#send`);
  await page.setInputFiles('#input-files', fx.loose);
  await page.setInputFiles('#input-folder', fx.folder);
  const count = await page.evaluate(() => window.__w2m.sender.files.length);
  if (count !== 6) throw new Error(`expected 6 files selected, got ${count}`);
  await page.fill('#code-input', code);
  await page.click('#send-btn');
  return page;
}

async function main() {
  const fx = makeFixtures();
  const expected = expectedHashes(fx);
  const server = await serve(0);
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ channel: CHANNEL, headless: process.env.HEADED ? false : true });
  let failed = false;
  try {
    const recvCtx = await browser.newContext();
    const sendCtx = await browser.newContext();
    const recv = await recvCtx.newPage();
    recv.on('pageerror', (e) => log('RECEIVER PAGE ERROR', e.message));
    if (process.env.VERBOSE) recv.on('console', (m) => log('receiver console:', m.text()));
    activePages.push(['receiver', recv]);
    await recv.goto(`${base}/?test=1#receive`);
    await waitPhase(recv, 'receiver', ['ready'], 30000);
    const code = await recv.evaluate(() => window.__w2m.receiver.code);
    log('receiver ready, code', code);

    await recv.evaluate(() => {
      const r = window.__w2m.receiver;
      const onChunk = r.onChunk.bind(r);
      let n = 0;
      r.onChunk = (data) => {
        n++;
        if (n === 300) {
          const b = new Uint8Array(data.slice(0));
          b[10] ^= 0xff;
          return onChunk(b.buffer);
        }
        return onChunk(data);
      };
      window.__seeks = 0;
      const seek = r.requestSeek.bind(r);
      r.requestSeek = (...a) => {
        window.__seeks++;
        return seek(...a);
      };
    });

    const send = await startSend(sendCtx, base, fx, code);
    await recv.waitForSelector('#incoming-dialog[open]', { timeout: 30000 });
    log('incoming prompt shown:', (await recv.textContent('#incoming-desc')).trim());
    await recv.click('#accept-btn');
    const t0 = Date.now();
    const speedLog = process.env.SPEEDLOG
      ? setInterval(async () => {
          const s = await send.evaluate(() => {
            const x = window.__w2m.sender;
            const f = x.current;
            return { sent: f?.sent, acked: f?.acked, buffered: x.dc?.bufferedAmount };
          }).catch(() => null);
          const r = await recv.evaluate(() => ({ queue: window.__w2m.receiver.queue.length })).catch(() => null);
          if (s) log(`sent ${(s.sent / 1048576).toFixed(1)}MB acked ${(s.acked / 1048576).toFixed(1)}MB buffered ${(s.buffered / 1024).toFixed(0)}KB recvQueue ${r?.queue}`);
        }, 1000)
      : null;

    await recv.waitForFunction(() => window.__w2m.receiver.doneBytes > 120 * 1024 * 1024, null, { timeout: 300000, polling: 200 });
    log('forcing connection drop at', await recv.evaluate(() => (window.__w2m.receiver.doneBytes / 1048576).toFixed(0) + ' MB'));
    await send.evaluate(() => window.__w2m.sender.conn.peerConnection.close());
    await waitPhase(send, 'sender', ['reconnecting'], 10000);
    log('sender is reconnecting');
    await waitPhase(send, 'sender', ['transferring'], 60000);
    log('sender resumed at', await send.evaluate(() => (window.__w2m.sender.doneBytes / 1048576).toFixed(0) + ' MB'));

    await waitPhase(send, 'sender', ['done', 'error'], 600000);
    await waitPhase(recv, 'receiver', ['done'], 60000);
    clearInterval(speedLog);
    const secs = (Date.now() - t0) / 1000;
    const summary = await send.evaluate(() => {
      const s = window.__w2m.sender;
      return { phase: s.phase, message: s.message, route: s.route, statuses: s.files.map((f) => `${f.path}:${f.status}`), total: s.totalBytes };
    });
    log('sender summary', JSON.stringify(summary));
    log(`transferred ${(summary.total / 1048576).toFixed(0)} MB in ${secs.toFixed(1)} s incl. reconnect → ${(summary.total / 1048576 / secs).toFixed(1)} MB/s`);
    log('integrity re-requests (seeks):', await recv.evaluate(() => window.__seeks));

    const actual = await recv.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('received');
      const out = {};
      async function walk(dir, prefix) {
        for await (const [name, h] of dir.entries()) {
          const p = prefix ? `${prefix}/${name}` : name;
          if (h.kind === 'directory') await walk(h, p);
          else {
            const buf = await (await h.getFile()).arrayBuffer();
            const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
            out[p] = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
          }
        }
      }
      await walk(root, '');
      return out;
    });

    for (const [path, hash] of Object.entries(expected)) {
      if (actual[path] !== hash) {
        failed = true;
        log(`MISMATCH ${path}: expected ${hash.slice(0, 12)} got ${actual[path]?.slice(0, 12)}`);
      }
    }
    const extra = Object.keys(actual).filter((p) => !(p in expected) && p !== '.w2m-transfer.json');
    if (extra.length) {
      failed = true;
      log('unexpected files:', extra);
    }
    if (!('.w2m-transfer.json' in actual)) {
      failed = true;
      log('manifest missing');
    }
    log(failed ? 'FILE CHECK FAILED' : `all ${Object.keys(expected).length} files byte-identical`);

    // Resend the same files from a fresh sender: everything should be skipped.
    await recv.evaluate(() => window.__w2m.receiver.newTransfer());
    const sendCtx2 = await browser.newContext();
    const send2 = await startSend(sendCtx2, base, fx, code);
    await recv.waitForSelector('#incoming-dialog[open]', { timeout: 30000 });
    await recv.click('#accept-btn');
    await waitPhase(send2, 'sender', ['done', 'error'], 60000);
    const statuses = await send2.evaluate(() => window.__w2m.sender.files.map((f) => f.status));
    if (!statuses.every((s) => s === 'skipped')) {
      failed = true;
      log('resend did not skip:', statuses);
    } else log('resend: all files skipped as already received');
  } catch (err) {
    failed = true;
    log('TEST ERROR', err);
    for (const [who, page] of activePages) {
      const state = await page
        .evaluate((w) => {
          const m = window.__w2m?.[w];
          return m && { phase: m.phase, message: m.message, done: m.doneBytes, route: m.route };
        }, who)
        .catch((e) => e.message);
      log(`${who} state:`, JSON.stringify(state));
    }
  } finally {
    await browser.close();
    server.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
  log(failed ? 'E2E FAILED' : 'E2E PASSED');
  process.exit(failed ? 1 : 0);
}

main();
