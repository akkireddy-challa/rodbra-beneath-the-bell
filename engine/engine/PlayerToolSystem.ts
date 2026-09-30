import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import { createWeaponMesh, makeWeaponVisualOnly, type WeaponTypeId } from 'engine/WeaponRegistry.js';
import type { VoxelMiningSystem } from 'engine/VoxelMiningSystem.js';
import { MINING_ANIMATIONS } from 'engine/AnimationPacks.js';

const MINING_SWING_MOTION_ID = 'mMiningChop01';
const MINING_SWING_SPEED = 2.5;

/**
 * PlayerToolSystem — visual tool in the player's hand + looping swing
 * animation while the mining key is held, and a blade-sweep hit test on
 * each swing that drives `VoxelMiningSystem`. Hit detection samples the
 * tool's world position at several points across the swing animation,
 * gated on proximity to a scenery mesh's bounding box AND on the player
 * facing the target. Mirrors how `WeaponMeleeSystem` binds hits to weapon
 * motion — the player has to swing toward the rock for it to count.
 *
 * NOT a combat system; does NOT damage `IDamageable` entities. DO NOT use
 * `WeaponMeleeSystem` / `setAttackSystem` for mining — that damages enemies
 * only and its action handler competes with the mining key.
 *
 * Usage:
 *   const toolSystem = new PlayerToolSystem(engine);
 *   toolSystem.equipTool(WeaponType.AXE, controller); // safe any time — defers until character ready
 *   toolSystem.update(deltaTime);
 *   toolSystem.dispose();
 */
export interface PlayerToolOptions {
    /** Seconds between repeated swings while the action key is held. */
    swingIntervalSec: number;
    /** Max distance from tool to scenery bounding box to register a hit (meters). */
    hitRadius: number;
    /**
     * Minimum `dot(playerForward, playerToTarget)` required to count a hit.
     * 1 = straight ahead, 0 = to the side, -1 = behind. ~0.25 ≈ ±75°.
     */
    facingDotThreshold: number;
}

/**
 * Reasonable defaults for `PlayerToolOptions`. Spread into a partial config
 * to override only the fields you care about:
 *
 *   new PlayerToolSystem(engine, { ...DEFAULT_TOOL_OPTIONS, hitRadius: 1.5 });
 */
export const DEFAULT_TOOL_OPTIONS: PlayerToolOptions = {
    swingIntervalSec: 0.6,
    hitRadius: 0.9,
    facingDotThreshold: 0.25,
};

const SWING_SAMPLE_TIMINGS = [0.10, 0.25, 0.40, 0.55, 0.70];

/**
 * A mesh counts as "scenery" (mineable) if its name ends in `_instanced`,
 * OR its name contains one of these hints. `_instanced` is the canonical
 * suffix `EnvironmentObjectSystem` uses for every InstancedMesh it creates
 * (rocks, trees, ores, custom VXL assets, etc.), so this covers arbitrary
 * resource names without needing to enumerate them. The extra hints cover
 * standalone (non-instanced) scenery meshes.
 */
const SCENERY_NAME_HINTS = ['rock', 'stone', 'tree', 'trunk', 'log'];
function looksLikeScenery(meshName: string): boolean {
    const lower = meshName.toLowerCase();
    if (lower.endsWith('_instanced')) return true;
    return SCENERY_NAME_HINTS.some((p) => lower.includes(p));
}

export class PlayerToolSystem {
    private readonly engine: EngineLike;
    private readonly swingIntervalSec: number;
    private readonly hitRadius: number;
    private readonly facingDotThreshold: number;

    private toolMesh: THREE.Object3D | null = null;
    private controller: PlayerController | null = null;
    private swingCooldown = 0;

    constructor(engine: EngineLike, opts: PlayerToolOptions = DEFAULT_TOOL_OPTIONS) {
        this.engine = engine;
        this.swingIntervalSec = opts.swingIntervalSec;
        this.hitRadius = opts.hitRadius;
        this.facingDotThreshold = opts.facingDotThreshold;
    }

    /**
     * Spawn a tool mesh (reused from WeaponRegistry) and attach it to the
     * player's right hand, and load the mining swing animation (`mMiningChop01`)
     * on demand. The swing clip is an optional built-in (not loaded at startup),
     * so a game without mining never fetches it; equipping a tool pulls it in.
     * The pickaxe parented to the hand bone follows the chop naturally.
     *
     * Safe to call any time — if the character isn't loaded yet the attach
     * is deferred to `onCharacterReady`.
     */
    equipTool(toolType: WeaponTypeId, controller: PlayerController): void {
        this.controller = controller;
        controller.onCharacterReady(() => {
            void this.loadMiningAnimation(controller);
            void this.attachToolNow(toolType, controller);
        });
    }

    /** Load the mining swing clip on demand (idempotent — cached by URL). */
    private async loadMiningAnimation(controller: PlayerController): Promise<void> {
        const animCtl = controller.animationController;
        if (animCtl?.loadAnimationPack) {
            await animCtl.loadAnimationPack([...MINING_ANIMATIONS]);
        }
    }

    /** Drive swings and per-swing hit-test sampling. Call every frame. */
    update(deltaTime: number): void {
        if (!this.controller) return;
        this.swingCooldown -= deltaTime;
        const isMining = this.controller.isMiningActive?.() ?? false;
        const animCtl = this.controller.animationController;
        if (isMining && this.swingCooldown <= 0 && !(animCtl?.isPlayingCustom?.() ?? false)) {
            animCtl?.playCustomAnimation?.(MINING_SWING_MOTION_ID, {
                speed: MINING_SWING_SPEED,
                fadeInDuration: 0.1,
                fadeOutDuration: 0.15,
                filterRootMotion: true,
            });
            this.swingCooldown = this.swingIntervalSec;
            this.performBladeSweep();
        } else if (!isMining && this.swingCooldown < 0) {
            this.swingCooldown = 0;
        }
    }

    dispose(): void {
        this.detachMesh();
        this.controller = null;
    }

    private async attachToolNow(
        toolType: WeaponTypeId,
        controller: PlayerController,
        retryCount: number = 0,
    ): Promise<void> {
        this.detachMesh();

        const { mesh } = createWeaponMesh(toolType);
        makeWeaponVisualOnly(mesh);

        const attached = controller.attachToBodyPart(mesh, 'rightHand');
        if (!attached) {
            if (retryCount < 5) {
                const delay = 100 * (retryCount + 1);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.attachToolNow(toolType, controller, retryCount + 1);
            }
            console.error(`PlayerToolSystem: failed to attach ${toolType} to right hand after 5 attempts`);
            return;
        }
        this.toolMesh = mesh;
    }

    /**
     * Schedule hit checks at several points across the swing animation. At
     * each sample we read the tool mesh's *current* world position (the
     * animation moves it through an arc) and look for a scenery mesh within
     * `hitRadius` of it that sits in the player's forward half-space.
     */
    private performBladeSweep(): void {
        const toolMesh = this.toolMesh;
        if (!toolMesh || !this.controller || !this.engine.physicsWorld) return;
        const mining = this.engine.getDynamicObjectManager?.()?.getVoxelMiningSystem?.();
        if (!mining) return;

        const swingDurationMs = this.swingIntervalSec * 1000;
        const hitState = { registered: false };
        for (const pct of SWING_SAMPLE_TIMINGS) {
            setTimeout(() => {
                if (hitState.registered) return;
                if (this.sampleWeaponHit(toolMesh, mining)) hitState.registered = true;
            }, swingDurationMs * pct);
        }
    }

    /** Returns true if a hit landed and further samples should be skipped. */
    private sampleWeaponHit(toolMesh: THREE.Object3D, mining: VoxelMiningSystem): boolean {
        if (!this.toolMesh || this.toolMesh !== toolMesh) return false;
        const physicsWorld = this.engine.physicsWorld;
        const playerObj = this.controller?.getPlayerObject?.();
        if (!physicsWorld || !playerObj) return false;

        toolMesh.updateMatrixWorld(true);
        const axePos = new THREE.Vector3();
        toolMesh.getWorldPosition(axePos);

        const sceneHit = this.findNearestSceneryInstance(axePos, this.hitRadius);
        if (!sceneHit) return false;
        if (!this.isInFrontOfPlayer(playerObj, sceneHit.pos)) return false;

        const found = this.findVoxelObjectNear(physicsWorld, sceneHit.pos, 1.0);
        if (found) {
            mining.hitVoxelObject(found.vo, sceneHit.pos, sceneHit.nameHint, found.handle);
        } else {
            mining.hitSceneryAt(sceneHit.pos, sceneHit.nameHint);
        }
        return true;
    }

    /** True when `target` lies in the player's forward half-space (±~75°). */
    private isInFrontOfPlayer(playerObj: THREE.Object3D, target: THREE.Vector3): boolean {
        const forward = new THREE.Vector3();
        playerObj.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) return true; // unknown facing — don't gate
        forward.normalize();

        const toTarget = new THREE.Vector3().subVectors(target, playerObj.position);
        toTarget.y = 0;
        if (toTarget.lengthSq() < 1e-6) return true;
        toTarget.normalize();

        return forward.dot(toTarget) >= this.facingDotThreshold;
    }

    /**
     * Scan the scene for a scenery InstancedMesh instance (or standalone
     * scenery mesh) whose bounding box comes within `radius` of `point`.
     * Returns the closest match or null.
     */
    private findNearestSceneryInstance(
        point: THREE.Vector3,
        radius: number,
    ): { pos: THREE.Vector3; nameHint: string; dist: number } | null {
        const scene = this.engine.scene;
        if (!scene) return null;

        const instanceMatrix = new THREE.Matrix4();
        const composed = new THREE.Matrix4();
        const instancePos = new THREE.Vector3();
        const worldBBox = new THREE.Box3();
        let best: { pos: THREE.Vector3; nameHint: string; dist: number } | null = null;

        scene.traverse((obj) => {
            const rawName = obj.name || '';
            if (!rawName || !looksLikeScenery(rawName)) return;

            const im = obj as THREE.InstancedMesh;
            if (im.isInstancedMesh) {
                if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
                const localBBox = im.geometry.boundingBox;
                if (!localBBox) return;
                im.updateMatrixWorld(true);
                for (let i = 0; i < im.count; i++) {
                    im.getMatrixAt(i, instanceMatrix);
                    composed.multiplyMatrices(im.matrixWorld, instanceMatrix);
                    worldBBox.copy(localBBox).applyMatrix4(composed);
                    const d = worldBBox.distanceToPoint(point);
                    if (d < radius && (!best || d < best.dist)) {
                        instancePos.setFromMatrixPosition(composed);
                        // Preserve the raw (mixed-case) name so downstream
                        // camelCase tokenisation can split `voxelRock` →
                        // `['voxel', 'rock']`. Lowercasing here would merge
                        // them into a single non-generic token.
                        best = { pos: instancePos.clone(), nameHint: rawName, dist: d };
                    }
                }
                return;
            }

            const mesh = obj as THREE.Mesh;
            if (mesh.geometry && !mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            const localBBox = mesh.geometry?.boundingBox;
            mesh.updateMatrixWorld(true);
            if (localBBox) {
                worldBBox.copy(localBBox).applyMatrix4(mesh.matrixWorld);
                const d = worldBBox.distanceToPoint(point);
                if (d < radius && (!best || d < best.dist)) {
                    const pos = new THREE.Vector3();
                    worldBBox.getCenter(pos);
                    best = { pos, nameHint: rawName, dist: d };
                }
            } else {
                const pos = new THREE.Vector3();
                obj.getWorldPosition(pos);
                const d = pos.distanceTo(point);
                if (d < radius && (!best || d < best.dist)) {
                    best = { pos, nameHint: rawName, dist: d };
                }
            }
        });

        return best;
    }

    /**
     * Look up a `VoxelObject` registered on any physics body within `radius`
     * of `point` and return it along with that body's Rapier handle. The
     * handle is needed so the mining system can destroy *exactly* the
     * collider for the hit instance (not every nearby scenery collider).
     */
    private findVoxelObjectNear(
        physicsWorld: NonNullable<EngineLike['physicsWorld']>,
        point: THREE.Vector3,
        radius: number,
    ): { vo: import('./VoxelObject.js').VoxelObject; handle: number } | null {
        const entries = physicsWorld.queryEntitiesInRadius(
            { x: point.x, y: point.y, z: point.z },
            radius,
        );
        for (const entry of entries) {
            const vo = (entry.userData as { voxelObject?: import('./VoxelObject.js').VoxelObject } | null)?.voxelObject;
            if (vo && !vo.isDestroyed()) return { vo, handle: entry.handle };
        }
        return null;
    }

    private detachMesh(): void {
        if (this.toolMesh && this.controller?.detachFromBodyPart) {
            this.controller.detachFromBodyPart(this.toolMesh);
        }
        this.toolMesh = null;
    }
}
