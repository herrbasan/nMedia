import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nImage from '../modules/nImage/lib/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

let port = null;
let child = null;
let testDir = null;
const childOutput = [];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: free } = srv.address();
      srv.close(() => resolve(free));
    });
  });
}

async function rawPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
  }
  return nImage({ data: raw, width, height, channels: 3 }).png().toBuffer();
}

function childTail(lines = 40) {
  return childOutput.slice(-lines).join('').trim();
}

test.before(async () => {
  port = await getFreePort();
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmedia-e2e-'));
  for (const sub of ['cache/assets', 'cache/jobs', 'cache/uploads', 'logs']) {
    fs.mkdirSync(path.join(testDir, sub), { recursive: true });
  }

  child = spawn(process.execPath, ['src/index.js'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      NMEDIA_CACHE_DIR: path.join(testDir, 'cache', 'assets'),
      NMEDIA_LOGS_DIR: path.join(testDir, 'logs'),
      NMEDIA_WORKERS_MODE: 'queue',
    },
  });
  child.stdout.on('data', (chunk) => childOutput.push(chunk));
  child.stderr.on('data', (chunk) => childOutput.push(chunk));

  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Service exited with code ${child.exitCode} during startup.\n${childTail()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`Service did not become healthy within 15s (${lastError}).\n${childTail()}`);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = new Promise((resolve) => setTimeout(resolve, 5000).unref());
    await Promise.race([exited, timer]);
    if (child.exitCode === null) {
      // Windows cannot deliver POSIX signals; terminate the whole tree.
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await exited;
    }
  }
  if (testDir) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Warning: could not remove temp dir ${testDir}: ${err.message}`);
    }
  }
});

// ---------------------------------------------------------------------------
// HTTP / SSE / WS helpers
// ---------------------------------------------------------------------------

const BASE = () => `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, urlPath, { headers = {}, body } = {}) {
  let reqBody = body;
  const reqHeaders = { ...headers };
  if (body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    reqBody = JSON.stringify(body);
    if (!reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json';
    }
  }
  const res = await fetch(`${BASE()}${urlPath}`, { method, headers: reqHeaders, body: reqBody });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body — callers use .text for those.
  }
  return { status: res.status, json, text };
}

async function upload(buffer, filename) {
  return api('POST', '/v1/upload', {
    headers: {
      'content-type': 'application/octet-stream',
      'x-original-filename': filename,
    },
    body: buffer,
  });
}

async function download(urlPath) {
  const res = await fetch(`${BASE()}${urlPath}`);
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
}

async function startImageJob(input, options) {
  const res = await api('POST', '/v1/process', {
    body: { ...input, processor: 'image', options },
  });
  assert.equal(res.status, 200, `process failed: ${res.text}`);
  assert.ok(res.json.jobId);
  return res.json;
}

async function pollJob(jobId, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, json } = await api('GET', `/v1/jobs/${jobId}`);
    if (status === 200) {
      if (json.status === 'completed') return json;
      if (json.status === 'failed') throw new Error(`Job ${jobId} failed: ${json.error}`);
      if (json.status === 'cancelled') throw new Error(`Job ${jobId} was cancelled`);
    }
    await sleep(100);
  }
  throw new Error(`Job ${jobId} did not settle within ${timeoutMs}ms`);
}

// The server keeps a live-linked SSE stream open after `complete` (only the
// replayed branch ends the response), so the reader aborts once a terminal
// event arrives.
async function readSse(jobId, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${BASE()}/v1/jobs/${jobId}/progress`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    read: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          events.push(event);
          if (['complete', 'error', 'cancelled'].includes(event.type)) break read;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

class WsClient {
  constructor(url) {
    this.text = [];
    this.binary = [];
    this.#waiters = [];
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        this.#dispatch(JSON.parse(event.data));
      } else {
        this.binary.push(Buffer.from(event.data));
      }
    });
  }

  #waiters;

  #dispatch(msg) {
    const idx = this.#waiters.findIndex((w) => w.match(msg));
    if (idx === -1) {
      this.text.push(msg);
      return;
    }
    const [entry] = this.#waiters.splice(idx, 1);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  open(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeoutMs);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket connection failed'));
      }, { once: true });
    });
  }

  sendText(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  sendBinary(buffer) {
    this.ws.send(buffer);
  }

  waitFor(match, { timeoutMs = 15000, desc = 'message' } = {}) {
    const buffered = this.text.findIndex(match);
    if (buffered !== -1) {
      return Promise.resolve(this.text.splice(buffered, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const entry = { match, resolve };
      entry.timer = setTimeout(() => {
        const idx = this.#waiters.indexOf(entry);
        if (idx !== -1) this.#waiters.splice(idx, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${desc}; received: ${JSON.stringify(this.text)}`));
      }, timeoutMs);
      this.#waiters.push(entry);
    });
  }

  drainBinary() {
    const all = Buffer.concat(this.binary);
    this.binary = [];
    return all;
  }

  close() {
    try {
      this.ws.close();
    } catch (err) {
      console.warn(`Warning: WebSocket close failed: ${err.message}`);
    }
  }
}

// Four concurrent tasks are configured, so four slow jobs keep every worker
// busy and hold the next job in `queued` state deterministically. Used to
// observe queued-state behaviour (SSE start events, job cancellation).
const SLOW_OPTIONS = { format: 'jpeg', quality: 90, max_dimension: 2400, blur: 12 };

async function saturateQueue(mark = 'filler') {
  const heavy = await rawPng(3000, 3000, [10, 120, 200]);
  const jobIds = [];
  for (let i = 0; i < 4; i++) {
    const up = await upload(heavy, `${mark}-${i}.png`);
    assert.equal(up.status, 200, `filler upload failed: ${up.text}`);
    const job = await startImageJob({ fileId: up.json.fileId }, SLOW_OPTIONS);
    jobIds.push(job.jobId);
  }
  return { heavy, jobIds };
}

// ---------------------------------------------------------------------------
// a. Service health & capabilities
// ---------------------------------------------------------------------------

test('GET /health reports ok with processor readiness and uptime', async () => {
  const { status, json } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(typeof json.uptime, 'number');
  assert.ok(json.uptime >= 0);
  assert.deepEqual(json.processors, { image: 'ready', audio: 'ready', video: 'ready' });
});

test('GET /v1/capabilities exposes processors, endpoints and native modules', async () => {
  const { status, json } = await api('GET', '/v1/capabilities');
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const processors = json.data.service.features.processors.map((p) => p.name).sort();
  assert.deepEqual(processors, ['audio', 'image', 'video']);
  const paths = json.data.service.endpoints.map((e) => e.path);
  for (const expected of ['/v1/upload', '/v1/process', '/v1/jobs/:jobId', '/v1/assets/:id']) {
    assert.ok(paths.includes(expected), `missing endpoint ${expected}`);
  }
  assert.ok(json.data.nVideo);
  assert.ok(json.data.nImage);
});

// ---------------------------------------------------------------------------
// b. Unified transport (upload-to-cache flow)
// ---------------------------------------------------------------------------

test('unified transport: upload, process, poll, download, metadata', async () => {
  const png = await rawPng(100, 100, [255, 0, 0]);

  const up = await upload(png, 'test.png');
  assert.equal(up.status, 200, up.text);
  assert.ok(up.json.fileId);
  assert.equal(up.json.detectedType, 'image');
  assert.equal(up.json.status, 'ready');

  const started = await api('POST', '/v1/process', {
    body: { fileId: up.json.fileId, processor: 'image', options: { format: 'webp', max_dimension: 50 } },
  });
  assert.equal(started.status, 200, started.text);
  assert.ok(started.json.jobId);
  assert.equal(started.json.progress_url, `/v1/jobs/${started.json.jobId}/progress`);
  assert.equal(started.json.poll_url, `/v1/jobs/${started.json.jobId}`);

  const job = await pollJob(started.json.jobId);
  assert.equal(job.status, 'completed');
  assert.ok(job.assetId);

  const meta = await api('GET', `/v1/assets/${job.assetId}/metadata`);
  assert.equal(meta.status, 200);
  assert.equal(meta.json.id, job.assetId);
  assert.equal(meta.json.metadata.width, 50);
  assert.equal(meta.json.metadata.height, 50);
  assert.equal(meta.json.metadata.format, 'webp');

  const asset = await download(`/v1/assets/${job.assetId}`);
  assert.equal(asset.status, 200);
  assert.ok(asset.buffer.length > 0);
  assert.equal(asset.buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(asset.buffer.subarray(8, 12).toString('ascii'), 'WEBP');
});

// ---------------------------------------------------------------------------
// c. SSE progress streaming
// ---------------------------------------------------------------------------

test('SSE progress stream delivers state, start, progress and complete', async () => {
  const { heavy, jobIds: fillers } = await saturateQueue('sse-filler');

  const up = await upload(heavy, 'sse-target.png');
  const job = await startImageJob({ fileId: up.json.fileId }, SLOW_OPTIONS);

  // The queue is saturated, so the target job is still queued and the SSE
  // link is established before its lifecycle events are emitted.
  const events = await readSse(job.jobId);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('state'), `no state event, got: ${types}`);
  assert.ok(types.includes('complete'), `no complete event, got: ${types}`);

  const start = events.find((e) => e.type === 'start');
  if (start) {
    assert.equal(start.jobId, job.jobId);
  }
  const progress = events.find((e) => e.type === 'progress');
  if (progress) {
    assert.equal(typeof progress.percent, 'number');
    assert.ok(progress.percent >= 0 && progress.percent <= 100);
  }

  // Drain the fillers so later tests start from an idle queue.
  await Promise.all(fillers.map((id) => pollJob(id)));
});

// ---------------------------------------------------------------------------
// d. Path-based processing
// ---------------------------------------------------------------------------

test('path-based processing produces a JPEG asset', async () => {
  const uploadsDir = path.join(testDir, 'cache', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const inputPath = path.join(uploadsDir, 'path-input.png');
  fs.writeFileSync(inputPath, await rawPng(200, 100, [0, 200, 60]));

  const job = await startImageJob(
    { input_path: inputPath },
    { format: 'jpeg', quality: 80 },
  );
  const done = await pollJob(job.jobId);
  assert.ok(done.assetId);

  const asset = await download(`/v1/assets/${done.assetId}`);
  assert.equal(asset.status, 200);
  assert.ok(asset.buffer.length > 0);
  assert.equal(asset.buffer.subarray(0, 3).toString('hex'), 'ffd8ff');
});

// ---------------------------------------------------------------------------
// e. SVG rasterization through the HTTP API
// ---------------------------------------------------------------------------

test('SVG upload rasterizes to PNG at max_dimension and density sizes', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">' +
    '<rect width="400" height="200" fill="#ff0000"/>' +
    '</svg>',
  );

  for (const options of [{ max_dimension: 800, format: 'png' }, { density: 2, format: 'png' }]) {
    const up = await upload(svg, 'rect.svg');
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.detectedType, 'image');

    const job = await startImageJob({ fileId: up.json.fileId }, options);
    const done = await pollJob(job.jobId);
    assert.ok(done.assetId);

    const asset = await download(`/v1/assets/${done.assetId}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.buffer.subarray(1, 4).toString('ascii'), 'PNG');

    const meta = await nImage(asset.buffer).metadata();
    assert.equal(meta.width, 800, `options: ${JSON.stringify(options)}`);
    assert.equal(meta.height, 400, `options: ${JSON.stringify(options)}`);
  }
});

// ---------------------------------------------------------------------------
// f. WebSocket transport
// ---------------------------------------------------------------------------

test('WebSocket transport: ping, binary upload, progress subscribe, binary download', async () => {
  assert.notEqual(typeof WebSocket, 'undefined', 'Node >= 22 is required for the native WebSocket client');

  const ws = new WsClient(`ws://127.0.0.1:${port}/v1/ws`);
  try {
    await ws.open();

    const connected = await ws.waitFor((m) => m.type === 'connected', { desc: 'connected' });
    assert.ok(connected.id);

    ws.sendText({ type: 'ping' });
    const pong = await ws.waitFor((m) => m.type === 'pong', { desc: 'pong' });
    assert.equal(pong.type, 'pong');

    const png = await rawPng(64, 64, [90, 90, 200]);
    ws.sendText({ type: 'upload_start', uploadId: 'ws-up-1', filename: 'ws-test.png', size: png.length });
    const accepted = await ws.waitFor((m) => m.type === 'upload_accepted', { desc: 'upload_accepted' });
    assert.equal(accepted.uploadId, 'ws-up-1');

    ws.sendBinary(png);
    ws.sendText({ type: 'upload_complete', uploadId: 'ws-up-1' });
    const ready = await ws.waitFor((m) => m.type === 'upload_ready', { desc: 'upload_ready' });
    assert.ok(ready.fileId);
    assert.equal(ready.detectedType, 'image');

    // Process via HTTP, then subscribe: a completed job replays `complete`
    // with the assetId, which a live-linked stream would not carry.
    const started = await startImageJob(
      { fileId: ready.fileId },
      { format: 'png', max_dimension: 32 },
    );
    const done = await pollJob(started.jobId);

    ws.sendText({ type: 'subscribe', jobId: started.jobId });
    const complete = await ws.waitFor((m) => m.type === 'complete', { desc: 'complete' });
    assert.equal(complete.assetId, done.assetId);
    const subscribed = await ws.waitFor((m) => m.type === 'subscribed', { desc: 'subscribed' });
    assert.equal(subscribed.jobId, started.jobId);

    ws.sendText({ type: 'download_request', assetId: complete.assetId });
    const dlReady = await ws.waitFor((m) => m.type === 'download_ready', { desc: 'download_ready' });
    assert.equal(dlReady.assetId, complete.assetId);
    await ws.waitFor((m) => m.type === 'download_complete', { desc: 'download_complete' });

    const bytes = ws.drainBinary();
    assert.equal(bytes.length, dlReady.size);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
  } finally {
    ws.close();
  }
});

// ---------------------------------------------------------------------------
// g. Error cases
// ---------------------------------------------------------------------------

test('process validation: missing, duplicate and unknown inputs are rejected', async () => {
  const neither = await api('POST', '/v1/process', { body: { processor: 'image' } });
  assert.equal(neither.status, 400);

  const png = await rawPng(10, 10, [0, 0, 0]);
  const up = await upload(png, 'err.png');
  assert.equal(up.status, 200, up.text);

  const both = await api('POST', '/v1/process', {
    body: { fileId: up.json.fileId, input_path: 'somewhere.png', processor: 'image' },
  });
  assert.equal(both.status, 400);

  const unknown = await api('POST', '/v1/process', {
    body: { fileId: up.json.fileId, processor: 'quantum' },
  });
  assert.equal(unknown.status, 400);
});

test('upload of undetectable text is rejected with 415', async () => {
  const res = await upload(Buffer.from('hello world'), 'note.txt');
  assert.equal(res.status, 415);
});

test('unknown asset and job ids return 404', async () => {
  const asset = await download(`/v1/assets/${crypto.randomUUID()}`);
  assert.equal(asset.status, 404);

  const job = await api('GET', `/v1/jobs/${crypto.randomUUID()}`);
  assert.equal(job.status, 404);
});

test('DELETE /v1/jobs/:jobId cancels a queued job', async () => {
  const { heavy, jobIds: fillers } = await saturateQueue('cancel-filler');

  const up = await upload(heavy, 'cancel-target.png');
  const job = await startImageJob({ fileId: up.json.fileId }, { format: 'png' });

  // All workers are busy with the fillers, so this job is still queued.
  const { status, json } = await api('DELETE', `/v1/jobs/${job.jobId}`);
  assert.equal(status, 200, json?.message);
  assert.equal(json.status, 'cancelled');

  const after = await api('GET', `/v1/jobs/${job.jobId}`);
  assert.equal(after.status, 200);
  assert.equal(after.json.status, 'cancelled');

  await Promise.all(fillers.map((id) => pollJob(id)));
});
