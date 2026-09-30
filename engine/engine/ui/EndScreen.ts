// Default themed overlay for the engine's END game state. Composes the
// shared modal-card CSS so the end screen sits in the same visual family
// as the start and pause screens. `interactive: true` on the HUD custom
// element already unlocks the mouse and freezes input, so we only need to
// render content and wire the "Play Again" button to a full page reload.

import type { IGameHUD } from 'engine/IGameHUD.js';
import { escapeHtml, injectModalCardStyles } from 'engine/ui/modalCard.js';

export type EndGameOutcome = 'win' | 'lose' | 'draw' | 'neutral';

export interface EndGameStat {
    label: string;
    value: string | number;
}

export interface EndGameOptions {
    outcome: EndGameOutcome;
    title: string;
    message: string | null;
    stats: EndGameStat[];
    replayLabel: string;
}

export const DEFAULT_END_GAME_OPTIONS: EndGameOptions = {
    outcome: 'neutral',
    title: 'Game Over',
    message: null,
    stats: [],
    replayLabel: 'Play Again',
};

const OVERLAY_ID = 'engine-end-overlay';

// Only 'win' and 'lose' map to their own accent classes; everything else
// (including 'draw') uses the neutral border treatment.
function outcomeDataAttribute(outcome: EndGameOutcome): string {
    return outcome === 'win' || outcome === 'lose' ? outcome : 'neutral';
}

function renderStats(stats: EndGameStat[]): string {
    if (stats.length === 0) return '';
    const rows = stats.map(s => `
        <div class="end-screen-stat">
            <span class="end-screen-stat-label">${escapeHtml(s.label)}</span>
            <span class="end-screen-stat-value">${escapeHtml(String(s.value))}</span>
        </div>
    `).join('');
    return `<div class="end-screen-stats">${rows}</div>`;
}

function renderMessage(message: string | null): string {
    return message ? `<p class="ui-modal-message">${escapeHtml(message)}</p>` : '';
}

const END_SCREEN_LOCAL_CSS = `
#hud-custom-${OVERLAY_ID} .end-screen-stats {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
}
#hud-custom-${OVERLAY_ID} .end-screen-stat {
    display: flex;
    justify-content: space-between;
    font-size: 14px;
}
#hud-custom-${OVERLAY_ID} .end-screen-stat-label {
    color: var(--hud-color-text-muted, rgba(255, 255, 255, 0.7));
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
}
#hud-custom-${OVERLAY_ID} .end-screen-stat-value {
    color: var(--hud-color-text, #ffffff);
    font-weight: var(--hud-font-weight-heading, 700);
}
`;

export function showEndOverlay(hud: IGameHUD, opts: EndGameOptions): void {
    injectModalCardStyles();
    // Guard against duplicate calls — removeElement is a safe no-op when absent.
    hud.removeElement(OVERLAY_ID);

    const accent = outcomeDataAttribute(opts.outcome);
    const html = `
        <div class="ui-modal-overlay ui-modal-overlay--animated">
            <div class="ui-modal-card" data-accent="${accent}">
                <h2 class="ui-modal-title">${escapeHtml(opts.title)}</h2>
                ${renderMessage(opts.message)}
                ${renderStats(opts.stats)}
                <button class="ui-modal-button end-screen-replay" type="button">${escapeHtml(opts.replayLabel)}</button>
            </div>
        </div>
        <style>${END_SCREEN_LOCAL_CSS}</style>
    `;

    hud.createCustomElement(OVERLAY_ID, {
        anchor: 'middle-center',
        html,
        interactive: true,
        onCreate: (container) => {
            const button = container.querySelector<HTMLButtonElement>('.end-screen-replay');
            button?.addEventListener('click', () => {
                window.location.reload();
            });
        },
    });
}
