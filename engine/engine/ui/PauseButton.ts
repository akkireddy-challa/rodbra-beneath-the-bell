import type { IGameHUD } from 'engine/IGameHUD.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';

/**
 * A pause button for touch devices — the only way to reach the pause card there.
 *
 * The card itself has existed for a long time and is where the settings live, but the ONLY
 * entry point was the Escape key. A phone has no Escape key, so on touch the pause screen,
 * its mute toggle, the Bitmagic branding and now the graphics-quality row were all
 * unreachable. The card was clearly meant to be reached: `modalCard.ts` carries a
 * `.pause-screen-brand` rule that turns the logo on under `@media (pointer: coarse)`, i.e.
 * for exactly the devices that could not open it.
 *
 * Touch-only on purpose. Desktop already has Escape, and adding a permanent on-screen
 * button there would spend a HUD corner on something every desktop player already knows.
 *
 * It fades to a low opacity a few seconds into play and comes back to full on touch, so a
 * corner of a phone screen is not permanently spent on a control the player needs twice a
 * session. The 44px touch target never shrinks — only the paint fades, so the button stays
 * as easy to hit dimmed as lit.
 *
 * Modelled on `MuteControl`: a HUD custom element with its rules in an embedded `<style>`
 * block, because `createCustomElement`'s `css` field is applied through `style.cssText` and
 * silently drops anything with a selector. Every value is a `--hud-*` token so a themed
 * game restyles it along with the rest of the HUD.
 */
/** How long the button stays at full opacity before fading back, in ms. */
const IDLE_DELAY_MS = 4000;

export class PauseButton {
    private disposed = false;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly hud: IGameHUD, private readonly onPause: () => void) {
        if (!isMobileRuntime()) return;
        this.create();
    }

    private create(): void {
        const s = this.hud.getScale();
        // 44px minimum touch target, matching `.ui-modal-button` on the card this opens.
        const localCss = `
            .pause-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                min-width: 44px;
                min-height: 44px;
                background: var(--hud-color-surface, rgba(0, 0, 0, 0.7));
                border: ${s.borderWidth}px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent);
                border-radius: var(--hud-radius-pill, ${s.borderRadius}px);
                padding: ${s.paddingSm}px ${s.paddingMd}px;
                color: var(--hud-color-text, #ffffff);
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
                transition: background 0.2s, border-color 0.2s;
            }
            .pause-btn:active { filter: brightness(0.9); }
            .pause-btn svg { display: block; }
            /* Idle: paint fades, hit area does not. Opacity only — a transform
               would shrink the 44px target along with the look of it. */
            .pause-btn.is-idle { opacity: 0.3; }
            @media (prefers-reduced-motion: no-preference) {
                .pause-btn { transition: background 0.2s, border-color 0.2s, opacity 0.6s ease; }
            }
        `;

        this.hud.createCustomElement('pause-button', {
            anchor: 'top-right',
            html: `
                <button class="pause-btn" type="button" aria-label="Pause">
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
                        <rect x="3" y="2" width="4" height="14" rx="1"></rect>
                        <rect x="11" y="2" width="4" height="14" rx="1"></rect>
                    </svg>
                </button>
                <style>${localCss}</style>
            `,
            interactive: true,
            onCreate: (container) => {
                const btn = container.querySelector('.pause-btn');
                btn?.addEventListener('click', () => this.onPause());
                // Touching anywhere on the button brings it back to full opacity
                // before the tap resolves, so the player sees what they hit.
                btn?.addEventListener('pointerdown', () => this.wake(btn));
                this.wake(btn);
            },
        });
    }

    /** Show the button at full opacity, then fade it back after {@link IDLE_DELAY_MS}. */
    private wake(btn: Element | null | undefined): void {
        if (!btn) return;
        btn.classList.remove('is-idle');
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (!this.disposed) btn.classList.add('is-idle');
        }, IDLE_DELAY_MS);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.hud.removeElement('pause-button');
    }
}
