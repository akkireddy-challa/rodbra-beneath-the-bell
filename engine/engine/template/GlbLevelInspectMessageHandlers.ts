/**
 * Level-voxelize GLB inspection. Reads the uploaded GLB's scene graph,
 * groups triangles by their topmost-named ancestor node (same heuristic
 * the voxelizer uses to stamp `Triangle.sourceNodeName`), and returns a
 * list of `{ name, triangleCount }` rows for the creator-side dialog
 * to render per-object LOD-offset controls.
 *
 * Distinct from `inspectGlbAnimation` (which decides between voxelize
 * vs animation upload paths) — that one looks for bones + animations;
 * this one just enumerates static-geometry top-level groups.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';

export interface LevelGlbObjectEntry {
    /**
     * Topmost-named ancestor node's name. The level voxelizer's per-object
     * LOD offset map is keyed by this string.
     */
    name: string;
    triangleCount: number;
}

export interface LevelGlbInspection {
    objects: LevelGlbObjectEntry[];
    /** Total triangle count across every mesh in the file, including any
     *  unnamed meshes (those collapse to a single entry with name=""). */
    totalTriangleCount: number;
    /**
     * Voxelization settings embedded in the GLB's scene extras
     * (`bmLevelVoxelize`) by the World Forger. GLB carries no real-world
     * scale, so the authoring tool ships the intended level size and
     * per-object options inside the file; the creator dialog pre-fills
     * from them. Absent for hand-authored GLBs.
     */
    suggestedSettings?: Record<string, unknown>;
}

/**
 * Walk a mesh's parent chain up to (but not including) the scene root
 * and return the topmost-named ancestor's name. Mirrors the helper
 * inside `extractGlbForVoxelization` so the inspection's groupings line
 * up with what the voxelizer will eventually see in `Triangle.sourceNodeName`.
 */
function topLevelNameForMesh(mesh: THREE.Mesh, sceneRoot: THREE.Object3D): string {
    let topNamed = '';
    let node: THREE.Object3D | null = mesh;
    while (node && node !== sceneRoot) {
        if (node.name) topNamed = node.name;
        node = node.parent;
    }
    return topNamed;
}

/** Triangle count from a mesh's geometry buffer (indexed or non-indexed). */
function meshTriangleCount(mesh: THREE.Mesh): number {
    if (!mesh.geometry) return 0;
    const idx = mesh.geometry.index;
    const pos = mesh.geometry.getAttribute('position');
    const vertexCount = idx?.count ?? pos?.count ?? 0;
    return Math.floor(vertexCount / 3);
}

/**
 * Parse a GLB buffer and bucket its triangle counts by top-level named
 * ancestor. Entries are sorted by triangleCount descending so the
 * largest groups appear first in the dialog.
 */
export async function inspectGlbForLevelVoxelize(fileData: ArrayBuffer): Promise<LevelGlbInspection> {
    const loader = createGltfLoader();
    const gltf = await loader.parseAsync(fileData, '');
    const scene = gltf.scene;

    const byName = new Map<string, number>();
    let total = 0;

    scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const tris = meshTriangleCount(mesh);
        if (tris <= 0) return;
        const name = topLevelNameForMesh(mesh, scene);
        byName.set(name, (byName.get(name) ?? 0) + tris);
        total += tris;
    });

    const objects: LevelGlbObjectEntry[] = [];
    for (const [name, triangleCount] of byName) {
        objects.push({ name, triangleCount });
    }
    objects.sort((a, b) => b.triangleCount - a.triangleCount);

    // GLTFLoader copies glTF scene `extras` onto scene.userData.
    const embedded = (scene.userData as Record<string, unknown>)?.bmLevelVoxelize;
    const suggestedSettings = embedded && typeof embedded === 'object'
        ? embedded as Record<string, unknown>
        : undefined;

    return { objects, totalTriangleCount: total, suggestedSettings };
}

/**
 * Handle the `INSPECT_GLB_FOR_LEVEL_VOXELIZE` message. Same shape as
 * `handleInspectGlbAnimation` so the creator-side round-trip code can
 * reuse the same requestId / response pattern.
 */
export async function handleInspectGlbForLevelVoxelize(
    ctx: GameTemplateContext,
    data: { requestId: string; fileData: ArrayBuffer; fileName: string },
): Promise<void> {
    console.log(`[INSPECT_GLB_FOR_LEVEL_VOXELIZE] received: ${data.fileName}`);

    try {
        const inspection = await inspectGlbForLevelVoxelize(data.fileData);
        console.log(
            `[INSPECT_GLB_FOR_LEVEL_VOXELIZE] ${data.fileName}: ` +
            `${inspection.objects.length} top-level objects, ${inspection.totalTriangleCount} triangles total`,
        );
        ctx.safePostMessage({
            type: 'LEVEL_GLB_INSPECTED',
            requestId: data.requestId,
            success: true,
            objects: inspection.objects,
            totalTriangleCount: inspection.totalTriangleCount,
            suggestedSettings: inspection.suggestedSettings,
        });
    } catch (error) {
        console.error('[INSPECT_GLB_FOR_LEVEL_VOXELIZE] error:', error);
        ctx.safePostMessage({
            type: 'LEVEL_GLB_INSPECTED',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'GLB inspection failed',
        });
    }
}
