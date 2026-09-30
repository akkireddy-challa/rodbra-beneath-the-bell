/**
 * Animates smart objects: the one runtime for every prop whose `.vxl` carries
 * a v12 parts table — windmill blades, ferris wheels, swinging signs.
 *
 * Owned by GameEngine (created on first use, ticked from the simulation loop,
 * disposed with the world systems). `EnvironmentObjectSystem` hands each placed
 * instance of a smart asset over with `attach()`: the instance's own mesh is
 * hidden and a `SmartObjectView` — per-part meshes under pivot groups — takes
 * its place as a child, so the instance keeps its transform, its physics body
 * and its id, and only what draws changes.
 *
 * Motion is a function of elapsed gameplay time, not of accumulated per-frame
 * rotation, so two clients that loaded at different moments still agree on
 * where a wheel is, and a paused game holds still. The vocabulary is the closed
 * one the Forger's analysis chooses from (`VxlV3PartMotion`):
 *
 * - `spin`: rotation about `axis` through the pivot, `rpm` revolutions per minute.
 * - `upright`: the part stays level while its ancestors turn — a cabin hanging
 *   from a wheel. Implemented as the inverse of the accumulated ancestor
 *   rotation, which is what a hinge under gravity does without the physics.
 * - `pendulum`: `amplitudeDeg` either side of rest, one swing per `periodS`.
 *
 * Game code reaches it through `engine.getSmartObjectSystem()` to change a
 * speed or stop a part; those overrides are per instance and per part.
 */

import * as THREE from 'three';
import { SmartObjectView } from 'engine/SmartObjectView.js';
import type { VxlV3Part } from 'engine/VxlV3Parts.js';
import type { SmartObjectFitment } from 'types/smartObject.js';

/** What `attach()` needs from the instance — `VoxelObject` satisfies it. */
export interface SmartObjectHost extends THREE.Object3D {
    getDecodedVxlV3(): { parts?: VxlV3Part[]; rig?: { bindPositions: Float32Array } } | null;
    buildSmartPartMeshes(): Array<{ joint: number; mesh: THREE.Mesh }> | null;
    getMesh(): THREE.Mesh | null;
    getPivot(): { x: number; y: number; z: number } | null;
}

interface SmartObjectEntry {
    id: string;
    host: SmartObjectHost;
    view: SmartObjectView;
    fitment: SmartObjectFitment;
    /** Per-part speed multiplier; 1 = as authored, 0 = stopped. */
    speedScale: number[];
    /** Per-part phase offset in radians, so `setAngle` is possible without a time jump. */
    phase: number[];
    paused: boolean;
}

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

export class SmartObjectSystem {
    private readonly entries = new Map<string, SmartObjectEntry>();
    private elapsed = 0;
    private disposed = false;

    // Scratch, reused every frame — a ferris wheel has nine parts and this runs
    // for every placed instance.
    private readonly axis = new THREE.Vector3();
    private readonly accumulated: THREE.Quaternion[] = [];

    /**
     * Take over the drawing of `host`: build the part view from its decoded
     * file, hide its single mesh, and start animating. Returns false when the
     * host's file has no parts (nothing to do), or when it is already attached.
     */
    attach(id: string, host: SmartObjectHost, fitment: SmartObjectFitment): boolean {
        if (this.disposed || this.entries.has(id)) return false;
        const decoded = host.getDecodedVxlV3();
        const parts = decoded?.parts;
        const rig = decoded?.rig;
        if (!parts || parts.length === 0 || !rig) return false;
        const meshes = host.buildSmartPartMeshes();
        if (!meshes || meshes.length === 0) return false;

        const view = new SmartObjectView({
            parts,
            bindPositions: rig.bindPositions,
            meshes,
            pivot: host.getPivot() ?? undefined,
        });
        const own = host.getMesh();
        if (own) own.visible = false;
        host.add(view);

        this.entries.set(id, {
            id, host, view, fitment,
            speedScale: parts.map(() => 1),
            phase: parts.map(() => 0),
            paused: false,
        });
        return true;
    }

    /** Stop animating and restore the host's own mesh. */
    detach(id: string): void {
        const entry = this.entries.get(id);
        if (!entry) return;
        this.entries.delete(id);
        entry.host.remove(entry.view);
        entry.view.disposeMeshes();
        const own = entry.host.getMesh();
        if (own) own.visible = true;
    }

    /** Ids of every attached instance. */
    ids(): string[] {
        return [...this.entries.keys()];
    }

    /** The part names of an attached instance, in joint order. */
    partsOf(id: string): string[] {
        return this.entries.get(id)?.view.parts.map((part) => part.name) ?? [];
    }

    /**
     * Scale a part's authored speed: 0 stops it, 1 restores it, 2 doubles it.
     * A negative value reverses a spin. Returns false for an unknown id or part.
     */
    setPartSpeed(id: string, partName: string, scale: number): boolean {
        const entry = this.entries.get(id);
        if (!entry) return false;
        const index = entry.view.parts.findIndex((part) => part.name === partName);
        if (index < 0) return false;
        // Re-phase so the part does not jump when its rate changes: the angle at
        // this instant stays the same under the new scale.
        entry.phase[index] = entry.phase[index]! + this.elapsed * (entry.speedScale[index]! - scale);
        entry.speedScale[index] = scale;
        return true;
    }

    /** Freeze or resume every part of one instance. */
    setPaused(id: string, paused: boolean): boolean {
        const entry = this.entries.get(id);
        if (!entry) return false;
        entry.paused = paused;
        return true;
    }

    /** The pivot group of a part, for game code that wants to attach something to it. */
    pivotOf(id: string, partName: string): THREE.Object3D | null {
        return this.entries.get(id)?.view.pivotOf(partName) ?? null;
    }

    /**
     * The world position, now, of an asset-frame point riding `partName` of
     * instance `id` — a light's `offset` on a cabin, a smoke emitter on a
     * chimney cap. False when the instance is not attached or has no such part,
     * so the caller keeps its static placement.
     */
    anchorToWorld(id: string, partName: string, point: { x: number; y: number; z: number }, out: THREE.Vector3): boolean {
        const entry = this.entries.get(id);
        return entry ? entry.view.assetPointOnPartToWorld(partName, point, out) : false;
    }

    /** Advance by `deltaTime` seconds of gameplay time and pose every part. */
    update(deltaTime: number): void {
        if (this.disposed) return;
        this.elapsed += deltaTime;
        for (const entry of this.entries.values()) {
            // An instance the environment system tore down (level switch, reload)
            // leaves the scene without telling us; drop it here rather than pose
            // an orphan forever.
            if (!entry.host.parent) {
                this.entries.delete(entry.id);
                entry.view.disposeMeshes();
                continue;
            }
            if (entry.paused) continue;
            this.pose(entry);
        }
    }

    private pose(entry: SmartObjectEntry): void {
        const { view } = entry;
        const jointCount = view.parts.length + 1;
        while (this.accumulated.length < jointCount) this.accumulated.push(new THREE.Quaternion());
        this.accumulated[0]!.identity();

        for (let joint = 1; joint < jointCount; joint++) {
            const part = view.parts[joint - 1]!;
            const group = view.pivots[joint]!;
            const parentAccumulated = this.accumulated[part.parentJoint]!;
            const t = this.elapsed * entry.speedScale[joint - 1]! + entry.phase[joint - 1]!;
            const motion = part.motion;

            switch (motion.kind) {
                case 'spin': {
                    this.axis.set(motion.axis[0], motion.axis[1], motion.axis[2]).normalize();
                    group.quaternion.setFromAxisAngle(this.axis, t * motion.rpm * TWO_PI / 60);
                    break;
                }
                case 'pendulum': {
                    this.axis.set(motion.axis[0], motion.axis[1], motion.axis[2]).normalize();
                    const period = motion.periodS > 0 ? motion.periodS : 1;
                    group.quaternion.setFromAxisAngle(this.axis, motion.amplitudeDeg * DEG * Math.sin(TWO_PI * t / period));
                    break;
                }
                case 'upright': {
                    // Level = undo everything the ancestors did.
                    group.quaternion.copy(parentAccumulated).invert();
                    break;
                }
                default:
                    group.quaternion.identity();
            }
            // This joint's rotation in the asset frame, for its own children.
            // Parents come first in the table, so this never aliases the parent.
            this.accumulated[joint]!.copy(parentAccumulated).multiply(group.quaternion);
        }
    }

    /** Elapsed gameplay seconds the poses are a function of. */
    getElapsed(): number {
        return this.elapsed;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const id of [...this.entries.keys()]) this.detach(id);
    }
}
