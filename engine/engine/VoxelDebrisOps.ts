import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { getMaterialRegistry } from 'engine/MaterialRegistry.js';
import { VoxelDebrisManager } from 'engine/VoxelDebrisManager.js';

/**
 * Debris spawning for VoxelWorld — split out of VoxelWorld.ts (same pattern as
 * VoxelObjectColliderOps) to keep that file inside the max-lines budget.
 */

/**
 * Spawn dynamic debris rigid bodies from removed blocks.
 * Creates one rigid body per block with physics simulation.
 * Rendering is handled by VoxelDebrisManager via InstancedMesh pools.
 */
export function spawnDebrisFromBlocks(
    world: VoxelWorld,
    physicsWorld: PhysicsWorld,
    parentGroup: THREE.Object3D,
    voxelSize: number,
    blocks: Array<{ x: number; y: number; z: number; blockType: number }>,
    centerX: number, centerY: number, centerZ: number,
    impulseStrength: number, impulseUp: number,
    fixedDirection?: THREE.Vector3,
): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> {
    const debris: Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> = [];
    const halfSize = voxelSize / 2;
    const atlas = getVoxelTextureAtlas();
    const collisionGroups = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);

    for (const block of blocks) {
        const basePosX = block.x + halfSize, basePosY = block.y + halfSize, basePosZ = block.z + halfSize;
        const dx = basePosX - centerX, dy = basePosY - centerY, dz = basePosZ - centerZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz), offsetDist = voxelSize * 0.6;
        let posX: number, posY: number, posZ: number;
        if (dist > 0.01) { posX = basePosX + (dx / dist) * offsetDist; posY = basePosY + (dy / dist) * offsetDist + voxelSize * 0.3; posZ = basePosZ + (dz / dist) * offsetDist; }
        else { posX = basePosX; posY = basePosY + offsetDist; posZ = basePosZ; }

        let impulseX: number, impulseY: number, impulseZ: number;
        if (fixedDirection) { impulseX = fixedDirection.x * impulseStrength; impulseY = fixedDirection.y * impulseStrength + impulseUp; impulseZ = fixedDirection.z * impulseStrength; }
        else {
            const horizDist = Math.sqrt(dx * dx + dz * dz);
            if (horizDist > 0.01) { impulseX = (dx / horizDist) * impulseStrength; impulseZ = (dz / horizDist) * impulseStrength; }
            else { const angle = Math.random() * Math.PI * 2; impulseX = Math.cos(angle) * impulseStrength; impulseZ = Math.sin(angle) * impulseStrength; }
            impulseY = impulseStrength + impulseUp;
        }

        const materialId = atlas.getBlockMaterial(block.blockType);
        const density = materialId !== undefined ? getMaterialRegistry().getDensity(materialId) : 2000;

        const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(posX, posY, posZ).setLinvel(impulseX, impulseY, impulseZ)
            .setAngvel({ x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8 })
            .setLinearDamping(0.5).setAngularDamping(0.8).setCcdEnabled(true);
        const body = physicsWorld.createRigidBody(rigidBodyDesc);

        const colliderDesc = RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize)
            .setCollisionGroups(collisionGroups).setFriction(0.5).setRestitution(0.6).setDensity(density);
        const collider = physicsWorld.createCollider(colliderDesc, body);

        physicsWorld.setUserData(body, { createdAt: performance.now(), blockType: block.blockType, isVoxelDebris: true, voxelWorld: world, density, debrisSize: voxelSize });

        debris.push({ body, collider });
        VoxelDebrisManager.spawnDebris(body, collider, physicsWorld, block.blockType, voxelSize, parentGroup);
    }

    return debris;
}
