import * as THREE from 'three';
import type { GameData, Asset, AssetLightEmitter, Vector3Like } from 'types/game.js';
import { PointLightPool, type PointLightSource } from 'engine/PointLightPool.js';
import { getActiveLevelIdOrNull } from 'engine/levels/levelManagerRegistry.js';
import { isInstanceInActiveLevel } from 'engine/levels/levelResolve.js';

/**
 * Turns placed environment objects into light sources.
 *
 * Assets opt in via the world.json `light` block (see AssetLightEmitter in
 * types/game.ts); every world.json instance of such an asset becomes a logical
 * emitter here. Real THREE.PointLights are budgeted through a constant-count
 * PointLightPool — the pool aims the few real lights at the emitters nearest
 * the camera each frame (WebGPU-recompile-safe, cheap on WebGL), so a dungeon
 * can place forty torches and still pay for six lights.
 *
 * Emitter positions are derived from world.json instance placements at load
 * time (position + rotated local offset). Editor drags don't move an emitter
 * live — positions refresh on the next game reload, matching the agent's
 * edit-then-reload flow. The exception is a light that rides a smart-object
 * part (`AssetLightEmitter.part`: a lantern on a ferris-wheel cabin): every
 * frame `followSmartParts` asks the smart-object system where that part's
 * pivot is now and moves the emitter with it, falling back to the rest
 * placement while the instance is not attached.
 *
 * Owned by GameEngine: created in loadGame() when any placed asset emits,
 * flicker-updated from animate(), disposed on the next loadGame().
 */

export interface EnvironmentLightOptions {
    /** Real lights in the pool — constant for the system's lifetime. */
    poolSize: number;
}

export const DEFAULT_ENVIRONMENT_LIGHT_OPTIONS: EnvironmentLightOptions = {
    // Real dynamic lights active at once: the pool aims these at the nearest
    // emitters and parks the rest. 6 gives rich, overlapping pools of torch/lamp
    // light in a dark scene. Fragment cost of a handful of point lights is
    // negligible on this renderer (measured ~1 ms total render time with 6
    // lights + a full dungeon), so this is a look knob, not a perf one.
    poolSize: 6,
};

/** Per-emitter defaults when the asset's `light` block omits a field. */
const DEFAULT_EMITTER_COLOR = '#ffa040';
const DEFAULT_EMITTER_INTENSITY = 12;
const DEFAULT_EMITTER_DISTANCE = 10;
/** Peak fractional intensity swing of the torch flicker. */
const FLICKER_AMOUNT = 0.25;

/** Every emitter an asset declares: the single `light` first, then `lights[]`. */
function emittersOf(asset: Asset): readonly AssetLightEmitter[] {
    return asset.light ? [asset.light, ...(asset.lights ?? [])] : (asset.lights ?? []);
}

/** The game's light-emitting assets, by id. */
function emittingAssetsById(gameData: GameData): Map<string, Asset> {
    const byId = new Map<string, Asset>();
    for (const asset of gameData.assets ?? []) {
        if (emittersOf(asset).length > 0) byId.set(asset.id, asset);
    }
    return byId;
}

/** A placed instance, narrowed to the fields an emitter placement reads. */
interface PlacedInstance {
    id?: string;
    assetId?: string;
    position?: Vector3Like;
    rotation?: Vector3Like;
    levelId?: string;
}

/** The game's placed instances — `environmentObjects` is untyped and may be absent. */
function instancesOf(gameData: GameData): PlacedInstance[] {
    return Array.isArray(gameData.environmentObjects) ? gameData.environmentObjects : [];
}

interface FlickerEntry {
    source: PointLightSource;
    baseIntensity: number;
    phase: number;
}

/** An emitter that rides a smart-object part: re-based onto the part every frame. */
interface RiderEntry {
    source: PointLightSource;
    instanceId: string;
    part: string;
    /** The record's `offset`, in the asset frame — what `anchorToWorld` re-bases. */
    offset: Vector3Like;
}

/** What `followSmartParts` needs from `SmartObjectSystem`. */
export interface SmartPartAnchors {
    anchorToWorld(id: string, partName: string, point: Vector3Like, out: THREE.Vector3): boolean;
}

export class EnvironmentLightSystem {
    private readonly pool: PointLightPool;
    private readonly sources: PointLightSource[] = [];
    private readonly flickering: FlickerEntry[] = [];
    private readonly riders: RiderEntry[] = [];
    private disposed = false;

    constructor(scene: THREE.Scene, options: EnvironmentLightOptions) {
        this.pool = new PointLightPool(scene, {
            poolSize: options.poolSize,
            focusFromCamera: true, // aimed by GameEngine's per-frame pool tick
            reassignHysteresis: 2,
        });
    }

    /**
     * Whether the game has any placed instance of a light-emitting asset —
     * lets GameEngine skip creating the system (and its pooled lights: even
     * parked lights cost per-fragment shader work) for the common no-lights game.
     */
    static gameDataHasEmitters(gameData: GameData): boolean {
        const emittingAssets = emittingAssetsById(gameData);
        if (emittingAssets.size === 0) return false;
        return instancesOf(gameData).some((inst) => !!inst.assetId && emittingAssets.has(inst.assetId));
    }

    /**
     * Build the emitter list from world.json data (assets[].light × their
     * environmentObjects[] instances). Replaces any previous emitter set.
     */
    initFromGameData(gameData: GameData): void {
        this.clearEmitters();

        const emittingAssets = emittingAssetsById(gameData);
        // Levels mode: emit only for the active level's instances (untagged = global).
        const activeLevelId = getActiveLevelIdOrNull();
        const euler = new THREE.Euler();
        for (const inst of instancesOf(gameData)) {
            if (!inst.assetId || !inst.position) continue;
            if (!isInstanceInActiveLevel(inst, activeLevelId)) continue;
            const asset = emittingAssets.get(inst.assetId);
            if (!asset) continue;

            // `light` plus `lights[]`: a smart object's lamp heads, a candelabra.
            for (const light of emittersOf(asset)) {
                const offset = this.resolveOffset(asset, light);
                euler.set(inst.rotation?.x ?? 0, inst.rotation?.y ?? 0, inst.rotation?.z ?? 0);
                offset.applyEuler(euler);

                const source: PointLightSource = {
                    position: new THREE.Vector3(
                        inst.position.x + offset.x,
                        inst.position.y + offset.y,
                        inst.position.z + offset.z,
                    ),
                    color: new THREE.Color(light.color ?? DEFAULT_EMITTER_COLOR),
                    intensity: light.intensity ?? DEFAULT_EMITTER_INTENSITY,
                    distance: light.distance ?? DEFAULT_EMITTER_DISTANCE,
                    decay: 2, // physical inverse-square falloff
                };
                this.sources.push(source);

                if (light.flicker) {
                    this.flickering.push({
                        source,
                        baseIntensity: source.intensity,
                        // Spread phases so a row of torches doesn't pulse in sync.
                        phase: this.sources.length * 2.399, // golden-angle spacing
                    });
                }
                // The rest placement above stands until the smart-object system
                // attaches the instance; from then on the emitter follows the part.
                if (light.part && light.offset && inst.id) {
                    this.riders.push({ source, instanceId: inst.id, part: light.part, offset: light.offset });
                }
            }
        }

        this.pool.setSources(this.sources);
        if (this.sources.length > 0) {
            console.log(`💡 EnvironmentLightSystem: ${this.sources.length} emitters (${this.flickering.length} flickering), pool of ${this.pool.size} lights`);
        }
    }

    /** Drop every emitter record — shared by a rebuild and by dispose(). */
    private clearEmitters(): void {
        this.sources.length = 0;
        this.flickering.length = 0;
        this.riders.length = 0;
    }

    /** Emitter anchor in asset-local space: explicit offset, or the bbox top (flame height). */
    private resolveOffset(asset: Asset, light: AssetLightEmitter): THREE.Vector3 {
        if (light.offset) {
            return new THREE.Vector3(light.offset.x, light.offset.y, light.offset.z);
        }
        const topY = asset.boundingBox?.maxY ?? 1.0;
        return new THREE.Vector3(0, topY, 0);
    }

    /**
     * Move every part-riding emitter to where its part is now. Call once per
     * frame BEFORE the pool aims, since the pool copies source positions into
     * the real lights as it aims. An instance the system has not attached (a
     * static bake, a level not yet loaded) keeps its rest placement.
     */
    followSmartParts(smart: SmartPartAnchors | null): void {
        if (this.disposed || !smart) return;
        for (const rider of this.riders) {
            smart.anchorToWorld(rider.instanceId, rider.part, rider.offset, rider.source.position);
        }
    }

    /** Whether any emitter rides a smart-object part. */
    hasRiders(): boolean {
        return this.riders.length > 0;
    }

    /** Animate flickering emitters. Call once per frame with elapsed seconds. */
    updateFlicker(elapsedSeconds: number): void {
        if (this.disposed) return;
        for (const entry of this.flickering) {
            // Two incommensurate sines read as organic flame wander without
            // per-frame random (deterministic, no GC pressure).
            const n = Math.sin(elapsedSeconds * 11 + entry.phase) * 0.6
                + Math.sin(elapsedSeconds * 23 + entry.phase * 1.7) * 0.4;
            entry.source.intensity = entry.baseIntensity * (1 + FLICKER_AMOUNT * n);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.pool.dispose();
        this.clearEmitters();
    }
}
