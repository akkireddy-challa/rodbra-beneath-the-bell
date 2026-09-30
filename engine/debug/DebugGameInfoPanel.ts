// Type checking enabled
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { GaussianSplatDebugDialog } from './GaussianSplatDebugDialog.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { getGlobalPathConflictAvoidance } from 'engine/PathConflictAvoidance.js';
import { getGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';
import { frameSpanRecorder } from './FrameSpanRecorder.js';
import type { RendererBackend } from 'engine/RendererType.js';

/**
 * Mobile gesture: holding a finger in the top-right corner for this long toggles
 * the panel (there is no backtick key on touch devices). The hotspot is a small
 * square anchored to the top-right; the hold cancels if the finger drifts beyond
 * the tolerance, so it won't fire from normal taps or drags on nearby UI.
 */
const CORNER_HOTSPOT_PX = 80;
const CORNER_HOLD_DURATION_MS = 5000;
const CORNER_HOLD_MOVE_CANCEL_PX = 40;

/** Minimal engine surface the panel uses — duck-typed so callers can pass their own narrower engine interfaces. */
interface DebugPanelEngine {
    getDebugForceActiveRate(): boolean;
    setDebugForceActiveRate(v: boolean): void;
    getDebugDisableNpcs(): boolean;
    setDebugDisableNpcs(v: boolean): void;
    /** Real GPU backend in use (WebGPURenderer may fall back to the WebGL2 backend). */
    getActiveBackend(): RendererBackend;
}

/** Result of an in-memory prune step — keeps the panel renderer free of any direct dep on `VoxelPvsCuller`. */
export interface PvsApplyPruneResult {
    keptSplats: number;
    removedSplats: number;
    cellsRemoved: number;
    elapsedMs: number;
}

/** Aggregate-only shape for the prunability report — the panel needs totals, not per-renderer breakdown. */
export interface PvsPruningReportSnapshot {
    walkableCells: number;
    everVisibleTiles: number;
    gsplatsTotal: number;
    gsplatsPrunable: number;
    cellsTotal: number;
    cellsPrunable: number;
    perSplat: {
        analysed: number;
        centerInsidePvs: number;
        centerOutsidePvs: number;
        prunableLowOpacity: number;
        prunableHighOpacity: number;
        largeLowOpacityVisible: number;
        analysisMs: number;
    };
}

/** What a PVS-culler provider hands back each tick. Shaped to be wire-friendly so any future provider can supply the same. */
export interface PvsStatsSnapshot {
    enabled: boolean;
    totalChunks: number;
    visibleChunks: number;
    hiddenChunks: number;
    cellsUnioned: number;
    cellX: number;
    cellZ: number;
    /** Splat-grid totals across every renderer. Zero when no splat grid is built — the panel hides the splat row in that case. */
    splatCellsTotal: number;
    splatCellsVisible: number;
    splatGaussiansTotal: number;
    splatGaussiansVisible: number;
}

/**
 * Standalone debug game info panel - displays game info independently of debug mode
 * Toggled with the backtick (`) key on desktop, or by holding the top-right
 * screen corner for 5 seconds on touch devices (see installCornerHoldGesture).
 */
export class DebugGameInfoPanel {
    private scene: THREE.Scene;
    private engine: DebugPanelEngine | null;

    // Panel element
    private panel: HTMLDivElement | null = null;
    private currentLocation: string = 'Unknown';
    
    // FPS tracking
    private fpsElement: HTMLElement | null = null;
    private frameCount: number = 0;
    private lastFpsUpdate: number = 0;
    private currentFps: number = 0;
    // Frame-pacing tracking: the FPS number is a 500ms AVERAGE and reads 60
    // even when motion judders. Track the window's worst frame gap and the
    // frames whose physics advanced 0 or 2+ fixed substeps (the visible
    // "nothing moved" / "double jump" beat of the fixed-timestep accumulator).
    private lastFrameAt: number = 0;
    private maxFrameMs: number = 0;
    private judderFrames: number = 0;
    private currentMaxFrameMs: number = 0;
    private currentJudderFrames: number = 0;

    // Animation state display
    private animationStateElement: HTMLElement | null = null;
    private animationStateProvider: (() => string) | null = null;

    // Renderer/backend display (refreshed on show — WebGPU backend resolves async)
    private rendererInfoElement: HTMLElement | null = null;

    // Mobile top-right-corner long-press gesture (touch-only alternative to the
    // backtick toggle). Tracks one finger by identifier and shows a progress ring.
    private holdTouchId: number | null = null;
    private holdStartX: number = 0;
    private holdStartY: number = 0;
    private holdStartTime: number = 0;
    private holdRaf: number = 0;
    private holdRing: HTMLDivElement | null = null;
    private holdRingProgress: HTMLDivElement | null = null;
    private onCornerTouchStart: ((e: TouchEvent) => void) | null = null;
    private onCornerTouchMove: ((e: TouchEvent) => void) | null = null;
    private onCornerTouchEnd: ((e: TouchEvent) => void) | null = null;

    // Player position display
    private positionElement: HTMLElement | null = null;
    private positionProvider: (() => { x: number; y: number; z: number } | null) | null = null;

    // NPC LOD scheduler stats (line refreshed in the 500ms flush; provider wired by the editor)
    private npcLodElement: HTMLDivElement | null = null;
    private npcLodProvider: (() => string) | null = null;
    private npcLodToggleButton: HTMLButtonElement | null = null;

    // NPC state dump (button + lazily created scrollable overlay; console.log'd too)
    private npcDumpButton: HTMLButtonElement | null = null;
    private npcDumpOverlay: HTMLDivElement | null = null;
    private npcDumpPre: HTMLPreElement | null = null;

    // Frame-span attribution line (worst ms per animate() span over the 500ms window)
    private frameSpanElement: HTMLDivElement | null = null;
    private frameSpanProvider: (() => string) | null = null;

    // PVS culling stats (only shown when a provider is installed — non-splat genres stay clean)
    private pvsStatsElement: HTMLElement | null = null;
    private pvsStatsProvider: (() => PvsStatsSnapshot | null) | null = null;

    // Prunability report (button + result line). Hidden unless a provider is wired.
    private pvsPruneButton: HTMLButtonElement | null = null;
    private pvsPruneResultElement: HTMLElement | null = null;
    private pvsPruneProvider: (() => PvsPruningReportSnapshot | { error: string } | null) | null = null;

    // Live prune (destructive in-memory; reload restores)
    private pvsApplyPruneButton: HTMLButtonElement | null = null;
    private pvsApplyPruneProvider: (() => PvsApplyPruneResult | { error: string } | null) | null = null;

    // Gaussian Splat tuning dialog (B key, self-managing)
    private gsDialog: GaussianSplatDebugDialog | null = null;

    // Navmesh visualization state (off by default; checkbox in the panel).
    private navmeshVisualized: boolean = false;
    // Both overlays use LineSegments2 (not THREE.LineSegments) so the
    // `linewidth` material parameter actually thickens the line — vanilla
    // WebGL clamps every line to 1px regardless of what you ask for.
    private pathOverlay: LineSegments2 | null = null;
    private pathOverlayMat: LineMaterial | null = null;
    private pathOverlayFrame: number = 0;
    /** Last mutation version observed; refresh blocker mesh when it changes. */
    private navmeshVizVersionSeen: number = -1;
    /** Provider for active NPC/animal paths. Set by the engine wire-up. */
    private pathProvider: (() => Array<{ position: THREE.Vector3; path: THREE.Vector3[]; currentWaypointIndex: number }>) | null = null;
    /** Magenta circles marking currently flagged path-conflict virtual obstacles. */
    private virtualObstacleOverlay: LineSegments2 | null = null;
    private virtualObstacleOverlayMat: LineMaterial | null = null;

    constructor(scene: THREE.Scene, engine: DebugPanelEngine | null = null) {
        this.scene = scene;
        this.engine = engine;
    }

    /**
     * Create the standalone debug info panel
     */
    createPanel(): void {
        this.panel = document.createElement('div');
        this.panel.id = 'debug-game-info';
        this.panel.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            color: white;
            background: rgba(0,0,0,0.5);
            padding: 15px;
            border-radius: 10px;
            font-size: 14px;
            max-width: 300px;
            display: none;
            pointer-events: auto;
            z-index: 9999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        `;

        // Title
        const title = document.createElement('div');
        title.style.cssText = `
            font-size: 1.2em;
            font-weight: bold;
            margin-bottom: 10px;
        `;
        title.textContent = 'Debug Game Info';

        // FPS display
        this.fpsElement = document.createElement('div');
        this.fpsElement.style.cssText = `
            margin-bottom: 10px;
            padding: 6px 10px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 6px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 16px;
            font-weight: bold;
        `;
        this.fpsElement.id = 'debug-fps-text';
        this.updateFpsDisplay();

        // FPS cap toggle (debug only — overrides the menu/editor 30-FPS throttle when ON)
        const fpsToggleRow = this.createFpsCapToggle();

        // NPC ablation toggle (debug only — freezes and hides every NPC/animal)
        const npcDisableRow = this.createNpcDisableToggle();

        // NPC LOD scheduler stats line (populated in the 500ms flush once a provider is wired)
        this.npcLodElement = document.createElement('div');
        this.npcLodElement.style.cssText = 'margin-bottom: 5px; font-family: "Monaco", "Menlo", monospace; font-size: 12px;';
        this.npcLodElement.id = 'debug-npc-lod-text';
        this.npcLodElement.textContent = 'NPC LOD: —';

        // Frame-span attribution line (hidden until a provider is wired)
        this.frameSpanElement = document.createElement('div');
        this.frameSpanElement.style.cssText = 'margin-bottom: 5px; font-family: "Monaco", "Menlo", monospace; font-size: 12px; display: none;';
        this.frameSpanElement.id = 'debug-frame-span-text';
        this.frameSpanElement.textContent = 'Spans: —';

        // Renderer-in-use line (read-only; toggle lives in the creator's Dev Tools tab).
        // Refreshed in show() because the WebGPU backend resolves async — the
        // panel may be built before init() reports the real backend.
        this.rendererInfoElement = document.createElement('div');
        this.rendererInfoElement.style.cssText = 'margin-bottom: 8px; font-size: 13px;';
        this.updateRendererDisplay();

        // Location info
        const locationDiv = document.createElement('div');
        locationDiv.style.cssText = 'margin-bottom: 5px;';
        locationDiv.id = 'debug-location-text';
        locationDiv.textContent = `Location: ${this.currentLocation}`;

        // Player position display
        this.positionElement = document.createElement('div');
        this.positionElement.style.cssText = 'margin-bottom: 5px; font-family: "Monaco", "Menlo", monospace; font-size: 12px;';
        this.positionElement.id = 'debug-position-text';
        this.positionElement.textContent = 'Player Position: —';

        // Animation state display
        this.animationStateElement = document.createElement('div');
        this.animationStateElement.style.cssText = 'margin-bottom: 5px;';
        this.animationStateElement.id = 'debug-animation-state';
        this.animationStateElement.textContent = 'Animation: —';

        // PVS stats display (hidden until a provider is installed)
        this.pvsStatsElement = document.createElement('div');
        this.pvsStatsElement.style.cssText = 'margin-bottom: 5px; font-family: "Monaco", "Menlo", monospace; font-size: 12px; display: none;';
        this.pvsStatsElement.id = 'debug-pvs-stats';
        this.pvsStatsElement.textContent = 'PVS: —';

        // Prunability report: button + result line. Hidden until a
        // provider is wired. The compute can take ~tens of ms on a 25 M
        // splat scene (iterates every grid cell's AABB-vs-tile lookup)
        // so it's button-triggered rather than per-frame.
        this.pvsPruneButton = document.createElement('button');
        this.pvsPruneButton.id = 'debug-pvs-prune-btn';
        this.pvsPruneButton.textContent = 'Analyze prunable splats';
        this.pvsPruneButton.style.cssText = `
            display: none;
            margin-bottom: 5px;
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        `;
        this.pvsPruneButton.addEventListener('click', () => this.runPvsPruneAnalysis());

        this.pvsPruneResultElement = document.createElement('div');
        this.pvsPruneResultElement.id = 'debug-pvs-prune-result';
        this.pvsPruneResultElement.style.cssText = 'margin-bottom: 5px; font-family: "Monaco", "Menlo", monospace; font-size: 12px; display: none; white-space: pre-line;';
        this.pvsPruneResultElement.textContent = '';

        // Apply-prune button: same predicate as the analyzer, but
        // destructively rebuilds each cell's SplatMesh with the kept
        // splats only. Reload restores the original. Same hidden-until-
        // provider-wired pattern as the analyze button.
        this.pvsApplyPruneButton = document.createElement('button');
        this.pvsApplyPruneButton.id = 'debug-pvs-apply-prune-btn';
        this.pvsApplyPruneButton.textContent = 'Apply prune (live)';
        this.pvsApplyPruneButton.style.cssText = `
            display: none;
            margin-left: 6px;
            margin-bottom: 5px;
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            background: rgba(248, 113, 113, 0.15);
            color: #fff;
            border: 1px solid rgba(248, 113, 113, 0.5);
            border-radius: 4px;
        `;
        this.pvsApplyPruneButton.title = 'Drop every gsplat whose center is outside the PVS union. Reload to restore.';
        this.pvsApplyPruneButton.addEventListener('click', () => this.runPvsApplyPrune());

        // NPC LOD scheduler on/off toggle. Always visible — the scheduler global
        // exists in every game; toggling off stamps everyone FULL (pre-LOD behavior).
        this.npcLodToggleButton = document.createElement('button');
        this.npcLodToggleButton.id = 'debug-npc-lod-toggle-btn';
        this.npcLodToggleButton.style.cssText = `
            margin-bottom: 5px;
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        `;
        this.npcLodToggleButton.title = 'Toggle the NPC LOD scheduler. Off = every character simulates at full rate.';
        this.updateNpcLodToggleLabel();
        this.npcLodToggleButton.addEventListener('click', () => {
            const scheduler = getGlobalLodScheduler();
            scheduler.setEnabled(!scheduler.isEnabled());
            this.updateNpcLodToggleLabel();
        });

        // NPC state dump button. Renders every registered character's scheduler
        // record + controller detail into a scrollable overlay (the game runs in
        // an iframe, so users have no console access) and console.logs the same
        // text for headless retrieval.
        this.npcDumpButton = document.createElement('button');
        this.npcDumpButton.id = 'debug-npc-dump-btn';
        this.npcDumpButton.textContent = 'Dump NPC states';
        this.npcDumpButton.style.cssText = `
            margin-left: 6px;
            margin-bottom: 5px;
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        `;
        this.npcDumpButton.title = 'Dump per-character LOD scheduler state to an overlay (and the console).';
        this.npcDumpButton.addEventListener('click', () => this.toggleNpcDumpOverlay());

        // Debug shortcuts info
        const shortcutsDiv = document.createElement('div');
        shortcutsDiv.style.cssText = `
            margin-top: 10px;
            font-size: 0.9em;
            opacity: 0.7;
            line-height: 1.4;
        `;
        shortcutsDiv.innerHTML = `
            F2: Dump Perf Spikes (when perf stats on) | F3: Gaussian Collider Editor | F4: Switch to Mesh Character<br>
            F5: Test Placement | F6: Toggle Flying | F7: Spawn Test Box + Enemy + Vehicle<br>
            N: Toggle NPCs (perf A/B) | F8: Screenshot to Clipboard | B: Gaussian Splat Tuning | G: Spawn GVRM | H: Info | \`: Toggle This Info
        `;

        this.panel.appendChild(title);
        this.panel.appendChild(this.fpsElement);
        this.panel.appendChild(fpsToggleRow);
        this.panel.appendChild(npcDisableRow);
        this.panel.appendChild(this.frameSpanElement);
        this.panel.appendChild(this.npcLodElement);
        this.panel.appendChild(this.rendererInfoElement);
        this.panel.appendChild(this.createNavmeshToggle());
        this.panel.appendChild(locationDiv);
        this.panel.appendChild(this.positionElement);
        this.panel.appendChild(this.animationStateElement);
        this.panel.appendChild(this.pvsStatsElement);
        this.panel.appendChild(this.npcLodToggleButton);
        this.panel.appendChild(this.npcDumpButton);
        this.panel.appendChild(this.pvsPruneButton);
        this.panel.appendChild(this.pvsApplyPruneButton);
        this.panel.appendChild(this.pvsPruneResultElement);
        this.panel.appendChild(shortcutsDiv);

        document.body.appendChild(this.panel);

        // Responsive styles for mobile
        const style = document.createElement('style');
        style.textContent = `
            @media (max-width: 768px) {
                #debug-game-info {
                    font-size: 12px !important;
                    padding: 10px !important;
                }
            }
        `;
        document.head.appendChild(style);

        // Touch-only: hold the top-right corner to toggle the panel on mobile.
        this.installCornerHoldGesture();
    }

    /**
     * Register the mobile top-right-corner long-press gesture. Listeners live on
     * `document` (passive, non-capturing) so they never swallow taps meant for
     * other UI — a normal tap ends before the hold completes and a drift cancels
     * it. Touch events only fire on touch-capable inputs, so desktop is
     * unaffected (it keeps using the backtick key).
     */
    private installCornerHoldGesture(): void {
        this.onCornerTouchStart = (e: TouchEvent): void => {
            if (this.holdTouchId !== null) return; // already tracking a hold
            const t = Array.from(e.changedTouches).find((t) => this.isInTopRightCorner(t.clientX, t.clientY));
            if (t) {
                this.holdTouchId = t.identifier;
                this.holdStartX = t.clientX;
                this.holdStartY = t.clientY;
                this.holdStartTime = performance.now();
                this.showHoldRing();
                this.holdRaf = requestAnimationFrame(this.tickHold);
            }
        };
        this.onCornerTouchMove = (e: TouchEvent): void => {
            const t = this.findTrackedTouch(e.changedTouches);
            if (!t) return;
            const moved = Math.hypot(t.clientX - this.holdStartX, t.clientY - this.holdStartY);
            if (moved > CORNER_HOLD_MOVE_CANCEL_PX) this.cancelHold();
        };
        this.onCornerTouchEnd = (e: TouchEvent): void => {
            if (this.findTrackedTouch(e.changedTouches)) this.cancelHold();
        };
        document.addEventListener('touchstart', this.onCornerTouchStart, { passive: true });
        document.addEventListener('touchmove', this.onCornerTouchMove, { passive: true });
        document.addEventListener('touchend', this.onCornerTouchEnd, { passive: true });
        document.addEventListener('touchcancel', this.onCornerTouchEnd, { passive: true });
    }

    private isInTopRightCorner(x: number, y: number): boolean {
        return x >= window.innerWidth - CORNER_HOTSPOT_PX && y <= CORNER_HOTSPOT_PX;
    }

    /** Find the currently tracked finger within a TouchList, or null. */
    private findTrackedTouch(list: TouchList): Touch | null {
        if (this.holdTouchId === null) return null;
        return Array.from(list).find((t) => t.identifier === this.holdTouchId) ?? null;
    }

    /** rAF loop: advance the progress ring and fire the toggle once the hold completes. */
    private tickHold = (): void => {
        if (this.holdTouchId === null) return;
        const elapsed = performance.now() - this.holdStartTime;
        const progress = Math.min(1, elapsed / CORNER_HOLD_DURATION_MS);
        this.updateHoldRing(progress);
        if (progress >= 1) {
            this.cancelHold();
            this.toggle();
            return;
        }
        this.holdRaf = requestAnimationFrame(this.tickHold);
    };

    /** Stop tracking the current hold and tear down its visual feedback. */
    private cancelHold(): void {
        this.holdTouchId = null;
        if (this.holdRaf !== 0) {
            cancelAnimationFrame(this.holdRaf);
            this.holdRaf = 0;
        }
        if (this.holdRing) {
            this.holdRing.remove();
            this.holdRing = null;
            this.holdRingProgress = null;
        }
    }

    /**
     * Create the progress-ring overlay shown while the corner is held. The outer
     * conic-gradient div fills clockwise as the hold advances; an inner disc
     * punches the centre out to leave a ring.
     */
    private showHoldRing(): void {
        if (this.holdRing) return;
        const ring = document.createElement('div');
        ring.style.cssText = `
            position: fixed;
            top: 14px;
            right: 14px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            z-index: 10000;
            pointer-events: none;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        const progress = document.createElement('div');
        progress.style.cssText = `
            position: absolute;
            inset: 0;
            border-radius: 50%;
            background: conic-gradient(rgba(255,255,255,0.9) 0deg, rgba(255,255,255,0.15) 0deg);
        `;
        const hole = document.createElement('div');
        hole.style.cssText = `
            position: absolute;
            inset: 6px;
            border-radius: 50%;
            background: rgba(0,0,0,0.65);
        `;
        ring.appendChild(progress);
        ring.appendChild(hole);
        document.body.appendChild(ring);
        this.holdRing = ring;
        this.holdRingProgress = progress;
        this.updateHoldRing(0);
    }

    private updateHoldRing(progress: number): void {
        if (!this.holdRingProgress) return;
        const deg = Math.round(progress * 360);
        this.holdRingProgress.style.background =
            `conic-gradient(rgba(255,255,255,0.9) ${deg}deg, rgba(255,255,255,0.15) ${deg}deg)`;
    }

    private removeCornerHoldGesture(): void {
        this.cancelHold();
        if (this.onCornerTouchStart) document.removeEventListener('touchstart', this.onCornerTouchStart);
        if (this.onCornerTouchMove) document.removeEventListener('touchmove', this.onCornerTouchMove);
        if (this.onCornerTouchEnd) {
            document.removeEventListener('touchend', this.onCornerTouchEnd);
            document.removeEventListener('touchcancel', this.onCornerTouchEnd);
        }
        this.onCornerTouchStart = null;
        this.onCornerTouchMove = null;
        this.onCornerTouchEnd = null;
    }

    /**
     * Toggle panel visibility
     */
    toggle(): void {
        if (!this.panel) {
            console.warn('Debug Game Info panel not found');
            return;
        }
        if (this.isVisible()) {
            this.hide();
            console.log('Debug Game Info hidden - Press ` to toggle');
        } else {
            this.show();
            console.log('Debug Game Info shown - Press ` to toggle');
        }
    }

    /**
     * Show the panel
     */
    show(): void {
        if (this.panel) {
            this.panel.style.display = 'block';
            this.toggleMeasuringStickVisibility(true);
            this.startFpsUpdates();
            // Backend is resolved by now (init() long since completed); refresh
            // in case the panel was built before the WebGPU fallback was known.
            this.updateRendererDisplay();
        }
    }

    /** Show the real GPU backend in use, not just the requested renderer type. */
    private updateRendererDisplay(): void {
        if (!this.rendererInfoElement) return;
        const backend = this.engine?.getActiveBackend();
        const label = backend === 'webgpu' ? 'WebGPU' : backend === 'webgl2' ? 'WebGL2' : 'Unknown';
        this.rendererInfoElement.textContent = `Renderer: ${label}`;
    }

    /**
     * Hide the panel
     */
    hide(): void {
        if (this.panel) {
            this.panel.style.display = 'none';
            this.toggleMeasuringStickVisibility(false);
            this.stopFpsUpdates();
        }
    }

    /**
     * Check if the panel is visible
     */
    isVisible(): boolean {
        if (!this.panel) return false;
        const computedStyle = window.getComputedStyle(this.panel);
        return computedStyle.display !== 'none';
    }

    /**
     * Update game name in debug info panel
     */
    updateGameName(gameName: string): void {
        this.currentLocation = gameName;
        const locationElement = document.getElementById('debug-location-text');
        if (locationElement) {
            locationElement.textContent = `Location: ${gameName}`;
        }
    }

    /**
     * Call this every frame to track FPS and frame pacing.
     * @param physicsSubsteps Fixed physics substeps the frame ran (from
     *   PhysicsWorld.lastStepSubstepCount). 0 or 2+ = a pacing beat the
     *   average FPS cannot show.
     */
    recordFrame(physicsSubsteps?: number): void {
        this.frameCount++;
        const now = performance.now();

        if (this.lastFrameAt > 0) {
            const gap = now - this.lastFrameAt;
            if (gap > this.maxFrameMs) this.maxFrameMs = gap;
        }
        this.lastFrameAt = now;
        if (physicsSubsteps !== undefined && physicsSubsteps !== 1) {
            this.judderFrames++;
        }

        // Update FPS display every 500ms for smooth readings
        if (now - this.lastFpsUpdate >= 500) {
            const elapsed = (now - this.lastFpsUpdate) / 1000;
            this.currentFps = Math.round(this.frameCount / elapsed);
            this.currentMaxFrameMs = this.maxFrameMs;
            this.currentJudderFrames = this.judderFrames;
            this.frameCount = 0;
            this.maxFrameMs = 0;
            this.judderFrames = 0;
            this.lastFpsUpdate = now;
            this.updateFpsDisplay();
            this.updateFrameSpanDisplay();
            this.updateNpcLodDisplay();
            this.updatePositionDisplay();
            this.updateAnimationStateDisplay();
            this.updatePvsStatsDisplay();
        }
    }

    /**
     * Update the FPS display element
     */
    private updateFpsDisplay(): void {
        if (!this.fpsElement) return;
        
        // Color-code FPS: green >= 55, yellow >= 30, red < 30
        let color: string;
        if (this.currentFps >= 55) {
            color = '#4ade80'; // green
        } else if (this.currentFps >= 30) {
            color = '#fbbf24'; // yellow
        } else {
            color = '#f87171'; // red
        }
        
        // Pacing suffix: worst frame gap + physics-beat frames in the window.
        // "60 FPS" with a 45ms max gap or a nonzero beat count IS the choppiness.
        const maxMs = this.currentMaxFrameMs;
        const beats = this.currentJudderFrames;
        const maxColor = maxMs <= 22 ? '#4ade80' : maxMs <= 34 ? '#fbbf24' : '#f87171';
        const beatColor = beats <= 1 ? '#4ade80' : beats <= 5 ? '#fbbf24' : '#f87171';
        this.fpsElement.innerHTML =
            `FPS: <span style="color: ${color}">${this.currentFps}</span>` +
            ` <span style="opacity:0.85">max <span style="color: ${maxColor}">${maxMs.toFixed(0)}ms</span>` +
            ` beat <span style="color: ${beatColor}">${beats}</span></span>`;
    }

    /**
     * Set a provider that returns the current player position.
     */
    setPositionProvider(provider: (() => { x: number; y: number; z: number } | null) | null): void {
        this.positionProvider = provider;
    }

    /**
     * Update the position display element
     */
    private updatePositionDisplay(): void {
        if (!this.positionElement) return;
        const pos = this.positionProvider ? this.positionProvider() : null;
        if (pos) {
            this.positionElement.textContent = `Player Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
        } else {
            this.positionElement.textContent = 'Player Position: —';
        }
    }

    /**
     * Set a provider that returns the current animation state string.
     */
    setAnimationStateProvider(provider: (() => string) | null): void {
        this.animationStateProvider = provider;
    }

    /**
     * Set a provider that returns the NPC LOD scheduler's compact stats line.
     */
    setNpcLodProvider(provider: (() => string) | null): void {
        this.npcLodProvider = provider;
    }

    /**
     * Update the NPC LOD stats display element
     */
    private updateNpcLodDisplay(): void {
        if (!this.npcLodElement) return;
        this.npcLodElement.textContent = this.npcLodProvider ? this.npcLodProvider() : 'NPC LOD: —';
    }

    /** Relabel the NPC LOD toggle button from the scheduler's current enabled state. */
    private updateNpcLodToggleLabel(): void {
        if (!this.npcLodToggleButton) return;
        this.npcLodToggleButton.textContent = getGlobalLodScheduler().isEnabled() ? 'NPC LOD: on' : 'NPC LOD: off';
    }

    /**
     * Set a provider that returns the frame-span attribution line (worst ms per
     * animate() span over the last window). Shows the row; pass null to hide.
     */
    setFrameSpanProvider(provider: (() => string) | null): void {
        this.frameSpanProvider = provider;
        if (this.frameSpanElement) this.frameSpanElement.style.display = provider ? 'block' : 'none';
    }

    /** Update the frame-span attribution display element (500ms flush). */
    private updateFrameSpanDisplay(): void {
        if (!this.frameSpanElement || !this.frameSpanProvider) return;
        this.frameSpanElement.textContent = this.frameSpanProvider();
    }

    /**
     * Toggle the NPC state dump overlay: on open (or re-click while open with
     * fresh data wanted), pull dumpStates() from the scheduler, console.log it
     * for headless retrieval, and render it into a scrollable monospace pre.
     */
    private toggleNpcDumpOverlay(): void {
        if (this.npcDumpOverlay && this.npcDumpOverlay.style.display !== 'none') {
            this.npcDumpOverlay.style.display = 'none';
            return;
        }
        const spikes = frameSpanRecorder.getSpikeLog();
        const spikeSection = spikes.length > 0
            ? '\n\nRecent spike frames (>30 ms, most recent last):\n' + spikes.join('\n')
            : '\n\nRecent spike frames (>30 ms): none recorded';
        const text = getGlobalLodScheduler().dumpStates() + spikeSection;
        console.log('[DebugGameInfoPanel] NPC state dump:\n' + text);
        if (!this.npcDumpOverlay) this.createNpcDumpOverlay();
        if (this.npcDumpPre) this.npcDumpPre.textContent = text;
        if (this.npcDumpOverlay) this.npcDumpOverlay.style.display = 'block';
    }

    /** Lazily build the dump overlay: panel-styled fixed box with a close button and a scrollable pre. */
    private createNpcDumpOverlay(): void {
        const overlay = document.createElement('div');
        overlay.id = 'debug-npc-dump-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 20px;
            left: 20px;
            right: 340px;
            max-height: 70vh;
            color: white;
            background: rgba(0,0,0,0.75);
            padding: 10px;
            border-radius: 10px;
            z-index: 10000;
            pointer-events: auto;
            display: none;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        `;
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;';
        const title = document.createElement('div');
        title.style.cssText = 'font-weight: bold; font-size: 13px;';
        title.textContent = 'NPC state dump';
        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        closeButton.style.cssText = `
            padding: 2px 10px;
            font-size: 12px;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        `;
        closeButton.addEventListener('click', () => {
            if (this.npcDumpOverlay) this.npcDumpOverlay.style.display = 'none';
        });
        header.appendChild(title);
        header.appendChild(closeButton);
        const pre = document.createElement('pre');
        pre.style.cssText = `
            margin: 0;
            max-height: calc(70vh - 40px);
            overflow: auto;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 11px;
            line-height: 1.4;
            white-space: pre;
        `;
        overlay.appendChild(header);
        overlay.appendChild(pre);
        document.body.appendChild(overlay);
        this.npcDumpOverlay = overlay;
        this.npcDumpPre = pre;
    }

    /**
     * Update the animation state display element
     */
    private updateAnimationStateDisplay(): void {
        if (!this.animationStateElement) return;
        const state = this.animationStateProvider ? this.animationStateProvider() : '—';
        this.animationStateElement.textContent = `Animation: ${state}`;
    }

    /**
     * Install a PVS culler stats provider. Pass null to remove. The row
     * itself only renders when the provider actually returns data with
     * chunks loaded, so non-splat games (or splat games before any voxels
     * are built) don't show a noisy empty line.
     */
    setPvsStatsProvider(provider: (() => PvsStatsSnapshot | null) | null): void {
        this.pvsStatsProvider = provider;
    }

    /**
     * Install a prunability-report provider. Wiring this in shows the
     * "Analyze prunable splats" button in the panel — clicking it runs
     * the provider synchronously and renders the result inline. Pass
     * null to hide the button.
     */
    setPvsPruneProvider(provider: (() => PvsPruningReportSnapshot | { error: string } | null) | null): void {
        this.pvsPruneProvider = provider;
        if (this.pvsPruneButton) this.pvsPruneButton.style.display = provider ? 'inline-block' : 'none';
        if (!provider && this.pvsPruneResultElement) {
            this.pvsPruneResultElement.style.display = 'none';
            this.pvsPruneResultElement.textContent = '';
        }
    }

    /**
     * Install the destructive in-memory prune provider. Shows the
     * "Apply prune (live)" button next to the analyze button when
     * non-null. The provider performs the rebuild and returns counts —
     * the panel just renders the outcome.
     */
    setPvsApplyPruneProvider(provider: (() => PvsApplyPruneResult | { error: string } | null) | null): void {
        this.pvsApplyPruneProvider = provider;
        if (this.pvsApplyPruneButton) this.pvsApplyPruneButton.style.display = provider ? 'inline-block' : 'none';
    }

    /** Click handler for the destructive prune button. Symmetric to `runPvsPruneAnalysis`. */
    private runPvsApplyPrune(): void {
        if (!this.pvsApplyPruneProvider || !this.pvsPruneResultElement || !this.pvsApplyPruneButton) return;
        this.pvsApplyPruneButton.disabled = true;
        this.pvsApplyPruneButton.textContent = 'Pruning…';
        requestAnimationFrame(() => {
            const result = this.pvsApplyPruneProvider?.();
            if (this.pvsApplyPruneButton) {
                this.pvsApplyPruneButton.disabled = false;
                this.pvsApplyPruneButton.textContent = 'Apply prune (live)';
            }
            if (!this.pvsPruneResultElement) return;
            this.pvsPruneResultElement.style.display = 'block';
            if (!result) {
                this.pvsPruneResultElement.style.color = '#f87171';
                this.pvsPruneResultElement.textContent = 'No data';
                return;
            }
            if ('error' in result) {
                this.pvsPruneResultElement.style.color = '#fbbf24';
                this.pvsPruneResultElement.textContent = `Can't prune: ${result.error}`;
                return;
            }
            const total = result.keptSplats + result.removedSplats;
            const pct = total > 0 ? (result.removedSplats / total) * 100 : 0;
            this.pvsPruneResultElement.style.color = '#4ade80';
            this.pvsPruneResultElement.textContent = [
                `Applied prune: ${result.removedSplats.toLocaleString()} gsplats removed (${pct.toFixed(1)}%), ${result.cellsRemoved} cells dropped`,
                `Kept: ${result.keptSplats.toLocaleString()} gsplats. Reload to restore. (${result.elapsedMs.toFixed(0)} ms)`,
            ].join('\n');
        });
    }

    /**
     * Click handler for the prunable-splats button. Runs the provider,
     * formats the result, and shows it under the button. Always shows a
     * line (success or error) so the user knows the click registered.
     */
    private runPvsPruneAnalysis(): void {
        if (!this.pvsPruneProvider || !this.pvsPruneResultElement || !this.pvsPruneButton) return;
        this.pvsPruneButton.disabled = true;
        this.pvsPruneButton.textContent = 'Analyzing…';
        // Defer one frame so the disabled/label change actually paints
        // before the (potentially blocking) analysis starts.
        requestAnimationFrame(() => {
            const result = this.pvsPruneProvider?.();
            if (this.pvsPruneButton) {
                this.pvsPruneButton.disabled = false;
                this.pvsPruneButton.textContent = 'Analyze prunable splats';
            }
            if (!this.pvsPruneResultElement) return;
            this.pvsPruneResultElement.style.display = 'block';
            if (!result) {
                this.pvsPruneResultElement.style.color = '#f87171';
                this.pvsPruneResultElement.textContent = 'No data';
                return;
            }
            if ('error' in result) {
                this.pvsPruneResultElement.style.color = '#fbbf24';
                this.pvsPruneResultElement.textContent = `Can't analyze: ${result.error}`;
                return;
            }
            this.pvsPruneResultElement.style.color = '#d1d5db';
            const gsplatPct = result.gsplatsTotal > 0 ? (result.gsplatsPrunable / result.gsplatsTotal) * 100 : 0;
            const cellPct = result.cellsTotal > 0 ? (result.cellsPrunable / result.cellsTotal) * 100 : 0;
            const ps = result.perSplat;
            const psOutPct = ps.analysed > 0 ? (ps.centerOutsidePvs / ps.analysed) * 100 : 0;
            const lines = [
                `Cell-level: ${result.gsplatsPrunable.toLocaleString()}/${result.gsplatsTotal.toLocaleString()} gsplats (${gsplatPct.toFixed(1)}%), ${result.cellsPrunable}/${result.cellsTotal} cells (${cellPct.toFixed(1)}%) outside PVS`,
                `Per-splat:  ${ps.centerOutsidePvs.toLocaleString()}/${ps.analysed.toLocaleString()} centers outside PVS (${psOutPct.toFixed(1)}%) — true prunable ≥ this`,
                `  outside breakdown: ${ps.prunableLowOpacity.toLocaleString()} low-opacity, ${ps.prunableHighOpacity.toLocaleString()} high-opacity`,
                `  large+low-opacity inside PVS: ${ps.largeLowOpacityVisible.toLocaleString()} (fill-rate suspects)`,
                `PVS union: ${result.everVisibleTiles.toLocaleString()} tiles over ${result.walkableCells.toLocaleString()} walkable cells (${ps.analysisMs.toFixed(0)} ms)`,
            ];
            this.pvsPruneResultElement.textContent = lines.join('\n');
        });
    }

    /**
     * Refresh the PVS stats line. Renders two rows when both voxel chunks
     * and a splat grid exist — the splat row carries the workload Spark
     * actually sees each frame (visible gsplat count is what matters; the
     * cell-count ratio can mislead when cell density varies). Colour
     * legend per row: green when culling hides >10%, yellow when it hides
     * something but not much, red when culling is on but nothing is
     * hidden, grey when culling is off.
     */
    private updatePvsStatsDisplay(): void {
        if (!this.pvsStatsElement) return;
        const stats = this.pvsStatsProvider ? this.pvsStatsProvider() : null;
        const hasChunks = !!stats && stats.totalChunks > 0;
        const hasSplats = !!stats && stats.splatCellsTotal > 0;
        if (!stats || (!hasChunks && !hasSplats)) {
            this.pvsStatsElement.style.display = 'none';
            return;
        }
        this.pvsStatsElement.style.display = 'block';
        const status = stats.enabled ? 'CULL' : 'OFF';
        const colorFor = (hiddenPct: number): string => {
            if (!stats.enabled) return '#9ca3af';
            if (hiddenPct >= 10) return '#4ade80';
            if (hiddenPct > 0) return '#fbbf24';
            return '#f87171';
        };
        const rows: string[] = [];
        if (hasChunks) {
            const hiddenPct = (stats.hiddenChunks / stats.totalChunks) * 100;
            rows.push(`Voxels <span style="color: ${colorFor(hiddenPct)}">${status}</span>: ${stats.visibleChunks}/${stats.totalChunks} chunks (${hiddenPct.toFixed(1)}% hidden) ∪${stats.cellsUnioned}`);
        }
        if (hasSplats) {
            const hiddenCells = stats.splatCellsTotal - stats.splatCellsVisible;
            const hiddenPct = (hiddenCells / stats.splatCellsTotal) * 100;
            const hiddenGsplats = stats.splatGaussiansTotal - stats.splatGaussiansVisible;
            const gsplatHiddenPct = stats.splatGaussiansTotal > 0 ? (hiddenGsplats / stats.splatGaussiansTotal) * 100 : 0;
            rows.push(
                `Splats <span style="color: ${colorFor(hiddenPct)}">${status}</span>: ${stats.splatCellsVisible}/${stats.splatCellsTotal} cells (${hiddenPct.toFixed(1)}% hidden), ${stats.splatGaussiansVisible.toLocaleString()}/${stats.splatGaussiansTotal.toLocaleString()} gsplats (${gsplatHiddenPct.toFixed(1)}% hidden)`,
            );
        }
        this.pvsStatsElement.innerHTML = rows.join('<br>');
    }

    /**
     * Reset the FPS sampling window — called when the panel becomes visible
     * so the first reading isn't computed against a stale `lastFpsUpdate`.
     */
    private startFpsUpdates(): void {
        this.lastFpsUpdate = performance.now();
        this.frameCount = 0;
    }

    private stopFpsUpdates(): void {
        // FPS is driven by per-frame recordFrame() calls — nothing to stop.
    }

    /**
     * Build a labelled checkbox row (shared by the toggle builders below).
     * `onChange` receives the checkbox's new checked state.
     */
    private createCheckboxRow(id: string, labelText: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; font-size: 13px;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = id;
        checkbox.style.cssText = 'cursor: pointer; margin: 0;';
        checkbox.checked = checked;
        checkbox.addEventListener('change', () => onChange(checkbox.checked));
        const label = document.createElement('label');
        label.htmlFor = id;
        label.style.cssText = 'cursor: pointer; user-select: none;';
        label.textContent = labelText;
        row.appendChild(checkbox);
        row.appendChild(label);
        return row;
    }

    /**
     * Build the FPS cap toggle row. Debug-only: when ON, the engine renders at
     * the active 60-FPS rate even outside of PLAYING state (useful for editor
     * preview at full smoothness). When OFF (default), the engine throttles
     * non-PLAYING states to 30 FPS to save GPU/CPU.
     */
    /**
     * Build the NPC ablation toggle. When ON, every NPC and animal is frozen and
     * hidden — no behaviour ticks, no LOD scheduling, no crowd solve, no draws —
     * while terrain, environment, physics and the player run untouched.
     *
     * Answers "what does this game cost with no NPCs at all?" directly, instead
     * of inferring it from spans that can only ever measure the NPCs that happen
     * to be awake. NPC spawn positions are random per session, so the awake set
     * differs every run and the spans alone cannot be compared across reloads.
     */
    private createNpcDisableToggle(): HTMLElement {
        return this.createCheckboxRow(
            'debug-disable-npcs-toggle',
            'Disable NPCs (perf A/B)',
            this.engine?.getDebugDisableNpcs() ?? false,
            (checked) => this.engine?.setDebugDisableNpcs(checked),
        );
    }

    private createFpsCapToggle(): HTMLElement {
        return this.createCheckboxRow(
            'debug-fps-cap-toggle',
            'Force 60 FPS in editor/menu',
            this.engine?.getDebugForceActiveRate() ?? false,
            (checked) => this.engine?.setDebugForceActiveRate(checked),
        );
    }

    /**
     * Build the navmesh-visualisation toggle row. When ON, the engine renders
     * a transparent overlay on top of every blocked navmesh cell (red =
     * obstacle, yellow = terrain-clip, orange = both). Walkable cells are
     * intentionally not drawn — at fine resolutions there are millions of
     * them and the contrast against the visible blockers is the whole
     * signal. The overlay is a snapshot at toggle-on time; toggle off and
     * on again to refresh after obstacles change.
     */
    private createNavmeshToggle(): HTMLElement {
        return this.createCheckboxRow(
            'debug-navmesh-toggle',
            'Show navmesh blockers',
            this.navmeshVisualized,
            (checked) => this.setNavmeshVisualization(checked),
        );
    }

    /**
     * Provide a callback that returns the current planned paths of every
     * active NPC and animal. Set by the engine wire-up so the navmesh
     * overlay can render path waypoints alongside the blocker cells.
     * Returning an empty list is fine; the overlay just shows no paths.
     */
    setPathProvider(provider: (() => Array<{ position: THREE.Vector3; path: THREE.Vector3[]; currentWaypointIndex: number }>) | null): void {
        this.pathProvider = provider;
    }

    /**
     * Enable or disable the navmesh visualization overlay. Idempotent —
     * calling with the same value as the current state is a no-op. Also
     * starts/stops the per-frame path overlay update.
     */
    private setNavmeshVisualization(enabled: boolean): void {
        const navMesh = getGlobalNavMesh();
        if (!navMesh) {
            console.warn('[DebugGameInfoPanel] No global navmesh registered — visualization unavailable.');
            return;
        }
        if (enabled) {
            navMesh.visualize(this.scene);
            this.navmeshVizVersionSeen = navMesh.getCellMutationVersion();
            this.navmeshVisualized = true;
            this.startPathOverlayLoop();
        } else {
            navMesh.removeVisualization(this.scene);
            this.navmeshVisualized = false;
            this.navmeshVizVersionSeen = -1;
            this.stopPathOverlayLoop();
        }
    }

    /**
     * Per-frame: rebuild the path overlay geometry from the latest agent
     * paths, and refresh the blocker mesh whenever the navmesh reports a
     * cell-mutation version bump (chairs / tables pushed, obstacles
     * toggled by the tavern system, etc.). Both updates run via
     * requestAnimationFrame so they stop automatically if the page tab is
     * hidden.
     */
    private startPathOverlayLoop(): void {
        this.stopPathOverlayLoop();
        const update = (): void => {
            this.pathOverlayFrame = 0;
            if (!this.navmeshVisualized) return;
            const nav = getGlobalNavMesh();
            if (nav) {
                const v = nav.getCellMutationVersion();
                if (v !== this.navmeshVizVersionSeen) {
                    nav.visualize(this.scene);
                    this.navmeshVizVersionSeen = v;
                }
            }
            this.refreshPathOverlay();
            this.refreshVirtualObstacleOverlay();
            this.pathOverlayFrame = requestAnimationFrame(update);
        };
        this.pathOverlayFrame = requestAnimationFrame(update);
    }

    private stopPathOverlayLoop(): void {
        if (this.pathOverlayFrame !== 0) {
            cancelAnimationFrame(this.pathOverlayFrame);
            this.pathOverlayFrame = 0;
        }
        if (this.pathOverlay) {
            this.scene.remove(this.pathOverlay);
            this.pathOverlay.geometry.dispose();
            this.pathOverlayMat?.dispose();
            this.pathOverlay = null;
            this.pathOverlayMat = null;
        }
        if (this.virtualObstacleOverlay) {
            this.scene.remove(this.virtualObstacleOverlay);
            this.virtualObstacleOverlay.geometry.dispose();
            this.virtualObstacleOverlayMat?.dispose();
            this.virtualObstacleOverlay = null;
            this.virtualObstacleOverlayMat = null;
        }
    }

    /**
     * Rebuild the LineSegments geometry that draws a magenta ring around
     * every currently flagged path-conflict virtual obstacle. Each obstacle
     * draws TWO concentric rings — the inner ring at the agent's bare
     * capsule radius, the outer ring at the inflated radius the planner
     * actually uses to block cells (agent + agent_radius padding). The gap
     * between them is the "you can't approach me closer than this" zone.
     * Plus a short vertical spike for extra contrast against ground clutter.
     */
    private refreshVirtualObstacleOverlay(): void {
        const pcs = getGlobalPathConflictAvoidance();
        if (!pcs) {
            if (this.virtualObstacleOverlay) this.virtualObstacleOverlay.visible = false;
            return;
        }
        const obstacles = pcs.getActiveVirtualObstacles();
        if (obstacles.length === 0) {
            if (this.virtualObstacleOverlay) this.virtualObstacleOverlay.visible = false;
            return;
        }
        const SEGMENTS = 24;
        // Inflate by the navmesh's agent radius — that's the exact ring
        // that A* treats as blocked. 0.35 m matches the engine's current
        // DEFAULT_AGENT_RADIUS; mismatch just means the outer ring is
        // drawn slightly off from the actual planner block radius.
        const planRadiusInflation = 0.35;
        const positions: number[] = [];
        const pushRing = (cx: number, cz: number, cy: number, r: number): void => {
            for (let i = 0; i < SEGMENTS; i++) {
                const a0 = (i / SEGMENTS) * Math.PI * 2;
                const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
                positions.push(
                    cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r,
                    cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r,
                );
            }
        };
        for (const obs of obstacles) {
            const y = obs.y + 0.25;
            // Inner ring: bare capsule radius.
            pushRing(obs.x, obs.z, y, obs.radius);
            // Outer ring: planner's effective blocked radius.
            pushRing(obs.x, obs.z, y, obs.radius + planRadiusInflation);
            // Vertical spike — visible from far away even when looking
            // down at a top-down camera angle that flattens the rings.
            positions.push(obs.x, obs.y, obs.z, obs.x, obs.y + 2.5, obs.z);
        }
        const geom = new LineSegmentsGeometry();
        geom.setPositions(new Float32Array(positions));
        // Magenta — visually distinct from the cyan path overlay, the red
        // blocker cells, and the yellow terrain-clip cells.
        const { overlay, mat } = this.upsertLineOverlay(this.virtualObstacleOverlay, geom, 0xff00ff, 0.9, 10000);
        this.virtualObstacleOverlay = overlay;
        this.virtualObstacleOverlayMat = mat;
    }

    /**
     * Create the overlay on first use (or rebind a new geometry into the
     * existing one) for a thick-line LineSegments2 overlay. LineMaterial
     * draws screen-space lines that actually honour `linewidth` (vanilla
     * THREE.LineBasicMaterial is locked to 1px on WebGL). Resolution is
     * refreshed every call since the window may have resized.
     */
    private upsertLineOverlay(
        existing: LineSegments2 | null,
        geom: LineSegmentsGeometry,
        color: number,
        opacity: number,
        renderOrder: number,
    ): { overlay: LineSegments2; mat: LineMaterial } {
        if (existing) {
            existing.geometry.dispose();
            existing.geometry = geom;
            const mat = existing.material as LineMaterial;
            mat.resolution.set(window.innerWidth, window.innerHeight);
            existing.visible = true;
            return { overlay: existing, mat };
        }
        const mat = new LineMaterial({
            color,
            linewidth: 4,
            transparent: true,
            opacity,
            depthTest: false,
            worldUnits: false,
        });
        mat.resolution.set(window.innerWidth, window.innerHeight);
        const overlay = new LineSegments2(geom, mat);
        overlay.renderOrder = renderOrder;
        this.scene.add(overlay);
        return { overlay, mat };
    }

    /**
     * Rebuild the geometry that draws every active path as a connected
     * polyline from the agent's current position through its REMAINING
     * (not-yet-reached) waypoints. Bright cyan, drawn slightly above
     * ground with a thickness-respecting LineMaterial so it's readable
     * against busy terrain.
     *
     * Starts the polyline at `path[currentWaypointIndex]` (not at
     * `path[0]`): waypoints the agent has already walked past are
     * irrelevant and rendering them produces a confusing backwards-line
     * from the agent toward the path's start.
     */
    private refreshPathOverlay(): void {
        const provider = this.pathProvider;
        if (!provider) return;
        const agents = provider();
        const positions: number[] = [];
        for (const agent of agents) {
            const path = agent.path;
            if (path.length === 0) continue;
            const startIdx = Math.max(0, Math.min(path.length, agent.currentWaypointIndex));
            if (startIdx >= path.length) continue;
            // First segment: agent's current position → current waypoint.
            // Subsequent segments chain through the remaining waypoints.
            let prev = agent.position;
            for (let i = startIdx; i < path.length; i++) {
                const w = path[i]!;
                positions.push(prev.x, prev.y + 0.2, prev.z, w.x, w.y + 0.2, w.z);
                prev = w;
            }
        }
        if (positions.length === 0) {
            if (this.pathOverlay) this.pathOverlay.visible = false;
            return;
        }
        const geom = new LineSegmentsGeometry();
        geom.setPositions(new Float32Array(positions));
        const { overlay, mat } = this.upsertLineOverlay(this.pathOverlay, geom, 0x00e0ff, 0.95, 9999);
        this.pathOverlay = overlay;
        this.pathOverlayMat = mat;
    }

    /**
     * Toggle measuring stick visibility in the scene
     */
    private toggleMeasuringStickVisibility(visible: boolean): void {
        // Find all measuring stick objects and toggle their visibility
        this.scene.traverse((object: THREE.Object3D) => {
            if (object.name.startsWith('MeasuringStick_')) {
                object.visible = visible;
            }
        });
    }

    /**
     * Create the GaussianSplatDebugDialog (B key) wired to the given engine.
     * Must be called after createPanel(). Safe to call on non-splat genres —
     * the dialog checks for an active SparkRenderer before opening.
     */
    attachGaussianSplatDebugDialog(engine: {
        sparkRenderer?: unknown;
        camera: THREE.PerspectiveCamera | null;
        getPointerLockManager?: () => import('engine/PointerLockManager.js').PointerLockManager | null;
    }): void {
        this.gsDialog?.dispose();
        this.gsDialog = new GaussianSplatDebugDialog({
            sparkProvider: () => (engine.sparkRenderer as never) ?? null,
            cameraProvider: () => engine.camera,
            pointerLockManagerProvider: () => engine.getPointerLockManager?.() ?? null,
        });
    }

    /**
     * Get the panel element
     */
    getPanel(): HTMLDivElement | null {
        return this.panel;
    }

    /**
     * Dispose of the panel
     */
    dispose(): void {
        this.stopFpsUpdates();
        this.removeCornerHoldGesture();
        this.gsDialog?.dispose();
        this.gsDialog = null;
        // Clean up the navmesh overlay if it's currently rendered.
        if (this.navmeshVisualized) {
            getGlobalNavMesh()?.removeVisualization(this.scene);
            this.navmeshVisualized = false;
        }
        this.stopPathOverlayLoop();
        if (this.panel && this.panel.parentNode) {
            this.panel.parentNode.removeChild(this.panel);
            this.panel = null;
        }
        this.fpsElement = null;
        this.rendererInfoElement = null;
        this.positionElement = null;
        this.positionProvider = null;
        this.animationStateElement = null;
        this.animationStateProvider = null;
        this.npcLodElement = null;
        this.npcLodProvider = null;
        this.npcLodToggleButton = null;
        this.npcDumpButton = null;
        if (this.npcDumpOverlay && this.npcDumpOverlay.parentNode) {
            this.npcDumpOverlay.parentNode.removeChild(this.npcDumpOverlay);
        }
        this.npcDumpOverlay = null;
        this.npcDumpPre = null;
        this.frameSpanElement = null;
        this.frameSpanProvider = null;
        this.pvsStatsElement = null;
        this.pvsStatsProvider = null;
    }
}
