// SCENE_FOOTPRINT — where the scene's geometry is, for the post-edit visual check.
//
// The Creator asks once when a prompt goes out and twice after the edited game
// has reloaded, then diffs the answers to find WHERE the edit added or changed
// something (creator/src/utils/sceneFootprint.ts) and frames a shot there. The
// prompt-time camera alone misses anything built outside the creator's view.
//
// Every object is rebuilt on a reload, so an entry's key is content-based: the
// kind, the vertex count and the bounds rounded to FOOTPRINT_GRID. Left out are
// things that move or change on their own and would read as "changed": the
// player, NPCs and their block bodies, animals, skinned meshes, particles and lines (editor gizmos), and packed
// InstancedMeshes, whose buffers culling repacks every frame — environment
// objects come from the world generator's own list instead.

import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';

export interface FootprintEntry {
    /** Content key; equal keys before and after mean "the same thing, still there". */
    k: string;
    /** World-space centre and size, rounded to FOOTPRINT_GRID. */
    c: [number, number, number];
    s: [number, number, number];
    /**
     * Voxel/fluid terrain chunks only: the chunk column "cx,cz". Chunks stream in
     * around the camera, so a chunk in a column that was not loaded before is
     * streaming, not the edit — the Creator needs the column to tell them apart.
     */
    col?: string;
}

export interface SceneFootprintResponse {
    requestId: string;
    entries?: FootprintEntry[];
    error?: string;
}

const FOOTPRINT_GRID = 0.5;
/** Larger than any level: sky domes, backdrop planes. */
const MAX_ENTRY_SIZE = 2000;
const MAX_ENTRIES = 20000;
/** Environment objects carry no bounds in their list; frame them as a box this big per unit of scale. */
const ENV_OBJECT_SIZE = 2;

/** VoxelWorld and VoxelFluidSystem name every chunk mesh this way. */
const CHUNK_NAME = /^(?:Voxel|Fluid)Chunk_(-?\d+)_-?\d+_(-?\d+)$/;

function snap(v: number): number {
    return Math.round(v / FOOTPRINT_GRID) * FOOTPRINT_GRID;
}

function snapped(v: THREE.Vector3): [number, number, number] {
    return [snap(v.x), snap(v.y), snap(v.z)];
}

function entry(kind: string, center: [number, number, number], size: [number, number, number]): FootprintEntry {
    return { k: `${kind}|${center.join(',')}|${size.join(',')}`, c: center, s: size };
}

/**
 * Block character bodies (the player's and NPCs') and animals are scene children of
 * their own, not under the rig getPlayerObject() / getCharacter() return. The names
 * are the convention GaussianSplatExporter hides them by.
 */
const CHARACTER_BODY_PREFIXES = ['BlockCharacter', 'AnimalController_', 'SnakeController_'];
const CHARACTER_BODY_SUFFIX = '_BlockCharacter';

function isCharacterBody(object: THREE.Object3D): boolean {
    return CHARACTER_BODY_PREFIXES.some(p => object.name.startsWith(p)) || object.name.endsWith(CHARACTER_BODY_SUFFIX);
}

/** The player and NPC subtrees: they move between the before and after snapshots. */
function movingRoots(engine: GameEngine): Set<THREE.Object3D> {
    const roots = new Set<THREE.Object3D>();
    const player = engine.getPlayerController()?.getPlayerObject?.();
    if (player) roots.add(player);
    for (const npc of engine.getNpcRegistry()?.getAllControllers() ?? []) roots.add(npc.getCharacter());
    return roots;
}

function meshEntries(scene: THREE.Scene, skip: Set<THREE.Object3D>, out: FootprintEntry[]): void {
    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    const visit = (object: THREE.Object3D): void => {
        // A body is posed onto its character only once the game runs, so after the
        // reload it sits elsewhere and would read as the edit (framed at the origin).
        if (skip.has(object) || isCharacterBody(object) || out.length >= MAX_ENTRIES) return;
        // Visibility is deliberately ignored: environment culling toggles it by camera.
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && !(object as THREE.InstancedMesh).isInstancedMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh) {
            const vertices = mesh.geometry?.attributes.position?.count ?? 0;
            if (vertices > 0) {
                box.setFromObject(mesh);
                if (!box.isEmpty() && Number.isFinite(box.min.x) && Number.isFinite(box.max.x)) {
                    box.getSize(size);
                    if (Math.max(size.x, size.y, size.z) <= MAX_ENTRY_SIZE) {
                        const e = entry(`mesh:${vertices}`, snapped(box.getCenter(center)), snapped(size));
                        const chunk = CHUNK_NAME.exec(mesh.name);
                        out.push(chunk ? { ...e, col: `${chunk[1]},${chunk[2]}` } : e);
                    }
                }
            }
        }
        for (const child of object.children) visit(child);
    };
    scene.updateMatrixWorld(true);
    visit(scene);
}

interface SerializedEnvObject {
    type?: unknown;
    assetId?: unknown;
    position?: { x?: unknown; y?: unknown; z?: unknown };
    scale?: { x?: unknown; y?: unknown; z?: unknown };
}

function hasEnvSerializer(value: unknown): value is { serializeEnvironmentObjects: () => unknown } {
    return typeof (value as { serializeEnvironmentObjects?: unknown } | null)?.serializeEnvironmentObjects === 'function';
}

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Placed environment objects, from the same list GET_SCENE_EDITING_STATUS serves. */
function environmentEntries(engine: GameEngine, out: FootprintEntry[]): void {
    const generator = (engine.genreModule as { worldGenerator?: unknown } | null | undefined)?.worldGenerator;
    if (!hasEnvSerializer(generator)) return;
    // Culling repacks LOD buffers per frame; the serializer reads logical slots.
    getActiveEnvironmentObjectSystem()?.restoreLogicalInstanceMatrices();
    const list = generator.serializeEnvironmentObjects();
    if (!Array.isArray(list)) return;
    for (const raw of list as SerializedEnvObject[]) {
        if (out.length >= MAX_ENTRIES) return;
        const p = raw?.position;
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') continue;
        const scale = Math.max(num(raw.scale?.x, 1), num(raw.scale?.y, 1), num(raw.scale?.z, 1), 0.1);
        const side = snap(ENV_OBJECT_SIZE * scale) || FOOTPRINT_GRID;
        const kind = `env:${String(raw.assetId ?? raw.type ?? '')}`;
        // The list gives the object's base; the box sits on it.
        out.push(entry(kind, [snap(p.x), snap(p.y + side / 2), snap(p.z)], [side, side, side]));
    }
}

export function collectSceneFootprint(engine: GameEngine): FootprintEntry[] {
    const scene = engine.scene;
    if (!scene) return [];
    const entries: FootprintEntry[] = [];
    meshEntries(scene, movingRoots(engine), entries);
    environmentEntries(engine, entries);
    return entries;
}

/** Handle one SCENE_FOOTPRINT message. Always answers when a requestId is present. */
export function handleSceneFootprint(
    engine: GameEngine | null,
    data: unknown,
    post: (message: { type: 'SCENE_FOOTPRINT_RESPONSE'; data: SceneFootprintResponse }) => void,
): void {
    const requestId = (data as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string' || !requestId) return;
    if (!engine) {
        post({ type: 'SCENE_FOOTPRINT_RESPONSE', data: { requestId, error: 'the game has not finished loading' } });
        return;
    }
    try {
        post({ type: 'SCENE_FOOTPRINT_RESPONSE', data: { requestId, entries: collectSceneFootprint(engine) } });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[SceneFootprint] Failed:', message);
        post({ type: 'SCENE_FOOTPRINT_RESPONSE', data: { requestId, error: message } });
    }
}
