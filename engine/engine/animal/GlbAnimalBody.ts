/**
 * GlbAnimalBody — renders an animal as its voxelized skinned GLB and plays the
 * model's own (inbuilt) animation clips.
 *
 * This replaces the procedural "block overlay" body (BlockAnimalBodyBuilder +
 * BlockAnimalAnimationController). AnimalController keeps owning behaviour,
 * physics, avoidance and riding (the "brain"); this class is just the visible
 * body + locomotion animation, exposing the SAME narrow contract the brain used
 * to talk to the block animation controller:
 *
 *   updateAnimation(isMoving, speed, grounded, jump)  // choose idle/walk/run
 *   update(deltaTime)                                 // advance the mixer
 *   dispose()
 *
 * The voxel GLBs are produced by tools/voxelize-animals.js and live at
 * animalBaseUrl (the CDN in dev-cluster/prod, the local serve-voxel-animals
 * middleware on localhost). Bones + clips are preserved verbatim by the
 * voxelizer, so standard glTF GPU skinning animates the cubes.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { animationAssets } from 'engine/AnimationAssets.js';
import type { ResolvedVoxelAnimal } from 'engine/animal/VoxelAnimalRegistry.js';

/** Locomotion states this body can play. Source clips cover idle/walk/run. */
type AnimState = 'idle' | 'walk' | 'run';

/** Bind-pose bounds used for physics capsule / feet-offset sizing. */
type Dimensions = { width: number; height: number; depth: number };

// Voxel bodies always load from the CDN — land animals from voxelAnimalBaseUrl
// (worlds/v3/voxel_animals/), fish from voxelFishBaseUrl (worlds/v3/
// fishes_voxel_brotli/), in every environment including localhost. Objects are
// brotli-compressed + served with `Content-Encoding: br`, decompressed
// transparently by the browser (no loader brotli code). Each body is fetched
// lazily (only when spawned) and cached below, so a game only downloads the
// species it actually uses.
function cdnUrl(r: ResolvedVoxelAnimal): string {
    return `${r.isFish ? animationAssets.voxelFishBaseUrl : animationAssets.voxelAnimalBaseUrl}/${r.file}`;
}

// One shared loader + one in-flight/loaded GLTF per body. SkeletonUtils.clone()
// gives each animal its own skeleton instance while sharing geometry, so many
// animals of the same species cost one network load and one geometry upload.
const sharedLoader = createGltfLoader();
const gltfCache = new Map<string, Promise<GLTF>>();

function loadVoxelGltf(resolved: ResolvedVoxelAnimal): Promise<GLTF> {
    const key = `${resolved.isFish ? 'fish' : 'animal'}:${resolved.file}`;
    let pending = gltfCache.get(key);
    if (!pending) {
        const url = cdnUrl(resolved);
        pending = new Promise<GLTF>((resolve, reject) => sharedLoader.load(url, resolve, undefined, reject));
        gltfCache.set(key, pending);
    }
    return pending;
}

/**
 * Map a raw clip name to a locomotion state. Clip names look like
 * "Chicken_001_idle", "Tiger_001_idle_rare", "Horse_001_eat". We only need
 * idle/walk/run for locomotion; everything else is ignored here.
 */
function clipNameToState(rawName: string): AnimState | null {
    const lower = rawName.toLowerCase();
    const action = lower.match(/_001_(.+)$/)?.[1] ?? lower;
    if (action.includes('walk')) return 'walk';
    if (action.includes('run')) return 'run';
    if (action.includes('idle')) return 'idle'; // also catches idle_rare → idle
    return null;
}

export class GlbAnimalBody {
    private readonly root: THREE.Group;
    private readonly mixer: THREE.AnimationMixer;
    private readonly actions: Map<AnimState, THREE.AnimationAction>;
    private readonly dimensions: Dimensions;
    private current: AnimState | null = null;

    private constructor(
        root: THREE.Group,
        mixer: THREE.AnimationMixer,
        actions: Map<AnimState, THREE.AnimationAction>,
        dimensions: Dimensions
    ) {
        this.root = root;
        this.mixer = mixer;
        this.actions = actions;
        this.dimensions = dimensions;
    }

    /**
     * Load + instantiate a voxel body for an already-resolved animal/fish (from
     * resolveVoxelAnimal). The caller falls back to the block system when
     * resolution returns null, so this never needs a null path.
     */
    static async load(resolved: ResolvedVoxelAnimal, scale = 1.0): Promise<GlbAnimalBody> {
        const gltf = await loadVoxelGltf(resolved);

        // Per-instance clone: own skeleton, shared geometry (flagged so
        // AnimalController.dispose() never disposes geometry still in use).
        const scene = cloneSkinnedScene(gltf.scene);
        scene.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (mesh.isMesh) {
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                mesh.userData.sharedGlbGeometry = true;
            }
        });

        const root = new THREE.Group();
        root.name = `GlbAnimalBody_${resolved.file.replace(/\.glb$/i, '')}`;
        root.add(scene);
        root.scale.setScalar(scale);

        // Mixer + one action per available locomotion state. The source GLBs all
        // ship idle/walk/run (some add eat/idle_rare, which we don't drive here).
        const mixer = new THREE.AnimationMixer(scene);
        const actions = new Map<AnimState, THREE.AnimationAction>();
        for (const clip of gltf.animations) {
            const state = clipNameToState(clip.name);
            if (state && !actions.has(state)) {
                actions.set(state, mixer.clipAction(clip));
            }
        }
        // Fallbacks so a missing clip never leaves a state silent. If the GLB has
        // no recognised locomotion clip, fall back to its first clip (if any).
        const firstClip = gltf.animations[0];
        const idle = actions.get('idle')
            ?? actions.get('walk')
            ?? (firstClip ? mixer.clipAction(firstClip) : undefined);
        if (idle) {
            if (!actions.has('idle')) actions.set('idle', idle);
            if (!actions.has('walk')) actions.set('walk', actions.get('run') ?? idle);
            if (!actions.has('run')) actions.set('run', actions.get('walk') ?? idle);
        }

        // Measure bind-pose bounds for physics capsule / feet offset sizing.
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const dimensions: Dimensions = {
            width: Math.max(size.x, 0.1),
            height: Math.max(size.y, 0.1),
            depth: Math.max(size.z, 0.1),
        };

        const body = new GlbAnimalBody(root, mixer, actions, dimensions);
        body.setState('idle', 0); // start idling so the first frame isn't a T-pose
        body.update(1e-6); // flush the mixer so bones pose to idle before first draw
        return body;
    }

    /** The Object3D to add to the animal's character group. */
    getObject3D(): THREE.Object3D {
        return this.root;
    }

    /** Visual bounds (after scale) for physics capsule / feet-offset sizing. */
    getDimensions(): Dimensions {
        return this.dimensions;
    }

    /** Current locomotion state name (compat with block controller callers). */
    getCurrentState(): string {
        return this.current ?? 'idle';
    }

    /**
     * Choose the locomotion clip from movement — mirrors the speed thresholds the
     * old BlockAnimalAnimationController used (idle <0.1, walk <3.0, else run).
     */
    updateAnimation(isMoving: boolean, movementSpeed: number, _isGrounded: boolean, _isJumpPressed: boolean): void {
        let next: AnimState;
        if (!isMoving || movementSpeed < 0.1) next = 'idle';
        else if (movementSpeed < 3.0) next = 'walk';
        else next = 'run';
        this.setState(next, 0.2);
    }

    /** Advance the animation mixer. Call every frame. */
    update(deltaTime: number): void {
        this.mixer.update(deltaTime);
    }

    private setState(state: AnimState, fade: number): void {
        if (this.current === state) return;
        const next = this.actions.get(state);
        if (!next) return;
        const prev = this.current ? this.actions.get(this.current) : null;
        if (prev && prev !== next) prev.fadeOut(fade);
        next.reset().setEffectiveWeight(1).fadeIn(fade).play();
        this.current = state;
    }

    /** Stop the mixer and release its binding. Geometry/materials are handled by
     * AnimalController.dispose() (geometry is shared and must not be disposed). */
    dispose(): void {
        this.mixer.stopAllAction();
        this.mixer.uncacheRoot(this.root);
        if (this.root.parent) this.root.parent.remove(this.root);
    }
}
