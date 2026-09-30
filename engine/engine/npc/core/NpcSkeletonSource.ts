import type { EngineLike } from 'types/game.js';
import { getDefaultCharacterUrl, getDefaultCharacterFallbackUrl } from 'engine/CharacterConfig.js';

/**
 * Engine-scoped source of the humanoid GLTF used as the skeleton when cloning
 * NPCs.
 *
 * Owns the shared, lazily-loaded default rig so the NPC system has no
 * dependency on PlayerLoader: a character-less game (hasPlayerCharacter:false,
 * no PlayerLoader constructed at all) spawns NPCs with zero extra wiring.
 * When a PlayerLoader exists and has loaded the player's GLTF, that rig is
 * preferred — it is the same base skeleton and is already downloaded.
 */
export class NpcSkeletonSource {
    private readonly engine: EngineLike;
    private sharedGLTF: unknown = null;
    private loadStarted = false;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    /**
     * GLTF to clone an NPC skeleton from: the player's own loaded GLTF when
     * available (read dynamically — the loader may be installed after this
     * source), otherwise the shared default rig. Null until either exists;
     * callers trigger ensureLoaded() and retry.
     */
    getSkeletonGLTF(): unknown {
        const playerLoader = (this.engine as { playerLoader?: { getLoadedGLTF?: () => unknown } }).playerLoader;
        return playerLoader?.getLoadedGLTF?.() ?? this.sharedGLTF;
    }

    /**
     * Ensure a skeleton GLTF is (being) loaded. Idempotent and non-blocking:
     * kicks off a single background load of the default character rig (brotli
     * copy first, uncompressed canonical rig as fallback); getSkeletonGLTF()
     * starts returning it once the load resolves. A fully failed load resets
     * so a later call can retry.
     */
    ensureLoaded(): void {
        if (this.getSkeletonGLTF() || this.loadStarted) {
            return;
        }
        const loader = this.engine.loader;
        if (!loader) {
            return;
        }
        this.loadStarted = true;
        const brotliUrl = getDefaultCharacterUrl();
        const fallbackUrl = getDefaultCharacterFallbackUrl();
        console.log(`[NpcSkeletonSource] Loading shared NPC skeleton from: ${brotliUrl}`);
        loader.load(
            brotliUrl,
            (gltf: unknown) => {
                this.sharedGLTF = gltf;
                console.log('[NpcSkeletonSource] NPC skeleton GLTF loaded');
            },
            undefined,
            () => {
                // Brotli copy failed — fall back to the uncompressed canonical rig.
                console.warn(`[NpcSkeletonSource] brotli load failed, falling back to ${fallbackUrl}`);
                loader.load(
                    fallbackUrl,
                    (gltf: unknown) => {
                        this.sharedGLTF = gltf;
                        console.log('[NpcSkeletonSource] NPC skeleton GLTF loaded (fallback)');
                    },
                    undefined,
                    (error: unknown) => {
                        this.loadStarted = false; // allow a later retry
                        console.error('[NpcSkeletonSource] Failed to load NPC skeleton GLTF (brotli + fallback)', error);
                    },
                );
            },
        );
    }
}

const sources = new WeakMap<object, NpcSkeletonSource>();

/**
 * The engine's shared NpcSkeletonSource, created lazily on first use. Keyed by
 * engine so parallel engines (editor previews, tests) don't share a cache, and
 * garbage-collected with the engine. No wiring step to forget: unlike an
 * install-once setter, first use IS the installation.
 */
export function getNpcSkeletonSource(engine: EngineLike): NpcSkeletonSource {
    let source = sources.get(engine);
    if (!source) {
        source = new NpcSkeletonSource(engine);
        sources.set(engine, source);
    }
    return source;
}
