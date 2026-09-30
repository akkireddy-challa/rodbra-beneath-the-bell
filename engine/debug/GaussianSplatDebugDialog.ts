// Type checking enabled
import * as THREE from 'three';
import type { PointerLockManager } from 'engine/PointerLockManager.js';

// Minimal shape of SparkRenderer properties we read/write
interface SparkLodControls {
    lodSplatScale: number;
    maxPagedSplats: number;
    lodRenderScale: number;
    /** Setting to true forces the LOD worker to re-evaluate on the next frame. */
    lodDirty: boolean;
}

interface SliderDef {
    label: string;
    min: number;
    max: number;
    step: number;
    get: (spark: SparkLodControls, cam: THREE.PerspectiveCamera | null) => number;
    set: (v: number, spark: SparkLodControls, cam: THREE.PerspectiveCamera | null) => void;
    format: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
    {
        label: 'LOD splat scale',
        min: 0.25, max: 8, step: 0.25,
        get: (s) => s.lodSplatScale,
        set: (v, s) => { s.lodSplatScale = v; },
        format: (v) => `${v.toFixed(2)}×`,
    },
    {
        label: 'Max paged splats',
        // slider value = page count; 1 page = 65 536 splats
        min: 64, max: 4096, step: 64,
        get: (s) => Math.round(s.maxPagedSplats / 65536),
        set: (v, s) => { s.maxPagedSplats = v * 65536; },
        format: (v) => `${(v * 65536 / 1_000_000).toFixed(0)} M splats`,
    },
    {
        label: 'LOD render scale',
        min: 0.25, max: 4, step: 0.25,
        get: (s) => s.lodRenderScale,
        set: (v, s) => { s.lodRenderScale = v; },
        format: (v) => `${v.toFixed(2)}×`,
    },
    {
        label: 'Draw distance',
        min: 10, max: 500, step: 10,
        get: (_s, cam) => Math.round(cam?.far ?? 300),
        set: (v, s, cam) => {
            if (cam) { cam.far = v; cam.updateProjectionMatrix(); }
            // Force the LOD worker to re-evaluate so it stops serving pages beyond the new distance.
            s.lodDirty = true;
        },
        format: (v) => `${v} m`,
    },
];

/**
 * Gaussian Splat tuning dialog.
 * - Press B (localhost only, only when SparkJS is active) to toggle.
 * - Releases pointer lock while open; game keeps running so changes are visible live.
 */
export class GaussianSplatDebugDialog {
    private backdrop: HTMLDivElement | null = null;
    private isOpen: boolean = false;

    private readonly sparkProvider: () => SparkLodControls | null;
    private readonly cameraProvider: () => THREE.PerspectiveCamera | null;
    private readonly plmProvider: () => PointerLockManager | null;
    private readonly boundKeyDown: (e: KeyboardEvent) => void;

    private static readonly isLocalhost =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1';

    constructor(opts: {
        sparkProvider: () => SparkLodControls | null;
        cameraProvider: () => THREE.PerspectiveCamera | null;
        pointerLockManagerProvider: () => PointerLockManager | null;
    }) {
        this.sparkProvider = opts.sparkProvider;
        this.cameraProvider = opts.cameraProvider;
        this.plmProvider = opts.pointerLockManagerProvider;

        this.boundKeyDown = (e: KeyboardEvent) => {
            if (e.code !== 'KeyB') return;
            if (!GaussianSplatDebugDialog.isLocalhost) return;
            if (!this.sparkProvider()) return;
            e.preventDefault();
            this.toggle();
        };
        document.addEventListener('keydown', this.boundKeyDown);
    }

    isDialogOpen(): boolean { return this.isOpen; }

    toggle(): void { this.isOpen ? this.close() : this.open(); }

    open(): void {
        if (this.isOpen) return;
        const spark = this.sparkProvider();
        if (!spark) return;

        // Release mouse — set interactiveUIMode first so the pointer-lock overlay
        // doesn't flash when the lock is released.
        const plm = this.plmProvider();
        if (plm) {
            plm.setInteractiveUIMode(true);
            plm.exitLock();
        } else {
            document.exitPointerLock?.();
        }

        this.isOpen = true;
        this.buildDialog(spark);
    }

    close(): void {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (this.backdrop?.parentNode) {
            this.backdrop.parentNode.removeChild(this.backdrop);
        }
        this.backdrop = null;
        // Restore pointer-lock overlay so the user can click to resume
        this.plmProvider()?.setInteractiveUIMode(false);
    }

    dispose(): void {
        document.removeEventListener('keydown', this.boundKeyDown);
        this.close();
    }

    // ── Dialog construction ───────────────────────────────────────────────────

    private buildDialog(spark: SparkLodControls): void {
        const cam = this.cameraProvider();

        this.backdrop = document.createElement('div');
        this.backdrop.style.cssText = `
            position: fixed;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10500;
            pointer-events: none;
        `;

        const panel = document.createElement('div');
        panel.style.cssText = `
            background: rgba(10, 12, 18, 0.93);
            border: 1px solid rgba(147, 197, 253, 0.3);
            border-radius: 12px;
            padding: 24px 28px;
            width: 440px;
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            box-shadow: 0 24px 64px rgba(0,0,0,0.7);
            pointer-events: auto;
            backdrop-filter: blur(12px);
        `;

        // ── Header ──
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;';

        const titleWrap = document.createElement('div');
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size: 15px; font-weight: 700; color: #93c5fd; letter-spacing: 0.03em;';
        titleEl.textContent = '✦ Gaussian Splat Tuning';
        const subtitleEl = document.createElement('div');
        subtitleEl.style.cssText = 'font-size: 11px; opacity: 0.5; margin-top: 2px;';
        subtitleEl.textContent = 'Game runs live — changes apply instantly';
        titleWrap.appendChild(titleEl);
        titleWrap.appendChild(subtitleEl);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: rgba(255,255,255,0.08); border: none; color: white;
            font-size: 16px; width: 28px; height: 28px; border-radius: 6px;
            cursor: pointer; flex-shrink: 0;
        `;
        closeBtn.addEventListener('click', () => this.close());

        header.appendChild(titleWrap);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // ── Sliders ──
        for (const def of SLIDERS) {
            panel.appendChild(this.buildSlider(def, spark, cam));
        }

        // ── Footer ──
        const footer = document.createElement('div');
        footer.style.cssText = 'margin-top: 18px; font-size: 11px; opacity: 0.4; text-align: center;';
        footer.textContent = 'Press B to close · click the game to re-engage mouse';
        panel.appendChild(footer);

        this.backdrop.appendChild(panel);
        document.body.appendChild(this.backdrop);
    }

    private buildSlider(def: SliderDef, spark: SparkLodControls, cam: THREE.PerspectiveCamera | null): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-bottom: 16px;';

        const labelRow = document.createElement('div');
        labelRow.style.cssText = 'display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px;';

        const labelEl = document.createElement('span');
        labelEl.style.cssText = 'font-size: 13px; opacity: 0.85;';
        labelEl.textContent = def.label;

        const valueEl = document.createElement('span');
        valueEl.style.cssText = 'font-size: 13px; font-family: "Monaco","Menlo",monospace; color: #fde68a; min-width: 90px; text-align: right;';
        valueEl.textContent = def.format(def.get(spark, cam));

        labelRow.appendChild(labelEl);
        labelRow.appendChild(valueEl);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(def.get(spark, cam));
        input.style.cssText = 'width: 100%; cursor: pointer; accent-color: #93c5fd; height: 4px;';

        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            const liveSpark = this.sparkProvider();
            const liveCam = this.cameraProvider();
            if (liveSpark) def.set(v, liveSpark, liveCam);
            valueEl.textContent = def.format(v);
        });

        wrapper.appendChild(labelRow);
        wrapper.appendChild(input);
        return wrapper;
    }
}
