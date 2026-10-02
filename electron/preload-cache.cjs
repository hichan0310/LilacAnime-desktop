// Dispersed episode preloading adapted from the local web player's EpisodePreloadCache.
// Media stays on disk; playback requests take precedence over the background queue.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

function dispersedIndices(count, ratio) {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('선다운로드 비율은 0~1이어야 합니다.');
  const size = Math.ceil(count * ratio);
  return new Set(Array.from({ length: size }, (_, i) => Math.floor(i * count / size)));
}

class PreloadCache {
  constructor(root, { concurrency = 6 } = {}) {
    this.root = root; this.concurrency = concurrency; this.sessions = new Map(); this.server = null;
    this.starting = null;
    fs.mkdirSync(root, { recursive: true });
    // Only this cache's abandoned session directories, after the app's single-instance lock.
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^episode-[A-Za-z0-9]{6}$/.test(entry.name)) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
  async listen() {
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.starting = new Promise((resolve, reject) => this.server.once('error', reject).listen(0, '127.0.0.1', resolve));
    try { await this.starting; } finally { this.starting = null; }
  }
  url(session, asset) { return `http://127.0.0.1:${this.server.address().port}/preload/${session.id}/${asset.id}`; }
  asset(session, url) {
    if (session.assets.has(url)) return session.assets.get(url);
    const asset = { id: crypto.randomUUID(), url, state: 'queued', priority: 1, file: null };
    session.assets.set(url, asset); session.ids.set(asset.id, asset);
    return asset;
  }
  async prepare(url, headers = {}, ratio = 0.5) {
    dispersedIndices(0, ratio);
    if (!/^https?:\/\//i.test(url)) throw new Error('HLS 재생 주소가 필요합니다.');
    await this.listen(); fs.mkdirSync(this.root, { recursive: true });
    const session = { id: crypto.randomUUID(), ratio, headers: {}, assets: new Map(), ids: new Map(), required: new Set(), controllers: new Set(), running: 0, initialized: false, closed: false, error: null, bytes: 0, dir: fs.mkdtempSync(path.join(this.root, 'episode-')) };
    for (const [key, value] of Object.entries(headers)) if (/^(user-agent|referer|origin|cookie|authorization|accept|accept-language)$/i.test(key)) session.headers[key] = String(value);
    this.sessions.set(session.id, session);
    const manifest = this.asset(session, url);
    this.manifest(session, manifest, 0).then(() => { session.initialized = true; this.pump(session); }).catch(error => this.fail(session, error));
    return { id: session.id, url: this.url(session, manifest) };
  }
  fail(session, error) {
    if (session.closed) return;
    session.error = String(error.message || error).replace(/https?:\/\/[^\s]+/g, '[주소]').slice(0, 250);
  }
  async response(session, url) {
    if (session.closed) throw new Error('선다운로드 취소');
    const controller = new AbortController(); session.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(url, { headers: session.headers, signal: controller.signal });
      if (!response.ok) throw new Error(`영상 서버 HTTP ${response.status}`);
      return { response, done: () => { clearTimeout(timer); session.controllers.delete(controller); } };
    } catch (error) { clearTimeout(timer); session.controllers.delete(controller); throw error; }
  }
  async manifest(session, asset, depth) {
    if (depth > 8) throw new Error('재생목록 연결이 너무 깊습니다.');
    if (asset.manifestPromise) return asset.manifestPromise;
    asset.manifestPromise = (async () => {
      const { response, done } = await this.response(session, asset.url);
      let text;
      try { text = await response.text(); } finally { done(); }
      if (session.closed) throw new Error('선다운로드 취소');
      if (!text.trimStart().startsWith('#EXTM3U') || text.length > 2 * 1024 * 1024) throw new Error('올바른 HLS 재생목록이 아닙니다.');
      let lines = text.split(/\r?\n/);
      const variants = [];
      lines.forEach((line, i) => { if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const height = Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1]) || 0;
        variants.push({ index: i, height, bandwidth: Number(line.match(/[:,]BANDWIDTH=(\d+)/)?.[1]) || 0, audio: line.match(/AUDIO="([^"]+)"/)?.[1] });
      } });
      if (variants.length) {
        const best = variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)[0];
        const audio = lines.filter(line => line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO(?:,|$)/.test(line) && line.includes(`GROUP-ID="${best.audio}"`));
        const chosenAudio = audio.find(line => /DEFAULT=YES/.test(line)) || audio[0];
        const remove = new Set(variants.filter(v => v !== best).flatMap(v => [v.index, v.index + 1]));
        lines = lines.filter((line, i) => !remove.has(i) && !line.startsWith('#EXT-X-I-FRAME-STREAM-INF:') && (!line.startsWith('#EXT-X-MEDIA:') || line === chosenAudio));
        lines = lines.map(line => line.replace(/,SUBTITLES="[^"]+"/g, ''));
      } else if (!lines.some(line => line.trim() === '#EXT-X-ENDLIST')) {
        throw new Error('선다운로드는 완결된 회차 재생목록에서 사용할 수 있습니다.');
      }
      const media = [], children = []; let duration = 0, elapsed = 0;
      lines = lines.map(line => {
        const value = line.trim();
        if (value.startsWith('#EXTINF:')) duration = Number(value.substring(8).split(',')[0]) || 0;
        if (!value) return line;
        if (value.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const child = this.asset(session, new URL(uri, response.url || asset.url).href);
          if (value.startsWith('#EXT-X-MEDIA:')) children.push(child);
          else session.required.add(child);
          return `URI="${this.url(session, child)}"`;
        });
        const child = this.asset(session, new URL(value, response.url || asset.url).href);
        if (variants.length) children.push(child);
        else { media.push(child); if (elapsed < 45) session.required.add(child); elapsed += duration; }
        return this.url(session, child);
      });
      for (const index of dispersedIndices(media.length, session.ratio)) session.required.add(media[index]);
      session.required.forEach(child => child.priority = 0);
      await Promise.all(children.map(child => this.manifest(session, child, depth + 1)));
      asset.text = lines.join('\n'); asset.state = 'done'; asset.type = 'application/vnd.apple.mpegurl';
    })();
    return asset.manifestPromise;
  }
  pump(session) {
    if (session.closed || !session.initialized) return;
    while (session.running < this.concurrency) {
      const next = [...session.assets.values()].filter(asset => asset.state === 'queued').sort((a, b) => a.priority - b.priority)[0];
      if (!next) break;
      next.state = 'loading'; session.running++;
      next.promise = this.download(session, next).catch(error => { next.state = 'failed'; this.fail(session, error); throw error; }).finally(() => { session.running--; this.pump(session); });
      next.promise.catch(() => {});
    }
  }
  async download(session, asset) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const partial = path.join(session.dir, `${asset.id}.part`);
      try {
        const { response, done } = await this.response(session, asset.url);
        try {
          if (!response.body) throw new Error('영상 데이터가 비어 있습니다.');
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
          if (session.closed) throw new Error('선다운로드 취소');
          const size = fs.statSync(partial).size;
          if (!size) throw new Error('영상 조각이 비어 있습니다.');
          asset.file = path.join(session.dir, asset.id); fs.renameSync(partial, asset.file);
          asset.type = response.headers.get('content-type') || 'application/octet-stream';
          session.bytes += size; asset.state = 'done'; return;
        } finally { done(); }
      } catch (error) {
        try { fs.unlinkSync(partial); } catch {}
        if (session.closed || attempt === 2 || error.code === 'ENOSPC') throw error;
      }
    }
  }
  status(id) {
    const s = this.sessions.get(id);
    if (!s) return { ready: false, error: '선다운로드 세션이 종료되었습니다.' };
    const prepared = [...s.required].filter(a => a.state === 'done').length;
    const completed = [...s.assets.values()].filter(a => a.file).length;
    return { ready: s.initialized && !s.error && prepared === s.required.size, prepared, required: s.required.size, completed, total: [...s.assets.values()].filter(a => !a.manifestPromise).length, bytes: s.bytes, error: s.error };
  }
  async handle(req, res) {
    try {
      const [, prefix, id, assetId] = new URL(req.url, 'http://localhost').pathname.split('/');
      const session = prefix === 'preload' && this.sessions.get(id), asset = session?.ids.get(assetId);
      if (!asset || session.closed) { res.writeHead(410).end(); return; }
      if (asset.manifestPromise) await asset.manifestPromise;
      else {
        asset.priority = -1; this.pump(session);
        if (asset.promise) await asset.promise;
        else await new Promise((resolve, reject) => {
          const poll = () => { if (session.closed) reject(new Error('선다운로드 취소')); else if (asset.promise) asset.promise.then(resolve, reject); else setTimeout(poll, 50); }; poll();
        });
      }
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', asset.type);
      if (asset.text != null) { res.end(asset.text); return; }
      const size = fs.statSync(asset.file).size, range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      let start = 0, end = size - 1;
      if (range) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; if (start > end) { res.writeHead(416).end(); return; } res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
      res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(fs.createReadStream(asset.file, { start, end }), res);
    } catch (error) { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('선다운로드 영상 요청 실패'); else res.destroy(); }
  }
  release(id) {
    const session = this.sessions.get(id); if (!session) return;
    session.closed = true; session.controllers.forEach(c => c.abort()); this.sessions.delete(id);
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
  close() { for (const id of this.sessions.keys()) this.release(id); this.server?.close(); this.server = null; }
}
module.exports = { PreloadCache, dispersedIndices };
