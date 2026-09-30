import { forgedFeatures, findForgedFeature, findForgedFeatures, forgedPathFeature } from 'engine/ForgedLevelData.js';
import type { GameData } from 'types/game.js';

/**
 * Contract tests for the forged-feature lookup.
 *
 * The behaviour under test is what stopped a game loading: a genre module
 * hardcoded a feature name, the designer had named that forge's feature
 * something else, and the constructor threw. So the guarantees here are that a
 * miss returns `null` (never throws), and that a name is matched leniently
 * enough to survive the casing drift of an LLM-authored string.
 */

const gameData = (assets: unknown[]): GameData => ({ assets } as unknown as GameData);

const forged = gameData([
    {
        id: 'level_1',
        worldForgerFeatures: [
            { kind: 'timeTrial', name: 'SlalomTimeTrial', anchors: [{ name: 'Gate1', x: 1, y: 2, z: 3 }] },
            { kind: 'skiLift', name: 'SummitChairlift', params: { engineAutoBuild: true } },
            { kind: 'path', name: 'SlalomRun', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }] },
        ],
    },
    { id: 'prop_1' },
    { id: 'level_2', worldForgerFeatures: [{ kind: 'door', name: 'LodgeDoor' }] },
]);

describe('forgedFeatures', () => {
    it('flattens every level asset\'s features in designer order', () => {
        expect(forgedFeatures(forged).map(f => f.name))
            .toEqual(['SlalomTimeTrial', 'SummitChairlift', 'SlalomRun', 'LodgeDoor']);
    });

    it('is empty — not a throw — for a game with no forged level', () => {
        expect(forgedFeatures(gameData([{ id: 'prop_1' }]))).toEqual([]);
        expect(forgedFeatures(null)).toEqual([]);
        expect(forgedFeatures(undefined)).toEqual([]);
    });
});

describe('findForgedFeature', () => {
    it('matches by kind', () => {
        expect(findForgedFeature(forged, { kind: 'skiLift' })?.name).toBe('SummitChairlift');
    });

    it('matches by name across assets', () => {
        expect(findForgedFeature(forged, { name: 'LodgeDoor' })?.kind).toBe('door');
    });

    it('folds case — designer casing drifts between forges', () => {
        expect(findForgedFeature(forged, { name: 'slalomtimetrial' })?.kind).toBe('timeTrial');
        expect(findForgedFeature(forged, { kind: 'SKILIFT' })?.name).toBe('SummitChairlift');
    });

    it('requires every provided field to match', () => {
        expect(findForgedFeature(forged, { kind: 'door', name: 'SlalomRun' })).toBeNull();
    });

    it('returns null for a name this forge did not use — the 2026-09-09 P10 crash', () => {
        expect(findForgedFeature(forged, { name: 'SlalomGates' })).toBeNull();
    });
});

describe('findForgedFeatures', () => {
    it('returns every match, empty when there are none', () => {
        expect(findForgedFeatures(forged, { kind: 'path' })).toHaveLength(1);
        expect(findForgedFeatures(forged, { kind: 'elevator' })).toEqual([]);
    });
});

describe('forgedPathFeature', () => {
    it('is the fallback route when a specific feature is missing', () => {
        expect(forgedPathFeature(forged)?.points).toHaveLength(2);
    });

    it('is null on a level with no designed path', () => {
        expect(forgedPathFeature(gameData([{ id: 'l', worldForgerFeatures: [{ kind: 'door' }] }]))).toBeNull();
    });
});
