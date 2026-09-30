import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import { getAgentUrl } from 'engine/agentUrl.js';
import { isCreatorMode, safePostMessageToCreator } from 'engine/CreatorMode.js';
import type { FlythroughPath } from 'debug/CameraPathEditor.js';
import { getGameEventLog, type TimelineSession } from 'engine/recording/GameEventLog.js';
import { getActiveBackend } from 'engine/RendererType.js';
import { RecordStream } from 'debug/RecordStream.js';

/** The dev-agent fallback sink only exists on the developer's own machine. */
function isLocalhost(): boolean {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

export class ScreenRecorder {
    private renderer: THREE.WebGLRenderer;
    private engine: GameEngine;
    private isRecording: boolean = false;
    // Buffered fallback only (see streamingToDisk): the captured bitmaps waiting to be saved at stop.
    private frames: ImageData[] = [];
    private frameCount: number = 0;
    private recordingStartTime: number = 0;
    private recordingName: string = '';

    // Store original renderer state for restoration (stored when recording starts)
    private originalSize: THREE.Vector2 = new THREE.Vector2();
    private originalPixelRatio: number = 1;
    private originalCanvas: HTMLCanvasElement | null = null;
    private originalViewport: { x: number; y: number; width: number; height: number } | null = null;

    // SparkRenderer LOD state saved before recording (restored on stop)
    private sparkOrigLodSplatCount: number | undefined = undefined;
    private sparkOrigLodSplatScale: number | undefined = undefined;

    private boundKeyDown: (event: KeyboardEvent) => void;
    private boundMessage: (event: MessageEvent) => void;

    // Recording mode: 'frames' = frame-by-frame at 60fps, 'video' = real-time screen capture
    private recordingMode: 'frames' | 'video' = 'frames';
    
    // Recording resolution (width x height)
    private recordingWidth: number = 1920;
    private recordingHeight: number = 1080;
    
    // Video capture mode: MediaRecorder over the canvas stream (see setupVideoCapture).
    private mediaRecorder: MediaRecorder | null = null;
    private videoChunks: Blob[] = [];

    // Localhost streaming: when the dev agent is reachable we POST each frame to
    // disk as it is captured instead of buffering ImageData in `this.frames`.
    // Buffering ~8MB/frame at 60fps exhausts the tab heap in seconds (the source
    // of the getImageData out-of-memory crash); streaming keeps memory flat and
    // never calls getImageData at all.
    private streamingToDisk: boolean = false;
    // Where frame/timeline POSTs go when the embedding host announces a sink of
    // its own (the `bitmagic dev` sidecar). In-memory only, never persisted:
    // dev ports drift between sessions, and the host re-announces the sink on
    // every load. Null means "no host sink" — fall back to getAgentUrl() (the
    // game-play-agent lane, unchanged).
    private sinkUrl: string | null = null;
    // Which editor host announced the sink, and where it keeps recordings — display only, for the
    // "recording complete" dialog. `bitmagic dev` says 'cli' + '.bitmagic/trailer/recordings';
    // the web Creator says nothing and gets the ~/Downloads wording it always had.
    private host: 'cli' | 'agent' | null = null;
    private recordingsDir: string | null = null;
    // The host's sink accepts a frame as a raw PNG body (`?recordingName=&frameIndex=`), so no
    // multipart Blob has to be built per frame. Announced in RECORDING_SETTINGS_CHANGED; an older
    // sink never says so and keeps getting multipart.
    private rawFrames: boolean = false;
    // The host's WebSocket frame sink (`bitmagic dev`'s /api/dev/record-stream). When announced,
    // frames leave through a worker that encodes them into an intermediate video with WebCodecs
    // (raw RGBA when the browser has no encoder) and the sidecar makes the PNGs after the
    // recording stops — see RecordStream. No Blob is ever created per frame, so Chrome's blob
    // storage — which a busy game loop's GC cannot keep clearing — stays out of the picture.
    private streamUrl: string | null = null;
    private stream: RecordStream | null = null;
    // Frames wait here as plain bytes, never as Blobs. A Blob lives in Chrome's blob storage until
    // its JS object is garbage-collected, and a long 1080p recording used to create them faster
    // than GC reclaimed them: after ~3 GB the store was full, every new Blob invalid, and every POST
    // carrying one failed with "Failed to fetch" — retries included — until the tab reloaded. Both
    // guided recordings on the dev lane died exactly this way at the 50-second mark. Holding frames
    // as ArrayBuffers instead (JS heap, so V8 feels the pressure and collects) and wrapping each in
    // a Blob only for the duration of its request keeps the store from filling.
    private streamQueue: Array<{ index: number; bytes: Uint8Array }> = [];
    private streamInflight: Set<Promise<void>> = new Set();
    private streamActiveUploads: number = 0;
    private streamSaved: number = 0;
    private streamFailed: boolean = false;
    private readonly STREAM_MAX_PARALLEL = 8;

    // Capture canvas reused across frames (allocating a 1080p canvas every tick
    // is wasteful and, on the old throw path, leaked one per failed frame).
    private captureCanvasEl: HTMLCanvasElement | null = null;
    private captureCtx: CanvasRenderingContext2D | null = null;

    // Trailer timeline session (frames mode): the GameEventLog collects
    // events/sounds keyed to this.frameCount while recording; at stop the
    // session is POSTed as timeline.json next to the frames.
    private pendingTimeline: TimelineSession | null = null;
    private timelineSaved: boolean = false;
    // The window the DOM HUD actually laid out against. The recorder resizes
    // only the CANVAS to the recording resolution and CSS-scales it into the
    // unchanged window, so HUD layout happens at these dimensions — the trailer
    // replay needs them to rasterize overlays that match what the player saw.
    private recordedWindow: { innerWidth: number; innerHeight: number; devicePixelRatio: number } | null = null;
    private frameClock: Array<{ frame: number; wallMs: number }> = [];
    private recordingStartWallMs: number = 0;
    // Frame indices whose save failed — a hole in the %06d sequence desyncs
    // every later SFX placement in the trailer cut, so failures are tracked,
    // retried once at drain, and survivors reported in the manifest.
    private failedFrameIndices: Set<number> = new Set();
    // Failed frames are kept for retry at drain, bounded by BYTES rather than by count: a 1080p
    // PNG is 1–3 MB, so 400 MB holds a few hundred frames — enough to survive the sink stalling
    // for several seconds — without buffering a whole lost recording in the tab heap.
    private retryBlobs: Map<number, Uint8Array> = new Map();
    private retryBytes: number = 0;
    private readonly RETRY_BUFFER_MAX_BYTES = 400 * 1024 * 1024;
    private readonly RETRY_PASSES = 3;
    private lastFrameFailure: string = '';
    // Backpressure. Capture can outrun the sink — a heavy scene at 1080p encodes PNGs faster than
    // a laptop uploads them — and every queued frame is a Blob in Chrome's blob storage. Let the
    // queue grow without bound and that storage fills; from then on EVERY new blob is invalid and
    // every POST fails with "Failed to fetch", retries included, until the tab reloads. That is
    // exactly the "fine for 50 s, then nothing" shape a lost recording has. So when the backlog
    // passes this many frames, the engine holds its loop (no simulation, no render, no capture)
    // until uploads catch up: the player feels a hitch, the recording stays complete — frame
    // index is the recording's clock, so held frames cost nothing in the output.
    private readonly MAX_BACKLOG_FRAMES = 24;
    private holdLoggedAt: number = 0;
    // toBlob is async: frames still encoding when recording stops must be
    // awaited by the drain, or the tail of the recording silently vanishes.
    private pendingEncodes: number = 0;

    constructor(renderer: THREE.WebGLRenderer, engine: GameEngine) {
        this.renderer = renderer;
        this.engine = engine;

        // Store canvas reference (doesn't change)
        this.originalCanvas = this.renderer.domElement;

        this.boundKeyDown = this.onKeyDown.bind(this);
        this.boundMessage = this.onMessage.bind(this);
        document.addEventListener('keydown', this.boundKeyDown);
        window.addEventListener('message', this.boundMessage);
        
        // Load initial settings from localStorage
        this.loadSettings();
    }
    
    private loadSettings(): void {
        try {
            const savedResolution = localStorage.getItem('aitopia5_recording_resolution');
            if (savedResolution) {
                const [width, height] = savedResolution.split('x').map(Number);
                if (width && height && width > 0 && height > 0) {
                    this.recordingWidth = width;
                    this.recordingHeight = height;
                }
            }
            
            const savedMode = localStorage.getItem('aitopia5_recording_mode');
            if (savedMode === 'frames' || savedMode === 'video') {
                this.recordingMode = savedMode;
            }
        } catch (e) {
            console.warn('Failed to load recording settings:', e);
        }
    }
    
    private onMessage(event: MessageEvent): void {
        if (!event.data) return;
        // Scripted capture: `bitmagic trailer record` drives the recorder over postMessage instead
        // of a keypress. Editor hosts only, like sinkUrl — a published game ignores these.
        if (isCreatorMode && event.data.type === 'TRAILER_RECORDING') {
            const action = event.data.action;
            if (action === 'start' && !this.isRecording) {
                if (event.data.mode === 'frames' || event.data.mode === 'video') this.recordingMode = event.data.mode;
                this.startRecording();
            } else if (action === 'stop' && this.isRecording) {
                this.stopRecording();
            }
            return;
        }
        if (isCreatorMode && event.data.type === 'TRAILER_FLYTHROUGH') {
            this.startFlythrough(event.data.path);
            return;
        }
        if (event.data.type === 'RECORDING_SETTINGS_CHANGED') {
            const settings = event.data.settings;
            if (settings) {
                if (settings.resolution && typeof settings.resolution === 'string') {
                    const [width, height] = settings.resolution.split('x').map(Number);
                    if (width && height && width > 0 && height > 0) {
                        this.recordingWidth = width;
                        this.recordingHeight = height;
                        localStorage.setItem('aitopia5_recording_resolution', settings.resolution);
                    }
                }
                if (settings.mode === 'frames' || settings.mode === 'video') {
                    this.recordingMode = settings.mode;
                    localStorage.setItem('aitopia5_recording_mode', settings.mode);
                }
                // Everything below is host-announced: only an editor host (the web Creator or the
                // `bitmagic dev` shell, both of which embed with ?source=creator) may name a sink or
                // describe where it keeps recordings. Published and standalone games are never
                // creator-mode, so these fields are inert there even though this file ships in
                // published bundles.
                if (isCreatorMode) {
                    if (typeof settings.sinkUrl === 'string') {
                        try {
                            const parsed = new URL(settings.sinkUrl);
                            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                                this.sinkUrl = parsed.origin;
                            }
                        } catch {
                            // Not an absolute URL — leave the current sink alone.
                        }
                    }
                    if (settings.host === 'cli' || settings.host === 'agent') {
                        this.host = settings.host;
                    }
                    if (typeof settings.recordingsDir === 'string' && settings.recordingsDir.length > 0) {
                        this.recordingsDir = settings.recordingsDir;
                    }
                    if (typeof settings.rawFrames === 'boolean') {
                        this.rawFrames = settings.rawFrames;
                    }
                }
                if (isCreatorMode && typeof settings.streamUrl === 'string') {
                    // ws(s): the `bitmagic dev` sidecar's socket; http(s): game-play-agent's chunked sink.
                    this.streamUrl = /^(wss?|https?):\/\//.test(settings.streamUrl) ? settings.streamUrl : null;
                }
            }
        }
    }

    /**
     * Whether the announced stream is game-play-agent's chunked-HTTP sink (the web Creator), which
     * also takes the timeline and keeps the recording server-side — no ffmpeg dialog to show.
     */
    private isHttpStream(): boolean {
        return this.streamUrl !== null && /^https?:\/\//.test(this.streamUrl);
    }

    /** Base URL for the frames/timeline disk sink: the host-announced sidecar, else the dev agent. */
    private getSinkUrl(): string {
        return this.sinkUrl ?? getAgentUrl();
    }

    /**
     * Whether the engine should skip this frame entirely so the upload backlog can drain.
     * Called by GameEngine.animate() before any per-frame work.
     */
    shouldHoldFrame(): boolean {
        if (!this.isRecording || !this.streamingToDisk || this.recordingMode !== 'frames') return false;
        // Stream sink: hold while the socket is still connecting, and while the sidecar is behind.
        if (this.stream !== null && this.stream.state !== 'failed') return this.stream.shouldHold();
        const backlog = this.pendingEncodes + this.streamQueue.length + this.streamActiveUploads;
        if (backlog <= this.MAX_BACKLOG_FRAMES) return false;
        const now = performance.now();
        if (now - this.holdLoggedAt > 2000) {
            this.holdLoggedAt = now;
            console.log(`[ScreenRecorder] holding the game loop: ${backlog} frames waiting to upload`);
        }
        return true;
    }

    /**
     * Open the host's frame stream for this recording (see RecordStream). If it fails to connect
     * the recorder falls back to the HTTP sink for the rest of the session, frames intact.
     */
    private openStream(): void {
        if (this.streamUrl === null) return;
        this.stream = new RecordStream({
            frameFailed: (index, error) => {
                this.failedFrameIndices.add(index);
                this.streamFailed = true;
                this.lastFrameFailure = error;
            },
            progress: (phase, frames) => {
                const label = phase === 'extracting' ? `Extracting frames… ${frames}` : phase === 'muxing' ? 'Writing capture.mp4…' : phase;
                this.showNotification('Saving Frames...', label, 'blue');
            },
        });
        this.stream.open({
            url: this.streamUrl,
            recordingName: this.recordingName,
            width: this.recordingWidth,
            height: this.recordingHeight,
        });
    }

    /**
     * Tell the editor host where a recording stands. `bitmagic trailer record` waits on these
     * (started → recording… → stopped → saved) instead of guessing from the filesystem; the Creator
     * ignores them. `recording` carries the frame count once a second while frames stream out.
     */
    private postState(state: 'started' | 'recording' | 'stopped' | 'saved' | 'failed', extra: Record<string, unknown> = {}): void {
        if (!isCreatorMode) return;
        safePostMessageToCreator({
            type: 'TRAILER_RECORDING_STATE',
            state,
            name: this.recordingName,
            frameCount: this.frameCount,
            ...extra,
        });
    }

    /**
     * A no-human recording: fly the camera along an authored path and record until it ends.
     * The path comes from the host (`bitmagic trailer record --flythrough`), not from a splat
     * world's cameraPathUrl, so this works in any game.
     */
    private startFlythrough(path: unknown): void {
        if (this.isRecording) return;
        const editor = this.engine.getCameraPathEditor();
        if (!editor) {
            console.warn('🎥 TRAILER_FLYTHROUGH: no camera path editor on this engine');
            this.postState('failed', { error: 'no camera path editor' });
            return;
        }
        try {
            editor.setPathData(path as FlythroughPath);
        } catch (err) {
            console.warn('🎥 TRAILER_FLYTHROUGH: invalid path', err);
            this.postState('failed', { error: err instanceof Error ? err.message : String(err) });
            return;
        }
        this.recordingMode = 'frames';
        // startRecording sees the markers and starts the path; the path's completion stops us.
        this.startRecording();
    }
    
    private onKeyDown(event: KeyboardEvent): void {
        if (event.key === 'F9') {
            event.preventDefault();
            if (this.isRecording) {
                this.stopRecording();
            } else {
                this.startRecording();
            }
        }
    }
    
    stopRecording(): void {
        if (!this.isRecording) return;

        this.isRecording = false;
        this.engine.forceFixedDeltaTime = false;
        const duration = (Date.now() - this.recordingStartTime) / 1000;

        // Restore renderer to original state (shared by both modes)
        this.restoreRendererState();

        this.postState('stopped', { durationSec: duration });
        // The web Creator's trailer lane opens a dialog as soon as the recording is saved; a
        // mouse-look game still holding the pointer would leave it unclickable until Esc. Releasing
        // the lock lands the game on its pause card, which is where it should wait anyway.
        if (this.isHttpStream()) this.engine.getPointerLockManager()?.exitLock();

        if (this.recordingMode === 'frames') {
            console.log(`📹 Recording stopped. Captured ${this.frameCount} frames in ${duration.toFixed(1)}s (${(this.frameCount / duration).toFixed(1)} fps average)`);

            // Freeze the trailer timeline at the stop instant — anything the
            // game logs after this belongs to no recording. Owner-gated: if a
            // passive eventlog session owns the log, this returns null (its
            // idle value) and that session survives.
            if (getGameEventLog().isActive()) {
                this.pendingTimeline = getGameEventLog().endSession('recorder');
            }

            // Nothing rendered — F9 pressed and released while the main thread was still finishing
            // the load, so animate() never reached the capture call. Stop here rather than saving:
            // the timeline is the only thing that would be written, and writing it would CREATE the
            // recording folder, leaving a directory holding a manifest and no frames for the
            // trailer tooling to find. The ffmpeg dialog is skipped for the same reason — its frame
            // range would read `_000000.png to _0000-1.png`.
            if (this.frameCount === 0) {
                this.pendingTimeline = null;
                this.showNotification(
                    'No Frames Captured',
                    'Nothing rendered while recording — the game was probably still loading. Press F9 again once it is running.',
                    'red',
                );
                return;
            }

            if (this.streamingToDisk) {
                // Frames were already written to disk during capture; wait for the
                // last uploads to flush, then show the ffmpeg helper.
                this.finishStreamingRecording();
            } else {
                // Buffered modes: encode + save now, then show the ffmpeg helper.
                this.downloadFrames().then(async () => {
                    await this.saveTimeline();
                    this.showFFmpegCommandDialog();
                });
            }
        } else {
            // Stop MediaRecorder and download video
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();

                this.mediaRecorder.onstop = () => {
                    this.downloadVideoFile();
                    this.mediaRecorder = null;
                    this.videoChunks = [];
                };
            } else {
                console.warn('MediaRecorder not available, no video to download');
            }
        }
    }

    /**
     * Restore renderer to its original state before recording started.
     * Handles pixel ratio, size, viewport, composer, camera, and canvas CSS.
     */
    private restoreRendererState(): void {
        console.log(`📹 STOP RECORDING (${this.recordingMode}) - Restoring original state:`, {
            originalSize: { x: this.originalSize.x, y: this.originalSize.y },
            originalPixelRatio: this.originalPixelRatio,
            originalViewport: this.originalViewport,
            currentWindowSize: { width: window.innerWidth, height: window.innerHeight },
            currentCanvasSize: { width: this.originalCanvas?.width, height: this.originalCanvas?.height },
            currentRendererSize: this.renderer.getSize(new THREE.Vector2())
        });

        // Set pixel ratio FIRST, then size (ensures correct canvas buffer size)
        this.renderer.setPixelRatio(this.originalPixelRatio);
        this.renderer.setSize(this.originalSize.x, this.originalSize.y, false);

        // Restore original viewport
        if (this.originalViewport) {
            this.renderer.setViewport(
                this.originalViewport.x,
                this.originalViewport.y,
                this.originalViewport.width,
                this.originalViewport.height
            );
        }

        // Restore composer size
        if (this.engine.composer) {
            this.engine.composer.setSize(this.originalSize.x, this.originalSize.y);
        }

        // Restore camera aspect ratio
        if (this.engine.camera instanceof THREE.PerspectiveCamera) {
            this.engine.camera.aspect = this.originalSize.x / this.originalSize.y;
            this.engine.camera.updateProjectionMatrix();
        }

        // Reset canvas CSS styles
        if (this.originalCanvas) {
            this.originalCanvas.style.width = '';
            this.originalCanvas.style.height = '';
            this.originalCanvas.style.transform = '';
            this.originalCanvas.style.transformOrigin = '';
            this.originalCanvas.style.position = '';
            this.originalCanvas.style.left = '';
            this.originalCanvas.style.top = '';
            this.originalCanvas.style.width = `${this.originalSize.x}px`;
            this.originalCanvas.style.height = `${this.originalSize.y}px`;
        }

        // Restore SparkRenderer LOD settings to pre-recording values
        const spark = (this.engine as any).sparkRenderer as { lodSplatCount?: number; lodSplatScale?: number } | undefined;
        if (spark && this.sparkOrigLodSplatScale !== undefined) {
            spark.lodSplatCount = this.sparkOrigLodSplatCount;
            spark.lodSplatScale = this.sparkOrigLodSplatScale;
            this.sparkOrigLodSplatCount = undefined;
            this.sparkOrigLodSplatScale = undefined;
        }

        // Force a render to ensure the restored state is visible. Through the
        // engine's own entry point, so this frame is composed exactly like a
        // gameplay one (post-FX chain, view-model overlay and all).
        if (this.engine.scene && this.engine.camera) {
            this.engine.renderFrameNow?.();
        }

        const restoredSize = this.renderer.getSize(new THREE.Vector2());
        const restoredViewport = new THREE.Vector4();
        this.renderer.getViewport(restoredViewport);
        console.log(`📹 STOP RECORDING (${this.recordingMode}) - After restoration:`, {
            restoredSize: { x: restoredSize.x, y: restoredSize.y },
            restoredPixelRatio: this.renderer.getPixelRatio(),
            restoredViewport: { x: restoredViewport.x, y: restoredViewport.y, width: restoredViewport.width, height: restoredViewport.height },
            canvasSize: { width: this.originalCanvas?.width, height: this.originalCanvas?.height }
        });

        // Free the reused capture canvas; already-queued frames keep their own
        // blob snapshots, so dropping the canvas now does not lose any frame.
        this.releaseCaptureCanvas();
    }
    
    private downloadVideoFile(): void {
        if (this.videoChunks.length === 0) {
            console.error('No video data available');
            this.showNotification('❌ Error', 'No video data recorded', 'red');
            return;
        }
        
        const videoBlob = new Blob(this.videoChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(videoBlob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.recordingName}.webm`;
        a.style.display = 'none';
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
        
        this.showNotification('✅ Video Downloaded', `Saved as ${this.recordingName}.webm`, 'green');
    }
    
    private showFFmpegCommandDialog(): void {
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.95);
            color: white;
            padding: 30px;
            border-radius: 12px;
            z-index: 10000;
            max-width: 900px;
            font-family: monospace;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        `;
        
        // The localhost dev path now writes frames into a per-recording
        // subfolder so successive recordings don't pile up in one directory.
        // The FS Access fallback path uses whatever folder the user picked,
        // but this command guides them at the canonical location.
        const downloadPath = this.recordingLocation();
        const inputPattern = `${downloadPath}/${this.recordingName}_%06d.png`;
        const outputFile = `${downloadPath}/${this.recordingName}.mp4`;
        
        const ffmpegCommand = `ffmpeg -framerate 60 -i "${inputPattern}" -c:v libx264 -crf 23 -pix_fmt yuv420p -preset medium -profile:v high "${outputFile}"`;
        
        dialog.innerHTML = `
            <h2 style="margin-top: 0; color: #4CAF50;">✅ Recording Complete (${this.recordingWidth}x${this.recordingHeight} @ 60fps)</h2>
            <p><strong>Frames captured:</strong> ${this.frameCount}</p>
            <p><strong>Duration:</strong> ${((Date.now() - this.recordingStartTime) / 1000).toFixed(1)}s</p>
            <p><strong>Resolution:</strong> ${this.recordingWidth}x${this.recordingHeight} (native render)</p>
            <p style="margin-top: 15px; color: #FFA500;">
                <strong>📁 Frames: ${downloadPath}/</strong><br>
                <span style="font-size: 11px;">Pattern: ${this.recordingName}_000000.png to ${this.recordingName}_${String(this.frameCount - 1).padStart(6, '0')}.png</span>
            </p>
            ${this.timelineSaved ? `
            <p style="margin-top: 15px; color: #7EC8FF;">
                <strong>🎞 Trailer:</strong> timeline.json saved alongside the frames.<br>
                <span style="font-size: 12px;">${this.host === 'cli'
                    ? 'Run <code style="color: #0f0;">bitmagic trailer make</code> — or ask your agent to make a trailer — to auto-cut a trailer with sound, or the raw ffmpeg command below for the full-length video.'
                    : 'Run <code style="color: #0f0;">/make-trailer</code> in Claude Code to auto-cut a trailer with sound, or the raw ffmpeg command below for the full-length video.'}</span>
            </p>` : ''}
            <p style="margin-top: 20px;"><strong>🎬 FFmpeg Command:</strong></p>
            <div style="
                background: #222;
                padding: 15px;
                border-radius: 6px;
                border: 1px solid #444;
                overflow-x: auto;
                margin: 10px 0;
                font-size: 11px;
            ">
                <code style="color: #0f0; white-space: pre-wrap; word-break: break-all;">${ffmpegCommand}</code>
            </div>
            <button id="copy-ffmpeg-btn" style="
                background: #4CAF50;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                margin-right: 10px;
                font-weight: bold;
            ">📋 Copy Command</button>
            <button id="close-dialog-btn" style="
                background: #666;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: bold;
            ">Close</button>
        `;
        
        document.body.appendChild(dialog);
        
        const copyBtn = document.getElementById('copy-ffmpeg-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(ffmpegCommand).then(() => {
                    copyBtn.textContent = '✅ Copied!';
                    setTimeout(() => {
                        copyBtn.textContent = '📋 Copy Command';
                    }, 2000);
                });
            });
        }
        
        const closeBtn = document.getElementById('close-dialog-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                document.body.removeChild(dialog);
            });
        }
    }
    
    private startRecording(): void {
        if (this.isRecording) return;

        // Store original renderer state BEFORE changing anything
        const currentSize = this.renderer.getSize(new THREE.Vector2());
        this.originalSize.copy(currentSize);
        this.originalPixelRatio = this.renderer.getPixelRatio();
        
        // Store original viewport
        const viewport = new THREE.Vector4();
        this.renderer.getViewport(viewport);
        this.originalViewport = {
            x: viewport.x,
            y: viewport.y,
            width: viewport.width,
            height: viewport.height
        };
        
        console.log('📹 START RECORDING - Storing original state:', {
            size: { x: this.originalSize.x, y: this.originalSize.y },
            pixelRatio: this.originalPixelRatio,
            viewport: this.originalViewport,
            windowSize: { width: window.innerWidth, height: window.innerHeight },
            canvasSize: { width: this.originalCanvas?.width, height: this.originalCanvas?.height }
        });

        this.isRecording = true;
        this.frames = [];
        this.frameCount = 0;
        this.recordingStartTime = Date.now();

        // Decide the capture sink up front. With a host-announced sink (the
        // bitmagic dev sidecar) or on localhost with the dev agent reachable,
        // stream every frame straight to disk (no in-memory buffer). Otherwise
        // fall back to buffering ImageData and saving at stop (FS-Access /
        // batched download), which keeps its prior behavior. The localhost
        // condition guards only the agent fallback — a host sink works wherever
        // the editor runs.
        this.streamingToDisk = this.recordingMode === 'frames'
            && (this.sinkUrl !== null || this.isHttpStream() || (isLocalhost() && !!getAgentUrl()));
        this.streamQueue = [];
        this.streamInflight.clear();
        this.streamActiveUploads = 0;
        this.streamSaved = 0;
        this.streamFailed = false;
        this.stream = null;

        // Force fixed 1/60s timestep on the engine (for frame-by-frame recording)
        if (this.recordingMode === 'frames') {
            this.engine.forceFixedDeltaTime = true;
            // Begin the trailer timeline session: from here on, GameEventLog
            // calls all over the engine/game code record against frameCount.
            getGameEventLog().startSession(() => this.frameCount, 'recorder');
            // HUDs are built at load, long before F9 — without this snapshot
            // the UI overlay would replay from an empty screen.
            this.engine.genreModule?.hud?.snapshotForRecording?.();
            this.pendingTimeline = null;
            this.timelineSaved = false;
            this.frameClock = [{ frame: 0, wallMs: 0 }];
            // Captured once at start; mid-recording window resizes are rare
            // enough not to track (and the HUD would have re-laid-out anyway).
            this.recordedWindow = {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio || 1,
            };
            this.recordingStartWallMs = performance.now();
            this.failedFrameIndices.clear();
            this.retryBlobs.clear();
            this.retryBytes = 0;
            this.lastFrameFailure = '';
            this.pendingEncodes = 0;
        }

        // Set renderer to recording resolution (shared by both modes)
        this.renderer.setSize(this.recordingWidth, this.recordingHeight);
        this.renderer.setPixelRatio(1);

        if (this.engine.composer) {
            this.engine.composer.setSize(this.recordingWidth, this.recordingHeight);
        }

        // Both modes render through the gameplay camera, so it carries the
        // recording aspect for the duration (restored in restoreRendererState).
        // Frames mode relies on this: it captures the engine's own render
        // rather than re-rendering, which is the only way the WebGPU post
        // pipeline (bloom, SSR, tone mapping) reaches the captured frames.
        if (this.engine.camera instanceof THREE.PerspectiveCamera) {
            this.engine.camera.aspect = this.recordingWidth / this.recordingHeight;
            this.engine.camera.updateProjectionMatrix();
        }

        this.scaleCanvasToWindow();

        if (this.recordingMode === 'video') {
            this.setupVideoCapture();
        }

        // Generate recording name with timestamp
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
        this.recordingName = `gameplay_recording_${timestamp}`;

        if (this.streamingToDisk && this.streamUrl !== null) this.openStream();
        
        // Maximize Gaussian Splat LOD quality: push lodSplatCount to the GPU memory
        // ceiling (maxPagedSplats) so the LOD system selects as many splats as possible.
        // This disables the normal quality-vs-performance trade-off during recording.
        const spark = (this.engine as any).sparkRenderer as { lodSplatCount?: number; lodSplatScale?: number; maxPagedSplats?: number } | undefined;
        if (spark) {
            this.sparkOrigLodSplatCount = spark.lodSplatCount;
            this.sparkOrigLodSplatScale = spark.lodSplatScale;
            spark.lodSplatCount = spark.maxPagedSplats ?? 16_777_216;
            spark.lodSplatScale = 1.0;
        }

        // Force activate all voxel colliders for recording
        if (this.engine.gaussianSplatRenderer) {
            const colliderEditor = this.engine.gaussianSplatRenderer.getColliderEditor();
            if (colliderEditor && colliderEditor.forceActivateAllVoxelColliders) {
                colliderEditor.forceActivateAllVoxelColliders();
            }
        }

        this.postState('started');

        // Check if camera path editor has markers and start path recording
        const cameraPathEditor = this.engine.getCameraPathEditor();
        if (cameraPathEditor && cameraPathEditor.getTotalPathDuration() > 0) {
            console.log('🎥 Starting camera path recording');
            cameraPathEditor.startRecordingPath(() => {
                console.log('🎥 Camera path recording complete, stopping screen recording');
                this.stopRecording();
            });
            this.showNotification(`🎥 Recording Camera Path (${this.recordingWidth}x${this.recordingHeight})`, `Duration: ${cameraPathEditor.getTotalPathDuration().toFixed(1)}s. Will auto-stop.`, 'green');
        } else {
            this.showNotification(`🎥 Recording Started (${this.recordingWidth}x${this.recordingHeight})`, 'Game scaled to fit window. Press F9 again to stop', 'green');
        }
        
        const modeText = this.recordingMode === 'frames' ? 'Frame-by-frame (60fps)' : 'Video capture (real-time)';
        console.log(`📹 Screen recording started: ${this.recordingName} - Mode: ${modeText}`);
    }
    
    private setupVideoCapture(): void {
        try {
            // Use the actual game canvas for video capture
            const canvas = this.renderer.domElement;
            
            // Create MediaRecorder from canvas stream
            let mimeType = 'video/webm;codecs=vp9';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'video/webm;codecs=vp8';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'video/webm';
                }
            }
            
            const stream = canvas.captureStream(); // Capture at canvas's natural frame rate
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: mimeType,
                videoBitsPerSecond: 10000000 // 10 Mbps
            });
            
            this.videoChunks = [];
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    this.videoChunks.push(event.data);
                }
            };
            
            this.mediaRecorder.onerror = (event) => {
                console.error('MediaRecorder error:', event);
            };
            
            // Start recording
            this.mediaRecorder.start(100); // Collect data every 100ms
            
            console.log('✓ Video capture started (real-time, no frame rate enforcement)');
        } catch (error) {
            console.error('Failed to setup video capture:', error);
            this.mediaRecorder = null;
        }
    }
    
    update(scene: THREE.Scene | null, camera: THREE.Camera | null): void {
        if (!this.isRecording || !scene || !camera) return;

        // Video capture mode needs nothing here — MediaRecorder grabs the
        // canvas on its own.
        if (this.recordingMode !== 'frames') return;

        // Re-render through the engine's SINGLE render entry point, then grab
        // the canvas. Never a local copy of its branching: this file used to
        // carry one, and when the WebGPU path moved to GameEnginePostFx's
        // RenderPipeline (leaving `engine.composer` null) the copy silently
        // fell through to a raw `renderer.render()` — every WebGPU recording
        // lost bloom, SSR, DOF, AO, outline and tone mapping. A copy today
        // would additionally drop the first-person view model. The gameplay
        // camera carries the recording aspect for the duration (see
        // startRecording), so driving the real pipeline is all that is needed.
        //
        // The render has to happen HERE rather than reusing the one in
        // animate(): capture is a canvas drawImage, and the canvas only reads
        // back reliably in the same task as the render that filled it —
        // skipping this yields blank frames on WebGPU.
        this.engine.renderFrameNow?.();

        // Exactly ONE frame per update(), which runs once per game-loop
        // iteration (the loop is pinned to a 1/60 s step while recording).
        this.captureFrameWithoutHUD();
    }
    
    shouldEnforceFixedFrameRate(): boolean {
        // Only enforce 1/60 deltaTime in frame-by-frame mode
        return this.isRecording && this.recordingMode === 'frames';
    }

    private scaleCanvasToWindow(): void {
        if (!this.originalCanvas) return;

        const canvas = this.originalCanvas;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        // Calculate scaling to fill window in at least one dimension
        const scaleX = windowWidth / this.recordingWidth;
        const scaleY = windowHeight / this.recordingHeight;
        const scale = Math.max(scaleX, scaleY); // Use largest scale to fill window

        const scaledWidth = this.recordingWidth * scale;
        const scaledHeight = this.recordingHeight * scale;

        // Center the scaled canvas in the window
        const offsetX = (windowWidth - scaledWidth) / 2;
        const offsetY = (windowHeight - scaledHeight) / 2;

        // Apply CSS scaling - use transform scale for crisp rendering
        canvas.style.width = `${this.recordingWidth}px`;
        canvas.style.height = `${this.recordingHeight}px`;
        canvas.style.transform = `scale(${scale})`;
        canvas.style.transformOrigin = '0 0';
        canvas.style.position = 'absolute';
        canvas.style.left = `${offsetX}px`;
        canvas.style.top = `${offsetY}px`;
    }
    
    private captureFrameWithoutHUD(): void {
        if (!this.originalCanvas) return;

        // Reuse one capture canvas across frames (see field comment).
        if (!this.captureCanvasEl
            || this.captureCanvasEl.width !== this.recordingWidth
            || this.captureCanvasEl.height !== this.recordingHeight) {
            this.captureCanvasEl = this.captureCanvasEl ?? document.createElement('canvas');
            this.captureCanvasEl.width = this.recordingWidth;
            this.captureCanvasEl.height = this.recordingHeight;
            // Read back every frame: the stream takes the pixels as a plain buffer (see RecordStream).
            this.captureCtx = this.captureCanvasEl.getContext('2d', { willReadFrequently: true });
        }
        const captureCanvas = this.captureCanvasEl;
        const captureContext = this.captureCtx;
        if (!captureContext) return;

        // Copy the main canvas content to capture canvas at recording resolution
        captureContext.drawImage(this.originalCanvas, 0, 0, this.recordingWidth, this.recordingHeight);

        const frameIndex = this.frameCount;
        this.frameCount++;

        // Once a second, map frame index -> wall clock for the timeline
        // manifest (diagnoses time dilation; enables audio-warp fallbacks).
        if (frameIndex > 0 && frameIndex % 60 === 0) {
            this.frameClock.push({ frame: frameIndex, wallMs: Math.round(performance.now() - this.recordingStartWallMs) });
        }

        if (this.streamingToDisk && this.stream !== null && this.stream.state === 'open') {
            // Read the pixels here (~5 ms at 1080p) and transfer them: a plain RGBA buffer is the
            // one input Chrome's encoders take at full speed (see RecordStream).
            const image = captureContext.getImageData(0, 0, this.recordingWidth, this.recordingHeight);
            this.stream.handFrame(frameIndex, image.data.buffer);
            if (this.frameCount % 60 === 0) this.postState('recording', { frameCount: this.frameCount });
        } else if (this.streamingToDisk) {
            // Snapshot to a PNG blob and POST it to disk. toBlob copies the canvas
            // bitmap at call time, so overwriting the canvas next frame is safe.
            // No getImageData, no buffer -> memory stays flat.
            this.pendingEncodes++;
            captureCanvas.toBlob((blob) => {
                if (!blob) {
                    this.pendingEncodes--;
                    this.streamFailed = true;
                    this.failedFrameIndices.add(frameIndex);
                    return;
                }
                // Out of blob storage and into the heap at once (see streamQueue); the Blob itself
                // is unreferenced from here on and collectable.
                blob.arrayBuffer().then((buffer) => {
                    this.pendingEncodes--;
                    this.streamQueue.push({ index: frameIndex, bytes: new Uint8Array(buffer) });
                    this.pumpStreamQueue();
                }, (err: unknown) => {
                    this.pendingEncodes--;
                    this.streamFailed = true;
                    this.failedFrameIndices.add(frameIndex);
                    this.lastFrameFailure = `arrayBuffer: ${err instanceof Error ? err.message : String(err)}`;
                });
            }, 'image/png');
        } else {
            // Non-localhost fallback: buffer ImageData, saved at stop.
            const imageData = captureContext.getImageData(0, 0, this.recordingWidth, this.recordingHeight);
            this.frames.push(imageData);
        }

        // Safety auto-stop for the buffered fallback only: ImageData piles up at
        // ~8MB/frame, so cap heap use. Streaming writes each frame straight to
        // disk and keeps memory flat, so it records with no frame limit.
        if (!this.streamingToDisk && this.frameCount >= 1500) {
            console.warn(`Recording auto-stopped at ${this.frameCount} frames (buffer memory limit)`);
            this.stopRecording();
            return;
        }

        // Show progress every 60 frames
        if (this.frameCount % 60 === 0) {
            console.log(`Recording: ${this.frameCount} frames captured`);
        }
    }

    /**
     * Drain the pending-frame queue, keeping at most STREAM_MAX_PARALLEL uploads
     * in flight. On localhost the POST drains faster than capture produces, so
     * the queue stays near-empty and memory stays flat.
     */
    private pumpStreamQueue(): void {
        while (this.streamActiveUploads < this.STREAM_MAX_PARALLEL && this.streamQueue.length > 0) {
            const item = this.streamQueue.shift();
            if (!item) break;
            this.streamActiveUploads++;
            const p = this.postFrame(item.index, item.bytes).finally(() => {
                this.streamActiveUploads--;
                this.streamInflight.delete(p);
                this.pumpStreamQueue();
            });
            this.streamInflight.add(p);
        }
    }

    private async postFrame(frameIndex: number, bytes: Uint8Array): Promise<void> {
        const ok = await this.postFrameOnce(frameIndex, bytes);
        if (ok) {
            this.streamSaved++;
            if (this.streamSaved % 60 === 0) {
                console.log(`Streamed ${this.streamSaved} frames to disk`);
            }
        } else {
            this.streamFailed = true;
            this.failedFrameIndices.add(frameIndex);
            // Keep failed blobs for the retry passes at drain, up to a byte budget; if the sink is
            // down entirely the recording is lost anyway, so don't buffer a whole session for it.
            if (this.retryBytes + bytes.byteLength <= this.RETRY_BUFFER_MAX_BYTES) {
                this.retryBlobs.set(frameIndex, bytes);
                this.retryBytes += bytes.byteLength;
            }
        }
    }

    /** One save-frame POST with no bookkeeping; returns whether it succeeded. */
    private async postFrameOnce(frameIndex: number, bytes: Uint8Array): Promise<boolean> {
        const baseUrl = this.getSinkUrl();
        if (!baseUrl) return false;
        let url = `${baseUrl}/api/dev/save-frame`;
        let body: BodyInit;
        let headers: Record<string, string> | undefined;
        if (this.rawFrames) {
            url += `?recordingName=${encodeURIComponent(this.recordingName)}&frameIndex=${frameIndex}`;
            // A Blob body, built here and dropped after the request — NOT the bytes directly. Chrome
            // uploads an ArrayBuffer body at ~6 requests/s no matter what (fetch or XHR, serialised),
            // while a Blob body is passed by reference and goes 15x faster. The Blob is fine to use
            // as long as it is short-lived: the 2 MB ArrayBuffer churn per frame keeps V8's GC busy,
            // and that GC is what releases each Blob's slot in blob storage.
            body = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
            headers = { 'Content-Type': 'application/octet-stream' };
        } else {
            // Legacy sink: multipart, with a Blob that lives only for this request.
            const form = new FormData();
            form.append('recordingName', this.recordingName);
            form.append('frameIndex', String(frameIndex));
            form.append('frame', new Blob([bytes as BlobPart], { type: 'image/png' }), `${this.recordingName}_${String(frameIndex).padStart(6, '0')}.png`);
            body = form;
        }
        try {
            const resp = await fetch(url, { method: 'POST', body, ...(headers ? { headers } : {}) });
            if (!resp.ok) {
                this.lastFrameFailure = `HTTP ${resp.status}`;
                console.warn(`[ScreenRecorder] dev save-frame ${frameIndex} returned ${resp.status}`);
                return false;
            }
            return true;
        } catch (err) {
            this.lastFrameFailure = err instanceof Error ? err.message : String(err);
            console.warn(`[ScreenRecorder] dev save-frame ${frameIndex} failed:`, err);
            return false;
        }
    }

    /**
     * Retry the failed frames after the main queue drained: sequentially, in up to RETRY_PASSES
     * passes with a short pause between them. Sequential because the failures that happen at all
     * happen under load — a stalled sink, a starved main thread — and the drain is the one moment
     * nothing else competes for it. A frame that is still missing after this is reported in the
     * manifest's missingFrames, and the renderer fills it from its neighbours.
     */
    private async retryFailedFrames(): Promise<void> {
        for (let pass = 1; pass <= this.RETRY_PASSES && this.retryBlobs.size > 0; pass++) {
            if (pass > 1) await new Promise((resolve) => setTimeout(resolve, 500 * pass));
            const retries = Array.from(this.retryBlobs.entries());
            let recovered = 0;
            for (const [index, blob] of retries) {
                if (await this.postFrameOnce(index, blob)) {
                    this.failedFrameIndices.delete(index);
                    this.retryBlobs.delete(index);
                    this.retryBytes -= blob.byteLength;
                    recovered++;
                }
            }
            console.log(`[ScreenRecorder] retry pass ${pass}: recovered ${recovered}/${retries.length} failed frames`);
        }
        this.retryBlobs.clear();
        this.retryBytes = 0;
        if (this.failedFrameIndices.size > 0) {
            console.warn(`[ScreenRecorder] ${this.failedFrameIndices.size} frame(s) could not be saved (last error: ${this.lastFrameFailure || 'unknown'})`);
        }
    }

    /** Wait for all pending encodes + queued + in-flight uploads (called at stop). */
    private async drainStreamQueue(): Promise<void> {
        this.pumpStreamQueue();
        while (this.pendingEncodes > 0 || this.streamInflight.size > 0 || this.streamQueue.length > 0) {
            if (this.streamInflight.size > 0) {
                await Promise.race(this.streamInflight);
            } else if (this.pendingEncodes > 0) {
                // Last frames may still be inside toBlob — poll until they land.
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            this.pumpStreamQueue();
        }
    }

    private async finishStreamingRecording(): Promise<void> {
        this.showNotification('Saving Frames...', `Flushing ${this.frameCount} frames to disk`, 'blue');
        if (this.stream !== null && this.stream.state === 'open') {
            const result = await this.stream.close(this.frameCount);
            for (const index of result.missing) this.failedFrameIndices.add(index);
            this.streamSaved = result.written - result.missing.length;
            if (result.error) console.warn(`[ScreenRecorder] frame stream: ${result.error}`);
        }
        await this.drainStreamQueue();
        await this.retryFailedFrames();
        if (this.failedFrameIndices.size > 0) {
            this.showNotification('Recording Saved With Errors', `${this.frameCount - this.failedFrameIndices.size}/${this.frameCount} frames written. Is the dev agent running?`, 'red');
        } else {
            console.log(`All ${this.streamSaved} frames streamed to ${this.recordingLocation()}/`);
        }
        await this.saveTimeline();
        if (!this.isHttpStream()) this.showFFmpegCommandDialog();
    }

    /**
     * Which post-processing path was live during the recording. `none` means
     * the frames are raw scene renders — no bloom, SSR, DOF, AO, outline, and
     * no tone mapping (OutputPass is the last stage of both chains).
     */
    private describeActivePostFx(): 'webgpu-pipeline' | 'webgl-composer' | 'none' {
        const eng = this.engine as unknown as { bloomPipeline?: unknown };
        if (eng.bloomPipeline) return 'webgpu-pipeline';
        if (this.engine.composer) return 'webgl-composer';
        return 'none';
    }

    /**
     * POST the frozen timeline session as timeline.json into the recording
     * folder (the host-announced sink, else the dev agent). Silent no-op when
     * there is no session or no sink; a failed POST only costs the trailer
     * tooling.
     */
    private async saveTimeline(): Promise<void> {
        const timeline = this.pendingTimeline;
        this.pendingTimeline = null;
        if (!timeline) return;
        const baseUrl = this.getSinkUrl();
        if (!baseUrl && !this.isHttpStream()) return;
        const gameData = this.engine.getGameData();
        const manifest = {
            version: 1,
            recording: {
                name: this.recordingName,
                gameId: gameData?.gameId,
                genre: gameData?.gameGenre,
                width: this.recordingWidth,
                height: this.recordingHeight,
                fps: 60,
                frameCount: this.frameCount,
                missingFrames: Array.from(this.failedFrameIndices).sort((a, b) => a - b),
                frameClock: this.frameClock,
                // Which backend produced these pixels, and whether a post
                // pipeline was live. Recorded because footage that silently
                // lost bloom/SSR/tone mapping is otherwise indistinguishable
                // from footage of a game that simply has those effects off.
                renderer: getActiveBackend(this.renderer),
                postProcessing: this.describeActivePostFx(),
                // How the frames left the tab (video intermediate or raw), when a stream carried them.
                ...(this.stream?.capture ? { capture: this.stream.capture } : {}),
                // Absent on recordings from before this field existed; the
                // trailer renderer then rasters HUD overlays at the recording
                // resolution, exactly as it always did.
                ...(this.recordedWindow !== null ? { window: this.recordedWindow } : {}),
            },
            events: timeline.events,
            sounds: timeline.sounds,
            music: timeline.music,
            hud: timeline.hud,
        };
        try {
            const timelineUrl = this.isHttpStream() && this.streamUrl !== null
                ? `${this.streamUrl.replace(/\/+$/, '')}/timeline?recordingName=${encodeURIComponent(this.recordingName)}`
                : `${baseUrl}/api/dev/save-recording-timeline`;
            const resp = await fetch(timelineUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recordingName: this.recordingName, timeline: manifest }),
            });
            if (resp.ok) {
                this.timelineSaved = true;
                console.log(`📊 Timeline saved: ${timeline.events.length} events, ${timeline.sounds.length} sounds, ${timeline.music.length} music, ${timeline.hud.length} HUD ops → ${this.recordingLocation()}/timeline.json`);
                this.postState('saved', { missingFrames: this.failedFrameIndices.size });
            } else {
                console.warn(`[ScreenRecorder] save-recording-timeline returned ${resp.status}`);
                this.postState('failed', { error: `save-recording-timeline returned ${resp.status}` });
            }
        } catch (err) {
            console.warn('[ScreenRecorder] save-recording-timeline failed:', err);
            this.postState('failed', { error: err instanceof Error ? err.message : String(err) });
        }
    }

    private releaseCaptureCanvas(): void {
        if (this.captureCanvasEl) {
            this.captureCanvasEl.width = 0;
            this.captureCanvasEl.height = 0;
            this.captureCanvasEl = null;
            this.captureCtx = null;
        }
    }

    /**
     * Localhost-only fast path: POST each captured frame to the dev agent
     * (`/api/dev/save-frame`), which writes it directly to disk under
     * ~/Downloads/<recordingName>/. Avoids the per-file browser download
     * (Chrome throttles those) and the directory picker (FS Access API).
     *
     * Encoding runs sequentially (see encodeBufferedFrame), but uploads overlap
     * with the next encode via background fetches with a concurrency cap — the
     * slow part is PNG compression, not the POST.
     *
     * Returns true if every frame uploaded; false if anything fails so the
     * caller can fall back.
     */
    private async uploadFramesToDevAgent(
        tempCanvas: HTMLCanvasElement,
        tempContext: CanvasRenderingContext2D,
    ): Promise<boolean> {
        const baseUrl = this.getSinkUrl();
        if (!baseUrl) return false;

        const inflight = new Set<Promise<unknown>>();
        const MAX_PARALLEL = 8;
        let saved = 0;
        let failed = false;

        const enqueue = (frameIndex: number, blob: Blob): void => {
            const form = new FormData();
            form.append('recordingName', this.recordingName);
            form.append('frameIndex', String(frameIndex));
            form.append('frame', blob, `${this.recordingName}_${String(frameIndex).padStart(6, '0')}.png`);
            const p = fetch(`${baseUrl}/api/dev/save-frame`, { method: 'POST', body: form })
                .then((resp) => {
                    if (!resp.ok) {
                        failed = true;
                        console.warn(`[ScreenRecorder] dev save-frame ${frameIndex} returned ${resp.status}`);
                    } else {
                        saved++;
                        if (saved % 60 === 0) {
                            console.log(`📥 Saved ${saved}/${this.frames.length} frames (dev path)`);
                        }
                    }
                })
                .catch((err) => {
                    failed = true;
                    console.warn(`[ScreenRecorder] dev save-frame ${frameIndex} failed:`, err);
                })
                .finally(() => {
                    inflight.delete(p);
                });
            inflight.add(p);
        };

        for (const [i, frame] of this.frames.entries()) {
            if (failed) break;
            const blob = await this.encodeBufferedFrame(frame, tempCanvas, tempContext);
            if (!blob) continue;
            enqueue(i, blob);
            if (inflight.size >= MAX_PARALLEL) {
                await Promise.race(inflight);
            }
        }
        await Promise.all(inflight);

        if (failed) {
            console.warn(`[ScreenRecorder] dev path failed (${saved}/${this.frames.length} saved); falling back to browser save`);
            return false;
        }
        console.log(`✅ All ${this.frames.length} frames saved via dev agent → ~/Downloads/${this.recordingName}/`);
        return true;
    }

    /**
     * Draw one buffered frame onto the shared temp canvas and encode it as a PNG.
     *
     * Callers await this one at a time on purpose: every frame goes through the same canvas, so a
     * second encode started before this one finished would read a bitmap already overwritten.
     */
    private encodeBufferedFrame(
        frame: ImageData,
        canvas: HTMLCanvasElement,
        context: CanvasRenderingContext2D,
    ): Promise<Blob | null> {
        context.putImageData(frame, 0, 0);
        return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    }

    /**
     * Where this recording's files are, as the host would say it: the project-relative folder the
     * `bitmagic dev` sidecar announced, else the web lane's ~/Downloads. The browser doesn't expose
     * `~`, so the fallback is a hand-rolled hint that is accurate on the typical localhost setup.
     */
    private recordingLocation(): string {
        if (this.isHttpStream()) return `the Creator's server (${this.recordingName})`;
        const base = this.host === 'cli' && this.recordingsDir ? this.recordingsDir : '~/Downloads';
        return `${base}/${this.recordingName}`;
    }

    private async downloadFrames(): Promise<void> {
        this.showNotification('💾 Saving Frames...', `Saving ${this.frames.length} frames as PNG`, 'blue');
        console.log(`📥 Saving ${this.frames.length} frames...`);

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.recordingWidth;
        tempCanvas.height = this.recordingHeight;
        const tempContext = tempCanvas.getContext('2d');
        if (!tempContext) {
            console.error('Failed to create temp canvas context');
            return;
        }

        // Localhost fast path — POST each frame to the dev agent which writes
        // it straight to ~/Downloads/<recordingName>/. No directory picker, no
        // browser download throttling. Skipped on production hosts (the
        // endpoint returns 404 there anyway).
        if (isLocalhost()) {
            const ok = await this.uploadFramesToDevAgent(tempCanvas, tempContext);
            if (ok) {
                tempCanvas.remove();
                return;
            }
            // fall through to FS API / batched download on failure
        }

        // Try File System Access API first (Chrome/Edge) — writes directly to disk, no throttling
        const fsApiAvailable = 'showDirectoryPicker' in window;
        if (fsApiAvailable) {
            try {
                const dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
                for (const [i, frame] of this.frames.entries()) {
                    const blob = await this.encodeBufferedFrame(frame, tempCanvas, tempContext);
                    if (blob) {
                        const paddedIndex = String(i).padStart(6, '0');
                        const fileHandle = await dirHandle.getFileHandle(
                            `${this.recordingName}_${paddedIndex}.png`,
                            { create: true }
                        );
                        const writable = await fileHandle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                    }
                    if ((i + 1) % 60 === 0) {
                        console.log(`📥 Saved ${i + 1}/${this.frames.length} frames`);
                    }
                }
                console.log(`✅ All ${this.frames.length} frames saved to folder`);
                tempCanvas.remove();
                return;
            } catch (err) {
                // User cancelled picker or API error — fall through to batched download
                if ((err as DOMException)?.name === 'AbortError') {
                    console.log('📁 Folder picker cancelled, falling back to batched download');
                } else {
                    console.warn('File System Access API failed, falling back to batched download:', err);
                }
            }
        }

        // Fallback: batched downloads (for Firefox/Safari or if folder picker was cancelled)
        // Chrome throttles rapid a.click() downloads — use batches of 8 with pauses
        const BATCH_SIZE = 8;
        const BATCH_DELAY_MS = 2000;

        for (const [i, frame] of this.frames.entries()) {
            const blob = await this.encodeBufferedFrame(frame, tempCanvas, tempContext);
            if (blob) {
                const url = URL.createObjectURL(blob);
                const paddedIndex = String(i).padStart(6, '0');
                const a = document.createElement('a');
                a.href = url;
                a.download = `${this.recordingName}_${paddedIndex}.png`;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            // Pause between batches to avoid Chrome download throttling
            if ((i + 1) % BATCH_SIZE === 0) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }

            if ((i + 1) % 60 === 0) {
                console.log(`📥 Downloaded ${i + 1}/${this.frames.length} frames`);
            }
        }

        console.log(`✅ Download complete: ${this.frames.length} frames`);
        tempCanvas.remove();
    }

    private showNotification(title: string, message: string, color: string): void {
        const notification = document.createElement('div');
        const bgColor = color === 'green' ? 'rgba(76, 175, 80, 0.95)' : 
                         color === 'blue' ? 'rgba(33, 150, 243, 0.95)' : 
                         'rgba(244, 67, 54, 0.95)';
        
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${bgColor};
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            font-family: Arial, sans-serif;
            font-size: 14px;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
        
        notification.innerHTML = `
            <strong>${title}</strong><br>
            <span style="font-size: 12px;">${message}</span>
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 3000);
    }
    
    isCurrentlyRecording(): boolean {
        return this.isRecording;
    }
    
    dispose(): void {
        document.removeEventListener('keydown', this.boundKeyDown);
        window.removeEventListener('message', this.boundMessage);
        this.frames = [];
        this.streamQueue = [];
        this.streamInflight.clear();
        this.releaseCaptureCanvas();
        this.engine.forceFixedDeltaTime = false;
        // Recorder torn down mid-recording (e.g. renderer recreate): the
        // timeline session must not outlive its frame provider. Owner-gated,
        // so a passive eventlog session is untouched.
        if (getGameEventLog().isActive()) {
            getGameEventLog().endSession('recorder');
        }
        this.retryBlobs.clear();

        // Restore original renderer state if still recording (shouldn't happen, but safety)
        if (this.isRecording) {
            this.renderer.setSize(this.originalSize.width, this.originalSize.height);
            this.renderer.setPixelRatio(this.originalPixelRatio);
            if (this.originalCanvas) {
                this.originalCanvas.style.width = '';
                this.originalCanvas.style.height = '';
                this.originalCanvas.style.transform = '';
                this.originalCanvas.style.transformOrigin = '';
                this.originalCanvas.style.position = '';
                this.originalCanvas.style.left = '';
                this.originalCanvas.style.top = '';
            }
        }
    }
}

