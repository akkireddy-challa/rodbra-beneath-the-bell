/**
 * Unit tests for the PURE config-resolution side of the pre-play selection
 * framework (resolveStartScreenSelections / defaultPick). Resolution is
 * deliberately free of i18n/DOM dependencies (the translated default heading
 * is applied by the DOM builder), so this runs under the node environment.
 * The DOM builder and the StartScreen presentation lifecycle are
 * runtime-verified — they need a real document + game runtime.
 */
import { resolveStartScreenSelections, defaultPick } from 'engine/ui/SelectionSteps.js';
import type { GameData, StartScreenSelection, WorldProfileData } from 'types/game.js';

const game = (wp: Partial<WorldProfileData>): GameData => ({ worldProfileData: wp } as GameData);

const LEVELS = [
    { id: 'l1', name: 'Meadow', vwldAssetId: 'a1' },
    { id: 'l2', name: 'Caves', vwldAssetId: 'a2' },
    { id: 'l3', name: 'Peak', vwldAssetId: 'a3' },
];

const withSelections = (selections: StartScreenSelection[], levels = LEVELS): GameData =>
    game({ levels, hud: { startScreen: { selections } } });

describe('resolveStartScreenSelections', () => {
    test('absent/empty config → no steps (every existing game)', () => {
        expect(resolveStartScreenSelections(null)).toEqual({ levelStep: null, choiceSteps: [] });
        expect(resolveStartScreenSelections(game({}))).toEqual({ levelStep: null, choiceSteps: [] });
        expect(resolveStartScreenSelections(withSelections([]))).toEqual({ levelStep: null, choiceSteps: [] });
    });

    test('level step offers all levels by default, in registry order', () => {
        const { levelStep } = resolveStartScreenSelections(withSelections([{ id: 'level', type: 'level' }]));
        expect(levelStep).not.toBeNull();
        expect(levelStep!.options.map((o) => o.id)).toEqual(['l1', 'l2', 'l3']);
        expect(levelStep!.options[0]!.label).toBe('Meadow');
        expect(levelStep!.kind).toBe('level');
        // No authored title → '' (the DOM builder applies the translated default).
        expect(levelStep!.title).toBe('');
    });

    test('levelIds filters the offered levels; unknown ids are skipped', () => {
        const { levelStep } = resolveStartScreenSelections(withSelections([
            { id: 'level', type: 'level', levelIds: ['l3', 'l1', 'ghost'] },
        ]));
        // Registry order, not levelIds order; 'ghost' dropped.
        expect(levelStep!.options.map((o) => o.id)).toEqual(['l1', 'l3']);
    });

    test('level step is dropped when fewer than 2 levels are offered, or game has no levels[]', () => {
        expect(resolveStartScreenSelections(withSelections([
            { id: 'level', type: 'level', levelIds: ['l1'] },
        ])).levelStep).toBeNull();
        expect(resolveStartScreenSelections(withSelections(
            [{ id: 'level', type: 'level' }],
            [],
        )).levelStep).toBeNull();
    });

    test('only the first level step is kept', () => {
        const { levelStep, choiceSteps } = resolveStartScreenSelections(withSelections([
            { id: 'level-a', type: 'level' },
            { id: 'level-b', type: 'level' },
        ]));
        expect(levelStep!.id).toBe('level-a');
        expect(choiceSteps).toEqual([]);
    });

    test('choice steps keep authored order and need ≥ 2 valid options', () => {
        const { choiceSteps } = resolveStartScreenSelections(withSelections([
            {
                id: 'difficulty', type: 'choice', title: 'Difficulty',
                options: [{ id: 'easy', label: 'Easy' }, { id: 'hard', label: 'Hard' }],
            },
            { id: 'broken', type: 'choice', options: [{ id: 'only', label: 'Only' }] },
            {
                id: 'team', type: 'choice',
                options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }, { id: '', label: 'bad' }],
            },
        ]));
        expect(choiceSteps.map((s) => s.id)).toEqual(['difficulty', 'team']);
        expect(choiceSteps[0]!.title).toBe('Difficulty');
        expect(choiceSteps[1]!.options.map((o) => o.id)).toEqual(['red', 'blue']);
    });

    test('steps without an id or with an unknown type are dropped', () => {
        const { levelStep, choiceSteps } = resolveStartScreenSelections(withSelections([
            { id: '', type: 'choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
            { id: 'x', type: 'mystery' } as unknown as StartScreenSelection,
        ]));
        expect(levelStep).toBeNull();
        expect(choiceSteps).toEqual([]);
    });
});

describe('defaultPick', () => {
    test('is the first option', () => {
        expect(defaultPick({ id: 's', title: '', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })).toBe('a');
    });
});
