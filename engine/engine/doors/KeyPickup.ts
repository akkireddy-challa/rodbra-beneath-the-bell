/**
 * KeyPickup — the collectible visual for one `KeyItemDefinition`.
 *
 * Two rendering paths, chosen at construction:
 *   - `def.assetId` set AND the engine exposes `spawnAsset` (see
 *     `engine/AssetSpawner.ts`): spawns the authored VXL/GLB asset, then
 *     re-homes it under a pivot at `def.position` (see `wrapSpawnedObject`).
 *     Its own auto-wired collectible sensor tracks the pickup. If the spawn
 *     resolves `null` or rejects (bad/missing asset id), falls back to the
 *     box mesh below instead of leaving the key permanently uncollectable.
 *   - Otherwise (no `assetId`, or the spawn above failed): a small floating
 *     box mesh (fallback look, tinted by `def.color`) added to the world
 *     group, with our own `CollectibleComponent` sensor.
 *
 * Whichever visual lands — the fallback mesh or the spawned-asset pivot —
 * spins slowly via `engine.registerBeforeRender` (`registerSpin`, shared by
 * both paths so there's one spin implementation, not two).
 *
 * Either way, collecting it grants the key on the shared `Keyring` and shows
 * an `InGameNotification`-style message via the injected `notify` callback,
 * then disposes itself. If the key is already held at construction time
 * (collected earlier this session, or synced in from another player over the
 * network — see `DoorSystem`), nothing is spawned at all: the instance is
 * inert and `dispose()` is a safe no-op.
 */

import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { EngineLike, KeyItemDefinition } from 'types/game.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollectibleComponent, type CollectibleComponentConfig } from 'engine/CollectibleComponent.js';
import type { SpawnedAsset } from 'engine/AssetSpawner.js';
import type { Keyring } from 'engine/doors/Keyring.js';

/** Trigger radius (meters) for both the spawnAsset and fallback pickup sensors. */
const KEY_PICKUP_SENSOR_RADIUS = 1.5;
/** Fallback box mesh edge length (meters). */
const KEY_PICKUP_FALLBACK_SIZE = 0.3;
/** Fallback box tint when `def.color` is omitted. */
const DEFAULT_KEY_PICKUP_COLOR = '#d4b64a';
/** Slow Y-axis spin rate for the pickup visual, radians/second. */
const KEY_PICKUP_ROTATION_SPEED = 0.8;
/** Assumed frame time when the engine doesn't expose `getDeltaTime()`. */
const DEFAULT_FRAME_SECONDS = 1 / 60;

/**
 * Minimal surface KeyPickup needs from its proximity sensor — satisfied by
 * `CollectibleComponent`, but kept narrow so tests can inject a stub.
 */
export interface CollectibleSensor {
    dispose(): void;
}

/**
 * Seam for constructing the fallback-path sensor. A real `CollectibleComponent`
 * needs a live Rapier `PhysicsWorld` (WASM-backed), which is disproportionate
 * to spin up just to unit-test KeyPickup's own wiring (mesh built, sensor
 * requested, onCollect grants + notifies + disposes). Tests inject a stub
 * factory; production code relies on the default.
 */
export type CollectibleSensorFactory = (
    physicsWorld: PhysicsWorld,
    config: CollectibleComponentConfig,
) => CollectibleSensor;

export const DEFAULT_COLLECTIBLE_SENSOR_FACTORY: CollectibleSensorFactory = (physicsWorld, config) =>
    new CollectibleComponent(physicsWorld, config);

export class KeyPickup {
    private disposed = false;
    private mesh: THREE.Mesh | null = null;
    /**
     * Pivot wrapping a spawned asset at `def.position` — ours, not the
     * spawner's. See `wrapSpawnedObject`. Null on the fallback-mesh path.
     */
    private pivot: THREE.Object3D | null = null;
    private sensor: CollectibleSensor | null = null;
    private unregisterBeforeRender: (() => void) | null = null;
    private spawnedAsset: SpawnedAsset | null = null;

    constructor(
        engine: EngineLike,
        def: KeyItemDefinition,
        keyring: Keyring,
        notify: (message: string) => void,
        sensorFactory: CollectibleSensorFactory = DEFAULT_COLLECTIBLE_SENSOR_FACTORY,
    ) {
        // Already collected this session (or synced in over the network) —
        // nothing to spawn. Every field stays null, so dispose() is a no-op.
        if (keyring.has(def.keyId)) return;

        const handleCollected = (): void => {
            if (this.disposed) return;
            keyring.grant(def.keyId);
            notify(`Picked up: ${def.name}`);
            this.dispose();
        };

        // Shared by both paths: whichever Object3D the animation-free pickup
        // actually shows (fallback mesh, or the spawned-asset pivot) spins the
        // same way. One implementation instead of two keeps them from drifting
        // apart the next time the rate or the timing source changes.
        const registerSpin = (target: THREE.Object3D): void => {
            this.unregisterBeforeRender = engine.registerBeforeRender?.(() => {
                target.rotation.y += KEY_PICKUP_ROTATION_SPEED * (engine.getDeltaTime?.() ?? DEFAULT_FRAME_SECONDS);
            }) ?? null;
        };

        // Fallback: a small floating box mesh with our own collectible sensor.
        // Defined as a closure (not a method) so both the sync no-assetId path
        // and the async spawn-failure path below can call it identically.
        const buildFallback = (): void => {
            const geometry = new THREE.BoxGeometry(KEY_PICKUP_FALLBACK_SIZE, KEY_PICKUP_FALLBACK_SIZE, KEY_PICKUP_FALLBACK_SIZE);
            // 'gold' — a key pickup glints (the default colour is gold already).
            const material = createClassedPartMaterial('gold', {
                color: new THREE.Color(def.color ?? DEFAULT_KEY_PICKUP_COLOR).getHex(),
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(def.position.x, def.position.y, def.position.z);
            this.mesh = mesh;

            engine.getWorldGroup().add(mesh);
            registerSpin(mesh);

            const physicsWorld = engine.physicsWorld;
            if (physicsWorld) {
                this.sensor = sensorFactory(physicsWorld, {
                    collectible: { onCollect: () => handleCollected() },
                    object3D: mesh,
                    radius: KEY_PICKUP_SENSOR_RADIUS,
                });
            } else {
                console.warn(`[KeyPickup] no physicsWorld available — key '${def.keyId}' pickup has no collectible sensor`);
            }
        };

        /**
         * Wrap a spawned asset in a pivot whose origin is `def.position`.
         *
         * Baked assets are bottom-origin (x/z centred, y = 0 at the bottom —
         * both the forger's `normalizeArchetypeMesh` and the asset voxelizer
         * normalize to that frame), so an asset spawned straight at the
         * pickup's position renders half a model too high. Mirrors
         * `DungeonDoor.wrapSpawnedLeaf` in miniature: a key pickup has no
         * authored width/height/thickness to fit against, so there is no
         * per-axis scaling step, only the re-centre.
         *
         * The pivot (not the asset) is what spins — see `registerSpin`.
         */
        const wrapSpawnedObject = (object: THREE.Object3D): void => {
            // Clear the pose spawnAsset applied — the pivot carries position
            // now. Detached first so the bounds below are measured in the
            // asset's own frame, whatever transform the world group carries.
            object.removeFromParent();
            object.position.set(0, 0, 0);
            object.rotation.set(0, 0, 0);
            object.updateWorldMatrix(false, true);

            const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());

            const pivot = new THREE.Object3D();
            pivot.name = `key_${def.id}_pivot`;
            pivot.position.set(def.position.x, def.position.y, def.position.z);
            this.pivot = pivot;
            pivot.add(object);
            engine.getWorldGroup().add(pivot);

            // Centre the asset's bounds on the pivot. For the expected
            // bottom-origin asset this is exactly -bboxHeight/2 on Y, and it
            // also absorbs assets whose bounds aren't perfectly centred in X/Z.
            object.position.set(-center.x, -center.y, -center.z);

            registerSpin(pivot);
        };

        if (def.assetId && engine.spawnAsset) {
            engine.spawnAsset(def.assetId, {
                position: def.position,
                collectible: { radius: KEY_PICKUP_SENSOR_RADIUS, onCollect: () => handleCollected() },
            }).then((spawned) => {
                if (this.disposed) {
                    // We were disposed while the load was in flight — tear
                    // down the object that just landed instead of leaking it.
                    spawned?.dispose();
                    return;
                }
                if (spawned) {
                    this.spawnedAsset = spawned;
                    wrapSpawnedObject(spawned.object);
                    return;
                }
                // A resolved-but-null spawn (bad/missing asset id) must not
                // soft-lock a door gated on this key — fall back to the box
                // mesh so the key stays obtainable.
                console.warn(`[KeyPickup] spawnAsset returned null for key '${def.keyId}' (asset '${def.assetId}') — falling back to the box mesh so the key stays obtainable`);
                buildFallback();
            }).catch((err: unknown) => {
                if (this.disposed) return;
                console.warn(`[KeyPickup] spawnAsset failed for key '${def.keyId}' (asset '${def.assetId}') — falling back to the box mesh so the key stays obtainable:`, err);
                buildFallback();
            });
            return;
        }

        buildFallback();
    }

    /** Tear down whichever path was built. Idempotent — safe to call more than once. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        this.unregisterBeforeRender?.();
        this.unregisterBeforeRender = null;

        this.sensor?.dispose();
        this.sensor = null;

        if (this.mesh) {
            this.mesh.parent?.remove(this.mesh);
            this.mesh.geometry.dispose();
            const material = this.mesh.material;
            if (Array.isArray(material)) {
                for (const m of material) m.dispose();
            } else {
                material.dispose();
            }
            this.mesh = null;
        }

        // Order matters: the asset's own dispose() detaches it from the pivot,
        // then the pivot — which is ours, not the spawner's — leaves the scene.
        if (this.spawnedAsset) {
            this.spawnedAsset.dispose();
            this.spawnedAsset = null;
        }
        if (this.pivot) {
            this.pivot.parent?.remove(this.pivot);
            this.pivot = null;
        }
    }
}
