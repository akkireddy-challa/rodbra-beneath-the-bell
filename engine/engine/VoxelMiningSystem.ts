import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Minimal contract a world-generator must satisfy for VoxelMiningSystem.
 * Both the voxel template's WorldGenerator and VoxelTerrainSystem satisfy this.
 */
export interface VoxelWorldProvider {
    getVoxelWorld(): VoxelWorld | null;
}

export interface VoxelMiningOptions {
    /** Per-block HP override, keyed by block type id. Empty Map = no per-id overrides. */
    blockHp: Map<number, number>;
    /** HP used when a block has no explicit entry. */
    defaultHp: number;
    /** HP deducted on each successful swing hit. */
    damagePerSwing: number;
    /**
     * Allow terrain voxels (ground/hills) to be mined. `false` = only
     * environment objects (rocks, trees, placed VoxelObjects) are mineable.
     * `true` = Minecraft-style freeform digging is enabled.
     */
    mineTerrain: boolean;
    /**
     * Whitelist of mineable block names. When non-null, only targets whose
     * resolved block name is in this list can be mined. A whitelisted block
     * is allowed even if it's terrain and `mineTerrain` is `false`, so
     * callers can say "only stone" without opening dirt/grass. `null` = no
     * whitelist, every block is allowed (subject to `mineTerrain`).
     * Block names: `stone`, `trunk`, `leaves`, `wood`, `grass`, `dirt`, `sand`, etc.
     */
    mineableBlocks: string[] | null;
    /**
     * Seconds of no swing hits after which the current target is cleared.
     * Keeps the crack overlay visible — and HP progress preserved — across
     * pauses, so a player tapping the action key or briefly releasing it
     * doesn't reset mid-mine. Defaults to 5 in `DEFAULT_MINING_OPTIONS`.
     */
    targetHoldSec: number;
}

/**
 * Reasonable defaults for `VoxelMiningOptions`. Spread into a partial config
 * to override only the fields you care about:
 *
 *   setTerrainSystem(voxelTerrain, {
 *       ...DEFAULT_MINING_OPTIONS,
 *       mineableBlocks: ['stone'],
 *   });
 */
export const DEFAULT_MINING_OPTIONS: VoxelMiningOptions = {
    blockHp: new Map(),
    defaultHp: 5,
    damagePerSwing: 1,
    mineTerrain: false,
    mineableBlocks: null,
    targetHoldSec: 5,
};

/**
 * VoxelMiningSystem — blade-sweep driven block mining for the Voxel genre.
 *
 * The system does **not** raycast from the camera. Instead, a weapon/tool
 * system (e.g. `PlayerToolSystem`) performs a forward sweep during each swing
 * and calls `tryHitAt()` with the hit body + point. This matches how
 * `WeaponMeleeSystem` detects hits against entities, and keeps mining in
 * sync with what the player visually sees the axe touching.
 *
 * HP/progress are tracked per-target across swings: swinging at the same
 * block repeatedly accumulates damage until the block is destroyed.
 *
 * Wire-up (done by `DynamicObjectManager` when `setTerrainSystem` is called):
 *   const mining = new VoxelMiningSystem(engine, worldProvider, opts?);
 *   // on each swing:
 *   mining.tryHitAt(hitBody, hitPoint, hitNormal);
 *   // each frame:
 *   mining.update(deltaTime);
 *   // on shutdown:
 *   mining.dispose();
 */
export class VoxelMiningSystem {
    public onBlockDestroyed:
        | ((pos: THREE.Vector3, blockId: number, blockName: string, color: number) => void)
        | null = null;

    private engine: EngineLike;
    private worldProvider: VoxelWorldProvider;

    private defaultHp: number;
    private damagePerSwing: number;
    private blockHp: Map<number, number>;
    private blockIdToName: Map<number, string> = new Map();
    private mineTerrain: boolean;
    private mineableBlocks: Set<string> | null;
    private targetHoldSec: number;

    private targetKey: string | null = null;
    private targetHp: number = 0;
    private targetMaxHp: number = 1;
    private timeSinceLastHit: number = 0;

    // Locked target snapshot — captured on first sweep hit, used for the
    // whole mining session so jitter in the sweep direction doesn't reset
    // progress.
    private _lockedBx: number = 0;
    private _lockedBy: number = 0;
    private _lockedBz: number = 0;
    private _lockedBlockId: number = 0;
    private _lockedEnvObject: VoxelObject | null = null;
    private _lockedEnvBlockName: string = '';
    private _lockedEnvColor: number = 0;
    private _lockedCenter: THREE.Vector3 = new THREE.Vector3();
    // Physics body handle for the specific instance that was hit. -1 = no
    // body known (e.g. terrain or scenery-only hit path). Stored so destroy
    // only removes THIS body rather than every rock-like collider in the
    // blast radius.
    private _lockedBodyHandle: number = -1;

    private overlayGroup: THREE.Group;
    private overlayBox: THREE.Mesh;
    private crackOverlay: THREE.Mesh;
    private crackTexture: THREE.CanvasTexture;
    private wobbleTime: number = 0;
    private visible: boolean = false;

    constructor(engine: EngineLike, worldProvider: VoxelWorldProvider, opts: VoxelMiningOptions) {
        this.engine = engine;
        this.worldProvider = worldProvider;
        this.defaultHp = opts.defaultHp;
        this.damagePerSwing = opts.damagePerSwing;
        this.blockHp = new Map(opts.blockHp);
        this.mineTerrain = opts.mineTerrain;
        this.mineableBlocks = opts.mineableBlocks
            ? new Set(opts.mineableBlocks.map(s => s.toLowerCase()))
            : null;
        this.targetHoldSec = opts.targetHoldSec;

        const atlas = getVoxelTextureAtlas();

        // Populate the blockId → name map from the atlas itself — every
        // block the atlas knows about, including custom block types
        // registered by the game. This lets the whitelist match custom
        // names (e.g. `mineableBlocks: ['iron']`) and keeps the `+1 <name>`
        // HUD notification readable for any block the atlas can render.
        for (const name of atlas.getBlockTypeNames()) {
            const id = atlas.getBlockIdByName(name);
            if (id === undefined) continue;
            this.blockIdToName.set(id, name);
        }

        // HP defaults for the standard block categories. Custom blocks that
        // aren't in this list fall through to `this.defaultHp`; games can
        // override via `blockHp` to tune individual block HP.
        const hpDefaults: Array<[string, number]> = [
            ['grass', 3],
            ['dirt', 3],
            ['sand', 2],
            ['wood', 4],
            ['trunk', 6],
            ['tree', 6],
            ['leaves', 2],
            ['stone', 10],
            ['marble', 12],
        ];
        for (const [name, hp] of hpDefaults) {
            const id = atlas.getBlockIdByName(name);
            if (id === undefined) continue;
            if (!this.blockHp.has(id)) this.blockHp.set(id, hp);
        }

        this.overlayGroup = new THREE.Group();
        this.overlayGroup.name = 'VoxelMiningOverlay';
        engine.scene?.add(this.overlayGroup);

        this.overlayBox = new THREE.Mesh(
            new THREE.BoxGeometry(1.02, 1.02, 1.02),
            new THREE.MeshBasicMaterial({
                color: 0xffffff,
                wireframe: true,
                transparent: true,
                opacity: 0.25,
            }),
        );
        this.overlayGroup.add(this.overlayBox);

        this.crackTexture = buildCrackTexture();
        this.crackOverlay = new THREE.Mesh(
            new THREE.BoxGeometry(1.03, 1.03, 1.03),
            new THREE.MeshBasicMaterial({
                map: this.crackTexture,
                transparent: true,
                opacity: 0,
                depthWrite: false,
            }),
        );
        this.overlayGroup.add(this.crackOverlay);
        this.overlayGroup.visible = false;
    }

    /**
     * Called by a weapon system on each swing that sweeps into a mineable
     * body. Applies one swing's worth of damage. Same body hit in successive
     * swings accumulates damage until HP hits 0, then destroys.
     *
     * `nameHint` is optional — pass a scenery-looking name (e.g. from a
     * nearby `InstancedMesh`) so classification can pick up `stone` / `trunk`
     * / etc. even when the resolved `VoxelObject` itself has no name.
     */
    tryHitAt(hitBody: unknown, hitPoint: THREE.Vector3, hitNormal: THREE.Vector3, nameHint?: string): void {
        const physicsWorld = this.engine.physicsWorld;
        if (!physicsWorld) return;
        const voxelWorld = this.worldProvider.getVoxelWorld();
        const resolved = this.resolveTarget(hitBody, hitPoint, hitNormal, voxelWorld, physicsWorld, nameHint);
        if (!resolved) return;
        this.applyHit(resolved, voxelWorld);
    }

    /**
     * Called by a weapon system that picked a known VoxelObject (e.g. via
     * proximity query). No raycast needed; applies one swing's damage.
     *
     * `nameHint` is optional: when a caller can provide a descriptive name
     * (e.g. the rendering InstancedMesh's `voxelRock_instanced` name), pass
     * it in so classification picks up `stone` / `trunk` / etc. even if the
     * template VoxelObject itself has no name set.
     */
    hitVoxelObject(
        voxelObject: VoxelObject,
        contactPoint?: THREE.Vector3,
        nameHint?: string,
        bodyHandle: number = -1,
    ): void {
        if (voxelObject.isDestroyed()) return;
        const voxelWorld = this.worldProvider.getVoxelWorld();
        const point = contactPoint ?? voxelObject.position.clone();
        const { name, color } = classifyVoxelObject(voxelObject, point, nameHint);
        const resolvedId = getVoxelTextureAtlas().getBlockIdByName(name) ?? 1;
        this.applyHit({
            bx: Math.floor(point.x),
            by: Math.floor(point.y),
            bz: Math.floor(point.z),
            blockId: resolvedId,
            envVoxelObject: voxelObject,
            bodyHandle,
            blockName: name,
            color,
            center: point.clone(),
        }, voxelWorld);
    }

    /**
     * Called by a weapon system that picked a known terrain voxel (e.g. via
     * proximity scan of `VoxelWorld`). No raycast needed; applies one swing's
     * damage.
     */
    hitTerrainCell(bx: number, by: number, bz: number): void {
        const voxelWorld = this.worldProvider.getVoxelWorld();
        if (!voxelWorld) return;
        const blockId = voxelWorld.getBlock(bx, by, bz);
        if (!blockId || blockId === 0) return;
        const name = this.blockIdToName.get(blockId) ?? `block_${blockId}`;
        const color = voxelWorld.getColor(bx, by, bz) ?? 0xcccccc;
        this.applyHit({
            bx, by, bz,
            blockId,
            envVoxelObject: null,
            bodyHandle: -1,
            blockName: name,
            color,
            center: new THREE.Vector3(bx + 0.5, by + 0.5, bz + 0.5),
        }, voxelWorld);
    }

    /**
     * Read the terrain block id at an integer cell coordinate. Returns 0 when
     * the world provider has no voxel world available or the cell is empty.
     * Exposed so weapon systems can proximity-scan terrain without reaching
     * into VoxelWorld directly.
     */
    probeTerrain(x: number, y: number, z: number): number {
        const voxelWorld = this.worldProvider.getVoxelWorld();
        if (!voxelWorld) return 0;
        return voxelWorld.getBlock(x, y, z) ?? 0;
    }

    /**
     * Called when a weapon system picked a mineable scenery mesh by scene
     * proximity (e.g. an InstancedMesh instance we couldn't resolve to a
     * physics-registered VoxelObject). We can't safely destroy the instance
     * without deeper integration with the scenery system, so we just apply
     * whitelist + fire `onBlockDestroyed` once per swing — the player gets
     * the "+1 stone" HUD feedback and any drop-spawn callback fires, but the
     * visual stays. Block classification comes from the object's name hint.
     */
    hitSceneryAt(position: THREE.Vector3, nameHint: string): void {
        const hint = (nameHint || '').toLowerCase();
        const isTree = hint.includes('tree') || hint.includes('trunk') || hint.includes('leaf') || hint.includes('log');
        const isRock = hint.includes('rock') || hint.includes('stone');
        const name = isRock ? 'stone' : isTree ? 'trunk' : 'wood';
        const color = isRock ? 0x888888 : 0x7a5230;
        const blockId = getVoxelTextureAtlas().getBlockIdByName(name) ?? 1;

        if (this.mineableBlocks && !this.mineableBlocks.has(name)) return;

        this.onBlockDestroyed?.(position.clone(), blockId, name, color);
    }

    private applyHit(resolved: ResolvedTarget, voxelWorld: VoxelWorld | null): void {
        const { bx, by, bz, blockId, envVoxelObject, bodyHandle, blockName, color, center } = resolved;

        // Whitelist check (terrain gating + explicit whitelist).
        const terrainHit = envVoxelObject === null && blockId !== 0;
        const whitelistAllows = this.mineableBlocks
            ? this.mineableBlocks.has(blockName.toLowerCase())
            : true;
        if (!whitelistAllows) return;
        if (terrainHit && !this.mineTerrain && !this.mineableBlocks?.has(blockName.toLowerCase())) return;

        // Env targets key on the body handle, not the VoxelObject uuid —
        // InstancedMesh scenery shares one template across all instances, so
        // the uuid is identical for every instance. Without the handle, the
        // relock branch below is skipped when the player switches from one
        // rock to another within `targetHoldSec`, and the destroy path uses
        // the first rock's center.
        const targetKey = envVoxelObject
            ? `v:${envVoxelObject.uuid}:${bodyHandle}`
            : `t:${bx},${by},${bz}`;

        // Lock / relock target.
        if (targetKey !== this.targetKey) {
            this._lockedBx = bx;
            this._lockedBy = by;
            this._lockedBz = bz;
            this._lockedBlockId = blockId;
            this._lockedEnvObject = envVoxelObject;
            this._lockedEnvBlockName = envVoxelObject ? blockName : '';
            this._lockedEnvColor = color;
            this._lockedCenter.copy(center);
            this._lockedBodyHandle = bodyHandle;

            this.targetKey = targetKey;
            this.targetMaxHp = this.blockHp.get(blockId) ?? this.defaultHp;
            this.targetHp = this.targetMaxHp;
            this.wobbleTime = 0;
        }

        this.targetHp -= this.damagePerSwing;
        this.timeSinceLastHit = 0;
        const destroyed = this.targetHp <= 0;
        // Single permanent log line per landed swing — enough to confirm
        // mining is working ("[Mining] hit stone 9/10") without flooding
        // the console. Per-step diagnostics were removed after shipping.
        console.log(`[Mining] hit ${blockName} ${Math.max(0, this.targetHp).toFixed(0)}/${this.targetMaxHp}${destroyed ? ' DESTROYED' : ''}`);
        if (!destroyed) return;

        this.destroyLocked(voxelWorld);
    }

    /**
     * Per-frame update: drives the crack-overlay wobble and auto-clears the
     * target if no swing hits have come in for `targetHoldSec` seconds.
     */
    update(deltaTime: number): void {
        this.timeSinceLastHit += deltaTime;
        if (this.targetKey !== null) {
            this.wobbleTime += deltaTime;
            this.renderOverlay();
            if (this.timeSinceLastHit > this.targetHoldSec) {
                this.clearTarget();
            }
        } else if (this.visible) {
            this.hideOverlay();
        }
    }

    dispose(): void {
        this.engine.scene?.remove(this.overlayGroup);
        this.overlayBox.geometry.dispose();
        (this.overlayBox.material as THREE.Material).dispose();
        this.crackOverlay.geometry.dispose();
        (this.crackOverlay.material as THREE.Material).dispose();
        this.crackTexture.dispose();
        this.onBlockDestroyed = null;
    }

    /**
     * Resolve a raw physics hit into a mining target: a locked voxel cell +
     * optional VoxelObject + classified block name/color. Returns null if the
     * hit can't be mapped to anything mineable.
     */
    private resolveTarget(
        hitBody: unknown,
        hitPoint: THREE.Vector3,
        hitNormal: THREE.Vector3,
        voxelWorld: VoxelWorld | null,
        physicsWorld: PhysicsWorld,
        nameHint?: string,
    ): ResolvedTarget | null {
        // 1. Try VoxelObject via userData on the hit rigid body.
        const body = hitBody as Parameters<typeof VoxelObject.fromRigidBody>[0] | undefined;
        const envVoxelObject = body ? VoxelObject.fromRigidBody(body, physicsWorld) : null;
        const bodyHandle = (body as { handle?: number } | undefined)?.handle ?? -1;
        if (envVoxelObject && !envVoxelObject.isDestroyed()) {
            const { name, color } = classifyVoxelObject(envVoxelObject, hitPoint, nameHint);
            const resolvedId = getVoxelTextureAtlas().getBlockIdByName(name) ?? 1;
            const center = hitPoint.clone().addScaledVector(hitNormal, -0.25);
            return {
                bx: Math.floor(hitPoint.x),
                by: Math.floor(hitPoint.y),
                bz: Math.floor(hitPoint.z),
                blockId: resolvedId,
                envVoxelObject,
                bodyHandle,
                blockName: name,
                color,
                center,
            };
        }

        // 2. Fall back to voxel terrain lookup.
        if (!voxelWorld) return null;
        const inside = hitPoint.clone().addScaledVector(hitNormal, -0.5);
        let bx = Math.floor(inside.x);
        let by = Math.floor(inside.y);
        let bz = Math.floor(inside.z);
        let blockId = voxelWorld.getBlock(bx, by, bz);

        // If the -0.5*normal step landed in air (hit was on a voxel face
        // boundary), pick the closest solid cell in the 3×3×3 neighborhood.
        if (!blockId || blockId === 0) {
            let bestId = 0;
            let bestDist = Infinity;
            let bestX = bx, bestY = by, bestZ = bz;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const cx = bx + dx, cy = by + dy, cz = bz + dz;
                        const id = voxelWorld.getBlock(cx, cy, cz);
                        if (!id || id === 0) continue;
                        const ddx = hitPoint.x - (cx + 0.5);
                        const ddy = hitPoint.y - (cy + 0.5);
                        const ddz = hitPoint.z - (cz + 0.5);
                        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                        if (d2 < bestDist) {
                            bestDist = d2;
                            bestId = id;
                            bestX = cx; bestY = cy; bestZ = cz;
                        }
                    }
                }
            }
            if (bestId !== 0) {
                bx = bestX; by = bestY; bz = bestZ;
                blockId = bestId;
            }
        }
        if (!blockId || blockId === 0) return null;

        const name = this.blockIdToName.get(blockId) ?? `block_${blockId}`;
        const color = voxelWorld.getColor(bx, by, bz) ?? 0xcccccc;
        return {
            bx, by, bz,
            blockId,
            envVoxelObject: null,
            bodyHandle: -1,
            blockName: name,
            color,
            center: new THREE.Vector3(bx + 0.5, by + 0.5, bz + 0.5),
        };
    }

    private destroyLocked(voxelWorld: VoxelWorld | null): void {
        const bx = this._lockedBx, by = this._lockedBy, bz = this._lockedBz;
        const blockId = this._lockedBlockId;
        const env = this._lockedEnvObject;
        const center = this._lockedCenter;
        const name = env
            ? (this._lockedEnvBlockName || this.blockIdToName.get(blockId) || `block_${blockId}`)
            : (this.blockIdToName.get(blockId) ?? `block_${blockId}`);
        const color = env
            ? this._lockedEnvColor
            : voxelWorld?.getColor(bx, by, bz) ?? 0xcccccc;

        if (env) {
            // Scenery VoxelObject may be a shared template for an InstancedMesh,
            // so `explodeAt()` alone would remove voxels from the template
            // without touching the visible instance. Hide the specific
            // InstancedMesh instance that matches our locked target type, and
            // remove the exact collider we hit — nothing else.
            const hidden = this.hideMatchingInstancedMeshInstance(center, 0.75, this._lockedEnvBlockName);
            if (!hidden) {
                env.explodeAt(center.clone(), 0.6, 1.0, 0.2);
            }
            this.removeLockedPhysicsBody();
        } else if (voxelWorld) {
            voxelWorld.setBlock(bx, by, bz, 0);
            voxelWorld.rebuildDirtyChunks();
        }
        this.onBlockDestroyed?.(center.clone(), blockId, name, color);
        this.clearTarget();
    }

    /**
     * Hide the closest InstancedMesh instance within `radius` of `point`
     * whose mesh name is compatible with the locked target's classified
     * block name — prevents mining a rock from accidentally hiding the
     * adjacent tree when their instance origins happen to be closer than
     * the rock's own origin-to-hit-center distance.
     */
    private hideMatchingInstancedMeshInstance(
        point: THREE.Vector3,
        radius: number,
        targetBlockName: string,
    ): boolean {
        const scene = this.engine.scene;
        if (!scene) return false;

        const instanceMatrix = new THREE.Matrix4();
        const instancePos = new THREE.Vector3();
        let bestMesh: THREE.InstancedMesh | null = null;
        let bestIndex = -1;
        let bestDist = radius;

        scene.traverse((obj) => {
            const im = obj as THREE.InstancedMesh;
            if (!im.isInstancedMesh) return;
            const meshName = (im.name || '').toLowerCase();
            if (!meshName) return;
            if (!isSceneryMeshNameCompatible(meshName, targetBlockName)) return;
            for (let i = 0; i < im.count; i++) {
                im.getMatrixAt(i, instanceMatrix);
                instancePos.setFromMatrixPosition(instanceMatrix);
                instancePos.applyMatrix4(im.matrixWorld);
                const d = instancePos.distanceTo(point);
                if (d < bestDist) {
                    bestDist = d;
                    bestMesh = im;
                    bestIndex = i;
                }
            }
        });

        if (!bestMesh || bestIndex < 0) return false;
        const meshTyped = bestMesh as THREE.InstancedMesh;
        // Zero-scale the matrix so the instance is no longer visible. We also
        // move it far below the world so any residual float-precision glitch
        // can't render a tiny remnant at origin.
        const zero = new THREE.Matrix4().compose(
            new THREE.Vector3(0, -1e4, 0),
            new THREE.Quaternion(),
            new THREE.Vector3(0, 0, 0),
        );
        meshTyped.setMatrixAt(bestIndex, zero);
        meshTyped.instanceMatrix.needsUpdate = true;
        return true;
    }

    /**
     * Remove the specific rigid body that was struck to lock the current
     * target (if we have its handle) — NOT every voxelObject-tagged body in
     * the blast radius. Scoping by handle prevents a mined rock from
     * silently deleting the colliders of adjacent rocks/trees.
     */
    private removeLockedPhysicsBody(): void {
        if (this._lockedBodyHandle < 0) return;
        const physicsWorld = this.engine.physicsWorld;
        if (!physicsWorld) return;
        const api = physicsWorld as unknown as {
            world: { getRigidBody: (h: number) => unknown };
            removeRigidBody: (body: unknown) => void;
        };
        const rb = api.world.getRigidBody(this._lockedBodyHandle);
        if (rb) api.removeRigidBody(rb);
    }

    private clearTarget(): void {
        this.targetKey = null;
        this.targetHp = 0;
        this.targetMaxHp = 1;
        this.wobbleTime = 0;
        this.timeSinceLastHit = 0;
        this._lockedEnvObject = null;
        this._lockedBodyHandle = -1;
        this.hideOverlay();
    }

    private renderOverlay(): void {
        this.overlayGroup.visible = true;
        this.visible = true;

        const c = this._lockedCenter;
        const wobX = 0.006 * Math.sin(this.wobbleTime * 22);
        const wobY = 0.006 * Math.cos(this.wobbleTime * 18);
        const wobZ = 0.006 * Math.sin(this.wobbleTime * 26);
        this.overlayGroup.position.set(c.x + wobX, c.y + wobY, c.z + wobZ);
        const scale = 1 + 0.008 * Math.sin(this.wobbleTime * 28);
        this.overlayGroup.scale.setScalar(scale);

        const progress = 1 - Math.max(0, this.targetHp) / Math.max(1e-4, this.targetMaxHp);
        (this.overlayBox.material as THREE.MeshBasicMaterial).opacity = 0.15 + progress * 0.35;
        (this.crackOverlay.material as THREE.MeshBasicMaterial).opacity = progress * 0.9;
    }

    private hideOverlay(): void {
        if (!this.visible) return;
        this.overlayGroup.visible = false;
        this.visible = false;
    }
}

interface ResolvedTarget {
    bx: number;
    by: number;
    bz: number;
    blockId: number;
    envVoxelObject: VoxelObject | null;
    /** Physics body handle for the struck rigid body, or -1 for terrain / scenery-only hits. */
    bodyHandle: number;
    blockName: string;
    color: number;
    center: THREE.Vector3;
}

/**
 * Tokens that identify a mesh as tree-like scenery. Used for hide-time
 * type parity so mining a rock doesn't hide an adjacent tree whose pivot
 * happens to be closer to the hit point than the rock's own pivot.
 */
const TREE_TOKENS = ['tree', 'trunk', 'leaf', 'leaves', 'log', 'branch'];
const ROCK_TOKENS = ['rock', 'stone'];

/**
 * Does an InstancedMesh `meshName` render scenery of the category the
 * mining system resolved for the locked target (`targetBlockName`)? E.g.
 * a `stone` lock should only match rock/stone meshes; a `trunk` / `leaves`
 * lock should only match tree meshes; specific resource names (`gold`,
 * `iron`, `mithril`) match any mesh whose name contains them. Returns
 * `true` when we can't classify confidently — better to do the hide than
 * skip a legitimate match.
 */
function isSceneryMeshNameCompatible(meshName: string, targetBlockName: string): boolean {
    const mn = meshName.toLowerCase();
    const tgt = (targetBlockName || '').toLowerCase();
    if (tgt && mn.includes(tgt)) return true;
    if (tgt === 'stone') return ROCK_TOKENS.some(t => mn.includes(t));
    if (tgt === 'trunk' || tgt === 'leaves') return TREE_TOKENS.some(t => mn.includes(t));
    // Any other scenery-looking mesh — fall through to permissive match so
    // novel block names still work.
    return (
        ROCK_TOKENS.some(t => mn.includes(t)) ||
        TREE_TOKENS.some(t => mn.includes(t))
    );
}

/**
 * Generic decorator / container tokens that don't identify a resource.
 * Stripped when parsing a mesh / asset name so we can pick out the
 * distinctive material token (e.g. `gold_stone_instanced` → `gold`).
 */
const GENERIC_TOKENS = new Set([
    'voxel', 'voxels',
    'rock', 'rocks', 'stone', 'stones',
    'ore', 'ores',
    'block', 'blocks',
    'instanced', 'mesh', 'meshes', 'asset', 'assets', 'vxl',
    'object', 'objects',
    'tree', 'trees', 'trunk', 'trunks', 'log', 'logs',
    'leaf', 'leaves',
    'wood', 'woods',
]);

/**
 * Parse a mesh / asset name hint into `[tokens]`, splitting on `_`, `-`,
 * whitespace, AND camelCase boundaries so `voxelRock_instanced` yields
 * `['voxel', 'rock', 'instanced']`.
 */
function tokenizeHint(hint: string): string[] {
    return (hint || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split(/[_\s-]+/)
        .filter(Boolean);
}

function classifyVoxelObject(env: VoxelObject, hitPoint: THREE.Vector3, nameHint?: string): { name: string; color: number } {
    const tokens = [...tokenizeHint(env.name || ''), ...tokenizeHint(nameHint || '')];

    // Prefer the first *specific* token — anything that isn't a generic
    // container word. This handles arbitrary resource names the engine has
    // never seen (e.g. `mithril`, `bronze`, `crystal_ore_instanced`) without
    // a hard-coded list.
    const specific = tokens.find(t => !GENERIC_TOKENS.has(t));
    if (specific) return { name: specific, color: 0xaaaaaa };

    // No specific token found — fall back to broad categories based on the
    // generic tokens that are present.
    const has = (w: string) => tokens.includes(w);
    if (has('tree') || has('trees') || has('trunk') || has('trunks') || has('log') || has('logs')) {
        const bbox = new THREE.Box3().setFromObject(env);
        const range = bbox.max.y - bbox.min.y;
        const frac = range > 1e-4 ? (hitPoint.y - bbox.min.y) / range : 0.5;
        return frac > 0.55
            ? { name: 'leaves', color: 0x2e8b2e }
            : { name: 'trunk', color: 0x7a5230 };
    }
    if (has('leaf') || has('leaves')) return { name: 'leaves', color: 0x2e8b2e };
    if (has('rock') || has('rocks') || has('stone') || has('stones')) return { name: 'stone', color: 0x888888 };
    return { name: 'wood', color: 0x7a5230 };
}

function buildCrackTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(8, 10);
    ctx.lineTo(30, 28);
    ctx.lineTo(22, 46);
    ctx.lineTo(44, 58);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(54, 8);
    ctx.lineTo(40, 30);
    ctx.lineTo(56, 44);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12, 52);
    ctx.lineTo(28, 38);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
}
