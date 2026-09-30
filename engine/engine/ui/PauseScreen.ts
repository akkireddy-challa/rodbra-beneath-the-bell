// Default themed overlay for the engine's PAUSED state. Renders a centered
// card with a Resume button (and a Mute toggle when the game uses audio).
// Activates only for user-initiated pauses (reason: 'manual'), so editor-tab,
// interactive-ui, and system pauses do not steal the UI from whatever overlay
// is already there.

import { GameState, type GameStateManager } from 'engine/GameStateManager.js';
import type { IGameHUD } from 'engine/IGameHUD.js';
import type { EngineLike } from 'types/game.js';
import { escapeHtml, injectModalCardStyles, ScreenLeave } from 'engine/ui/modalCard.js';
import { qualityControlHtml, wireQualityControl } from 'engine/ui/QualityControl.js';
import type { GameEngine } from 'engine/GameEngine.js';
import { speakerOnSvg, speakerOffSvg } from 'engine/ui/speakerIcons.js';
import { BITMAGIC_URL, getBitmagicLogoUrl } from 'engine/ui/bitmagicBranding.js';

const OVERLAY_ID = 'engine-pause-overlay';

export interface PauseScreenOptions {
    pausedLabel: string;
    resumeLabel: string;
}

export const DEFAULT_PAUSE_SCREEN_OPTIONS: PauseScreenOptions = {
    pausedLabel: 'Paused',
    resumeLabel: 'Resume',
};

export class PauseScreen {
    private readonly gameStateManager: GameStateManager;
    private readonly getHud: () => IGameHUD | null;
    private readonly onResume: () => void;
    private readonly getEngine: () => EngineLike | null;
    private readonly options: PauseScreenOptions;
    private readonly stateListener: (newState: GameState) => void;
    private mounted = false;
    private muteUnsub: (() => void) | null = null;
    /** The mounted card's container, so a leave can mark it for the fade-out. */
    private container: HTMLElement | null = null;
    /** Pending removal of a card that is fading out. */
    private readonly leave = new ScreenLeave();

    constructor(params: {
        gameStateManager: GameStateManager;
        getHud: () => IGameHUD | null;
        onResume: () => void;
        // Resolved lazily at mount time: the PauseScreen is constructed during
        // `resetForLoad` (before `attachEngine`), so capturing the engine by
        // value here would freeze it to the null it was at construction.
        getEngine?: () => EngineLike | null;
        options?: Partial<PauseScreenOptions>;
    }) {
        this.gameStateManager = params.gameStateManager;
        this.getHud = params.getHud;
        this.onResume = params.onResume;
        this.getEngine = params.getEngine ?? (() => null);
        this.options = { ...DEFAULT_PAUSE_SCREEN_OPTIONS, ...params.options };

        this.stateListener = (newState: GameState) => {
            this.syncVisibility(newState);
        };
        this.attachListener();
    }

    /**
     * (Re)register the state-change listener. Idempotent. Call after
     * `gameStateManager.clearListeners()` (e.g. inside `resetForLoad`) to
     * keep the pause overlay responsive across game reloads.
     */
    attachListener(): void {
        this.gameStateManager.removeListener(this.stateListener);
        this.gameStateManager.addListener(this.stateListener);
    }

    /** Public for the ESC handler in GameRuntimeController — recompute after a manual pause transition. */
    refresh(): void {
        this.syncVisibility(this.gameStateManager.getCurrentState());
    }

    dispose(): void {
        this.gameStateManager.removeListener(this.stateListener);
        const hud = this.getHud();
        if (hud && this.mounted) {
            this.unmount(hud, false);
        }
        this.leave.cancel();
    }

    private syncVisibility(state: GameState): void {
        const reasons = this.gameStateManager.getPauseReasons();
        const shouldShow = state === GameState.PAUSED
            && reasons.has('manual')
            && !reasons.has('editor-tab');

        const hud = this.getHud();
        if (!hud) {
            this.mounted = false;
            return;
        }

        if (shouldShow && !this.mounted) {
            this.mount(hud);
        } else if (!shouldShow && this.mounted) {
            this.unmount(hud);
        }
    }

    /**
     * Take the card down. Animated: the overlay is marked leaving (clicks pass through at
     * once) and removed when the fade has run. A mount in the meantime cancels that removal
     * and clears the node itself, so the timer can never take a newer card with it.
     */
    private unmount(hud: IGameHUD, animate = true): void {
        this.muteUnsub?.();
        this.muteUnsub = null;
        this.mounted = false;
        const overlay = animate ? (this.container?.querySelector<HTMLElement>('.ui-modal-overlay') ?? null) : null;
        this.container = null;
        this.leave.start(overlay, () => hud.removeElement(OVERLAY_ID));
    }

    private mount(hud: IGameHUD): void {
        // Idempotent at the DOM level: `createCustomElement` does not dedupe by
        // id, and `syncVisibility` can clear `mounted` without removing the node
        // (when `getHud()` is briefly null across a reload). Clearing first means
        // we can never strand a second "Paused" overlay. No-op when absent. This also
        // drops a card still fading out, whose pending removal must not outlive it.
        this.leave.cancel();
        hud.removeElement(OVERLAY_ID);

        injectModalCardStyles();

        // The mute toggle is shown only once the game has actually used audio,
        // so silent games keep a clean Resume-only card.
        const engine = this.getEngine();
        const audioUsed = !!engine?.isAudioUsed?.();
        const muted = !!engine?.isAudioMuted?.();
        const muteHtml = audioUsed
            ? `<button class="ui-modal-button pause-screen-mute" type="button" data-variant="secondary">
                    <span class="pause-screen-mute-icon">${muted ? speakerOffSvg : speakerOnSvg}</span><span class="pause-screen-mute-label">${muted ? 'Unmute' : 'Mute'}</span>
               </button>`
            : '';

        // Branding for a published game. Rendered whenever this build has a
        // watermark, but styled to appear on touch devices only — that is where
        // the corner watermark is hidden because it sits under the on-screen
        // controls. See engine/ui/bitmagicBranding.ts.
        const logoUrl = getBitmagicLogoUrl();
        const brandHtml = logoUrl
            ? `<a class="pause-screen-brand" href="${BITMAGIC_URL}" target="_blank" rel="noopener noreferrer">
                    <img src="${escapeHtml(logoUrl)}" alt="Bitmagic" />
               </a>`
            : '';

        const html = `
            <div class="ui-modal-overlay ui-modal-overlay--animated">
                <div class="ui-modal-card" data-accent="neutral">
                    <h2 class="ui-modal-title">${escapeHtml(this.options.pausedLabel)}</h2>
                    <div class="ui-modal-stack">
                        <button class="ui-modal-button pause-screen-resume" type="button">${escapeHtml(this.options.resumeLabel)}</button>
                        ${muteHtml}
                        ${qualityControlHtml()}
                    </div>
                    ${brandHtml}
                </div>
            </div>
        `;

        hud.createCustomElement(OVERLAY_ID, {
            anchor: 'middle-center',
            html,
            interactive: true,
            onCreate: (container) => {
                this.container = container;
                const resume = container.querySelector<HTMLButtonElement>('.pause-screen-resume');
                resume?.addEventListener('click', () => this.onResume());
                this.wireMuteButton(container);
                wireQualityControl(container, () => this.getEngine() as GameEngine | null);
            },
        });
        this.mounted = true;
    }

    private wireMuteButton(container: HTMLElement): void {
        // The button is only rendered when the game uses audio, so its presence is the check.
        const btn = container.querySelector<HTMLButtonElement>('.pause-screen-mute');
        const engine = this.getEngine();
        if (!btn || !engine) return;
        const iconEl = container.querySelector<HTMLElement>('.pause-screen-mute-icon');
        const labelEl = container.querySelector<HTMLElement>('.pause-screen-mute-label');

        const render = (isMuted: boolean): void => {
            if (iconEl) iconEl.innerHTML = isMuted ? speakerOffSvg : speakerOnSvg;
            if (labelEl) labelEl.textContent = isMuted ? 'Unmute' : 'Mute';
        };

        btn.addEventListener('click', () => {
            engine.setAudioMuted?.(!(engine.isAudioMuted?.() ?? false));
        });

        // Stay in sync if mute is toggled elsewhere (HUD button / M key) while paused.
        this.muteUnsub = engine.onAudioMuteChange?.(render) ?? null;
        render(engine.isAudioMuted?.() ?? false);
    }
}
