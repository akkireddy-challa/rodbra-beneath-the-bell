import * as THREE from 'three';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { DirectionalLocomotionPlayer } from 'engine/animation/DirectionalLocomotionPlayer.js';
import { directionalWeights, DIRECTIONAL_BLEND_IDS } from 'engine/animation/DirectionalLocomotion.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { AnimationState, type AnimationContext } from 'engine/animation/AnimationContext.js';
import { resolveLocomotionMotionId } from 'engine/animation/AnimationOverrideSystem.js';

function source(duration = 1, angle = 0) {
    const root = new THREE.Group();
    const add = (parent: THREE.Object3D, name: string, y: number) => {
        const bone = new THREE.Bone(); bone.name = `mixamorig${name}`; bone.position.y = y; parent.add(bone); return bone;
    };
    const hips = add(root, 'Hips', 100), spine = add(hips, 'Spine', 20);
    add(spine, 'Head', 45);
    for (const side of ['Left', 'Right']) {
        const thigh = add(hips, `${side}UpLeg`, 0), shin = add(thigh, `${side}Leg`, -45);
        add(shin, `${side}Foot`, -45);
    }
    const tracks: THREE.KeyframeTrack[] = [];
    root.traverse(node => {
        if (!(node as THREE.Bone).isBone) return;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), node.name.endsWith('UpLeg') ? angle : 0).toArray();
        tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, [0, duration], [...q, ...q]));
    });
    tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, duration / 2, duration],
        [0, 100, 0, 2, 95, 100, 0, 100, 200]));
    return { root, clip: new THREE.AnimationClip('test', duration, tracks) };
}

function fixture() {
    const scene = new THREE.Scene(), character = new THREE.Group();
    const load = <T extends MixamoAnimationPlayer>(p: T, duration: number, angle = 0): T => {
        const data = source(duration, angle);
        expect(p.loadFromGLTF(data.root, [data.clip], scene, character, 1.75, { retainFullSkeleton: true })).toBe(true);
        return p;
    };
    const samplers = Array.from({ length: 8 }, (_, i) => load(new MixamoAnimationPlayer(), .5 + i * .1, i * .06));
    const blend = load(new DirectionalLocomotionPlayer(), .5);
    blend.configure(samplers); blend.setLoop(true); blend.play(); blend.setLocomotionMode(true);
    const controller = new CharacterAnimationController();
    const ctx = (controller as unknown as { ctx: AnimationContext }).ctx;
    ctx.character = character; ctx.mixer = new THREE.AnimationMixer(character); ctx.isInitialized = true;
    ctx.mixamoStateOverrides.set(AnimationState.RUN, 'mGenSlowRun01');
    ctx.mixamoAnimationPlayers.set(DIRECTIONAL_BLEND_IDS.neutral, blend);
    return { blend, samplers, character, controller, ctx };
}

describe('captured eight-way locomotion', () => {
    it('has exact cardinal/diagonal samples, adjacent weights, and wrap continuity', () => {
        const weights = Array<number>(8).fill(0);
        for (let i = -32; i <= 32; i++) {
            directionalWeights(i * Math.PI / 4, weights);
            expect(weights[(i % 8 + 8) % 8]).toBeCloseTo(1);
        }
        for (let i = -720; i <= 720; i++) {
            directionalWeights(i * Math.PI / 180, weights);
            expect(weights.reduce((a, b) => a + b)).toBeCloseTo(1);
            expect(weights.filter(w => w > 1e-12).length).toBeLessThanOrEqual(2);
            expect(weights.every(w => w >= 0 && w <= 1)).toBe(true);
        }
        directionalWeights(Math.PI - 1e-8, weights); const before = [...weights];
        directionalWeights(-Math.PI + 1e-8, weights);
        expect(Math.max(...weights.map((w, i) => Math.abs(w - before[i]!)))).toBeLessThan(1e-6);
    });

    it.each([15, 30, 60, 120, 144])('keeps one gait clock and joint lengths at %i fps', fps => {
        const { blend, samplers, character } = fixture();
        blend.setDirection(Math.PI * .375);
        blend.setSpeed(1.7);
        for (let frame = 0; frame < fps * 3; frame++) {
            blend.update(1 / fps);
            expect(blend.getDirectionWeights().reduce((a, b) => a + b)).toBeCloseTo(1);
            for (const bone of blend.getBoneMap().values()) {
                expect([...bone.position.toArray(), ...bone.quaternion.toArray()].every(Number.isFinite)).toBe(true);
                expect(bone.quaternion.length()).toBeCloseTo(1);
                if (/mixamorig(Left|Right)(Leg|Foot)$/.test(bone.name)) expect(bone.position.length()).toBeCloseTo(45);
            }
        }
        expect(blend.getDirectionWeights()[1]).toBeCloseTo(.5);
        expect(blend.getDirectionWeights()[2]).toBeCloseTo(.5);
        expect(blend.getNativeLocomotionSpeed()).toBeCloseTo(4 * Math.cos(Math.PI / 8));
        const contactPhase = (p: MixamoAnimationPlayer) => (p.getTime() / p.getDuration() - (p.getLocomotionContactPhase() ?? 0) + 1) % 1;
        expect(contactPhase(samplers[1]!)).toBeCloseTo(contactPhase(blend));
        expect(contactPhase(samplers[2]!)).toBeCloseTo(contactPhase(blend));
        expect(character.position.length()).toBe(0);
        expect(character.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
        const before = blend.getBoneMap().get('mixamorigLeftUpLeg')!.quaternion.clone();
        blend.update(0); blend.update(NaN);
        expect(blend.getBoneMap().get('mixamorigLeftUpLeg')!.quaternion.angleTo(before)).toBeLessThan(1e-6);
        blend.dispose();
    });

    it('does not swap/restart Track A on direction changes, including during split attacks', () => {
        const { controller, ctx, blend } = fixture();
        controller.updateAnimation(true, 5, true, false, true);
        const revision = blend.getPlayRevision();
        ctx.isAttacking = true; ctx.currentState = AnimationState.ATTACK; ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
        for (const [x, z] of [[1, 1], [0, -1], [-1, -1], [-1, 0], [0, 1]]) {
            controller.setLocomotionDirection(x!, z!);
            controller.updateAnimation(true, 8, true, false, true); controller.update(1 / 60);
            expect(controller.getTrackAMixamoPlayer()).toBe(blend);
            expect(blend.getPlayRevision()).toBe(revision);
            expect(controller.getCurrentState()).toBe(AnimationState.ATTACK);
        }
        expect(blend.getSpeed()).toBeGreaterThan(1.35); // No slow-sidestep cap on captured runs.
        controller.dispose();
    });

    it('keeps walking/posture/missing-pack fallbacks and accepts no invalid direction', () => {
        const { controller, ctx, blend } = fixture();
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe(DIRECTIONAL_BLEND_IDS.neutral);
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBeUndefined();
        ctx.posture = 'crouch';
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe('mGenSlowRun01');
        ctx.posture = 'stand'; controller.setDirectionalLocomotionStyle('rifle');
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe('mGenSlowRun01');
        controller.setDirectionalLocomotionStyle('neutral'); controller.setDirectionalLocomotionEnabled(false);
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe('mGenSlowRun01');
        controller.setDirectionalLocomotionEnabled(true);
        ctx.mixamoStateOverrides.set(AnimationState.RUN, 'userPinnedRun');
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe('userPinnedRun');
        controller.setLocomotionDirection(1, 0); const angle = ctx.locomotionAngle;
        controller.setLocomotionDirection(NaN, 1); controller.setLocomotionDirection(Infinity, 1); controller.setLocomotionDirection(0, 0);
        expect(ctx.locomotionAngle).toBe(angle);
        blend.dispose();
    });
});
