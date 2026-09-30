/**
 * AnimationPreview — runs an arbitrary Mixamo-style animation GLB on the
 * canonical voxel block character, in an isolated standalone scene.
 *
 * Reuses the engine's actual playback stack:
 *   - `MixamoAnimationPlayer`  — loads + drives the hidden source skeleton
 *   - `BlockCharacterRenderer` — reads bone world transforms, positions
 *                                block meshes provided by the voxel factory
 *   - `bitmagicCharacterFactory` — same procedural character used in-game
 *
 * Lives in `src/debug/` because ESLint forbids `src/engine/` and
 * `src/genres/` from importing from `src/debug/` — so this is the only
 * tier allowed to depend on both engine + genre code. Loaded by
 * `game/animation-preview.html` via the same importmap as `index.html`.
 *
 * This module deliberately does NOT touch any engine singletons, world
 * data, or physics — the preview window is fully isolated from the live
 * game iframe.
 */

import * as THREE from 'three';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { createGltfLoader, initGltfLoaderSupport } from 'engine/loaders/GltfLoaderSupport.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { BlockCharacterRenderer } from 'engine/BlockCharacterRenderer.js';
import { bitmagicCharacterFactory, BITMAGIC_CONFIG } from 'genres/voxel/BitmagicPlayerCharacter.js';
import { createWeaponMesh, type WeaponTypeId } from 'engine/WeaponRegistry.js';
import { FrameTimer } from 'engine/FrameTimer.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { authoredFootLift, buildRetargetDeltas, captureRigBindPose } from 'engine/loaders/SkinnedRigRetarget.js';

export interface AnimationPreviewOptions {
    /** URL of the animation GLB (must contain skeleton + animation clip). */
    animationUrl: string;
    /** Element the preview canvas will be mounted into. */
    container: HTMLElement;
    /** Final character height in meters. Defaults to the bitmagic voxel height. */
    characterHeight: number;
    /** Draw a ground grid under the character. Disable for thumbnail-sized previews. */
    showGrid: boolean;
    /** Start with the animation paused — character renders in bind pose. */
    paused: boolean;
    /** Put a weapon in the right hand, e.g. 'sword'. Omit for none. */
    weapon?: WeaponTypeId;
    /** 'side' views the character side-on — required to judge a weapon's arc. */
    view?: 'front' | 'side' | 'iso';
    /** Preview the clip on this skinned character instead of the block mascot. */
    characterUrl?: string;
}

export const DEFAULT_ANIMATION_PREVIEW_OPTIONS = {
    characterHeight: BITMAGIC_CONFIG.targetHeight,
    showGrid: true,
    paused: false,
} as const;

export interface AnimationPreviewHandle {
    setPaused(paused: boolean): void;
    setSpeed(timeScale: number): void;
    /**
     * Scrub to an exact point in the clip, 0–1, and pause there.
     *
     * Automated capture must use this rather than playing and screenshotting on
     * a timer: the preview loops, screenshot latency varies, and successive
     * wall-clock samples alias against the cycle. That aliasing made a correct
     * overhead sword chop appear never to raise the arms at all.
     */
    setPhase(phase: number): void;
    dispose(): void;
}

/**
 * Set `isBone = true` on every non-root, non-mesh descendant of `root`.
 * See the call site in `startAnimationPreview` for why.
 */
function promoteJointsToBones(root: THREE.Object3D): void {
    root.traverse((child) => {
        const joint = child as { isMesh?: boolean; isBone?: boolean };
        if (child === root || joint.isMesh || joint.isBone) return;
        joint.isBone = true;
    });
}

/**
 * Mount a one-shot animation preview into `container` and start animating.
 * Returns a handle for play/pause + cleanup. Throws if the GLB fails to
 * load or contains no usable animation clip.
 */
export async function startAnimationPreview(
    opts: AnimationPreviewOptions
): Promise<AnimationPreviewHandle> {
    const { animationUrl, container, characterHeight, showGrid, paused: startPaused } = opts;

    // --- Scene / renderer / camera ----------------------------------------

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    // `three` resolves to the webgpu build, which has no WebGLRenderer — so the
    // classic renderer comes from its own module, exactly as GameEngine does it.
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Teach the shared GLTF loader what this device can decompress, BEFORE anything is
    // loaded. Nothing else does it here: this module never boots GameEngine, which is where
    // the engine normally makes that call, so every loader `createGltfLoader` handed out sat
    // in the awaiting-KTX2 queue forever. That was invisible while the preview only ever
    // showed clips and the block mascot — both plain — and became
    // `setKTX2Loader must be called before loading KTX2 textures` the moment `characterUrl`
    // pointed at a catalogue body, an asset class that is REQUIRED to carry KTX2. Three reads
    // the KTX2 loader when it PARSES a file, so the call has to come before the load, not
    // merely before the first frame.
    initGltfLoaderSupport(renderer);

    const camera = new THREE.PerspectiveCamera(
        40,
        container.clientWidth / Math.max(container.clientHeight, 1),
        0.05,
        200,
    );
    // A front-on camera cannot show a sword arc: a blade pointing forward
    // foreshortens into what looks like a downward bar, which is exactly how a
    // correct forward strike gets misread as the sword hanging down. `view=side`
    // puts the camera on the character's right so the whole sagittal arc reads.
    if (opts.view === 'side') {
        camera.position.set(characterHeight * 2.4, characterHeight * 0.8, 0);
    } else if (opts.view === 'iso') {
        // Elevated three-quarter view: the honest angle for FLOOR postures.
        // Front and side both sit at hip height, which looks DOWN a lying or
        // crawling body and foreshortens it into an unreadable blob.
        camera.position.set(characterHeight * 1.9, characterHeight * 1.5, characterHeight * 1.9);
    } else {
        camera.position.set(0, characterHeight * 0.8, characterHeight * 2.4);
    }
    if (opts.weapon) camera.position.multiplyScalar(1.35);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xb0c0ff, 0.3);
    fillLight.position.set(-3, 2, -2);
    scene.add(fillLight);

    // Ground grid — placed below the character so the camera frames nicely.
    if (showGrid) {
        const grid = new THREE.GridHelper(6, 12, 0x4a4a6a, 0x33334a);
        scene.add(grid);
    }

    // OrbitControls — user can spin / zoom.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, characterHeight * (opts.weapon ? 0.7 : 0.5), 0);
    controls.enableDamping = true;

    // --- Engine playback stack -------------------------------------------

    // A zero-position anchor that MixamoAnimationPlayer copies the skeleton
    // root onto each frame. We never move it — the character renders at
    // world origin, modulo the player's internal hips-pivot offset.
    const playerPositionRef = new THREE.Object3D();
    playerPositionRef.name = 'AnimationPreviewAnchor';
    scene.add(playerPositionRef);

    const player = new MixamoAnimationPlayer();
    const loaded = await player.load(
        animationUrl,
        createGltfLoader(),
        scene,
        playerPositionRef,
        characterHeight,
        { retainFullSkeleton: !!opts.characterUrl },
    );
    if (!loaded) throw new Error(`Failed to load animation GLB: ${animationUrl}`);

    // Locomotion mode keeps weight pinned at 1.0 (no blend-in fade from the
    // standard-skeleton bind pose) and filters root motion so the character
    // stays centred. Perfect for an in-place preview regardless of whether
    // the source clip is a walk cycle or a one-shot attack.
    player.setLocomotionMode(true);
    player.setLoop(true);

    const skeleton = player.getSkeletonRoot();
    if (!skeleton) throw new Error('MixamoAnimationPlayer did not expose a skeleton root');

    // Promote skeleton joints to "bones" so BlockCharacterRenderer can find them.
    //
    // GLTFLoader only promotes a node to `THREE.Bone` when it's referenced as
    // a joint by a `SkinnedMesh`. Uthana-generated animation GLBs ship the
    // armature without a SkinnedMesh (the engine uses them as pure animation
    // sources), so every joint comes through as plain `THREE.Object3D` with
    // `isBone === undefined`.
    //
    // `BlockCharacterRenderer.findBonesInSkeleton` does a strict
    // `(child as any).isBone` check, so without this patch every body part
    // logs "No bones found" and the renderer leaves the block meshes
    // clumped at world origin. AnimationMixer is unaffected — it binds
    // tracks by node name regardless of `isBone`. So we flip the flag
    // ourselves on every non-mesh descendant.
    promoteJointsToBones(skeleton);

    const blockRenderer = BlockCharacterRenderer.create(skeleton, bitmagicCharacterFactory);
    scene.add(blockRenderer.getRoot());

    // The asset preview must expose the wrists, ankles and skin deformation that
    // a block body hides. Use the runtime's rotation retargeter on the real rig.
    let skinnedRoot: THREE.Group | null = null;
    let updateBody = () => blockRenderer.update();
    if (opts.characterUrl) {
        // The factory, not a bare loader: a catalogue character carries KTX2 textures and a
        // bare GLTFLoader cannot read them (see engine/loaders/GltfLoaderSupport.ts).
        const root = (await createGltfLoader().loadAsync(opts.characterUrl)).scene;
        root.updateMatrixWorld(true);
        const height = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
        if (!(height > 0)) throw new Error('Preview character has no measurable height');
        root.scale.multiplyScalar(characterHeight / height);
        scene.add(root);
        skinnedRoot = root;
        blockRenderer.getRoot().visible = false;
        const bones: THREE.Bone[] = [];
        root.traverse(o => {
            if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
            if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
        });
        const sources = player.getBoneMap();
        const bind = captureRigBindPose(root);
        const deltas = bind ? buildRetargetDeltas(bind.rotations, new Map(player.getRestRotations()),
            name => CharacterLoader.resolveMixamoBone(name, sources)?.name ?? null) : null;
        const pose = new Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>();
        const feet = bones.filter(b => CharacterLoader.FOOT_BONE_NAMES.includes(b.name));
        const hips = bones.find(b => /hips|pelvis/i.test(b.name));
        const bindHips = hips?.position.clone();
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        updateBody = () => {
            for (const bone of bones) {
                const source = CharacterLoader.resolveMixamoBone(bone.name, sources);
                if (!source) continue;
                let entry = pose.get(bone.name);
                if (!entry) {
                    entry = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
                    pose.set(bone.name, entry);
                }
                source.getWorldPosition(entry.position);
                source.getWorldQuaternion(entry.rotation);
            }
            CharacterLoader.applyPoseRotations(root, pose, deltas);
            const rest = player.getRestHipsOffset();
            const hp = hips && pose.get(hips.name);
            if (hips?.parent && bindHips && rest && hp) {
                p.copy(hp.position).sub(rest).setY(0);
                hips.parent.getWorldQuaternion(q).invert();
                hips.parent.getWorldScale(scale);
                hips.position.copy(bindHips).add(p.applyQuaternion(q).divide(scale));
            }
            root.updateMatrixWorld(true);
            let lowest = Infinity;
            for (const foot of feet) lowest = Math.min(lowest, foot.getWorldPosition(p).y);
            if (Number.isFinite(lowest)) root.position.y += authoredFootLift(player.getAuthoredFootLift()) - lowest;
            root.updateMatrixWorld(true);
        };
    }

    // Expose the scene for headless measurement.
    //
    // Offline tools reason about the BONE, but a weapon is parented to the hand
    // BLOCK, and the two frames are not guaranteed to agree — which is how
    // "blade-check says 0°, the sword still lands flat" happened. Reading the
    // real weapon mesh's world transform out of the live scene is the only
    // ground truth that has no model of mine in the middle of it.
    (window as unknown as { __previewScene?: THREE.Scene }).__previewScene = scene;

    // Optionally put a real weapon in the character's hand.
    //
    // Without this the preview shows the arms but not what they are holding, and
    // a blade's angle is invisible — which is exactly how several rounds of
    // "the numbers say the blade points forward" survived while the sword on
    // screen was pivoting wildly. Uses the engine's own mesh and the same +90° X
    // attach correction as `PlayerController.attachToBodyPart`, so what shows
    // here is what a game shows.
    if (opts.weapon) {
        const { mesh } = createWeaponMesh(opts.weapon);
        const rig = skinnedRoot;
        let hand = blockRenderer.getBodyPart('rightHand');
        if (hand) {
            if (rig) {
                hand = BlockCharacterRenderer.boneNamesForPart('rightHand')
                    .map(name => rig.getObjectByName(name)).find(Boolean) ?? null;
                if (!hand) throw new Error('Preview character has no supported right-hand bone for its weapon');
            }
            hand.add(mesh);
            mesh.rotation.set(Math.PI / 2, 0, 0);
            // Bone parents carry the asset's import scale; attachment meshes
            // are in metres (PlayerController.attachToBodyPart does this too).
            const handScale = new THREE.Vector3();
            hand.getWorldScale(handScale);
            mesh.scale.divide(handScale);
        }
    }

    let paused = startPaused;
    if (!paused) player.play();

    // Always run the renderer once so the block character lands on the bind
    // pose even when we start paused — otherwise the body parts stay at
    // their factory-local origin and render as a clump at world centre.
    player.update(0);
    updateBody();

    // --- Frame loop -------------------------------------------------------

    const timer = new FrameTimer();
    let timeScale = 1;
    let disposed = false;
    let rafId = 0;

    const tick = (): void => {
        if (disposed) return;
        rafId = requestAnimationFrame(tick);
        const dt = timer.tick(performance.now());
        if (!paused) {
            player.update(dt * timeScale);
        }
        // Block renderer always reads current bone transforms — cheap when
        // the mixer is paused since the bones don't move.
        updateBody();
        controls.update();
        renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(tick);

    // Resize follows the container, not just the window — the iframe may
    // be resized by the parent.
    const resize = (): void => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    return {
        setPaused(p: boolean): void {
            if (p === paused) return;
            paused = p;
            // Drive the engine player's mixer too — without this, going from
            // paused→playing would skip the play() that flushes the first
            // frame, and going playing→paused would keep the mixer accruing
            // time even though tick() stopped feeding it.
            if (p) player.stop(); else player.play();
        },
        setSpeed(s: number): void { timeScale = s; },
        setPhase(phase: number): void {
            // See AnimationPreviewHandle.setPhase for why automated capture must
            // scrub rather than play-and-wait.
            const duration = player.getDuration();
            if (!duration) return;
            paused = true;
            player.play();
            player.setTime(duration * Math.min(1, Math.max(0, phase)));
            updateBody();
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            cancelAnimationFrame(rafId);
            ro.disconnect();
            renderer.dispose();
            renderer.domElement.remove();
        },
    };
}
