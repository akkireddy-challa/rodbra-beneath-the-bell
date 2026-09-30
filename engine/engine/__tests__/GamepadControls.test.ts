/**
 * @jest-environment jsdom
 *
 * GamepadControls against fake pads: which pad it takes and how it reads the sticks.
 *
 * The browser's mapping is what varies by platform — Chrome on a Mac reports nearly every pad
 * as "standard", Chrome/Edge on Windows only XInput ones, so a DirectInput pad there arrives
 * with an empty mapping. These tests pin down that such a pad is taken with the generic layout
 * rather than ignored, and that a standard pad still wins.
 */

import { GamepadControls } from 'engine/GamepadControls.js';

type FakePad = {
    id: string;
    index: number;
    connected: boolean;
    mapping: string;
    axes: number[];
    buttons: { pressed: boolean; touched: boolean; value: number }[];
    timestamp: number;
};

function pad(index: number, mapping: string, axes: number[], id = `pad-${index}`): FakePad {
    return {
        id, index, connected: true, mapping, axes, timestamp: 0,
        buttons: Array.from({ length: 12 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
}

function withPads(pads: (FakePad | null)[]): void {
    (navigator as unknown as { getGamepads: () => (FakePad | null)[] }).getGamepads = () => pads;
}

/** Controls with the deadzones off, so raw axis values reach moveX/cameraX untouched, polled once. */
function pollOnce(): GamepadControls {
    const gc = new GamepadControls({ stickDeadzone: 0, axisDeadzone: 0 });
    gc.update();
    return gc;
}

/** Enough updates to pass the re-scan throttle. */
function settle(gc: GamepadControls): void {
    for (let i = 0; i < 61; i++) gc.update();
}

describe('GamepadControls pad selection and layouts', () => {
    let gc: GamepadControls | null = null;
    afterEach(() => { gc?.dispose(); gc = null; withPads([]); });

    it('takes a standard pad and reads both sticks from axes 0/1 and 2/3', () => {
        withPads([pad(0, 'standard', [0.8, -0.2, 0.5, 0.1])]);
        gc = pollOnce();
        expect(gc.getGamepadInfo()).toMatchObject({ index: 0, layout: 'standard' });
        expect(gc.moveX).toBeCloseTo(0.8);
        expect(gc.moveY).toBeCloseTo(0.2); // Y inverted: -1 is forward
        expect(gc.cameraX).toBeCloseTo(0.5 * 3);
    });

    it('takes a pad with an empty mapping instead of ignoring it, with the generic layout', () => {
        withPads([pad(0, '', [0.8, -0.2, 0.5, 0.1], 'Generic USB Joystick')]);
        gc = pollOnce();
        expect(gc.getGamepadInfo()).toMatchObject({ index: 0, mapping: '', layout: 'generic' });
        expect(gc.moveX).toBeCloseTo(0.8);
        expect(gc.cameraX).toBeCloseTo(0.5 * 3);
        expect(gc.cameraY).toBeCloseTo(0.1 * 3);
    });

    it('reads a six-axis generic pad\'s right stick from axes 2/5', () => {
        withPads([pad(0, '', [0, 0, 0.4, 0.9, 0.9, -0.3])]);
        gc = pollOnce();
        expect(gc.cameraX).toBeCloseTo(0.4 * 3);
        expect(gc.cameraY).toBeCloseTo(-0.3 * 3);
    });

    it('prefers a standard pad over a generic one when both are present', () => {
        withPads([pad(0, '', [0.9, 0, 0, 0]), pad(1, 'standard', [0.3, 0, 0, 0])]);
        gc = pollOnce();
        expect(gc.getGamepadInfo()).toMatchObject({ index: 1, layout: 'standard' });
        expect(gc.moveX).toBeCloseTo(0.3);
    });

    it('picks up a generic pad that appears later, through the re-scan', () => {
        withPads([]);
        gc = pollOnce();
        expect(gc.getGamepadInfo()).toBeNull();
        withPads([pad(0, '', [0.6, 0, 0, 0])]);
        settle(gc);
        expect(gc.getGamepadInfo()).toMatchObject({ layout: 'generic' });
        expect(gc.moveX).toBeCloseTo(0.6);
    });

    it('ignores a pad without sticks', () => {
        withPads([pad(0, '', [])]);
        gc = new GamepadControls();
        gc.update();
        expect(gc.getGamepadInfo()).toBeNull();
    });
});
