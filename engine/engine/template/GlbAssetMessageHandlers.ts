/**
 * Creator-iframe handlers for GLB-native asset actions: precise-collision
 * trimesh generation (splat-colliderUrl pattern) and GLB preview thumbnails.
 * Reliability protocol matches the import handlers: ACK first, requestId dedup.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';
import { uploadFile } from 'engine/StorageUploadUtil.js';
import {
    buildColliderFromTriangles, DEFAULT_GLB_COLLIDER_OPTIONS, type RasterTriangle,
} from 'engine/GlbColliderBuilder.js';
import { getGlbPreviewRenderer } from 'engine/GlbPreviewRenderer.js';

const handledGlbRequestIds = new Set<string>();

function dedupe(requestId: string): boolean {
    if (handledGlbRequestIds.has(requestId)) return true;
    handledGlbRequestIds.add(requestId);
    if (handledGlbRequestIds.size > 64) {
        const oldest = handledGlbRequestIds.values().next().value;
        if (oldest !== undefined) handledGlbRequestIds.delete(oldest);
    }
    return false;
}

/**
 * Constant color for collider triangles - the builder rebases every triangle
 * to one node name and one constant color anyway (colors are irrelevant to a
 * collider), so sampling real materials here would be wasted work.
 */
const GLB_TRI_COLOR = { r: 1, g: 1, b: 1 };
const sampleGlbTriColor = (): { r: number; g: number; b: number } => GLB_TRI_COLOR;

/** Unit geometric normal from triangle winding; [0,1,0] for degenerate triangles. */
function triangleNormal(
    v0: [number, number, number],
    v1: [number, number, number],
    v2: [number, number, number],
): [number, number, number] {
    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!Number.isFinite(len) || len < 1e-12) return [0, 1, 0];
    return [nx / len, ny / len, nz / len];
}

/**
 * Load a GLB and flatten it into world-space RasterTriangles (NATIVE units -
 * no targetHeight scaling here; the loader scales per instance at
 * collider-build time). Meshes without a position attribute are skipped.
 * Vertex finiteness is validated downstream by buildColliderFromTriangles.
 */
async function glbUrlToRasterTriangles(glbUrl: string): Promise<RasterTriangle[]> {
    const loader = createGltfLoader();
    const gltf = await loader.loadAsync(glbUrl);
    gltf.scene.updateMatrixWorld(true);

    const tris: RasterTriangle[] = [];
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();

    gltf.scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const geometry = obj.geometry;
        const position = geometry.getAttribute('position');
        if (!position) return;
        const index = geometry.getIndex();
        const nodeName = obj.name || 'glb';
        const matrixWorld = obj.matrixWorld;
        const readVertex = (i: number, target: THREE.Vector3): void => {
            target.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrixWorld);
        };
        const triCount = Math.floor((index ? index.count : position.count) / 3);
        for (let i = 0; i < triCount; i++) {
            readVertex(i * 3, va);
            readVertex(i * 3 + 1, vb);
            readVertex(i * 3 + 2, vc);
            const v0: [number, number, number] = [va.x, va.y, va.z];
            const v1: [number, number, number] = [vb.x, vb.y, vb.z];
            const v2: [number, number, number] = [vc.x, vc.y, vc.z];
            tris.push({
                v0, v1, v2,
                normal: triangleNormal(v0, v1, v2),
                nodeName,
                sampleColor: sampleGlbTriColor,
            });
        }
    });

    return tris;
}

/**
 * Pack a trimesh into GLB bytes via GLTFExporter (SceneExporter pattern):
 * BufferGeometry from verts/indices -> Mesh -> parseAsync(scene, {binary:true}).
 */
async function trimeshToGlbBytes(verts: Float32Array, indices: Uint32Array): Promise<ArrayBuffer> {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'glb-collider';
    const scene = new THREE.Scene();
    scene.add(mesh);
    try {
        const exporter = new GLTFExporter();
        const glb = await exporter.parseAsync(scene, { binary: true });
        return glb as ArrayBuffer;
    } finally {
        geometry.dispose();
        material.dispose();
    }
}

export interface GenerateGlbColliderData {
    requestId: string;
    glbUrl: string;
    assetName: string;
}

export async function handleGenerateGlbCollider(
    ctx: GameTemplateContext,
    data: GenerateGlbColliderData,
): Promise<void> {
    ctx.safePostMessage({ type: 'GENERATE_GLB_COLLIDER_ACK', requestId: data.requestId });
    if (dedupe(data.requestId)) return;
    try {
        const gameData = ctx.getCurrentGameData();
        if (!gameData?.gameId) throw new Error('No current game / gameId');

        // 1. Load the GLB and merge world-transformed triangles.
        const tris = await glbUrlToRasterTriangles(data.glbUrl);

        // 2. Budget/simplify.
        const result = buildColliderFromTriangles(tris, DEFAULT_GLB_COLLIDER_OPTIONS);

        // 3. Export as GLB.
        const glbBytes = await trimeshToGlbBytes(result.verts, result.indices);

        // 4. Upload (same filename pattern as the vwld upload in VoxelImportMessageHandlers).
        const safeName = data.assetName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'collider';
        const colliderUrl = await uploadFile(
            new Uint8Array(glbBytes),
            `${gameData.gameId}-${safeName}-collider-${Date.now()}.glb`,
            {
                contentType: 'model/gltf-binary',
                gameId: gameData.gameId,
            },
        );
        if (!colliderUrl) throw new Error('Failed to upload collider GLB');

        ctx.safePostMessage({
            type: 'GENERATE_GLB_COLLIDER_RESULT',
            requestId: data.requestId,
            success: true,
            colliderUrl,
            colliderTriangles: result.triangleCount,
            simplified: result.simplified,
        });
    } catch (error) {
        console.error('[GENERATE_GLB_COLLIDER] Error:', error);
        ctx.safePostMessage({
            type: 'GENERATE_GLB_COLLIDER_RESULT',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Collider generation failed',
        });
    }
}

export interface GenerateGlbPreviewData {
    requestId: string;
    glbUrl: string;
}

/**
 * Mirror of handleGenerateVoxelPreview's contract: no ACK/dedup, replies
 * { type: 'GLB_PREVIEW_RESPONSE', requestId, success, previewBase64?, error? }.
 */
export async function handleGenerateGlbPreview(
    ctx: GameTemplateContext,
    data: GenerateGlbPreviewData,
): Promise<void> {
    try {
        const previewRenderer = getGlbPreviewRenderer();
        const previewBase64 = await previewRenderer.generatePreview(data.glbUrl);

        ctx.safePostMessage({
            type: 'GLB_PREVIEW_RESPONSE',
            requestId: data.requestId,
            previewBase64,
            success: true,
        });
    } catch (error) {
        console.error('[GENERATE_GLB_PREVIEW] Error generating preview:', error);
        ctx.safePostMessage({
            type: 'GLB_PREVIEW_RESPONSE',
            requestId: data.requestId,
            error: error instanceof Error ? error.message : 'Unknown error',
            success: false,
        });
    }
}
