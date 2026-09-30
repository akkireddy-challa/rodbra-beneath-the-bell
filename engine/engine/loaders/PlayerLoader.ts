import * as THREE from 'three';
import type { WorldProfileData, EngineLike, BaseAnimationDefinition } from 'types/game.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { isClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { clearBloomTint } from 'engine/effects/BloomTint.js';
import { getDefaultCharacterUrl, getDefaultCharacterFallbackUrl, getSkeletonHeight, mergeCharacterConfig } from 'engine/CharacterConfig.js';
import { isDefaultCharacterUrl } from 'engine/AnimationAssets.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { isBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { BlockCharacterWardrobe, CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';
import { registerPlayerBodyForProjectiles, unregisterPlayerBodyForProjectiles } from 'engine/Projectile.js';
import { CollisionMask } from 'engine/CollisionLayers.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { queryPhysicsFor } from 'engine/physics/PlaneLockedPhysics.js';
import { applyCanonicalBoneAliases } from 'engine/SkeletonAliases.js';
import { applyBmCharacterPosture } from 'engine/loaders/BmCharacterPosture.js';
import { cachedGLTFLoad, type CachedGLTF } from 'engine/animation/AnimationContext.js';
import { mapWithConcurrency } from 'engine/AsyncConcurrency.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import { loadCharacterModel, type LoadedCharacterModel } from 'engine/loaders/CharacterModelLoader.js';
import { isVxlCharacterUrl, type VxlCharacterMeasurements } from 'engine/loaders/VxlCharacterLoader.js';
import { measureSkinnedBodyWidthRatio } from 'engine/loaders/SkinnedCharacterMeasure.js';
import type RAPIER from '@dimforge/rapier3d-compat';

// Gravity for the default player physics body. Genres tune player physics via
// their own PhysicsConfig; this engine-level default only seeds the body.
const DEFAULT_PLAYER_GRAVITY = -35.0;

/** Small drop used to detect a floor directly beneath the capsule's feet. */
const SUPPORT_PROBE = 0.1;

/**
 * Bounds every player capsule is sized within: narrow enough to clear a doorway,
 * wide enough that the visible body cannot pass through a wall.
 */
const MIN_CAPSULE_RADIUS = 0.2;
const MAX_CAPSULE_RADIUS = 0.8;
const MIN_CAPSULE_HEIGHT = 0.5;

function clampCapsuleRadius(radius: number): number {
    return Math.max(MIN_CAPSULE_RADIUS, Math.min(radius, MAX_CAPSULE_RADIUS));
}

/**
 * Ground-corrected spawns park the capsule at this clearance above the
 * surface — the character controller's natural rest keeps it ~0.08 (its
 * collision offset) above ground, and nothing lifts an idle capsule parked
 * lower (grounded disables gravity; snap only pulls down). A 0.02 clearance
 * left the character standing 0.06 low at spawn — feet visibly under the
 * rendered terrain until the first step re-solved it.
 */
export const PLAYER_REST_CLEARANCE_M = 0.1;

/**
 * Bound on the downward search for a floor beneath the configured spawn.
 *
 * What keeps the player in the authored room is the scan itself: it returns the
 * HIGHEST qualifying pose, so it always prefers the nearest floor beneath the
 * spawn. This cap only bounds how far the search looks. For the forger's 6 m
 * dungeon storey pitch that makes a wrong-storey landing impossible, but the cap
 * alone is not a guarantee: a building with a sub-3 m storey pitch whose authored
 * room offers no clear pose (e.g. 1 m of headroom) can still seat one storey down.
 */
const MAX_INTERIOR_DESCENT_M = 3.0;

/**
 * Visual-grounding compensation for the character controller's collision
 * offset: the physics capsule rests ~0.08 m above every collider, and on
 * exact-collider surfaces (platforms, slabs, movers) that float is visible.
 * getFeetOffsetY() folds this in so visual grounding sits the feet on the
 * surface. Exported for consumers that must PRESERVE their own tuned lift on
 * top of the raw offset (ski snow lift).
 */
export const VISUAL_GROUND_SINK_M = 0.06;

/**
 * Options for loadPlayer() / loadHeadlessPlayer(). All fields optional;
 * existing callers (which pass nothing) keep the default capsule path.
 */
export interface LoadPlayerOptions {
    /**
     * Pre-built Rapier rigid body to use as the player body instead of the
     * default capsule. When supplied, PlayerLoader does NOT create or position
     * a body — the caller owns the body's shape, position, mass, and collision
     * groups. PlayerLoader still registers the body with the projectile
     * hit-detection system and stores it as `this.playerBody`. Use this for
     * non-humanoid players (spacecraft, mech, robot) where the visible mesh
     * has a distinct shape from the capsule.
     */
    customPhysicsBody?: RAPIER.RigidBody;
}

/**
 * First bone whose name reads as the pelvis/hips — the anchor the block
 * character is positioned from. Null when the rig names it something else.
 */
function findSkeletonRootBone(player: THREE.Object3D): THREE.Bone | null {
    const rootBoneKeywords = ['hip', 'pelvis'];
    let found: THREE.Bone | null = null;
    player.traverse((child: THREE.Object3D) => {
        if (found || !(child as THREE.Bone).isBone) return;
        const lower = child.name.toLowerCase();
        if (rootBoneKeywords.some(k => lower.includes(k))) {
            found = child as THREE.Bone;
        }
    });
    return found;
}

/**
 * An actually-configured asset URL, or undefined when the JSON field is
 * missing, blank, or not a string.
 */
function configuredUrl(url: unknown): string | undefined {
    return typeof url === 'string' && url.trim() !== '' ? url : undefined;
}

/** Run `visit` for every mesh in `root`'s subtree. */
function forEachMesh(root: THREE.Object3D, visit: (mesh: THREE.Mesh) => void): void {
    root.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) visit(mesh);
    });
}

/** Run `visit` for every material of every mesh in `root`'s subtree. */
function forEachMeshMaterial(root: THREE.Object3D, visit: (material: THREE.Material) => void): void {
    forEachMesh(root, (mesh) => {
        if (!mesh.material) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) visit(material);
    });
}

/**
 * PlayerLoader - Loads character mesh, skeleton, and animations from GLB files
 *
 * Architecture Pattern: Animated Skeleton + Block Overlay Renderer
 * ----------------------------------------------------------------
 * This loader prepares the "animated skeleton" part of the pattern:
 * 1. Downloads GLB file (mesh + rig + animations)
 * 2. Hides the mesh (only skeleton is needed for animation)
 * 3. Initializes CharacterAnimationController to drive skeleton
 * 4. Optionally creates BlockCharacterRenderer to visualize the skeleton
 *
 * The mesh is hidden because it serves only as an animation source.
 * The visible character can be:
 * - Block character (created via BlockCharacterRenderer + template factory)
 * - Original mesh (if block character is disabled)
 * - Any other renderer that reads the skeleton's bone transforms
 */
export class PlayerLoader extends CharacterLoader {
    private worldProfileData: WorldProfileData;
    private playerBody: RAPIER.RigidBody | null = null;
    private animationController: CharacterAnimationController | null = null;
    private loadedGLTF: any = null;
    private feetOffsetY: number = 0; // Offset from playerGroup origin to character feet
    private skeletonRootBone: THREE.Bone | null = null; // Root bone (pelvis/hips) for block character positioning
    private playerGroup: THREE.Object3D | null = null; // Reference to playerGroup for position updates
    private renderSkinned: boolean = false; // True = drive & show the glTF skinned mesh; false = block character

    // The player's looks — mesh sets swapped into the ONE block renderer this
    // loader owns. Nothing here owns a renderer or a skeleton binding.
    private readonly wardrobe = new BlockCharacterWardrobe(
        this,
        '[PlayerLoader]',
        () => this.renderSkinned
            ? 'This player renders its skinned glTF mesh — the block character is only a hidden pose source, so changing its meshes has no visible effect.'
            : null,
    );

    // Callbacks fired at the end of each updateBlockCharacter() pass.
    private postBlockUpdateCallbacks: Array<() => void> = [];

    constructor(engine: EngineLike, worldProfileData: WorldProfileData) {
        super(engine);
        this.worldProfileData = worldProfileData;
        // The player's block character gets CLONED Lambert materials: the
        // traverseVisibleCharacter docs invite shipped game code to mutate the
        // player's visible materials in place, which must never reach the
        // shared NPC material cache (see CharacterLoader.createBlockCharacter).
        this.cloneSharedBlockMaterials = true;
    }

    async loadPlayer(options?: LoadPlayerOptions): Promise<THREE.Object3D> {
        // Games can opt out of the full visible-character pipeline via
        // world.json `hasPlayerCharacter: false` (first-person bodies, board
        // games, top-down strategy). Short-circuit to the headless path so
        // we don't load a GLB, build a block character, or run animations
        // that would just have to be hidden.
        if (this.worldProfileData.hasPlayerCharacter === false) {
            return this.loadHeadlessPlayer(options);
        }
        // 4 attempts: 2 on the brotli copy, then 2 on the uncompressed fallback.
        return this.loadPlayerWithRetry(4, 1000, options);
    }

    /**
     * Load a headless player — no character model, no animations, no block character.
     * Creates an invisible physics capsule and an empty group.
     * 
     * Use this for vehicle-only games (racing, etc.) where no humanoid character is needed.
     * All systems (PlayerController, vehicles, camera) still work because they receive
     * the group and physics body.
     */
    async loadHeadlessPlayer(options?: LoadPlayerOptions): Promise<THREE.Object3D> {
        const playerGroup = new THREE.Group();
        playerGroup.name = 'HeadlessPlayer';

        // Set default capsule dimensions (based on typical 1.75m character)
        this.calculatedCapsuleHeight = this.getTargetCharacterHeight();
        this.calculatedCapsuleRadius = 0.3;

        // Position at spawn point + apply initial facing direction from world config
        const { spawnPos, finalY } = this.placeGroupAtSpawn(playerGroup);

        // Add to scene
        if (this.engine.scene) {
            this.engine.scene.add(playerGroup);
        }

        // Store reference
        this.playerGroup = playerGroup;
        this.setCharacterGroup(playerGroup as THREE.Group);

        this.installPhysicsBody(playerGroup, options);

        console.log(`✅ Headless player created at (${spawnPos.x.toFixed(1)}, ${finalY.toFixed(1)}, ${spawnPos.z.toFixed(1)})`);
        return playerGroup;
    }

    /**
     * Resolve the configured character height from world profile data,
     * falling back to the engine default skeleton height (1.75m).
     */
    private getTargetCharacterHeight(): number {
        return this.worldProfileData.characterConfig?.height
            ?? this.worldProfileData.characterHeight
            ?? getSkeletonHeight();
    }

    /**
     * Find the configured player spawn point (the `player`-typed entry in the
     * world.json spawnPoints array), or undefined if none is configured.
     */
    private getPlayerSpawnPoint() {
        return this.worldProfileData.spawnPoints?.find(sp => sp.type === 'player');
    }

    /**
     * Install the player physics body — either use the caller-supplied custom body
     * (and register it with projectile detection) or create the default capsule.
     */
    private installPhysicsBody(playerGroup: THREE.Object3D, options?: LoadPlayerOptions): void {
        if (options?.customPhysicsBody) {
            this.playerBody = options.customPhysicsBody;
            registerPlayerBodyForProjectiles(this.playerBody);
        } else {
            this.createPlayerPhysicsBody(playerGroup);
        }
    }

    /**
     * Get the player spawn rotation Y from spawnPoints array or legacy field.
     */
    private getPlayerSpawnRotationY(): number {
        const playerSp = this.getPlayerSpawnPoint();
        return playerSp?.rotationY ?? this.worldProfileData.playerSpawnRotationY ?? 0;
    }

    /**
     * Resolve the spawn position from world.json.
     *
     * Returns a CONFIGURED x/y/z verbatim — interior spawns (inside a
     * voxelised building, cave, room) must survive. Earlier this routed
     * through engine.findValidVoxelSpawnPosition / getWorldHeightAt /
     * findSpawnPositionInColliderMesh, all of which raycast straight down
     * from above and return the topmost surface (= the building roof for any
     * interior placement). The "make sure the player isn't clipped"
     * responsibility lives in createPlayerPhysicsBody — capsule-overlap test
     * + minimal step-up — so we don't second-guess a saved Y here.
     *
     * The one exception is the legacy { x: 0, y: 0, z: 0 } fallback used when
     * NO spawn is configured anywhere: dropping the player at world origin
     * almost always lands below the terrain surface, so the game looks frozen
     * until the body falls and settles. With no configured Y to respect, we
     * ground-snap to the origin surface instead.
     */
    private findSpawnPosition(): THREE.Vector3 {
        const playerSp = this.getPlayerSpawnPoint();
        const configuredSpawn = playerSp?.position ?? this.worldProfileData.playerSpawnPosition;
        if (configuredSpawn) {
            return new THREE.Vector3(configuredSpawn.x, configuredSpawn.y, configuredSpawn.z);
        }

        const groundY = this.queryGroundHeight(0, 0);
        if (groundY !== null) {
            console.log(`[PlayerLoader] No spawn configured — ground-snapped spawn to (0, ${groundY.toFixed(2)}, 0).`);
            return new THREE.Vector3(0, groundY, 0);
        }
        return new THREE.Vector3(0, 0, 0);
    }

    /**
     * Best-effort ground height at (x, z) using the engine's spawn helpers.
     * Prefers the voxel-aware finder (snaps to a walkable column, avoids trees
     * and props) and falls back to the downward height raycast. Returns null
     * only when neither helper is wired (e.g. headless tests).
     */
    private queryGroundHeight(x: number, z: number): number | null {
        const voxelPos = this.engine.findValidVoxelSpawnPosition?.(x, z);
        if (voxelPos) {
            return voxelPos.y;
        }
        const height = this.engine.getWorldHeightAt?.(x, z);
        return height ?? null;
    }

    /**
     * Position a player group at the configured spawn (with the +0.5 lift) and
     * apply the configured facing direction. Returns the resolved spawn position
     * and final Y so callers can log them. Shared by the headless and
     * full-character load paths.
     */
    private placeGroupAtSpawn(group: THREE.Object3D): { spawnPos: THREE.Vector3; finalY: number } {
        const spawnPos = this.findSpawnPosition();
        const finalY = spawnPos.y + 0.5;
        group.position.set(spawnPos.x, finalY, spawnPos.z);

        const spawnRotY = this.getPlayerSpawnRotationY();
        if (spawnRotY !== 0) {
            group.rotation.y = spawnRotY;
        }
        return { spawnPos, finalY };
    }

    private async loadPlayerWithRetry(maxRetries: number, initialDelay: number, options?: LoadPlayerOptions): Promise<THREE.Object3D> {
        let lastError: Error | null = null;

        // Per-game override (Asset Forger character) always wins and has no
        // fallback. Otherwise use the default rig: the brotli-compressed copy
        // first, falling back to the uncompressed canonical copy after two failed
        // attempts (e.g. a client/proxy that mishandles Content-Encoding: br).
        const customUrl = this.resolveCharacterUrl();
        const BROTLI_ATTEMPTS = 2;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const url = customUrl
                ?? (attempt < BROTLI_ATTEMPTS ? getDefaultCharacterUrl() : getDefaultCharacterFallbackUrl());
            try {
                return await this.attemptLoadPlayer(url, options);
            } catch (error) {
                lastError = error as Error;
                const delay = initialDelay * Math.pow(2, attempt); // Exponential backoff

                if (attempt < maxRetries - 1) {
                    console.warn(`Character load failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`, error);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    console.error(`Character load failed after ${maxRetries} attempts`);
                }
            }
        }

        throw lastError || new Error('Failed to load character after all retries');
    }

    private async attemptLoadPlayer(animationsUrl: string, options?: LoadPlayerOptions): Promise<THREE.Object3D> {
        console.log(`Loading character from: ${animationsUrl}`);
        // Routed rather than loaded directly: a character may be a GLB or a rigged
        // `.vxl`, and `loadCharacterModel` is the one place that knows which.
        let loaded: LoadedCharacterModel;
        try {
            loaded = await loadCharacterModel(this.engine.loader, animationsUrl);
        } catch (error) {
            const errorMessage = `FATAL: Failed to load character model from ${animationsUrl}. This is a fatal condition - the game cannot continue without a valid character model.`;
            console.error(errorMessage, error);
            throw new Error(errorMessage);
        }
        // Store the model for potential NPC cloning
        this.loadedGLTF = loaded;

        console.log('PlayerLoader: Character model loaded successfully');
        const player = loaded.scene;

        const playerGroup = this.setupPlayerCharacter(player);
        this.playerGroup = playerGroup; // Store reference for position updates
        this.setCharacterGroup(playerGroup as THREE.Group); // Set reference for base class

        // Initialize animation controller with merged config (defaults + worldProfileData overrides)
        console.log('PlayerLoader: Creating animation controller');
        const animConfig = mergeCharacterConfig(this.worldProfileData.characterConfig);
        const animationController = new CharacterAnimationController(animConfig);
        // Decided before the animations load: a skinned rig needs the Mixamo
        // players to keep every bone (fingers, toes) its skin may reach.
        const renderSkinned = this.resolveRenderSkinned();
        this.renderSkinned = renderSkinned;
        animationController.setRetainFullSkeleton(renderSkinned);
        this.animationController = animationController;

        // Set character height for Mixamo skeleton scaling
        animationController.setCharacterHeight(this.getTargetCharacterHeight());

        // Build animation list based on configuration
        const animationsToUse = this.buildAnimationsForPlayer();
        if (animationsToUse.length === 0) {
            throw new Error('PlayerLoader: No animations to load');
        }

        console.log(`🎬 PlayerLoader: Loading ${animationsToUse.length} animations`);
        await animationController.initializeWithCharacter(player, loaded, this.engine.loader, animationsToUse, () => {
            const gd = this.engine.getGameData?.();
            return gd ? { assets: gd.assets, scene: this.engine.scene } : null;
        });
        this.setAnimationController(animationController);

        // Forged characters (character-forger GLBs) carry a signature
        // posture in scene extras — additive offsets over every clip.
        applyBmCharacterPosture(player, animationController);

        // Apply walking pose grounding
        this.applyWalkingPoseGrounding(player, loaded);

        // Adjust skeleton position so feet are at origin BEFORE creating block character
        this.adjustSkeletonPosition(player);

        // Add canonical-name aliases ('rightHand', 'leftHand', 'head', …)
        // as empty Object3D children of the matching skeleton bones, so
        // template / gameplay code can use the obvious
        // `player.getObjectByName('rightHand')` regardless of whether
        // the underlying rig is Mixamo, Unreal Manny, or something else.
        applyCanonicalBoneAliases(player);

        const wp = this.worldProfileData;
        const hasCustomCharacterUrl = this.hasCustomCharacterUrl();

        // When a custom character GLB is the visible, authoritative
        // representation (skinned render of a custom characterUrl),
        // its capsule was already measured from the loaded asset's
        // bounding box in setupPlayerCharacter(). Keep those measured
        // dimensions instead of letting the default block character
        // (built only as a hidden pose source here) resize the
        // capsule with humanoid block proportions and squash it.
        const customCharacterAuthoritative = hasCustomCharacterUrl && renderSkinned;

        // Asset-load-time facing correction: some custom character GLBs are
        // authored facing the wrong way and render backward (movement stays
        // correct, only the mesh faces away from travel). When rendering the
        // skinned mesh, apply the configured yaw to the glTF root once. Safe
        // here because the block character is hidden in skinned mode and
        // grounding (feetOffsetY) is Y-only, so a yaw leaves it unaffected.
        const modelRotationY = wp.characterModelRotationY;
        if (renderSkinned && typeof modelRotationY === 'number' && modelRotationY !== 0) {
            player.rotation.y = modelRotationY;
            console.log(`PlayerLoader: Applied characterModelRotationY=${modelRotationY} to skinned mesh`);
        }

        // The block character is still built (when a factory is available)
        // because the skinned path reuses its boneMap and grounding; in
        // skinned mode it is simply kept hidden as the pose source.
        const shouldCreateBlockCharacter = wp.useBlockCharacter !== false;
        const factory = this.engine.blockCharacterFactory;

        if (shouldCreateBlockCharacter && factory && isBlockCharacterFactory(factory)) {
            console.log('PlayerLoader: Creating block character using factory');

            // Use base class method to create block character.
            // Suppress its capsule sizing when a custom character
            // owns its own (already-measured) dimensions.
            this.createBlockCharacter(player, factory, undefined, undefined, !customCharacterAuthoritative);

            this.skeletonRootBone = findSkeletonRootBone(player);

            if (renderSkinned) {
                // Drive & show the real glTF skinned mesh; hide the blocks.
                this.enableSkinnedRendering(player);
                this.blockCharacterRenderer!.getRoot().visible = false;
                console.log('PlayerLoader: Rendering skinned glTF mesh (block character hidden)');
            } else {
                // Hide the original mesh character; block character is visible.
                player.visible = false;
                console.log('PlayerLoader: Original mesh character hidden, block character visible');
            }

            // Calculate the offset from block character root to its feet (for dynamic grounding)
            // Use filtered bounding box to exclude future attachments (weapons, etc.)
            const blockRoot = this.blockCharacterRenderer!.getRoot();
            blockRoot.updateMatrixWorld(true);
            const blockBox = this.computeBoundingBoxExcludingAttachments(blockRoot);
            this.feetOffsetY = blockBox.min.y - blockRoot.position.y;
        } else {
            if (shouldCreateBlockCharacter) {
                console.warn('PlayerLoader: No block character factory provided. Using original mesh character.');
            }
            if (renderSkinned) {
                // No block character to hide behind: drive the skinned mesh directly
                // from the Mixamo blend.
                this.enableSkinnedRendering(player);
            }
        }

        this.installPhysicsBody(playerGroup, options);

        return playerGroup;
    }

    /**
     * Decide whether the loaded glTF/vxl mesh itself is the visible body.
     *
     * The clean BoxGeometry block character is the DEFAULT visible look; the
     * loaded glTF serves only as the hidden animation rig. A highres skinned
     * mesh is shown only on demand — when the user asks.
     *   - useBlockCharacter set (legacy inverse override) wins outright.
     *   - otherwise highres requires an actual custom characterUrl GLB to show:
     *     with a custom URL, render skinned unless useHighResCharacter is
     *     explicitly false; with no custom URL there is no highres asset, so
     *     always fall back to the clean block (even if useHighResCharacter:true).
     *   - a rigged `.vxl` character IS the visible body, not a hidden rig: there
     *     is no block fallback that could show it, and useHighResCharacter
     *     describes a choice between a GLB and the blocks that does not exist for
     *     this format. Only the explicit useBlockCharacter override can hide it.
     */
    private resolveRenderSkinned(): boolean {
        const wp = this.worldProfileData;
        if (wp.useBlockCharacter === true) return false;
        const customUrl = this.resolveCharacterUrl();
        if (customUrl && isVxlCharacterUrl(customUrl)) return true;
        if (wp.useBlockCharacter === false) return true;
        return this.hasCustomCharacterUrl() && (wp.useHighResCharacter ?? true);
    }

    /**
     * The per-game character asset (GLB or `.vxl`), or undefined for the default rig.
     * `worldProfileData.characterUrl` (what `bitmagic character generate|add --apply-to-player` writes)
     * wins; the game.json `characterUrl` field is honoured as a fallback — it is the field
     * every scaffold ships and the one people reach for first, and the engine used to log
     * it as "Final gameData.characterUrl" and then ignore it, rendering the block character.
     *
     * Either field naming the built-in rig (today's URL or a legacy default an older writer
     * baked in — see isDefaultCharacterUrl) is the same as naming nothing: the default path
     * with its brotli-then-uncompressed retry applies. Taking such a value literally made a
     * dead legacy URL a no-fallback override, and every game carrying it failed to load.
     */
    private resolveCharacterUrl(): string | undefined {
        const profileUrl = this.worldProfileData.characterUrl;
        if (PlayerLoader.isCustomCharacterUrl(profileUrl)) return profileUrl;
        const gameUrl = this.engine.getGameData?.()?.characterUrl;
        if (PlayerLoader.isCustomCharacterUrl(gameUrl)) return gameUrl;
        return undefined;
    }

    private static isCustomCharacterUrl(url: unknown): url is string {
        const configured = configuredUrl(url);
        return configured !== undefined && !isDefaultCharacterUrl(configured);
    }

    /** True when world.json or game.json names a per-game character asset (GLB or `.vxl`). */
    private hasCustomCharacterUrl(): boolean {
        return this.resolveCharacterUrl() !== undefined;
    }

    /**
     * Build the list of animations to load.
     * 
     * Loads core locomotion animations by default.
     * Legacy baseAnimations still supported for backward compatibility.
     * 
     * Combat/weapon animations are loaded by Game templates when needed
     * via animController.loadAnimationPack().
     */
    private buildAnimationsForPlayer(): BaseAnimationDefinition[] {
        // Legacy: baseAnimations provided in JSON → use them (backward compatibility)
        const legacy = this.worldProfileData.baseAnimations;
        if (legacy && legacy.length > 0) {
            console.log(`📦 PlayerLoader: Using legacy baseAnimations (${legacy.length} animations)`);
            return legacy;
        }

        // Default: load core animations (locomotion + basic idle)
        // Combat/weapon animations loaded by Game templates when needed
        console.log(`🎬 PlayerLoader: Loading core animations`);
        return buildAnimationList();
    }

    /**
     * Warm the shared GLTF cache with the player's animation GLBs so they
     * download *alongside* the character rig instead of after it. Fire-and-forget
     * and idempotent: `cachedGLTFLoad` keys by URL, so when the animation system
     * later loads the same URLs it reuses these in-flight fetches. Bounded by the
     * mobile-aware concurrency cap. Call right before `loadPlayer()`.
     */
    prefetchPlayerAnimations(): void {
        if (!this.engine.loader) return;
        const anims = this.buildAnimationsForPlayer();
        if (anims.length === 0) return;
        const loaderRef = this.engine.loader as unknown as { loadAsync: (url: string) => Promise<CachedGLTF> };
        void mapWithConcurrency(anims, activeQualityPolicy().deferred.loadConcurrency, (anim) =>
            cachedGLTFLoad(loaderRef, anim.animationUrl).catch(() => null),
        );
    }

    private setupPlayerCharacter(player: THREE.Object3D): THREE.Object3D {
        player.updateMatrixWorld(true);

        // A rigged `.vxl` body measures and sizes itself, and must NOT be scaled.
        //
        // Scaling smears a voxel grid off its own lattice, which is why voxel
        // assets are never scaled anywhere in the engine — and these bodies do not
        // need it: the pipeline normalises every one of them to 1.72 m, 1.7 % off
        // the 1.75 m default. Its capsule cannot come from the bounding box either,
        // because the bind pose is a T-pose up to 2.65 m wide; `measureVxlCharacter`
        // excludes the arms instead. An explicitly configured height still wins, as
        // a deliberate opt-in rather than a silent default.
        const vxlMeasurements = player.userData.vxlMeasurements as VxlCharacterMeasurements | undefined;
        if (vxlMeasurements) {
            const configured = this.worldProfileData.characterConfig?.height;
            if (typeof configured === 'number' && Math.abs(configured - vxlMeasurements.height) > 0.01) {
                console.log(`PlayerLoader: scaling voxel character to configured height ${configured} (natural ${vxlMeasurements.height.toFixed(3)})`);
                player.scale.multiplyScalar(configured / vxlMeasurements.height);
                player.updateMatrixWorld(true);
            }
            const scale = player.scale.y;
            this.calculatedCapsuleHeight = vxlMeasurements.height * scale * 1.05;
            this.calculatedCapsuleRadius = vxlMeasurements.radius * scale;
            return this.finishPlayerSetup(player);
        }

        const box = new THREE.Box3().setFromObject(player);
        const size = box.getSize(new THREE.Vector3());
        const currentHeight = size.y;
        const scale = this.getTargetCharacterHeight() / currentHeight;

        player.scale.multiplyScalar(scale);

        // Recalculate bounding box after scaling
        box.setFromObject(player);
        const scaledSize = box.getSize(new THREE.Vector3());

        // Note: Skeleton position adjustment is done later via super.adjustSkeletonPosition()
        // after animations are loaded, to ensure proper feet positioning for block character

        // Character from Blender export should be correctly oriented
        // No coordinate transformation needed

        // Calculate capsule dimensions from the scaled character, with the
        // T-posed arms discounted out of the width (see SkinnedCharacterMeasure).
        this.calculateCapsuleDimensions(scaledSize, measureSkinnedBodyWidthRatio(player));
        return this.finishPlayerSetup(player);
    }

    /** Spawn placement, shadows and material defaults — shared by both character formats. */
    private finishPlayerSetup(player: THREE.Object3D): THREE.Object3D {

        const playerGroup = new THREE.Group();
        playerGroup.name = 'PlayerGroup';
        playerGroup.add(player);

        // Determine spawn position + facing direction using shared logic
        const { spawnPos, finalY } = this.placeGroupAtSpawn(playerGroup);
        console.log(`[SpawnHeight] Final spawn position: (${spawnPos.x}, ${finalY}, ${spawnPos.z})`);

        this.enableShadows(playerGroup);
        if (this.engine.scene) {
            this.engine.scene.add(playerGroup);
        }
        console.log('Player loaded and scaled with corrected facing direction');

        // this.analyzeModel(player, '++ Loaded as: ');
        // A voxel character's material is authored, not imported: it is already the
        // matte vertex-colour Lambert this pass exists to convert glTF imports INTO,
        // and it is SHARED by every instance of that body — so mutating it here
        // would reach across characters for no gain.
        if (!player.userData.vxlMeasurements) {
            this.modifyGLTFMaterialDefaults(player);
        }
        // this.analyzeModel(player, '+++ Modified: ');

        return playerGroup;
    }

    private modifyGLTFMaterialDefaults(player: THREE.Object3D): void {
        forEachMeshMaterial(player, (mat) => {
            // A classed part (`BM_slot_gold` on a forged character) already
            // IS its intended material — flattening it would undo the class.
            // Ordinary imports still get the full matte treatment below.
            if (isClassedPartMaterial(mat)) return;
            const standardMat = mat as THREE.MeshStandardMaterial;

            if (standardMat.map) {
                standardMat.map.colorSpace = THREE.SRGBColorSpace;
            }

            standardMat.metalness = 0.0;
            standardMat.roughness = 1.0;

            // Light the character from the scene's local lights, NOT the
            // environment map — the block-character path converts to
            // MeshLambert for exactly this reason. A bright sky environment
            // otherwise reflects across the mesh as a white sheen and washes
            // the colours out.
            standardMat.envMapIntensity = 0;

            // Spec/gloss source assets (e.g. Mixamo characters) import as
            // MeshPhysicalMaterial carrying a KHR_materials_specular layer.
            // Drop its maps and the specular lobe so the surface is fully matte
            // (no Fresnel rim reflecting the sky).
            const physMat = mat as THREE.MeshPhysicalMaterial;
            if ('specularIntensity' in physMat) {
                physMat.specularIntensityMap = null;
                physMat.specularColorMap = null;
                physMat.specularIntensity = 0;
            }

            standardMat.needsUpdate = true;
        });
    }

    /**
     * Set up the loaded glTF character for skinned-mesh rendering: register its
     * skeleton as the per-frame pose target, keep it visible, disable frustum
     * culling (bones are posed manually so the cached bounding volume is stale
     * and three.js would wrongly cull the mesh), and opt out of the bloom
     * emissive tint (which washes a realistic mesh to a milky grey).
     */
    private enableSkinnedRendering(player: THREE.Object3D): void {
        this.setSkinnedSkeletonRoot(player);
        player.visible = true;
        forEachMesh(player, (mesh) => {
            mesh.frustumCulled = false;
            mesh.userData.skipBloomTint = true;
        });
    }

    /** True when the player renders as the glTF skinned mesh (not the block character). */
    isRenderingSkinnedMesh(): boolean {
        return this.renderSkinned;
    }

    /**
     * True when the player is headless BY DESIGN (world.json
     * `hasPlayerCharacter: false` — first-person, vehicle, board games): no
     * character model, no block renderer, ever. Systems that would otherwise
     * wait for the renderer (weapon equip) should proceed without one.
     */
    isHeadlessPlayer(): boolean {
        return this.worldProfileData.hasPlayerCharacter === false;
    }

    /**
     * Defensively clear the "bloom tint" emissive from the skinned mesh.
     *
     * enableBloomOnObject() gives the player a low grey emissive (≈ baseColor ×
     * 0.35) so the block character pops under the bloom post-pass. On a realistic
     * skinned mesh that reads as a milky white wash. The per-mesh `skipBloomTint`
     * opt-out only works if the flag is set before the tint is written, and a
     * later character-modification/bloom pass can apply it after — so we clear it
     * here every frame.
     *
     * `clearBloomTint` removes ONLY emission the tint itself wrote (it matches
     * the value recorded on the material), so a coloured runtime emissive
     * (DamageFlash red) and — the reason this is not a colour heuristic — a GLB
     * character that stores its clothing and face on the emissive channel keep
     * what their author gave them.
     */
    private neutralizeBloomTint(): void {
        const root = this.skinnedSkeletonRoot;
        if (!root) return;
        forEachMeshMaterial(root, (mat) => {
            // A classed part's glow is authored (grey/white included) — it is
            // never tinted, and must not be cleared.
            if (isClassedPartMaterial(mat)) return;
            clearBloomTint(mat);
        });
    }

    /**
     * @param bodyWidthRatio share of the horizontal box the BODY occupies once
     *   the T-posed arms are excluded (`measureSkinnedBodyWidthRatio`), or null
     *   for an unmeasurable body — then the whole box is used, as before.
     *   Without it a character GLB, which is authored arms-out, is wrapped in a
     *   capsule wider than it is tall: a ball that rides up voxel edges instead
     *   of stepping onto them.
     */
    private calculateCapsuleDimensions(characterSize: THREE.Vector3, bodyWidthRatio: number | null): void {
        // Use the character's actual height for capsule height, with extra margin
        // to ensure the head is covered for projectile hit detection
        this.calculatedCapsuleHeight = characterSize.y * 1.05; // 5% extra to cover head

        // Calculate radius based on the larger of width or depth, with some padding
        const maxHorizontal = Math.max(characterSize.x, characterSize.z);
        const bodyHorizontal = bodyWidthRatio === null ? maxHorizontal : maxHorizontal * bodyWidthRatio;
        this.calculatedCapsuleRadius = clampCapsuleRadius((bodyHorizontal / 2) * 1.1); // Reduced from 1.2 to 1.1
        if (bodyWidthRatio !== null && bodyWidthRatio < 0.9) {
            console.log(
                `PlayerLoader: capsule radius ${this.calculatedCapsuleRadius.toFixed(3)} from the body `
                + `(${(bodyWidthRatio * 100).toFixed(0)}% of the T-pose width ${maxHorizontal.toFixed(2)})`,
            );
        }
    }


    private enableShadows(player: THREE.Object3D): void {
        forEachMesh(player, (mesh) => {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
        });
    }

    /** The world the player body lives in: 3D, or the 2D world through its plane-locked facade. */
    private playerPhysics(): PhysicsWorld | null {
        return queryPhysicsFor(this.engine);
    }

    private createPlayerPhysicsBody(player: THREE.Object3D): void {
        const physicsWorld = this.playerPhysics();
        if (!physicsWorld) {
            console.warn('Physics world not initialized, player body not added');
            return;
        }

        const x = player.position.x;
        const z = player.position.z;

        // Capsule dimensions used by createPhysicsBody (must match
        // CharacterLoader.createPhysicsBody so the overlap test queries the
        // same shape the runtime body will own).
        const radius = this.calculatedCapsuleRadius;
        const totalHeight = this.calculatedCapsuleHeight;
        const cylinderHalfHeight = Math.max(0, (totalHeight - 2 * radius) / 2);
        const SPAWN_OFFSET = 0.05; // matches CharacterLoader.createPhysicsBody
        const centerOffsetY = totalHeight / 2 + SPAWN_OFFSET;

        const capsuleOverlapsAt = (footY: number): boolean =>
            physicsWorld.capsuleOverlaps(
                { x, y: footY + centerOffsetY, z },
                radius,
                cylinderHalfHeight,
                CollisionMask.PLAYER,
            );

        // Trust the configured spawn Y when the player capsule fits at that
        // point. This is what makes interior spawns (e.g. inside a voxelised
        // building) work — a downward ground-finding raycast would otherwise
        // hit the building's roof and lift the player onto it. Only when the
        // capsule actually overlaps a collider do we fall back to lifting:
        // first try the legacy "ground at xz" snap, then step upward.
        let spawnY = player.position.y;
        let correctionApplied = false;
        if (capsuleOverlapsAt(spawnY)) {
            let resolved = false;
            let groundY: number | null = null;
            // A spawn authored above an interior floor overlaps the room's
            // ceiling. Seat it on that floor BEFORE consulting getWorldHeightAt
            // below: that query is top-down, so inside a structure it reports
            // the surface above the whole thing and the lift parks the player
            // on the roof. The search only succeeds where a real floor exists
            // within MAX_INTERIOR_DESCENT_M, so a spawn buried in terrain (only
            // more solid below) still falls through to the lift.
            const seatedY = this.findSupportedPoseBelow(spawnY, capsuleOverlapsAt, MAX_INTERIOR_DESCENT_M);
            if (seatedY !== null) {
                spawnY = seatedY;
                resolved = true;
            }
            if (!resolved && this.engine.getWorldHeightAt) {
                groundY = this.engine.getWorldHeightAt(x, z);
                const candidate = Math.max(spawnY, groundY) + PLAYER_REST_CLEARANCE_M;
                if (!capsuleOverlapsAt(candidate)) {
                    spawnY = candidate;
                    resolved = true;
                } else if (groundY + PLAYER_REST_CLEARANCE_M < spawnY && !capsuleOverlapsAt(groundY + PLAYER_REST_CLEARANCE_M)) {
                    // A spawn configured ABOVE the floor of a roofed interior
                    // overlaps the ceiling, and lifting would park the player
                    // ON the roof — snap DOWN onto the ground first.
                    spawnY = groundY + PLAYER_REST_CLEARANCE_M;
                    resolved = true;
                }
            }
            if (!resolved) {
                // Step upward in small increments until we find clear space
                // (capped so we don't loop forever). Start from the LOWER of
                // configured/ground level: inside a building that finds the
                // interior floor instead of jumping past the roof.
                const stepSize = Math.max(0.05, radius * 0.5);
                const maxLift = totalHeight * 4 + 5;
                const base = groundY !== null ? Math.min(spawnY, groundY + PLAYER_REST_CLEARANCE_M) : spawnY;
                for (let lifted = stepSize; lifted <= maxLift; lifted += stepSize) {
                    if (!capsuleOverlapsAt(base + lifted)) {
                        spawnY = base + lifted;
                        resolved = true;
                        break;
                    }
                }
                if (!resolved) {
                    console.warn(`[PlayerLoader] No clear capsule pose found near spawn (${x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${z.toFixed(2)}); using configured Y as-is.`);
                }
            }
            correctionApplied = resolved;
        } else if (this.engine.getWorldHeightAt) {
            // The capsule fits, but it may be floating in open air *below* the
            // ground surface (e.g. a zero/low configured Y under a platform or
            // floor). Gravity would just drop the body until it settles, so the
            // game reads as frozen until the player is controllable. Lift only
            // when the player is genuinely unsupported: if lowering the capsule
            // slightly still finds clear space, there is no floor directly
            // beneath, so snap up onto the surface. A player resting on an
            // interior floor (under a roof) overlaps just below its feet and is
            // left untouched, so interior spawns are preserved.
            const groundY = this.engine.getWorldHeightAt(x, z);
            const supported = capsuleOverlapsAt(spawnY - SUPPORT_PROBE);
            if (groundY > spawnY && !supported) {
                // "Ground above an unsupported player" is also what a roofed
                // interior looks like to the top-down height query, and lifting
                // there parks the player on the roof. Prefer a floor beneath the
                // spawn; the search finds one only inside a structure, so an
                // open-air spawn with nothing within MAX_INTERIOR_DESCENT_M
                // still takes the original lift.
                const seatedY = this.findSupportedPoseBelow(spawnY, capsuleOverlapsAt, MAX_INTERIOR_DESCENT_M);
                if (seatedY !== null) {
                    spawnY = seatedY;
                    correctionApplied = true;
                } else {
                    const candidate = groundY + PLAYER_REST_CLEARANCE_M;
                    if (!capsuleOverlapsAt(candidate)) {
                        spawnY = candidate;
                        correctionApplied = true;
                    }
                }
            }
        }

        if (correctionApplied) {
            console.log(`[PlayerLoader] Ground-corrected spawn from y=${player.position.y.toFixed(2)} to y=${spawnY.toFixed(2)} at (${x.toFixed(2)}, ${z.toFixed(2)}).`);
        }

        const spawnPosition = new THREE.Vector3(x, spawnY, z);

        // Probe BEFORE the player body exists — engine raycasts have no
        // self-exclusion, so afterwards every ray would hit the capsule.
        this.warnIfSpawnEnclosed(physicsWorld, spawnPosition, radius);

        this.playerBody = this.createPhysicsBody(
            spawnPosition,
            physicsWorld,
            DEFAULT_PLAYER_GRAVITY,
        );

        // Register player body for projectile hit detection
        // This allows enemy projectiles to identify when they hit the player
        if (this.playerBody) {
            registerPlayerBodyForProjectiles(this.playerBody);
        }
    }

    /**
     * Search DOWNWARD from `fromY` for a capsule foot height that is both clear
     * of colliders and standing on one, i.e. a real floor beneath the spawn.
     * Returns the HIGHEST such pose (first match wins, so the nearest floor
     * beneath the spawn), or null when none exists within `maxDrop`.
     *
     * This is the interior-aware counterpart to getWorldHeightAt, which
     * raycasts top-down and therefore reports the surface above a roofed
     * structure rather than the floor the spawn was authored on.
     *
     * @param fromY - Capsule foot height to start below (never tested itself).
     * @param capsuleOverlapsAt - True when the capsule at that foot height hits a collider.
     * @param maxDrop - Metres to search below `fromY`.
     */
    private findSupportedPoseBelow(
        fromY: number,
        capsuleOverlapsAt: (footY: number) => boolean,
        maxDrop: number,
    ): number | null {
        // The band above a floor where the capsule is simultaneously clear of it
        // and close enough to read as supported is exactly SUPPORT_PROBE tall, so
        // the step must be at most half the probe — a coarser one strides over
        // valid floors. The scan runs once, at spawn, so the extra samples are free.
        const stepSize = SUPPORT_PROBE / 2;
        for (let dropped = stepSize; dropped <= maxDrop; dropped += stepSize) {
            const candidate = fromY - dropped;
            if (!capsuleOverlapsAt(candidate) && capsuleOverlapsAt(candidate - SUPPORT_PROBE)) {
                // Normalize to the same rest pose every other correction here
                // produces: the raw lattice point can sit flush on the floor,
                // which is the sunk-feet artifact PLAYER_REST_CLEARANCE_M exists to kill.
                // Keep the raw point if the clearance would re-clip a low ceiling.
                const seated = candidate + PLAYER_REST_CLEARANCE_M;
                return capsuleOverlapsAt(seated) ? candidate : seated;
            }
        }
        return null;
    }

    /**
     * Warn loudly when the spawn point sits inside a closed structure — a
     * doorless building traps the player permanently, and the lock-in is
     * otherwise invisible until someone plays the level. Probe: horizontal
     * rays at chest height, origins pushed just outside the capsule radius
     * (rays have no self/each-other exclusion); when EVERY ray hits within
     * ENCLOSURE_RADIUS_M there is no walkable opening in range. Warning-only —
     * relocating the player here would silently override level design.
     */
    private warnIfSpawnEnclosed(physicsWorld: PhysicsWorld, spawn: THREE.Vector3, capsuleRadius: number): void {
        const ENCLOSURE_RADIUS_M = 8;
        const RAY_COUNT = 24;
        const CHEST_Y = 1.2;
        const originOffset = capsuleRadius + 0.2;

        const origin = new THREE.Vector3();
        const dir = new THREE.Vector3();
        let openings = 0;
        for (let i = 0; i < RAY_COUNT; i++) {
            const a = (i / RAY_COUNT) * Math.PI * 2;
            dir.set(Math.sin(a), 0, Math.cos(a));
            origin.set(spawn.x + dir.x * originOffset, spawn.y + CHEST_Y, spawn.z + dir.z * originOffset);
            const hit = physicsWorld.raycast(origin, dir, ENCLOSURE_RADIUS_M);
            if (!hit.hasHit) openings++;
        }
        if (openings > 0) return;

        dir.set(0, 1, 0);
        origin.set(spawn.x, spawn.y + CHEST_Y, spawn.z);
        const roofed = physicsWorld.raycast(origin, dir, 6).hasHit;
        console.warn(
            `[PlayerLoader] Spawn (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}, ${spawn.z.toFixed(1)}) appears ` +
            `ENCLOSED: no horizontal opening within ${ENCLOSURE_RADIUS_M}m${roofed ? ' and a roof overhead' : ''} — ` +
            `players may be trapped. Give the structure a doorway (worldProfileData.hotspots type 'building' ` +
            `guarantees one) or move the spawn point outside.`,
        );
    }

    getPlayerBody(): RAPIER.RigidBody | null {
        return this.playerBody;
    }

    /**
     * Enable gravity on the player body.
     * Call this AFTER terrain is fully loaded to prevent falling through unloaded terrain.
     */
    enablePlayerGravity(): void {
        if (this.playerBody) {
            this.enableGravity(this.playerBody);
            console.log('✅ Player gravity enabled');
        }
    }

    getCapsuleHalfHeight(): number {
        return this.getCapsuleHeight() / 2;
    }

    getFeetOffsetY(): number {
        // VISUAL_GROUND_SINK_M: the character controller keeps the physics
        // capsule ~0.08 m above every collider (its collision offset — a
        // physics necessity for seam-free sliding). Terrain hides that float
        // because its SMOOTHED render surface sits above the blocky collider,
        // but exact-collider surfaces (platforms, slabs, engine movers) show
        // the full gap — the character visibly hovers. Compensate in the
        // visual grounding only: every consumer that plants the feet at
        // "capsule bottom" gets a slightly lower answer, so feet meet the
        // surface. Physics is untouched.
        return this.feetOffsetY + VISUAL_GROUND_SINK_M;
    }

    getLoadedGLTF(): any {
        return this.loadedGLTF;
    }

    /**
     * Update the calculated capsule dimensions (for character modifications like Donald Duck)
     */
    updateCapsuleDimensions(height: number, radius: number): void {
        // Apply the same bounds checking as calculateCapsuleDimensions
        // Update base class properties
        this.calculatedCapsuleHeight = Math.max(MIN_CAPSULE_HEIGHT, height);
        this.calculatedCapsuleRadius = clampCapsuleRadius(radius);
    }

    /**
     * Recreate the physics body with new dimensions
     */
    recreatePhysicsBody(player: THREE.Object3D): void {
        // Get current position and velocity, and calculate old capsule dimensions from position
        let currentPos = { x: 0, y: 0.5, z: 0 };
        let currentVelocity = { x: 0, y: 0, z: 0 };
        let oldHeight = 1.75; // Default

        if (this.playerBody) {
            const pos = this.playerBody.translation();
            currentPos = { x: pos.x, y: pos.y, z: pos.z };

            // Use stored capsule height
            oldHeight = this.calculatedCapsuleHeight;

            const velocity = this.playerBody.linvel();
            currentVelocity = { x: velocity.x, y: velocity.y, z: velocity.z };

            // Unregister old player body from projectile hit detection
            unregisterPlayerBodyForProjectiles(this.playerBody);
            
            // Remove old physics body
            this.playerPhysics()?.removeRigidBody(this.playerBody);
        }

        // Calculate adjusted Y position to keep the bottom of the capsule at the same ground level
        // Old bottom Y = currentPos.y - oldHeight/2
        // New center Y should be: oldBottomY + newHeight/2
        const oldBottomY = currentPos.y - oldHeight / 2;
        const newGroundPosition = new THREE.Vector3(currentPos.x, oldBottomY, currentPos.z);

        // Use base class method to create new physics body
        const physicsWorld = this.playerPhysics();
        if (physicsWorld) {
            this.playerBody = this.createPhysicsBody(
                newGroundPosition,
                physicsWorld,
                DEFAULT_PLAYER_GRAVITY
            );

            // Register new player body for projectile hit detection
            if (this.playerBody) {
                registerPlayerBodyForProjectiles(this.playerBody);

                // Restore velocity
                this.playerBody.setLinvel(currentVelocity, true);

                // Wake up the body
                this.playerBody.wakeUp();
            }
        }
    }

    getAnimationController(): CharacterAnimationController | null {
        return this.animationController;
    }

    /**
     * Apply walking pose grounding to ensure character feet are properly positioned
     */
    private applyWalkingPoseGrounding(player: THREE.Object3D, animGltf: { animations: THREE.AnimationClip[] }): void {
        // Locate the Scene child (for grounding offset) and the skinned mesh in a single pass.
        // Matches the original two-pass behaviour: last match wins for both nodes.
        // Collected into an object so both stay properly typed afterwards — TS
        // cannot narrow a plain `let` that is only assigned inside the callback.
        const found: { sceneChild: THREE.Object3D | null; skinnedMesh: THREE.SkinnedMesh | null } =
            { sceneChild: null, skinnedMesh: null };
        player.traverse((child) => {
            if (child.name === 'Scene' || child.name === 'Scene(Clone)') {
                found.sceneChild = child;
            }
            if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
                found.skinnedMesh = child as THREE.SkinnedMesh;
            }
        });
        const { sceneChild, skinnedMesh } = found;

        const sceneLocalY = sceneChild ? sceneChild.position.y : 0;
        const originalTPoseMinY = -sceneLocalY; // The original minY used for T-pose grounding

        if (!skinnedMesh) return;

        // Set up mixer and set to walking pose
        const mixer = new THREE.AnimationMixer(skinnedMesh);
        const walkingClip = THREE.AnimationClip.findByName(animGltf.animations, 'Walk') || 
                           THREE.AnimationClip.findByName(animGltf.animations, 'walk') ||
                           animGltf.animations[0];

        if (!walkingClip) return;

        // The sample below poses the REAL bones (three resolves a track's node
        // through the mesh's skeleton), and a mixer never returns them to rest.
        // Left posed, the skinned rig would start life at walk frame 0 — and the
        // block character built next would measure its feet offset from it.
        const restore = PlayerLoader.snapshotBoneTransforms(player);

        const action = mixer.clipAction(walkingClip);
        action.play();
        action.time = 0;
        mixer.update(0);

        // Update hierarchy and skeleton
        player.updateMatrixWorld(true);
        skinnedMesh.skeleton.update();

        // Compute bounding box in walking pose
        const box = new THREE.Box3();
        const target = new THREE.Vector3();
        const positionAttribute = skinnedMesh.geometry.attributes.position;

        if (!positionAttribute) return;

        // Get character scale
        const characterScale = sceneChild ? sceneChild.scale.x : 1;

        for (let i = 0; i < positionAttribute.count; i++) {
            target.fromBufferAttribute(positionAttribute, i);
            skinnedMesh.applyBoneTransform(i, target);
            box.expandByPoint(target);
        }

        // In walking pose, Z is flipped, so use -max.z for feet position
        const scaledMinZ = (-box.max.z) * characterScale;
        
        // Apply walking pose grounding if significantly different from T-pose
        if (Math.abs(scaledMinZ - originalTPoseMinY) > 0.01 && sceneChild) {
            sceneChild.position.y = -scaledMinZ;
        }
        restore();
        player.updateMatrixWorld(true);
    }

    /**
     * Capture every bone's local transform under `root`; the returned function
     * puts them back. For a measurement that has to pose the rig and then leave
     * it exactly as it found it.
     */
    private static snapshotBoneTransforms(root: THREE.Object3D): () => void {
        const saved: Array<{ bone: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }> = [];
        root.traverse((o) => {
            if (!(o as THREE.Bone).isBone) return;
            saved.push({ bone: o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
        });
        return () => {
            for (const { bone, p, q, s } of saved) {
                bone.position.copy(p);
                bone.quaternion.copy(q);
                bone.scale.copy(s);
                bone.updateMatrix();
            }
        };
    }

    /**
     * Apply character modifications after PlayerController is ready
     *
     * This is an optional hook for templates to apply post-creation modifications
     * such as scaling, physics adjustments, or other customizations that require
     * the PlayerController to be fully initialized.
     *
     * Example: Bitmagic character scaling and physics updates
     */
    applyCharacterModifications(player: THREE.Object3D, playerController: any): void {
        // Headless players have no skeleton or block character for the template
        // hook to scale/modify — skip it. fireCharacterReady still runs so
        // PlayerController-level attachments aren't blocked.
        const skipTemplateHook = this.worldProfileData.hasPlayerCharacter === false;
        // A per-game character body (an Asset Forger GLB or `.vxl`) is sized by
        // its own measurements and `characterConfig.height`; the template hook
        // is the DEFAULT mascot's business (it rescales the body to the mascot
        // height — 1.3 m — and re-grounds it). Applied to a forged body it
        // shrank a grown man to 1.24 m beside 1.84 m monsters.
        const customBody = this.hasCustomCharacterUrl() && this.isRenderingSkinnedMesh();
        if (this.engine.applyCharacterModifications) {
            if (customBody) {
                console.log('PlayerLoader: custom character body — template character modifications skipped');
            } else if (!skipTemplateHook) {
                console.log('PlayerLoader: Applying template-specific character modifications');
                this.engine.applyCharacterModifications(player, playerController, this, this.blockCharacterRenderer!);
            }
        }

        // Notify PlayerController that character is fully loaded and ready for attachments
        if (playerController && playerController.fireCharacterReady) {
            console.log('PlayerLoader: Character is now ready for attachments');
            playerController.fireCharacterReady();
        }
    }

    /**
     * Update block character renderer (call this every frame to sync with skeleton)
     * Overrides base class - computes position internally from playerGroup.
     */
    updateBlockCharacter(): void {
        if (!this.playerGroup) return;

        const playerGroupPos = new THREE.Vector3();
        this.playerGroup.getWorldPosition(playerGroupPos);

        // Skinned mode drives the real glTF skeleton; block mode positions blocks.
        // Both consume the same per-frame Mixamo blend (see computeBlendedPose).
        if (this.renderSkinned) {
            super.updateSkinnedCharacter(playerGroupPos);
            this.neutralizeBloomTint();
        } else {
            super.updateBlockCharacter(playerGroupPos);
        }

        // Run any callbacks that need fresh body-part world transforms
        // (e.g. weapon-orientation stabilization that has to read the bone-driven
        // body-part group's world rotation after it has been written this frame).
        for (const cb of this.postBlockUpdateCallbacks) {
            cb();
        }
    }

    /**
     * Register a callback fired at the end of every updateBlockCharacter() pass,
     * after body-part groups have been positioned for the frame. Returns an
     * unregister function.
     */
    onAfterBlockCharacterUpdate(callback: () => void): () => void {
        this.postBlockUpdateCallbacks.push(callback);
        return () => {
            const idx = this.postBlockUpdateCallbacks.indexOf(callback);
            if (idx >= 0) this.postBlockUpdateCallbacks.splice(idx, 1);
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // Block Character Variant System
    // ════════════════════════════════════════════════════════════════════════
    //
    // A variant is a LOOK, not a body: the same renderer, the same skeleton
    // binding and the same pose, with a different set of meshes inside the body
    // part groups. See game/agent-docs/character-outfits.md.

    /**
     * Load an additional block character variant that can be swapped to later.
     * The original block character is variant index 0.
     *
     * @param variantIndex - Unique index for this variant (1, 2, 3, etc.)
     * @param factory - Block character factory to create the variant
     * @returns true if variant was loaded successfully
     */
    loadBlockCharacterVariant(variantIndex: number, factory: IBlockCharacterFactory): boolean {
        if (!this.playerGroup) {
            console.warn('[PlayerLoader] Cannot load variant - player not loaded yet');
            return false;
        }
        return this.wardrobe.load(variantIndex, factory);
    }

    /**
     * Switch to a different block character variant.
     *
     * @param variantIndex - Index of the variant to switch to (0 = original)
     * @returns true if switch was successful
     */
    setActiveBlockCharacterVariant(variantIndex: number): boolean {
        return this.wardrobe.activate(variantIndex);
    }

    /**
     * Rebuild the player's block meshes from a new factory, keeping the skeleton
     * binding, the current pose and everything attached to a body part (a held
     * weapon, a hat). This is the one-call change of clothes; the indexed
     * variant methods above are for looks you pre-build and swap between
     * repeatedly.
     *
     * @param factory - Block character factory describing the new look
     * @returns true if the character was redressed
     */
    redressBlockCharacter(factory: IBlockCharacterFactory): boolean {
        return this.wardrobe.redress(factory);
    }

    /**
     * Get the currently active variant index.
     * @returns The active variant index (0 = original)
     */
    getActiveBlockCharacterVariant(): number {
        return this.wardrobe.getActiveIndex();
    }

    /**
     * Check if a variant is loaded.
     * @param variantIndex - Index to check
     * @returns true if the variant exists
     */
    hasBlockCharacterVariant(variantIndex: number): boolean {
        return this.wardrobe.has(variantIndex);
    }

    dispose(): void {
        if (this.animationController) {
            this.animationController.dispose();
            this.animationController = null;
        }

        this.wardrobe.disposeAll();

        // Call base class dispose to clean up block character renderer
        super.dispose();
    }
}
