const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PreloadCache, dispersedIndices } = require('../electron/preload-cache.cjs');

test('distributed selection includes the first segment at 0/0.5/1', () => {
  assert.deepEqual([...dispersedIndices(8, 0)], []);
  assert.deepEqual([...dispersedIndices(8, 0.5)], [0, 2, 4, 6]);
  assert.equal(dispersedIndices(8, 1).size, 8);
  assert.throws(() => dispersedIndices(8, NaN));
});

test('highest quality, separate audio, keys/maps/ranges, gating, disk reuse and cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-preload-test-'));
  const hits = new Map(); const order = [];
  const server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1); order.push(req.url);
    if (req.url === '/master.m3u8') return res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720,AUDIO="audio"\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1920x1080,AUDIO="audio"\n1080.m3u8\n');
    if (req.url === '/1080.m3u8' || req.url === '/audio.m3u8') {
      const prefix = req.url === '/audio.m3u8' ? 'a' : 'v';
      return res.end(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init"\n${Array.from({length:8}, (_, i) => `#EXTINF:60,\n${prefix}${i}.ts`).join('\n')}\n#EXT-X-ENDLIST\n`);
    }
    setTimeout(() => res.end(Buffer.from(req.url === '/key' ? '0123456789abcdef' : 'segment-data-0123456789')), 20);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cache = new PreloadCache(root, { concurrency: 2 });
  try {
    const prepared = await cache.prepare(`http://127.0.0.1:${server.address().port}/master.m3u8`, {}, 0.5);
    assert.equal(cache.status(prepared.id).ready, false);
    const deadline = Date.now() + 5000;
    while (!cache.status(prepared.id).ready) {
      assert.equal(cache.status(prepared.id).error, null);
      assert.ok(Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(hits.has('/720.m3u8'), false);
    assert.ok(order.indexOf('/v6.ts') < order.indexOf('/v1.ts') || !hits.has('/v1.ts'));
    const manifest = await (await fetch(prepared.url)).text();
    assert.match(manifest, /1920x1080/); assert.doesNotMatch(manifest, /1280x720/);
    const videoUrl = manifest.split('\n').find(line => line.startsWith('http://'));
    const audioUrl = manifest.match(/URI="([^"]+)"/)[1];
    assert.match(await (await fetch(audioUrl)).text(), /EXTINF/);
    const media = await (await fetch(videoUrl)).text();
    const segmentUrl = media.split('\n').find(line => line.startsWith('http://'));
    const count = hits.get('/v0.ts');
    const segment = await (await fetch(segmentUrl)).text();
    assert.equal(segment, 'segment-data-0123456789');
    assert.equal(hits.get('/v0.ts'), count);
    const ranged = await fetch(segmentUrl, { headers: { Range: 'bytes=2-5' } });
    assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'gmen');
    assert.ok(cache.status(prepared.id).bytes > 0);
    cache.release(prepared.id);
    assert.equal((await fetch(segmentUrl)).status, 410);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { cache.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('HTTP failures become visible instead of an infinite preparation spinner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-preload-fail-'));
  const server = http.createServer((req, res) => res.writeHead(503).end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cache = new PreloadCache(root);
  try {
    const prepared = await cache.prepare(`http://127.0.0.1:${server.address().port}/bad.m3u8`, {}, 0.5);
    for (let i = 0; i < 100 && !cache.status(prepared.id).error; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(cache.status(prepared.id).error, /503/);
    assert.equal(cache.status(prepared.id).ready, false);
  } finally { cache.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive:true,force:true}); }
});
