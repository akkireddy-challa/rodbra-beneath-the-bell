/**
 * MeshLevel — an authored GLB (Blender, or any DCC tool) as the whole world.
 *
 * The level is one GLB registered as an asset (`bitmagic assets add x.glb --keep-glb`)
 * plus a `bitmagic-mesh-level` JSON (MeshLevelSchema.ts) describing colliders,
 * volumes, landmarks and lights. `load()` puts the art in the world group, builds
 * static Rapier bodies from the JSON, registers the level as the main terrain so
 * shadows, world-size clamping and gridless NPC spawning see its extent, and
 * applies an interior lighting preset. Pair it with `terrain.shape: 'none'` in
 * world.json, or the voxel ground plane is built underneath the level as well.
 *
 * Everything that can go wrong goes wrong loudly: a missing asset id lists the
 * candidates, a schema violation names its JSON path, an unknown landmark lists
 * the known ones. Nothing here returns a silent null for a typo.
 *
 * Usage and the JSON contract: agent-docs/mesh-level.md and samples/mesh-level-setup.ts.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import type { EngineLike, GameData } from 'types/game.js';
import { getAssetUrlById, resolveAssetUrl } from 'types/game.js';
import { PhysicsBodyFactory } from 'engine/physics/PhysicsBodyFactory.js';
import type { BakedTerrainProvider, TerrainBounds } from 'engine/DynamicObjectManager.js';
import { syncGroundWorldSizeToBakedLevel } from 'engine/syncGroundWorldSizeToBakedLevel.js';
import { createPhysicsSpawnFinder } from 'engine/bakedSpawnResolver.js';
import { collectGlbTriangleSoup } from 'engine/EnvGlbPhysics.js';
import { buildColliderFromTriangles, DEFAULT_GLB_COLLIDER_OPTIONS, type BuildGlbColliderOptions } from 'engine/GlbColliderBuilder.js';
import {
    parseMeshLevel,
    type MeshLevelCollider,
    type MeshLevelCollisionGroup,
    type MeshLevelData,
    type MeshLevelHeightfieldCollider,
    type MeshLevelLandmark,
    type MeshLevelVolume,
} from 'engine/meshlevel/MeshLevelSchema.js';
import { colliderBounds, orientedBoxContains, planCollider, sampleHeightfield, soupToRasterTriangles, symmetricExtent, unionBounds } from 'engine/meshlevel/MeshLevelColliders.js';
import { VoxelNavMesh, getGlobalNavMesh, setGlobalNavMesh, NPC_NAV_CELL_M, NPC_NAV_STEP_M } from 'engine/VoxelNavMesh.js';
import { buildTrackCenterline, type CenterlinePoint, type NamedTrimeshLevel, type TrackCenterlineOptions } from 'engine/TrackCenterline.js';
import {
    applyMeshLevelLighting,
    disposeMeshLevelLighting,
    refreshCachedShadows,
    DEFAULT_MESH_LEVEL_LIGHTING,
    type AppliedMeshLevelLighting,
    type MeshLevelLightingOptions,
    type MeshLevelShadowMode,
} from 'engine/meshlevel/MeshLevelLighting.js';

export type { MeshLevelLandmark, MeshLevelVolume } from 'engine/meshlevel/MeshLevelSchema.js';

/** Where the level's two halves come from. */
export interface MeshLevelSource {
    /** The GLB: an `assets[]` id (recommended — the CDN URL survives publish) or a literal URL. */
    glb: { assetId: string } | { url: string };
    /**
     * The mesh-level JSON: parsed data (a static import, inlined by the bundler —
     * recommended), a `.json` asset id, or `'trimesh-from-glb'` to derive one
     * trimesh collider per top-level GLB node (no landmarks, volumes or lights).
     */
    level: { data: unknown } | { assetId: string } | 'trimesh-from-glb';
}

export interface MeshLevelOptions {
    /** Group for colliders whose record does not say — see `collisionLayersFor`. */
    collisionGroup: MeshLevelCollisionGroup;
    friction: number;
    lighting: MeshLevelLightingOptions;
    shadows: MeshLevelShadowMode;
    /** Apply the material-name conventions (`glass*` transparent, `emissive*` glowing) to the loaded scene. */
    materialConventions: boolean;
    /** Register as the main terrain: shadow fit, world-size sync and the gridless spawn finder. */
    registerAsTerrain: boolean;
    /** Budget for the trimesh-from-GLB fallback. */
    trimeshFallback: BuildGlbColliderOptions;
}

export const DEFAULT_MESH_LEVEL_OPTIONS: MeshLevelOptions = {
    collisionGroup: 'terrain',
    friction: 0.8,
    lighting: DEFAULT_MESH_LEVEL_LIGHTING,
    shadows: 'cached',
    materialConventions: true,
    registerAsTerrain: true,
    trimeshFallback: DEFAULT_GLB_COLLIDER_OPTIONS,
};

export interface MeshLevelLoadResult {
    colliderCount: number;
    lightCount: number;
    bounds: TerrainBounds;
    warnings: string[];
}

/** One static body the level owns. */
export interface MeshLevelBody {
    name: string;
    group: MeshLevelCollisionGroup;
    rigidBody: ReturnType<typeof PhysicsBodyFactory.createStaticBody>['rigidBody'];
    collider: ReturnType<typeof PhysicsBodyFactory.createStaticBody>['collider'];
}

export class MeshLevelError extends Error {
    constructor(message: string) {
        super(`[MeshLevel] ${message}`);
        this.name = 'MeshLevelError';
    }
}

/** Material-name prefix that makes a GLB material render as thin glass. */
export const GLASS_MATERIAL_PREFIX = 'glass';
/** Material-name prefix that guarantees a GLB material glows. */
export const EMISSIVE_MATERIAL_PREFIX = 'emissive';
/** Mesh-name prefix excluded from the trimesh-from-GLB fallback. */
export const NOCOLLIDE_MESH_PREFIX = 'nocollide';
const GLASS_OPACITY = 0.1;

const GLB_ASSET_TYPES = new Set(['glb', 'gltf', 'polygon-mesh']);

export class MeshLevel implements BakedTerrainProvider {
    private root: THREE.Group | null = null;
    private data: MeshLevelData | null = null;
    private readonly bodies: MeshLevelBody[] = [];
    private bounds: TerrainBounds | null = null;
    private lighting: AppliedMeshLevelLighting | null = null;
    private previousSpawnFinder: EngineLike['findValidVoxelSpawnPosition'] = undefined;
    private registered = false;
    private loaded = false;
    /** The NPC navmesh this level built from its heightfield ground (null: none, or one was already installed). */
    private npcNavMesh: VoxelNavMesh | null = null;

    constructor(
        private readonly engine: EngineLike,
        private readonly source: MeshLevelSource,
        private readonly options: MeshLevelOptions,
    ) {}

    async load(): Promise<MeshLevelLoadResult> {
        if (this.loaded) throw new MeshLevelError('load() was already called on this level — construct a new MeshLevel to load again');
        this.loaded = true;
        const physicsWorld = this.engine.physicsWorld;
        if (!physicsWorld) throw new MeshLevelError('engine.physicsWorld is not ready — load the level after the engine has initialised physics');
        const warnings: string[] = [];

        // 1. Art.
        const glbUrl = this.resolveGlbUrl(warnings);
        const gltf = await createGltfLoader().loadAsync(glbUrl);
        const root = gltf.scene;
        root.name = 'MeshLevel';
        root.updateMatrixWorld(true);
        if (this.options.materialConventions) applyMaterialConventions(root);
        if (this.engine.addToWorld) this.engine.addToWorld(root);
        else this.engine.getWorldGroup().add(root);
        this.root = root;

        // 2. Data.
        const data = await this.resolveLevelData(root, warnings);
        this.data = data;

        // 3. Physics.
        for (const record of data.colliders) {
            const plan = planCollider(record, this.options.collisionGroup);
            const body = PhysicsBodyFactory.createStaticBody(
                physicsWorld,
                plan.position,
                { shape: plan.shape, friction: this.options.friction, collisionGroup: plan.collisionGroup, collisionMask: plan.collisionMask },
                plan.quaternion,
            );
            this.bodies.push({ name: plan.name, group: plan.group, rigidBody: body.rigidBody, collider: body.collider });
        }
        // One step so the colliders answer raycasts before anything spawns.
        physicsWorld.step(1 / 60);

        // 4. Extent: the art's AABB united with the colliders'.
        const artBox = new THREE.Box3().setFromObject(root);
        const artBounds: TerrainBounds | null = artBox.isEmpty() ? null : {
            minX: artBox.min.x, minY: artBox.min.y, minZ: artBox.min.z,
            maxX: artBox.max.x, maxY: artBox.max.y, maxZ: artBox.max.z,
        };
        const bounds = unionBounds(artBounds, colliderBounds(data.colliders));
        if (!bounds) throw new MeshLevelError(`"${glbUrl}" holds no geometry and the level JSON holds no colliders — nothing to stand on`);
        this.bounds = bounds;

        // 5. Terrain registration: shadows fit the level, spawn clamping covers it, gridless spawns resolve on it.
        if (this.options.registerAsTerrain) {
            this.engine.getDynamicObjectManager?.().setBakedTerrain(this);
            syncGroundWorldSizeToBakedLevel(this.engine, symmetricExtent(bounds));
            this.previousSpawnFinder = this.engine.findValidVoxelSpawnPosition;
            this.engine.findValidVoxelSpawnPosition = createPhysicsSpawnFinder(this.engine, bounds, { requireHeadroom: true });
            this.registered = true;
        }

        // 6. NPC navigation over the level's heightfield ground, if it has one.
        this.buildNpcNavMesh(data);

        // 7. Lighting.
        this.lighting = applyMeshLevelLighting(this.engine, data.lights, this.options.lighting, this.options.shadows);
        refreshCachedShadows(this.lighting);

        const shapes = { box: 0, convexHull: 0, trimesh: 0, heightfield: 0 };
        for (const c of data.colliders) shapes[c.shape]++;
        console.log(
            `[MeshLevel] loaded "${glbUrl}" — ${data.colliders.length} colliders (${shapes.box} box, ${shapes.convexHull} hull, ${shapes.trimesh} trimesh, ${shapes.heightfield} heightfield), ` +
            `${data.lights.length} lights, ${data.landmarks.length} landmarks, ${data.volumes.length} volumes, ` +
            `bounds x ${bounds.minX.toFixed(1)}..${bounds.maxX.toFixed(1)} y ${bounds.minY.toFixed(1)}..${bounds.maxY.toFixed(1)} z ${bounds.minZ.toFixed(1)}..${bounds.maxZ.toFixed(1)}`,
        );
        for (const w of warnings) console.warn(`[MeshLevel] ${w}`);
        return { colliderCount: data.colliders.length, lightCount: data.lights.length, bounds, warnings };
    }

    /**
     * Give NPCs a navmesh over the level's heightfield colliders (a forged landscape's ground):
     * a sampler over the same grid Rapier collides with, built once at load, no raycasts.
     * Water below `waterLevelY` is not walkable. Environment objects block cells through the
     * obstacle providers they register. A level without a heightfield (a hand-built room) gets
     * none — the same as before — and a navmesh already installed for this world wins.
     */
    private buildNpcNavMesh(data: MeshLevelData): void {
        const grounds = data.colliders.filter((c): c is MeshLevelHeightfieldCollider => c.shape === 'heightfield');
        if (grounds.length === 0 || getGlobalNavMesh()?.isReady()) return;
        const t0 = performance.now();
        const waterY = this.gameData()?.worldProfileData?.waterLevelY;
        const sampler = (x: number, z: number): number | null => {
            let best: number | null = null;
            for (const g of grounds) {
                const h = sampleHeightfield(g, x, z);
                if (h !== null && (best === null || h > best)) best = h;
            }
            if (best !== null && typeof waterY === 'number' && best < waterY) return null;
            return best;
        };
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const g of grounds) {
            minX = Math.min(minX, g.minX); maxX = Math.max(maxX, g.minX + g.nx * g.cellSize);
            minZ = Math.min(minZ, g.minZ); maxZ = Math.max(maxZ, g.minZ + g.nz * g.cellSize);
        }
        const nav = new VoxelNavMesh();
        nav.buildFromHeightSampler(sampler, minX, maxX, minZ, maxZ, NPC_NAV_STEP_M, { cellSize: NPC_NAV_CELL_M });
        setGlobalNavMesh(nav);
        this.npcNavMesh = nav;
        console.log(`[MeshLevel] NPC navmesh built from the heightfield in ${(performance.now() - t0).toFixed(0)} ms`);
    }

    dispose(): void {
        if (this.npcNavMesh) {
            if (getGlobalNavMesh() === this.npcNavMesh) setGlobalNavMesh(null);
            this.npcNavMesh.dispose();
            this.npcNavMesh = null;
        }
        const physicsWorld = this.engine.physicsWorld;
        if (physicsWorld) for (const body of this.bodies) physicsWorld.removeRigidBody(body.rigidBody);
        this.bodies.length = 0;
        if (this.lighting) {
            disposeMeshLevelLighting(this.engine, this.lighting);
            this.lighting = null;
        }
        if (this.registered) {
            this.engine.getDynamicObjectManager?.().setBakedTerrain(null);
            this.engine.findValidVoxelSpawnPosition = this.previousSpawnFinder;
            this.registered = false;
        }
        if (this.root) {
            this.root.removeFromParent();
            this.root.traverse((o) => {
                if (!(o instanceof THREE.Mesh)) return;
                o.geometry.dispose();
                for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
            });
            this.root = null;
        }
    }

    // ---- queries ----------------------------------------------------------

    /** Names of the level's trimesh colliders — the surfaces `getTrimesh` / `getTrackCenterline` answer for. */
    getTrimeshNames(): string[] {
        return (this.data?.colliders ?? []).filter((c) => c.shape === 'trimesh').map((c) => c.name);
    }

    /** The named trimesh collider's geometry in world coordinates, or null when there is none by that name. */
    getTrimesh(name: string): { vertices: Float32Array; indices: Uint32Array } | null {
        const found = this.data?.colliders.find((c) => c.name === name && c.shape === 'trimesh');
        if (!found || found.shape !== 'trimesh') return null;
        return { vertices: new Float32Array(found.vertices), indices: new Uint32Array(found.indices) };
    }

    /**
     * Road-centred closed waypoint loop over the named trimesh (a forged race track or ski
     * run), the mesh-level counterpart of `VxlSceneTerrainSystem.getTrackCenterline`: [] when
     * there is no such surface or it forms no loop, oriented the way the player spawn faces.
     */
    getTrackCenterline(name: string, options?: Partial<TrackCenterlineOptions>): CenterlinePoint[] {
        const trimesh = this.getTrimesh(name);
        if (!trimesh) return [];
        const spawn = this.engine.getSpawnPoints?.('player')?.[0];
        const orientTo = options?.orientTo ?? (spawn ? {
            position: { x: spawn.position.x, z: spawn.position.z },
            heading: { x: Math.sin(spawn.rotationY), z: Math.cos(spawn.rotationY) },
        } : undefined);
        return buildTrackCenterline(trimesh, { ...options, orientTo });
    }

    /** A named landmark. Throws, listing the known names, when there is none — a typo must not spawn the boss at the origin. */
    landmark(name: string): MeshLevelLandmark {
        const found = this.requireData('landmark').landmarks.find((l) => l.name === name);
        if (!found) throw new MeshLevelError(`no landmark "${name}" — known landmarks: ${this.describeNames(this.requireData('landmark').landmarks)}`);
        return found;
    }

    hasLandmark(name: string): boolean {
        return this.requireData('hasLandmark').landmarks.some((l) => l.name === name);
    }

    /** Every landmark carrying `tag` (e.g. all `security` posts), in JSON order. */
    landmarksTagged(tag: string): MeshLevelLandmark[] {
        return this.requireData('landmarksTagged').landmarks.filter((l) => l.tags.includes(tag));
    }

    /** A named volume. Throws, listing the known names, when there is none. */
    volume(name: string): MeshLevelVolume {
        const found = this.requireData('volume').volumes.find((v) => v.name === name);
        if (!found) throw new MeshLevelError(`no volume "${name}" — known volumes: ${this.describeNames(this.requireData('volume').volumes)}`);
        return found;
    }

    /** Every volume containing `point`, in JSON order (later entries can be treated as more specific). */
    volumesAt(point: { x: number; y: number; z: number }): MeshLevelVolume[] {
        return this.requireData('volumesAt').volumes.filter((v) => orientedBoxContains(point, v.position, v.size, v.yaw));
    }

    getColliders(): ReadonlyArray<MeshLevelBody> {
        return this.bodies;
    }

    /** World AABB of art and colliders together (null before `load()`). */
    getBounds(): TerrainBounds | null {
        return this.bounds;
    }

    /** The loaded GLB scene, parented under the engine's world group. */
    getRoot(): THREE.Group {
        if (!this.root) throw new MeshLevelError('getRoot() before load()');
        return this.root;
    }

    /** The spot lights the level created (point lights live in a pool and are not exposed). */
    getLights(): ReadonlyArray<THREE.Light> {
        return this.lighting?.spots ?? [];
    }

    /** The JSON `extras` block, untouched. */
    getExtras<T = Record<string, unknown>>(): T {
        return this.requireData('getExtras').extras as T;
    }

    /** Re-bake cached spot shadows after static geometry changed. */
    refreshShadows(): void {
        if (this.lighting) refreshCachedShadows(this.lighting);
    }

    // ---- internals --------------------------------------------------------

    private requireData(method: string): MeshLevelData {
        if (!this.data) throw new MeshLevelError(`${method}() before load() finished`);
        return this.data;
    }

    private describeNames(items: ReadonlyArray<{ name: string }>): string {
        return items.length === 0 ? '(none)' : items.map((i) => `"${i.name}"`).join(', ');
    }

    private gameData(): GameData | null {
        return this.engine.getGameData?.() ?? null;
    }

    private resolveGlbUrl(warnings: string[]): string {
        if ('assetId' in this.source.glb) {
            const id = this.source.glb.assetId;
            const url = getAssetUrlById(this.gameData(), id);
            if (!url) {
                const candidates = (this.gameData()?.assets ?? []).filter((a) => GLB_ASSET_TYPES.has(a.type)).map((a) => `"${a.id}" (${a.name})`);
                throw new MeshLevelError(`no asset with id "${id}" in world.json assets[] — GLB assets present: ${candidates.length ? candidates.join(', ') : '(none; run bitmagic assets add <file>.glb --keep-glb)'}`);
            }
            return url;
        }
        const url = resolveAssetUrl(this.source.glb.url);
        if (!url) throw new MeshLevelError('glb.url is empty');
        if (!/^(https?:|data:|blob:)/.test(url)) {
            warnings.push(`GLB url "${url}" is a local path — it loads in dev and 404s in a published bundle; register it with bitmagic assets add <file>.glb --keep-glb and pass { assetId }`);
        }
        return url;
    }

    private async resolveLevelData(root: THREE.Group, warnings: string[]): Promise<MeshLevelData> {
        const source = this.source.level;
        if (source === 'trimesh-from-glb') {
            return this.trimeshLevelFromGlb(root, warnings);
        }
        if ('data' in source) {
            const parsed = parseMeshLevel(source.data, 'level');
            warnings.push(...parsed.warnings);
            return parsed.data;
        }
        const url = getAssetUrlById(this.gameData(), source.assetId);
        if (!url) throw new MeshLevelError(`no asset with id "${source.assetId}" for the level JSON — register it with bitmagic assets add <file>.json`);
        const res = await fetch(url);
        if (!res.ok) throw new MeshLevelError(`level JSON "${url}" failed to load: HTTP ${res.status}`);
        const parsed = parseMeshLevel(await res.json(), `asset "${source.assetId}"`);
        warnings.push(...parsed.warnings);
        return parsed.data;
    }

    /** One trimesh collider per top-level GLB node, each under the collider builder's budget. */
    private trimeshLevelFromGlb(root: THREE.Group, warnings: string[]): MeshLevelData {
        const colliders: MeshLevelCollider[] = [];
        const include = (mesh: THREE.Mesh) => !mesh.name.toLowerCase().startsWith(NOCOLLIDE_MESH_PREFIX);
        root.children.forEach((node, i) => {
            const soup = collectGlbTriangleSoup(node, include);
            if (soup.indices.length < 3) return;
            const name = node.name || `node_${i}`;
            const built = buildColliderFromTriangles(soupToRasterTriangles(soup.verts, soup.indices, name), this.options.trimeshFallback);
            if (built.simplified) warnings.push(`trimesh for "${name}" exceeded the ${this.options.trimeshFallback.triangleBudget}-triangle budget and was coarsened (cell ${built.cellSize?.toFixed(2)} m) — author colliders in the level JSON for exact walls`);
            colliders.push({ name, shape: 'trimesh', vertices: Array.from(built.verts), indices: Array.from(built.indices) });
        });
        if (colliders.length === 0) throw new MeshLevelError('trimesh-from-glb found no triangles in the GLB');
        warnings.push('level built from the GLB alone: no landmarks, volumes or lights — landmark() and volume() will throw');
        return { format: 'bitmagic-mesh-level', version: 1, units: 'meters', colliders, volumes: [], landmarks: [], lights: [], extras: {} };
    }
}

/** `glass*` materials become thin transparent panes; `emissive*` materials are guaranteed to glow. Every mesh casts and receives shadows. */
export function applyMaterialConventions(root: THREE.Object3D): void {
    root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = true;
        o.receiveShadow = true;
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
            const name = (material.name ?? '').toLowerCase();
            if (name.startsWith(GLASS_MATERIAL_PREFIX)) {
                material.transparent = true;
                material.opacity = Math.min(material.opacity < 1 ? material.opacity : GLASS_OPACITY, GLASS_OPACITY);
                material.depthWrite = false;
                material.side = THREE.DoubleSide;
                o.castShadow = false;
            } else if (name.startsWith(EMISSIVE_MATERIAL_PREFIX) && material instanceof THREE.MeshStandardMaterial) {
                if (material.emissive.getHex() === 0) material.emissive.copy(material.color);
                material.emissiveIntensity = Math.max(material.emissiveIntensity, 1);
            }
        }
    });
}

