/**
 * Pulsing highlight on every instance of an asset whose high-quality version is
 * being generated in the background.
 *
 * Generation takes minutes and used to be completely invisible: the object sat there
 * looking exactly as before, with nothing to say work was underway, until the game
 * suddenly reloaded with a new mesh. This makes the wait legible in the world itself.
 *
 * Two constraints shaped the implementation:
 *
 *  - **Environment objects share ONE material** (`EnvironmentObjectSystem.environmentMaterial`),
 *    so setting `emissive` on it would light up the entire scene. Each highlighted mesh
 *    therefore gets a CLONE, restored (and disposed) when the highlight clears.
 *  - The pulse drives itself off `requestAnimationFrame` rather than the engine update
 *    loop. It only runs while something is generating, and keeping it out of the render
 *    path means a highlight can never affect frame pacing or game logic.
 *
 * Highlights are keyed by environment TYPE name, which is what the object system indexes
 * meshes by; the caller maps asset ids to type names.
 */

import * as THREE from 'three';

/** Emissive colour of the "being generated" pulse — the accent aqua the editor uses. */
const GLOW_COLOR = 0x4ad8c0;
/** Emissive intensity range and period of the breathing pulse. */
const GLOW_MIN = 0.12;
const GLOW_MAX = 0.85;
const PULSE_PERIOD_MS = 1600;

interface Highlighted {
    mesh: THREE.Mesh;
    original: THREE.Material | THREE.Material[];
    clones: THREE.MeshStandardMaterial[];
}

export interface HqGlowDeps {
    /** Every rendered mesh for the given environment type names (packed + unpacked). */
    collectMeshesForTypes(typeNames: Set<string>): THREE.Object3D[];
}

export class HqGenerationGlow {
    private deps: HqGlowDeps;
    private activeTypes = new Set<string>();
    private highlighted: Highlighted[] = [];
    private rafId: number | null = null;
    private startedAt = 0;

    constructor(deps: HqGlowDeps) {
        this.deps = deps;
    }

    /** Type names currently glowing (for callers that need to re-apply after a rebuild). */
    getActiveTypes(): ReadonlySet<string> {
        return this.activeTypes;
    }

    /**
     * Replace the glowing set. Idempotent: passing the same names again re-resolves the
     * meshes, which is what makes this safe to call after the object system unpacks a
     * type (a click) or rebuilds its meshes mid-generation.
     */
    setGeneratingTypes(typeNames: Iterable<string>): void {
        const next = new Set(typeNames);
        this.clearMaterials();
        this.activeTypes = next;
        if (next.size === 0) {
            this.stopPulse();
            return;
        }
        for (const obj of this.deps.collectMeshesForTypes(next)) {
            const mesh = obj as THREE.Mesh;
            if (!mesh.material) continue;
            const original = mesh.material;
            const mats = Array.isArray(original) ? original : [original];
            const clones = mats.map((m) => {
                const clone = (m as THREE.MeshStandardMaterial).clone() as THREE.MeshStandardMaterial;
                clone.emissive = new THREE.Color(GLOW_COLOR);
                clone.emissiveIntensity = GLOW_MIN;
                return clone;
            });
            mesh.material = Array.isArray(original) ? clones : clones[0]!;
            this.highlighted.push({ mesh, original, clones });
        }
        if (this.highlighted.length > 0) this.startPulse();
        else this.stopPulse();
    }

    /** Stop all highlighting and restore original materials. */
    clear(): void {
        this.setGeneratingTypes([]);
    }

    dispose(): void {
        this.clear();
    }

    private clearMaterials(): void {
        for (const h of this.highlighted) {
            h.mesh.material = h.original;
            for (const c of h.clones) c.dispose();
        }
        this.highlighted = [];
    }

    private startPulse(): void {
        if (this.rafId !== null) return;
        this.startedAt = performance.now();
        const tick = (now: number): void => {
            // Cosine breathe: no discontinuity at the wrap, unlike a sawtooth.
            const phase = ((now - this.startedAt) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
            const level = GLOW_MIN + (GLOW_MAX - GLOW_MIN) * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
            for (const h of this.highlighted) {
                for (const c of h.clones) c.emissiveIntensity = level;
            }
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    private stopPulse(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
}
