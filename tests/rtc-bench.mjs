// Raw RTCDataChannel throughput between two peer connections in one page (no PeerJS).
// Usage: node tests/rtc-bench.mjs [ipPrefixFilter ...]
import { chromium } from 'playwright-core';

const filters = process.argv.slice(2);
const browser = await chromium.launch({
  channel: process.env.CHANNEL || 'chrome',
  headless: !process.env.HEADED,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const page = await browser.newPage();
await page.goto('about:blank');
for (const filter of filters.length ? filters : ['']) {
  const result = await page.evaluate(async (FILTER) => {
    const CHUNK = 64 * 1024;
    const TOTAL = 15 * 1024 * 1024;
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    const pass = (c) => !FILTER || c.candidate.includes(` ${FILTER}`);
    a.onicecandidate = (e) => e.candidate && pass(e.candidate) && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && pass(e.candidate) && a.addIceCandidate(e.candidate);
    const dc = a.createDataChannel('x', { ordered: true });
    let received = 0;
    const done = new Promise((res) => {
      b.ondatachannel = (e) => {
        e.channel.binaryType = 'arraybuffer';
        e.channel.onmessage = (m) => {
          received += m.data.byteLength;
          if (received >= TOTAL) res();
        };
      };
    });
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
    const opened = await Promise.race([new Promise((r) => (dc.onopen = () => r(true))), new Promise((r) => setTimeout(() => r(false), 10000))]);
    if (!opened) return { filter: FILTER, error: 'no connection' };
    dc.bufferedAmountLowThreshold = 1 << 20;
    const buf = new Uint8Array(CHUNK);
    const t0 = performance.now();
    for (let sent = 0; sent < TOTAL; sent += CHUNK) {
      if (dc.bufferedAmount > 4 << 20) await new Promise((r) => (dc.onbufferedamountlow = r));
      dc.send(buf);
    }
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 60000));
    const outcome = await Promise.race([done, timeout]);
    const secs = (performance.now() - t0) / 1000;
    const stats = await a.getStats();
    let pair;
    stats.forEach((r) => r.type === 'transport' && r.selectedCandidatePairId && (pair = stats.get(r.selectedCandidatePairId)));
    const bStats = await b.getStats();
    let bPair;
    bStats.forEach((r) => r.type === 'transport' && r.selectedCandidatePairId && (bPair = bStats.get(r.selectedCandidatePairId)));
    const loss = {
      aPacketsSent: pair?.packetsSent,
      bPacketsReceived: bPair?.packetsReceived,
      aBytesSentMB: (pair?.bytesSent / 1048576).toFixed(1),
      rttMs: pair?.currentRoundTripTime * 1000,
    };
    const l = pair && stats.get(pair.localCandidateId);
    const rm = pair && stats.get(pair.remoteCandidateId);
    a.close();
    b.close();
    return {
      filter: FILTER || '(any)',
      route: `${l?.address}:${l?.port} (${l?.candidateType}) -> ${rm?.address}:${rm?.port}`,
      mbps: ((received / 1048576) / secs).toFixed(1),
      outcome: outcome || 'ok',
      ...loss,
    };
  }, filter);
  console.log(result);
}
await browser.close();
