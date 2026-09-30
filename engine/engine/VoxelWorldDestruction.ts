import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK_SIZE } from 'engine/VoxelGeometry.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { getMaterialRegistry } from 'engine/MaterialRegistry.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { VoxelDebrisManager } from 'engine/VoxelDebrisManager.js';
import { spawnDebrisFromBlocks } from 'engine/VoxelDebrisOps.js';
import type { MergedDebris, VoxelWorld } from 'engine/VoxelWorld.js';

/**
 * VoxelWorldDestruction — carving voxels out of the world and turning what was
 * removed into physics debris: sphere/box removal, detaching blocks and merged
 * debris as rigid bodies, and merging settled debris back into a chunk.
 *
 * A FRIEND MODULE, the same seam VoxelObjectPristineOps and EnvObjectPackOps
 * use: these operations belong to VoxelWorld conceptually, but VoxelWorld.ts
 * sits at the repo's 2000-line ESLint cap, so they live here and reach the
 * class's private state through TypeScript's sanctioned element-access escape
 * hatch (`world['chunks']` — typed, not `any`).
 *
 * VoxelWorld keeps the six public entry points as methods delegating here:
 * templates in published games are compiled against that surface.
 *
 * Import-cycle note: VoxelWorld.ts imports these functions, so this module
 * imports it as a TYPE ONLY. Keep it that way.
 */

/** Remove all blocks within a sphere (uses batch mode). @returns Array of removed block positions and types */
export function removeBlocksInSphere(
    world: VoxelWorld,
        centerX: number, 
    centerY: number, 
    centerZ: number, 
    radius: number
): Array<{ x: number; y: number; z: number; blockType: number }> {
    const removed: Array<{ x: number; y: number; z: number; blockType: number }> = [];
    const wasBatchMode = world['batchMode'];
    const atlas = getVoxelTextureAtlas();
    
    if (!wasBatchMode) {
        world.beginBatchUpdate();
    }

    const radiusSq = radius * radius;
    
    // Snap to voxel grid
    const minX = Math.floor(centerX - radius / world['voxelSize']) * world['voxelSize'];
    const maxX = Math.ceil((centerX + radius) / world['voxelSize']) * world['voxelSize'];
    const minY = Math.floor((centerY - radius) / world['voxelSize']) * world['voxelSize'];
    const maxY = Math.ceil((centerY + radius) / world['voxelSize']) * world['voxelSize'];
    const minZ = Math.floor((centerZ - radius) / world['voxelSize']) * world['voxelSize'];
    const maxZ = Math.ceil((centerZ + radius) / world['voxelSize']) * world['voxelSize'];

    let checked = 0;
    let foundBlocks = 0;
    
    // Iterate in voxel-sized steps
    for (let x = minX; x <= maxX; x += world['voxelSize']) {
        for (let y = minY; y <= maxY; y += world['voxelSize']) {
            for (let z = minZ; z <= maxZ; z += world['voxelSize']) {
                checked++;
                // Check if voxel center is within sphere
                const voxelCenterX = x + world['voxelSize'] / 2;
                const voxelCenterY = y + world['voxelSize'] / 2;
                const voxelCenterZ = z + world['voxelSize'] / 2;
                
                const dx = voxelCenterX - centerX;
                const dy = voxelCenterY - centerY;
                const dz = voxelCenterZ - centerZ;
                const distSq = dx * dx + dy * dy + dz * dz;
                
                if (distSq <= radiusSq) {
                    const blockType = world.getBlock(x, y, z);
                    if (blockType !== 0) {
                        foundBlocks++;
                        removed.push({ x, y, z, blockType });
                        world.setBlock(x, y, z, 0);
                    }
                }
            }
        }
    }
    

    if (!wasBatchMode) {
        world.endBatchUpdate();
    }
    
    // Refill water if solid terrain was destroyed adjacent to water bodies
    const solidBlocksRemoved = removed.filter(b => !atlas.isFluidBlock(b.blockType));
    if (solidBlocksRemoved.length > 0) {
        world['waterRefill'].refillWaterAfterDestruction(solidBlocksRemoved);
    }

    return removed;
}

/**
 * Remove all blocks within a box.
 * Uses batch mode internally for efficiency.
 * @returns Array of removed block positions and block types
 */
export function removeBlocksInBox(
    world: VoxelWorld,
        minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number
): Array<{ x: number; y: number; z: number; blockType: number }> {
    const removed: Array<{ x: number; y: number; z: number; blockType: number }> = [];
    const wasBatchMode = world['batchMode'];
    const atlas = getVoxelTextureAtlas();
    
    if (!wasBatchMode) {
        world.beginBatchUpdate();
    }

    // Iterate in voxel-sized steps
    for (let x = minX; x <= maxX; x += world['voxelSize']) {
        for (let y = minY; y <= maxY; y += world['voxelSize']) {
            for (let z = minZ; z <= maxZ; z += world['voxelSize']) {
                const blockType = world.getBlock(x, y, z);
                if (blockType !== 0) {
                    removed.push({ x, y, z, blockType });
                    world.setBlock(x, y, z, 0);
                }
            }
        }
    }

    if (!wasBatchMode) {
        world.endBatchUpdate();
    }
    
    // Refill water if solid terrain was destroyed adjacent to water bodies
    const solidBlocksRemoved = removed.filter(b => !atlas.isFluidBlock(b.blockType));
    if (solidBlocksRemoved.length > 0) {
        world['waterRefill'].refillWaterAfterDestruction(solidBlocksRemoved);
    }

    return removed;
}


/**
 * Detached block info returned by detach methods
 */


/**
 * Detach blocks within a sphere - removes from terrain and spawns dynamic debris.
 * @param centerX, centerY, centerZ - Center of sphere in world coordinates
 * @param radius - Radius of sphere
 * @param impulseStrength - Optional impulse magnitude (outward from center)
 * @param impulseUp - Optional upward impulse component
 * @returns Array of spawned debris rigid bodies (caller can apply additional forces)
 */
export function detachBlocksInSphere(world: VoxelWorld, centerX: number, centerY: number, centerZ: number, radius: number, impulseStrength: number = 5, impulseUp: number = 2): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> {
    const blocks = collectBlocksInSphere(world, centerX, centerY, centerZ, radius);
    const mergedDebris = detachMergedDebrisInSphere(world, centerX, centerY, centerZ, radius, impulseStrength, impulseUp);
    let debris: Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> = [];
    const physicsWorld = world['physicsWorld'];
    if (blocks.length > 0) {
        // 2D lane: the voxels are carved, no 3D debris bodies to spawn.
        if (physicsWorld) {
            debris = spawnDebrisFromBlocks(world, physicsWorld, world['parentGroup'], world['voxelSize'], blocks, centerX, centerY, centerZ, impulseStrength, impulseUp);
        }
        removeCollectedBlocks(world, blocks);
        
        world['waterRefill'].refillWaterAfterDestruction(blocks);
    }
    
    triggerExplosionWaves(world, centerX, centerZ, radius, impulseStrength * 0.1);
    
    return [...debris, ...mergedDebris];
}
    
function triggerExplosionWaves(_world: VoxelWorld, _cX: number, _cZ: number, _r: number, _s: number): void { /* Wave effects stub */ }

function detachMergedDebrisInSphere(world: VoxelWorld, cX: number, cY: number, cZ: number, radius: number, impStr: number, impUp: number): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> {
    const rSq = radius * radius, result: Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> = [], dirty = new Set<string>();
    const atlas = getVoxelTextureAtlas();
    const physicsWorld = world['physicsWorld'];
    if (!physicsWorld) return []; // debris never merges into terrain without a 3D world to settle in
    for (const [key, chunk] of world['chunks']) {
        if (chunk.mergedDebris.length === 0) continue;
        const keep: MergedDebris[] = [];
        for (const md of chunk.mergedDebris) {
            let mx = 0, my = 0, mz = 0; for (let i = 0; i < 8; i++) { mx += md.vertices[i*3]!; my += md.vertices[i*3+1]!; mz += md.vertices[i*3+2]!; } mx /= 8; my /= 8; mz /= 8;
            const dx = mx - cX, dy = my - cY, dz = mz - cZ;
            if (dx*dx + dy*dy + dz*dz <= rSq) {
                const dist = Math.sqrt(dx*dx + dy*dy + dz*dz), iX = dist > 0.01 ? dx/dist*impStr : 0, iY = (dist > 0.01 ? dy/dist*impStr : 0) + impUp, iZ = dist > 0.01 ? dz/dist*impStr : 0;
                const size = md.debrisSize ?? world['voxelSize'];
                const h = size / 2;
                const q = new THREE.Quaternion(md.rotation.x, md.rotation.y, md.rotation.z, md.rotation.w);
                const bd = RAPIER.RigidBodyDesc.dynamic().setTranslation(mx,my,mz).setRotation(q).setLinvel(iX,iY,iZ).setAngvel({x:(Math.random()-.5)*8,y:(Math.random()-.5)*8,z:(Math.random()-.5)*8}).setLinearDamping(.5).setAngularDamping(.8).setCcdEnabled(true);
                const body = physicsWorld.createRigidBody(bd), cg = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);
                const cd = RAPIER.ColliderDesc.cuboid(h,h,h).setCollisionGroups(cg).setFriction(.5).setRestitution(.6).setDensity(2000);
                const collider = physicsWorld.createCollider(cd, body);
                const matId = atlas.getBlockMaterial(md.blockType);
                const dens = matId !== undefined ? getMaterialRegistry().getDensity(matId) : 2000;
                const userData: Record<string, unknown> = { blockType: md.blockType, isVoxelDebris: true, voxelWorld: world, density: dens, debrisSize: size };
                if (md.color) userData.color = md.color;
                physicsWorld.setUserData(body, userData);
                if (md.color) {
                    VoxelDebrisManager.spawnColoredDebris(body, collider, physicsWorld, md.color.r, md.color.g, md.color.b, size, world['parentGroup']);
                } else {
                    VoxelDebrisManager.spawnDebris(body, collider, physicsWorld, md.blockType, size, world['parentGroup']);
                }
                result.push({ body, collider }); dirty.add(key);
            } else keep.push(md);
        }
        if (keep.length !== chunk.mergedDebris.length) chunk.mergedDebris = keep;
    }
    for (const key of dirty) { const c = world['chunks'].get(key); if (c) { world['dirtyChunks'].add(c); world['dirtyChecksumChunks'].add(key); } }
    if (dirty.size > 0) world.updatePhysicsAndMeshing();
    return result;
}

/**
 * Collect blocks within a sphere without removing them.
 */
function collectBlocksInSphere(
    world: VoxelWorld,
        centerX: number, 
    centerY: number, 
    centerZ: number, 
    radius: number
): Array<{ x: number; y: number; z: number; blockType: number }> {
    const collected: Array<{ x: number; y: number; z: number; blockType: number }> = [];
    const radiusSq = radius * radius;
    const atlas = getVoxelTextureAtlas();
    
    // Snap to voxel grid
    const minX = Math.floor((centerX - radius) / world['voxelSize']) * world['voxelSize'];
    const maxX = Math.ceil((centerX + radius) / world['voxelSize']) * world['voxelSize'];
    const minY = Math.floor((centerY - radius) / world['voxelSize']) * world['voxelSize'];
    const maxY = Math.ceil((centerY + radius) / world['voxelSize']) * world['voxelSize'];
    const minZ = Math.floor((centerZ - radius) / world['voxelSize']) * world['voxelSize'];
    const maxZ = Math.ceil((centerZ + radius) / world['voxelSize']) * world['voxelSize'];
    
    // Iterate in voxel-sized steps
    for (let x = minX; x <= maxX; x += world['voxelSize']) {
        for (let y = minY; y <= maxY; y += world['voxelSize']) {
            for (let z = minZ; z <= maxZ; z += world['voxelSize']) {
                // Check if voxel center is within sphere
                const voxelCenterX = x + world['voxelSize'] / 2;
                const voxelCenterY = y + world['voxelSize'] / 2;
                const voxelCenterZ = z + world['voxelSize'] / 2;
                
                const dx = voxelCenterX - centerX;
                const dy = voxelCenterY - centerY;
                const dz = voxelCenterZ - centerZ;
                const distSq = dx * dx + dy * dy + dz * dz;
                
                if (distSq <= radiusSq) {
                    const blockType = world.getBlock(x, y, z);
                    // Only collect solid blocks, not air or fluids
                    if (blockType !== 0 && !atlas.isFluidBlock(blockType)) {
                        collected.push({ x, y, z, blockType });
                    }
                }
            }
        }
    }
    
    return collected;
}

/**
 * Remove previously collected blocks from the terrain.
 */
function removeCollectedBlocks(world: VoxelWorld, blocks: Array<{ x: number; y: number; z: number; blockType: number }>): void {
    world.beginBatchUpdate();
    for (const block of blocks) {
        world.setBlock(block.x, block.y, block.z, 0);
    }
    world.endBatchUpdate();
}

/**
 * Detach blocks within a box - removes from terrain and spawns dynamic debris.
 * @param minX, minY, minZ, maxX, maxY, maxZ - Box bounds in world coordinates
 * @param impulseDirection - Direction to apply impulse (normalized)
 * @param impulseStrength - Impulse magnitude
 * @returns Array of spawned debris rigid bodies
 */
export function detachBlocksInBox(
    world: VoxelWorld,
        minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
    impulseDirection?: THREE.Vector3,
    impulseStrength: number = 5
): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> {
    // First collect all blocks to remove
    const blocksToDetach = world.removeBlocksInBox(minX, minY, minZ, maxX, maxY, maxZ);
    
    // Calculate center of box for default impulse direction
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;
    
    // Refill water if terrain was destroyed adjacent to water bodies
    if (blocksToDetach.length > 0) {
        world['waterRefill'].refillWaterAfterDestruction(blocksToDetach);
    }
    
    // Spawn debris for each removed block — none in the 2D lane, which has no
    // physics world to put bodies in.
    const physicsWorld = world['physicsWorld'];
    if (!physicsWorld) return [];
    return spawnDebrisFromBlocks(world,
        physicsWorld, world['parentGroup'], world['voxelSize'], 
        blocksToDetach, 
        centerX, centerY, centerZ, 
        impulseStrength, 
        0,
        impulseDirection
    );
}


/**
 * Clear all debris for this world (used on level reset).
 */
export function clearDebris(world: VoxelWorld): void {
    const physicsWorld = world['physicsWorld'];
    if (physicsWorld) VoxelDebrisManager.clearForWorld(physicsWorld);
}
