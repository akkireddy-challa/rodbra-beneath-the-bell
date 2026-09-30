/**
 * Generated guest names.
 *
 * Two things are being defended here. First, names already in the wild: a name
 * is derived from an id and stored nowhere, so a change to the generator is a
 * retroactive rename of every guest on every board. Second, the variety the
 * widening was for — one fixed Adjective-Noun-Number template made every guest
 * look like a variation of every other one.
 *
 * ⚠ The vectors below are duplicated in `portal/src/ghost-names.test.ts`. The
 * portal derives the same names from the same ids with its own copy of the
 * generator, and the two drifting would show one player under two names.
 */

import { generatedNameFor, isAnonymousPlayerId } from 'engine/replay/GhostNames.js';

describe('generatedNameFor', () => {
    // PUBLISHED names — on boards, in challenge links, in screenshots players
    // posted. These must never move again.
    const LEGACY: Array<[string, string]> = [
        ['g_0123456789abcdef0123456789abcdef', 'Frozen Stallion 2792'],
        ['g_deadbeef', 'Golden Badger 8713'],
    ];

    const WIDENED: Array<[string, string]> = [
        ['g_v2_0123456789abcdef0123456789abcdef', 'CobaltBullet57'],
        ['g_v2_deadbeefdeadbeefdeadbeefdeadbeef', 'TheSonicCheetah'],
        ['g_v2_00000000000000000000000000000001', 'havoc_kestrel'],
        ['g_v2_ffffffffffffffffffffffffffffffff', 'Rooster8'],
        ['pub_alice', 'TheTalonTurbine'],
        ['jani', 'Ithloix47'],
        ['', 'Marlin90'],
    ];

    it.each(LEGACY)('keeps the name id %s was already racing under', (id, expected) => {
        expect(generatedNameFor(id)).toBe(expected);
    });

    it.each(WIDENED)('derives %s from the widened generator', (id, expected) => {
        expect(generatedNameFor(id)).toBe(expected);
    });

    it('is stable across calls', () => {
        expect(generatedNameFor('g_v2_abc')).toBe(generatedNameFor('g_v2_abc'));
    });

    it('still recognises both guest id generations', () => {
        expect(isAnonymousPlayerId('g_deadbeef')).toBe(true);
        expect(isAnonymousPlayerId('g_v2_deadbeef')).toBe(true);
        expect(isAnonymousPlayerId('pub_alice')).toBe(false);
    });

    describe('variety', () => {
        const sample = Array.from({ length: 400 }, (_, i) => generatedNameFor(`g_v2_${i}`));
        // Collapse a name to its shape: `Vapor_Pilot` and `Marlin_28` are W_W
        // and W_N. This measures the thing that went wrong — every guest in one
        // template — rather than the vocabulary.
        const shapeOf = (name: string): string => name
            .replace(/[A-Z][a-z]*/g, 'W')
            .replace(/[a-z]+/g, 'w')
            .replace(/\d+/g, 'N');

        it('wears at least ten different shapes', () => {
            expect(new Set(sample.map(shapeOf)).size).toBeGreaterThanOrEqual(10);
        });

        it('does not put a number on every name', () => {
            expect(sample.some((name) => !/\d/.test(name))).toBe(true);
            expect(sample.some((name) => /\d/.test(name))).toBe(true);
        });

        it('rarely repeats itself', () => {
            expect(new Set(sample).size).toBeGreaterThanOrEqual(300);
        });

        it('stays a sane length', () => {
            for (const name of sample) {
                expect(name.length).toBeGreaterThanOrEqual(3);
                expect(name.length).toBeLessThanOrEqual(24);
            }
        });
    });
});
