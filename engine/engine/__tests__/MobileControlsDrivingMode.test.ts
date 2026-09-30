/**
 * @jest-environment jsdom
 *
 * Driving-mode touch layout (vehicles): the left stick becomes a horizontal
 * STEERING slider (moveX only), the bottom-right of the screen is a held GAS
 * pedal (moveY = 1), quick right-side taps no longer fire ascend (the default
 * brake), and right-side action buttons re-anchor above the gas zone.
 */

import { MobileControls } from 'engine/MobileControls.js';

// jsdom viewport is 1024x768: left half x < 512; gas zone y >= 768 * (1 - 0.35) = 499.2;
// reverse corner rect x >= 1024 - 124 = 900 AND y >= 768 - 72 = 696.
const GAS_X = 700, GAS_Y = 700;      // bottom-right gas zone (clear of the reverse rect)
const REV_X = 960, REV_Y = 730;      // reverse corner rect
const CAM_X = 900, CAM_Y = 100;      // upper-right
const STICK_X = 200, STICK_Y = 700;  // bottom-left

describe('MobileControls driving mode', () => {
    let controls: MobileControls;
    let surface: HTMLDivElement;

    /** Dispatch a touch event carrying one `changedTouches` entry from the game surface. */
    function fire(type: 'touchstart' | 'touchmove' | 'touchend', id: number, clientX: number, clientY: number): void {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'changedTouches', { value: [{ identifier: id, clientX, clientY }], configurable: true });
        surface.dispatchEvent(ev);
    }
    const start = (id: number, x: number, y: number) => fire('touchstart', id, x, y);
    const move = (id: number, x: number, y: number) => fire('touchmove', id, x, y);
    const end = (id: number, x: number, y: number) => fire('touchend', id, x, y);

    beforeEach(() => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
            configurable: true,
        });
        controls = new MobileControls();
        surface = document.createElement('div');
        document.body.appendChild(surface);
    });

    afterEach(() => {
        controls.dispose();
        surface.remove();
    });

    it('a held touch in the bottom-right zone is gas (moveY = 1), released to 0', () => {
        controls.setDrivingMode(true);
        start(1, GAS_X, GAS_Y);
        expect(controls.moveY).toBe(1);
        end(1, GAS_X, GAS_Y);
        expect(controls.moveY).toBe(0);
    });

    it('the gas touch stays gas even when the finger drifts out of the zone', () => {
        controls.setDrivingMode(true);
        start(1, GAS_X, GAS_Y);
        move(1, CAM_X, CAM_Y);
        expect(controls.moveY).toBe(1);
        end(1, CAM_X, CAM_Y);
        expect(controls.moveY).toBe(0);
    });

    it('an upper-right quick tap does NOT fire ascend while driving (no accidental brake)', () => {
        controls.setDrivingMode(true);
        start(1, CAM_X, CAM_Y);
        end(1, CAM_X, CAM_Y);
        expect(controls.ascendPressed).toBe(false);
        expect(controls.moveY).toBe(0);
    });

    it('the same quick tap DOES fire ascend in the walking layout (legacy jump)', () => {
        start(1, CAM_X, CAM_Y);
        end(1, CAM_X, CAM_Y);
        expect(controls.ascendPressed).toBe(true);
    });

    it('the steering slider writes moveX only — a strongly vertical drag never throttles', () => {
        controls.setDrivingMode(true);
        start(1, STICK_X, STICK_Y);
        // Drag right AND far up: in the walking layout this would be forward.
        move(1, STICK_X + 60, STICK_Y - 200);
        expect(controls.moveX).toBeGreaterThan(0.5);
        expect(controls.moveY).toBe(0);
        end(1, STICK_X + 60, STICK_Y - 200);
        expect(controls.moveX).toBe(0);
    });

    it('the steering slider is proportional — a small deflection stays small', () => {
        controls.setDrivingMode(true);
        start(1, STICK_X, STICK_Y);
        // Default joystickSize 80 -> pill width 176, knob 43, travel 62.5px.
        move(1, STICK_X - 20, STICK_Y);
        const gentle = controls.moveX;
        expect(gentle).toBeLessThan(0);
        expect(gentle).toBeGreaterThan(-0.5);
        // Held, not integrated: repeating the same finger position must not creep
        // toward full lock (the over-sensitive-steering bug).
        move(1, STICK_X - 20, STICK_Y);
        move(1, STICK_X - 20, STICK_Y);
        expect(controls.moveX).toBe(gentle);
    });

    it('the steering pill follows the finger past full lock, so a reversal bites instantly', () => {
        controls.setDrivingMode(true);
        start(1, STICK_X, STICK_Y);
        // Drag 300px left — far beyond the 62.5px of travel.
        move(1, STICK_X - 300, STICK_Y);
        expect(controls.moveX).toBe(-1);
        // Moving back right by less than the overshoot must ALREADY reduce the
        // lock; without the re-anchor there would be ~240px of dead travel first.
        move(1, STICK_X - 280, STICK_Y);
        expect(controls.moveX).toBeGreaterThan(-1);
        expect(controls.moveX).toBeLessThan(0);
    });

    it('releasing the steering touch never cuts the held gas (moveY belongs to the pedal)', () => {
        controls.setDrivingMode(true);
        start(2, GAS_X, GAS_Y);
        start(1, STICK_X, STICK_Y);
        move(1, STICK_X - 40, STICK_Y);
        expect(controls.moveY).toBe(1);
        expect(controls.moveX).toBeLessThan(0);
        end(1, STICK_X - 40, STICK_Y);
        expect(controls.moveY).toBe(1); // gas still held
        end(2, GAS_X, GAS_Y);
        expect(controls.moveY).toBe(0);
    });

    it('driving mode re-anchors buttons for the driving layout, and restores them', () => {
        // jsdom drops `min()` CSS lengths, so assert on a plain-px observable:
        // exit sits at right 30px walking, 20px driving (raised clear of the gas
        // zone in the real driving position).
        const btn = controls.getButton('exit')!;
        expect(btn.style.right).toBe('30px');
        controls.setDrivingMode(true);
        expect(btn.style.right).toBe('20px');
        controls.setDrivingMode(false);
        expect(btn.style.right).toBe('30px');
    });

    it('the small bottom-right corner rect is REVERSE (moveY = -1), and it beats held gas', () => {
        controls.setDrivingMode(true);
        start(1, REV_X, REV_Y);
        expect(controls.moveY).toBe(-1);
        end(1, REV_X, REV_Y);
        expect(controls.moveY).toBe(0);

        // Gas held, then reverse pressed on top: reverse (the brake) wins;
        // releasing it returns to the still-held gas.
        start(2, GAS_X, GAS_Y);
        expect(controls.moveY).toBe(1);
        start(3, REV_X, REV_Y);
        expect(controls.moveY).toBe(-1);
        end(3, REV_X, REV_Y);
        expect(controls.moveY).toBe(1);
        end(2, GAS_X, GAS_Y);
        expect(controls.moveY).toBe(0);
    });

    it('driving ladder gives every right-side button a distinct slot (no pile-ups)', () => {
        controls.registerAction({ action: 'fire', label: 'FIRE', behavior: 'tap' },
            { bottom: 'min(130px, 28vh)', right: '20px', width: '70px', height: '70px', borderRadius: '50%', fontSize: '24px' });
        controls.registerAction({ action: 'swap', label: 'SWAP', behavior: 'tap' },
            { bottom: 'min(200px, 42vh)', right: '20px', width: '70px', height: '70px', borderRadius: '50%', fontSize: '18px' });
        controls.setDrivingMode(true);
        // jsdom drops min() CSS lengths, so distinctness is asserted via the
        // slot marker the ladder stamps on each button.
        const spots = new Set<string>();
        for (const action of ['action', 'secondaryAction', 'ascend', 'descend', 'fire', 'swap']) {
            const el = controls.getButton(action)!;
            spots.add(el.dataset.drivingSlot!);
        }
        expect(spots.size).toBe(6);
        // VISIBLE buttons must hold the low, thumb-reachable rows (0/1) — the
        // initially-hidden action/secondaryAction take the leftovers, never the
        // other way around (hidden built-ins once shoved FIRE into the HUD).
        for (const action of ['fire', 'swap']) {
            const row = controls.getButton(action)!.dataset.drivingSlot!.split(',')[0];
            expect(['0', '1']).toContain(row);
        }
    });

    it('turning driving mode off mid-throttle neutralizes gas and steering', () => {
        controls.setDrivingMode(true);
        start(1, GAS_X, GAS_Y);
        expect(controls.moveY).toBe(1);
        controls.setDrivingMode(false);
        expect(controls.moveY).toBe(0);
        expect(controls.moveX).toBe(0);
    });
});

describe('MobileControls driving mode on DESKTOP (touch UI never built)', () => {
    it('setDrivingMode creates no DOM — the pedals must not leak onto desktop screens', () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            configurable: true,
        });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
        // jsdom has no matchMedia; the desktop UA path reaches the coarse-pointer check.
        Object.defineProperty(window, 'matchMedia', {
            value: () => ({ matches: false }),
            configurable: true,
        });
        const desktop = new MobileControls();
        const before = document.querySelectorAll('.hud-mobile-button, .hud-mobile-joystick-outer').length;
        desktop.setDrivingMode(true);
        const after = document.querySelectorAll('.hud-mobile-button, .hud-mobile-joystick-outer').length;
        expect(after).toBe(before);
        expect(after).toBe(0);
        desktop.setDrivingMode(false); // no-op teardown must not throw either
        desktop.dispose();
    });
});
