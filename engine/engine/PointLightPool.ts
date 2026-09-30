import * as THREE from 'three';

/**
 * A fixed-size pool of point lights, sized once and never resized — the scene's
 * light COUNT stays constant for the pool's lifetime.
 *
 * WHY: adding or removing a light (or hiding a light's parent with
 * `.visible = false`) changes how many lights three.js compiles into each
 * material's shader. On the WebGPU backend that recompile is SYNCHRONOUS
 * (`device.createRenderPipeline`) and costs 300–500 ms — a hard frame freeze.
 * It is cheap/deferred on WebGL, so the stutter only shows on WebGPU. Games hit
 * this by creating one light per lamp/keycard/etc. and toggling `light.visible`
 * (or removing lights on pickup/spawn) to cap how many are "on".
 *
 * THE FIX this class implements: keep a constant number of always-`visible`
 * `THREE.PointLight`s and, each frame, point them at the nearest "logical" light
 * sources — updating only `position`/`color`/`intensity`/`distance`/`decay`,
 * which are shader UNIFORMS (no recompile). A pool slot with no source is parked
 * at `intensity = 0` but stays visible, so the count never changes.
 *
 * Mutate the source objects in place (e.g. flicker `intensity`) — the pool reads
 * them live each tick.
 */

/** A "logical" light the pool can point a real light at. Mutate fields in place to animate. */
export interface PointLightSource {
    position: THREE.Vector3;
    color: THREE.Color;
    intensity: number;
    distance: number;
    decay: number;
}

export interface PointLightPoolOptions {
    /** Number of real PointLights — constant for the pool's lifetime. */
    poolSize: number;
    /** When true the pool auto-ticks from GameEngine using the camera world position. */
    focusFromCamera: boolean;
    /**
     * Stickiness (meters): a source already lit by a slot keeps it unless another
     * source is closer by more than this margin. Avoids slots flapping between
     * near-equidistant sources (which would pop a light back and forth).
     */
    reassignHysteresis: number;
}

export const DEFAULT_POINT_LIGHT_POOL_OPTIONS: PointLightPoolOptions = {
    poolSize: 4,
    focusFromCamera: true,
    reassignHysteresis: 2,
};

/** Pools that opted into camera-driven ticking; driven by `updatePointLightPoolsFromCamera`. */
const _cameraPools = new Set<PointLightPool>();

/**
 * @internal Tick every `focusFromCamera` pool with the camera world position.
 * Called once per frame by `GameEngine.animate()`.
 */
export function updatePointLightPoolsFromCamera(cameraWorldPosition: THREE.Vector3): void {
    for (const pool of _cameraPools) pool.aimAt(cameraWorldPosition);
}

export class PointLightPool {
    private readonly scene: THREE.Scene;
    private readonly opts: PointLightPoolOptions;
    private readonly group: THREE.Group;
    private readonly lights: THREE.PointLight[] = [];
    private sources: PointLightSource[] = [];
    /** Source index each slot currently lights, or -1 when parked. Drives stickiness. */
    private readonly slotSource: number[] = [];
    private disposed = false;

    constructor(scene: THREE.Scene, opts: PointLightPoolOptions) {
        this.scene = scene;
        this.opts = opts;
        this.group = new THREE.Group();
        this.group.name = 'PointLightPool';
        for (let i = 0; i < opts.poolSize; i++) {
            const light = new THREE.PointLight(0xffffff, 0, 0, 2);
            // Set ONCE. Never toggle .visible at runtime — that changes the count.
            light.visible = true;
            light.name = 'PooledPointLight';
            this.lights.push(light);
            this.group.add(light);
            this.slotSource.push(-1);
        }
        scene.add(this.group);
        if (opts.focusFromCamera) _cameraPools.add(this);
    }

    /** Number of real lights in the pool (constant). */
    get size(): number {
        return this.lights.length;
    }

    /**
     * Replace the set of logical sources. Cheap; call whenever sources are
     * added/removed/relocated. Does NOT change the real light count.
     */
    setSources(sources: PointLightSource[]): void {
        this.sources = sources;
        // Forget assignments that point past the new list so stale slots re-pick.
        for (let s = 0; s < this.slotSource.length; s++) {
            if (this.slotSource[s]! >= sources.length) this.slotSource[s] = -1;
        }
    }

    /**
     * Aim the pool at the nearest sources to `focus`. Keeps a slot on its current
     * source unless a closer one wins by more than `reassignHysteresis`. Slots
     * with no source are parked at `intensity = 0` (still visible). Call once per
     * frame (or let `focusFromCamera` pools tick automatically from GameEngine).
     */
    aimAt(focus: THREE.Vector3): void {
        if (this.disposed) return;
        const sources = this.sources;
        const K = this.lights.length;

        if (sources.length === 0) {
            for (let s = 0; s < K; s++) {
                this.lights[s]!.intensity = 0;
                this.slotSource[s] = -1;
            }
            return;
        }

        // Sources currently held by a slot get a stickiness bonus so they aren't
        // swapped out by a marginally-closer rival.
        const held = new Set<number>();
        for (const si of this.slotSource) if (si >= 0) held.add(si);

        // Select the K lowest-score sources (score = distance − stickiness bonus).
        const chosen: number[] = [];
        const chosenScore: number[] = [];
        for (let i = 0; i < sources.length; i++) {
            const p = sources[i]!.position;
            const dx = p.x - focus.x, dy = p.y - focus.y, dz = p.z - focus.z;
            let score = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (held.has(i)) score -= this.opts.reassignHysteresis;
            if (chosen.length < K) {
                chosen.push(i);
                chosenScore.push(score);
            } else {
                let worst = 0;
                for (let c = 1; c < chosen.length; c++) if (chosenScore[c]! > chosenScore[worst]!) worst = c;
                if (score < chosenScore[worst]!) {
                    chosen[worst] = i;
                    chosenScore[worst] = score;
                }
            }
        }
        const chosenSet = new Set(chosen);

        // Keep slots whose source is still chosen; free the rest.
        const stillHeld = new Set<number>();
        for (let s = 0; s < K; s++) {
            const si = this.slotSource[s]!;
            if (si >= 0 && chosenSet.has(si)) stillHeld.add(si);
            else this.slotSource[s] = -1;
        }

        // Assign freed slots to chosen sources that no slot holds yet.
        const unheld: number[] = [];
        for (const ci of chosen) if (!stillHeld.has(ci)) unheld.push(ci);
        let u = 0;
        for (let s = 0; s < K; s++) {
            if (this.slotSource[s] === -1 && u < unheld.length) this.slotSource[s] = unheld[u++]!;
        }

        // Apply each slot (uniform-only writes — no recompile).
        for (let s = 0; s < K; s++) {
            const light = this.lights[s]!;
            const si = this.slotSource[s]!;
            if (si >= 0) {
                const src = sources[si]!;
                light.position.copy(src.position);
                light.color.copy(src.color);
                light.intensity = src.intensity;
                light.distance = src.distance;
                light.decay = src.decay;
            } else {
                light.intensity = 0; // parked but still visible — count stays constant
            }
        }
    }

    /** Remove all pool lights from the scene and stop auto-ticking. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        _cameraPools.delete(this);
        this.scene.remove(this.group);
        for (const light of this.lights) {
            this.group.remove(light);
            light.dispose();
        }
        this.lights.length = 0;
        this.sources = [];
        this.slotSource.length = 0;
    }
}
