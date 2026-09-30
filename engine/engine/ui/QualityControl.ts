/**
 * The graphics-quality setting on the pause card: Auto plus the ladder's rungs, in a
 * dropdown.
 *
 * WHY A DROPDOWN AND NOT A ROW OF CHIPS. Six chips needed two grid rows and took more of
 * the card than Resume and Mute together — the two things anyone actually opens the card
 * to press. A setting that is changed once, if ever, should not outweigh the actions. A
 * `select` collapses the six to one line, and it hands the popup, the keyboard handling
 * and the touch picker to the browser instead of to us.
 *
 * WHY AUTO IS NOT A RUNG. It is the absence of a choice — "keep following what the engine
 * works out" — and it is the default. Modelling it as a sixth rung would make "the engine
 * decided Medium" and "the player asked for Medium" the same state, which they are not: one
 * may still be lowered automatically and the other may not. The two are stored in separate
 * keys for the same reason (see `DeviceQuality.ts`), and the note under the dropdown is what
 * makes the distinction visible — Auto shows what it currently resolves to, in parentheses.
 *
 * WHY IT SAYS WHAT WILL NOT CHANGE YET. Resolution and shadows move while the card is open,
 * which is what makes the setting feel real. Material quality lands at the next material
 * construction and level detail at the next level load, because the alternative is
 * re-meshing the level under a paused player — the trade `setLevelDetail`'s own docstring
 * already refuses. Saying so in a muted line is better than an "Apply" button that would
 * have to lie about what it does.
 */

import {
    DEVICE_QUALITY_TIERS, activeDeviceQualityTier, deviceQualitySource,
    readAutoDeviceTier, readQualityPreference, setQualityPreference, activeDeviceSignature,
    refreshActiveDeviceQuality,
    type DeviceQualityTier, type QualityPreference,
} from 'engine/DeviceQuality.js';
import { applyDeviceTierLive, type PendingQualityChange } from 'engine/quality/DeviceQualityApply.js';
import type { GameEngine } from 'engine/GameEngine.js';
import { t } from 'engine/i18n/index.js';

const AUTO_VALUE = 'auto';

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
    ));
}

/** The row's markup. Nothing inline — every rule lives in `MODAL_CARD_CSS`. */
export function qualityControlHtml(): string {
    const label = escapeHtml(t('game.quality.label'));
    const options = [AUTO_VALUE, ...DEVICE_QUALITY_TIERS]
        .map((value) => `<option value="${value}">${escapeHtml(t(`game.quality.${value}`))}</option>`)
        .join('');
    // The select carries its own aria-label rather than a `for`/`id` pair: the card is
    // built from a string that could be mounted twice, and duplicate ids would silently
    // point every label at the first copy.
    return `
        <div class="ui-modal-row quality-control">
            <span class="ui-modal-row-label">${label}</span>
            <span class="ui-modal-select-wrap">
                <select class="ui-modal-select" aria-label="${label}">${options}</select>
            </span>
            <span class="ui-modal-note quality-control-note"></span>
        </div>
    `;
}

/**
 * The note under the row: what Auto resolved to and why, or what a fresh choice has not
 * applied yet. Empty when there is nothing worth saying — a player who pinned a rung two
 * sessions ago does not need to be told about deferred knobs that landed long ago.
 */
export function qualityNote(pending: PendingQualityChange[]): string {
    if (pending.includes('shadows')) return t('game.quality.deferredShadows');
    if (pending.length > 0) return t('game.quality.deferred');
    const source = deviceQualitySource();
    if (source !== 'auto' && source !== 'default') return '';
    const tier = t(`game.quality.${activeDeviceQualityTier()}`);
    const resolved = t('game.quality.autoResolved', { tier });
    // Only say WHY when something was actually taken away, and say which thing took it.
    // A `probe` record is the OPENING rung — the player never had anything else, so
    // claiming the frame rate forced it down describes an event that did not happen.
    const record = readAutoDeviceTier(activeDeviceSignature());
    if (!record || record.reason === 'probe') return resolved;
    const why = record.reason === 'crash' ? 'game.quality.autoReasonCrash' : 'game.quality.autoReasonMeasure';
    return `${resolved} — ${t(why)}`;
}

/** Wire the row inside `container`. Safe to call when the row is absent. */
export function wireQualityControl(container: HTMLElement, getEngine: () => GameEngine | null): void {
    const row = container.querySelector<HTMLElement>('.quality-control');
    if (!row) return;
    const note = row.querySelector<HTMLElement>('.quality-control-note');
    const select = row.querySelector<HTMLSelectElement>('.ui-modal-select');
    if (!select) return;

    const render = (pending: PendingQualityChange[]): void => {
        select.value = readQualityPreference();
        if (note) note.textContent = qualityNote(pending);
    };

    select.addEventListener('change', () => {
        const value = select.value;
        const pref: QualityPreference = value === AUTO_VALUE ? AUTO_VALUE : value as DeviceQualityTier;
        setQualityPreference(pref);
        // The stored keys just changed under the session memo, so re-derive before
        // reading the rung back — otherwise "Auto" would resolve to the value the memo
        // was holding rather than to a fresh resolution.
        refreshActiveDeviceQuality();
        const engine = getEngine();
        // Picking Auto clears the stored conclusion too, so the rung it resolves to
        // now is the honest starting point rather than whatever the tuner had already
        // ratcheted this device down to. Applying it live means the player sees
        // resolution and shadows move as they choose, which is what makes the row
        // feel like a control rather than a form.
        const tier = pref === AUTO_VALUE ? activeDeviceQualityTier() : pref;
        const pending = engine ? applyDeviceTierLive(engine, tier, pref === AUTO_VALUE ? 'auto' : 'pinned') : [];
        render(pending);
    });

    render([]);
}
