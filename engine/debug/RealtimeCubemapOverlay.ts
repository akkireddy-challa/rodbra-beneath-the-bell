/**
 * Real-time 6-face cubemap overlay. Renders the voxel proxy scene as a
 * colour cubemap from the live camera's current position every ~250 ms
 * and displays it as a translucent strip across the top of the screen,
 * so the user can directly compare what the PVS bake "sees" against
 * what the main camera is rendering. Pure debugging aid — turns off
 * when toggled off; consumes GPU time while active.
 *
 * Why it's interactive: pressing "Sample at camera" gives a one-shot
 * PNG that's hard to align mentally with the live view. A live overlay
 * makes mismatches obvious — if a chunk visible on the main camera
 * doesn't appear in any cube face from the same position, the bake is
 * broken at proxy build / camera setup, not at tile encoding.
 */
import * as THREE from 'three';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { VisibilityTileGrid } from './VisibilityTileGrid.js';
import { WalkableMapGpuBaker } from './WalkableMapGpuBaker.js';

const FACE_LABELS = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
const FACE_RES = 128;
const TICK_MS = 250;

export class RealtimeCubemapOverlay {
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private overlayCanvas: HTMLCanvasElement | null = null;
    private overlayCtx: CanvasRenderingContext2D | null = null;
    private baker: WalkableMapGpuBaker | null = null;
    private busy = false;

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly getCamera: () => THREE.Camera,
        private readonly getWorld: () => VoxelWorld | null,
    ) {}

    isEnabled(): boolean { return this.intervalId !== null; }

    enable(): void {
        if (this.intervalId !== null) return;
        // Six faces side-by-side, plus a 12 px header for axis labels.
        const width = FACE_RES * 6;
        const height = FACE_RES + 12;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.style.cssText = `
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            pointer-events: none;
            z-index: 9999;
            border: 1px solid #ff4060;
            background: rgba(0, 0, 0, 0.7);
            image-rendering: pixelated;
        `;
        document.body.appendChild(canvas);
        this.overlayCanvas = canvas;
        this.overlayCtx = canvas.getContext('2d');
        this.baker = new WalkableMapGpuBaker();
        this.baker.setRenderer(this.renderer);
        // Kick off the first tick immediately so the user sees something
        // before the first 250 ms elapses.
        void this.tick();
        this.intervalId = setInterval(() => { void this.tick(); }, TICK_MS);
    }

    disable(): void {
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.overlayCanvas && this.overlayCanvas.parentNode) {
            this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
        }
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.baker?.dispose();
        this.baker = null;
    }

    private async tick(): Promise<void> {
        if (this.busy) return; // skip if previous tick still rendering
        if (!this.baker || !this.overlayCtx || !this.overlayCanvas) return;
        const world = this.getWorld();
        if (!world) return;
        const camera = this.getCamera();
        const camPos = (camera as THREE.PerspectiveCamera).position;
        const tileGrid = new VisibilityTileGrid({
            minX: camPos.x, minY: camPos.y, minZ: camPos.z,
            maxX: camPos.x, maxY: camPos.y, maxZ: camPos.z,
        }, 2);
        this.busy = true;
        try {
            const buf = await this.baker.bakeColorAtlas({
                world, tileGrid, eyeX: camPos.x, eyeY: camPos.y, eyeZ: camPos.z,
                faceResolution: FACE_RES,
            });
            this.drawAtlas(buf);
        } catch (err) {
            console.warn('[cubemap-overlay] tick failed:', err);
        } finally {
            this.busy = false;
        }
    }

    private drawAtlas(buf: Uint8Array): void {
        if (!this.overlayCtx || !this.overlayCanvas) return;
        const ctx = this.overlayCtx;
        const width = this.overlayCanvas.width;
        const headerH = 12;
        // Render the 6-face strip below the header. Y-flip from WebGL.
        const img = ctx.createImageData(width, FACE_RES);
        for (let y = 0; y < FACE_RES; y++) {
            const srcRow = (FACE_RES - 1 - y) * width * 4;
            const dstRow = y * width * 4;
            for (let i = 0; i < width * 4; i++) img.data[dstRow + i] = buf[srcRow + i]!;
        }
        ctx.putImageData(img, 0, headerH);
        // Header: face labels + dividers + camera info.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(0, 0, width, headerH);
        ctx.fillStyle = '#ffcc40';
        ctx.font = 'bold 10px monospace';
        ctx.textBaseline = 'middle';
        for (let f = 0; f < 6; f++) {
            ctx.fillText(FACE_LABELS[f]!, f * FACE_RES + 6, headerH / 2);
        }
        // Red dividers between faces.
        ctx.fillStyle = '#ff4060';
        for (let f = 1; f < 6; f++) {
            ctx.fillRect(f * FACE_RES, 0, 1, FACE_RES + headerH);
        }
    }
}
