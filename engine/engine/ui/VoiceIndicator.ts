import type { HUDAnchor, IGameHUD } from 'engine/IGameHUD.js';
import type { VoiceInput, VoiceInputState } from 'engine/VoiceInput.js';

/**
 * Options for VoiceIndicator.
 * All fields are required; use DEFAULT_VOICE_INDICATOR_OPTIONS and spread overrides.
 */
export interface VoiceIndicatorOptions {
    /** Anchor position for the indicator (default: 'top-center') */
    anchor: HUDAnchor;
}

export const DEFAULT_VOICE_INDICATOR_OPTIONS: VoiceIndicatorOptions = {
    anchor: 'top-center',
};

const ELEMENT_ID = 'voice-indicator';

const INDICATOR_CSS = `
    .voice-indicator {
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--hud-color-surface, rgba(0, 0, 0, 0.7));
        border: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent);
        border-radius: var(--hud-radius-pill, 16px);
        padding: 6px 14px;
        color: var(--hud-color-text, #ffffff);
        font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
        font-weight: var(--hud-font-weight-heading, 700);
        font-size: 14px;
    }
    .voice-indicator[data-state="idle"] {
        display: none;
    }
    .voice-indicator-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--hud-color-danger, #ff4b4b);
        animation: voice-indicator-pulse 1.2s ease-in-out infinite;
    }
    .voice-indicator[data-state="transcribing"] .voice-indicator-dot {
        background: color-mix(in srgb, var(--hud-color-text, #ffffff) 60%, transparent);
        animation: none;
    }
    @keyframes voice-indicator-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.35); opacity: 0.6; }
    }
`;

const INDICATOR_HTML = `
    <div class="voice-indicator" data-state="idle">
        <span class="voice-indicator-dot"></span>
        <span class="voice-indicator-label">Listening</span>
    </div>
    <style>${INDICATOR_CSS}</style>
`;

const LABEL_BY_STATE: Record<VoiceInputState, string> = {
    idle: '',
    listening: 'Listening',
    transcribing: 'Thinking…',
};

/**
 * VoiceIndicator — recording-state HUD element for voice input.
 *
 * Shows a pulsing red dot + "Listening" while the mic records and "Thinking…"
 * while the transcript is in flight; hidden when idle. Renders through the
 * genre HUD when one exists (theme-aware, like MuteControl), else falls back
 * to a plain fixed-position element in the engine container.
 */
export class VoiceIndicator {
    private hud: IGameHUD | null;
    private fallbackElement: HTMLElement | null = null;
    private unsubscribe: (() => void) | null = null;
    private isDisposed = false;

    constructor(
        voiceInput: VoiceInput,
        hud: IGameHUD | null,
        container: HTMLElement,
        options: VoiceIndicatorOptions = DEFAULT_VOICE_INDICATOR_OPTIONS
    ) {
        this.hud = hud;
        if (hud) {
            hud.createCustomElement(ELEMENT_ID, {
                anchor: options.anchor,
                html: INDICATOR_HTML,
                onUpdate: (element, value) => {
                    VoiceIndicator.applyState(element, value as VoiceInputState);
                },
            });
        } else {
            this.fallbackElement = document.createElement('div');
            this.fallbackElement.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:1000;pointer-events:none;';
            this.fallbackElement.innerHTML = INDICATOR_HTML;
            container.appendChild(this.fallbackElement);
        }

        this.unsubscribe = voiceInput.onStateChange((state) => this.setState(state));
    }

    private setState(state: VoiceInputState): void {
        if (this.isDisposed) return;
        if (this.hud) {
            this.hud.updateCustomElement(ELEMENT_ID, state);
        } else if (this.fallbackElement) {
            VoiceIndicator.applyState(this.fallbackElement, state);
        }
    }

    private static applyState(element: HTMLElement, state: VoiceInputState): void {
        const indicator = element.querySelector<HTMLElement>('.voice-indicator');
        const label = element.querySelector<HTMLElement>('.voice-indicator-label');
        if (!indicator || !label) return;
        indicator.dataset.state = state;
        label.textContent = LABEL_BY_STATE[state];
    }

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.hud?.removeElement(ELEMENT_ID);
        this.fallbackElement?.remove();
        this.fallbackElement = null;
    }
}
