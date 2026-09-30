/**
 * Shared visuals for the box/voxel ("platform") vehicle path.
 *
 * The platform silhouette and its plain cylinder wheels are built in four
 * places — `PlatformVehicleRenderer`, `BoxCarRenderer`, `VoxelCarRenderer` and
 * the multiplayer ghost in `NetworkVehicleController` — and each carried its
 * own copy. The copies had drifted in ways nobody chose (a degenerate middle
 * section guarded in one and not the others, mesh names present in some), so
 * the shape lives here once and every caller gets the same car.
 *
 * Nothing here is asset-vehicle code: an imported bmVehicle GLB renders through
 * `AssetVehicleRenderer` over `VehicleAssetVisual` instead.
 */

import * as THREE from 'three';
import { createClassedPartMaterial, type ClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { Vehicle, VehicleConfig, WheelConfig } from 'engine/Vehicle.js';
import type { VehiclePlatformStructure } from 'engine/VehiclePlatform.js';

/** Fraction of the platform width kept by the front and rear spines. */
export const SPINE_WIDTH_RATIO = 0.4;
/** Chassis paint when the vehicle config names no colour. */
export const DEFAULT_CHASSIS_COLOR = 0x444444;
/** Tyre colour when neither the wheel nor the vehicle names one. */
export const DEFAULT_WHEEL_COLOR = 0x222222;
/** Window translucency when the body config names none. */
export const DEFAULT_WINDOW_OPACITY = 0.7;
/** Wheel size for legacy configs that predate `wheels[]`. */
const LEGACY_WHEEL_RADIUS = 0.4;
const LEGACY_WHEEL_WIDTH = 0.3;

/**
 * The box shape shared by `BoxPartConfig` and `VoxelPartConfig` — everything
 * the generic body-part helpers need, so a caller can pass either one.
 */
export interface BodyPartBox {
    /** Position relative to platform centre (in meters). */
    position: { x: number; y: number; z: number };
    /** Size of the box (in meters). */
    size: { width: number; height: number; length: number };
    /** Part colour. */
    color: number;
    /** Is this a window? (transparent, and no collision). */
    isWindow?: boolean;
}

/**
 * A fresh material for one body part: tinted glass for windows, painted
 * bodywork otherwise. Each part owns its material so disposal stays per-mesh.
 */
export function createBodyPartMaterial(part: BodyPartBox, windowOpacity: number): ClassedPartMaterial {
    // 'paint' — the painted-bodywork class voxelized vehicles carry.
    if (!part.isWindow) return createClassedPartMaterial('paint', { color: part.color });
    // 'glass', with the window's translucency kept as a caller postscript
    // (the classes themselves are opaque).
    const material = createClassedPartMaterial('glass', { color: part.color });
    material.transparent = true;
    material.opacity = windowOpacity;
    return material;
}

/**
 * Register collision boxes for the solid (non-window) body parts, lifted onto
 * the platform's top surface.
 *
 * Mass stays 0 by design: the platform config carries the vehicle's entire
 * weight, and body parts exist only so projectiles and walls have something to
 * hit.
 */
export function addSolidPartsPhysics(
    vehicle: Vehicle,
    platform: VehiclePlatformStructure,
    parts: readonly BodyPartBox[],
): void {
    for (const part of parts) {
        if (part.isWindow) continue;
        vehicle.addBodyPhysics({
            position: new THREE.Vector3(
                part.position.x,
                platform.topSurfaceY + part.position.y,
                part.position.z,
            ),
            size: part.size,
            mass: 0,
        });
    }
}

export interface PlatformSlabOptions {
    /** Platform extents in meters. */
    size: { width: number; height: number; length: number };
    /** Wheel Z offsets — the wide middle spans rear-most to front-most. */
    wheelZs: number[];
    /** Shared by all three sections; the caller owns and disposes it. */
    material: THREE.Material;
}

/**
 * Add the platform silhouette to `group`. Viewed from above:
 *
 *     ##      <- narrow front spine (ahead of the front wheels)
 *   ######    <- wide middle, front wheels to rear wheels; the wheels sit in
 *   ######       the side gaps this leaves
 *     ##      <- narrow rear spine (behind the rear wheels)
 *
 * A section whose length works out to zero or less is skipped rather than
 * built: wheels flush with the nose or tail leave no spine, and an empty
 * `wheelZs` (a descriptor with no wheels at all) would otherwise ask three.js
 * for an infinitely long box and produce NaN geometry.
 */
export function addPlatformSlab(group: THREE.Object3D, options: PlatformSlabOptions): void {
    const { size, wheelZs, material } = options;
    if (wheelZs.length === 0) return;

    const frontWheelZ = Math.max(...wheelZs);
    const rearWheelZ = Math.min(...wheelZs);
    const spineWidth = size.width * SPINE_WIDTH_RATIO;

    const addSection = (name: string, width: number, length: number, z: number): void => {
        if (length <= 0) return;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, size.height, length), material);
        mesh.name = name;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.z = z;
        group.add(mesh);
    };

    const middleLength = frontWheelZ - rearWheelZ;
    addSection('MiddleSection', size.width, middleLength, (frontWheelZ + rearWheelZ) / 2);

    const frontLength = (size.length / 2) - frontWheelZ;
    addSection('FrontSpine', spineWidth, frontLength, frontWheelZ + (frontLength / 2));

    const rearLength = (size.length / 2) + rearWheelZ;
    addSection('RearSpine', spineWidth, rearLength, rearWheelZ - (rearLength / 2));
}

export interface CylinderWheelOptions {
    /** Mesh name — templates find wheels by it. */
    name: string;
    /** Radial segments: 16 reads as round, 8 keeps the voxel look chunky. */
    segments: number;
}

/**
 * One dark cylinder per wheel, world-positioned around `position` and left in
 * the engine's neutral pose (upright cylinder rotated so the axle runs along
 * X — see `RapierVehicle.visualUpdate`, which re-syncs these every frame).
 *
 * Takes either the resolved per-wheel `wheelConfigs`/`config.wheels` or the
 * legacy global `wheelRadius`/`wheelWidth`/`wheelPositions` triple, normalising
 * both to a single build loop.
 */
export function createCylinderWheelMeshes(
    config: VehicleConfig,
    position: THREE.Vector3,
    wheelConfigs: WheelConfig[] | undefined,
    options: CylinderWheelOptions,
): THREE.Mesh[] {
    const perWheel = wheelConfigs ?? config.wheels;
    const specs = perWheel?.length
        ? perWheel.map(wheel => ({
            radius: wheel.radius,
            width: wheel.width,
            color: wheel.color ?? config.wheelColor ?? DEFAULT_WHEEL_COLOR,
            position: wheel.position,
        }))
        : (config.wheelPositions ?? []).map(wheelPosition => ({
            radius: config.wheelRadius ?? LEGACY_WHEEL_RADIUS,
            width: config.wheelWidth ?? LEGACY_WHEEL_WIDTH,
            color: config.wheelColor ?? DEFAULT_WHEEL_COLOR,
            position: wheelPosition,
        }));

    return specs.map(spec => {
        // 'matte' — tyres, the VehicleWheelBuilder precedent. Per wheel rather
        // than shared, so a consumer owns what it disposes.
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(spec.radius, spec.radius, spec.width, options.segments),
            createClassedPartMaterial('matte', { color: spec.color }),
        );
        mesh.name = options.name;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(
            position.x + spec.position.x,
            position.y + spec.position.y,
            position.z + spec.position.z,
        );
        mesh.rotation.z = Math.PI / 2;
        return mesh;
    });
}
