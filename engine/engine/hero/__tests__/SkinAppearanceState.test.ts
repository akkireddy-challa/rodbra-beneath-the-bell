import { SkinAppearanceState } from 'engine/hero/SkinAppearanceState.js';

test('appearance frames replace previous expression, clamp inputs and reject invalid controls', () => {
    const state = new SkinAppearanceState();
    state.setFrame({ browInnerUp: 2, mouthSmileLeft: 1, cheekSquintRight: -1 });
    expect(state.weights.toArray()).toEqual([1, .5, 0]);
    state.setFrame({});
    expect(state.weights.toArray()).toEqual([0, 0, 0]);
    expect(() => state.setFrame({ browInnerUp: NaN })).toThrow('Non-finite');
    expect(state.weights.toArray()).toEqual([0, 0, 0]);
});
