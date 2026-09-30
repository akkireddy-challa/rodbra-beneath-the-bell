/**
 * @jest-environment jsdom
 *
 * The graphics-quality dropdown on the pause card.
 *
 * The behaviour worth pinning is the Auto/pinned distinction, because it is the part that
 * is easy to get subtly wrong and impossible to see in a screenshot: "Auto" and "the rung
 * Auto currently resolves to" look identical on screen, but one may still be lowered by the
 * auto-tuner and the other may not. In particular, choosing Auto has to clear the stored
 * CONCLUSION as well as the pin — otherwise "back to Auto" quietly means "back to whatever
 * the tuner had already ratcheted me down to", which is the opposite of what it says.
 */
import {
    qualityControlHtml, wireQualityControl, qualityNote,
} from 'engine/ui/QualityControl.js';
import {
    setQualityPreference, setAutoDeviceTier, readQualityPreference, readAutoDeviceTier,
    activeDeviceSignature, refreshActiveDeviceQuality, deviceQualitySource,
} from 'engine/DeviceQuality.js';

/** Mount the row on its own, with no engine — the wiring must survive that. */
function mount(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = qualityControlHtml();
    document.body.appendChild(root);
    wireQualityControl(root, () => null);
    return root;
}

const select = (root: HTMLElement): HTMLSelectElement =>
    root.querySelector<HTMLSelectElement>('.ui-modal-select')!;

const options = (root: HTMLElement): string[] =>
    Array.from(select(root).options).map((o) => o.value);

const selected = (root: HTMLElement): string => select(root).value;

/** Choose a value the way a player does: set it and let the browser's event fire. */
const choose = (root: HTMLElement, value: string): void => {
    const el = select(root);
    el.value = value;
    el.dispatchEvent(new Event('change'));
};

const note = (root: HTMLElement): string =>
    root.querySelector('.quality-control-note')?.textContent ?? '';

beforeEach(() => {
    document.body.innerHTML = '';
    setQualityPreference('auto');
    refreshActiveDeviceQuality();
});

afterEach(() => {
    setQualityPreference('auto');
    refreshActiveDeviceQuality();
});

describe('quality control row', () => {
    it('offers Auto plus every rung, with Auto selected by default', () => {
        const root = mount();
        expect(options(root)).toEqual([
            'auto', 'ultra', 'high', 'medium', 'low', 'minimal',
        ]);
        expect(selected(root)).toBe('auto');
    });

    // i18n is not initialised under jest, so `t()` returns the key. Asserting on keys is
    // the right level anyway: this file tests which message is chosen, not its wording.
    it('shows what Auto resolved to, so the player can see the engine\'s answer', () => {
        const root = mount();
        expect(note(root)).toContain('game.quality.autoResolved');
    });

    it('adds the reason only once something actually lowered it', () => {
        // A device that simply started where it started has no story, and inventing one
        // reads as an apology for nothing.
        expect(qualityNote([])).not.toContain('autoReason');
        setAutoDeviceTier('low', 'measure', activeDeviceSignature());
        expect(qualityNote([])).toContain('game.quality.autoReasonMeasure');
    });

    it('says nothing was lowered when the probe merely set the opening rung', () => {
        // The probe runs before the player has seen a frame, so it takes nothing away.
        // Reporting it as "lowered to hold the frame rate" describes an event that never
        // happened — and this is what the pause card actually showed on a healthy machine.
        setAutoDeviceTier('high', 'probe', activeDeviceSignature());
        expect(qualityNote([])).toContain('game.quality.autoResolved');
        expect(qualityNote([])).not.toContain('autoReason');
    });

    it('names the crash when that is what lowered it', () => {
        setAutoDeviceTier('medium', 'crash', activeDeviceSignature());
        expect(qualityNote([])).toContain('game.quality.autoReasonCrash');
        expect(qualityNote([])).not.toContain('autoReasonMeasure');
    });

    it('pins the rung the player picks', () => {
        const root = mount();
        choose(root, 'low');
        expect(readQualityPreference()).toBe('low');
        expect(selected(root)).toBe('low');
        expect(deviceQualitySource()).toBe('pinned');
    });

    it('says nothing about Auto once a rung is pinned', () => {
        const root = mount();
        choose(root, 'high');
        expect(note(root)).not.toContain('game.quality.autoResolved');
    });

    it('treats picking Auto as a fresh start, clearing the tuner\'s conclusion too', () => {
        // The one that matters. Clearing only the pin would leave the stored conclusion in
        // place, so "Auto" would resolve straight back to the ratcheted rung and the player
        // would have no way to undo an automatic downgrade at all.
        setAutoDeviceTier('minimal', 'measure', activeDeviceSignature());
        const root = mount();
        choose(root, 'ultra');
        choose(root, 'auto');
        expect(readQualityPreference()).toBe('auto');
        expect(readAutoDeviceTier(activeDeviceSignature())).toBeNull();
        expect(selected(root)).toBe('auto');
    });

    it('warns about deferred knobs only when there are some', () => {
        expect(qualityNote(['materials'])).toBe('game.quality.deferred');
        expect(qualityNote([])).not.toContain('game.quality.deferred');
    });

    it('survives having no engine to apply to', () => {
        // The row is built by the pause card, which can mount before the engine resolves.
        const root = mount();
        expect(() => choose(root, 'medium')).not.toThrow();
        expect(readQualityPreference()).toBe('medium');
    });

    it('does nothing when the row is absent', () => {
        const empty = document.createElement('div');
        expect(() => wireQualityControl(empty, () => null)).not.toThrow();
    });
});
