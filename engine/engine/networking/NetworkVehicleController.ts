// NetworkVehicleController: visual-only controller for remote (non-owner) vehicles.
// Creates a ghost vehicle mesh (chassis + wheels + body parts) and drives wheel animation
// from network state. No physics — purely visual representation.
//
// USAGE:
//
//   // Listen for vehicle enter events:
//   networkManager.events.on('_vehicleEnter', (senderId, data) => {
//       const { networkId, descriptor } = data as { networkId: string; descriptor: VehicleDescriptor };
//       const remoteVehicle = NetworkVehicleController.create({
//           engine, networkId, vehicleDescriptor: descriptor,
//           initialState, playerName: 'Player',
//       });
//       networkManager.registerObject(remoteVehicle.getNetworkObject());
//       remoteVehicles.set(networkId, remoteVehicle);
//   });
//
//   // Every frame:
//   remoteVehicle.update(deltaTime);
//
//   // On vehicle exit or player leave:
//   remoteVehicle.dispose();

import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { NetworkObject } from 'engine/networking/NetworkObject.js';
import { createNameLabelSprite } from 'engine/networking/NetworkUtils.js';
import {
    DEFAULT_WHEEL_COLOR,
    addPlatformSlab,
    createBodyPartMaterial,
} from 'engine/vehicle/PlatformVehicleParts.js';
import type { StateMessage, VehicleDescriptor } from 'engine/networking/NetworkTypes.js';
import type { EngineLike } from 'types/game.js';

/** Height of the name label above the chassis, in meters. */
const NAME_LABEL_LIFT = 2.0;
/** Window translucency on a remote car — thinner than the local one's glass. */
const GHOST_WINDOW_OPACITY = 0.4;
/** Wheel radius used for spin only when a descriptor carries no wheels. */
const FALLBACK_WHEEL_RADIUS = 0.4;

// Reusable temporaries for wheel positioning
const _wheelPos = new THREE.Vector3();
const _steeringQuat = new THREE.Quaternion();
const _spinQuat = new THREE.Quaternion();
const _cylinderAlign = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);

/** Parameters for NetworkVehicleController.create() */
export interface NetworkVehicleCreateParams {
    /** Engine reference (for scene) */
    engine: EngineLike;
    /** Network ID from the received StateMessage */
    networkId: string;
    /** Initial state message (position, rotation, speed) */
    initialState: StateMessage;
    /** Vehicle visual descriptor (from _vehicleEnter event) */
    vehicleDescriptor: VehicleDescriptor;
    /** Display name for the floating name label */
    playerName: string;
}

/** Free one mesh's GPU resources, whether it carries one material or many. */
function disposeMeshResources(mesh: THREE.Mesh): void {
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.dispose();
}

interface WheelInfo {
    mesh: THREE.Mesh;
    position: THREE.Vector3;
    radius: number;
    suspensionRestLength: number;
    isSteering: boolean;
}

/**
 * Controller for remote (non-owner) networked vehicles.
 *
 * Creates a visual ghost vehicle from a VehicleDescriptor:
 * - Chassis mesh (platform shape matching original)
 * - Body part meshes (boxes placed on top of chassis)
 * - Wheel meshes (cylinders with spin + steering animation)
 * - Floating name label sprite
 *
 * Position/rotation are driven by NetworkObject interpolation with dead reckoning.
 * Wheel spin is derived from speed, steering angle from network state.
 */
export class NetworkVehicleController {
    private engine: EngineLike;
    private rootGroup: THREE.Group = new THREE.Group();
    private chassisGroup: THREE.Group = new THREE.Group();
    private wheels: WheelInfo[] = [];
    private networkObject: NetworkObject | null = null;
    private nameLabel: THREE.Sprite | null = null;
    private disposed = false;

    // Wheel animation state
    private wheelSpinAngle = 0;
    private chassisHeight = 0.2;
    /** Mean wheel radius, resolved once — the wheel set never changes. */
    private avgWheelRadius = FALLBACK_WHEEL_RADIUS;

    private constructor(engine: EngineLike) {
        this.engine = engine;
    }

    /**
     * Create a fully initialized remote vehicle.
     * Builds chassis mesh, body parts, wheel meshes, NetworkObject, and name label.
     */
    static create(params: NetworkVehicleCreateParams): NetworkVehicleController {
        const { engine, networkId, initialState, vehicleDescriptor, playerName } = params;

        const ctrl = new NetworkVehicleController(engine);

        // 1. Position root group from initial state
        ctrl.rootGroup.name = `NetworkVehicle_${playerName}`;
        ctrl.rootGroup.position.set(
            initialState.position.x,
            initialState.position.y,
            initialState.position.z,
        );
        ctrl.rootGroup.quaternion.set(
            initialState.quaternion.x,
            initialState.quaternion.y,
            initialState.quaternion.z,
            initialState.quaternion.w,
        );

        // 2. Build chassis mesh
        ctrl.chassisHeight = vehicleDescriptor.chassisSize.height;
        ctrl.buildChassis(vehicleDescriptor);
        ctrl.rootGroup.add(ctrl.chassisGroup);

        // 3. Build body parts
        ctrl.buildBodyParts(vehicleDescriptor);

        // 4. Build wheel meshes (separate from chassis, positioned in world space each frame)
        ctrl.buildWheels(vehicleDescriptor);

        // 5. Add to scene
        const scene = engine.scene;
        if (scene) {
            scene.add(ctrl.rootGroup);
            for (const wheel of ctrl.wheels) {
                scene.add(wheel.mesh);
            }
        }

        // 6. Create NetworkObject (non-owner)
        const zeroVelocity = { x: 0, y: 0, z: 0 };
        const netObj = new NetworkObject(ctrl.rootGroup, networkId, false, {
            velocityGetter: () => zeroVelocity,
        });
        netObj.applyState(initialState);
        ctrl.networkObject = netObj;

        // 7. Create name label
        ctrl.nameLabel = createNameLabelSprite(playerName);
        scene?.add(ctrl.nameLabel);
        ctrl.positionNameLabel();

        // 8. Asset-based vehicles: the box ghost shows immediately; the real
        // asset visuals swap in when their async load resolves. Any failure
        // keeps the box ghost — never a broken remote player.
        if (vehicleDescriptor.assetId) {
            void ctrl.upgradeToAssetVisuals(vehicleDescriptor.assetId);
        }

        return ctrl;
    }

    /** Swap the box-ghost visuals for the vehicle asset's body + wheels. */
    private async upgradeToAssetVisuals(assetId: string): Promise<void> {
        try {
            const assets = this.engine.getGameData?.()?.assets;
            const asset = assets?.find((a) => a.id === assetId) ?? assets?.find((a) => a.name === assetId);
            const fitment = asset?.vehicleFitment;
            if (!asset || !fitment) return;
            const { loadVehicleAssetVisual, wheelMeshForAxleSide } = await import('engine/vehicle/VehicleAssetVisual.js');
            const visual = await loadVehicleAssetVisual(this.engine, asset, fitment);
            if (this.disposed) return;

            // Body: clear the box chassis + parts, mount the asset body at the
            // platform-top convention (chassis origin = slab center).
            this.chassisGroup.clear();
            visual.chassisObject.position.set(0, this.chassisHeight / 2, 0);
            this.chassisGroup.add(visual.chassisObject);

            // Wheels: replace each ghost cylinder with the asset's wheel for
            // that corner (matched by the descriptor's wheel positions).
            const scene = this.engine.scene;
            for (const wheel of this.wheels) {
                const axle = fitment.axles.reduce((best, a) =>
                    Math.abs(a.z - wheel.position.z) < Math.abs(best.z - wheel.position.z) ? a : best);
                const side: 1 | -1 = wheel.position.x >= 0 ? 1 : -1;
                const replacement = wheelMeshForAxleSide(visual, axle, side);
                replacement.position.copy(wheel.mesh.position);
                replacement.quaternion.copy(wheel.mesh.quaternion);
                replacement.userData.excludeFromSplatExport = true;
                scene?.remove(wheel.mesh);
                scene?.add(replacement);
                wheel.mesh = replacement;
            }
        } catch (error) {
            console.warn(`[NetworkVehicleController] asset ghost upgrade failed (${assetId}) — keeping box ghost:`, error);
        }
    }

    /**
     * Advance wheel animation and update visuals. Call every frame.
     * Note: NetworkObject.updateInterpolation() is called automatically by NetworkManager.update().
     */
    update(deltaTime: number): void {
        if (this.disposed || !this.networkObject) return;

        // 1. Get current speed and steering from interpolation
        const speed = this.networkObject.getCurrentSpeed();
        const steeringAngle = this.networkObject.getSteeringAngle();

        // 2. Accumulate wheel spin based on speed
        this.wheelSpinAngle += (speed / this.avgWheelRadius) * deltaTime;

        // 3. Update each wheel mesh position and rotation
        // Mirrors RapierVehicle.visualUpdate() lines 709-738
        for (const wheel of this.wheels) {
            // Local wheel position (fixed suspension at rest length, no dynamic
            // compression), transformed to world space via the chassis pose.
            _wheelPos.copy(wheel.position);
            _wheelPos.y -= wheel.suspensionRestLength;
            _wheelPos.applyQuaternion(this.rootGroup.quaternion);
            _wheelPos.add(this.rootGroup.position);
            wheel.mesh.position.copy(_wheelPos);

            // Compose quaternion: chassis * steering * spin * cylinderAlign
            wheel.mesh.quaternion.copy(this.rootGroup.quaternion);

            if (wheel.isSteering) {
                _steeringQuat.setFromAxisAngle(_up, steeringAngle);
                wheel.mesh.quaternion.multiply(_steeringQuat);
            }

            // +wheelSpinAngle: roll forward with travel — matches the driven
            // vehicle's sign (RapierVehicle.visualUpdate) so ghost wheels spin
            // the same way as the local car's.
            _spinQuat.setFromAxisAngle(_right, this.wheelSpinAngle);
            wheel.mesh.quaternion.multiply(_spinQuat);
            wheel.mesh.quaternion.multiply(_cylinderAlign);
        }

        // 4. Update name label position (above chassis)
        this.positionNameLabel();
    }

    /** Clean up all resources. Call when the remote vehicle is destroyed. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        const scene = this.engine.scene;
        this.networkObject?.destroy();
        scene?.remove(this.rootGroup);

        // Remove and dispose wheels
        for (const wheel of this.wheels) {
            scene?.remove(wheel.mesh);
            disposeMeshResources(wheel.mesh);
        }
        this.wheels = [];

        // Dispose chassis geometries and materials
        this.chassisGroup.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) disposeMeshResources(child as THREE.Mesh);
        });

        // Dispose name label
        if (this.nameLabel) {
            scene?.remove(this.nameLabel);
            const mat = this.nameLabel.material as THREE.SpriteMaterial;
            mat.map?.dispose();
            mat.dispose();
            this.nameLabel = null;
        }
    }

    /** Float the name label a fixed height above the chassis. */
    private positionNameLabel(): void {
        if (!this.nameLabel) return;
        this.nameLabel.position.copy(this.rootGroup.position);
        this.nameLabel.position.y += this.chassisHeight + NAME_LABEL_LIFT;
    }

    /** Get the root Object3D (driven by NetworkObject interpolation) */
    getObject3D(): THREE.Object3D {
        return this.rootGroup;
    }

    /** Get the NetworkObject for registering with NetworkManager */
    getNetworkObject(): NetworkObject {
        return this.networkObject!;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VISUAL CONSTRUCTION
    // ═══════════════════════════════════════════════════════════════════════════

    private buildChassis(descriptor: VehicleDescriptor): void {
        this.chassisGroup.name = 'GhostChassis';
        addPlatformSlab(this.chassisGroup, {
            size: descriptor.chassisSize,
            wheelZs: descriptor.wheels.map(w => w.position.z),
            // 'paint' — a remote player's vehicle shades like the local one.
            material: createClassedPartMaterial('paint', { color: descriptor.chassisColor }),
        });
    }

    private buildBodyParts(descriptor: VehicleDescriptor): void {
        for (const part of descriptor.bodyParts) {
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(part.size.width, part.size.height, part.size.length),
                createBodyPartMaterial(part, GHOST_WINDOW_OPACITY),
            );
            mesh.castShadow = !part.isWindow;
            mesh.receiveShadow = true;
            mesh.position.set(part.position.x, part.position.y, part.position.z);
            this.chassisGroup.add(mesh);
        }
    }

    private buildWheels(descriptor: VehicleDescriptor): void {
        for (const wheelDesc of descriptor.wheels) {
            const mesh = new THREE.Mesh(
                new THREE.CylinderGeometry(wheelDesc.radius, wheelDesc.radius, wheelDesc.width, 16),
                createClassedPartMaterial('matte', { color: wheelDesc.color ?? DEFAULT_WHEEL_COLOR }),
            );
            mesh.name = 'GhostWheel';
            mesh.castShadow = true;
            mesh.receiveShadow = true;

            this.wheels.push({
                mesh,
                position: new THREE.Vector3(wheelDesc.position.x, wheelDesc.position.y, wheelDesc.position.z),
                radius: wheelDesc.radius,
                suspensionRestLength: wheelDesc.suspensionRestLength,
                isSteering: wheelDesc.isSteering,
            });
        }

        if (this.wheels.length > 0) {
            this.avgWheelRadius = this.wheels.reduce((sum, w) => sum + w.radius, 0) / this.wheels.length;
        }
    }
}
