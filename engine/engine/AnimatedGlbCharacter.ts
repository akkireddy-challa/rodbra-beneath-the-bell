import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { findRootMotionBone } from 'engine/AnimationClipUtils.js';
import { rootMotionWorldTravelXZ } from 'engine/animation/RootMotion.js';

/**
 * Stand-alone, self-animating skinned-GLB character.
 *
 * Unlike the player/NPC pipeline (which is Mixamo-only and discards a custom
 * GLB's own clips — see `game/CLAUDE.md` → "Character animation"), this class
 * loads an arbitrary rigged GLB and plays *its own* embedded animation clips by
 * name, driven by its own {@link THREE.AnimationMixer}. It has no locomotion,
 * no physics, and no coupling to `CharacterAnimationController`.
 *
 * Intended use: experimental / dev — e.g. a soccer goalie that only plays
 * `idle`, `dive_left`, `dive_right`, `victory`. By default it mounts itself
 * into `engine.scene` and ticks from its own requestAnimationFrame loop, so it
 * needs no wiring into any per-frame update path. Set `autoTick: false` to
 * drive {@link update} yourself from a game loop instead.
 */
export interface AnimatedGlbCharacterOptions {
    /** URL of the rigged/skinned GLB to load. */
    url: string;
    /** World-space spawn position. Copied internally; never mutated. */
    position: { x: number; y: number; z: number };
    /** Yaw in radians (gameplay +Z-forward convention). */
    rotationY: number;
    /**
     * Uniformly scale the model so its bounding-box height matches this value
     * in metres. `null` keeps the GLB's authored scale.
     */
    targetHeight: number | null;
    /** Clip name to play on load. `null` → falls back to `idleClipName`, then the first clip. */
    autoPlayClip: string | null;
    /** Looping clip to ease back to after a one-shot (`loop: false`) clip finishes. `null` disables auto-return. */
    idleClipName: string | null;
    /** Whether character meshes cast shadows. */
    castShadow: boolean;
    /** Whether character meshes receive shadows. */
    receiveShadow: boolean;
    /** Drive the mixer from an internal requestAnimationFrame loop. Set `false` to call {@link update} yourself. */
    autoTick: boolean;
    /**
     * Commit the active clip's authored root translation (root/hips bone XZ) to
     * this character's own group each frame instead of playing in place. Read the
     * resulting world position via {@link AnimatedGlbCharacter.getPosition}. The
     * visible mesh is locked to its rest XZ so the body advances exactly once
     * (no double-move, no end-of-clip snap-back).
     */
    rootMotion: boolean;
    /**
     * Also commit the root bone's authored yaw (Y-twist) to the group rotation.
     * Only meaningful when {@link rootMotion} is true. Suited to clips that turn
     * the character; leave OFF for pose-tilt clips (e.g. a sideways dive), where
     * the hips rotation is part of the pose, not a change of facing.
     */
    rootMotionYaw: boolean;
    /**
     * How committed root motion affects position:
     * - `'commit'` (default): root motion permanently advances the character's group
     *   and {@link AnimatedGlbCharacter.getPosition} tracks it — for a character that
     *   travels.
     * - `'hold'`: the group (the logical position / anchor) stays where you place it,
     *   and root motion moves the body via an inner offset node so the FEET PLANT.
     *   The offset is transient: call {@link AnimatedGlbCharacter.recenter} on a
     *   stance change (e.g. a lean) to ease it back to zero. For a character that must
     *   hold its spot but whose clips carry root motion (e.g. a goalie).
     */
    rootMotionMode: 'commit' | 'hold';
}

export const DEFAULT_ANIMATED_GLB_CHARACTER_OPTIONS: AnimatedGlbCharacterOptions = {
    url: '',
    position: { x: 0, y: 0, z: 0 },
    rotationY: 0,
    targetHeight: null,
    autoPlayClip: null,
    idleClipName: null,
    castShadow: true,
    receiveShadow: true,
    autoTick: true,
    rootMotion: false,
    rootMotionYaw: false,
    rootMotionMode: 'commit',
};

export interface PlayClipOptions {
    /** Loop forever (`true`) or play exactly once and hold the last frame (`false`). */
    loop: boolean;
    /** Crossfade duration in seconds from the currently-playing clip. `0` snaps. */
    crossfadeDuration: number;
    /** Playback speed multiplier. */
    timeScale: number;
    /**
     * Override root-motion translation for THIS clip. Absent → inherit the
     * constructor's `rootMotion`. Set `false` on in-place clips (idle, a victory
     * pose) so their hips aren't locked, and `true` on travelling clips (a dive).
     */
    rootMotion?: boolean;
    /** Override root-motion yaw for THIS clip. Absent → inherit the constructor's `rootMotionYaw`. */
    rootMotionYaw?: boolean;
}

export const DEFAULT_PLAY_CLIP_OPTIONS: PlayClipOptions = {
    loop: true,
    crossfadeDuration: 0.25,
    timeScale: 1,
};

/**
 * Swing-twist: write the twist component of `q` about the world Y axis into
 * `out` (a unit quaternion representing rotation about Y only). Degenerate near
 * a 180° rotation about a horizontal axis (|y|,|w| → 0), where it returns identity.
 */
function yTwistInto(q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
    const len = Math.hypot(q.y, q.w);
    if (len < 1e-8) {
        return out.identity();
    }
    return out.set(0, q.y / len, 0, q.w / len);
}

/** Minimal shape of a parsed GLTF we rely on (engine.loader is typed `any`). */
interface LoadedGltf {
    scene: THREE.Group;
    animations: THREE.AnimationClip[];
}

export class AnimatedGlbCharacter {
    private readonly engine: EngineLike;
    private readonly options: AnimatedGlbCharacterOptions;
    private readonly root: THREE.Group;
    private readonly ready: Promise<void>;

    private mixer: THREE.AnimationMixer | null = null;
    private readonly clips = new Map<string, THREE.AnimationClip>();
    private clipNames: string[] = [];
    private currentAction: THREE.AnimationAction | null = null;
    private currentClipName: string | null = null;

    private rafId: number | null = null;
    private lastTickMs = 0;
    private disposed = false;

    // Root-motion state — active only when options.rootMotion. The root bone
    // (hips/pelvis/root) carries the clip's authored travel/turn; each frame we
    // move/turn `root` by the delta and lock the bone back so the visible mesh
    // advances exactly once.
    private rootBone: THREE.Object3D | null = null;
    private currentClipRootMotion = false;
    private currentClipRootMotionYaw = false;
    private rmWarnedNoBone = false;
    private rmNeedsBaseline = true;
    private readonly rmRestLocalPos = new THREE.Vector3();
    private readonly rmRestTwist = new THREE.Quaternion();
    private readonly rmPrevCumulative = new THREE.Vector3();
    private rmPrevYaw = 0;
    private readonly _rmHipsWorld = new THREE.Vector3();
    private readonly _rmTravel = new THREE.Vector3();
    private readonly _rmTwist = new THREE.Quaternion();
    private readonly _rmTwistDelta = new THREE.Quaternion();
    private readonly _rmDelta = new THREE.Vector3();
    private readonly _rmInvQuat = new THREE.Quaternion();
    // HOLD-mode offset node (between `root` and the model): root motion accumulates
    // here (so the feet plant) while `root` stays the game-owned anchor; recenter()
    // eases it back to zero on a stance change.
    private readonly _motionNode = new THREE.Group();
    private _recenterTimer = 0;

    constructor(engine: EngineLike, options: AnimatedGlbCharacterOptions) {
        this.engine = engine;
        this.options = options;

        this.root = new THREE.Group();
        this.root.name = `AnimatedGlbCharacter(${options.url})`;
        this.root.position.set(options.position.x, options.position.y, options.position.z);
        this.root.rotation.y = options.rotationY;
        this.engine.scene?.add(this.root);
        this.root.add(this._motionNode);

        this.ready = this.load();
    }

    /** Resolves once the GLB has loaded and the initial clip is playing (rejects on load failure). */
    whenReady(): Promise<void> {
        return this.ready;
    }

    private async load(): Promise<void> {
        let gltf: LoadedGltf;
        try {
            gltf = (await this.engine.loader.loadAsync(this.options.url)) as LoadedGltf;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error(`[AnimatedGlbCharacter] failed to load ${this.options.url}:`, error);
            throw error;
        }

        // Disposed while the GLB was in flight — drop the parsed scene and stop.
        if (this.disposed) {
            this.disposeObjectTree(gltf.scene);
            return;
        }

        const scene = gltf.scene;
        scene.traverse((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh) {
                mesh.castShadow = this.options.castShadow;
                mesh.receiveShadow = this.options.receiveShadow;
                // NOTE: meshes are intentionally left on the default render layer (0).
                // The dead `GlbNPC` reference set layer 1 — the bloom-only layer the main
                // camera does not render directly — which would make the character invisible.
            }
        });

        this.applyTargetHeight(scene);
        this._motionNode.add(scene);

        const clips: THREE.AnimationClip[] = gltf.animations ?? [];
        this.mixer = new THREE.AnimationMixer(scene);
        this.mixer.addEventListener('finished', this.handleFinished);
        for (const clip of clips) {
            this.clips.set(clip.name, clip);
        }
        this.clipNames = clips.map((c) => c.name);

        // Always locate the root bone so root motion can be toggled per clip.
        this.rootBone = findRootMotionBone(scene);

        const initial = this.options.autoPlayClip ?? this.options.idleClipName ?? this.clipNames[0] ?? null;
        if (initial) {
            this.play(initial, {});
        }

        if (this.options.autoTick) {
            this.startAutoTick();
        }
    }

    private applyTargetHeight(scene: THREE.Object3D): void {
        const box = new THREE.Box3().setFromObject(scene);
        const size = new THREE.Vector3();
        box.getSize(size);
        if (this.options.targetHeight !== null && size.y > 1e-4) {
            scene.scale.setScalar(this.options.targetHeight / size.y);
        }
        // Surface the native height so callers can pick a sensible targetHeight.
        console.info(`[AnimatedGlbCharacter] ${this.options.url} native height ≈ ${size.y.toFixed(3)}m`);
    }

    /**
     * Play a clip by name, crossfading from whatever is currently playing.
     * Returns `false` (and logs the available clip names) if no such clip exists.
     */
    play(name: string, opts: Partial<PlayClipOptions>): boolean {
        if (!this.mixer) {
            console.warn(`[AnimatedGlbCharacter] play("${name}") before load finished; ignored.`);
            return false;
        }
        const clip = this.clips.get(name);
        if (!clip) {
            console.warn(
                `[AnimatedGlbCharacter] no clip "${name}". Available: ${this.clipNames.join(', ') || '(none)'}`,
            );
            return false;
        }

        const o = { ...DEFAULT_PLAY_CLIP_OPTIONS, ...opts };
        const action = this.mixer.clipAction(clip);
        action.setLoop(o.loop ? THREE.LoopRepeat : THREE.LoopOnce, o.loop ? Infinity : 1);
        action.clampWhenFinished = !o.loop;
        action.setEffectiveTimeScale(o.timeScale);
        action.setEffectiveWeight(1);
        action.enabled = true;
        action.reset();

        const previous = this.currentAction;
        action.play();
        if (previous && previous !== action) {
            if (o.crossfadeDuration > 0) {
                previous.crossFadeTo(action, o.crossfadeDuration, false);
            } else {
                previous.stop();
            }
        }

        this.currentAction = action;
        this.currentClipName = name;

        // Resolve root motion for THIS clip (per-clip override → constructor default).
        const wantRootMotion = o.rootMotion ?? this.options.rootMotion;
        if (wantRootMotion && !this.rootBone && !this.rmWarnedNoBone) {
            this.rmWarnedNoBone = true;
            console.warn(`[AnimatedGlbCharacter] root motion requested but no root bone in ${this.options.url}.`);
        }
        this.currentClipRootMotion = wantRootMotion && this.rootBone !== null;
        this.currentClipRootMotionYaw = o.rootMotionYaw ?? this.options.rootMotionYaw;
        // Re-measure root motion from this clip's first frame.
        this.rmNeedsBaseline = true;
        return true;
    }

    /**
     * Advance the animation by `deltaTime` seconds, committing root motion if
     * enabled. Only call this when constructed with `autoTick: false`.
     */
    update(deltaTime: number): void {
        this.mixer?.update(deltaTime);
        if (this.rootBone && this.currentClipRootMotion) {
            this.applyRootMotion(deltaTime);
        }
    }

    /**
     * Apply the active clip's authored root motion. Two modes (see `rootMotionMode`):
     * COMMIT permanently advances the character's group (it travels); HOLD feeds it
     * into an inner offset node so the body moves (feet plant) while the group
     * (anchor) stays put for the game, and {@link recenter} eases that offset away.
     * Either way the visible bone is locked to rest each frame so the body moves
     * exactly once — no double-move, no end-of-clip snap-back. Mirrors the engine's
     * player root-motion commit (see engine/animation/RootMotion.ts).
     */
    private applyRootMotion(deltaTime: number): void {
        const bone = this.rootBone;
        if (!bone) {
            return;
        }
        // getWorldPosition refreshes this bone's + ancestors' world matrices,
        // which the travel helper reads via parent.matrixWorld.
        bone.getWorldPosition(this._rmHipsWorld);

        if (this.rmNeedsBaseline) {
            this.rmRestLocalPos.copy(bone.position);
            yTwistInto(bone.quaternion, this.rmRestTwist);
            this.rmPrevCumulative.set(0, 0, 0);
            this.rmPrevYaw = 0;
            this.rmNeedsBaseline = false;
            return;
        }

        // Per-frame authored travel in world axes (facing-rotated; scale + this.root
        // + offset-node positions all cancel in the helper, so this is pure clip motion).
        const parent = bone.parent ?? bone;
        rootMotionWorldTravelXZ(parent, this._rmHipsWorld, this.rmRestLocalPos, this._rmTravel);
        const dWorldX = this._rmTravel.x - this.rmPrevCumulative.x;
        const dWorldZ = this._rmTravel.z - this.rmPrevCumulative.z;
        this.rmPrevCumulative.copy(this._rmTravel);

        // Per-frame authored yaw (Y-twist) delta, if requested.
        let yawDelta = 0;
        if (this.currentClipRootMotionYaw) {
            yTwistInto(bone.quaternion, this._rmTwist);
            // twistDelta = restTwist⁻¹ · curTwist (the authored Y-rotation since rest)
            this._rmTwistDelta.copy(this.rmRestTwist).invert().multiply(this._rmTwist);
            const cumulativeYaw = 2 * Math.atan2(this._rmTwistDelta.y, this._rmTwistDelta.w);
            yawDelta = cumulativeYaw - this.rmPrevYaw;
            if (yawDelta > Math.PI) yawDelta -= 2 * Math.PI;
            else if (yawDelta < -Math.PI) yawDelta += 2 * Math.PI;
            this.rmPrevYaw = cumulativeYaw;
            // Strip the authored Y-twist from the visible bone (keep pose swing).
            bone.quaternion.multiply(this._rmTwistDelta.invert());
        }

        // Lock the visible bone back to rest XZ (keep Y so vertical bob survives) —
        // its travel now lives on `root` (commit) or the offset node (hold).
        bone.position.x = this.rmRestLocalPos.x;
        bone.position.z = this.rmRestLocalPos.z;

        if (this.options.rootMotionMode === 'hold') {
            // HOLD: accumulate the authored travel on the offset node (the body moves,
            // so the feet plant) and leave the anchor group (`root`) to the game.
            // Convert the world delta into the anchor's local frame first.
            this._rmDelta
                .set(dWorldX, 0, dWorldZ)
                .applyQuaternion(this._rmInvQuat.copy(this.root.quaternion).invert());
            this._motionNode.position.x += this._rmDelta.x;
            this._motionNode.position.z += this._rmDelta.z;
            this._motionNode.rotation.y += yawDelta;
            // Transient recenter: ease the whole offset to zero over the requested
            // window (started by recenter(), e.g. on a lean). Otherwise it just holds.
            if (this._recenterTimer > 0) {
                const dt = Math.min(deltaTime, this._recenterTimer);
                const k = dt / this._recenterTimer;
                this._motionNode.position.multiplyScalar(1 - k);
                this._motionNode.rotation.y *= 1 - k;
                this._recenterTimer -= dt;
                if (this._recenterTimer <= 1e-4) {
                    this._recenterTimer = 0;
                    this._motionNode.position.set(0, 0, 0);
                    this._motionNode.rotation.y = 0;
                }
            }
        } else {
            // COMMIT: permanently advance the anchor group (the character travels).
            this.root.position.x += dWorldX;
            this.root.position.z += dWorldZ;
            this.root.rotation.y += yawDelta;
        }
    }

    /**
     * Current world position of the character's anchor group. In COMMIT mode it
     * advances as root motion travels; in HOLD mode it stays put (the transient
     * root-motion offset lives on an inner node and is not included here).
     */
    getPosition(): THREE.Vector3 {
        return this.root.position.clone();
    }

    /** Current world yaw in radians (advances as rootMotionYaw commits turning). */
    getRotationY(): number {
        return this.root.rotation.y;
    }

    /**
     * (HOLD mode) Ease the accumulated root-motion offset back to zero over
     * `durationSeconds`, returning the body smoothly to its anchor. Call on a
     * stance change — e.g. when the character leans — typically alongside replaying
     * the idle from its first frame. No effect in COMMIT mode.
     */
    recenter(durationSeconds: number): void {
        this._recenterTimer = Math.max(0, durationSeconds);
    }

    setPosition(x: number, y: number, z: number): void {
        this.root.position.set(x, y, z);
    }

    setRotationY(yaw: number): void {
        this.root.rotation.y = yaw;
    }

    /** The root group containing the GLB scene. */
    getObject(): THREE.Object3D {
        return this.root;
    }

    /** Names of every available clip (embedded in the character GLB plus any added via {@link loadAnimation}). */
    getClipNames(): string[] {
        return [...this.clipNames];
    }

    /**
     * Load a separate animation-only GLB (e.g. an idle / dive / victory clip
     * exported without a mesh) and register its clip(s) so they can be played by
     * name on THIS character's skeleton.
     *
     * The animation GLB must use the same bone names as the character (e.g. both
     * Mixamo `mixorig:*`): a {@link THREE.AnimationMixer} binds clip tracks to
     * bones by name, so no retargeting is performed — tracks that don't match a
     * character bone are silently ignored by Three.js.
     *
     * @param url  URL of the animation GLB (may be mesh-less).
     * @param name Name to register the first clip under for {@link play}. Most
     *   single-clip exports are unnamed, so pass one. Additional clips keep their
     *   own names. Re-registering an existing name overwrites it.
     * @returns the names the clip(s) were registered under (empty on failure).
     */
    async loadAnimation(url: string, name?: string): Promise<string[]> {
        // Wait for the character GLB + mixer; tolerate a character load failure.
        await this.ready.catch(() => { /* already logged in load() */ });
        if (this.disposed || !this.mixer) {
            console.warn(`[AnimatedGlbCharacter] loadAnimation("${url}") skipped: character not loaded.`);
            return [];
        }

        let gltf: LoadedGltf;
        try {
            gltf = (await this.engine.loader.loadAsync(url)) as LoadedGltf;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error(`[AnimatedGlbCharacter] failed to load animation ${url}:`, error);
            throw error;
        }
        if (this.disposed) {
            return [];
        }

        const loaded: THREE.AnimationClip[] = gltf.animations ?? [];
        if (loaded.length === 0) {
            console.warn(`[AnimatedGlbCharacter] animation GLB has no clips: ${url}`);
            return [];
        }

        const registered: string[] = [];
        loaded.forEach((clip, i) => {
            const key = i === 0 && name ? name : clip.name || `${name ?? 'clip'}_${i}`;
            this.clips.set(key, clip);
            if (!this.clipNames.includes(key)) {
                this.clipNames.push(key);
            }
            registered.push(key);
        });
        return registered;
    }

    /** Name of the clip currently playing, or `null` before load / if none. */
    getCurrentClip(): string | null {
        return this.currentClipName;
    }

    /** Duration in seconds of a registered clip (embedded or loaded), or `0` if there's no such clip. */
    getClipDuration(name: string): number {
        return this.clips.get(name)?.duration ?? 0;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.mixer) {
            this.mixer.removeEventListener('finished', this.handleFinished);
            this.mixer.stopAllAction();
            this.mixer.uncacheRoot(this.root);
            this.mixer = null;
        }
        if (this.root.parent) {
            this.root.parent.remove(this.root);
        }
        this.disposeObjectTree(this.root);
        this.clips.clear();
        this.clipNames = [];
        this.currentAction = null;
        this.currentClipName = null;
    }

    private startAutoTick(): void {
        this.lastTickMs = performance.now();
        const tick = (): void => {
            if (this.disposed) {
                return;
            }
            const now = performance.now();
            // Clamp to avoid a huge jump after a tab was backgrounded.
            const dt = Math.min(0.1, (now - this.lastTickMs) / 1000);
            this.lastTickMs = now;
            this.update(dt);
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    /** When a one-shot clip ends, ease back to the configured idle clip. */
    private readonly handleFinished = (event: { action: THREE.AnimationAction }): void => {
        if (this.disposed) {
            return;
        }
        const idle = this.options.idleClipName;
        if (idle && event.action === this.currentAction && this.clips.has(idle)) {
            this.play(idle, { loop: true });
        }
    };

    private disposeObjectTree(obj: THREE.Object3D): void {
        obj.traverse((o: THREE.Object3D) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
                mesh.geometry?.dispose();
                const material = mesh.material;
                if (Array.isArray(material)) {
                    material.forEach((m) => m.dispose());
                } else {
                    material?.dispose();
                }
            }
        });
    }
}

declare global {
    interface Window {
        /** Dev helper: spawn an {@link AnimatedGlbCharacter} from any GLB URL. Returns the handle. */
        __bmSpawnAnimGlb?: (url: string, opts?: Partial<AnimatedGlbCharacterOptions>) => AnimatedGlbCharacter;
        /** The most recently spawned dev character (e.g. `__bmAnimGlb.play('dive_left', { loop: false })`). */
        __bmAnimGlb?: AnimatedGlbCharacter | null;
    }
}

let devToolsInstalled = false;

/**
 * Install the experimental `window.__bmSpawnAnimGlb(url)` console factory and,
 * if a `?animGlb=<url>` query param is present, spawn it automatically.
 *
 * Localhost-only — a no-op in dev/prod builds (mirrors the F4 physics-wireframe
 * gate in GameEngine), so neither the window factory nor the ?animGlb= auto-spawn
 * ships active in a deployed game.
 *
 * Call once at game start (currently from the voxel genre's constructor). Safe
 * to call repeatedly — installs only on the first call. Runs in the game iframe,
 * so use it from the iframe's devtools context.
 */
export function installAnimatedGlbDevTools(engine: EngineLike): void {
    if (devToolsInstalled || typeof window === 'undefined') {
        return;
    }
    // Dev tool only — gate to localhost so it never activates in a deployed game.
    const isLocalhost = window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1';
    if (!isLocalhost) {
        return;
    }
    devToolsInstalled = true;

    window.__bmSpawnAnimGlb = (url: string, opts?: Partial<AnimatedGlbCharacterOptions>): AnimatedGlbCharacter => {
        window.__bmAnimGlb?.dispose();
        const character = new AnimatedGlbCharacter(engine, {
            ...DEFAULT_ANIMATED_GLB_CHARACTER_OPTIONS,
            url,
            ...opts,
        });
        window.__bmAnimGlb = character;
        character
            .whenReady()
            .then(() => {
                console.info(
                    `[AnimatedGlbCharacter] ready. Clips: ${character.getClipNames().join(', ') || '(none)'}. ` +
                        `Play one with __bmAnimGlb.play('<clip>', { loop: false }).`,
                );
            })
            .catch(() => {
                /* load failure already logged in load() */
            });
        return character;
    };

    const url = new URLSearchParams(window.location.search).get('animGlb');
    if (url) {
        console.info(`[AnimatedGlbCharacter] ?animGlb= detected — spawning ${url}`);
        window.__bmSpawnAnimGlb(url);
    }
}
