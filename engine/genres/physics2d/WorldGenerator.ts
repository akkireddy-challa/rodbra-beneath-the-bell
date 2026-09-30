import RAPIER2D from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { WorldProfileData, EngineLike, GameData, Asset } from 'types/game.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import {
    applyExplosionImpulseToDebris2D,
    applyFootKickDebris2D,
    createVoxelColliders2D,
    explodeVoxelObject2D,
    updateDebris2D,
    type VoxelBody2D,
    type Debris2D,
} from 'engine/physics/VoxelPhysics2D.js';

interface PlatformDef {
    x: number;
    y: number;
    width: number;
    height: number;
    color?: number;
}

const VOXEL_SIZE = 0.5;

export class WorldGenerator {
    private physicsWorld: PhysicsWorld2D;
    private engine: EngineLike;
    private worldProfileData: WorldProfileData;
    private gameData: GameData | null;
    private worldGroup: THREE.Group;
    private bodies: RAPIER2D.RigidBody[] = [];
    private voxelObjects: VoxelObject[] = [];
    private voxelBodies: VoxelBody2D[] = [];
    private debris: Debris2D[] = [];

    constructor(physicsWorld: PhysicsWorld2D, engine: EngineLike, worldProfileData: WorldProfileData, gameData?: GameData) {
        this.physicsWorld = physicsWorld;
        this.engine = engine;
        this.worldProfileData = worldProfileData;
        this.gameData = gameData ?? null;
        this.worldGroup = new THREE.Group();
        this.worldGroup.name = 'Physics2D_World';
    }

    async generateWorld(): Promise<void> {
        this.buildDefaultWorld();

        if (this.engine.scene) {
            this.engine.scene.add(this.worldGroup);
        }

        this.physicsWorld.step(1 / 60);

        await this.loadEnvironmentObjects();
    }

    private buildDefaultWorld(): void {
        const R = getRapier2D();

        // Ground platform
        this.createVoxelPlatform(R, { x: 0, y: -2, width: 20, height: 1, color: 0x4a8c3f });

        // Floating platforms
        this.createVoxelPlatform(R, { x: -6, y: 1, width: 4, height: 0.5, color: 0x8b7355 });
        this.createVoxelPlatform(R, { x: 6, y: 3, width: 4, height: 0.5, color: 0x8b7355 });
        this.createVoxelPlatform(R, { x: 0, y: 5, width: 3, height: 0.5, color: 0x8b7355 });
    }

    /**
     * Load environmentObjects from world.json, resolving URLs via the assets array.
     * Uses assetId to look up the current asset URL, so re-voxelizing an asset
     * automatically updates all instances without code changes.
     */
    private async loadEnvironmentObjects(): Promise<void> {
        const envObjects = this.gameData?.environmentObjects;
        const assets = this.gameData?.assets;
        if (!envObjects || !Array.isArray(envObjects) || envObjects.length === 0) return;

        for (const obj of envObjects) {
            const assetId: string | undefined = obj.assetId;
            const assetName: string | undefined = obj.type;
            const url = this.resolveAssetUrl(assetId, assetName, assets);
            if (!url) {
                console.warn(`[WorldGenerator] Cannot resolve URL for environmentObject id=${obj.id} assetId=${assetId} type=${assetName}`);
                continue;
            }

            const pos = obj.position ?? { x: 0, y: 0 };
            await this.loadVoxelAsset(url, pos.x ?? 0, pos.y ?? 0);
        }
    }

    private resolveAssetUrl(assetId?: string, assetName?: string, assets?: Asset[]): string | null {
        if (!assets || assets.length === 0) return null;

        if (assetId) {
            const byId = assets.find(a => a.id === assetId);
            if (byId) return byId.url;
        }
        if (assetName) {
            const byName = assets.find(a => a.name === assetName);
            if (byName) return byName.url;
        }
        return null;
    }

    /**
     * Load a voxel asset by name (from the assets library in world.json).
     * Resolves the current URL at runtime, so re-voxelizing an asset
     * automatically picks up the new version.
     */
    async loadAssetByName(assetName: string, x: number, y: number): Promise<VoxelBody2D | null> {
        const url = this.resolveAssetUrl(undefined, assetName, this.gameData?.assets);
        if (!url) {
            console.warn(`[WorldGenerator] Asset "${assetName}" not found in assets library`);
            return null;
        }
        return this.loadVoxelAsset(url, x, y);
    }

    /**
     * Load a voxel asset by asset ID (from the assets library in world.json).
     * Resolves the current URL at runtime, so re-voxelizing an asset
     * automatically picks up the new version.
     */
    async loadAssetById(assetId: string, x: number, y: number): Promise<VoxelBody2D | null> {
        const url = this.resolveAssetUrl(assetId, undefined, this.gameData?.assets);
        if (!url) {
            console.warn(`[WorldGenerator] Asset ID "${assetId}" not found in assets library`);
            return null;
        }
        return this.loadVoxelAsset(url, x, y);
    }

    /**
     * Load a .vxl asset from URL and place it at the given 2D position
     * with voxel-accurate compound colliders.
     */
    async loadVoxelAsset(url: string, x: number, y: number): Promise<VoxelBody2D | null> {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.warn(`[WorldGenerator] Failed to fetch voxel asset: ${response.status}`);
                return null;
            }
            const buffer = await response.arrayBuffer();

            const voxelObj = new VoxelObject({ shadows: true });
            await voxelObj.loadFromFile(buffer);

            voxelObj.position.set(x, y, 0);
            this.worldGroup.add(voxelObj);
            this.voxelObjects.push(voxelObj);

            const voxelBody = createVoxelColliders2D(voxelObj, this.physicsWorld, { x, y });
            this.voxelBodies.push(voxelBody);
            this.bodies.push(voxelBody.body);

            return voxelBody;
        } catch (err) {
            console.warn('[WorldGenerator] Error loading voxel asset:', err);
            return null;
        }
    }

    /**
     * Explode a voxel object at a world position.
     * Damage is a 3D sphere (worldCenterZ included): voxels outside radius in Z are not removed.
     */
    explodeAt(
        worldX: number,
        worldY: number,
        radius: number,
        impulseStrength: number = 5,
        worldCenterZ: number = 0,
    ): Debris2D[] {
        if (!this.engine.scene) return [];

        applyExplosionImpulseToDebris2D(this.debris, worldX, worldY, radius, impulseStrength);

        const newDebris: Debris2D[] = [];
        for (const vb of this.voxelBodies) {
            if (vb.voxelObject.isDestroyed()) continue;
            const d = explodeVoxelObject2D(
                vb, { x: worldX, y: worldY, z: worldCenterZ }, radius,
                this.physicsWorld, this.engine.scene, impulseStrength,
            );
            newDebris.push(...d);
        }
        this.debris.push(...newDebris);
        return newDebris;
    }

    /**
     * Optional: nudge debris near the feet. Default Physics2DGame does not call this — debris
     * should not affect the player; use only if you want cosmetic scatter without rigid contact.
     */
    applyFootDebrisKick(feetX: number, feetY: number, velocityX: number, deltaTime: number): void {
        applyFootKickDebris2D(this.debris, feetX, feetY, velocityX, deltaTime);
    }

    /** Sync debris meshes with physics. Call every frame from Game.update(). */
    update(): void {
        if (!this.engine.scene) return;
        this.debris = updateDebris2D(this.debris, this.physicsWorld, this.engine.scene);
    }

    private createVoxelPlatform(R: typeof RAPIER2D, plat: PlatformDef): void {
        const hw = plat.width / 2;
        const hh = plat.height / 2;

        const bodyDesc = R.RigidBodyDesc.fixed().setTranslation(plat.x, plat.y);
        const body = this.physicsWorld.createRigidBody(bodyDesc);
        const colliderDesc = R.ColliderDesc.cuboid(hw, hh)
            .setFriction(0.7)
            .setRestitution(0.0)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT));
        this.physicsWorld.createCollider(colliderDesc, body);
        this.bodies.push(body);

        const voxelObj = new VoxelObject({ voxelSize: VOXEL_SIZE, shadows: true });
        const color = plat.color ?? 0x888888;
        const blockType = BlockType.COLOR as BlockTypeId;

        const voxelsW = Math.max(1, Math.round(plat.width / VOXEL_SIZE));
        const voxelsH = Math.max(1, Math.round(plat.height / VOXEL_SIZE));
        const voxelsD = Math.max(1, Math.round(1.0 / VOXEL_SIZE));

        for (let vx = 0; vx < voxelsW; vx++) {
            for (let vy = 0; vy < voxelsH; vy++) {
                for (let vz = 0; vz < voxelsD; vz++) {
                    const shade = this.varyColor(color, 0.08);
                    voxelObj.setVoxel(vx, vy, vz, blockType, shade);
                }
            }
        }

        voxelObj.finalize();
        voxelObj.position.set(plat.x, plat.y - hh, 0);

        this.worldGroup.add(voxelObj);
        this.voxelObjects.push(voxelObj);
    }

    private varyColor(base: number, amount: number): number {
        const r = (base >> 16) & 0xff;
        const g = (base >> 8) & 0xff;
        const b = base & 0xff;
        const vary = (c: number) => Math.max(0, Math.min(255, Math.round(c + (Math.random() - 0.5) * 2 * amount * 255)));
        return (vary(r) << 16) | (vary(g) << 8) | vary(b);
    }

    createDynamicBox(x: number, y: number, width: number, height: number, color = 0xcc8844): RAPIER2D.RigidBody {
        const R = getRapier2D();
        const hw = width / 2;
        const hh = height / 2;

        const bodyDesc = R.RigidBodyDesc.dynamic().setTranslation(x, y);
        const body = this.physicsWorld.createRigidBody(bodyDesc);
        const colliderDesc = R.ColliderDesc.cuboid(hw, hh)
            .setFriction(0.5)
            .setRestitution(0.2)
            .setMass(1.0)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP));
        this.physicsWorld.createCollider(colliderDesc, body);

        const voxelObj = new VoxelObject({ voxelSize: VOXEL_SIZE, shadows: true });
        const blockType = BlockType.COLOR as BlockTypeId;
        const voxelsW = Math.max(1, Math.round(width / VOXEL_SIZE));
        const voxelsH = Math.max(1, Math.round(height / VOXEL_SIZE));
        const voxelsD = Math.max(1, Math.round(0.8 / VOXEL_SIZE));

        for (let vx = 0; vx < voxelsW; vx++) {
            for (let vy = 0; vy < voxelsH; vy++) {
                for (let vz = 0; vz < voxelsD; vz++) {
                    voxelObj.setVoxel(vx, vy, vz, blockType, this.varyColor(color, 0.06));
                }
            }
        }

        voxelObj.finalize();
        voxelObj.position.set(x, y - hh, 0);
        voxelObj.userData['physicsBody'] = body;
        this.worldGroup.add(voxelObj);
        this.voxelObjects.push(voxelObj);
        this.bodies.push(body);

        return body;
    }

    getWorld(): THREE.Group {
        return this.worldGroup;
    }

    getBodies(): RAPIER2D.RigidBody[] {
        return this.bodies;
    }

    getVoxelBodies(): VoxelBody2D[] {
        return this.voxelBodies;
    }

    dispose(): void {
        for (const body of this.bodies) {
            if (body.isValid()) {
                this.physicsWorld.removeRigidBodyImmediate(body);
            }
        }
        this.bodies = [];

        if (this.engine.scene) {
            for (const d of this.debris) {
                if (d.body.isValid()) this.physicsWorld.removeRigidBodyImmediate(d.body);
                this.engine.scene.remove(d.mesh);
                d.mesh.geometry.dispose();
                (d.mesh.material as THREE.Material).dispose();
            }
        }
        this.debris = [];

        for (const vo of this.voxelObjects) {
            vo.dispose();
        }
        this.voxelObjects = [];
        this.voxelBodies = [];

        if (this.engine.scene) {
            this.engine.scene.remove(this.worldGroup);
        }
    }
}
