/**
 * A translucent, non-colliding car driven by a recorded run.
 *
 * Built from a `VehicleDescriptor` — the same contract multiplayer already uses
 * to describe someone else's car — but deliberately NOT built on
 * `NetworkVehicleController`. That class drives its transform through
 * `NetworkObject.updateInterpolation()`, which adds a fixed interpolation delay
 * and dead reckoning. Both are correct for a live remote player over a lossy
 * link and wrong here: a ghost's pose is known exactly for every moment of the
 * run, and a lag between where the ghost is drawn and where the recorded car
 * actually was turns "did I beat it into that corner" into a lie.
 *
 * So the transform comes straight from `ReplayPlayer`, addressed by run time.
 * Wheel spin and steering are derived the same way the network ghost derives
 * them, because those genuinely are derived quantities.
 */

import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { VehicleDescriptor } from 'engine/networking/NetworkTypes.js';
import type { EngineLike } from 'types/game.js';
import { VehiclePlatformBuilder } from 'engine/VehiclePlatform.js';
import { DEFAULT_WHEEL_COLOR } from 'engine/vehicle/PlatformVehicleParts.js';
import {
    DEFAULT_GHOST_MATERIAL_OPTIONS,
    applyGhostMaterial,
    disposeGhostMaterials,
    type GhostMaterialOptions,
} from 'engine/replay/GhostMaterial.js';
import { MOTION_TRACK, VEHICLE_WHEEL_SLOTS } from 'engine/replay/ReplayChannels.js';
import type { ReplayPlayer, ReplayTrackReader } from 'engine/replay/ReplayPlayer.js';

const _steerQuat = new THREE.Quaternion();
const _spinQuat = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);
/** Cylinders are Y-up; wheels roll about X. */
const _cylinderAlign = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);

/**
 * A shadowless ghost part.
 *
 * 'matte' throughout the ghost: the old bare Standard (roughness 1, metalness
 * 0) WAS the matte look, and `applyGhostMaterial` clones these into the
 * translucent presentation — same read, cheaper on every tier.
 */
function ghostMesh(geometry: THREE.BufferGeometry, color: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, createClassedPartMaterial('matte', { color }));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
}

/**
 * Copy an object's VISUALS only — geometry, materials, transforms, hierarchy.
 *
 * 🚫 Not `Object3D.clone()`. That calls `Object3D.copy()`, which deep-copies
 * userData through `JSON.parse(JSON.stringify(...))`. A live vehicle's chassis
 * carries Rapier handles in userData, and `colliderSet` closes a reference
 * cycle, so cloning it throws "Converting circular structure to JSON" and the
 * ghost silently never appears.
 *
 * Geometry and materials are SHARED here. Materials are cloned immediately
 * afterwards by `applyGhostMaterial`; geometry stays shared on purpose, which
 * is why dispose() must never free it.
 */
function cloneVisualOnly(source: THREE.Object3D): THREE.Object3D {
    const mesh = source as THREE.Mesh;
    let copy: THREE.Object3D;
    if (mesh.isMesh) {
        const meshCopy = new THREE.Mesh(mesh.geometry, mesh.material);
        meshCopy.castShadow = false;
        meshCopy.receiveShadow = false;
        meshCopy.renderOrder = mesh.renderOrder;
        copy = meshCopy;
    } else {
        copy = new THREE.Group();
    }

    copy.name = source.name;
    copy.visible = source.visible;
    copy.position.copy(source.position);
    copy.quaternion.copy(source.quaternion);
    copy.scale.copy(source.scale);
    // Deliberately NOT source.userData — that is the circular structure.
    copy.userData = { excludeFromSplatExport: true };

    for (const child of source.children) copy.add(cloneVisualOnly(child));
    return copy;
}

interface GhostWheel {
    mesh: THREE.Mesh;
    position: THREE.Vector3;
    suspensionRestLength: number;
    isSteering: boolean;
    /** Integrated spin angle. Absolute phase is arbitrary; only its rate reads. */
    phase: number;
}

export interface GhostVehicleOptions {
    material: GhostMaterialOptions;
    /**
     * Engine reference, needed to load asset visuals when the descriptor names
     * an `assetId`. Without it the ghost stays boxes and cylinders.
     */
    engine: EngineLike | null;
    /**
     * The live vehicle's chassis object, CLONED for the ghost body.
     *
     * By far the best source when the ghost is the same car the player is
     * driving: it is exact, synchronous, and needs no asset lookup. Rebuilding
     * a body from a `VehicleDescriptor` is guesswork by comparison — the box
     * only ever matches a car that happens to be box-shaped, and sizing it from
     * collision extents renders the bare 15 cm platform when the body's
     * colliders are visual-only.
     *
     * Null falls back to the descriptor's boxes.
     */
    bodyTemplate: THREE.Object3D | null;
}

export const DEFAULT_GHOST_VEHICLE_OPTIONS: GhostVehicleOptions = {
    material: DEFAULT_GHOST_MATERIAL_OPTIONS,
    engine: null,
    bodyTemplate: null,
};

/** Channel indices resolved once, so playback does no string lookups per frame. */
interface MotionChannels {
    posX: number;
    posY: number;
    posZ: number;
    rot: number;
    steer: number;
    /** Per-wheel angular velocity, -1 where the run did not record that slot. */
    wheelW: number[];
}

function resolveMotionChannels(reader: ReplayTrackReader): MotionChannels {
    const wheelW: number[] = [];
    for (let i = 0; i < VEHICLE_WHEEL_SLOTS; i++) wheelW.push(reader.indexOf(`wheelW${i}`));
    return {
        posX: reader.indexOf('posX'),
        posY: reader.indexOf('posY'),
        posZ: reader.indexOf('posZ'),
        rot: reader.indexOf('rot'),
        steer: reader.indexOf('steer'),
        wheelW,
    };
}

export class GhostVehicle {
    private readonly root = new THREE.Group();
    private readonly wheels: GhostWheel[] = [];
    /** Chassis + body-part meshes, so an asset upgrade can replace them. */
    private readonly bodyMeshes: THREE.Mesh[] = [];
    private readonly materialOptions: GhostMaterialOptions;
    private readonly channels: MotionChannels;
    private readonly motion: ReplayTrackReader;
    private disposed = false;

    constructor(
        private readonly player: ReplayPlayer,
        descriptor: VehicleDescriptor,
        options: GhostVehicleOptions,
    ) {
        const motion = player.getTrack(MOTION_TRACK);
        if (!motion) {
            throw new Error(`GhostVehicle: run has no '${MOTION_TRACK}' track`);
        }
        this.motion = motion;
        this.channels = resolveMotionChannels(motion);
        this.materialOptions = options.material;

        this.root.name = 'GhostVehicle';
        const cloned = this.buildFromTemplate(options.bodyTemplate);
        if (!cloned) {
            this.buildChassis(descriptor);
            this.buildBodyParts(descriptor);
        }
        this.buildWheels(descriptor);
        applyGhostMaterial(this.root, options.material);

        // Only worth an async asset load when there was nothing to clone —
        // a ghost of a car the player is not currently driving.
        if (!cloned && descriptor.assetId && options.engine) {
            void this.upgradeToAssetVisuals(options.engine, descriptor);
        }
    }

    /**
     * Clone the live vehicle's body.
     *
     * `getChassisObject()` returns the group the renderer built — for an asset
     * vehicle that is the real voxel body, already positioned at the platform's
     * top surface. Cloning it gives a ghost that matches the car exactly, with
     * no descriptor, no asset id, and nothing to load.
     *
     * The group carries the live car's WORLD position, so the clone is zeroed:
     * the ghost's own root supplies that, and the body child keeps its local
     * lift.
     */
    private buildFromTemplate(template: THREE.Object3D | null): boolean {
        if (!template) return false;
        const clone = cloneVisualOnly(template);
        // Scale is the template's (cloneVisualOnly copied it); the world pose is not.
        clone.position.set(0, 0, 0);
        clone.quaternion.identity();
        this.root.add(clone);
        this.bodyMeshes.push(clone as THREE.Mesh);
        return true;
    }

    /**
     * Replace the box body and cylinder wheels with the vehicle asset's own.
     *
     * Without this a ghost of a detailed kart renders as a flat slab, which
     * reads as a bug rather than as a ghost. Same load path the multiplayer
     * ghost uses, so the two stay visually consistent.
     */
    private async upgradeToAssetVisuals(engine: EngineLike, descriptor: VehicleDescriptor): Promise<void> {
        const assetId = descriptor.assetId;
        if (!assetId) return;
        try {
            const assets = engine.getGameData?.()?.assets;
            const asset = assets?.find((a) => a.id === assetId) ?? assets?.find((a) => a.name === assetId);
            const fitment = asset?.vehicleFitment;
            if (!asset || !fitment) return;

            const { loadVehicleAssetVisual, wheelMeshForAxleSide } =
                await import('engine/vehicle/VehicleAssetVisual.js');
            const visual = await loadVehicleAssetVisual(engine, asset, fitment);
            if (this.disposed) return;

            // Body: drop the box chassis and parts, mount the asset body.
            for (const mesh of this.bodyMeshes) {
                mesh.removeFromParent();
                mesh.geometry.dispose();
            }
            this.bodyMeshes.length = 0;
            // The engine's own convention: the chassis origin is the centre of
            // the 15 cm platform slab, and the asset body mounts on its TOP
            // surface (VehicleSpawner: `bodyLiftY = PLATFORM_HEIGHT / 2`).
            // Using half the descriptor's chassis height instead lifted the
            // body by half the CAR's height, floating it above the wheels.
            visual.chassisObject.position.set(0, VehiclePlatformBuilder.PLATFORM_HEIGHT / 2, 0);
            this.root.add(visual.chassisObject);
            this.bodyMeshes.push(visual.chassisObject as THREE.Mesh);

            // Wheels: swap each cylinder for the asset's wheel at that corner.
            for (const wheel of this.wheels) {
                const axle = fitment.axles.reduce((best, candidate) =>
                    Math.abs(candidate.z - wheel.position.z) < Math.abs(best.z - wheel.position.z)
                        ? candidate : best);
                const side: 1 | -1 = wheel.position.x >= 0 ? 1 : -1;
                const replacement = wheelMeshForAxleSide(visual, axle, side);
                replacement.userData.excludeFromSplatExport = true;
                wheel.mesh.removeFromParent();
                wheel.mesh.geometry.dispose();
                this.root.add(replacement);
                wheel.mesh = replacement;
            }

            // The swapped-in meshes carry the asset's opaque materials.
            applyGhostMaterial(this.root, this.materialOptions);
        } catch (error) {
            console.warn(`[GhostVehicle] asset visuals failed for ${assetId} — keeping the box ghost:`, error);
        }
    }

    /** Add to a scene. The ghost has no physics body and no collider by construction. */
    getObject3D(): THREE.Object3D {
        return this.root;
    }

    /**
     * Place the ghost at `elapsedMs` into the run.
     *
     * Named `updateAt` rather than `update` on purpose: this is a seek, not a
     * tick. The engine convention is that `update(deltaTime)` advances state by
     * an elapsed amount, whereas a ghost is addressed by an absolute position
     * in the recording and would ignore any accumulated state.
     *
     * `deltaTime` (seconds) advances wheel spin only. Spin is integrated rather
     * than stored because it is recoverable from speed, and storing a
     * derivable quantity is how a format grows without getting better.
     */
    updateAt(elapsedMs: number, deltaTime: number): void {
        if (this.disposed) return;
        this.motion.seek(elapsedMs);

        this.root.position.set(
            this.motion.scalar(this.channels.posX),
            this.motion.scalar(this.channels.posY),
            this.motion.scalar(this.channels.posZ),
        );
        this.motion.quaternion(this.channels.rot, this.root.quaternion);

        this.updateWheels(this.motion.scalar(this.channels.steer), deltaTime);
    }

    /** True once the run clock is past the end of the recording. */
    isFinished(elapsedMs: number): boolean {
        return this.player.isFinished(elapsedMs);
    }

    setVisible(visible: boolean): void {
        this.root.visible = visible;
    }

    /**
     * Remove from the scene and release GPU resources.
     *
     * Explicit teardown, called from the owner's level-switch path: the scene
     * graph is not a registry, and ghost meshes left parented to a discarded
     * scene are exactly the leak that has bitten vehicles here before.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.root.removeFromParent();
        disposeGhostMaterials(this.root);
        // Materials are cloned per ghost and freed above. Geometry is NOT:
        // a cloned body shares buffers with the LIVE car, so disposing it here
        // would blank the player's own vehicle.
        for (const wheel of this.wheels) wheel.mesh.geometry.dispose();
        this.root.clear();
        this.wheels.length = 0;
    }

    private buildChassis(descriptor: VehicleDescriptor): void {
        const { width, height, length } = descriptor.chassisSize;
        const mesh = ghostMesh(new THREE.BoxGeometry(width, height, length), descriptor.chassisColor);
        this.root.add(mesh);
        this.bodyMeshes.push(mesh);
    }

    private buildBodyParts(descriptor: VehicleDescriptor): void {
        for (const part of descriptor.bodyParts) {
            const { width, height, length } = part.size;
            const mesh = ghostMesh(new THREE.BoxGeometry(width, height, length), part.color);
            mesh.position.set(part.position.x, part.position.y, part.position.z);
            this.root.add(mesh);
            this.bodyMeshes.push(mesh);
        }
    }

    private buildWheels(descriptor: VehicleDescriptor): void {
        for (const wheel of descriptor.wheels) {
            const mesh = ghostMesh(
                new THREE.CylinderGeometry(wheel.radius, wheel.radius, wheel.width, 16),
                wheel.color ?? DEFAULT_WHEEL_COLOR,
            );
            // Wheels hang off the root rather than under it: their world
            // transform is composed from the chassis pose plus steering and
            // spin, exactly as the network ghost does it.
            this.root.add(mesh);
            this.wheels.push({
                mesh,
                position: new THREE.Vector3(wheel.position.x, wheel.position.y, wheel.position.z),
                suspensionRestLength: wheel.suspensionRestLength,
                isSteering: wheel.isSteering,
                phase: 0,
            });
        }
    }

    /**
     * Pose the wheels in the chassis's LOCAL frame.
     *
     * They are children of the root group, so three applies the vehicle
     * transform for us. An earlier version copied the world-space position onto
     * a child, which composed the root transform twice and threw the wheels off
     * into space as soon as the car left the origin — invisible while the
     * default descriptor carried no wheels at all.
     */
    private updateWheels(steer: number, deltaTime: number): void {
        for (const [i, wheel] of this.wheels.entries()) {
            // Spin comes from the RECORDED angular velocity of that wheel, not
            // from speed. That is the whole reason it is stored: a wheel
            // outruns the car under acceleration, locks under braking, and
            // spins freely (or not at all) in the air. Integrating here also
            // sidesteps the aliasing that made storing phase impossible.
            const channel = this.channels.wheelW[i] ?? -1;
            if (channel >= 0) wheel.phase += this.motion.scalar(channel) * deltaTime;

            // Suspension is fixed at rest length — a ghost records no travel.
            wheel.mesh.position.copy(wheel.position);
            wheel.mesh.position.y -= wheel.suspensionRestLength;

            wheel.mesh.quaternion.identity();
            if (wheel.isSteering) {
                _steerQuat.setFromAxisAngle(_up, steer);
                wheel.mesh.quaternion.multiply(_steerQuat);
            }
            _spinQuat.setFromAxisAngle(_right, wheel.phase);
            wheel.mesh.quaternion.multiply(_spinQuat);
            wheel.mesh.quaternion.multiply(_cylinderAlign);
        }
    }
}
