import * as THREE from 'three';
import type { BaseAnimationDefinition } from 'types/game.js';
import {
    type AnimationContext,
    AnimationState,
    cachedGLTFLoad,
    findAnimationAsset,
    findAnimationAssetIdByName,
} from 'engine/animation/AnimationContext.js';
import { getBuiltinAnimationDef } from 'engine/AnimationPacks.js';

interface CustomPlayOptions {
    loop?: boolean;
    fadeInDuration?: number;
    fadeOutDuration?: number;
    speed?: number;
    onFinished?: () => void;
    applyRootMotion?: boolean;
    onRootMotionDisplacement?: (displacement: THREE.Vector3) => void;
    holdLastFrame?: boolean;
    /**
     * Lock the clip's root motion so it cannot move the character.
     *
     * DEFAULTS TO TRUE — pass `false` only to deliberately let a clip's baked
     * hips travel drag the character, which is almost never wanted (see
     * playCustomAnimation). To move the character *intentionally*, use
     * `applyRootMotion` + `onRootMotionDisplacement` instead.
     */
    filterRootMotion?: boolean;
    splitBodyOnRun?: boolean;
    interruptOnMovement?: boolean;
    /** Fired once, when playback crosses the clip's contact frame. No-ops if
     *  the clip has no detectable contact frame and no `impactTime` override. */
    onImpact?: () => void;
    /** Explicit override (clip-local seconds) of the contact frame, for the
     *  rare case auto-detection is wrong or absent. Beats the detected value. */
    impactTime?: number;
}

/**
 * Manages custom animation loading and playback (both standard mixer
 * and Mixamo-based uploaded animations).
 */
export class CustomAnimationSystem {
    private readonly ctx: AnimationContext;
    private readonly playAnimation: (state: AnimationState) => void;
    /** Set when a play call supplies onImpact AND a resolvable contact time.
     *  Polled each frame (via updatePendingImpact); fires once, then cleared. */
    private pendingImpact:
        | { player: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer;
            thresholdSeconds: number;
            onImpact: () => void;
            fired: boolean }
        | null = null;
    /** Built-in optional motionIds whose lazy load is currently in flight, so a
     *  per-frame `playCustomAnimation` miss doesn't kick off duplicate loads. */
    private readonly builtinLoadsInFlight = new Set<string>();
    private readonly loadedLoops = new Map<string, boolean>();

    constructor(
        ctx: AnimationContext,
        playAnimation: (state: AnimationState) => void,
    ) {
        this.ctx = ctx;
        this.playAnimation = playAnimation;
    }

    /**
     * Load a custom animation by its asset ID.
     */
    async loadCustomAnimation(
        motionId: string,
        /**
         * `normalizeRootMotion` is accepted for back-compat and has NO effect:
         * it never had an implementation. Root motion is neutralised at PLAY
         * time instead, and locked by default — see playCustomAnimation.
         */
        options?: { normalizeRootMotion?: boolean; loop?: boolean },
    ): Promise<void> {
        const isLoaded = (id: string) =>
            this.ctx.customAnimations.has(id) || this.ctx.mixamoAnimationPlayers.has(id);

        if (isLoaded(motionId)) {
            if (options?.loop !== undefined) {
                this.loadedLoops.set(motionId, options.loop);
                this.ctx.mixamoAnimationPlayers.get(motionId)?.setLoop(options.loop);
            }
            return;
        }

        if (!this.ctx.loader) {
            console.warn('No loader available. Initialize with loader to load custom animations.');
            return;
        }

        if (!this.ctx.mixer) {
            console.warn('No mixer available. Initialize character first.');
            return;
        }

        // Fallback: callers may pass an asset NAME instead of a motionId. Resolve
        // by name if id-lookup fails, then re-check the already-loaded maps so we
        // don't reload an animation that's keyed under its real id.
        let raw = findAnimationAsset(this.ctx, motionId);
        if (!raw) {
            const resolvedId = findAnimationAssetIdByName(this.ctx, motionId);
            if (resolvedId) {
                if (isLoaded(resolvedId)) return this.loadCustomAnimation(resolvedId, options);
                raw = findAnimationAsset(this.ctx, resolvedId);
                if (raw) motionId = resolvedId;
            }
        }
        if (!raw) {
            // Built-in optional animation (Punching, Kicking, MiningChop,
            // SoccerKick, DanceUthana)? These live in AnimationPacks, not the
            // game-data asset list, and are not loaded at startup. Resolve them
            // here so templates can `await loadCustomAnimation('mSoccerKick01')`.
            const builtin = getBuiltinAnimationDef(motionId);
            if (builtin) {
                await this.loadBuiltinAnimation(builtin);
                if (options?.loop !== undefined && isLoaded(motionId)) await this.loadCustomAnimation(motionId, options);
                return;
            }
            console.warn(`Animation "${motionId}" not found in assets. Ensure setGameDataProvider() was called.`);
            return;
        }

        const animationDef = {
            animationUrl: (raw.animationUrl ?? raw.url) as string,
            source: raw.source as string | undefined,
            prompt: raw.prompt as string | undefined,
            unitScale: raw.unitScale as number | undefined,
        };

        if (!animationDef.animationUrl) {
            console.warn(`Animation "${motionId}" has no URL (checked animationUrl and url fields)`);
            return;
        }

        try {
            // All custom animations target the canonical Mixamo skeleton (whether
            // user-uploaded or agent-generated via Uthana — see
            // shared/asset-core/src/generators/animation.ts). Route
            // every clip through MixamoAnimationPlayer; no standard-mixer
            // fallback. Clips whose skeleton the player can't parse are
            // rejected loudly so authors fix the asset rather than silently
            // landing on a retargeting code path that no longer exists.
            const providerData = this.ctx.gameDataProvider?.();
            const scene = providerData?.scene ?? null;

            if (!scene || !this.ctx.character) {
                console.warn(`Cannot load custom animation "${motionId}": scene or character not available`);
                return;
            }

            const gltf = await cachedGLTFLoad(this.ctx.loader, animationDef.animationUrl);
            const { MixamoAnimationPlayer } = await import('engine/MixamoAnimationPlayer.js');
            const player = new MixamoAnimationPlayer();
            const success = player.loadFromGLTF(
                gltf.scene,
                gltf.animations,
                scene,
                this.ctx.character,
                this.ctx.characterHeight,
                { retainFullSkeleton: this.ctx.retainFullSkeleton }
            );
            if (!success) {
                console.error(`MixamoAnimationPlayer rejected "${motionId}" (${animationDef.animationUrl}): unrecognised skeleton. Custom animations must target the Mixamo skeleton (mixamorig:* joints) or one of the supported aliases (mixamorig2:*, UE5 Manny lowercase).`);
                return;
            }
            player.setAnimationName(motionId);
            // Stride sync fallback for in-place clips: locomotion speed-match
            // measures the hips track when the clip has baked root motion, but
            // an in-place clip measures 0 and would play at 1x no matter how
            // fast the character moves (feet slide). The asset's designSpeed
            // (written by authored gait clips) is what getNativeLocomotionSpeed
            // falls back to.
            const designSpeed = raw.designSpeed;
            if (typeof designSpeed === 'number' && designSpeed > 0) {
                player.setDesignSpeed(designSpeed);
            }
            this.ctx.mixamoAnimationPlayers.set(motionId, player);
            const loop = options?.loop ?? (typeof raw.loop === 'boolean' ? raw.loop : undefined);
            if (loop !== undefined) { this.loadedLoops.set(motionId, loop); player.setLoop(loop); }
        } catch (error) {
            console.error(`Failed to load custom animation "${motionId}" from ${animationDef.animationUrl}:`, error);
        }
    }

    /**
     * Load a built-in optional animation from an explicit definition (URL known
     * from AnimationPacks, not the game-data asset list). Routes through
     * MixamoAnimationPlayer like loadCustomAnimation. Idempotent — the GLB fetch
     * is cached and an already-loaded motionId is a no-op.
     */
    private async loadBuiltinAnimation(def: BaseAnimationDefinition): Promise<void> {
        if (this.ctx.mixamoAnimationPlayers.has(def.motionId)) return;
        if (!this.ctx.loader) {
            console.warn('No loader available. Cannot load built-in animation.');
            return;
        }
        const providerData = this.ctx.gameDataProvider?.();
        const scene = providerData?.scene ?? null;
        if (!scene || !this.ctx.character) {
            console.warn(`Cannot load built-in animation "${def.motionId}": scene or character not available`);
            return;
        }
        try {
            const gltf = await cachedGLTFLoad(this.ctx.loader, def.animationUrl);
            const { MixamoAnimationPlayer } = await import('engine/MixamoAnimationPlayer.js');
            const player = new MixamoAnimationPlayer();
            const success = player.loadFromGLTF(
                gltf.scene,
                gltf.animations,
                scene,
                this.ctx.character,
                this.ctx.characterHeight,
                { retainFullSkeleton: this.ctx.retainFullSkeleton }
            );
            if (!success) {
                console.error(`MixamoAnimationPlayer rejected built-in "${def.motionId}" (${def.animationUrl}): unrecognised skeleton.`);
                return;
            }
            player.setAnimationName(def.motionId);
            if (def.designSpeed) player.setDesignSpeed(def.designSpeed);
            this.ctx.mixamoAnimationPlayers.set(def.motionId, player);
        } catch (error) {
            console.error(`Failed to load built-in animation "${def.motionId}" from ${def.animationUrl}:`, error);
        }
    }

    /**
     * Load all animation assets from the game data.
     */
    async loadAllAnimationAssets(options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void> {
        const data = this.ctx.gameDataProvider?.();
        if (!data?.assets) {
            console.warn('loadAllAnimationAssets: No game data provider or no assets available');
            return;
        }

        const animationAssets = data.assets.filter(a => {
            return (a as Record<string, unknown>).type === 'animation';
        });

        if (animationAssets.length === 0) return;

        await Promise.all(animationAssets.map(asset => {
            const rec = asset as Record<string, unknown>;
            const id = (rec.id ?? rec.motionId) as string;
            if (!id) return Promise.resolve();
            const assetLoop = typeof rec.loop === 'boolean' ? rec.loop : options?.loop;
            return this.loadCustomAnimation(id, { ...options, loop: assetLoop });
        }));
    }

    /**
     * Play a custom animation by motionId. Mixamo-only — every clip loaded
     * via `loadCustomAnimation` becomes a `MixamoAnimationPlayer` entry in
     * `ctx.mixamoAnimationPlayers`, and playback dispatches to the Mixamo
     * track-B path. The standard-mixer code path was removed when the engine
     * went 100% Mixamo (see `loadCustomAnimation` for the rationale).
     */
    playCustomAnimation(
        motionId: string,
        options?: CustomPlayOptions
    ): { success: boolean; duration: number } {
        const mixamoPlayer = this.ctx.mixamoAnimationPlayers.get(motionId);
        if (mixamoPlayer) {
            return this.playMixamoAnimation(motionId, mixamoPlayer, options);
        }

        // Built-in optional animation (SoccerKick, DanceUthana, …) played before
        // it was loaded? Kick off the lazy load so the next call succeeds. The
        // load is async, so this first call can't play (returns failure). For
        // guaranteed first-frame playback, preload via loadCustomAnimation().
        const builtin = getBuiltinAnimationDef(motionId);
        if (builtin && !this.builtinLoadsInFlight.has(motionId)) {
            this.builtinLoadsInFlight.add(motionId);
            void this.loadBuiltinAnimation(builtin).finally(() => {
                this.builtinLoadsInFlight.delete(motionId);
            });
            return { success: false, duration: 0 };
        }

        const availableMixamo = Array.from(this.ctx.mixamoAnimationPlayers.keys());
        console.warn(
            `Custom animation "${motionId}" not found. Load it first via ` +
            `loadCustomAnimation() (the clip must target the canonical Mixamo skeleton). ` +
            `Available Mixamo players: ${availableMixamo.length > 0 ? availableMixamo.join(', ') : '(none loaded)'}`,
        );
        return { success: false, duration: 0 };
    }

    /**
     * Play an uploaded Mixamo animation using MixamoAnimationPlayer.
     */
    playMixamoAnimation(
        motionId: string,
        player: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer,
        options?: CustomPlayOptions
    ): { success: boolean; duration: number } {
        // Clean up previous held Mixamo player
        if (this.ctx.trackBMixamoPlayer && this.ctx.trackBMixamoPlayer !== player) {
            this.ctx.trackBMixamoPlayer.setHoldLastFrame(false);
            this.ctx.trackBMixamoPlayer.disableRootMotion();
            this.ctx.trackBMixamoPlayer.stop();
        }
        // A replacement owns its own mask. Do not inherit the preceding
        // move's automatic split; preserve only explicitly caller-owned masks.
        if (this.ctx.customAnimationSplitApplied) {
            this.ctx.trackBlend = null;
            this.ctx.customAnimationSplitApplied = false;
        }

        this.ctx.isPlayingCustomAnimation = true;
        this.ctx.customAnimationHeld = false;
        this.ctx.currentCustomMotionId = motionId;
        this.ctx.trackBMixamoPlayer = player;

        // Arm the contact-frame callback: explicit override wins, else the
        // clip's auto-detected fraction. Cleared if neither resolves.
        const detectedFraction = player.getImpactFraction();
        const impactSeconds =
            options?.impactTime ??
            (detectedFraction !== null ? detectedFraction * player.getDuration() : null);
        this.pendingImpact =
            options?.onImpact && impactSeconds !== null
                ? { player, thresholdSeconds: impactSeconds, onImpact: options.onImpact, fired: false }
                : null;

        this.ctx.customAnimationInterruptOnMovement = options?.interruptOnMovement === true;

        player.setHoldLastFrame(options?.holdLastFrame === true);
        const loop = options?.loop ?? this.loadedLoops.get(motionId);
        if (loop !== undefined) player.setLoop(loop);
        player.setLocomotionMode(false);
        if (options?.holdLastFrame) {
            this.ctx.customAnimationHeld = true;
        }

        // Root motion: COMMIT the clip's step to the player (applyRootMotion +
        // callback), or LOCK it in place (filterRootMotion), or neither. These
        // are mutually exclusive; always (re)set the player's mode so a reused
        // player doesn't inherit a previous play's root-motion callback.
        if (options?.applyRootMotion && options.onRootMotionDisplacement) {
            player.enableRootMotion(options.onRootMotionDisplacement);
        } else {
            player.disableRootMotion();
            // LOCKED BY DEFAULT.
            //
            // A custom animation plays on a character whose position something
            // else owns — the movement controller, physics, or a network peer.
            // Any hips travel baked into the clip therefore drags the character
            // sideways through the world, which is what "the animation teleports
            // the player" always turns out to be.
            //
            // This used to require the CALLER to remember `filterRootMotion`, so
            // whether a clip teleported you depended on the call site rather than
            // on the clip. Every in-engine caller that thought about it passed the
            // flag (WeaponMeleeSystem) or asked for normalisation at load time —
            // so locking is the intent everywhere; it simply was not the default.
            //
            // A caller that genuinely wants the clip to move the character opts in
            // with `applyRootMotion` + `onRootMotionDisplacement`, which commits
            // the step deliberately instead of leaking it.
            if (options?.filterRootMotion !== false) {
                player.filterAllRootMotion();
            } else player.restoreRootMotion();
        }

        // Upper-body-only blend while running, mirroring WeaponMeleeSystem's
        // melee-strike behaviour: legs keep the run cycle, the custom clip
        // plays on the upper body. Cleared in onComplete below. We also
        // remember whether *we* set it so we don't stomp a blend that some
        // other system (e.g. WeaponMeleeSystem) may already have active.
        //
        // Attack-driven plays (e.g. UnarmedMeleeSystem punch) call
        // beginAttackState() before reaching here, which flips currentState
        // to ATTACK and stashes the prior locomotion state in previousState.
        // We accept either signal so a punch thrown mid-run still splits.
        const isInRunContext =
            this.ctx.currentState === AnimationState.RUN
            || this.ctx.currentState === AnimationState.WALK
            || (this.ctx.currentState === AnimationState.ATTACK
                && (this.ctx.previousState === AnimationState.RUN
                    || this.ctx.previousState === AnimationState.WALK));
        const splitBodyApplied =
            options?.splitBodyOnRun === true
            && isInRunContext
            && !this.ctx.trackBlend;
        if (splitBodyApplied) {
            this.ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
            this.ctx.customAnimationSplitApplied = true;
        }
        // A clip that WANTED the split but started from a standstill is remembered, because
        // the decision must not be final. Without this it latches: a full-body clip stops
        // locomotion from running at all, so `currentState` can never leave idle, so every
        // retrigger reads "not moving" and re-decides the same way — and the character slides
        // through the world in a firing pose until the trigger is released. The controller
        // re-checks this flag against real movement every frame.
        this.ctx.customAnimationSplitOnMove = options?.splitBodyOnRun === true && !splitBodyApplied;

        const revision = player.getPlayRevision() + 1;
        player.play(
            () => {
                if (this.ctx.trackBMixamoPlayer !== player || player.getPlayRevision() !== revision) return;

                if (options?.holdLastFrame) {
                    // Drop an impact that never fired (e.g. impactTime beyond the clip).
                    if (this.pendingImpact && !this.pendingImpact.fired) this.pendingImpact = null;
                    options?.onFinished?.();
                    return;
                }

                this.ctx.customAnimationHeld = false;
                this.ctx.isPlayingCustomAnimation = false;
                this.ctx.currentCustomMotionId = null;
                player.disableRootMotion();
                this.ctx.trackBMixamoPlayer = null;
                this.ctx.customAnimationInterruptOnMovement = false;
                this.pendingImpact = null;

                // Read from the context, not the local: the split may have been applied
                // AFTER this clip started, the moment the character began to move.
                if (this.ctx.customAnimationSplitApplied) {
                    this.ctx.trackBlend = null;
                    this.ctx.customAnimationSplitApplied = false;
                }
                this.ctx.customAnimationSplitOnMove = false;

                // Resume the state that was active before the custom animation
                // took over (currentState is preserved across custom anims).
                // Avoids a forced IDLE flash when finishing mid-jump or mid-run.
                this.playAnimation(this.ctx.currentState);
                // Clean up BEFORE user callbacks: a combo may start its next
                // move here, and the old completion must not clear that move.
                options?.onFinished?.();
            },
            options?.fadeInDuration,
            options?.fadeOutDuration,
        );

        if (options?.speed !== undefined) {
            player.setSpeed(options.speed);
        }

        const duration = player.getDuration();
        return { success: true, duration };
    }

    /**
     * Fire the armed onImpact callback once the playing clip crosses its
     * contact frame. Called every frame by CharacterAnimationController.update.
     * No-op when nothing is armed. If the originating player is no longer the
     * active overlay (interrupted / replaced), the armed impact is dropped.
     */
    updatePendingImpact(): void {
        const pi = this.pendingImpact;
        if (!pi || pi.fired) return;
        if (this.ctx.trackBMixamoPlayer !== pi.player) {
            this.pendingImpact = null;
            return;
        }
        if (pi.player.getTime() >= pi.thresholdSeconds) {
            pi.fired = true;
            pi.onImpact();
            this.pendingImpact = null;
        }
    }

    isPlayingCustom(): boolean {
        return this.ctx.isPlayingCustomAnimation;
    }

    getCustomMotionId(): string | null {
        return this.ctx.isPlayingCustomAnimation ? this.ctx.currentCustomMotionId : null;
    }

    getAvailableCustomAnimations(): string[] {
        return [...this.ctx.customAnimations.keys(), ...this.ctx.mixamoAnimationPlayers.keys()];
    }

    stopCustomAnimation(): void {
        if (!this.ctx.isPlayingCustomAnimation) return;
        if (this.ctx.customAnimationHeld) return;

        this.ctx.isPlayingCustomAnimation = false;
        this.ctx.currentCustomMotionId = null;
        this.ctx.customAnimationInterruptOnMovement = false;
        this.ctx.customAnimationSplitOnMove = false;
        this.ctx.customAnimationSplitApplied = false;
        this.pendingImpact = null;

        if (this.ctx.trackBMixamoPlayer) {
            this.ctx.trackBMixamoPlayer.disableRootMotion();
            this.ctx.trackBMixamoPlayer.stop();
            this.ctx.trackBMixamoPlayer = null;
        }
        this.ctx.trackBlend = null;

        // Note: `ctx.customAnimations` is always empty under the Mixamo-only
        // contract, so we don't iterate it here. Custom playback now lives
        // entirely on track-B Mixamo players, handled above.

        // Resume whatever state was active before the custom animation —
        // currentState is preserved during custom playback. Avoids a forced
        // IDLE flash when interrupting mid-run.
        this.playAnimation(this.ctx.currentState);
    }

    // Speed/time control
    setAnimationSpeed(speed: number): void {
        if (this.ctx.trackBMixamoPlayer) {
            this.ctx.trackBMixamoPlayer.setSpeed(speed);
            return;
        }
        if (this.ctx.currentAction) {
            this.ctx.currentAction.timeScale = speed;
        }
    }

    getAnimationSpeed(): number {
        if (this.ctx.trackBMixamoPlayer) {
            return this.ctx.trackBMixamoPlayer.getSpeed();
        }
        return this.ctx.currentAction?.timeScale ?? 1;
    }

    setAnimationTime(time: number): void {
        if (this.ctx.trackBMixamoPlayer) {
            this.ctx.trackBMixamoPlayer.setTime(time);
            return;
        }
        if (this.ctx.currentAction) {
            this.ctx.currentAction.time = time;
            this.ctx.mixer?.update(0);
        }
    }

    getAnimationTime(): number {
        if (this.ctx.trackBMixamoPlayer) {
            return this.ctx.trackBMixamoPlayer.getTime();
        }
        return this.ctx.currentAction?.time ?? 0;
    }

    /** 0..1 progress of the playing custom clip; 0 when none is playing. */
    getCustomAnimationProgress(): number {
        const player = this.ctx.trackBMixamoPlayer;
        if (!this.ctx.isPlayingCustomAnimation || !player) return 0;
        const d = player.getDuration();
        return d > 0 ? Math.min(1, Math.max(0, player.getTime() / d)) : 0;
    }

    dispose(): void {
        this.loadedLoops.clear();
        this.pendingImpact = null;
        // No standard-mixer listeners or root-bone refs to release under the
        // Mixamo-only contract. Mixamo player disposal is handled by the
        // pool owner (AnimationContext.mixamoAnimationPlayers).
    }
}
