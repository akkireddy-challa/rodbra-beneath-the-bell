/**
 * GaussianSplatSelectionTool — drag-rectangle selection for the Splats tab.
 *
 * Workflow:
 *   1. enable(renderer) — installs canvas drag handlers + overlay div, starts
 *      buffering "pending deletion" indices for one specific GaussianSplatRenderer.
 *   2. The user drags a rectangle. On mouseup the tool projects every gaussian
 *      to NDC, finds those inside the rect (centers only — fully within means
 *      "center inside the screen rectangle, behind the near plane"). Calls back
 *      onRectSelection(count).
 *   3. commitDelete() folds the current rect's indices into pending deletion.
 *      Affected splats have their opacity zeroed via packedSplats.setSplat —
 *      original opacities are stashed so cancel() can restore them.
 *   4. Either:
 *        - getPendingIndices() + finish() on save, OR
 *        - cancel() to revert all hidden splats and exit.
 *
 * Live preview during drag is intentionally skipped: even one forEachSplat pass
 * over a 5M-splat cloud is too slow for mousemove. Selection finalises on mouseup.
 */

import * as THREE from 'three';
import type { GaussianSplatRenderer } from 'engine/GaussianSplatRenderer.js';

interface SplatLike {
    forEachSplat(
        callback: (
            index: number,
            center: THREE.Vector3,
            scales: THREE.Vector3,
            quaternion: THREE.Quaternion,
            opacity: number,
            color: THREE.Color,
        ) => void,
    ): void;
    packedSplats?: {
        numSplats: number;
        needsUpdate: boolean;
        getSplat(index: number): {
            center: THREE.Vector3;
            scales: THREE.Vector3;
            quaternion: THREE.Quaternion;
            opacity: number;
            color: THREE.Color;
        };
        setSplat(
            index: number,
            center: THREE.Vector3,
            scales: THREE.Vector3,
            quaternion: THREE.Quaternion,
            opacity: number,
            color: THREE.Color,
        ): void;
    };
    matrixWorld: THREE.Matrix4;
    updateMatrixWorld(force?: boolean): void;
}

export interface SelectionToolCallbacks {
    onRectSelection?: (count: number) => void;
    onPendingChanged?: (count: number) => void;
    onExited?: () => void;
}

export class GaussianSplatSelectionTool {
    private camera: THREE.Camera;
    private domElement: HTMLElement;
    private callbacks: SelectionToolCallbacks;

    private renderer: GaussianSplatRenderer | null = null;
    private splatMesh: SplatLike | null = null;

    private overlay: HTMLDivElement | null = null;
    private rectDiv: HTMLDivElement | null = null;
    private hintDiv: HTMLDivElement | null = null;

    private dragStart: { x: number; y: number } | null = null;
    private dragEnd: { x: number; y: number } | null = null;

    private currentRectIndices: number[] = [];
    private pendingDeletion = new Map<number, number>(); // index → original opacity

    private boundOnMouseDown: (e: MouseEvent) => void;
    private boundOnMouseMove: (e: MouseEvent) => void;
    private boundOnMouseUp: (e: MouseEvent) => void;

    constructor(camera: THREE.Camera, domElement: HTMLElement, callbacks: SelectionToolCallbacks = {}) {
        this.camera = camera;
        this.domElement = domElement;
        this.callbacks = callbacks;
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
    }

    isActive(): boolean {
        return this.renderer !== null;
    }

    getRenderer(): GaussianSplatRenderer | null {
        return this.renderer;
    }

    getCurrentRectCount(): number {
        return this.currentRectIndices.length;
    }

    getPendingCount(): number {
        return this.pendingDeletion.size;
    }

    getPendingIndices(): number[] {
        return Array.from(this.pendingDeletion.keys()).sort((a, b) => a - b);
    }

    enable(renderer: GaussianSplatRenderer): void {
        if (this.renderer === renderer) return;
        if (this.renderer) this.disable(false);

        const splatMesh = renderer.getSplatMesh() as SplatLike | null;
        if (!splatMesh) {
            console.warn('[GaussianSplatSelectionTool] renderer has no SplatMesh — selection requires the high-res splat to be loaded');
            return;
        }
        this.renderer = renderer;
        this.splatMesh = splatMesh;
        this.currentRectIndices = [];
        this.pendingDeletion.clear();

        this.installOverlay();
        this.domElement.addEventListener('mousedown', this.boundOnMouseDown, true);
        window.addEventListener('mousemove', this.boundOnMouseMove, true);
        window.addEventListener('mouseup', this.boundOnMouseUp, true);
    }

    /**
     * Exits selection mode. By default restores any hidden gaussians; pass
     * keepDeletions=true to leave the in-memory deletions in place (used after
     * Save, where the splat is about to be reloaded from the new URL anyway).
     */
    disable(restore = true): void {
        if (!this.renderer) return;

        if (restore) this.restoreAllHidden();

        this.domElement.removeEventListener('mousedown', this.boundOnMouseDown, true);
        window.removeEventListener('mousemove', this.boundOnMouseMove, true);
        window.removeEventListener('mouseup', this.boundOnMouseUp, true);
        this.removeOverlay();

        this.renderer = null;
        this.splatMesh = null;
        this.dragStart = null;
        this.dragEnd = null;
        this.currentRectIndices = [];
        this.pendingDeletion.clear();

        this.callbacks.onExited?.();
    }

    /** Folds the current rect's selection into the pending-deletion set. */
    commitDelete(): void {
        if (!this.splatMesh || !this.splatMesh.packedSplats) return;
        const packed = this.splatMesh.packedSplats;

        for (const i of this.currentRectIndices) {
            if (this.pendingDeletion.has(i)) continue;
            const splat = packed.getSplat(i);
            this.pendingDeletion.set(i, splat.opacity);
            packed.setSplat(i, splat.center, splat.scales, splat.quaternion, 0, splat.color);
        }
        packed.needsUpdate = true;

        this.currentRectIndices = [];
        this.clearRectDiv();
        this.callbacks.onRectSelection?.(0);
        this.callbacks.onPendingChanged?.(this.pendingDeletion.size);
    }

    private restoreAllHidden(): void {
        if (!this.splatMesh || !this.splatMesh.packedSplats) return;
        const packed = this.splatMesh.packedSplats;

        for (const [i, originalOpacity] of this.pendingDeletion) {
            const splat = packed.getSplat(i);
            packed.setSplat(i, splat.center, splat.scales, splat.quaternion, originalOpacity, splat.color);
        }
        if (this.pendingDeletion.size > 0) packed.needsUpdate = true;
        this.pendingDeletion.clear();
    }

    // ---- DOM overlay ----

    private installOverlay(): void {
        const overlay = document.createElement('div');
        overlay.id = 'gaussian-selection-overlay';
        overlay.style.cssText = [
            'position: fixed',
            'inset: 0',
            'pointer-events: none',
            'z-index: 9000',
        ].join('; ');

        const hint = document.createElement('div');
        hint.style.cssText = [
            'position: absolute',
            'top: 12px',
            'left: 50%',
            'transform: translateX(-50%)',
            'background: rgba(15, 23, 42, 0.85)',
            'color: #e2e8f0',
            'padding: 6px 12px',
            'border-radius: 6px',
            'font: 13px system-ui, sans-serif',
        ].join('; ');
        hint.textContent = 'Drag to select gaussians • use the Splats panel to delete or save';
        overlay.appendChild(hint);

        document.body.appendChild(overlay);
        this.overlay = overlay;
        this.hintDiv = hint;
    }

    private removeOverlay(): void {
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.rectDiv = null;
        this.hintDiv = null;
    }

    private ensureRectDiv(): HTMLDivElement {
        if (this.rectDiv) return this.rectDiv;
        const rect = document.createElement('div');
        rect.style.cssText = [
            'position: absolute',
            'border: 1px solid rgba(56, 189, 248, 0.95)',
            'background: rgba(56, 189, 248, 0.18)',
            'pointer-events: none',
        ].join('; ');
        this.overlay?.appendChild(rect);
        this.rectDiv = rect;
        return rect;
    }

    private clearRectDiv(): void {
        if (this.rectDiv && this.rectDiv.parentNode) {
            this.rectDiv.parentNode.removeChild(this.rectDiv);
        }
        this.rectDiv = null;
    }

    private updateRectDiv(): void {
        if (!this.dragStart || !this.dragEnd) return;
        const rect = this.ensureRectDiv();
        const x = Math.min(this.dragStart.x, this.dragEnd.x);
        const y = Math.min(this.dragStart.y, this.dragEnd.y);
        const w = Math.abs(this.dragEnd.x - this.dragStart.x);
        const h = Math.abs(this.dragEnd.y - this.dragStart.y);
        rect.style.left = `${x}px`;
        rect.style.top = `${y}px`;
        rect.style.width = `${w}px`;
        rect.style.height = `${h}px`;
    }

    // ---- Mouse handling ----

    private onMouseDown(event: MouseEvent): void {
        if (event.button !== 0) return;
        if (!this.renderer) return;
        event.preventDefault();
        event.stopPropagation();
        this.dragStart = { x: event.clientX, y: event.clientY };
        this.dragEnd = { x: event.clientX, y: event.clientY };
        this.updateRectDiv();
    }

    private onMouseMove(event: MouseEvent): void {
        if (!this.dragStart) return;
        this.dragEnd = { x: event.clientX, y: event.clientY };
        this.updateRectDiv();
    }

    private onMouseUp(event: MouseEvent): void {
        if (event.button !== 0) return;
        if (!this.dragStart || !this.dragEnd) return;
        event.preventDefault();
        event.stopPropagation();

        const start = this.dragStart;
        const end = this.dragEnd;
        this.dragStart = null;
        this.dragEnd = null;

        const dx = Math.abs(end.x - start.x);
        const dy = Math.abs(end.y - start.y);
        if (dx < 4 || dy < 4) {
            // Treat as a click — clear the in-flight rect, no selection.
            this.clearRectDiv();
            return;
        }
        this.computeSelection(start, end);
    }

    // ---- Projection ----

    private computeSelection(start: { x: number; y: number }, end: { x: number; y: number }): void {
        if (!this.splatMesh) return;

        const canvas = this.domElement.getBoundingClientRect();
        const ndcMinX = ((Math.min(start.x, end.x) - canvas.left) / canvas.width) * 2 - 1;
        const ndcMaxX = ((Math.max(start.x, end.x) - canvas.left) / canvas.width) * 2 - 1;
        // y is flipped in NDC
        const ndcMinY = -(((Math.max(start.y, end.y) - canvas.top) / canvas.height) * 2 - 1);
        const ndcMaxY = -(((Math.min(start.y, end.y) - canvas.top) / canvas.height) * 2 - 1);

        // Build the world→NDC matrix once for the whole pass.
        this.camera.updateMatrixWorld(true);
        this.splatMesh.updateMatrixWorld(true);
        const projView = new THREE.Matrix4().multiplyMatrices(
            (this.camera as THREE.PerspectiveCamera).projectionMatrix,
            this.camera.matrixWorldInverse,
        );
        const localToClip = new THREE.Matrix4().multiplyMatrices(projView, this.splatMesh.matrixWorld);

        const indices: number[] = [];
        const v = new THREE.Vector4();

        this.splatMesh.forEachSplat((index, center) => {
            // Skip already-deleted splats so a re-drag doesn't double-count them.
            if (this.pendingDeletion.has(index)) return;
            v.set(center.x, center.y, center.z, 1).applyMatrix4(localToClip);
            const w = v.w;
            if (w <= 0) return; // behind near plane
            const x = v.x / w;
            const y = v.y / w;
            const z = v.z / w;
            if (z < -1 || z > 1) return;
            if (x < ndcMinX || x > ndcMaxX) return;
            if (y < ndcMinY || y > ndcMaxY) return;
            indices.push(index);
        });

        this.currentRectIndices = indices;
        this.callbacks.onRectSelection?.(indices.length);
    }
}
