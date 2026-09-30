/**
 * The F9 recorder's frame stream to the `bitmagic dev` sidecar (`/api/dev/record-stream`).
 *
 * Nothing about a trailer recording has to happen in real time: the recording's clock is the frame
 * index, and the engine holds its loop while this stream is behind. What matters is that every
 * frame leaves the tab cheaply. Raw 1080p RGBA is 8.3 MB a frame and a WebSocket to the sidecar
 * carries about 95 MB/s, which pinned capture at ~11 fps. So the worker encodes the frames into a
 * high-bitrate intermediate video with WebCodecs (H.264, or VP9 where Chrome has no H.264 encoder)
 * — hardware where the platform has it, software otherwise, at ~60 Mbps for 1080p60, which a
 * trailer that ends at web bitrates cannot tell from the source — and ships ~100 KB chunks. After
 * the recording stops, the sidecar turns the video into `capture.mp4` and the PNG frames the
 * trailer pipeline reads, and only then answers `stopped`. Without WebCodecs (or a sidecar that
 * predates it) the worker sends raw RGBA exactly as before.
 *
 * Two things measured in Chrome 152 shape the code here:
 *  - A VideoFrame built over a GPU-backed source (an ImageBitmap, a canvas) runs Chrome's software
 *    encoders at ~140 fps for the first sixty frames and then collapses to one frame a second; the
 *    same pixels handed over as a plain RGBA buffer sustain 180 fps. So the main thread reads the
 *    pixels (`getImageData`, ~5 ms at 1080p) and transfers the buffer; the worker never touches a
 *    canvas.
 *  - Chrome's encoders emit one chunk per frame in input order (no B-frames), so a FIFO of frame
 *    indices is enough to label the outputs.
 *
 * Main ↔ worker messages:
 *   main → worker  {type:'start', url, recordingName, width, height}
 *                  {type:'frame', index, pixels: ArrayBuffer}   (transferred)
 *                  {type:'stop', frameCount, handed}            (worker flushes, then tells the sidecar)
 *                  {type:'close'}
 *   worker → main  {type:'started', codec, hardware, container?} (sidecar accepted; codec is what the worker sends)
 *                  {type:'sent', index, buffered}                 one chunk (or raw frame) on the socket
 *                  {type:'frame-failed', index, error, settled?}  this frame will be missing (settled: it
 *                                                                 had been sent, so it no longer counts as
 *                                                                 awaiting the sidecar)
 *                  {type:'ack', frameIndex} | {type:'progress', phase, frames} | {type:'stopped', …} | {type:'error', error}
 *                  {type:'closed'}
 *
 * Sidecar wire protocol: see cli/src/editor/recording-stream.ts. The `codec` field in `start` is
 * how the two sides agree on the format; an old sidecar echoes no codec back and the worker drops
 * to raw RGBA for the session.
 *
 * An `http(s)://` url selects the chunked-HTTP transport instead — game-play-agent's sink for the
 * web Creator (`/api/trailer/record-stream/<gameId>`), which has no WebSocket: POST `/start` (the
 * same hello, answered with the same `started`), POST `/chunks` batches of `[u32 LE length][packet]`
 * in order, POST `/stop`, then GET `/status` until it answers `stopped`. The worker turns those into
 * exactly the messages above, so nothing outside the worker knows which transport ran. Video only:
 * without a WebCodecs encoder the HTTP transport refuses to start.
 */

export type StreamCodec = 'avc' | 'vp9' | 'raw';

export interface StreamStopResult {
    written: number;
    missing: number[];
    error?: string;
}

/** How this recording's frames left the tab — recorded in timeline.json for provenance. */
export interface StreamCapture {
    codec: StreamCodec;
    /** Whether Chrome reported a hardware encoder for the chosen config; null for raw. */
    hardware: boolean | null;
    /** The video the sidecar keeps next to the frames (`capture.mp4` / `capture.webm`); null for raw. */
    container: string | null;
}

export interface RecordStreamHooks {
    frameFailed(index: number, error: string): void;
    /** Sidecar post-processing after stop: `muxing`, `extracting` — with the frame count so far. */
    progress(phase: string, frames: number): void;
}

/**
 * The worker. A plain script (Blob URL) so it ships inside this file and needs no build step.
 * Written without backticks so the template literal stays trivially valid.
 */
export const RECORD_WORKER_SOURCE = `
let tx = null, enc = null, codec = 'raw', width = 0, height = 0, hardware = null;
let received = 0, sent = 0, stopAfter = -1, stopCount = 0, stopping = false, encFailed = null;
const pending = [];
const FRAME_US = 1000000 / 60;

function candidates(w, h) {
  const base = { width: w, height: h, framerate: 60, bitrate: Math.round(w * h * 60 * 0.5), bitrateMode: 'variable',
    latencyMode: 'quality', alpha: 'discard', hardwareAcceleration: 'no-preference' };
  const level = w * h > 2560 * 1440 ? '34' : '33';
  return [
    { codec: 'avc', config: Object.assign({ codec: 'avc1.6400' + level, avc: { format: 'annexb' } }, base) },
    { codec: 'avc', config: Object.assign({ codec: 'avc1.4d00' + level, avc: { format: 'annexb' } }, base) },
    { codec: 'vp9', config: Object.assign({ codec: 'vp09.00.51.08' }, base) },
  ];
}
async function pickCodec(w, h) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const c of candidates(w, h)) {
    try {
      const r = await VideoEncoder.isConfigSupported(c.config);
      if (!r.supported) continue;
      let hw = false;
      try { hw = (await VideoEncoder.isConfigSupported(Object.assign({}, c.config, { hardwareAcceleration: 'prefer-hardware' }))).supported; } catch (e) { hw = false; }
      return { codec: c.codec, config: c.config, hardware: hw };
    } catch (e) { /* next candidate */ }
  }
  return null;
}
function packet(index, key, bytes) {
  const head = codec === 'raw' ? 4 : 5;
  const out = new Uint8Array(head + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, index, true);
  if (head === 5) out[4] = key ? 1 : 0;
  out.set(bytes, head);
  return out;
}

// The sidecar's WebSocket (bitmagic dev): one message per packet, acks and progress pushed back.
function wsTransport(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return {
    begin(hello) {
      ws.onopen = () => ws.send(JSON.stringify(hello));
      ws.onmessage = (ev) => { let msg; try { msg = JSON.parse(String(ev.data)); } catch (e) { return; } onServer(msg); };
      ws.onerror = () => postMessage({ type: 'error', error: 'the frame stream could not connect' });
      ws.onclose = () => postMessage({ type: 'closed' });
    },
    packet(index, bytes) { ws.send(bytes); },
    stop(frameCount) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop', frameCount: frameCount })); },
    buffered() { return ws.bufferedAmount; },
    close() { ws.close(); },
  };
}

// game-play-agent's chunked-HTTP sink (the web Creator): packets batched into ordered POSTs of
// [u32 LE length][packet]..., acks from each response, and a polled status after stop so a long
// extraction still reports progress. One POST in flight at a time keeps the chunks in order.
const BATCH_BYTES = 1 << 20;
const BATCH_MS = 250;
const MAX_TRIES = 4;
function httpTransport(url) {
  const base = url.replace(/[/]+$/, '');
  let name = '', queue = [], queued = 0, inflight = false, stopWanted = -1, timer = null, polling = false;
  function post(path, body, json) {
    return fetch(base + path + '?recordingName=' + encodeURIComponent(name), {
      method: 'POST', body: body,
      headers: { 'Content-Type': json ? 'application/json' : 'application/octet-stream' },
    });
  }
  async function flush() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (inflight || queue.length === 0) { maybeStopHttp(); return; }
    const batch = queue.splice(0);
    queued = 0;
    let total = 0;
    for (const p of batch) total += 4 + p.bytes.byteLength;
    const body = new Uint8Array(total);
    const view = new DataView(body.buffer);
    let at = 0;
    for (const p of batch) { view.setUint32(at, p.bytes.byteLength, true); body.set(p.bytes, at + 4); at += 4 + p.bytes.byteLength; }
    inflight = true;
    let error = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const resp = await fetch(base + '/chunks?recordingName=' + encodeURIComponent(name), {
          method: 'POST', body: body, headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (resp.ok) { error = null; break; }
        error = 'the sink refused the chunks (' + resp.status + ')';
        if (resp.status < 500) break;
      } catch (err) { error = String(err); }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    inflight = false;
    for (const p of batch) {
      if (error === null) postMessage({ type: 'ack', frameIndex: p.index });
      else postMessage({ type: 'frame-failed', index: p.index, error: error, settled: true });
    }
    flush();
  }
  function maybeStopHttp() {
    if (stopWanted < 0 || inflight || queue.length > 0 || polling) return;
    polling = true;
    const frameCount = stopWanted;
    post('/stop', JSON.stringify({ frameCount: frameCount }), true).then(poll, (err) => postMessage({ type: 'stopped', written: 0, missing: [], error: String(err) }));
  }
  async function poll() {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      let msg = null;
      try {
        const resp = await fetch(base + '/status?recordingName=' + encodeURIComponent(name));
        if (resp.ok) msg = await resp.json();
      } catch (e) { msg = null; }
      if (msg === null) continue;
      if (msg.type === 'stopped') { postMessage(msg); return; }
      if (msg.type === 'progress') postMessage(msg);
    }
  }
  return {
    begin(hello) {
      name = hello.recordingName;
      post('/start', JSON.stringify(hello), true)
        .then((resp) => resp.json().catch(() => ({ type: 'error', error: 'the sink answered ' + resp.status })))
        .then((msg) => onServer(msg), (err) => postMessage({ type: 'error', error: 'the frame sink could not be reached: ' + String(err) }));
    },
    packet(index, bytes) {
      queue.push({ index: index, bytes: bytes });
      queued += bytes.byteLength;
      if (queued >= BATCH_BYTES) flush();
      else if (timer === null) timer = setTimeout(flush, BATCH_MS);
    },
    stop(frameCount) { stopWanted = frameCount; flush(); },
    buffered() { return queued; },
    close() { /* nothing held open */ },
  };
}

function onServer(msg) {
  if (msg.type === 'started') {
    // A sidecar that predates video capture ignores the codec and expects raw RGBA.
    if (codec !== 'raw' && msg.codec !== codec) { codec = 'raw'; hardware = null; dropEncoder(); }
    msg = Object.assign({}, msg, { codec: codec, hardware: hardware });
  }
  postMessage(msg);
}
function ship(index, key, bytes) {
  tx.packet(index, packet(index, key, bytes));
  sent++;
  postMessage({ type: 'sent', index: index, buffered: tx.buffered() });
}
function failFrame(index, error) { sent++; postMessage({ type: 'frame-failed', index: index, error: String(error) }); }
function dropEncoder() { if (enc !== null) { try { enc.close(); } catch (e) { /* already closed */ } enc = null; } }
function maybeStop() {
  if (stopAfter < 0) return;
  if (codec === 'raw') {
    if (sent >= stopAfter) { tx.stop(stopCount); stopAfter = -1; }
    return;
  }
  if (received < stopAfter || stopping) return;
  stopping = true;
  const finish = () => { tx.stop(stopCount); stopAfter = -1; };
  if (enc === null || enc.state !== 'configured') { finish(); return; }
  enc.flush().then(finish, (err) => { for (const index of pending.splice(0)) failFrame(index, err); finish(); });
}
async function start(m) {
  width = m.width; height = m.height;
  const http = /^https?:/.test(m.url);
  const picked = await pickCodec(width, height);
  if (picked !== null) {
    codec = picked.codec; hardware = picked.hardware;
    try {
      enc = new VideoEncoder({
        output: (chunk) => {
          const index = pending.shift();
          if (index === undefined) return;
          try {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            ship(index, chunk.type === 'key', bytes);
          } catch (err) { failFrame(index, err); }
        },
        error: (err) => {
          encFailed = String(err);
          for (const index of pending.splice(0)) failFrame(index, encFailed);
          maybeStop();
        },
      });
      enc.configure(picked.config);
    } catch (err) { codec = 'raw'; hardware = null; dropEncoder(); }
  }
  // Raw RGBA is a local-socket fallback; over HTTP it would be ~4 MB a frame, so it is refused.
  if (http && codec === 'raw') { postMessage({ type: 'error', error: 'this browser has no WebCodecs video encoder' }); return; }
  try { tx = http ? httpTransport(m.url) : wsTransport(m.url); } catch (err) { postMessage({ type: 'error', error: String(err) }); return; }
  const hello = { type: 'start', recordingName: m.recordingName, width: width, height: height };
  if (codec !== 'raw') hello.codec = codec;
  tx.begin(hello);
}
function frame(m) {
  const pixels = new Uint8Array(m.pixels);
  if (codec === 'raw') {
    try { ship(m.index, false, pixels); }
    catch (err) { failFrame(m.index, err); }
    maybeStop();
    return;
  }
  received++;
  if (encFailed !== null || enc === null || enc.state !== 'configured') {
    failFrame(m.index, encFailed || 'encoder closed');
    maybeStop();
    return;
  }
  pending.push(m.index);
  try {
    const f = new VideoFrame(m.pixels, { format: 'RGBA', codedWidth: width, codedHeight: height,
      timestamp: Math.round(m.index * FRAME_US), duration: Math.round(FRAME_US) });
    enc.encode(f, { keyFrame: m.index % 120 === 0 });
    f.close();
  } catch (err) {
    pending.pop();
    failFrame(m.index, err);
  }
  maybeStop();
}
self.onmessage = (event) => {
  const m = event.data;
  if (m.type === 'start') start(m);
  else if (m.type === 'frame') frame(m);
  else if (m.type === 'stop') { stopAfter = m.handed; stopCount = m.frameCount; maybeStop(); }
  else if (m.type === 'close') { dropEncoder(); if (tx) tx.close(); }
};
`;

/** Frames handed to the worker but not yet confirmed by the sidecar before the engine holds its loop. */
const MAX_UNACKED_FRAMES = 24;
/** Silence from the sidecar this long after stop means it died; every ack/progress resets it. */
const STOP_IDLE_MS = 60_000;
/** Even a busy sidecar finishes a recording in this time. */
const STOP_CAP_MS = 30 * 60_000;

/**
 * One recording's stream, owned by the ScreenRecorder for the duration of a frames-mode session.
 */
export class RecordStream {
    private worker: Worker | null = null;
    state: 'idle' | 'connecting' | 'open' | 'failed' = 'idle';
    /** Frames posted to the worker. */
    handed = 0;
    /** Frames (or their encoded chunks) the worker put on the socket, failures included. */
    sent = 0;
    /** Frames the sidecar confirmed. */
    acked = 0;
    /** Bytes still queued inside Chrome's socket, as of the last `sent`. */
    buffered = 0;
    capture: StreamCapture | null = null;
    private stopped: ((result: StreamStopResult) => void) | null = null;
    private lastActivity = 0;
    private holdLoggedAt = 0;

    constructor(private readonly hooks: RecordStreamHooks) {}

    /**
     * Open the stream. Until the sidecar answers `started` the engine loop is held (shouldHold);
     * if it refuses — no ffmpeg, an older sidecar — or the browser lacks Workers, the state goes to
     * `failed` and the recorder falls back to the HTTP sink for the rest of the session.
     */
    open(options: { url: string; recordingName: string; width: number; height: number }): void {
        if (typeof Worker === 'undefined') {
            console.warn('[ScreenRecorder] frame stream needs a Worker — using HTTP frames');
            this.state = 'failed';
            return;
        }
        let worker: Worker;
        try {
            worker = new Worker(URL.createObjectURL(new Blob([RECORD_WORKER_SOURCE], { type: 'text/javascript' })));
        } catch (err) {
            console.warn('[ScreenRecorder] frame stream worker could not start — using HTTP frames:', err);
            this.state = 'failed';
            return;
        }
        this.worker = worker;
        this.state = 'connecting';
        worker.onerror = (event: ErrorEvent) => {
            console.warn('[ScreenRecorder] frame stream worker error:', event.message);
            if (this.state === 'connecting') this.state = 'failed';
        };
        worker.onmessage = (event: MessageEvent) => this.onWorkerMessage(worker, event.data as WorkerMessage);
        worker.postMessage({ type: 'start', url: options.url, recordingName: options.recordingName, width: options.width, height: options.height });
    }

    /** Hand one frame's RGBA pixels over; the buffer is transferred and must not be touched again. */
    handFrame(index: number, pixels: ArrayBuffer): void {
        if (this.worker === null || this.state !== 'open') return;
        this.handed++;
        this.worker.postMessage({ type: 'frame', index, pixels }, [pixels]);
    }

    /** Whether the engine should skip this frame so the stream can catch up. */
    shouldHold(): boolean {
        if (this.state === 'connecting') return true;
        if (this.state !== 'open') return false;
        const unacked = this.handed - this.acked;
        if (unacked <= MAX_UNACKED_FRAMES) return false;
        const now = performance.now();
        if (now - this.holdLoggedAt > 2000) {
            this.holdLoggedAt = now;
            console.log(`[ScreenRecorder] holding the game loop: ${unacked} frames awaiting the sidecar`);
        }
        return true;
    }

    /**
     * Tell the sidecar the recording is over and wait until every frame is on disk. The sidecar
     * encodes after stop, so this waits on activity rather than a fixed budget.
     */
    close(frameCount: number): Promise<StreamStopResult> {
        return new Promise((resolve) => {
            const worker = this.worker;
            if (worker === null) {
                resolve({ written: 0, missing: [], error: 'no stream' });
                return;
            }
            const startedAt = performance.now();
            this.lastActivity = startedAt;
            const done = (result: StreamStopResult): void => {
                clearInterval(watchdog);
                this.state = 'idle';
                this.worker = null;
                this.stopped = null;
                worker.postMessage({ type: 'close' });
                setTimeout(() => worker.terminate(), 1000);
                resolve(result);
            };
            const watchdog = setInterval(() => {
                const now = performance.now();
                if (now - this.lastActivity > STOP_IDLE_MS) {
                    done({ written: this.acked, missing: [], error: `no word from the sidecar for ${Math.round(STOP_IDLE_MS / 1000)} s after stop` });
                } else if (now - startedAt > STOP_CAP_MS) {
                    done({ written: this.acked, missing: [], error: 'timed out waiting for the sidecar to finish the recording' });
                }
            }, 1000);
            this.stopped = done;
            // The worker sends `stop` only after every frame it was handed has been encoded and sent.
            worker.postMessage({ type: 'stop', frameCount, handed: this.handed });
        });
    }

    private onWorkerMessage(worker: Worker, msg: WorkerMessage): void {
        this.lastActivity = performance.now();
        switch (msg.type) {
            case 'started': {
                this.state = 'open';
                const codec = msg.codec ?? 'raw';
                this.capture = { codec, hardware: codec === 'raw' ? null : (msg.hardware ?? false), container: msg.container ?? null };
                const how = codec === 'raw' ? 'raw RGBA frames' : `${codec === 'avc' ? 'H.264' : 'VP9'} video (${this.capture.hardware ? 'hardware' : 'software'} encoder)`;
                console.log(`[ScreenRecorder] streaming ${how} to the sidecar from a worker`);
                break;
            }
            case 'sent':
                this.sent++;
                this.buffered = msg.buffered ?? 0;
                break;
            case 'ack':
                this.acked++;
                break;
            case 'progress':
                this.hooks.progress(msg.phase ?? '', msg.frames ?? 0);
                break;
            case 'frame-failed':
                // A settled failure was already counted as sent; it stops being awaited instead, so
                // one lost batch cannot hold the game loop forever.
                if (msg.settled === true) this.acked++;
                else this.sent++;
                if (typeof msg.index === 'number') this.hooks.frameFailed(msg.index, msg.error ?? 'worker frame failure');
                break;
            case 'stopped':
                this.stopped?.({ written: msg.written ?? 0, missing: msg.missing ?? [], ...(msg.error ? { error: msg.error } : {}) });
                break;
            case 'error':
                console.warn(`[ScreenRecorder] frame stream refused (${msg.error}) — using HTTP frames`);
                if (this.state === 'connecting') {
                    this.state = 'failed';
                    worker.terminate();
                    this.worker = null;
                }
                break;
            case 'closed':
                if (this.state === 'connecting') this.state = 'failed';
                this.stopped?.({ written: this.acked, missing: [], error: 'the frame stream closed before the sidecar confirmed the last frame' });
                break;
            default:
                break;
        }
    }
}

interface WorkerMessage {
    type?: string;
    index?: number;
    buffered?: number;
    error?: string;
    written?: number;
    missing?: number[];
    codec?: StreamCodec;
    hardware?: boolean | null;
    container?: string;
    phase?: string;
    frames?: number;
    settled?: boolean;
}
