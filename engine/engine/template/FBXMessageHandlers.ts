import * as THREE from 'three';
import { processFBXAnimation, testFBXWithSkin } from 'engine/FBXAnimationProcessor.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';

/**
 * Handle PROCESS_FBX_ANIMATION message from Creator.
 * Validates FBX file has humanoid skeleton and converts to GLB.
 */
export async function handleProcessFBXAnimation(
    ctx: GameTemplateContext,
    data: { requestId: string; fileData: ArrayBuffer; fileName: string }
): Promise<void> {
    console.log(`🎬 PROCESS_FBX_ANIMATION received: ${data.fileName}`);

    try {
        const file = new File([data.fileData], data.fileName, { type: 'application/octet-stream' });
        const result = await processFBXAnimation(file);

        if (result.success && result.glbBlob) {
            const glbArrayBuffer = await result.glbBlob.arrayBuffer();

            ctx.safePostMessage({
                type: 'FBX_ANIMATION_PROCESSED',
                requestId: data.requestId,
                success: true,
                glbData: glbArrayBuffer,
                validation: result.validation,
                unitScale: result.validation?.unitScale ?? 1.0,
                skeletonHeight: result.validation?.skeletonHeight ?? 0,
            });
        } else {
            ctx.safePostMessage({
                type: 'FBX_ANIMATION_PROCESSED',
                requestId: data.requestId,
                success: false,
                error: result.error,
                validation: result.validation,
            });
        }
    } catch (error) {
        console.error('FBX processing error:', error);
        ctx.safePostMessage({
            type: 'FBX_ANIMATION_PROCESSED',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}

/**
 * Handle TEST_FBX_WITH_SKIN message — display FBX mesh with animation for testing.
 */
export async function handleTestFBXWithSkin(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        fileData: ArrayBuffer;
        fileName: string;
        position?: { x: number; y: number; z: number };
    }
): Promise<void> {
    console.log(`🧪 TEST_FBX_WITH_SKIN received: ${data.fileName}`);

    try {
        const gameEngine = ctx.getGameEngine();
        if (!gameEngine?.scene) {
            throw new Error('Game engine not ready');
        }

        const file = new File([data.fileData], data.fileName, { type: 'application/octet-stream' });
        const position = data.position
            ? new THREE.Vector3(data.position.x, data.position.y, data.position.z)
            : new THREE.Vector3(5, 0, 0);

        const result = await testFBXWithSkin(file, gameEngine.scene, position);

        if (result) {
            ctx.safePostMessage({
                type: 'FBX_TEST_STARTED',
                requestId: data.requestId,
                success: true,
            });
        } else {
            ctx.safePostMessage({
                type: 'FBX_TEST_STARTED',
                requestId: data.requestId,
                success: false,
                error: 'Failed to load FBX - check console for details',
            });
        }
    } catch (error) {
        console.error('FBX test error:', error);
        ctx.safePostMessage({
            type: 'FBX_TEST_STARTED',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}

/**
 * Handle CLEANUP_FBX_TEST message — remove test mesh from scene.
 */
export function handleCleanupFBXTest(ctx: GameTemplateContext): void {
    const cleanup = (window as any).__fbxTestCleanup;
    if (cleanup) {
        cleanup();
        ctx.safePostMessage({ type: 'FBX_TEST_CLEANED_UP', success: true });
    } else {
        ctx.safePostMessage({ type: 'FBX_TEST_CLEANED_UP', success: false, error: 'No test to clean up' });
    }
}
