import * as THREE from 'three';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { SkinnedGrounding, SkinnedHeightFilter, skinnedContactWeight } from 'engine/loaders/SkinnedGrounding.js';
import { resolveSkinnedLegBones } from 'engine/loaders/LegIK.js';
import type { PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { AnimationState, type AnimationContext } from 'engine/animation/AnimationContext.js';
import { clearGameplayTimers } from 'engine/GameplayTimers.js';
import { authoredHipsHeight } from 'engine/loaders/AuthoredHipsHeight.js';

const wp = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());

const planeLockedWorld = { [Symbol.for('bitmagic.planeLockedPhysics')]: true } as unknown as PhysicsWorld;

function rig(parentScale = 1, thighLength = .43, shinLength = .43) {
    const group = new THREE.Group();
    group.position.set(5, 3, -7);
    group.rotation.y = .7;
    group.scale.setScalar(parentScale);
    const root = new THREE.Group(); root.scale.setScalar(.8); group.add(root);
    const unit = 1 / (parentScale * .8);
    const hips = new THREE.Bone(); hips.name = 'mixamorigHips'; hips.position.y = unit; root.add(hips);
    const parts = new Map<string, THREE.Bone>();
    const feet: THREE.Bone[] = [];
    for (const [side, x] of [['left', -.12], ['right', .12]] as const) {
        const thigh = new THREE.Bone(); thigh.position.x = x * unit; hips.add(thigh);
        const shin = new THREE.Bone(); shin.position.set(0, -thighLength * unit, .24 * unit); thigh.add(shin);
        const foot = new THREE.Bone(); foot.position.set(0, -shinLength * unit, -.24 * unit); shin.add(foot);
        foot.rotation.set(.12, .1, .05);
        const toe = new THREE.Bone(); toe.position.set(0, -.08 * unit, .12 * unit); foot.add(toe);
        const prefix = `mixamorig${side === 'left' ? 'Left' : 'Right'}`;
        thigh.name = prefix + 'UpLeg'; shin.name = prefix + 'Leg'; foot.name = prefix + 'Foot'; toe.name = prefix + 'ToeBase';
        feet.push(foot, toe);
        parts.set(`${side}Thigh`, thigh); parts.set(`${side}Shin`, shin); parts.set(`${side}Foot`, foot);
    }
    group.updateMatrixWorld(true);
    const grounding = new SkinnedGrounding(root, hips, feet);
    const controller = new CharacterAnimationController();
    jest.spyOn(controller, 'getPoseDeltaSeconds').mockReturnValue(1 / 120);
    const pose = (t: number) => {
        for (const side of ['left', 'right']) {
            parts.get(`${side}Thigh`)!.quaternion.identity();
            parts.get(`${side}Shin`)!.rotation.set(.35 * Math.sin(t * Math.PI * 6), 0, 0);
            parts.get(`${side}Foot`)!.rotation.set(.12, .1, .05);
        }
        group.updateMatrixWorld(true);
    };
    return { group, root, hips, feet, parts, grounding, controller, pose };
}

type Rig = ReturnType<typeof rig>;

const lowestFoot = (r: Rig) => Math.min(...r.feet.map(foot => wp(foot).y));

/** Where the hips sit under the legacy exact lowest-foot placement, i.e. with no damping. */
const undampedHips = (r: Rig, ground = 3, lift = 0) => wp(r.hips).y + ground + lift - lowestFoot(r);

const place = (r: Rig, { ground = 3, lift = 0, world, authored = null }:
    { ground?: number; lift?: number; world?: PhysicsWorld; authored?: number | null } = {}) =>
    r.grounding.place(ground, lift, 1.8, r.controller, world, r.group, authored);

/** Pose the rig, ground it, and report the resulting hip height. */
function sampleHips(r: Rig, time: number): number {
    r.pose(time);
    place(r);
    return wp(r.hips).y;
}

/** How far grounding moved the hips away from the undamped placement. */
function sampleOffset(r: Rig, time: number): number {
    r.pose(time);
    const raw = undampedHips(r);
    place(r);
    return wp(r.hips).y - raw;
}

/** A track-B action player held at a fixed blend weight. Returns the controller
 * spy so a test can make the action disappear again. */
function mockActionPlayer(r: Rig, weight = 1) {
    const action = new MixamoAnimationPlayer();
    jest.spyOn(action, 'getBlendWeight').mockReturnValue(weight);
    return jest.spyOn(r.controller, 'getTrackBMixamoPlayer').mockReturnValue(action);
}

function mockFootIkBinding(r: Rig): void {
    jest.spyOn(r.controller, 'getFootIkTargets').mockReturnValue({
        left: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
        right: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }, facing: new THREE.Quaternion(),
    });
}

/** Real attack lifecycle and fade weights, with tiny locally authored clips.
 * The visible test rig is posed separately to isolate grounding from retargeting. */
function attackController(r: Rig): void {
    jest.spyOn(r.controller, 'getPoseDeltaSeconds').mockRestore();
    const ctx = (r.controller as unknown as { ctx: AnimationContext }).ctx;
    ctx.character = r.root.clone(true);
    ctx.mixer = new THREE.AnimationMixer(ctx.character);
    ctx.isInitialized = true;
    for (const name of ['idle', 'walk', 'run', 'swing']) {
        const player = new MixamoAnimationPlayer();
        const track = new THREE.QuaternionKeyframeTrack('mixamorigLeftUpLeg.quaternion',
            [0, 1], [0, 0, 0, 1, .1, 0, 0, Math.sqrt(.99)]);
        expect(player.loadFromGLTF(r.root.clone(true), [new THREE.AnimationClip(name, 1, [track])],
            new THREE.Scene(), ctx.character, 1.8, { retainFullSkeleton: true })).toBe(true);
        ctx.mixamoAnimationPlayers.set(name, player);
    }
    for (const state of [AnimationState.IDLE, AnimationState.WALK, AnimationState.RUN]) {
        ctx.mixamoStateOverrides.set(state, state);
    }
    expect(r.controller.registerCustomAttack({ name: 'swing', animationMotionId: 'swing',
        type: 'attack', splitBodyOnRun: true })).toBe(true);
}

describe('bounded visual height damping', () => {
    afterEach(() => clearGameplayTimers());
    describe.each([.01, 1, 2])('render-root feedback at parent scale %s', scale => {
        it.each([30, 60, 144])('keeps source motion and body height stable over 10 seconds at %s fps', fps => {
            const r = rig(scale), source = new MixamoAnimationPlayer();
            const sceneRoot = new THREE.Group(), hips = new THREE.Bone();
            hips.name = 'mixamorigHips'; hips.position.y = 100; sceneRoot.add(hips);
            const track = new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, .5, 1],
                [0, 100, 0, 0, 110, 0, 0, 100, 0]);
            expect(source.loadFromGLTF(sceneRoot, [new THREE.AnimationClip('bob', 1, [track])],
                new THREE.Scene(), r.root, 1.8, { retainFullSkeleton: true })).toBe(true);
            source.setLoop(true);
            source.play();
            jest.spyOn(r.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / fps);
            const restHeight = wp(r.hips).y - lowestFoot(r);
            const filter = new SkinnedHeightFilter();
            const sourceHips = source.getBoneMap().get(hips.name)!;
            const pose = new Map([[hips.name, { position: new THREE.Vector3(), rotation: new THREE.Quaternion() }]]);
            // Real players/NPCs track this adjusted render root, not the capsule.
            r.root.position.y = -.4 / scale;
            try {
                for (let i = 0; i < fps * 10; i++) {
                    const ground = i < fps * 3 ? 3 : i < fps * 6 ? 3.4 : -20;
                    r.group.position.y = ground; r.group.rotation.y = Math.floor(i / fps) * Math.PI / 4;
                    r.pose(i / fps);
                    source.update(1 / fps);
                    sourceHips.getWorldPosition(pose.get(hips.name)!.position);
                    const localMotion = (sourceHips.position.y - 100) * source.getSkeletonRoot()!.scale.y;
                    const authored = authoredHipsHeight(pose, source, r.group, hips.name)!;
                    expect(authored.offset).toBeCloseTo(localMotion, 8);
                    const expected = ground + restHeight + localMotion + filter.sample(restHeight + localMotion, 1.8, 1 / fps);
                    const physicsPosition = r.group.position.clone(), physicsRotation = r.group.quaternion.clone();
                    place(r, { ground, authored: authored.offset });
                    expect(wp(r.hips).y).toBeCloseTo(expected, 8);
                    expect(r.group.position).toEqual(physicsPosition);
                    expect(r.group.quaternion.toArray()).toEqual(physicsRotation.toArray());
                }
            } finally { source.dispose(); r.controller.dispose(); }
        });
    });

    it.each(['mixamorig', 'mixamorig2'])('resolves %s ankles, never the block-preferred toes', prefix => {
        const r = rig();
        r.root.traverse(bone => { bone.name = bone.name.replace('mixamorig', prefix); });
        expect(resolveSkinnedLegBones(r.root, 'left')?.foot).toBe(r.parts.get('leftFoot'));
        expect(resolveSkinnedLegBones(r.root, 'right')?.foot).toBe(r.parts.get('rightFoot'));
        r.parts.get('leftFoot')!.name = 'unrecognizedAnkle';
        expect(resolveSkinnedLegBones(r.root, 'left')).toBeNull();
    });
    it('is time-based, bounded and resettable, with no warm-up displacement', () => {
        const sample = (hz: number) => {
            const f = new SkinnedHeightFilter();
            expect(f.sample(1, 1.8, 1 / hz)).toBe(0);
            let offset = 0;
            for (let i = 0; i < hz / 4; i++) {
                offset = f.sample(1.1, 1.8, 1 / hz);
                expect(Math.abs(offset)).toBeLessThan(1.8 * .022);
            }
            f.reset(); expect(f.sample(1.4, 1.8, 1 / hz)).toBe(0);
            expect(f.sample(.2, 1.8, 1 / hz)).toBe(0); // pose discontinuity
            expect(f.sample(.3, 1.8, 1)).toBe(0); // resumed after a long gap
            return offset;
        };
        expect(sample(120)).toBeCloseTo(sample(60), 10);
        expect(sample(60)).toBeCloseTo(sample(24), 10);
    });

    it.each([.01, .5, 1, 2])('damps bob while preserving ankle paths and rotations at parent scale %s', scale => {
        const r = rig(scale);
        const rawHeights: number[] = [], heights: number[] = [];
        for (let i = 0; i < 240; i++) {
            r.pose(i / 120);
            const ground = 3;
            const lift = .12 * Math.max(0, Math.sin(i / 120 * Math.PI * 6));
            const rawShift = ground + lift - lowestFoot(r);
            const expected = r.feet.map(foot => wp(foot).add(new THREE.Vector3(0, rawShift, 0)));
            const rotations = r.feet.map(foot => foot.getWorldQuaternion(new THREE.Quaternion()));
            rawHeights.push(wp(r.hips).y + rawShift);
            const groupPosition = r.group.position.clone(), rootRotation = r.root.quaternion.clone();
            place(r, { ground, lift });
            heights.push(wp(r.hips).y);
            for (let j = 0; j < r.feet.length; j++) {
                expect(wp(r.feet[j]!).distanceTo(expected[j]!)).toBeLessThan(1e-5);
                expect(r.feet[j]!.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotations[j]!)).toBeLessThan(1e-6);
            }
            expect(r.group.position).toEqual(groupPosition);
            expect(r.root.quaternion.toArray()).toEqual(rootRotation.toArray());
        }
        const span = (a: number[]) => Math.max(...a.slice(120)) - Math.min(...a.slice(120));
        expect(span(heights)).toBeLessThan(span(rawHeights) * .9);
    });

    it.each([[.30, .55], [.55, .30], [.35, .35]])('keeps ankle paths for thigh/shin proportions %s/%s', (thigh, shin) => {
        const r = rig(.01, thigh, shin);
        for (let i = 0; i < 120; i++) {
            r.pose(i / 120);
            const shift = 3 - lowestFoot(r);
            const expected = r.feet.map(foot => wp(foot).add(new THREE.Vector3(0, shift, 0)));
            place(r);
            for (let j = 0; j < r.feet.length; j++) expect(wp(r.feet[j]!).distanceTo(expected[j]!)).toBeLessThan(1e-5);
        }
    });

    it('moves immediately with the ground reference instead of smoothing physics steps or teleports', () => {
        const r = rig(.01);
        const sample = (ground: number) => {
            r.pose(0);
            place(r, { ground });
            return wp(r.hips).y;
        };
        const baseline = sample(3);
        expect(sample(3.4) - baseline).toBeCloseTo(.4, 8);
        expect(sample(30) - baseline).toBeCloseTo(27, 8);
        expect(sample(-5) - baseline).toBeCloseTo(-8, 8);
    });

    it.each(['airborne', 'binding', 'crouch', 'fullBodyAction', 'actionLayer', 'priority', '2d'])('does not damp %s poses', mode => {
        const r = rig();
        place(r);
        if (mode === 'airborne') jest.spyOn(r.controller, 'getPoseGrounded').mockReturnValue(false);
        if (mode === 'crouch') jest.spyOn(r.controller, 'getPosture').mockReturnValue('crouch');
        if (mode === 'binding') mockFootIkBinding(r);
        if (mode === 'fullBodyAction') jest.spyOn(r.controller, 'getIsPlayingCustomAnimation').mockReturnValue(true);
        if (mode === 'actionLayer') {
            jest.spyOn(r.controller, 'getActionBoneMap').mockReturnValue(new Map());
            jest.spyOn(r.controller, 'getActionBlend').mockReturnValue({ upperBody: 1, lowerBody: 1 });
        }
        if (mode === 'priority') jest.spyOn(r.controller, 'isPriorityAnimationPlaying').mockReturnValue(true);
        const world = mode === '2d' ? planeLockedWorld : undefined;
        r.pose(.07);
        const expected = undampedHips(r, 3, .2);
        place(r, { lift: .2, world });
        expect(wp(r.hips).y).toBeCloseTo(expected, 8);
    });

    it.each([AnimationState.IDLE, AnimationState.ATTACK])('uses lower-body mask and fade weight in %s', state => {
        const sample = (weight: number, lowerBody: number) => {
            const r = rig();
            jest.spyOn(r.controller, 'getCurrentState').mockReturnValue(state);
            place(r);
            mockActionPlayer(r, weight);
            jest.spyOn(r.controller, 'getCustomAnimationBodyBlend').mockReturnValue({ upperBody: 1, lowerBody });
            return sampleOffset(r, .18);
        };
        const normal = sample(0, 1);
        expect(Math.abs(normal)).toBeGreaterThan(.001);
        expect(sample(1, 0)).toBeCloseTo(normal, 8);
        expect(sample(1, .5)).toBeCloseTo(normal * .5, 8);
        expect(sample(.5, 1)).toBeCloseTo(normal * .5, 8);
        expect(sample(1, 1)).toBeCloseTo(0, 8);
    });

    describe.each([15, 30, 60, 120])('real attack transitions at %i fps', fps => {
        it.each([0, 2, 5])('keeps the torso continuous through an upper-body attack at speed %s', speed => {
            const r = rig(), control = rig();
            attackController(r);
            jest.spyOn(control.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / fps);
            let sawAttack = false, sawCompletion = false;
            for (let i = 0; i < fps * 3; i++) {
                r.controller.updateAnimation(speed > 0, speed, true, false, speed > 0);
                r.controller.update(1 / fps);
                const before = sampleHips(r, i / fps);
                expect(before).toBeCloseTo(sampleHips(control, i / fps), 7);
                if (i === fps) {
                    // Stationary upper-body actions may supply an explicit mask;
                    // walking/running weapons must apply their own split automatically.
                    if (speed === 0) r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody: 0 });
                    expect(r.controller.startNamedAttack('swing').success).toBe(true);
                    expect(r.controller.getCurrentState()).toBe(AnimationState.ATTACK);
                    expect(r.controller.getCustomAnimationBodyBlend()?.lowerBody).toBe(0);
                    r.controller.update(0);
                    expect(sampleHips(r, i / fps)).toBeCloseTo(before, 7);
                }
                sawAttack ||= r.controller.getCurrentState() === AnimationState.ATTACK;
                sawCompletion ||= sawAttack && r.controller.getTrackBMixamoPlayer() === null;
            }
            expect(sawAttack).toBe(true); expect(sawCompletion).toBe(true);
            r.controller.dispose(); control.controller.dispose();
        });

        it('fades damping out and back with a stationary full-body attack', () => {
            const r = rig(), control = rig();
            attackController(r);
            jest.spyOn(control.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / fps);
            sampleOffset(r, 0); sampleOffset(control, 0);
            expect(r.controller.startNamedAttack('swing').success).toBe(true);
            expect(r.controller.getCustomAnimationBodyBlend()).toBeNull();
            let sawFullWeight = false, sawFade = false;
            for (let i = 0; i < fps * 2; i++) {
                r.controller.update(1 / fps);
                const weight = r.controller.getTrackBMixamoPlayer()?.getBlendWeight() ?? 0;
                // This pose needs a negative correction, so the leg-extension
                // safety bound cannot obscure the action-weight assertion.
                expect(sampleOffset(r, .18)).toBeCloseTo(sampleOffset(control, .18) * (1 - weight), 7);
                sawFullWeight ||= weight === 1;
                sawFade ||= weight > 0 && weight < 1;
            }
            expect(sawFullWeight).toBe(true); expect(sawFade).toBe(true);
            expect(r.controller.getIsAttacking()).toBe(false);
            r.controller.dispose(); control.controller.dispose();
        });

        it('does not pop when movement releases the legs during a full-body swing', () => {
            const r = rig(); attackController(r);
            expect(r.controller.startNamedAttack('swing').success).toBe(true);
            const frames = Math.ceil(fps * .25);
            for (let i = 0; i <= frames; i++) { r.controller.update(1 / fps); sampleHips(r, i / fps); }
            const before = wp(r.hips).y;
            expect(r.controller.getTrackBMixamoPlayer()?.getBlendWeight()).toBe(1);
            r.controller.updateAnimation(true, 5, true, false, true);
            expect(r.controller.getCustomAnimationBodyBlend()?.lowerBody).toBe(0);
            r.controller.update(0);
            expect(sampleHips(r, frames / fps)).toBeCloseTo(before, 7);
            r.controller.dispose();
        });
    });

    describe.each([15, 30, 60, 120, 144])('full-body action lifecycle at %i fps', fps => {
        it.each(['cancel', 'replay', 'replace', 'restart', 'instantReplace'])
        ('preserves the displayed torso through %s without a preceding mask handoff', event => {
            const r = rig(); attackController(r);
            expect(r.controller.startNamedAttack('swing').success).toBe(true);
            const frames = Math.ceil(.3 * fps), time = frames / fps;
            for (let i = 0; i <= frames; i++) { r.controller.update(1 / fps); sampleHips(r, i / fps); }
            expect(r.controller.getTrackBMixamoPlayer()?.getBlendWeight()).toBe(1);
            expect(r.controller.getCustomAnimationBodyBlend()).toBeNull();
            const before = wp(r.hips).y;
            if (event === 'replace' || event === 'instantReplace') {
                expect(r.controller.playCustomAnimation('walk', {
                    fadeInDuration: event === 'instantReplace' ? 0 : .1,
                }).success).toBe(true);
            } else if (event === 'restart') {
                // The player object and mask stay the same; only its play revision changes.
                expect(r.controller.playCustomAnimation('swing', { fadeInDuration: .1 }).success).toBe(true);
            } else {
                r.controller.stopCustomAnimation(); r.controller.endAttack();
                if (event === 'replay') expect(r.controller.startNamedAttack('swing').success).toBe(true);
            }
            // Repeated zero-delta renders cannot advance or restart the handoff.
            for (let i = 0; i < 4; i++) {
                r.controller.update(0);
                expect(sampleHips(r, time)).toBeCloseTo(before, 7);
            }
            r.controller.dispose();
        });
    });

    it.each([24, 60, 144])('finishes and can interrupt lifecycle handoffs at %i fps', fps => {
        const r = rig(), control = rig(); attackController(r);
        const dt = jest.spyOn(r.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / fps);
        jest.spyOn(control.controller, 'getPoseDeltaSeconds').mockImplementation(() => r.controller.getPoseDeltaSeconds());
        // Pose .18 needs a negative correction: no leg-extension clamp obscuring weight.
        const sample = (subject: Rig) => sampleOffset(subject, .18);
        place(r); place(control);
        expect(r.controller.startNamedAttack('swing').success).toBe(true);
        for (let i = 0; i < Math.ceil(.15 * fps); i++) {
            r.controller.update(1 / fps); sample(r); sample(control);
        }
        expect(r.controller.getTrackBMixamoPlayer()?.getBlendWeight()).toBe(1);
        const before = sample(r); sample(control);
        r.controller.stopCustomAnimation(); r.controller.endAttack();
        dt.mockReturnValue(0);
        expect(sample(r)).toBeCloseTo(before, 8); sample(control);
        // Partway back to locomotion, start another full-body action. Its first
        // zero-weight frame must not discard the cancellation's displayed blend.
        dt.mockReturnValue(.04);
        const partial = sample(r); sample(control);
        expect(Math.abs(partial)).toBeGreaterThan(.0001);
        expect(r.controller.playCustomAnimation('swing', { fadeInDuration: .1 }).success).toBe(true);
        dt.mockReturnValue(0);
        expect(sample(r)).toBeCloseTo(partial, 8); sample(control);
        dt.mockReturnValue(1 / fps);
        for (let i = 0; i < Math.ceil(.12 * fps); i++) {
            r.controller.update(1 / fps); sample(r); sample(control);
        }
        expect(r.controller.getTrackBMixamoPlayer()?.getBlendWeight()).toBe(1);
        expect(sample(r)).toBeCloseTo(0, 8); sample(control);
        r.controller.stopCustomAnimation(); r.controller.endAttack();
        dt.mockReturnValue(0);
        expect(sample(r)).toBeCloseTo(0, 8); sample(control);
        dt.mockReturnValue(1 / fps);
        for (let i = 0; i < Math.ceil(.1 * fps); i++) { sample(r); sample(control); }
        // Exact terminal weight, not a residual exponential tail.
        dt.mockReturnValue(0);
        expect(sample(r)).toBeCloseTo(sample(control), 8);
        r.controller.dispose(); control.controller.dispose();
    });

    it('restarts an interrupted mask handoff from its displayed influence and finishes exactly', () => {
        const r = rig();
        jest.spyOn(r.controller, 'getCurrentState').mockReturnValue(AnimationState.ATTACK);
        mockActionPlayer(r);
        const dt = jest.spyOn(r.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / 60);
        const sample = () => sampleHips(r, .18);
        r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody: 1 });
        place(r);
        const fullBody = sample();
        r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody: 0 });
        dt.mockReturnValue(0); expect(sample()).toBeCloseTo(fullBody, 8);
        dt.mockReturnValue(.04); const partial = sample();
        expect(Math.abs(partial - fullBody)).toBeGreaterThan(.0001);
        // Reverse before the first handoff finishes: no jump to either endpoint.
        r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody: 1 });
        dt.mockReturnValue(0); expect(sample()).toBeCloseTo(partial, 8);
        dt.mockReturnValue(.1); expect(sample()).toBeCloseTo(fullBody, 8);
    });

    it.each(['airborne', 'binding', 'crouch', '2d', 'reset', 'longFrame', 'invalidDelta'])
    ('clears a pending attack-mask handoff on %s', mode => {
        const r = rig();
        jest.spyOn(r.controller, 'getCurrentState').mockReturnValue(AnimationState.ATTACK);
        mockActionPlayer(r);
        const dt = jest.spyOn(r.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / 60);
        r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody: 1 });
        place(r);
        sampleHips(r, .18);
        r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody: 0 });
        sampleHips(r, .18);
        dt.mockReturnValue(.04);
        sampleHips(r, .18);
        if (mode === 'airborne') jest.spyOn(r.controller, 'getPoseGrounded').mockReturnValue(false);
        if (mode === 'binding') mockFootIkBinding(r);
        if (mode === 'crouch') r.controller.setPosture('crouch');
        if (mode === 'reset') r.grounding.reset();
        if (mode === 'longFrame') dt.mockReturnValue(1);
        if (mode === 'invalidDelta') dt.mockReturnValue(NaN);
        const world = mode === '2d' ? planeLockedWorld : undefined;
        r.pose(.18);
        const expected = undampedHips(r);
        place(r, { world });
        expect(wp(r.hips).y).toBeCloseTo(expected, 8);
        expect(r.root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    });

    it.each([0, 1])('finishes a pending mask handoff when the action disappears (initial lower mask %s)', lowerBody => {
        const r = rig();
        const player = mockActionPlayer(r);
        const dt = jest.spyOn(r.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / 60);
        const sample = () => sampleHips(r, .18);
        r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody });
        place(r);
        sample();
        r.controller.setCustomAnimationBodyBlend({ upperBody: 1, lowerBody: 1 - lowerBody });
        dt.mockReturnValue(0); sample();
        dt.mockReturnValue(.04); const before = sample();
        player.mockReturnValue(null); r.controller.setCustomAnimationBodyBlend(null);
        dt.mockReturnValue(0); expect(sample()).toBeCloseTo(before, 8);
        // After the handoff, the unmasked filter is fully authoritative again.
        dt.mockReturnValue(.1); const completed = sample();
        dt.mockReturnValue(0); expect(sample()).toBeCloseTo(completed, 8);
        expect(Number.isFinite(completed)).toBe(true);
    });

    it('does not turn wall or high edge hits into root height/tilt', () => {
        const r = rig();
        const world = { raycast: (_origin: THREE.Vector3, _dir: THREE.Vector3, _length: number,
            _mask: number, out: RaycastResult) => {
            out.hasHit = true; out.hitPoint.set(0, 3.8, 0); out.hitNormal.set(1, 0, 0);
        } } as unknown as PhysicsWorld;
        place(r);
        const before = wp(r.hips), rotation = r.root.quaternion.clone();
        for (let i = 0; i < 30; i++) {
            r.pose(0);
            place(r, { world });
        }
        expect(wp(r.hips).distanceTo(before)).toBeLessThan(1e-8);
        expect(r.root.quaternion.toArray()).toEqual(rotation.toArray());
        expect(r.grounding.footPlants.left.isPlanted).toBe(false);
    });
});

describe('contact is distinct from flight displacement', () => {
    it('keeps centimetre-scale idle/walk toe lifts in contact without suppressing true flight', () => {
        expect(skinnedContactWeight(.017, 1.75)).toBe(1);
        expect(skinnedContactWeight(.022, 1.75)).toBe(1);
        expect(skinnedContactWeight(.04, 1.75)).toBeGreaterThan(0);
        expect(skinnedContactWeight(.04, 1.75)).toBeLessThan(1);
        expect(skinnedContactWeight(.22, 1.75)).toBe(0);
        expect(skinnedContactWeight(.02, .875)).toBe(skinnedContactWeight(.04, 1.75));
    });
});

describe('authored pelvis owns skinned body height', () => {
    it.each([.01, .5, 1, 2])('does not apply the opposite foot contact correction to a clear swing leg at scale %s', scale => {
        const r = rig(scale);
        for (const pitch of [-.5, 0, .5, 1]) for (const lift of [0, .03, .059, .09]) {
            r.pose(0);
            r.parts.get('leftThigh')!.rotation.x = -1;
            r.parts.get('leftShin')!.rotation.x = 1.2;
            r.parts.get('leftFoot')!.quaternion.identity();
            r.parts.get('rightFoot')!.rotation.x = pitch;
            r.group.updateMatrixWorld(true);
            const foot = r.parts.get('leftFoot')!;
            const relative = wp(foot).sub(wp(r.hips));
            const rotation = foot.getWorldQuaternion(new THREE.Quaternion());
            place(r, { authored: 0, lift });
            expect(wp(foot).y - 3).toBeGreaterThan(.2);
            expect(wp(foot).sub(wp(r.hips)).distanceTo(relative)).toBeLessThan(1e-6);
            expect(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation)).toBeLessThan(1e-6);
        }
    });

    it.each([.01, .5, 1, 2])('does not bob from ankle angles or changing support joints, parent scale %s', scale => {
        const r = rig(scale);
        place(r, { authored: 0 });
        const hips = wp(r.hips).y, anchor = r.group.position.clone();
        for (let i = 0; i <= 180; i++) {
            r.pose(i / 180);
            // Both toe/ankle support switches and different leg extension slack
            // used to feed back into root height. Keep authored pelvis fixed.
            for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
                r.parts.get(`${side}Foot`)!.rotation.x = sign * (i - 90) * Math.PI / 180;
            }
            r.group.updateMatrixWorld(true);
            const rotations = r.feet.map(foot => foot.getWorldQuaternion(new THREE.Quaternion()));
            place(r, { authored: 0 });
            expect(wp(r.hips).y).toBeCloseTo(hips, 9);
            expect(r.group.position).toEqual(anchor);
            expect(r.root.rotation.x).toBe(0); expect(r.root.rotation.z).toBe(0);
            r.feet.forEach((foot, j) => expect(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotations[j]!)).toBeLessThan(1e-6));
        }
    });

    it.each([30, 60, 120, 144])('follows source vertical motion continuously at %s FPS without clipping to leg reach', fps => {
        const r = rig();
        jest.spyOn(r.controller, 'getPoseDeltaSeconds').mockReturnValue(1 / fps);
        r.pose(0); place(r, { authored: 0 });
        const rest = wp(r.hips).y;
        let before = rest;
        for (let i = 1; i <= fps * 2; i++) {
            r.pose(i / fps);
            const offset = .04 * Math.sin(i / fps * 2 * Math.PI);
            place(r, { authored: offset });
            const current = wp(r.hips).y;
            expect(Math.abs(current - before)).toBeLessThan(.3 / fps);
            expect(Math.abs(current - rest)).toBeLessThan(.041);
            before = current;
        }
    });

    it('moves immediately with physics ground height, including under rotated/scaled parents', () => {
        const r = rig(.01);
        r.pose(0); place(r, { authored: .05 });
        const before = wp(r.hips).y;
        for (const ground of [3.4, -5, 30, 3]) {
            r.pose(0); place(r, { ground, authored: .05 });
            expect(wp(r.hips).y - before).toBeCloseTo(ground - 3, 9);
        }
    });

    it('preserves airborne source height and ankle rotations without inventing contact', () => {
        const r = rig();
        jest.spyOn(r.controller, 'getPoseGrounded').mockReturnValue(false);
        r.pose(0); place(r, { authored: 0 });
        const before = wp(r.hips).y;
        r.pose(.12);
        const rotations = r.feet.map(foot => foot.getWorldQuaternion(new THREE.Quaternion()));
        place(r, { authored: .2, lift: .3 });
        expect(wp(r.hips).y - before).toBeCloseTo(.2, 8);
        r.feet.forEach((foot, i) => expect(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotations[i]!)).toBeLessThan(1e-6));
        expect(r.grounding.footPlants.left.isPlanted).toBe(false);
    });

    it('does not override explicit foot bindings with the source pelvis height', () => {
        const r = rig(); mockFootIkBinding(r);
        r.pose(.1);
        const expected = undampedHips(r);
        place(r, { authored: .3 });
        expect(wp(r.hips).y).toBeCloseTo(expected, 9);
    });
});
