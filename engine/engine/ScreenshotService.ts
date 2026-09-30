/**
 * ScreenshotService — Runtime screenshot capture + upload for game template code.
 *
 * Templates call `engine.getScreenshotService().captureAndUpload()` to grab a
 * frame and ship it to GCS via game-server's sign endpoint. Output is always
 * WebP at quality 0.8 (good fidelity at ~25–35% smaller than equivalent JPEG;
 * universal browser support).
 *
 * Two capture paths:
 *  - `camera: null` (default) — render the live game camera to the live canvas
 *    and grab `toBlob`. Fast path used by the existing iframe screenshot flow.
 *  - `camera: { kind: 'topdown'|'isometric'|'orbit'|'custom', ... }` — build a
 *    camera via `ScreenshotCameras`, render off-screen via `OffscreenRender`,
 *    and upload. The live canvas is never touched, so the player's view does
 *    not flicker.
 *
 * @example
 * // Use the live game camera (default).
 * const { url } = await engine.getScreenshotService().captureAndUpload();
 *
 * @example
 * // Top-down shot of the entire playable area.
 * const { url } = await engine.getScreenshotService().captureAndUpload({
 *     camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null },
 * });
 *
 * @example
 * // Orbit around the player.
 * const { url } = await engine.getScreenshotService().captureAndUpload({
 *     camera: { kind: 'orbit', target: null, distance: 6, azimuth: 0.7, pitch: 0.4 },
 * });
 */

import * as THREE from 'three';
import { AI_CHAT_URL } from 'engine/config.js';
import type { GameEngine } from 'engine/GameEngine.js';
import {
    buildTopdownCamera,
    buildIsometricCamera,
    buildOrbitCamera,
    type TopdownSpec,
    type IsometricSpec,
    type OrbitSpec,
} from 'engine/ScreenshotCameras.js';
import { renderToWebpBlob } from 'engine/OffscreenRender.js';

const SCREENSHOT_CONTENT_TYPE = 'image/webp';
const SCREENSHOT_QUALITY = 0.8;

export type CameraSpec =
    | TopdownSpec
    | IsometricSpec
    | OrbitSpec
    | { kind: 'custom'; camera: THREE.Camera };

export interface ScreenshotUploadOptions {
    /** Filename hint stored in the GCS key. `null` lets the server pick a timestamp-based name. */
    filename: string | null;
    /** Custom-camera spec. `null` = render the live game view (current behavior). */
    camera: CameraSpec | null;
    /** Output width in pixels. `null` = match the renderer's drawing-buffer width. */
    width: number | null;
    /** Output height in pixels. `null` = match the renderer's drawing-buffer height. */
    height: number | null;
}

export const DEFAULT_SCREENSHOT_UPLOAD_OPTIONS: ScreenshotUploadOptions = {
    filename: null,
    camera: null,
    width: null,
    height: null,
};

export interface ScreenshotUploadResult {
    /** Public CDN URL of the uploaded screenshot. */
    url: string;
    /** Storage key (`games/<gameId>/uploads/...`). */
    key: string;
}

/**
 * The size an unsized capture should come out at.
 *
 * The drawing buffer alone is the wrong answer once a quality tier can render BELOW the
 * display: at a 0.75 pixel ratio it is 0.75x the CSS viewport, so every screenshot taken
 * on a rescue-rung device would be silently three-quarter-sized — and a project with no
 * cover art publishes its captured screenshot as the game's thumbnail. Taking the larger
 * of the two means a low render scale costs sharpness, which is what the player already
 * accepted, and never costs DIMENSIONS, which nobody asked for.
 *
 * Above ratio 1 the drawing buffer is the larger of the two and wins, so a Retina capture
 * keeps its full resolution exactly as before.
 */
function captureSize(renderer: THREE.WebGLRenderer): { x: number; y: number } {
    const buffer = new THREE.Vector2();
    renderer.getDrawingBufferSize(buffer);
    const css = new THREE.Vector2();
    renderer.getSize(css);
    return { x: Math.max(buffer.x, css.x), y: Math.max(buffer.y, css.y) };
}

/**
 * Decide the output dimensions for a screenshot capture.
 *
 * - Explicit `width` AND `height` are always honored.
 * - For `fitLevel: true` topdown/isometric presets with both dims null,
 *   match the output aspect to the world aspect so the level frames tightly
 *   instead of leaving sky padding on the long axis. The longer side is capped
 *   at `max(canvasSize.x, canvasSize.y)`.
 * - Otherwise, any null dim falls back to the matching canvas dim (today's behavior).
 *
 * Exported for unit testing; not part of the public API.
 */
export function resolveOutputSize(
    opts: ScreenshotUploadOptions,
    canvasSize: { x: number; y: number },
    worldAspect: number | null,
): { width: number; height: number } {
    if (opts.width !== null && opts.height !== null) {
        return { width: opts.width, height: opts.height };
    }

    const spec = opts.camera;
    const fitsLevel =
        spec !== null &&
        (spec.kind === 'topdown' || spec.kind === 'isometric') &&
        spec.fitLevel;

    if (fitsLevel && opts.width === null && opts.height === null && worldAspect !== null && worldAspect > 0) {
        const cap = Math.max(canvasSize.x, canvasSize.y);
        if (worldAspect >= 1) {
            return { width: cap, height: Math.max(1, Math.round(cap / worldAspect)) };
        }
        return { width: Math.max(1, Math.round(cap * worldAspect)), height: cap };
    }

    return {
        width: opts.width ?? canvasSize.x,
        height: opts.height ?? canvasSize.y,
    };
}

export class ScreenshotService {
    private static instance: ScreenshotService | null = null;
    private readonly baseUrl: string = AI_CHAT_URL;
    private gameId: string = '';
    private engine: GameEngine | null = null;

    private constructor() {}

    static getInstance(): ScreenshotService {
        if (!ScreenshotService.instance) {
            ScreenshotService.instance = new ScreenshotService();
        }
        return ScreenshotService.instance;
    }

    /** @internal — called by GameEngine when a game loads. */
    configure(engine: GameEngine, gameId: string): void {
        this.engine = engine;
        this.gameId = gameId;
    }

    /**
     * Capture the current frame and upload it. Resolves with the public URL.
     * See class-level JSDoc for camera-spec examples.
     */
    async captureAndUpload(opts?: Partial<ScreenshotUploadOptions>): Promise<ScreenshotUploadResult> {
        const merged: ScreenshotUploadOptions = { ...DEFAULT_SCREENSHOT_UPLOAD_OPTIONS, ...opts };
        return this.uploadBlob(await this.capture(merged), merged);
    }

    /**
     * Capture a frame as a WebP blob WITHOUT uploading it — for callers that compose
     * several captures into one image (the agent's `look` contact sheet) before
     * handing the result to {@link upload}. `filename` is ignored here.
     */
    async capture(opts?: Partial<ScreenshotUploadOptions>): Promise<Blob> {
        const merged: ScreenshotUploadOptions = { ...DEFAULT_SCREENSHOT_UPLOAD_OPTIONS, ...opts };
        return merged.camera === null
            ? this.captureLiveCanvas()
            : this.captureWithCamera(merged);
    }

    /** Upload an already-captured WebP blob. `filename` as in {@link ScreenshotUploadOptions}. */
    async upload(blob: Blob, filename: string | null): Promise<ScreenshotUploadResult> {
        return this.uploadBlob(blob, { ...DEFAULT_SCREENSHOT_UPLOAD_OPTIONS, filename });
    }

    private async captureLiveCanvas(): Promise<Blob> {
        if (!this.engine) {
            throw new Error('ScreenshotService not configured — no GameEngine reference');
        }
        const { renderer, scene, camera } = this.engine;
        if (!renderer || !scene || !camera) {
            throw new Error('Cannot capture screenshot — renderer/scene/camera not initialized');
        }

        // A quality tier that renders below the display makes the live canvas smaller than
        // the viewport, and `toBlob` would hand back that smaller image — a three-quarter
        // -sized thumbnail on a rescue-rung device. Render the same view off-screen at the
        // viewport's own size instead: still exactly what the player is looking at, just
        // not also inheriting the render scale as an output dimension.
        if (renderer.getPixelRatio() < 1) {
            const size = captureSize(renderer);
            return renderToWebpBlob(renderer, scene, camera, size.x, size.y, SCREENSHOT_QUALITY);
        }

        // Re-render so the back buffer has fresh contents at read time. Required
        // because the WebGL context is created with `preserveDrawingBuffer: false`
        // outside the creator iframe.
        renderer.render(scene, camera);

        const canvas = renderer.domElement;
        const blob = await new Promise<Blob | null>(resolve => {
            canvas.toBlob(resolve, SCREENSHOT_CONTENT_TYPE, SCREENSHOT_QUALITY);
        });
        if (!blob) {
            throw new Error('canvas.toBlob returned null');
        }
        return blob;
    }

    private async captureWithCamera(opts: ScreenshotUploadOptions): Promise<Blob> {
        if (!this.engine) {
            throw new Error('ScreenshotService not configured — no GameEngine reference');
        }
        const { renderer, scene } = this.engine;
        if (!renderer || !scene) {
            throw new Error('Cannot capture screenshot — renderer/scene not initialized');
        }
        if (opts.camera === null) {
            throw new Error('captureWithCamera called with null camera spec'); // unreachable
        }

        const { width, height } = resolveOutputSize(opts, captureSize(renderer), this.getWorldAspect());
        const aspect = width / height;

        const camera = this.resolveCamera(opts.camera, aspect);
        // A fresh camera sees layer 0 only, but block characters (the player and
        // block NPCs) render on layer 1 — see CharacterLoader.applyBlockPartMaterial.
        // Preset shots see what the live camera sees; a custom camera keeps the
        // layers its caller chose.
        if (opts.camera.kind !== 'custom' && this.engine.camera) {
            camera.layers.mask = this.engine.camera.layers.mask;
        }
        return renderToWebpBlob(renderer, scene, camera, width, height, SCREENSHOT_QUALITY);
    }

    private getWorldAspect(): number | null {
        const wpd = this.engine?.getGameData()?.worldProfileData;
        const x = wpd?.groundWorldSizeX;
        const z = wpd?.groundWorldSizeZ;
        if (x == null || z == null || z === 0) {
            return null;
        }
        return x / z;
    }

    private resolveCamera(spec: CameraSpec, aspect: number): THREE.Camera {
        if (spec.kind === 'custom') {
            return spec.camera;
        }
        const gameData = this.engine?.getGameData();
        if (!gameData) {
            throw new Error('Preset camera requires loaded game data');
        }
        switch (spec.kind) {
            case 'topdown':
                return buildTopdownCamera(gameData, spec, aspect);
            case 'isometric':
                return buildIsometricCamera(gameData, spec, aspect);
            case 'orbit': {
                // Player fallback lives here; buildOrbitCamera stays pure and
                // receives a pre-resolved target (or null → throw).
                const resolvedTarget = spec.target
                    ?? this.engine?.getPlayerController()?.getPlayerObject?.()
                    ?? null;
                return buildOrbitCamera(resolvedTarget, spec, aspect);
            }
        }
    }

    private async uploadBlob(blob: Blob, opts: ScreenshotUploadOptions): Promise<ScreenshotUploadResult> {
        if (!this.gameId) {
            throw new Error('ScreenshotService not configured — no gameId');
        }

        const signResponse = await fetch(`${this.baseUrl}/api/screenshot-upload-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                gameId: this.gameId,
                contentType: SCREENSHOT_CONTENT_TYPE,
                filename: opts.filename,
            }),
        });
        if (!signResponse.ok) {
            const errBody = await signResponse.text().catch(() => 'unknown error');
            throw new Error(`Screenshot upload-url request failed (${signResponse.status}): ${errBody}`);
        }
        const { signedUrl, publicUrl, cacheControl, key } = await signResponse.json() as {
            signedUrl: string;
            publicUrl: string;
            cacheControl: string;
            key: string;
        };

        const putHeaders: Record<string, string> = { 'Content-Type': SCREENSHOT_CONTENT_TYPE };
        if (cacheControl) putHeaders['Cache-Control'] = cacheControl;

        const putResponse = await fetch(signedUrl, {
            method: 'PUT',
            headers: putHeaders,
            body: blob,
        });
        if (!putResponse.ok) {
            const errBody = await putResponse.text().catch(() => 'unknown error');
            throw new Error(`Screenshot upload failed (${putResponse.status}): ${errBody}`);
        }

        return { url: publicUrl, key };
    }
}
