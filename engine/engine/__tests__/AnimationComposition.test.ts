import * as THREE from 'three';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { CustomAnimationSystem } from 'engine/animation/CustomAnimationSystem.js';
import { AnimationOverrideSystem } from 'engine/animation/AnimationOverrideSystem.js';
import { AttackAnimationSystem } from 'engine/animation/AttackAnimationSystem.js';
import { advanceGameplayTimers, clearGameplayTimers } from 'engine/GameplayTimers.js';
import { AnimationState, type AnimationContext } from 'engine/animation/AnimationContext.js';
import type { EngineLike } from 'types/game.js';

const axis = new THREE.Vector3(1, 0, 0);
function rig(): THREE.Group {
    const group = new THREE.Group();
    const add = (parent: THREE.Object3D, name: string, y: number) => {
        const bone = new THREE.Bone(); bone.name = `mixamorig${name}`; bone.position.y = y; parent.add(bone); return bone;
    };
    const hips = add(group, 'Hips', 100);
    const spine = add(hips, 'Spine', 20);
    add(spine, 'Head', 45);
    for (const side of ['Left', 'Right']) {
        const thigh = add(hips, `${side}UpLeg`, 0);
        const shin = add(thigh, `${side}Leg`, -45);
        add(shin, `${side}Foot`, -45);
    }
    group.updateMatrixWorld(true);
    return group;
}
function player(angle = 0): MixamoAnimationPlayer {
    const source = rig();
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle).toArray();
    const tracks: THREE.KeyframeTrack[] = [];
    source.traverse(b => {
        if (!(b as THREE.Bone).isBone) return;
        const value = /Head|UpLeg/.test(b.name) ? rotation : [0, 0, 0, 1];
        tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, [0, 1], [...value, ...value]));
    });
    tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, .5, 1], [0, 100, 0, 4, 94, 50, 0, 100, 100]));
    const result = new MixamoAnimationPlayer();
    expect(result.loadFromGLTF(source, [new THREE.AnimationClip('test', 1, tracks)], new THREE.Scene(), new THREE.Group(), 1.75,
        { retainFullSkeleton: true })).toBe(true);
    result.play(undefined, 0, 0);
    return result;
}
function context(): { controller: CharacterAnimationController; ctx: AnimationContext } {
    const controller = new CharacterAnimationController();
    const ctx = (controller as unknown as { ctx: AnimationContext }).ctx;
    ctx.character = rig(); ctx.mixer = new THREE.AnimationMixer(ctx.character); ctx.isInitialized = true;
    return { controller, ctx };
}
class TestLoader extends CharacterLoader {
    constructor(controller: CharacterAnimationController) {
        super({ scene: new THREE.Scene() } as unknown as EngineLike);
        this.setCharacterGroup(new THREE.Group()); this.setSkinnedSkeletonRoot(rig()); this.setAnimationController(controller);
    }
    pose() { return this.computeBlendedPose()!; }
}

describe('production animation composition', () => {
    afterEach(() => clearGameplayTimers());

    it('retains the source jump until physics exits airborne, without a standard-rig fade', () => {
        const { controller, ctx } = context(); const jump = player(.6);
        ctx.mixamoAnimationPlayers.set('jump', jump); ctx.mixamoStateOverrides.set(AnimationState.JUMP, 'jump');
        const system = new AnimationOverrideSystem(ctx, null!, null!);
        system.activateMixamoOverride(AnimationState.JUMP);
        const loader = new TestLoader(controller);
        for (let i = 0; i < 180; i++) {
            jump.update(1 / 60);
            const expected = jump.getBoneMap().get('mixamorigHead')!.getWorldQuaternion(new THREE.Quaternion());
            expect(loader.pose().get('mixamorigHead')!.rotation.angleTo(expected)).toBeLessThan(1e-6);
        }
        expect(jump.getBlendWeight()).toBe(1);
        controller.dispose();
    });

    it.each([30, 60, 120, 144])('blends an action continuously through a half-turn at %i Hz', fps => {
        const { controller, ctx } = context();
        const a = player(), b = player(); ctx.trackAMixamoPlayer = a; ctx.trackBMixamoPlayer = b;
        ctx.trackBlend = { upperBody: .5, lowerBody: 0 };
        const loader = new TestLoader(controller); let previous = new THREE.Quaternion();
        for (let i = 0; i <= fps; i++) {
            b.getBoneMap().get('mixamorigHead')!.quaternion.setFromAxisAngle(axis, i / fps * Math.PI * 1.5);
            const q = loader.pose().get('mixamorigHead')!.rotation.clone();
            expect(q.angleTo(previous)).toBeLessThan(2.4 / fps);
            previous = q;
        }
        controller.dispose();
    });

    it('phase-matches the actual controller walk-to-run handoff', () => {
        const { controller, ctx } = context(); const walk = player(), run = player();
        walk.setLoop(true); walk.setLocomotionMode(true);
        ctx.trackAMixamoPlayer = walk; ctx.currentState = AnimationState.WALK;
        ctx.mixamoAnimationPlayers.set('walk', walk); ctx.mixamoAnimationPlayers.set('run', run);
        ctx.mixamoStateOverrides.set(AnimationState.WALK, 'walk'); ctx.mixamoStateOverrides.set(AnimationState.RUN, 'run');
        const sync = jest.spyOn(run, 'synchronizeLocomotionFrom');
        controller.updateAnimation(true, 5, true, false, true);
        expect(ctx.trackAMixamoPlayer).toBe(run); expect(ctx.fadingOutTrackAPlayer).toBe(walk);
        expect(sync).toHaveBeenCalledWith(walk);
    });

    it.each([30, 60, 120])('finishes a split-on-move action through the real controller at %i fps', fps => {
        const { controller, ctx } = context(); const idle = player(0), walk = player(.2), hit = player(.6);
        ctx.trackAMixamoPlayer = idle;
        ctx.mixamoAnimationPlayers.set('idle', idle); ctx.mixamoAnimationPlayers.set('walk', walk); ctx.mixamoAnimationPlayers.set('hit', hit);
        ctx.mixamoStateOverrides.set(AnimationState.IDLE, 'idle'); ctx.mixamoStateOverrides.set(AnimationState.WALK, 'walk');
        const loader = new TestLoader(controller);
        controller.playCustomAnimation('hit', { splitBodyOnRun: true, fadeInDuration: .06, fadeOutDuration: .1 });
        let split = false;
        for (let i = 0; i < fps * 2; i++) {
            const moving = i / fps > .2;
            controller.updateAnimation(moving, moving ? 2 : 0, true, false, moving);
            controller.update(1 / fps);
            split ||= controller.getCustomAnimationBodyBlend()?.lowerBody === 0;
            for (const value of loader.pose().values()) {
                expect([...value.position.toArray(), ...value.rotation.toArray()].every(Number.isFinite)).toBe(true);
                expect(value.rotation.length()).toBeCloseTo(1);
            }
        }
        expect(split).toBe(true); expect(controller.getTrackBMixamoPlayer()).toBeNull();
        expect(controller.getCurrentState()).toBe(AnimationState.WALK);
    });

    it('times attack duration at playback speed and keeps its watchdog paused with gameplay', () => {
        const { ctx } = context(); const p = player();
        ctx.mixamoAnimationPlayers.set('mTestSwing01', p);
        const system = new AttackAnimationSystem(ctx, () => {}, () => ({ success: true, duration: 1 }));
        system.registerCustomAttack({ name: 'swing', animationMotionId: 'mTestSwing01', type: 'attack', speed: 2 });
        const result = system.startNamedAttack('swing');
        expect(result.duration).toBe(.5);
        for (let i = 0; i < 100; i++) advanceGameplayTimers(0);
        expect(ctx.isAttacking).toBe(true);
        advanceGameplayTimers(.75); expect(ctx.isAttacking).toBe(true);
        advanceGameplayTimers(.3); expect(ctx.isAttacking).toBe(false);
    });
    it('keeps the outgoing locomotion fade underneath an upper-body action', () => {
        const { controller, ctx } = context();
        ctx.fadingOutTrackAPlayer = player(0); ctx.trackAMixamoPlayer = player(Math.PI / 2);
        ctx.fadingOutCrossfadeProgress = .25; ctx.trackBMixamoPlayer = player(1);
        ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
        const pose = new TestLoader(controller).pose();
        const expected = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2 * THREE.MathUtils.smoothstep(.25, 0, 1));
        expect(pose.get('mixamorigLeftUpLeg')!.rotation.angleTo(expected)).toBeLessThan(1e-6);
        expect(pose.get('mixamorigHead')!.rotation.angleTo(new THREE.Quaternion().setFromAxisAngle(axis, 1))).toBeLessThan(1e-6);
    });

    it('applies legacy procedural stance offsets to blended actions as well as a single clip', () => {
        const { controller, ctx } = context();
        ctx.trackAMixamoPlayer = player(0); ctx.trackBMixamoPlayer = player(0);
        ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
        const rotation = new THREE.Quaternion().setFromAxisAngle(axis, .2);
        controller.setManualBoneOffsets(new Map([['leftThigh', rotation]]));
        expect(new TestLoader(controller).pose().get('mixamorigLeftUpLeg')!.rotation.angleTo(rotation)).toBeLessThan(1e-6);
        expect(ctx.trackAMixamoPlayer.getBoneMap().get('mixamorigLeftUpLeg')!.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    });

    it('smooths an immediate full-body to upper-body mask handoff', () => {
        const { controller, ctx } = context();
        ctx.trackAMixamoPlayer = player(0); ctx.trackBMixamoPlayer = player(1);
        const loader = new TestLoader(controller);
        const before = loader.pose().get('mixamorigLeftUpLeg')!.rotation.clone();
        ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
        expect(loader.pose().get('mixamorigLeftUpLeg')!.rotation.angleTo(before)).toBeLessThan(1e-6);
        for (let i = 0; i < 20; i++) loader.pose();
        expect(loader.pose().get('mixamorigLeftUpLeg')!.rotation.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    });

    it('does not clear the next combo started in a completion callback', () => {
        const { ctx } = context(); const system = new CustomAnimationSystem(ctx, () => {});
        const first = player(); const next = player(.5);
        system.playMixamoAnimation('first', first, { onFinished: () => system.playMixamoAnimation('next', next) });
        first.update(1.01);
        expect(ctx.trackBMixamoPlayer).toBe(next);
        expect(ctx.currentCustomMotionId).toBe('next');
        expect(ctx.isPlayingCustomAnimation).toBe(true);
    });

    it('clears an owned split when replaced, but keeps an explicitly caller-owned mask', () => {
        const { ctx } = context(); const system = new CustomAnimationSystem(ctx, () => {});
        ctx.currentState = AnimationState.RUN;
        system.playMixamoAnimation('a', player(), { splitBodyOnRun: true });
        expect(ctx.trackBlend?.lowerBody).toBe(0);
        system.playMixamoAnimation('b', player(), { splitBodyOnRun: false });
        expect(ctx.trackBlend).toBeNull();
        ctx.trackBlend = { upperBody: .6, lowerBody: .2 };
        system.playMixamoAnimation('c', player());
        expect(ctx.trackBlend).toEqual({ upperBody: .6, lowerBody: .2 });
    });

    it('restores cached source root tracks after in-place playback without erasing sway', () => {
        const p = player();
        const hips = p.getBoneMap().get('mixamorigHips')!;
        p.filterAllRootMotion(); p.setTime(.5);
        expect(hips.position.toArray()).toEqual([4, 94, 0]);
        p.restoreRootMotion(); p.setTime(.5);
        expect(hips.position.toArray()).toEqual([4, 94, 50]);
        p.filterAllRootMotion(); p.setTime(.5);
        expect(hips.position.toArray()).toEqual([4, 94, 0]);
    });

    it('does not fade a looping custom action out at the first loop boundary', () => {
        const p = player(); p.setLoop(true); p.play(undefined, .1, .1);
        for (let i = 0; i < 29; i++) p.update(1 / 30);
        expect(p.getBlendWeight()).toBe(1);
        for (let i = 0; i < 30; i++) p.update(1 / 30);
        expect(p.getBlendWeight()).toBe(1);
    });

    it('honors loaded loop defaults, explicit one-shot overrides, and the next default replay', async () => {
        const { ctx } = context(); const p = player(); ctx.mixamoAnimationPlayers.set('loop', p);
        const system = new CustomAnimationSystem(ctx, () => {});
        await system.loadCustomAnimation('loop', { loop: true });
        system.playCustomAnimation('loop');
        p.update(2.1); expect(ctx.isPlayingCustomAnimation).toBe(true); expect(p.getBlendWeight()).toBe(1);
        system.playCustomAnimation('loop', { loop: false });
        p.update(1.1); expect(ctx.isPlayingCustomAnimation).toBe(false);
        system.playCustomAnimation('loop');
        p.update(2.1); expect(ctx.isPlayingCustomAnimation).toBe(true);
        p.dispose(); system.dispose();
    });

    it('does not feed the last skinned output into a custom-only fallback', () => {
        const { controller, ctx } = context(); const p = player(.6);
        p.play(undefined, 1, 0); p.update(.5); ctx.trackBMixamoPlayer = p;
        const loader = new TestLoader(controller);
        const before = loader.pose().get('mixamorigHead')!.rotation.clone();
        for (let i = 0; i < 20; i++) {
            loader.getSkinnedSkeletonRoot()!.getObjectByName('mixamorigHead')!.quaternion.setFromAxisAngle(axis, i * .1);
            expect(loader.pose().get('mixamorigHead')!.rotation.angleTo(before)).toBeLessThan(1e-6);
        }
        controller.dispose();
    });

    it('reads timing from an exporter-created root node and preserves anticipation', () => {
        const source = rig();
        source.children[0]!.userData.bmAnimation = { startTime: 0, impactPhase: .4, contactStart: .3, contactEnd: .6 };
        const p = new MixamoAnimationPlayer();
        const clip = new THREE.AnimationClip('timed', 1, [new THREE.QuaternionKeyframeTrack('mixamorigHead.quaternion',
            [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);
        expect(p.loadFromGLTF(source, [clip], new THREE.Scene(), new THREE.Group())).toBe(true);
        p.play(); expect(p.getTime()).toBeLessThan(.001);
        expect(p.getImpactFraction()).toBe(.4);
        expect(p.getContactCheckPhases([])).toContain(.4);
    });

    it('starts an interrupted locomotion crossfade at the previously displayed pose', () => {
        const { controller, ctx } = context();
        const a = player(0), b = player(1), c = player(-1);
        ctx.trackAMixamoPlayer = b; ctx.fadingOutTrackAPlayer = a; ctx.fadingOutCrossfadeProgress = .5;
        const loader = new TestLoader(controller);
        const displayed = loader.pose().get('mixamorigLeftUpLeg')!.rotation.clone();
        ctx.fadingOutTrackAPlayer = b; ctx.trackAMixamoPlayer = c; ctx.fadingOutCrossfadeProgress = 0;
        expect(loader.pose().get('mixamorigLeftUpLeg')!.rotation.angleTo(displayed)).toBeLessThan(1e-6);
    });

    it('does not leave the live incoming player in the outgoing slot on a rapid reversal', () => {
        const { ctx } = context();
        const a = player(); const b = player();
        ctx.mixamoStateOverrides.set(AnimationState.IDLE, 'a'); ctx.mixamoStateOverrides.set(AnimationState.WALK, 'b');
        ctx.mixamoAnimationPlayers.set('a', a); ctx.mixamoAnimationPlayers.set('b', b);
        ctx.trackAMixamoPlayer = b; ctx.fadingOutTrackAPlayer = a;
        // This method does not use idle/attack subsystems; real class and real players.
        const system = new AnimationOverrideSystem(ctx, null!, null!);
        system.activateMixamoOverride(AnimationState.IDLE);
        expect(ctx.trackAMixamoPlayer).toBe(a); expect(ctx.fadingOutTrackAPlayer).toBe(b);
        b.stop(); expect(a.isPlaying()).toBe(true);
    });
});
