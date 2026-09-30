import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';

const RENDERABLE_TRIANGLE_THRESHOLD = 100;

export interface GlbAnimationInspection {
    hasAnimations: boolean;
    hasRenderableMesh: boolean;
    animationCount: number;
    skeletonHeight: number;
    unitScale: number;
}

function inspectGltfScene(scene: THREE.Object3D): { renderableTriangles: number; skeletonHeight: number } {
    let renderableTriangles = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    const worldPos = new THREE.Vector3();

    scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) {
            const idx = mesh.geometry.index;
            const pos = mesh.geometry.getAttribute('position');
            const vertexCount = idx?.count ?? pos?.count ?? 0;
            renderableTriangles += vertexCount / 3;
        }
        if ((obj as THREE.Bone).isBone) {
            obj.updateWorldMatrix(true, false);
            obj.getWorldPosition(worldPos);
            minY = Math.min(minY, worldPos.y);
            maxY = Math.max(maxY, worldPos.y);
        }
    });

    const skeletonHeight = (minY === Infinity) ? 0 : (maxY - minY);
    return { renderableTriangles, skeletonHeight };
}

export async function inspectGlbAnimation(fileData: ArrayBuffer): Promise<GlbAnimationInspection> {
    const loader = createGltfLoader();
    const gltf = await loader.parseAsync(fileData, '');

    const animationCount = gltf.animations?.length ?? 0;
    const { renderableTriangles, skeletonHeight } = inspectGltfScene(gltf.scene);

    const hasAnimations = animationCount > 0;
    const hasRenderableMesh = renderableTriangles > RENDERABLE_TRIANGLE_THRESHOLD;
    const unitScale = skeletonHeight > 50 ? 0.01 : 1.0;

    return {
        hasAnimations,
        hasRenderableMesh,
        animationCount,
        skeletonHeight,
        unitScale,
    };
}

export async function handleInspectGlbAnimation(
    ctx: GameTemplateContext,
    data: { requestId: string; fileData: ArrayBuffer; fileName: string }
): Promise<void> {
    console.log(`🔎 INSPECT_GLB_ANIMATION received: ${data.fileName}`);

    try {
        const inspection = await inspectGlbAnimation(data.fileData);
        console.log(
            `🔎 ${data.fileName}: animations=${inspection.animationCount}, renderable=${inspection.hasRenderableMesh}, ` +
            `skeletonHeight=${inspection.skeletonHeight.toFixed(2)}, unitScale=${inspection.unitScale}`
        );

        ctx.safePostMessage({
            type: 'GLB_ANIMATION_INSPECTED',
            requestId: data.requestId,
            success: true,
            ...inspection,
        });
    } catch (error) {
        console.error('GLB inspection error:', error);
        ctx.safePostMessage({
            type: 'GLB_ANIMATION_INSPECTED',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}
