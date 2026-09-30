import type { HUDAnchor, IGameHUD } from 'engine/IGameHUD.js';
import type { EngineLike, GameData } from 'types/game.js';
import { speakerOnSvg, speakerOffSvg } from 'engine/ui/speakerIcons.js';

/**
 * Options for MuteControl.
 * All fields are required; use DEFAULT_MUTE_CONTROL_OPTIONS and spread overrides.
 */
export interface MuteControlOptions {
    /** Anchor position for the mute button (default: 'top-right') */
    anchor: HUDAnchor;
}

export const DEFAULT_MUTE_CONTROL_OPTIONS: MuteControlOptions = {
    anchor: 'top-right',
};

/**
 * MuteControl — opt-in HUD mute button.
 *
 * Off by default. Templates opt in by calling `engine.enableMuteControl()` in
 * `Game.load()`; the engine then constructs this class via the HUD.
 *
 * The engine owns the actual mute state, persistence, and the `M`-key shortcut
 * (`engine.setAudioMuted` / `isAudioMuted` / `onAudioMuteChange` /
 * `setMuteHotkeyEnabled`). This class is just a HUD view bound to that state, so
 * the button always agrees with the pause-menu toggle and the `M` key. Muting
 * silences both engine audio (`playSound`/`playMusic`) and any Web Audio routed
 * through `engine.getAudioContext()` / `getAudioDestination()`.
 */
export class MuteControl {
    private hud: IGameHUD;
    private engine: EngineLike;
    private unsubscribe: (() => void) | null = null;
    private isDisposed = false;

    constructor(
        hud: IGameHUD,
        engine: EngineLike,
        _gameData: GameData | null,
        options: MuteControlOptions = DEFAULT_MUTE_CONTROL_OPTIONS
    ) {
        this.hud = hud;
        this.engine = engine;

        // Create the HUD button (initial icon from the engine's mute state).
        this.createMuteButton(options.anchor);

        // Keep the icon in sync with the engine mute state — whether toggled
        // here, from the pause menu, or applied from the persisted preference.
        this.unsubscribe = this.engine.onAudioMuteChange?.((muted) => {
            this.hud.updateCustomElement('mute-button', muted);
        }) ?? null;
    }

    private get muted(): boolean {
        return this.engine.isAudioMuted?.() ?? false;
    }

    /** Toggle mute state. */
    toggle(): void {
        if (this.isDisposed) return;
        this.engine.setAudioMuted?.(!this.muted);
    }

    /** Get current mute state. */
    getMuted(): boolean {
        return this.muted;
    }

    /** Set mute state explicitly. */
    setMuted(muted: boolean): void {
        if (this.isDisposed) return;
        this.engine.setAudioMuted?.(muted);
    }

    /**
     * Create the mute button HUD element.
     */
    private createMuteButton(anchor: MuteControlOptions['anchor']): void {
        const s = this.hud.getScale();
        const initialIcon = this.muted ? speakerOffSvg : speakerOnSvg;

        // Embed styles inside the HTML via a <style> block — the `css` field of
        // createCustomElement is applied via `style.cssText` and silently drops
        // anything with selectors. EndScreen uses the same pattern.
        const localCss = `
            .mute-btn {
                display: flex;
                align-items: center;
                gap: ${s.gap}px;
                background: var(--hud-color-surface, rgba(0, 0, 0, 0.7));
                border: ${s.borderWidth}px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent);
                border-radius: var(--hud-radius-pill, ${s.borderRadius}px);
                padding: ${s.paddingSm}px ${s.paddingMd}px;
                color: var(--hud-color-text, #ffffff);
                cursor: pointer;
                font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
                font-weight: var(--hud-font-weight-heading, 700);
                transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
            }
            .mute-btn:hover {
                border-color: color-mix(in srgb, var(--hud-color-primary, #ffffff) 60%, transparent);
                box-shadow: 0 0 12px var(--hud-glow-color, transparent);
            }
            .mute-btn:active {
                filter: brightness(0.9);
            }
            .mute-icon {
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .mute-key {
                font-size: ${s.fontSm}px;
                font-weight: var(--hud-font-weight-heading, 700);
                background: color-mix(in srgb, var(--hud-color-text, #ffffff) 18%, transparent);
                border: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent);
                padding: 2px 6px;
                border-radius: 3px;
                font-family: var(--hud-font-family);
            }
        `;

        this.hud.createCustomElement('mute-button', {
            anchor,
            html: `
                <button class="mute-btn" title="Toggle mute (M)">
                    <span class="mute-icon">${initialIcon}</span>
                    <span class="mute-key">M</span>
                </button>
                <style>${localCss}</style>
            `,
            interactive: true,
            onCreate: (container) => {
                const btn = container.querySelector('.mute-btn');
                if (btn) {
                    btn.addEventListener('click', () => this.toggle());
                }
            },
            onUpdate: (container, value) => {
                const isMuted = value as boolean;
                const iconEl = container.querySelector('.mute-icon');
                if (iconEl) {
                    iconEl.innerHTML = isMuted ? speakerOffSvg : speakerOnSvg;
                }
            },
        });
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;

        this.unsubscribe?.();
        this.unsubscribe = null;

        this.hud.removeElement('mute-button');
    }
}
