import {
    ALL_BUILTIN_MOTION_IDS,
    POSTURE_MOVES,
    POSTURE_ACTIONS,
    DIRECTIONAL_MOVES,
    RANGED_MOVES,
    UNARMED_MOVES,
    getBuiltinAnimationDef,
} from 'engine/AnimationPacks.js';
import { animationAssets } from 'engine/AnimationAssets.js';
import { DEFAULT_ANIMATION_TEST_CYCLER_OPTIONS } from 'debug/AnimationTestCycler.js';

/**
 * Every clip the engine ships must be reachable BY ID.
 *
 * `playCustomAnimation(id)` lazy-loads through `getBuiltinAnimationDef`, so a
 * clip missing from that table can only ever play as a side effect of the
 * system that owns its pack — entering the posture, equipping the gun. The
 * posture, directional, melee and ranged packs were all missing, which is why
 * "play every animation" showed the standing clips and nothing else.
 */

const packIds = [
    ...Object.values(POSTURE_MOVES).flatMap((set) => [set.hold, ...('move' in set ? [set.move] : [])]),
    ...Object.values(POSTURE_ACTIONS),
    ...Object.values(DIRECTIONAL_MOVES),
    ...Object.values(RANGED_MOVES),
    ...Object.values(UNARMED_MOVES),
];

describe('built-in animation id lookup', () => {
    it('resolves every pack clip, so playCustomAnimation can lazy-load it', () => {
        const unresolved = packIds.filter((id) => !getBuiltinAnimationDef(id));
        expect(unresolved).toEqual([]);
    });

    it('gives every resolved clip a URL to load from', () => {
        for (const id of packIds) {
            expect(getBuiltinAnimationDef(id)?.animationUrl).toBeTruthy();
        }
    });

    it('uses the imported walk and shared run without changing locomotion IDs or design speeds', () => {
        for (const [id, file, speed] of [
            ['mGenWalk01', 'Walking.glb', 1.8],
            ['mGenSlowRun01', 'Running.glb', 3.5],
            ['mGenFastRun01', 'Running.glb', 5],
        ] as const) {
            const definition = getBuiltinAnimationDef(id)!;
            expect(definition.animationUrl).toMatch(/\/captured_locomotion\/\d{8}-\d{6}\//);
            expect(definition.animationUrl.endsWith(`/${file}`)).toBe(true);
            expect(definition.designSpeed).toBe(speed);
            expect(definition.source).toBe('mixamo');
            expect(definition.animationUrl).toBe(animationAssets.generatedAnimations.find(a => a.motionId === id)?.url);
        }
        expect(getBuiltinAnimationDef('mGenSlowRun01')!.animationUrl).toBe(getBuiltinAnimationDef('mGenFastRun01')!.animationUrl);
    });

    it('keeps the legacy CDN locomotion IDs on their original assets', () => {
        expect(getBuiltinAnimationDef('mWalkDefault01')!.animationUrl).toBe(`${animationAssets.animationBaseUrl}/NewWalk.glb`);
        for (const id of ['mQdKavT8ahiz', 'm9YxTKJfRZWu']) {
            expect(getBuiltinAnimationDef(id)!.animationUrl).toBe(`${animationAssets.animationBaseUrl}/NewRun.glb`);
        }
    });
});

describe('play-every-animation coverage', () => {
    it('the debug cycler walks the postures, strafes and weapon holds too', () => {
        for (const id of packIds) {
            expect(ALL_BUILTIN_MOTION_IDS).toContain(id);
        }
        expect(DEFAULT_ANIMATION_TEST_CYCLER_OPTIONS.motionIds).toBe(ALL_BUILTIN_MOTION_IDS);
    });

    it('lists each id once', () => {
        expect(new Set(ALL_BUILTIN_MOTION_IDS).size).toBe(ALL_BUILTIN_MOTION_IDS.length);
    });
});
