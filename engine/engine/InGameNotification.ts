// Type checking enabled

import { injectHudBaseStyles } from 'engine/hud/index.js';

/**
 * In-game notification system for displaying messages to players.
 * Token-driven via .hud-notification (see hud-base.css) — recolors with
 * the active HUD theme. Used for transient banners that aren't tied to a
 * specific HUD element (achievements, hints, etc.).
 */
export class InGameNotification {
    private container: HTMLDivElement | null = null;
    private currentTimeout: number | null = null;

    constructor() {
        // Defensive — InGameNotification may be constructed before GameHUD.
        injectHudBaseStyles();
        this.createContainer();
    }

    private createContainer(): void {
        this.container = document.createElement('div');
        this.container.id = 'in-game-notification';
        this.container.className = 'hud-notification';
        document.body.appendChild(this.container);
    }

    /**
     * Show a notification message
     * @param message - The message to display (HTML allowed)
     * @param durationMs - How long to show the message in milliseconds (default: 3000)
     */
    public show(message: string, durationMs: number = 3000): void {
        if (!this.container) return;

        // Clear any existing timeout
        if (this.currentTimeout !== null) {
            clearTimeout(this.currentTimeout);
        }

        this.container.innerHTML = message;

        // Two-frame visibility flip so the opacity transition fires reliably:
        // first paint the element with display:block but opacity:0 (data-visible
        // not yet set), then on the next frame set data-visible so the
        // CSS transition has both sides to interpolate.
        this.container.dataset.visible = 'true';

        this.currentTimeout = window.setTimeout(() => {
            this.hide();
        }, durationMs);
    }

    /**
     * Hide the notification
     */
    public hide(): void {
        if (!this.container) return;
        delete this.container.dataset.visible;
    }

    /**
     * Dispose of the notification system
     */
    public dispose(): void {
        if (this.currentTimeout !== null) {
            clearTimeout(this.currentTimeout);
        }

        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }

        this.container = null;
    }
}
