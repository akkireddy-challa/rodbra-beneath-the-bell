import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelObject, type VoxelObjectDebris } from 'engine/VoxelObject.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { trueUpBodyMass } from 'engine/physics/BallPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { greedyMeshOctreeLeaves, octreeVoxelCells, type OctreeVoxelCells, type PhysicsBox } from 'engine/VoxelOctreeRenderer.js';
import { sphereIntersectsAabb } from 'engine/VoxelGeometry.js';
import { findUnsupportedFragments, groundPlaneY, type FragmentAabb } from 'engine/FragmentConnectivity.js';
import type { FragmentSlot, FragmentVisualSource } from 'engine/FragmentInstancePool.js';
import { attachUnionVoxelCollider, chunkVoxelCells, clearColliders, collectChunkPhysicsBoxes, createStaticVoxelBody } from 'engine/VoxelObjectColliderOps.js';

/**
 * VoxelObjectPristineOps — the batched-pristine destructible machinery for
 * VoxelObject (see PristineDestructible.ts / EnvironmentObjectSystem for the
 * consumer side).
 *
 * This is deliberately a FRIEND MODULE: the operations belong to VoxelObject
 * conceptually, but VoxelObject.ts sits at the repo's 2000-line ESLint cap,
 * so they live here and reach the class's private state through TypeScript's
 * sanctioned element-access escape hatch (`vox['_fragments']` — typed, not
 * `any`). Keep every private-touching pristine/fragment operation in THIS
 * file so the seam stays in one place.
 *
 * Import-cycle note: VoxelObject.ts imports several of these functions. That
 * cycle is safe because this module only ever uses the VoxelObject binding
 * inside function bodies (call time), never at module evaluation — do NOT
 * add module-level or class-extends usage of VoxelObject here.
 */

/** Number of pre-baked fragments (0 when not a multi-fragment container). */
export function getFragmentCount(vox: VoxelObject): number {
    return vox['_fragments']?.length ?? 0;
}

/**
 * Geometry/material REFERENCES of a pre-fragmented template's fragment
 * meshes, for shared instanced rendering of broken instances. Null unless
 * every fragment has a built mesh (templates build them at load).
 */
export function getFragmentVisualSources(vox: VoxelObject): FragmentVisualSource[] | null {
    const fragments = vox['_fragments'];
    if (!fragments || fragments.length === 0) return null;
    const out: FragmentVisualSource[] = [];
    for (const child of fragments) {
        const mesh = child['mesh'];
        if (!mesh) return null;
        out.push({ geometry: mesh.geometry, material: mesh.material });
    }
    return out;
}

/**
 * Union collider boxes for the whole object (all fragments / all chunks),
 * greedy-meshed once and cached on the object. Called on an asset TEMPLATE
 * this is a per-type cost that every placed instance then shares — instead
 * of re-greedy-meshing every fragment for every instance.
 *
 * Reads the RESIDENT leaf storage (`octreeLeafSources`) and never converts it:
 * the greedy mesher iterates LeafBuffers directly, so neither a fragment nor a
 * single-body template ever expands its compact buffer into per-voxel objects
 * for the sake of a collider.
 */
export function getUnionColliderBoxes(vox: VoxelObject): PhysicsBox[] {
    const cached = vox['_unionColliderBoxes'];
    if (cached) return cached;
    const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = vox['getBoundsAndPivot']();
    let boxes: PhysicsBox[];
    if (vox['_isOctreeV2']) {
        // One greedy mesh over every fragment's resident storage at once (a
        // single-body template contributes its own), so the union never has to
        // exist as a concatenated OctreeLeaf[].
        boxes = greedyMeshOctreeLeaves(vox['octreeLeafSources'], pivotX, pivotY, pivotZ, vox['getPhysicsGridStep']());
    } else {
        boxes = collectChunkPhysicsBoxes(vox, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ);
    }
    vox['_unionColliderBoxes'] = boxes;
    return boxes;
}

/**
 * The static-collider counterpart of getUnionColliderBoxes: one cell set per
 * TYPE, cached on the template and shared by every placed instance — scale
 * composes at attach time, so the cache is scale-free. Octree templates
 * rasterize their resident leaf storage; v1 (chunked) templates expand their
 * greedy collision boxes. Null when the template has no collidable voxels.
 */
export function getUnionVoxelCells(vox: VoxelObject): OctreeVoxelCells | null {
    const cached = vox['_unionVoxelCells'];
    if (cached !== undefined) return cached;
    const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = vox['getBoundsAndPivot']();
    const out = vox['_isOctreeV2']
        ? octreeVoxelCells(vox['octreeLeafSources'], pivotX, pivotY, pivotZ, vox['getPhysicsGridStep']())
        : chunkVoxelCells(vox, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ);
    vox['_unionVoxelCells'] = out;
    return out;
}

/**
 * Copy the template's geometric identity (bounds, pivot, voxel scale,
 * decoded-file reference) onto `vox` WITHOUT building meshes, chunks or
 * fragments. The result is a "pristine" stand-in: transformable, nameable,
 * able to carry a physics body — while the batch keeps rendering the visuals.
 */
export function adoptPristineTemplate(vox: VoxelObject, template: VoxelObject): void {
    vox['voxelSize'] = template['voxelSize'];
    vox['useAtlas'] = template['useAtlas'];
    vox['_isOctreeV2'] = template['_isOctreeV2'];
    vox['_physicsGridStep'] = template['_physicsGridStep'];
    vox['_vxlV3Data'] = template['_vxlV3Data'];
    vox['bounds'] = template['bounds'] ? { ...template['bounds'] } : null;
    vox['boundsInWorldUnits'] = template['boundsInWorldUnits'];
    if (template['voxelPivot']) vox['voxelPivot'] = { ...template['voxelPivot'] };
    if (template['storedBoundsOffset']) vox['storedBoundsOffset'] = { ...template['storedBoundsOffset'] };
    vox['_loadedFromFile'] = true;
}

/**
 * Pristine static body: ONE union voxels collider from the template's cached
 * cell set.
 * For fragmented templates the collider registers as the pristine union, so
 * the first fragment detach lazy-splits it into per-fragment colliders
 * exactly like a full clone would (splitPristineColliders).
 */
export function initPristineUnionBody(vox: VoxelObject, physicsWorld: PhysicsWorld, template: VoxelObject): void {
    if (vox['rigidBody']) vox.removePhysicsBody();
    vox['physicsWorld'] = physicsWorld;
    vox['colliders'] = [];
    const { pos, quat, scale } = vox['decomposeWorld']();
    const rigidBody = createStaticVoxelBody(vox, physicsWorld, pos, quat);
    vox['rigidBody'] = rigidBody;
    const collisionGroups = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);
    const unionCells = getUnionVoxelCells(template);
    const collider = unionCells
        ? attachUnionVoxelCollider(unionCells, physicsWorld, rigidBody, collisionGroups, scale.x, scale.y, scale.z)
        : null;
    if (collider) {
        vox['colliders'] = [collider];
        if (template['_fragments']) vox['_pristineUnionCollider'] = collider;
    }
    vox.userData.collisionGroup = CollisionGroup.ENVIRONMENT;
    vox.userData.collisionMask = CollisionMask.ENVIRONMENT;
    vox.userData.rigidBody = rigidBody;
}

/**
 * Pristine DYNAMIC body: one cuboid per box of the template's cached union
 * greedy mesh, on a body that starts asleep.
 *
 * This is `VoxelObject.createDynamicPhysicsBody`'s cuboid branch with the boxes
 * sourced from the TEMPLATE instead of from `vox`'s own chunks — a pristine
 * instance carries no chunks or leaves, and must not build any, because staying
 * geometry-free is exactly what keeps it in the render batch. Sharing the
 * template's cache is also strictly cheaper at load: a hundred placed wrecks
 * greedy-mesh once between them instead of once each.
 *
 * The body starts asleep so a level full of knockables pays no settle wave on
 * spawn; the first real contact wakes it and the owner promotes it out of the
 * batch (see PristineDynamic.ts).
 */
export function initPristineDynamicBody(
    vox: VoxelObject, physicsWorld: PhysicsWorld, template: VoxelObject, mass: number,
): void {
    if (vox['rigidBody']) vox.removePhysicsBody();
    vox['_isDynamic'] = true;
    vox['physicsWorld'] = physicsWorld;
    vox['colliders'] = [];
    vox.userData.excludeFromSplatExport = true; // dynamic → excluded from static GS bake

    const { pos, quat, scale } = vox['decomposeWorld']();
    const body = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(pos.x, pos.y, pos.z)
            .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
            .setLinearDamping(0.1)
            .setAngularDamping(0.1),
    );
    vox['rigidBody'] = body;
    // Contact resolution (VoxelObject.fromRigidBody) has to reach the proxy, or
    // game code that hits a pristine prop resolves it to nothing.
    physicsWorld.setUserData(body, { voxelObject: vox });

    // ONE coarse collider while pristine — see attachPristineDynamicColliders.
    attachPristineDynamicColliders(vox, physicsWorld, template, mass, scale, body);
    let bottom = Infinity;
    for (const c of vox['colliders']) {
        const shape = c.shape as { halfExtents?: { y: number } };
        const hy = shape.halfExtents?.y ?? 0;
        bottom = Math.min(bottom, c.translation().y - hy);
    }
    // Colliders are a coarser cover than the source voxels, so density-derived
    // mass drifts heavy — true it up like the non-pristine path does.
    trueUpBodyMass(body, vox['colliders'], mass);
    // Lowest collider point relative to the body origin, for the
    // embedded-in-terrain safety net in syncWithPhysics().
    vox['_colliderBottomOffsetY'] = Number.isFinite(bottom) ? bottom : 0;

    vox.userData.collisionGroup = CollisionGroup.DYNAMIC_PROP;
    vox.userData.collisionMask = CollisionMask.DYNAMIC_PROP;
    vox.userData.rigidBody = body;
    vox.userData.isDynamic = true;
    vox.userData.mass = mass;
    body.sleep();
}

/**
 * Colliders for a pristine (asleep, never touched) dynamic prop: ONE cuboid
 * covering the object's bounds, instead of the ~36 that its greedy mesh needs.
 *
 * A dynamic body cannot use a trimesh in Rapier — no volume for inertia, and
 * trimesh-vs-trimesh does not collide — so an exact voxel prop becomes a
 * cuboid DECOMPOSITION. At 266 placed wrecks that was 9,556 colliders in the
 * broad phase, permanently, for objects that never move.
 *
 * While pristine the coarse box is enough: nothing has touched the prop, so the
 * only thing its collider must do is BE touched. The exact shape is attached on
 * promotion (attachPromotedDynamicColliders), before anything can observe the
 * difference — the first contact wakes the body, and the swap happens in the
 * same step as the promotion it triggers.
 *
 * Bounds come from the template, so the box is the asset's real extent rather
 * than a guess; for a car wreck or a bin the difference from the exact hull is
 * imperceptible, which is exactly the population this path serves.
 */
export function attachPristineDynamicColliders(
    vox: VoxelObject,
    physicsWorld: PhysicsWorld,
    template: VoxelObject,
    mass: number,
    scale: THREE.Vector3,
    body: RAPIER.RigidBody,
): void {
    const boxes = getUnionColliderBoxes(template);
    if (boxes.length === 0) return;

    // Union AABB of the greedy boxes, in the same local frame they use.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
        minX = Math.min(minX, b.cx - b.hx); maxX = Math.max(maxX, b.cx + b.hx);
        minY = Math.min(minY, b.cy - b.hy); maxY = Math.max(maxY, b.cy + b.hy);
        minZ = Math.min(minZ, b.cz - b.hz); maxZ = Math.max(maxZ, b.cz + b.hz);
    }
    const hx = Math.max(1e-3, ((maxX - minX) / 2) * scale.x);
    const hy = Math.max(1e-3, ((maxY - minY) / 2) * scale.y);
    const hz = Math.max(1e-3, ((maxZ - minZ) / 2) * scale.z);
    const cx = ((minX + maxX) / 2) * scale.x;
    const cy = ((minY + maxY) / 2) * scale.y;
    const cz = ((minZ + maxZ) / 2) * scale.z;
    // Density from the BOX volume so the body's mass is right before trueUp.
    const density = mass / Math.max(1e-6, 8 * hx * hy * hz);
    const collisionGroups = makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP);
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(cx, cy, cz)
        .setCollisionGroups(collisionGroups)
        .setFriction(0.5)
        .setRestitution(0.3)
        .setDensity(density);
    vox['colliders'].push(physicsWorld.createCollider(desc, body));
}

/**
 * Replace a promoted prop's coarse collider with the exact cuboid set.
 *
 * Called when the body wakes: from here the prop is being pushed, so its shape
 * has to be right. This is the physics half of the same promote-on-demand
 * bargain the renderer makes — pay for exactness only once something looks.
 */
export function attachPromotedDynamicColliders(
    vox: VoxelObject,
    physicsWorld: PhysicsWorld,
    template: VoxelObject,
    mass: number,
): void {
    const body = vox['rigidBody'];
    if (!body) return;
    const { scale } = vox['decomposeWorld']();
    clearColliders(vox);

    const boxes = getUnionColliderBoxes(template);
    const collisionGroups = makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP);
    let totalVolume = 0;
    for (const b of boxes) totalVolume += 8 * (b.hx * scale.x) * (b.hy * scale.y) * (b.hz * scale.z);
    const density = totalVolume > 0 ? mass / totalVolume : 1.0;
    let bottom = Infinity;
    for (const b of boxes) {
        const hy = b.hy * scale.y;
        const cy = b.cy * scale.y;
        const desc = RAPIER.ColliderDesc.cuboid(b.hx * scale.x, hy, b.hz * scale.z)
            .setTranslation(b.cx * scale.x, cy, b.cz * scale.z)
            .setCollisionGroups(collisionGroups)
            .setFriction(0.5)
            .setRestitution(0.3)
            .setDensity(density);
        vox['colliders'].push(physicsWorld.createCollider(desc, body));
        bottom = Math.min(bottom, cy - hy);
    }
    trueUpBodyMass(body, vox['colliders'], mass);
    vox['_colliderBottomOffsetY'] = Number.isFinite(bottom) ? bottom : 0;
}

/**
 * Cheap blast pretest against the TEMPLATE's fragment AABBs, evaluated in
 * `vox`'s local frame (same math as detachAffectedFragments). True when at
 * least one fragment would be hit — i.e. promotion would do something.
 * Non-fragmented templates always return true (no cheap test exists).
 */
export function templateBlastWouldAffect(
    vox: VoxelObject, template: VoxelObject, worldCenter: THREE.Vector3, radius: number,
): boolean {
    const aabbs = template['_fragmentAabbs'];
    if (!aabbs) return true;
    const { localPoint: localCenter } = vox['toLocalFrame'](worldCenter);
    const radiusSq = radius * radius;
    return aabbs.some(aabb => sphereIntersectsAabb(localCenter, radiusSq, aabb.min, aabb.max));
}

/**
 * Build a promoted instance's live fragment children from the template.
 * Leaf data is REFERENCED (the shared immutable LeafBuffer — per-child
 * decode happens only if/when colliders or edits need object form) and the
 * visual is a rented FragmentInstancePool slot; no geometry is built or
 * cloned. After this, detachAsDynamic / splitPristineColliders / the debris
 * pipeline treat the children exactly like clone-built ones.
 */
export function materializePromotedFragments(
    vox: VoxelObject,
    template: VoxelObject,
    slotFor: (fragIndex: number, matrix: THREE.Matrix4) => FragmentSlot | null,
): void {
    const templateFragments = template['_fragments'];
    const templateAabbs = template['_fragmentAabbs'];
    if (!templateFragments || !templateAabbs || vox['_fragments']) return;
    vox.updateMatrixWorld(true);
    const fragments: VoxelObject[] = [];
    vox['_fragments'] = fragments;
    vox['_fragmentAabbs'] = [...templateAabbs];
    // Base plane captured from the FULL set, before anything can detach.
    vox['_fragmentGroundY'] = groundPlaneY(templateAabbs);
    for (let k = 0; k < templateFragments.length; k++) {
        const templateChild = templateFragments[k]!;
        const child = new VoxelObject({
            voxelSize: template['voxelSize'],
            useAtlas: template['useAtlas'],
            shadows: vox['shadows'],
        });
        child.name = `${vox.name || 'fragment'}#${k}`;
        child['_isOctreeV2'] = true;
        child['_isFragment'] = true;
        // Wire the physics world exactly like createPhysicsBody does for
        // clone-built fragment children — detachAsDynamic refuses to peel a
        // child whose physicsWorld is unset.
        child['physicsWorld'] = vox['physicsWorld'];
        child['_physicsGridStep'] = template['_physicsGridStep'];
        child['bounds'] = template['bounds'] ? { ...template['bounds'] } : null;
        child['boundsInWorldUnits'] = template['boundsInWorldUnits'];
        const templateChildBuffer = templateChild['_leafBuffer'];
        const templateChildLeaves = templateChild['_octreeLeaves'];
        if (templateChildBuffer) child['_leafBuffer'] = templateChildBuffer;
        else if (templateChildLeaves) child['_octreeLeaves'] = [...templateChildLeaves];
        vox.add(child);
        fragments.push(child);
        child['_fragmentSlot'] = slotFor(k, vox.matrixWorld);
    }
}

/**
 * Impulse scale applied to fragments the blast did NOT directly touch when a
 * `'shatter'` object comes apart. They are released rather than blasted, so
 * they drop and tumble outward instead of being flung like the struck face.
 */
const SHATTER_BYSTANDER_IMPULSE = 0.45;

/**
 * Impulse scale for fragments that fall because they lost their support path
 * to the ground rather than because the blast reached them — they should
 * crumble in place, not fly.
 */
const COLLAPSE_IMPULSE = 0.15;

/**
 * Peel fragment `index` off the container: detach it as a dynamic body, drop
 * it (and its AABB) from the container's parallel arrays and collect the
 * debris entry. Callers must walk indices in DESCENDING order so the splices
 * can't disturb the indices still to come.
 */
export function detachFragmentAt(
    fragments: VoxelObject[],
    aabbs: FragmentAabb[],
    index: number,
    worldCenter: THREE.Vector3,
    impulseStrength: number,
    impulseUp: number,
    debris: VoxelObjectDebris[],
): void {
    const result = fragments[index]!.detachAsDynamic(worldCenter, impulseStrength, impulseUp);
    fragments.splice(index, 1);
    aabbs.splice(index, 1);
    if (result) debris.push(result);
}

/**
 * `'shatter'` destruction: release EVERY remaining fragment as a rigid body.
 * Fragments the blast actually intersects get the full impulse; the rest are
 * let go gently (see SHATTER_BYSTANDER_IMPULSE) so a struck cactus bursts at
 * the impact point and crumbles everywhere else — instead of leaving its top
 * half hovering where the bottom used to be.
 *
 * Callers must have already established that the blast touches something.
 */
export function shatterAllFragments(
    vox: VoxelObject,
    worldCenter: THREE.Vector3,
    localCenter: THREE.Vector3,
    radiusSq: number,
    impulseStrength: number,
    impulseUp: number,
): VoxelObjectDebris[] {
    const fragments = vox['_fragments'];
    const aabbs = vox['_fragmentAabbs'];
    if (!fragments || !aabbs) return [];
    const debris: VoxelObjectDebris[] = [];
    // Reverse so splicing detached children can't disturb the loop index.
    for (let i = fragments.length - 1; i >= 0; i--) {
        const aabb = aabbs[i]!;
        const struck = sphereIntersectsAabb(localCenter, radiusSq, aabb.min, aabb.max);
        const falloff = struck ? 1 : SHATTER_BYSTANDER_IMPULSE;
        detachFragmentAt(fragments, aabbs, i, worldCenter, impulseStrength * falloff, impulseUp * falloff, debris);
    }
    finalizeIfSpent(vox);
    return debris;
}

/**
 * Last fragment gone: the container is spent. Mark destroyed (so
 * isDestroyed() finally reports the truth for fragmented assets), drop the
 * now-colliderless body and stop blocking NPC paths.
 */
function finalizeIfSpent(vox: VoxelObject): void {
    if ((vox['_fragments']?.length ?? 0) > 0 || vox.isDestroyed()) return;
    vox['_isDestroyed'] = true;
    vox.removePhysicsBody();
    vox.setNavmeshObstacleEnabled(false);
}

/**
 * Post-blast tail of detachAffectedFragments: fragment-level structural
 * collapse (whatever the blast left face-disconnected from the ground layer
 * falls too — a cactus arm after the trunk is smashed), then container
 * finalisation once the last fragment is gone. The leaf-level collapse
 * callback never runs on the fragmented path — the container has no leaves
 * of its own — so this is where support is enforced.
 */
export function collapseUnsupportedAndFinalize(
    vox: VoxelObject,
    worldCenter: THREE.Vector3,
    impulseStrength: number,
    debris: VoxelObjectDebris[],
): void {
    const fragments = vox['_fragments'];
    const aabbs = vox['_fragmentAabbs'];
    if (!fragments || !aabbs) return;
    if (debris.length > 0 && fragments.length > 0) {
        const unsupported = findUnsupportedFragments(aabbs, vox['_fragmentGroundY']);
        // Descending so each splice leaves the lower indices intact. Gentle
        // impulse: collapse pieces crumble rather than fly.
        for (let j = unsupported.length - 1; j >= 0; j--) {
            detachFragmentAt(fragments, aabbs, unsupported[j]!, worldCenter, impulseStrength * COLLAPSE_IMPULSE, 0, debris);
        }
    }
    finalizeIfSpent(vox);
}
