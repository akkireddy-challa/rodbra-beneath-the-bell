/**
 * Physics builders for GLB-native environment instances (loadGlbObjects):
 * static per-mesh box colliders, dynamic: true compound-cuboid bodies
 * (mirroring VoxelObject.createDynamicPhysicsBody), and precise-collision
 * trimeshes from generated collider GLBs (asset.colliderUrl — the splat
 * colliderUrl pattern). Split out of EnvironmentObjectSystem.ts to respect
 * the max-lines limit.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import type { Asset } from 'types/game.js';
import type { PhysicsBox } from 'engine/VoxelOctreeRenderer.js';
import type { PlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

/**
 * Structural slice of GameEngine needed to register dynamic GLB bodies with
 * the DynamicObjectManager (matches VoxelObject.createDynamicPhysicsBody's
 * engine parameter) AND to mirror VoxelObject.syncWithPhysics's per-frame
 * chunk-registration refresh (updatePosition) and floor rescue
 * (getVoxelFloorY) — see VoxelObject.ts's `_engineRef` type for the source of
 * truth this mirrors.
 */
export interface GlbDynamicEngineRef {
    getDynamicObjectManager?: () => {
        register(obj: ChunkManagedObject, type: string, radius?: number): void;
        unregister?(obj: ChunkManagedObject): void;
        updatePosition(obj: ChunkManagedObject): void;
        getVoxelFloorY(x: number, feetY: number, z: number): number | null;
    };
}

/** World-space box approximating one mesh of a GLB hierarchy. */
interface MeshBox {
    /** Half-extents with the mesh's world scale already applied. */
    half: THREE.Vector3;
    center: THREE.Vector3;
    quat: THREE.Quaternion;
}

/**
 * One world-space box per renderable mesh in the hierarchy, sized from the
 * mesh's own bounding box and its world transform (which includes the parent
 * group's scaling + centering). Truly degenerate meshes (zero-area geometry)
 * are skipped; flat meshes (planes) get their thin axis clamped to a minimum
 * thickness. Shared by the static and dynamic body builders so both see the
 * exact same boxes.
 */
function collectMeshBoxes(object: THREE.Group): MeshBox[] {
    const boxes: MeshBox[] = [];
    object.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh) || !child.geometry) return;

        child.geometry.computeBoundingBox();
        const meshBbox = child.geometry.boundingBox;
        if (!meshBbox) return;
        const meshSize = meshBbox.getSize(new THREE.Vector3());
        if (meshSize.x < 0.001 && meshSize.y < 0.001 && meshSize.z < 0.001) return;

        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        child.matrixWorld.decompose(new THREE.Vector3(), worldQuat, worldScale);

        boxes.push({
            half: new THREE.Vector3(
                Math.max(meshSize.x * worldScale.x, 0.02) / 2,
                Math.max(meshSize.y * worldScale.y, 0.02) / 2,
                Math.max(meshSize.z * worldScale.z, 0.02) / 2,
            ),
            center: meshBbox.getCenter(new THREE.Vector3()).applyMatrix4(child.matrixWorld),
            quat: worldQuat,
        });
    });
    return boxes;
}

/**
 * Static collision for a GLB instance: one FIXED body + box collider per mesh
 * in the hierarchy, sized from the mesh's world-space bounding box. Also the
 * fallback when a trimesh collider fails to load/build.
 */
export function createGlbBoxColliders(physicsWorld: PhysicsWorld, worldBodies: unknown[], object: THREE.Group): void {
    const RAPIER = getRapier();
    const collisionGroups = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ALL);

    for (const box of collectMeshBoxes(object)) {
        const bodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(box.center.x, box.center.y, box.center.z)
            .setRotation({ x: box.quat.x, y: box.quat.y, z: box.quat.z, w: box.quat.w });
        const body = physicsWorld.createRigidBody(bodyDesc);

        const colliderDesc = RAPIER.ColliderDesc.cuboid(box.half.x, box.half.y, box.half.z)
            .setFriction(0.7)
            .setRestitution(0.1)
            .setCollisionGroups(collisionGroups);
        physicsWorld.createCollider(colliderDesc, body);
        worldBodies.push(body);
    }
}

/**
 * World-space axis-aligned boxes around each mesh of a placed GLB (an oriented mesh box
 * becomes the AABB of its eight corners) — the `PhysicsBox` shape the 2D-physics lane
 * slices into plane cuboids. Pure over the object's current world matrices.
 */
export function glbWorldPhysicsBoxes(object: THREE.Group): PhysicsBox[] {
    const out: PhysicsBox[] = [];
    const corner = new THREE.Vector3();
    for (const box of collectMeshBoxes(object)) {
        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            corner.set(sx * box.half.x, sy * box.half.y, sz * box.half.z).applyQuaternion(box.quat).add(box.center);
            min.min(corner);
            max.max(corner);
        }
        out.push({
            cx: (min.x + max.x) / 2, cy: (min.y + max.y) / 2, cz: (min.z + max.z) / 2,
            hx: (max.x - min.x) / 2, hy: (max.y - min.y) / 2, hz: (max.z - min.z) / 2,
        });
    }
    return out;
}

/**
 * Static colliders for a placed GLB on the 2D-physics lane: its mesh boxes, sliced to the
 * gameplay plane like a voxel object's (`PlaneLockedPhysics.createEnvironmentBody`), so a
 * side-on level's mesh platforms and walls are solid.
 */
export function createGlbPlaneLockedColliders(physicsWorld: PlaneLockedPhysics, worldBodies: unknown[], object: THREE.Group): void {
    const boxes = glbWorldPhysicsBoxes(object);
    if (boxes.length === 0) return;
    const built = physicsWorld.createEnvironmentBody({
        boxes,
        transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        kind: 'fixed',
        collisionGroups: makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ALL),
        friction: 0.7,
        restitution: 0.1,
    });
    worldBodies.push(built.body);
}

/**
 * dynamic: true parity for GLB instances — ONE dynamic body at the instance
 * transform carrying the same per-mesh boxes as compound cuboids (body-local),
 * mirroring VoxelObject.createDynamicPhysicsBody (mass 10 applied as
 * per-collider density = mass / total box volume, damping 0.1/0.1). Dynamic
 * instances always use boxes (trimesh is static-only).
 *
 * Registers the body with the engine's DynamicObjectManager (chunk-based
 * hibernation + gravity hold until terrain colliders are ready) through a
 * thin ChunkManagedObject adapter whose members mirror VoxelObject's
 * dynamic-path implementations. Returns the visual-sync adapter the caller
 * must hand to its trackDynamicObject registry — its `dispose()` is the ONLY
 * handle on the body and the chunk registration, so a caller that drops the
 * adapter without disposing it leaks both (a level switch used to).
 */
export function createDynamicGlbBody(
    physicsWorld: PhysicsWorld,
    object: THREE.Group,
    engine: GlbDynamicEngineRef | null,
): { syncWithPhysics(): void; dispose(): void } {
    const RAPIER = getRapier();
    // Dynamic props carry DYNAMIC_PROP/DYNAMIC_PROP — exact parity with
    // VoxelObject.createDynamicPhysicsBody and the documented prop contract in
    // CollisionLayers.ts. ENVIRONMENT membership would be wrong for a dynamic
    // body: it pairs the body with the kinematic player in the solver
    // (infinite-mass shoves launch the prop) instead of routing interaction
    // through the KCC's capped-push loop (WalkingAndJumpingMovement.ts).
    const collisionGroups = makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP);
    const mass = 10;

    const bodyQuat = new THREE.Quaternion().setFromEuler(object.rotation);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(object.position.x, object.position.y, object.position.z)
        .setRotation({ x: bodyQuat.x, y: bodyQuat.y, z: bodyQuat.z, w: bodyQuat.w })
        .setLinearDamping(0.1)
        .setAngularDamping(0.1);
    const body = physicsWorld.createRigidBody(bodyDesc);

    // The same per-mesh boxes the fixed-box path builds (half-extents already
    // carry world scale), re-expressed in the BODY frame — translation+rotation
    // only. Mapped up front so the total volume is known before the
    // per-collider densities are set.
    const invBodyQuat = bodyQuat.clone().invert();
    const cuboids = collectMeshBoxes(object).map(box => ({
        half: box.half,
        pos: box.center.clone().sub(object.position).applyQuaternion(invBodyQuat),
        quat: invBodyQuat.clone().multiply(box.quat),
    }));
    const totalVolume = cuboids.reduce((sum, c) => sum + 8 * c.half.x * c.half.y * c.half.z, 0);

    // Mass exactly as VoxelObject.createDynamicPhysicsBody applies it:
    // per-collider density = mass / total collider volume, so the compound
    // body totals ~10 regardless of how many boxes it carries.
    const density = totalVolume > 0 ? mass / totalVolume : 1.0;
    // Lowest collider point relative to the body origin (mirrors
    // VoxelObject._colliderBottomOffsetY) — used by the same
    // embedded-in-terrain safety net below.
    let colliderBottomOffsetY = Infinity;
    for (const cuboid of cuboids) {
        const colliderDesc = RAPIER.ColliderDesc.cuboid(cuboid.half.x, cuboid.half.y, cuboid.half.z)
            .setTranslation(cuboid.pos.x, cuboid.pos.y, cuboid.pos.z)
            .setRotation({ x: cuboid.quat.x, y: cuboid.quat.y, z: cuboid.quat.z, w: cuboid.quat.w })
            .setFriction(0.7)
            .setRestitution(0.1)
            .setCollisionGroups(collisionGroups)
            .setDensity(density);
        physicsWorld.createCollider(colliderDesc, body);
        colliderBottomOffsetY = Math.min(colliderBottomOffsetY, cuboid.pos.y - cuboid.half.y);
    }
    if (!Number.isFinite(colliderBottomOffsetY)) colliderBottomOffsetY = 0;

    // Chunk-based hibernation through an honest ChunkManagedObject adapter.
    // Built BEFORE registration (not inline in the register() call) so the
    // exact same object identity is available to syncWithPhysics's
    // updatePosition() call below — DynamicObjectManager keys its internal
    // tracking map by adapter identity, so a re-created object there would
    // silently no-op every re-registration.
    let hibernating = false;
    const chunkManagedAdapter: ChunkManagedObject = {
        getPosition: () => object.position,
        // Dynamic props are put to SLEEP, never setEnabled(false): a
        // disabled body is a ghost whose space can be occupied, and
        // re-enabling it inside an overlap ejects it violently (mirrors
        // VoxelObject.hibernate).
        hibernate: (): void => {
            if (hibernating) return;
            hibernating = true;
            if (body.isValid()) body.sleep();
        },
        wake: (): void => {
            if (!hibernating) return;
            hibernating = false;
            if (body.isValid()) body.setGravityScale(1.0, true);
        },
        isHibernating: () => hibernating,
        // Veto hibernation while awake and moving (mirrors
        // VoxelObject.canHibernate).
        canHibernate: (): boolean => {
            if (!body.isValid() || body.isSleeping()) return true;
            const lv = body.linvel();
            return (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z) < 0.01;
        },
        holdPhysicsUntilReady: (): void => {
            if (body.isValid()) {
                body.setGravityScale(0, true);
                body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            }
        },
        releasePhysics: (): void => {
            if (body.isValid()) body.setGravityScale(1.0, true);
        },
    };
    const dynamicObjMgr = engine?.getDynamicObjectManager?.();
    if (dynamicObjMgr) {
        dynamicObjMgr.register(chunkManagedAdapter, 'dynamic_prop', 1.0);
    }

    // Last position the adapter was chunk-registered at (mirrors
    // VoxelObject._lastChunkRegPos), seeded at creation exactly like
    // VoxelObject's constructor does right after register().
    const lastChunkRegPos = object.position.clone();

    // Visual sync adapter — same registry the VXL dynamic clones use.
    return {
        syncWithPhysics: () => {
            const t = body.translation();

            // Safety net: if the body has sunk into solid voxel terrain —
            // typically because it moved across a chunk whose physics
            // colliders are currently disabled and fell through the surface —
            // lift it back so the solver never sees a deep penetration (which
            // would eject the light body at extreme speed). Mirrors
            // VoxelObject.syncWithPhysics exactly, including skipping sleeping
            // bodies (they cannot be falling, and waking them here would
            // itself destabilise resting props).
            if (!body.isSleeping()) {
                const feetY = t.y + colliderBottomOffsetY;
                const floorY = dynamicObjMgr?.getVoxelFloorY(t.x, feetY, t.z) ?? null;
                if (floorY !== null) {
                    const newY = t.y + (floorY - feetY);
                    body.setTranslation({ x: t.x, y: newY, z: t.z }, true);
                    const lv = body.linvel();
                    body.setLinvel({ x: lv.x, y: 0, z: lv.z }, true);
                    t.y = newY;
                }
            }

            const r = body.rotation();
            object.position.set(t.x, t.y, t.z);
            object.quaternion.set(r.x, r.y, r.z, r.w);

            // Keep the chunk registration in sync with the physics position.
            // Hibernation visibility is driven by the chunks the object is
            // REGISTERED in, not where it currently is — without this, a prop
            // that drifts out of its home chunk gets hidden whenever that
            // home chunk leaves the view. Throttled to meaningful movement
            // (>0.5m) so resting props pay nothing — mirrors
            // VoxelObject.syncWithPhysics's dx*dx + dz*dz > 0.25 check.
            const dx = t.x - lastChunkRegPos.x;
            const dz = t.z - lastChunkRegPos.z;
            if (dx * dx + dz * dz > 0.25 && dynamicObjMgr) {
                dynamicObjMgr.updatePosition(chunkManagedAdapter);
                lastChunkRegPos.set(t.x, lastChunkRegPos.y, t.z);
            }
        },
        dispose: () => {
            dynamicObjMgr?.unregister?.(chunkManagedAdapter);
            physicsWorld.removeRigidBody(body);
        },
    };
}

/**
 * Per-asset collider-GLB soup cache for `createGlbTrimeshCollider`: each
 * collider GLB is fetched and flattened ONCE per URL (all instances share the
 * result) in the asset's NATIVE units; every instance then scales the shared
 * verts by its own transform before building its Rapier trimesh.
 */
const glbColliderSoupCache = new Map<string, Promise<{ verts: Float32Array; indices: Uint32Array }>>();

function loadGlbColliderSoup(url: string): Promise<{ verts: Float32Array; indices: Uint32Array }> {
    let soup = glbColliderSoupCache.get(url);
    if (!soup) {
        soup = fetchGlbColliderSoup(url);
        glbColliderSoupCache.set(url, soup);
        // A rejected promise must not stay cached — it would permanently pin
        // this colliderUrl to the box fallback until a full page reload. This
        // is a separate handler (not chained onto the returned promise) so
        // every caller still observes and handles the original rejection
        // exactly as before; it only clears the cache entry for the NEXT
        // attempt to refetch.
        soup.catch(() => { glbColliderSoupCache.delete(url); });
    }
    return soup;
}

/**
 * Fetch a collider GLB and merge every mesh into one flat vertex/index soup,
 * with the GLB's internal node transforms applied (native units — mirrors the
 * splat collider load in GaussianSplatRenderer.createGlbPhysics).
 */
async function fetchGlbColliderSoup(url: string): Promise<{ verts: Float32Array; indices: Uint32Array }> {
    const gltf = await createGltfLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const soup = collectGlbTriangleSoup(gltf.scene);
    if (soup.indices.length < 3) {
        throw new Error('Collider GLB contains no triangles');
    }
    return soup;
}

/**
 * Merge every mesh under `root` into one flat world-space vertex/index soup
 * (`root.updateMatrixWorld(true)` must have run). `include` filters meshes —
 * a mesh level uses it to skip `nocollide*` decoration. Shared by the
 * collider-GLB fetch above and by MeshLevel's trimesh-from-GLB fallback.
 */
export function collectGlbTriangleSoup(
    root: THREE.Object3D,
    include: (mesh: THREE.Mesh) => boolean = () => true,
): { verts: Float32Array; indices: Uint32Array } {
    const vertices: number[] = [];
    const indices: number[] = [];
    let vertexOffset = 0;
    const v = new THREE.Vector3();
    root.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (!child.geometry) return;
        if (!include(child)) return;
        const position = child.geometry.getAttribute('position');
        if (!position) return;
        const index = child.geometry.getIndex();

        const vertexStart = vertexOffset;
        for (let i = 0; i < position.count; i++) {
            v.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
            vertices.push(v.x, v.y, v.z);
            vertexOffset++;
        }
        if (index) {
            for (let i = 0; i < index.count; i++) {
                indices.push(index.getX(i) + vertexStart);
            }
        } else {
            for (let i = 0; i < position.count; i++) {
                indices.push(vertexStart + i);
            }
        }
    });
    return { verts: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/**
 * Precise collision for a static GLB instance: a FIXED body at the instance
 * transform carrying a Rapier trimesh built from the asset's generated
 * collider GLB (`asset.colliderUrl`). The collider GLB is in the asset's
 * NATIVE units and frame, so the shared soup is mapped by the exact transform
 * chain the rendered model gets (recenter to the center-X/Z bottom-Y pivot,
 * then the per-instance scale) — position/rotation live on the body itself.
 * On ANY load/build failure this falls back to the box path for the instance
 * so the object is never left collider-less.
 */
export async function createGlbTrimeshCollider(
    physicsWorld: PhysicsWorld,
    worldBodies: unknown[],
    object: THREE.Group,
    asset: Asset,
    recenterOffset: THREE.Vector3,
    /** The GLB's full visual scale — the object's own scale times the asset's fit-to-height scale. */
    visualScale: THREE.Vector3 = object.scale,
): Promise<void> {
    try {
        const colliderUrl = asset.colliderUrl;
        if (!colliderUrl) throw new Error('Missing colliderUrl');
        const soup = await loadGlbColliderSoup(colliderUrl);

        const vertMatrix = new THREE.Matrix4()
            .makeScale(visualScale.x, visualScale.y, visualScale.z)
            .multiply(new THREE.Matrix4().makeTranslation(recenterOffset.x, recenterOffset.y, recenterOffset.z));
        const scaledVerts = new Float32Array(soup.verts.length);
        const v = new THREE.Vector3();
        for (let i = 0; i < soup.verts.length; i += 3) {
            v.set(soup.verts[i]!, soup.verts[i + 1]!, soup.verts[i + 2]!).applyMatrix4(vertMatrix);
            scaledVerts[i] = v.x;
            scaledVerts[i + 1] = v.y;
            scaledVerts[i + 2] = v.z;
        }

        const RAPIER = getRapier();
        // FIX_INTERNAL_EDGES (144) fixes zero/bad normals at triangle edges
        const colliderDesc = RAPIER.ColliderDesc.trimesh(scaledVerts, soup.indices, 144);
        if (!colliderDesc) throw new Error('Failed to create trimesh collider');
        colliderDesc.setFriction(0.7)
            .setRestitution(0.1)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ALL));

        const bodyQuat = new THREE.Quaternion().setFromEuler(object.rotation);
        const bodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(object.position.x, object.position.y, object.position.z)
            .setRotation({ x: bodyQuat.x, y: bodyQuat.y, z: bodyQuat.z, w: bodyQuat.w });
        const body = physicsWorld.createRigidBody(bodyDesc);
        physicsWorld.createCollider(colliderDesc, body);
        worldBodies.push(body);
    } catch (error) {
        console.warn(`Trimesh collider failed for "${asset.name}", falling back to box colliders:`, error);
        createGlbBoxColliders(physicsWorld, worldBodies, object);
    }
}
